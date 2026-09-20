<!--
  Novel Studio · 设备诊断（docs/12 §6.1 / §6.2 / §11 / §12）
  ============================================================================
  设计依据：
    · docs/12 §6.1 —— 这一页是用户排除「没声音 / 声音小 / 有杂音」的最快手段：
      输入设备选择、采样率（请求 vs 设备实际）、声道、增益、监听、实时电平、
      底噪（3 秒测量）、削波、自检结论，一屏之内全给。
    · docs/12 §6.1 —— 自检「录 5 秒并回放」必须做，检查项固定五项：
      是否有信号、是否削波、是否丢帧、底噪水平、实际采样率 vs 请求采样率。
    · docs/12 §6.2 —— 延迟只能读到 baseLatency + outputLatency，**必须标注为估算值**，
      不能假装是端到端输入延迟。
    · docs/12 §11  —— 设备枚举只能在渲染进程做（授权后才有 label）；
      设备偏好与自检结果存主进程（device:list / device:savePreference / device:selfTestResult）。
    · docs/12 §12  —— 「设备丢失 / 权限被拒」这类错误由 error-bus 统一展示：
      自检 composable（useDeviceSelfTest）内部已经 reportError，本页**不重复弹**。

  结论与建议都在这里给出人话版本（采样率不一致 / 无信号 / 削波 / 掉帧），
  因为这些是「诊断结论」而不是「错误文案」——错误文案仍然只走 error-bus。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AppSettings, DeviceSelfTestResult } from '@shared/types.ts'
import { AUDIO_DEFAULTS, RECORD_LIMITS } from '@shared/constants.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LevelMeter from '@/shared/ui/LevelMeter.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { formatBytes, formatDb, formatDuration, formatInt, formatSampleRate, UNKNOWN } from '@/shared/lib/format.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useDeviceStore } from '../stores/device.store.ts'
import { useDeviceSelfTest } from '../composables/useRecorder.ts'
import { useMonitor } from '../composables/useMonitor.ts'

const devices = useDeviceStore()
const settings = useSettingsStore()
const session = useSessionStore()
const test = useDeviceSelfTest()
/** 监听图：诊断页要能验证「返送是否通」，因此复用同一套监听实现（docs/05 §11.2） */
const monitor = useMonitor()

/** 已成功上报主进程的自检结果（null = 还没上报） */
const submitted = ref<boolean | null>(null)
/**
 * 自检/回放的提示（docs/91 §5.2.38）：
 * 采集被中断（`AbortError`）与「没有可回放的缓冲」以前都是**静默**的 ——
 * 按了按钮什么都没发生、也没有任何文字解释，只能靠猜。
 */
const selfTestNotice = ref('')

// ---------------------------------------------------------------------------
// 设置项读写（唯一来源是 settings.audio，本页不缓存副本）
// ---------------------------------------------------------------------------

const audio = computed(() => settings.audio)

const sampleRate = computed(() => audio.value?.sampleRate ?? AUDIO_DEFAULTS.sampleRate)
const channels = computed(() => audio.value?.channels ?? AUDIO_DEFAULTS.channels)
const inputGainDb = computed(() => audio.value?.inputGainDb ?? 0)
const monitorEnabled = computed(() => audio.value?.monitorEnabled ?? false)
const monitorGainDb = computed(() => audio.value?.monitorGainDb ?? -6)
const preferredDeviceId = computed(() => audio.value?.defaultInputDeviceId ?? null)

const SAMPLE_RATE_CHOICES = [44_100, 48_000] as const
const CHANNEL_CHOICES = [1, 2] as const

async function patchAudio(patch: Partial<AppSettings['audio']>): Promise<void> {
  // patch 失败会由 ipc.call 走 error-bus（settings:set），本页不做二次提示
  await settings.patch({ audio: patch }).catch(() => undefined)
}

/** 采样率/声道的下拉变更（下拉 value 是字符串，这里统一收窄回数字） */
async function onSampleRateChange(event: Event): Promise<void> {
  const value = Number((event.target as HTMLSelectElement).value)
  if (value !== 44_100 && value !== 48_000) return
  await patchAudio({ sampleRate: value })
}

async function onChannelsChange(event: Event): Promise<void> {
  const value = Number((event.target as HTMLSelectElement).value)
  if (value !== 1 && value !== 2) return
  await patchAudio({ channels: value })
}

