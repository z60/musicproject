/**
 * 录音域 · 设备与配置 store
 * ============================================================================
 * 设计依据：
 *   · docs/12 §6   —— 设备诊断页：输入/输出设备、采样率（请求 vs 实际）、
 *                     延迟、底噪、削波结论与建议
 *   · docs/12 §11  —— 「设备枚举位置说明：`navigator.mediaDevices.enumerateDevices()`
 *                     只能在渲染进程调用（**需要用户授权后才能拿到 label**）；
 *                     设备偏好与自检结果存主进程，两侧通过 IPC 同步」
 *   · docs/20 §4.5 —— `device:list` / `device:savePreference` / `device:selfTestResult`
 *
 * 因此本 store 的职责是**合并两个来源**：
 *   1. 主进程（`device:list`）：偏好 deviceId、自检历史（权威持久数据）；
 *   2. 渲染进程（enumerateDevices）：带 label 的实时设备表（授权后才完整）。
 * 主进程 handler 若尚未实现（当前仓库就是这种情况），本地枚举仍然要能用：
 * 设备列表为空时 UI 必须能引导用户「刷新 / 授权」，而不是一片空白。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { callSafe } from '@/shared/lib/ipc.ts'
import type { AudioDeviceInfo, DeviceSelfTestResult } from '@shared/types.ts'

/** 设备枚举来源（UI 需要说明 label 为什么是空的） */
export type DeviceSource = 'main' | 'renderer' | 'merged' | 'none'

interface DeviceListResult {
  devices: AudioDeviceInfo[]
  preferred: string | null
}

