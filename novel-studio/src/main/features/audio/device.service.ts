/**
 * Novel Studio · 设备服务（`device:list` / `device:savePreference` / `device:selfTestResult`）
 * ============================================================================
 * 设计依据：
 *   · docs/12 §11「设备枚举位置说明」：`navigator.mediaDevices.enumerateDevices()` 只能在
 *     渲染进程调用（未授权时拿不到 label），**设备偏好与自检结果存主进程**，两侧经 IPC 同步。
 *   · docs/20 §4.5 `device:*` 三个通道
 *   · docs/04 §8.2 设置里的 `audio.defaultInputDeviceId` 是「默认输入设备」的权威键
 *
 * ### 主进程到底负责什么（容易被想复杂）
 *   · **偏好**：用户选中的输入设备 id → `settings.audio.defaultInputDeviceId`
 *   · **label 快照**：见过的设备 id → label。渲染进程在未授权时只能拿到空 label，
 *     主进程存下来的快照能让「已拔掉但仍在偏好里」的设备显示成人话而不是一串 id
 *   · **自检结果**：最近一次「录 5 秒并回放」的结果（docs/12 §11），供设置页与诊断面板回看
 *
 *   它**不枚举设备**：主进程里没有 Web Audio，也没有跨平台的输入设备枚举 API。
 *   所以 `list()` 返回的是「主进程知道的那部分」，由渲染侧合并（见 device.store.refresh）。
 */

import { AppError } from '../../../shared/errors.ts'
import type { AppSettings, AudioDeviceInfo, DeviceSelfTestResult } from '../../../shared/types.ts'
import type { Logger } from '../../infra/log/index.ts'
import type { SettingsStore } from '../../settings.ts'

export interface DeviceListResult {
  devices: AudioDeviceInfo[]
  preferred: string | null
}

export interface DeviceServiceDeps {
  settings: () => SettingsStore
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
}

export interface DeviceService {
  list(): DeviceListResult
  savePreference(deviceId: string, label: string): { ok: boolean }
  saveSelfTest(result: DeviceSelfTestResult): { ok: boolean }
}

/**
 * 自检结果的提醒语（docs/12 §11 的四项检查）。
 *
 * 优先级刻意如此：丢帧 / 没信号 / 削波会让录音**不可用**，先报；
 * 底噪偏高与采样率不符只提示（可用降噪或系统设置缓解）。
 * 返回 `null` 表示「一切正常」，UI 就显示「正常」。
 */
export function suggestSelfTestFix(result: DeviceSelfTestResult): string | null {
  if (result.droppedFrames > 0) {
    return `采集过程丢帧 ${result.droppedFrames} 次：请关闭占用 CPU 的程序，或在设置里降低采样率/位深后重试。`
  }
  if (!result.hasSignal) {
    return '没有检测到输入信号：请确认麦克风已插好、系统输入设备选对、且没有被静音。'
  }
  if (result.clipping) {
    return '出现削波（波形顶到 0 dBFS）：请在设置里降低输入增益，或把麦克风离嘴远一点。'
  }
  if (typeof result.noiseFloorDb === 'number' && result.noiseFloorDb > -45) {
    return `底噪偏高（约 ${result.noiseFloorDb.toFixed(1)} dBFS）：录完可用处理链里的降噪；安静环境能明显改善。`
  }
  if (result.requestedSampleRate !== result.actualSampleRate) {
    return (
      `设备实际采样率 ${result.actualSampleRate} Hz 与请求的 ${result.requestedSampleRate} Hz 不同：` +
      '录音会自动转换，但如果设备频繁切换采样率，建议在系统里把它固定下来。'
    )
  }
  return null
}

export function createDeviceService(deps: DeviceServiceDeps): DeviceService {
  /** 当前 audio 设置段（`?? {}` 是取值级兜底：坏数据不该让设备页整页打不开，见 docs/91 §5.2.3） */
  function audioSettings(): Partial<AppSettings['audio']> {
    return deps.settings().current().audio ?? {}
  }

  return {
    list(): DeviceListResult {
      const audio = audioSettings()
      const preferred = audio.defaultInputDeviceId ?? null
      const labels = audio.deviceLabels ?? {}
      const devices: AudioDeviceInfo[] = Object.entries(labels).map(([deviceId, label]) => ({
        deviceId,
        label,
        // 主进程只知道「用户选过它」，不知道它是输入还是输出设备。
        // 本应用只用输入设备（录音），所以默认按 audioinput 报；
        // 渲染侧会用自己的枚举结果覆盖（只有它知道真实 kind）。
        kind: 'audioinput',
        isDefault: deviceId === preferred,
      }))
      // 偏好设备即使还没存过 label 也要出现在列表里（否则用户看不到「当前首选」）
      if (preferred && !devices.some((d) => d.deviceId === preferred)) {
        devices.unshift({
          deviceId: preferred,
          label: labels[preferred] ?? preferred,
          kind: 'audioinput',
          isDefault: true,
        })
      }
      return { devices, preferred }
    },

    savePreference(deviceId: string, label: string): { ok: boolean } {
      if (!deviceId.trim()) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'device:savePreference', reason: 'empty-device-id' },
        })
      }
      const store = deps.settings()
      const labels = { ...(store.current().audio?.deviceLabels ?? {}) }
      // 空 label 不覆盖已有快照：未授权时渲染侧只能给出空串，写进去会把好数据抹掉
      if (label.trim()) labels[deviceId] = label
      /**
       * ⚠️ 这里必须用**点分键**写。
       *
       * 嵌套写法 `{ audio: { deviceLabels: labels } }` 会被 `settings.set` 里的
       * `collectLeafKeys` **展开成一条条子路径**（`audio.deviceLabels.<deviceId>`），
       * 而那些子路径在默认值树里并不存在 → `setByPath` 返回 false →
       * **设置看起来写成功了，实际什么都没变**（重启后 label 全丢、自检结果也不见了）。
       * 对象型设置项只有「整块作为一个叶子写」才是对的（settings.ts 的注释里把点分键
       * 定为 store 层用法，本文件正是 store 层）。
       */
      store.set({
        'audio.defaultInputDeviceId': deviceId,
        'audio.deviceLabels': labels,
      })
      deps.log?.info?.('device.preferenceSaved', {
        event: 'device.preferenceSaved',
        deviceId,
        label: labels[deviceId] ?? '',
      })
      return { ok: true }
    },

    saveSelfTest(result: DeviceSelfTestResult): { ok: boolean } {
      if (!result || typeof result !== 'object') {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'device:selfTestResult', reason: 'missing-result' },
        })
      }
      // 调用方给了 suggestion 就用它的；否则按四项检查给一条
      const suggestion = result.suggestion ?? suggestSelfTestFix(result)
      // 同 savePreference：对象型设置项必须整块写（点分键），否则会被展开成不存在的子路径而静默丢弃
      deps.settings().set({ 'audio.lastSelfTest': { ...result, suggestion } })
      deps.log?.info?.('device.selfTestSaved', {
        event: 'device.selfTestSaved',
        hasSignal: result.hasSignal,
        clipping: result.clipping,
        droppedFrames: result.droppedFrames,
        noiseFloorDb: result.noiseFloorDb,
        suggestion,
      })
      return { ok: true }
    },
  }
}