/** 下拉框的当前选择：空串 = 跟随系统默认设备 */
const selectedDeviceId = ref<string>('')

const inputOptions = computed(() => devices.inputs)
const outputCount = computed(() => devices.outputs.length)

const deviceSourceText = computed(() => {
  switch (devices.source) {
    case 'main': return '来自主进程的偏好记录（渲染进程未枚举到设备）'
    case 'renderer': return '来自渲染进程枚举（主进程暂无记录）'
    case 'merged': return '主进程偏好 + 渲染进程枚举合并'
    default: return '两个来源都没有设备'
  }
})

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

const SELF_TEST_MS = 5000

const result = computed<DeviceSelfTestResult | null>(() => test.result.value ?? devices.selfTestResult)
const testProgress = computed(() => {
  if (!test.running.value) return 0
  return Math.min(1, test.elapsedMs.value / SELF_TEST_MS)
})

async function runSelfTest(): Promise<void> {
  submitted.value = null
  selfTestNotice.value = ''
  const summary = await test.start({
    durationMs: SELF_TEST_MS,
    deviceId: selectedDeviceId.value || null,
    sampleRate: sampleRate.value,
    channels: channels.value,
  })
  if (!summary) {
    // 采集被中断 / 设备不可用：必须给出文字解释（静默 = 用户以为按钮坏了）
    selfTestNotice.value = '自检没有完成：采集被中断或输入设备不可用。请确认上面选中的输入设备、系统麦克风权限后重试。'
    return
  }
  // docs/12 §11：自检结果存主进程（本机偏好的一部分）
  submitted.value = await devices.submitSelfTest(summary)
}

function stopSelfTest(): void {
  test.stop()
}

async function playBack(): Promise<void> {
  selfTestNotice.value = ''
  const played = await test.play()
  if (!played) {
    selfTestNotice.value = '没有可回放的自检录音：请先完成一次「录 5 秒并回放」，再点回放。'
  }
}

// ---------------------------------------------------------------------------
// 五项检查项（docs/12 §6.1）——逐条给结论，不留「你自己看」
// ---------------------------------------------------------------------------

interface CheckItem {
  key: string
  label: string
  ok: boolean
  detail: string
  advice: string
}

const checks = computed<CheckItem[]>(() => {
  const r = result.value
  if (!r) return []
  const mismatch = r.requestedSampleRate > 0 && r.actualSampleRate > 0 && r.requestedSampleRate !== r.actualSampleRate
  return [
    {
      key: 'signal',
      label: '是否有输入信号（RMS > -50 dBFS）',
      ok: r.hasSignal,
      detail: `实测 RMS ${formatDb(r.rmsDb)}，峰值 ${formatDb(r.peakDb)}`,
      advice: r.hasSignal
        ? '有输入信号，设备链路正常'
        : '没有检测到信号：请检查麦克风是否静音、线缆/接口、系统输入设备选择，以及是否选错了输入通道',
    },
    {
      key: 'clipping',
      label: '是否削波（峰值触顶）',
      ok: !r.clipping,
      detail: r.clipping ? `峰值 ${formatDb(r.peakDb)}（已触顶）` : `峰值 ${formatDb(r.peakDb)}`,
      advice: r.clipping
        ? '输入过载：请降低设备侧增益或本页的输入增益后重录；过载的素材无法靠后期完全救回'
        : '未削波，峰值留有余量',
    },
    {
      key: 'dropped',
      label: '是否丢帧（采集样本数 vs 期望样本数）',
      ok: r.droppedFrames === 0,
      detail: `缺失约 ${formatInt(r.droppedFrames)} 帧`,
      advice: r.droppedFrames === 0
        ? '没有丢帧'
        : '出现丢帧：请关闭占用 CPU 的程序、避免使用蓝牙耳麦，并重试自检；录音会话中丢帧恒应为 0',
    },
    {
      key: 'noise',
      label: '底噪水平（滑动 3 秒的分位值）',
      ok: r.noiseFloorDb !== null && r.noiseFloorDb <= -50,
      detail: `底噪 ${formatDb(r.noiseFloorDb)}`,
      advice: r.noiseFloorDb === null
        ? '底噪还没测出来：先安静环境跑一次 5 秒自检'
        : r.noiseFloorDb <= -50
          ? '底噪干净，可以不启用降噪'
          : '底噪偏高：建议启用处理链降噪，并把「噪声底」设为实测值',
    },
    {
      key: 'sampleRate',
      label: '实际采样率 vs 请求采样率',
      ok: !mismatch,
      detail: `请求 ${formatSampleRate(r.requestedSampleRate)} / 设备实际 ${formatSampleRate(r.actualSampleRate)}`,
      advice: mismatch
        ? '两者不一致：请按设备实际采样率记录，并在采集后重采样；否则会出现音调偏移与对轨错位'
        : '采样率一致',
    },
  ]
})