export const useDeviceStore = defineStore('recording/device', () => {
  const devices = ref<AudioDeviceInfo[]>([])
  const preferredId = ref<string | null>(null)
  const source = ref<DeviceSource>('none')
  const loading = ref(false)
  /** 是否已经拿到麦克风授权（未授权时 label 为空，必须提示用户） */
  const labelAvailable = ref(false)
  const lastError = ref<unknown>(null)

  // ── 自检（docs/12 §6.1「录 5 秒并回放」）──────────────────────────────────
  const selfTestRunning = ref(false)
  const selfTestElapsedMs = ref(0)
  const selfTestResult = ref<DeviceSelfTestResult | null>(null)
  /** 实测底噪（3 秒测量，供处理链 afftdn 的 nf 参考） */
  const noiseFloorDb = ref<number | null>(null)
  /** 由用户显式「作为降噪参考」保存下来的底噪 */
  const noiseReferenceDb = ref<number | null>(null)

  const inputs = computed(() => devices.value.filter(d => d.kind === 'audioinput'))
  const outputs = computed(() => devices.value.filter(d => d.kind === 'audiooutput'))
  const hasDevices = computed(() => devices.value.length > 0)
  const preferredDevice = computed(() => devices.value.find(d => d.deviceId === preferredId.value) ?? null)
  /** 采样率不一致（请求 ≠ 实际）—— docs/05 §2.1 的踩坑点，必须显式提示 */
  const sampleRateMismatch = computed(() => {
    const r = selfTestResult.value
    return r !== null && r.requestedSampleRate > 0 && r.actualSampleRate > 0 && r.requestedSampleRate !== r.actualSampleRate
  })

  /** 本地枚举（渲染进程唯一能拿到 label 的地方） */
  async function enumerateLocally(): Promise<AudioDeviceInfo[]> {
    const media = globalThis.navigator?.mediaDevices
    if (!media?.enumerateDevices) return []
    try {
      const list = await media.enumerateDevices()
      const result: AudioDeviceInfo[] = []
      let firstInput = true
      let firstOutput = true
      for (const device of list) {
        if (device.kind !== 'audioinput' && device.kind !== 'audiooutput') continue
        const isFirst = device.kind === 'audioinput' ? firstInput : firstOutput
        if (device.kind === 'audioinput') firstInput = false
        else firstOutput = false
        result.push({
          deviceId: device.deviceId,
          // label 为空 = 未授权（docs/12 §11）
          label: device.label || (device.kind === 'audioinput' ? `输入设备（未授权 ${result.length + 1}）` : `输出设备（未授权）`),
          kind: device.kind,
          // enumerateDevices 不返回「哪个是默认设备」；约定：同类里第一个即系统默认
          // （与 Chromium 的排序一致），主进程给了 isDefault 时以主进程为准。
          isDefault: isFirst,
        })
      }
      labelAvailable.value = list.some(d => Boolean(d.label))
      return result
    } catch (error) {
      lastError.value = error
      return []
    }
  }

  /**
   * 主动申请一次授权：只有拿到授权，enumerateDevices 才会返回 label。
   * 采集结束后立刻停掉轨道 —— 这里只是为了解锁 label，不是录音（docs/12 §12 权限流程）。
   */
  async function ensurePermission(): Promise<boolean> {
    const media = globalThis.navigator?.mediaDevices
    if (!media?.getUserMedia) return false
    try {
      const stream = await media.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      labelAvailable.value = true
      return true
    } catch (error) {
      lastError.value = error
      return false
    }
  }

  /**
   * 刷新设备列表：主进程（偏好 + isDefault）与渲染进程（label）合并。
   * 合并策略：以渲染进程枚举到的设备集合为准（它才是当前真实可用的），
   * 主进程给的 preferred / isDefault 覆盖上去。
   */
  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const [fromMain, local] = await Promise.all([
        callSafe('device:list', undefined) as Promise<DeviceListResult | null>,
        enumerateLocally(),
      ])
      const mainDevices = fromMain?.devices ?? []
      preferredId.value = fromMain?.preferred ?? null

      if (!local.length && !mainDevices.length) {
        devices.value = []
        source.value = 'none'
        return
      }

      if (!local.length) {
        devices.value = mainDevices
        source.value = 'main'
        return
      }

      const byId = new Map(mainDevices.map(d => [d.deviceId, d]))
      devices.value = local.map((d) => {
        const main = byId.get(d.deviceId)
        return {
          ...d,
          // 主进程的 label 更可靠（它持久化了 label 快照），本地有 label 时用本地的
          label: d.label && !d.label.startsWith('输入设备（未授权') ? d.label : (main?.label || d.label),
          isDefault: main?.isDefault ?? d.isDefault,
        }
      })
      // 主进程有、本地枚举没有的设备（例如已被拔掉但仍在偏好里）也保留，标为不可用来源
      for (const device of mainDevices) {
        if (!devices.value.some(d => d.deviceId === device.deviceId)) devices.value.push(device)
      }
      source.value = mainDevices.length ? 'merged' : 'renderer'
    } finally {
      loading.value = false
    }
  }

  /** 保存首选设备（主进程存偏好；同时写设置里的默认输入设备，docs/04 §8.2） */
  async function savePreference(deviceId: string, label: string): Promise<boolean> {
    const result = await callSafe('device:savePreference', { deviceId, label })
    if (!result?.ok) return false
    preferredId.value = deviceId
    devices.value = devices.value.map(d => ({ ...d, isDefault: d.deviceId === deviceId ? true : d.isDefault }))
    return true
  }

  /** 自检结果落库（docs/12 §11：自检结果存主进程） */
  async function submitSelfTest(result: DeviceSelfTestResult): Promise<boolean> {
    selfTestResult.value = result
    if (typeof result.noiseFloorDb === 'number') noiseFloorDb.value = result.noiseFloorDb
    const saved = await callSafe('device:selfTestResult', { result })
    return saved?.ok ?? false
  }

  function setSelfTestRunning(running: boolean): void {
    selfTestRunning.value = running
    if (!running) selfTestElapsedMs.value = 0
  }

  function setSelfTestElapsed(ms: number): void {
    selfTestElapsedMs.value = ms
  }

  function setNoiseFloor(db: number | null): void {
    noiseFloorDb.value = db
  }

  function useAsNoiseReference(): void {
    noiseReferenceDb.value = noiseFloorDb.value
  }

  function reset(): void {
    selfTestResult.value = null
    selfTestElapsedMs.value = 0
    selfTestRunning.value = false
  }

  return {
    devices, preferredId, source, loading, labelAvailable, lastError,
    selfTestRunning, selfTestElapsedMs, selfTestResult, noiseFloorDb, noiseReferenceDb,
    inputs, outputs, hasDevices, preferredDevice, sampleRateMismatch,
    enumerateLocally, ensurePermission, refresh, savePreference, submitSelfTest,
    setSelfTestRunning, setSelfTestElapsed, setNoiseFloor, useAsNoiseReference, reset,
  }
})
