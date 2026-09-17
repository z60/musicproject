<!--
  Novel Studio · BGM/SFX 轨配置（docs/14 §8「使用位置」、docs/15 §2 MixTrack.music）
  ============================================================================
  职责边界（很重要，避免和素材库重复）：
    · 本组件只管「**这一章要放哪一段**」：素材、入点、出点、循环、淡入淡出、ducking 概要；
    · 素材本身的导入/探测/标签/授权在 MusicLibraryPanel；
    · ducking 的五个参数在 DuckingPanel（本组件只显示概要并给入口）。

  波形条为什么是 Canvas：素材可能是 5 分钟的交响乐，DOM 柱状图会直接把渲染进程拖死
  （docs 明确禁止堆 DOM 柱）。这里用 `analysis:peaks` 的真实峰值画一条简版波形，
  再叠加「入出点区间 + 淡入淡出三角 + 循环标记」，肉眼就能判断出点有没有切在音乐中间。

  合法性校验（写在这里而不是丢给渲染器）：
    · 出点必须大于入点；
    · 淡入 + 淡出 > 有效时长 → 明确报错（渲染侧只会夹紧，用户会以为「填了没生效」）；
    · 未设出点且非循环 + 已知素材时长 → 提示实际会用满全长。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMixStore } from '../stores/mix.store.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { formatDuration, formatDb } from '@/shared/lib/format.ts'
import { prepareCanvas } from '../composables/useMeter.ts'
import { callSafe } from '@/shared/lib/ipc.ts'
import type { Id, MusicAsset, MixTrack } from '@shared/types.ts'

const props = defineProps<{ track: MixTrack }>()

const emit = defineEmits<{
  /** 请求视图展开/滚动到 DuckingPanel */
  'open-ducking': []
  /** 请求视图展开素材库（去导入/试听素材） */
  'open-library': []
}>()

const mix = useMixStore()
const session = useSessionStore()

const STEPS = { start: 10, fade: 50, end: 100 }

const canvasRef = ref<HTMLCanvasElement | null>(null)
const peaks = ref<number[]>([])
const peaksLoading = ref(false)
const peaksError = ref<string | null>(null)

const config = computed(() => props.track.music)
const assets = computed(() => mix.allAssets.filter(asset => asset.kind === (props.track.kind === 'sfx' ? 'sfx' : 'bgm')))
const asset = computed<MusicAsset | null>(() => {
  const id = config.value?.assetId
  if (!id) return null
  return mix.allAssets.find(item => item.id === id) ?? null
})

/** 素材实测时长优先用探测结果（probe 过才有），否则用库里的 durationMs */
const assetDurationMs = computed<number | null>(() => {
  const id = asset.value?.id
  if (id && mix.assetMetrics[id]) return mix.assetMetrics[id]?.durationMs ?? null
  return asset.value?.durationMs ?? null
})

const startMs = computed(() => config.value?.startMs ?? 0)
const endMs = computed(() => config.value?.endMs ?? null)
const fadeInMs = computed(() => config.value?.fadeInMs ?? 0)
const fadeOutMs = computed(() => config.value?.fadeOutMs ?? 0)
const loop = computed(() => config.value?.loop ?? false)

/** 有效片段时长（出点为空时按素材全长算，未知则按 0 处理并单独提示） */
const effectiveDurationMs = computed(() => {
  const end = endMs.value ?? assetDurationMs.value
  if (end === null) return null
  return Math.max(0, end - startMs.value)
})

const peakAdviceText = computed(() => {
  const current = asset.value
  if (!current) return null
  return mix.peakAdvice(current)
})