const failedChecks = computed(() => checks.value.filter(item => !item.ok))
const hasResult = computed(() => result.value !== null)

/**
 * 建议增益：目标是峰值落在 -6 dBFS 附近（留 6 dB 余量，避免削波；docs/05 §2.5）。
 * 只在有实测峰值时给建议，且限制在 ±24 dB 之内（超过就该动设备侧增益了）。
 */
const suggestedGainDb = computed<number | null>(() => {
  const r = result.value
  if (!r || r.peakDb === null || !Number.isFinite(r.peakDb)) return null
  if (!r.hasSignal) return null
  const delta = -6 - r.peakDb
  if (Math.abs(delta) < 1.5) return null
  return Math.max(-24, Math.min(24, Math.round(delta)))
})

const gainAdviceText = computed(() => {
  const delta = suggestedGainDb.value
  if (delta === null) return '当前增益合适（峰值接近 -6 dBFS）'
  return delta > 0
    ? `当前偏小：建议输入增益 +${delta} dB（目标峰值 -6 dBFS）`
    : `当前偏大：建议输入增益 ${delta} dB（目标峰值 -6 dBFS）`
})

async function applySuggestedGain(): Promise<void> {
  const delta = suggestedGainDb.value
  if (delta === null) return
  const next = Math.max(-24, Math.min(24, inputGainDb.value + delta))
  await patchAudio({ inputGainDb: next })
}

// ---------------------------------------------------------------------------
// 设备与权限
// ---------------------------------------------------------------------------

async function refreshDevices(): Promise<void> {
  await devices.refresh()
  if (selectedDeviceId.value && !devices.devices.some(d => d.deviceId === selectedDeviceId.value)) {
    selectedDeviceId.value = ''
  }
}

async function grantPermission(): Promise<void> {
  const ok = await devices.ensurePermission()
  if (ok) await refreshDevices()
}

async function savePreference(): Promise<void> {
  const id = selectedDeviceId.value
  if (!id) return
  const label = devices.devices.find(d => d.deviceId === id)?.label ?? id
  if (await devices.savePreference(id, label)) await patchAudio({ defaultInputDeviceId: id })
}

async function toggleMonitor(): Promise<void> {
  const next = !monitorEnabled.value
  await patchAudio({ monitorEnabled: next })
  monitor.setEnabled(next)
}

async function applyMonitorGain(event: Event): Promise<void> {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  await patchAudio({ monitorGainDb: value })
  monitor.setGainDb(value)
}

