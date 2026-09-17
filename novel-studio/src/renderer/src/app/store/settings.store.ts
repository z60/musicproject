/**
 * 应用级状态 · 设置与能力探测（跨功能域共享）
 * ============================================================================
 * 设计依据：
 *   · docs/04 §8.2 —— 设置项分组（路径/音频/录音/画本/混音/导出/AI/外观/高级）
 *   · docs/02 §5.1 —— 能力探测：ffmpeg 滤镜、模型文件是否就绪；
 *     「探测到缺失的关键滤镜 → UI 据此隐藏控件，而不是等用户点了才报错」
 *   · docs/20 §7 —— `settings:changed` 事件后要刷新本地缓存
 *
 * 为什么放在 app/store：录音页要用 audio/recording 段，混音导出要用 mixing/export 段，
 * 设置页要用全部 —— 属于典型跨域共享状态（docs/01 §3.2）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { call, callSafe, on } from '@/shared/lib/ipc.ts'
import type { AppCapabilities, AppSettings } from '@shared/types.ts'
import type { DeepPartial } from '@shared/ipc.ts'

export const useSettingsStore = defineStore('app/settings', () => {
  const settings = ref<AppSettings | null>(null)
  const capabilities = ref<AppCapabilities | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const lastError = ref<unknown>(null)
  let unsubscribe: (() => void) | null = null

  /** 常用片段的便捷读取（避免组件里写 settings.value!.audio.xxx） */
  const audio = computed(() => settings.value?.audio ?? null)
  const recording = computed(() => settings.value?.recording ?? null)
  const mixing = computed(() => settings.value?.mixing ?? null)
  const exportSettings = computed(() => settings.value?.export ?? null)
  const ui = computed(() => settings.value?.ui ?? null)
  const advanced = computed(() => settings.value?.advanced ?? null)

  /** ffmpeg 缺失的关键滤镜（UI 据此禁用相关控件） */
  const missingFilters = computed(() => capabilities.value?.ffmpeg.missing ?? [])
  const ffmpegReady = computed(() => capabilities.value?.ffmpeg.available ?? false)
  const embeddingReady = computed(() => capabilities.value?.embedding.available ?? false)
  const missingModels = computed(() => (capabilities.value?.models ?? []).filter(m => !m.ok))

  async function load(force = false): Promise<void> {
    if (settings.value && !force) return
    loading.value = true
    try {
      const [loaded, caps] = await Promise.all([
        call('settings:get', {}),
        callSafe('app:getCapabilities', undefined),
      ])
      settings.value = loaded
      if (caps) capabilities.value = caps
      lastError.value = null
    } catch (error) {
      lastError.value = error
    } finally {
      loading.value = false
    }
  }

  /**
   * 局部更新：主进程返回 changedKeys，成功后**重新拉取**（而不是把 patch 拍进本地），
   * 因为主进程可能会做归一化/联动（例如改采样率同时调整位深）。
   */
  async function patch(changes: DeepPartial<AppSettings>): Promise<string[]> {
    saving.value = true
    try {
      const result = await call('settings:set', { patch: changes })
      await load(true)
      return result.changedKeys
    } finally {
      saving.value = false
    }
  }

  /** 敏感项（API Key）单独走 setSecret，永不进入 settings 明文 */
  async function setSecret(key: string, value: string): Promise<boolean> {
    const result = await callSafe('settings:setSecret', { key, value })
    return result?.ok ?? false
  }

  async function testProvider(provider: AppSettings['ai'] & { apiKey?: string }): Promise<{ ok: boolean; message: string; latencyMs?: number } | null> {
    return await callSafe('settings:testProvider', { provider })
  }

  async function reset(keys?: string[]): Promise<void> {
    await call('settings:reset', keys ? { keys } : {})
    await load(true)
  }

  async function refreshCapabilities(): Promise<void> {
    const caps = await callSafe('app:getCapabilities', undefined)
    if (caps) capabilities.value = caps
  }

  /** 订阅设置变更（多窗口/任务包导入后主进程会改设置） */
  function init(): void {
    if (unsubscribe) return
    const offSettings = on('settings:changed', () => { void load(true) })
    const offCaps = on('app:capabilitiesChanged', (caps) => { capabilities.value = caps })
    unsubscribe = () => {
      offSettings()
      offCaps()
    }
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    settings, capabilities, loading, saving, lastError,
    audio, recording, mixing, exportSettings, ui, advanced,
    missingFilters, ffmpegReady, embeddingReady, missingModels,
    load, patch, setSecret, testProvider, reset, refreshCapabilities, init, dispose,
  }
})