/** 校验结果：error 阻断套用，warning 只提醒（与渲染侧的夹紧行为对齐） */
const validation = computed<{ level: 'error' | 'warning'; text: string } | null>(() => {
  const duration = effectiveDurationMs.value
  if (!config.value) return null
  if (endMs.value !== null && endMs.value <= startMs.value) {
    return { level: 'error', text: `出点（${endMs.value} ms）必须大于入点（${startMs.value} ms）` }
  }
  if (duration !== null && duration <= 0) {
    return { level: 'error', text: '有效时长为 0：请检查入点/出点与素材时长' }
  }
  if (duration !== null && fadeInMs.value + fadeOutMs.value > duration) {
    return {
      level: 'error',
      text: `淡入 + 淡出（${fadeInMs.value + fadeOutMs.value} ms）超过片段时长（${duration} ms）：`
        + '渲染时只会被夹紧，请调小淡入淡出或拉长片段',
    }
  }
  if (duration !== null && fadeInMs.value > duration / 2) {
    return { level: 'warning', text: `淡入 ${fadeInMs.value} ms 超过片段一半，音乐会被「吞掉」开头` }
  }
  if (duration !== null && fadeOutMs.value > duration / 2) {
    return { level: 'warning', text: `淡出 ${fadeOutMs.value} ms 超过片段一半，收尾会显得仓促` }
  }
  if (endMs.value === null && !loop.value && assetDurationMs.value === null) {
    return { level: 'warning', text: '还没有素材时长信息：点「探测素材」拿到时长后会自动填入出点' }
  }
  return null
})

/** 循环次数估算：让用户知道「这段音乐会重复几遍」 */
const loopCount = computed(() => {
  if (!loop.value || !assetDurationMs.value || !effectiveDurationMs.value) return null
  const span = assetDurationMs.value - startMs.value
  if (span <= 0) return null
  return Math.max(1, Math.ceil(effectiveDurationMs.value / span))
})

// ── 配置写入（全部经 store.patchMusic，保证乐观 UI + 防抖落库）────────────
function patch(patchValue: Partial<NonNullable<MixTrack['music']>>): void {
  mix.patchMusic(props.track.id, patchValue)
}

function patchEnd(value: number | null): void {
  patch({ endMs: value })
}

// ── 模板事件处理器（el-* 是全局组件，模板里拿不到载荷类型，统一在这里声明）──
/** el-input-number 的载荷是数字，清空时是 undefined */
function onStartMsChange(value: number | undefined): void {
  patch({ startMs: Math.max(0, Number(value ?? 0)) })
}

/** 出点：清空（undefined）表示「用满素材」*/
function onEndMsChange(value: number | undefined): void {
  patchEnd(value ?? null)
}

/** 淡入：清空时按 0 处理 */
function onFadeInMsChange(value: number | undefined): void {
  patch({ fadeInMs: Math.max(0, Number(value ?? 0)) })
}

/** 淡出：清空时按 0 处理 */
function onFadeOutMsChange(value: number | undefined): void {
  patch({ fadeOutMs: Math.max(0, Number(value ?? 0)) })
}

/** el-switch 的载荷是三态（boolean / string / number），这里只认「明确打开」*/
function onLoopChange(value: boolean | string | number): void {
  patch({ loop: value === true })
}

function adoptAsset(assetId: string): void {
  const target = mix.allAssets.find(item => item.id === assetId)
  if (!target) return
  mix.assignMusicAsset(props.track.id, target)
  void loadPeaks()
  // 指派后自动探测一次：拿到时长/峰值/响度，后面的校验才有数据支撑
  void mix.probeAsset(target.id).then(() => { void loadPeaks() })
}

/** el-select 的载荷是所选素材 id（el-option :value="item.id"；清空时给空值）*/
function onAssetChange(value: Id | null): void {
  if (value) adoptAsset(String(value))
}

function initConfig(): void {
  mix.patchMusic(props.track.id, { assetId: props.track.refId ?? '', startMs: 0 })
}

function adoptSuggestedGain(): void {
  mix.patchTrack(props.track.id, { gainDb: mix.suggestedMusicGainDb() })
}