async function persistInputGain(event: Event): Promise<void> {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  await patchAudio({ inputGainDb: value })
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(() => {
  void settings.load()
  void session.loadPaths()
  void refreshDevices()
  // 默认选中设置里的首选设备（没有偏好就用系统默认）
  selectedDeviceId.value = preferredDeviceId.value ?? ''
  monitor.setEnabled(monitorEnabled.value)
  monitor.setGainDb(monitorGainDb.value)
})

onBeforeUnmount(() => {
  if (test.running.value) test.stop()
  void test.release()
  monitor.dispose()
})

/** 会话里录音要求的磁盘余量（同一口径，告诉用户「这里也能先体检」） */
const requiredFreeText = computed(() => formatBytes(RECORD_LIMITS.requiredFreeBytes))
</script>

<template>
  <div class="ns-device-page">
    <header class="ns-device-page__header">
      <div>
        <h2 class="ns-device-page__title">设备诊断</h2>
        <p class="ns-device-page__subtitle">
          录音前先跑一次自检：有信号 / 不削波 / 不丢帧 / 底噪干净 / 采样率一致（docs/12 §6.1）
        </p>
      </div>
      <div class="ns-device-page__header-actions">
        <button type="button" class="ns-device-page__button" :disabled="devices.loading" @click="refreshDevices">
          {{ devices.loading ? '刷新中…' : '刷新设备' }}
        </button>
        <button
          v-if="!devices.labelAvailable"
          type="button"
          class="ns-device-page__button is-primary"
          @click="grantPermission"
        >
          授权麦克风（解锁设备名）
        </button>
      </div>
    </header>

    <LoadingBlock v-if="settings.loading && !audio" text="正在读取设置…" :rows="4" />

    <template v-else>
      <!-- ── 设备与参数（docs/12 §6.1 上半屏）────────────────────────────── -->
      <section class="ns-device-page__card">
        <h3 class="ns-device-page__card-title">输入设备与格式</h3>
        <div class="ns-device-page__grid">
          <label class="ns-device-page__field">
            <span>输入设备</span>
            <select v-model="selectedDeviceId" class="ns-device-page__control">
              <option value="">跟随系统默认设备</option>
              <option v-for="device in inputOptions" :key="device.deviceId" :value="device.deviceId">
                {{ device.label }}{{ device.isDefault ? '（默认）' : '' }}
              </option>
            </select>
          </label>

          <label class="ns-device-page__field">
            <span>采样率（请求）</span>
            <select
              class="ns-device-page__control"
              :value="sampleRate"
              @change="onSampleRateChange"
            >
              <option v-for="rate in SAMPLE_RATE_CHOICES" :key="rate" :value="rate">
                {{ formatSampleRate(rate) }}
              </option>
            </select>
          </label>

          <label class="ns-device-page__field">
            <span>声道</span>
            <select
              class="ns-device-page__control"
              :value="channels"
              @change="onChannelsChange"
            >
              <option v-for="count in CHANNEL_CHOICES" :key="count" :value="count">
                {{ count === 1 ? '单声道' : '双声道' }}
              </option>
            </select>
          </label>

          <label class="ns-device-page__field">
            <span>输入增益：{{ formatDb(inputGainDb, 0) }}</span>
            <input
              class="ns-device-page__range"
              type="range"
              min="-24"
              max="24"
              step="1"
              :value="inputGainDb"
              @change="persistInputGain"
            >
          </label>

          <div class="ns-device-page__field">
            <span>监听返送</span>
            <div class="ns-device-page__inline">
              <button type="button" class="ns-device-page__button" @click="toggleMonitor">
                {{ monitorEnabled ? '已启用（点击关闭）' : '已关闭（点击启用）' }}
              </button>
              <input
                class="ns-device-page__range"
                type="range"
                min="-30"
                max="6"
                step="1"
                :value="monitorGainDb"
                :disabled="!monitorEnabled"
                @change="applyMonitorGain"
              >
              <span class="ns-device-page__value">音量 {{ formatDb(monitorGainDb, 0) }}</span>
            </div>
          </div>

          <div class="ns-device-page__field">
            <span>延迟（估算）</span>
            <p class="ns-device-page__value">
              {{ test.latencyMs.value === null ? UNKNOWN : `${formatInt(test.latencyMs.value)} ms` }}
              <em>＝ baseLatency + outputLatency；输入延迟无法直读（docs/12 §6.2）</em>
            </p>
          </div>
        </div>

        <div class="ns-device-page__inline ns-device-page__inline--spread">
          <p class="ns-device-page__note">
            设备来源：{{ deviceSourceText }} · 已枚举 {{ formatInt(devices.devices.length) }} 个（输入
            {{ formatInt(inputOptions.length) }} / 输出 {{ formatInt(outputCount) }}）
          </p>
          <button
            type="button"
            class="ns-device-page__button"
            :disabled="!selectedDeviceId"
            @click="savePreference"
          >
            保存为我的首选设备
          </button>
        </div>
        <p v-if="!devices.labelAvailable" class="ns-device-page__warn">
          设备名显示为「未授权」：浏览器只在授权后才返回 label，点上方「授权麦克风」即可（授权只用于解锁设备名，不会录音）。
        </p>
        <p v-if="!devices.hasDevices" class="ns-device-page__warn">
          没有枚举到任何音频设备：请检查系统是否已接入麦克风，或点击「刷新设备」重试。
        </p>
      </section>

      <!-- ── 实时电平 / 底噪 / 削波（docs/12 §6.1 中段）──────────────────── -->
      <section class="ns-device-page__card">
        <h3 class="ns-device-page__card-title">实时电平与底噪</h3>
        <LevelMeter
          :rms-db="test.meter.rmsDb.value"
          :peak-db="test.meter.peakDb.value"
          :clipping="test.meter.clipping.value"
          label="输入电平"
          :height="14"
          @clear-clip="test.meter.clearClip()"
        />

        <div class="ns-device-page__metrics">
          <span>底噪（3 秒窗口）：<strong>{{ formatDb(test.meter.noiseFloorDb.value) }}</strong></span>
          <span>语音段计数：{{ formatInt(test.meter.speechRunCount.value) }}</span>
          <span>削波事件：<strong :class="{ 'is-bad': test.meter.clipEvents.value > 0 }">{{ formatInt(test.meter.clipEvents.value) }}</strong></span>
          <span>峰值贴顶块数：<strong :class="{ 'is-bad': test.meter.overloadBlocks.value > 0 }">{{ formatInt(test.meter.overloadBlocks.value) }}</strong></span>
        </div>

        <div class="ns-device-page__inline">
          <button
            type="button"
            class="ns-device-page__button is-primary"
            :disabled="test.running.value"
            @click="runSelfTest"
          >
            {{ test.running.value ? `采集中… ${formatDuration(test.elapsedMs.value)} / ${formatDuration(SELF_TEST_MS)}` : '▶ 录 5 秒并回放' }}
          </button>
          <button type="button" class="ns-device-page__button" :disabled="!test.running.value" @click="stopSelfTest">
            提前结束
          </button>
          <button type="button" class="ns-device-page__button" :disabled="!hasResult" @click="playBack">
            ▶ 回放刚才的录音
          </button>          <button
            type="button"
            class="ns-device-page__button"
            :disabled="test.meter.noiseFloorDb.value === null"
            @click="devices.useAsNoiseReference()"
          >
            作为降噪参考
          </button>
        </div>

        <div v-if="test.running.value" class="ns-device-page__progress">
          <div class="ns-device-page__progress-bar" :style="{ width: `${Math.round(testProgress * 100)}%` }" />
        </div>

        <!-- 自检/回放的回执：中断与「没有可回放缓冲」都必须有文字，否则按钮像坏的 -->
        <p v-if="selfTestNotice" class="ns-device-page__notice">{{ selfTestNotice }}</p>

        <p class="ns-device-page__note">
          降噪参考值：
          {{ devices.noiseReferenceDb === null ? '未设置' : formatDb(devices.noiseReferenceDb) }}
          · 底噪测量窗口 3 秒，请在这段时间保持安静（这也正是「底噪」的含义）
        </p>
      </section>

      <!-- ── 自检结论（docs/12 §6.1 下半屏）────────────────────────────── -->
      <section class="ns-device-page__card">
        <h3 class="ns-device-page__card-title">自检结论</h3>

        <EmptyState
          v-if="!hasResult"
          title="还没有自检结果"
          description="点上面的「录 5 秒并回放」，对着麦克风正常说几句话，稍后会给出五项检查的结论与建议。"
          icon="🎙️"
          size="small"
        />

        <template v-else>
          <ul class="ns-device-page__checks">
            <li v-for="item in checks" :key="item.key" :class="item.ok ? 'is-ok' : 'is-bad'">
              <span class="ns-device-page__check-mark">{{ item.ok ? '✓' : '✗' }}</span>
              <div>
                <p class="ns-device-page__check-label">{{ item.label }}</p>
                <p class="ns-device-page__check-detail">{{ item.detail }} —— {{ item.advice }}</p>
              </div>
            </li>
          </ul>

          <p class="ns-device-page__verdict">
            总体结论：{{ failedChecks.length === 0 ? '正常（无丢帧、无削波、采样率一致）' : `${failedChecks.length} 项需要处理：${failedChecks.map(i => i.label).join('、')}` }}
          </p>

          <p v-if="result?.suggestion" class="ns-device-page__suggestion">
            主进程建议：{{ result.suggestion }}
          </p>

          <p class="ns-device-page__note">
            结果上报主进程：{{ submitted === null ? '本次尚未上报' : submitted ? '已保存' : '保存失败（已记日志）' }}
            · 采样率不一致时必须按设备实际采样率记录并在采集后重采样（docs/05 §2.1）
          </p>
        </template>
      </section>

      <!-- ── 增益建议 ────────────────────────────────────────────────────── -->
      <section class="ns-device-page__card">
        <h3 class="ns-device-page__card-title">增益建议</h3>
        <p class="ns-device-page__note">
          目标：峰值落在 -6 dBFS 附近，给后续处理留 6 dB 余量（docs/05 §2.5）。
          落盘建议用 32-bit float：即使增益加过头也能在后期救回来。
        </p>
        <div class="ns-device-page__inline">
          <span class="ns-device-page__value">{{ gainAdviceText }}</span>
          <button
            type="button"
            class="ns-device-page__button is-primary"
            :disabled="suggestedGainDb === null || settings.saving"
            @click="applySuggestedGain"
          >
            应用建议增益
          </button>
        </div>
        <p class="ns-device-page__note">
          录音会话的最小磁盘余量要求：{{ requiredFreeText }}（主进程在 record:prepare 时还会再检查一次）
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ns-device-page { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow-y: auto; }
.ns-device-page__header { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; justify-content: space-between; }
.ns-device-page__title { margin: 0; font-size: 18px; color: var(--ns-text-primary, #303133); }
.ns-device-page__subtitle { margin: 4px 0 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-device-page__header-actions { display: flex; gap: 8px; }
.ns-device-page__card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff); }
.ns-device-page__card-title { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-device-page__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 18px; }
.ns-device-page__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-device-page__control { padding: 5px 8px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 13px; color: var(--ns-text-primary, #303133); }
.ns-device-page__range { width: 100%; max-width: 220px; }
.ns-device-page__inline { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; font-size: 12px; color: var(--ns-text-regular, #606266); }
.ns-device-page__inline--spread { justify-content: space-between; }
.ns-device-page__button { padding: 5px 12px; border: 1px solid var(--ns-border, #dcdfe6); border-radius: 4px; background: var(--ns-bg-elevated); font-size: 13px; color: var(--ns-text-regular, #606266); cursor: pointer; }
.ns-device-page__button:hover:not(:disabled) { border-color: var(--ns-primary, #409eff); color: var(--ns-primary, #409eff); }
.ns-device-page__button.is-primary { border-color: var(--ns-primary, #409eff); background: var(--ns-primary, #409eff); color: #fff; }
.ns-device-page__button:disabled { cursor: not-allowed; opacity: 0.5; }
.ns-device-page__metrics { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ns-text-regular, #606266); }
.ns-device-page__metrics .is-bad { color: var(--ns-danger, #f56c6c); }
.ns-device-page__value em { margin-left: 6px; font-style: normal; color: var(--ns-text-secondary, #909399); }
.ns-device-page__progress { height: 6px; overflow: hidden; border-radius: 3px; background: var(--ns-fill, #ebeef5); }
.ns-device-page__progress-bar { height: 100%; background: var(--ns-primary, #409eff); transition: width 0.1s linear; }
.ns-device-page__checks { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.ns-device-page__checks li { display: flex; gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--ns-fill-light, #f5f7fa); }
.ns-device-page__checks li.is-ok { border-left: 3px solid var(--ns-success, #67c23a); }
.ns-device-page__checks li.is-bad { border-left: 3px solid var(--ns-danger, #f56c6c); background: rgb(245 108 108 / 8%); }
.ns-device-page__check-mark { font-weight: 700; }
.ns-device-page__checks li.is-ok .ns-device-page__check-mark { color: var(--ns-success, #67c23a); }
.ns-device-page__checks li.is-bad .ns-device-page__check-mark { color: var(--ns-danger, #f56c6c); }
.ns-device-page__check-label { margin: 0; font-size: 13px; color: var(--ns-text-primary, #303133); }
.ns-device-page__check-detail { margin: 2px 0 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-device-page__verdict { margin: 0; font-size: 13px; font-weight: 600; color: var(--ns-text-primary, #303133); }
.ns-device-page__suggestion { margin: 0; padding: 8px 10px; border-radius: 4px; background: rgb(230 162 60 / 12%); font-size: 12px; color: var(--ns-warning, #e6a23c); }
.ns-device-page__warn { margin: 0; font-size: 12px; color: var(--ns-warning, #e6a23c); }
.ns-device-page__note { margin: 0; font-size: 12px; color: var(--ns-text-secondary, #909399); }
.ns-device-page__notice {
  margin: 8px 0 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgb(230 162 60 / 14%);
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.7;
}
</style>