// ── 波形（analysis:peaks，真实峰值而不是假动画）──────────────────────────
async function loadPeaks(): Promise<void> {
  const current = asset.value
  if (!current) {
    peaks.value = []
    peaksError.value = null
    return
  }
  peaksLoading.value = true
  peaksError.value = null
  try {
    const result = await callSafe('analysis:peaks', {
      path: current.filePath,
      peaksPerSec: 10,
      fromMs: 0,
      toMs: Math.max(1, assetDurationMs.value ?? 30_000),
    })
    const list = (result?.peaks ?? []).map(value => Math.min(1, Math.abs(value)))
    peaks.value = list
    if (!list.length) peaksError.value = '未能读取波形峰值（素材可能还没探测，或文件已被移动）'
  } finally {
    peaksLoading.value = false
  }
}

function draw(): void {
  const frame = prepareCanvas(canvasRef.value)
  if (!frame) return
  const { ctx, width, height } = frame
  ctx.clearRect(0, 0, width, height)

  const total = Math.max(
    1000,
    assetDurationMs.value ?? Math.max(endMs.value ?? 0, startMs.value + 1000),
  )
  const x = (ms: number): number => (Math.min(total, Math.max(0, ms)) / total) * width
  const midY = height / 2

  // 底
  ctx.fillStyle = 'rgba(0, 0, 0, 0.04)'
  ctx.fillRect(0, 0, width, height)

  // 波形（简版：每列取峰值段包络）
  if (peaks.value.length) {
    const perColumn = peaks.value.length / width
    ctx.fillStyle = 'rgba(64, 158, 255, 0.55)'
    for (let px = 0; px < width; px += 1) {
      const from = Math.floor(px * perColumn)
      const to = Math.max(from + 1, Math.floor((px + 1) * perColumn))
      let peak = 0
      for (let i = from; i < to && i < peaks.value.length; i += 1) {
        peak = Math.max(peak, peaks.value[i] ?? 0)
      }
      const half = Math.max(0.5, (peak * height) / 2.2)
      ctx.fillRect(px, midY - half, 1, half * 2)
    }
  } else {
    ctx.fillStyle = 'rgba(144, 147, 153, 0.5)'
    ctx.font = '11px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'center'
    ctx.fillText(peaksLoading.value ? '波形加载中…' : '暂无可绘制的波形数据', width / 2, midY + 4)
  }

  // 选中的入出点区间
  const fromX = x(startMs.value)
  const toX = x(endMs.value ?? total)
  ctx.fillStyle = 'rgba(103, 194, 58, 0.16)'
  ctx.fillRect(fromX, 0, Math.max(1, toX - fromX), height)
  ctx.strokeStyle = 'rgba(103, 194, 58, 0.9)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(fromX + 0.5, 0)
  ctx.lineTo(fromX + 0.5, height)
  ctx.moveTo(toX - 0.5, 0)
  ctx.lineTo(toX - 0.5, height)
  ctx.stroke()

  // 淡入 / 淡出三角（把「听感会怎么变」画出来）
  const fadeInW = effectiveDurationMs.value
    ? Math.max(1, ((Math.min(fadeInMs.value, effectiveDurationMs.value) / total) * width))
    : 0
  const fadeOutW = effectiveDurationMs.value
    ? Math.max(1, ((Math.min(fadeOutMs.value, effectiveDurationMs.value) / total) * width))
    : 0
  ctx.strokeStyle = 'rgba(230, 162, 60, 0.95)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(fromX, midY * 2 - 2)
  ctx.lineTo(fromX + fadeInW, 2)
  ctx.moveTo(toX, midY * 2 - 2)
  ctx.lineTo(toX - fadeOutW, 2)
  ctx.stroke()

  // 循环标记
  if (loop.value && assetDurationMs.value) {
    ctx.strokeStyle = 'rgba(64, 158, 255, 0.7)'
    ctx.setLineDash([3, 3])
    for (let cursor = assetDurationMs.value; cursor < total; cursor += assetDurationMs.value) {
      const cx = x(cursor)
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, height)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  // 刻度（首尾各一个时间）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.font = '10px ui-monospace, Consolas, monospace'
  ctx.textAlign = 'left'
  ctx.fillText('0:00', 2, height - 3)
  ctx.textAlign = 'right'
  ctx.fillText(formatDuration(total), width - 2, height - 3)
}

onMounted(() => {
  void loadPeaks()
  window.addEventListener('resize', draw)
})

onBeforeUnmount(() => { window.removeEventListener('resize', draw) })

watch(() => [peaks.value, startMs.value, endMs.value, fadeInMs.value, fadeOutMs.value, loop.value, assetDurationMs.value], () => draw(), { deep: true })
watch(() => props.track.id, () => { void loadPeaks() })
</script>

<template>
  <section class="ns-mtedit">
    <header class="ns-mtedit__head">
      <div>
        <h3>{{ track.kind === 'sfx' ? '音效轨配置' : 'BGM 轨配置' }}：{{ track.name }}</h3>
        <p class="ns-hint">
          这里配置「本章放哪一段音乐、从哪到哪、循环几次、怎么淡入淡出」；
          素材本身的导入与试听在素材库，闪避曲线在闪避面板。
        </p>
      </div>
      <div class="ns-mtedit__ops">
        <el-button size="small" @click="emit('open-library')">打开素材库</el-button>
        <el-button size="small" :loading="peaksLoading" @click="loadPeaks">重载波形</el-button>
        <el-button size="small" @click="emit('open-ducking')">闪避设置</el-button>
      </div>
    </header>

    <div v-if="!config" class="ns-mtedit__empty">
      <p class="ns-hint">这条轨还没有音乐配置（可能是从旧方案读进来的）</p>
      <el-button size="small" type="primary" @click="initConfig">初始化配置</el-button>
    </div>

    <template v-else>
      <!-- 素材 -->
      <div class="ns-mtedit__row">
        <span class="ns-label">素材</span>
        <el-select
          :model-value="config.assetId || null"
          size="small"
          filterable
          clearable
          placeholder="从素材库选择"
          class="ns-mtedit__select"
          @change="onAssetChange"
        >
          <el-option
            v-for="item in assets"
            :key="item.id"
            :label="`${item.name}${item.durationMs ? `（${formatDuration(item.durationMs)}）` : ''}`"
            :value="item.id"
          />
        </el-select>
        <el-button
          size="small"
          :disabled="!asset"
          :loading="mix.assetsLoading"
          @click="asset && mix.probeAsset(asset.id)"
        >
          探测素材
        </el-button>
        <span v-if="asset" class="ns-hint">
          {{ formatDuration(assetDurationMs) }} ·
          峰值 {{ formatDb(mix.assetMetrics[asset.id]?.peakDb ?? asset.peakDb) }} dBFS ·
          响度 {{ formatDb(mix.assetMetrics[asset.id]?.lufs ?? asset.lufs) }} LUFS
        </span>
        <span v-else class="ns-hint">还没有指定素材：这条轨在混音时不会有声音</span>
      </div>

      <p v-if="peakAdviceText" class="ns-warn">{{ peakAdviceText }}</p>
      <p v-if="peaksError" class="ns-hint">{{ peaksError }}</p>

      <!-- 波形条 + 入出点/淡入淡出可视化 -->
      <canvas ref="canvasRef" class="ns-mtedit__wave" height="88" />

      <!-- 入出点与淡入淡出（数字输入，docs/15 §2 MixTrack.music 字段） -->
      <div class="ns-mtedit__grid">
        <label class="ns-field">
          <span class="ns-label">入点 (ms)</span>
          <el-input-number
            :model-value="startMs"
            :min="0"
            :step="STEPS.start"
            size="small"
            controls-position="right"
            @change="onStartMsChange"
          />
          <span class="ns-hint">{{ formatDuration(startMs) }}</span>
        </label>

        <label class="ns-field">
          <span class="ns-label">出点 (ms)</span>
          <el-input-number
            :model-value="endMs ?? undefined"
            :min="0"
            :step="STEPS.end"
            size="small"
            controls-position="right"
            placeholder="留空 = 用满素材"
            @change="onEndMsChange"
          />
          <span class="ns-hint">{{ endMs === null ? '未设出点' : formatDuration(endMs) }}</span>
        </label>

        <label class="ns-field">
          <span class="ns-label">淡入 (ms)</span>
          <el-input-number
            :model-value="fadeInMs"
            :min="0"
            :step="STEPS.fade"
            size="small"
            controls-position="right"
            @change="onFadeInMsChange"
          />
        </label>

        <label class="ns-field">
          <span class="ns-label">淡出 (ms)</span>
          <el-input-number
            :model-value="fadeOutMs"
            :min="0"
            :step="STEPS.fade"
            size="small"
            controls-position="right"
            @change="onFadeOutMsChange"
          />
        </label>

        <label class="ns-field">
          <span class="ns-label">循环</span>
          <el-switch
            :model-value="loop"
            size="small"
            @change="onLoopChange"
          />
          <span class="ns-hint">
            {{ loopCount ? `约循环 ${loopCount} 遍` : '不循环：播完即结束' }}
          </span>
        </label>

        <div class="ns-field">
          <span class="ns-label">出点快捷</span>
          <el-button size="small" :disabled="!assetDurationMs" @click="patchEnd(assetDurationMs)">
            用满素材
          </el-button>
          <el-button size="small" :disabled="!assetDurationMs" @click="patchEnd(startMs + 30_000)">
            入点 + 30 s
          </el-button>
        </div>
      </div>

      <p v-if="validation" :class="validation.level === 'error' ? 'ns-error' : 'ns-warn'">
        {{ validation.text }}
      </p>

      <!-- 音量与 ducking 概要 -->
      <div class="ns-mtedit__summary">
        <div class="ns-mtedit__gain">
          <span class="ns-label">轨道音量</span>
          <strong>{{ formatDb(track.gainDb) }} dB</strong>
          <el-button size="small" @click="adoptSuggestedGain">
            采用建议值（{{ formatDb(mix.suggestedMusicGainDb()) }} dB）
          </el-button>
          <span class="ns-hint">BGM 比人声低 18~24 dB 最稳妥（docs/14 §8）</span>
        </div>
        <div class="ns-mtedit__duck">
          <span class="ns-label">闪避</span>
          <el-tag size="small" :type="config.ducking.enabled ? 'success' : 'info'">
            {{ config.ducking.enabled ? `开（${formatDb(config.ducking.amountDb)} dB）` : '关' }}
          </el-tag>
          <span class="ns-hint">
            模式 {{ config.ducking.mode === 'sidechain' ? '侧链压缩' : '按画本行包络' }} ·
            阈值 {{ formatDb(config.ducking.thresholdDb) }} dB ·
            {{ config.ducking.attackMs }}/{{ config.ducking.releaseMs }} ms
          </span>
          <el-button size="small" @click="emit('open-ducking')">调整</el-button>
        </div>
      </div>

      <p class="ns-hint">
        有效片段时长：{{ formatDuration(effectiveDurationMs) }} ·
        素材文件：{{ asset?.originalName ?? asset?.filePath ?? '未指定' }}
        <template v-if="session.projectId === null">（未选择项目：素材路径无法解析）</template>
      </p>
    </template>
  </section>
</template>

<style scoped>
.ns-mtedit { display: flex; flex-direction: column; gap: 8px; }
.ns-mtedit__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-mtedit h3 { margin: 0; font-size: 13.5px; color: var(--ns-text-primary, #303133); }
.ns-mtedit__ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-label { color: var(--ns-text-regular, #606266); font-size: 11.5px; white-space: nowrap; }
.ns-warn { margin: 0; color: var(--ns-warning, #e6a23c); font-size: 11.5px; }
.ns-error { margin: 0; color: var(--ns-danger, #f56c6c); font-size: 11.5px; }
.ns-mtedit__empty { display: flex; align-items: center; gap: 10px; }
.ns-mtedit__row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-mtedit__select { width: 240px; }
.ns-mtedit__wave {
  display: block; width: 100%; height: 88px; border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px; background: var(--ns-bg-elevated, #fff);
}
.ns-mtedit__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px 12px; }
.ns-field { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ns-mtedit__summary {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-mtedit__gain,
.ns-mtedit__duck { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ns-mtedit__gain strong { color: var(--ns-text-primary, #303133); font-family: ui-monospace, Consolas, monospace; }
</style>
