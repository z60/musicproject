<!--
  Novel Studio · take 列表（docs/12 §3.1 右侧 / §8.1 多 take 管理 / §3.3 分段）
  ============================================================================
  设计依据：
    · docs/12 §8.1 —— 列 durationMs / peakDb / rmsDb / source / flags / isSelected；
                      A/B 对比、设为成品、删除（软删/硬删）、打标、合并分段
    · docs/12 §3.3 —— 超长行分段录：同一个 line 的多个 part 按 partIndex 排序后合并
    · docs/12 §8.2 —— 补录需要「选中 take 内的一段区间」→ 这里提供区间输入
    · docs/12 §13  —— 多 take：同一行录 5 次全部保留、A/B 可切、设为成品唯一
    · docs/01 §4.3 —— 音频访问只能走 ns-media://（segmentUrl + 缓存破坏参数）

  试听用**一个** <audio> 元素（不是每行一个）：
    同一时刻只该有一路试听；多元素会导致「点了两行同时在放」。
    该元素通过 `player-ready` 交给录音页，由它挂进监听图（docs/12 §7「监听已有轨道」）。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Take } from '@shared/types.ts'
import { mediaUrlWithCacheBust, segmentUrl } from '@/shared/lib/media-url.ts'
import { UNKNOWN, formatDate, formatDb, formatDuration, formatRelativeTime } from '@/shared/lib/format.ts'
import { TAKE_FLAG_PRESETS } from '../stores/takes.store.ts'

const props = withDefaults(defineProps<{
  takes: Take[]
  /** 当前成品 id（isSelected 的那个） */
  selectedId?: string | null
  projectId: string
  loading?: boolean
  /** 打标筛选：命中的 take 才显示（空数组 = 不过滤） */
  activeFlags?: string[]
  /** 是否具备合并分段条件（同一行 ≥2 个 part） */
  canCombineParts?: boolean
  /** 补录区间的默认值（毫秒） */
  punchInMs?: number
  punchOutMs?: number
  /** 是否显示「来源」列（任务包回收的 take 要能看出来） */
  showSource?: boolean
  compact?: boolean
}>(), {
  selectedId: null,
  loading: false,
  activeFlags: () => [],
  canCombineParts: false,
  punchInMs: 0,
  punchOutMs: 0,
  showSource: true,
  compact: false,
})

const emit = defineEmits<{
  select: [takeId: string]
  /** hard=false 为软删（可找回），true 为硬删文件 */
  remove: [takeId: string, hard: boolean]
  flag: [takeId: string, flag: string]
  combine: [takeIds: string[]]
  play: [takeId: string]
  compare: [takeIdA: string, takeIdB: string]
  /** 补录区间变化（录音页据此调用 record:punchIn） */
  'punch-range': [payload: { takeId: string; srcInMs: number; srcOutMs: number }]
  /** <audio> 元素就绪（录音页把它挂进监听图） */
  'player-ready': [element: HTMLAudioElement]
}>()

const playerRef = ref<HTMLAudioElement | null>(null)
const playingId = ref<string | null>(null)
/** A/B 对比选中的两个 take（按点击顺序） */
const comparePicks = ref<string[]>([])
/** 展开的 take（显示区间/补录输入） */
const expandedId = ref<string | null>(null)
const punchIn = ref<number>(0)
const punchOut = ref<number>(0)

const visibleTakes = computed(() => {
  if (!props.activeFlags.length) return props.takes
  return props.takes.filter(t => t.flags.some(f => props.activeFlags.includes(f)))
})

const SOURCE_LABELS: Record<Take['source'], string> = {
  local: '本地录制',
  package: '任务包回收',
  import: '外部导入',
}

function urlOf(take: Take): string {
  const base = segmentUrl(props.projectId, take.filePath)
  if (!base) return ''
  // 同名文件重录后浏览器会命中旧缓存，必须带版本参数（docs/01 §4.3 的坑）
  return mediaUrlWithCacheBust(base, take.recordedAt)
}

/** 试听：同一元素切换 src；再点同一条即暂停 */
async function preview(take: Take): Promise<void> {
  const player = playerRef.value
  if (!player) return
  if (playingId.value === take.id) {
    player.pause()
    playingId.value = null
    return
  }
  player.src = urlOf(take)
  try {
    await player.play()
    playingId.value = take.id
    emit('play', take.id)
  } catch {
    // 播放失败（文件缺失/格式不支持）由录音页统一走 error-bus（TAKE_SRC_MISSING）
    playingId.value = null
    emit('play', take.id)
  }
}

function toggleCompare(take: Take): void {
  const picks = comparePicks.value
  if (picks.includes(take.id)) {
    comparePicks.value = picks.filter(id => id !== take.id)
    return
  }
  // 最多两个：超过时挤掉最早的
  comparePicks.value = [...picks, take.id].slice(-2)
}

function runCompare(): void {
  const [a, b] = comparePicks.value
  if (a && b) emit('compare', a, b)
}

function toggleExpand(take: Take): void {
  if (expandedId.value === take.id) {
    expandedId.value = null
    return
  }
  expandedId.value = take.id
  punchIn.value = props.punchInMs || Math.max(0, take.trimmedInMs || 0)
  punchOut.value = props.punchOutMs || Math.max(1, take.srcOutMs || take.durationMs)
}

function confirmPunch(take: Take): void {
  const inMs = Math.min(punchIn.value, punchOut.value - 1)
  const outMs = Math.max(punchOut.value, inMs + 1)
  emit('punch-range', { takeId: take.id, srcInMs: Math.max(0, inMs), srcOutMs: outMs })
}

function combineAll(): void {
  emit('combine', props.takes.map(t => t.id))
}

function isFlagged(take: Take, flag: string): boolean {
  return take.flags.includes(flag)
}

/** 快捷打标只用「值得一键点」的几个（全套在 TakeFlagsPanel 里） */
const quickFlags = TAKE_FLAG_PRESETS.slice(0, 4)

onMounted(() => {
  if (playerRef.value) emit('player-ready', playerRef.value)
})

defineExpose({
  player: playerRef,
  stop: () => {
    playerRef.value?.pause()
    playingId.value = null
  },
})
</script>

<template>
  <section class="ns-takes" :class="{ 'is-compact': compact }">
    <header class="ns-takes__head">
      <span class="ns-takes__title">试录版本（take）</span>
      <span class="ns-takes__count">{{ takes.length }} 个</span>
      <button type="button" class="ns-takes__link" :disabled="comparePicks.length !== 2" @click="runCompare">
        A/B 对比{{ comparePicks.length ? `（已选 ${comparePicks.length}）` : '' }}
      </button>
      <button v-if="canCombineParts" type="button" class="ns-takes__link" @click="combineAll">
        合并分段
      </button>
    </header>

    <p v-if="activeFlags.length" class="ns-takes__filter">
      仅显示标记：{{ activeFlags.join('、') }}（共 {{ visibleTakes.length }} 个）
    </p>

    <p v-if="loading" class="ns-takes__hint">正在加载该行的 take…</p>
    <p v-else-if="!takes.length" class="ns-takes__hint">这一行还没有录过。按录制键开始第一次录制。</p>
    <p v-else-if="!visibleTakes.length" class="ns-takes__hint">当前筛选条件下没有 take。</p>

    <ol v-else class="ns-takes__list">
      <li
        v-for="(take, index) in visibleTakes"
        :key="take.id"
        class="ns-take"
        :class="{ 'is-selected': take.isSelected, 'is-playing': playingId === take.id }"
      >
        <div class="ns-take__row">
          <span class="ns-take__index">#{{ index + 1 }}</span>
          <button
            type="button"
            class="ns-take__play"
            :title="playingId === take.id ? '暂停试听' : '试听'"
            @click="preview(take)"
          >
            {{ playingId === take.id ? '⏸' : '▶' }}
          </button>

          <span class="ns-take__duration">{{ formatDuration(take.durationMs, { showMs: true }) }}</span>
          <span class="ns-take__metric" :title="'该 take 的写入增益'">增益 {{ formatDb(take.gainDb) }}</span>
          <span class="ns-take__metric">峰值 {{ formatDb(take.peakDb) }}</span>
          <span class="ns-take__metric">RMS {{ formatDb(take.rmsDb) }}</span>
          <span v-if="take.partIndex > 0" class="ns-take__badge">分段 {{ take.partIndex + 1 }}</span>
          <span v-if="showSource" class="ns-take__badge ns-take__badge--source">{{ SOURCE_LABELS[take.source] }}</span>
          <span v-if="take.isSelected" class="ns-take__badge ns-take__badge--ok">成品</span>
          <span
            v-for="flag in take.flags"
            :key="flag"
            class="ns-take__badge ns-take__badge--flag"
            :title="TAKE_FLAG_PRESETS.find(p => p.key === flag)?.hint ?? flag"
          >
            {{ TAKE_FLAG_PRESETS.find(p => p.key === flag)?.label ?? flag }}
          </span>

          <span class="ns-take__time" :title="formatDate(take.recordedAt, 'YYYY-MM-DD HH:mm:ss')">
            {{ formatRelativeTime(take.recordedAt) }}
          </span>
        </div>

        <div class="ns-take__actions">
          <button type="button" class="ns-take__btn" :disabled="take.isSelected" @click="emit('select', take.id)">
            设为成品
          </button>
          <button type="button" class="ns-take__btn" @click="toggleCompare(take)">
            {{ comparePicks.includes(take.id) ? '移出对比' : '加入对比' }}
          </button>
          <button type="button" class="ns-take__btn" @click="toggleExpand(take)">
            {{ expandedId === take.id ? '收起' : '补录/区间' }}
          </button>
          <span class="ns-take__quick">
            <button
              v-for="preset in quickFlags"
              :key="preset.key"
              type="button"
              class="ns-take__flag"
              :class="{ 'is-on': isFlagged(take, preset.key) }"
              :title="preset.hint"
              @click="emit('flag', take.id, preset.key)"
            >
              {{ preset.label }}
            </button>
          </span>
          <span class="ns-take__spacer" />
          <button
            type="button"
            class="ns-take__btn ns-take__btn--danger"
            :title="'软删：文件保留，可在清理时彻底删除'"
            @click="emit('remove', take.id, false)"
          >
            移除
          </button>
          <button
            type="button"
            class="ns-take__btn ns-take__btn--danger"
            title="硬删：删除文件，不可恢复（会二次确认）"
            @click="emit('remove', take.id, true)"
          >
            彻底删除
          </button>
        </div>

        <div v-if="expandedId === take.id" class="ns-take__detail">
          <p class="ns-take__detail-line">
            会话区间：{{ formatDuration(take.srcInMs, { showMs: true }) }} →
            {{ formatDuration(take.srcOutMs, { showMs: true }) }} ·
            修剪后：{{ formatDuration(take.trimmedInMs, { showMs: true }) }} →
            {{ formatDuration(take.trimmedOutMs, { showMs: true }) }}
          </p>
          <p class="ns-take__detail-line">
            格式：{{ formatDuration(take.durationMs) }} · {{ take.format.sampleRate }} Hz /
            {{ take.format.bitDepth === 32 ? '32f' : take.format.bitDepth }} bit /
            {{ take.format.channels === 1 ? '单声道' : '立体声' }} ·
            备注：{{ take.note ? take.note : UNKNOWN }}
          </p>

          <!-- 补录区间（docs/12 §8.2）：pre-roll/post-roll 的取值在录音页里显示 -->
          <div class="ns-take__punch">
            <span>补录区间（毫秒，相对该 take）</span>
            <label>
              起点
              <input v-model.number="punchIn" type="number" min="0" :max="take.durationMs" step="10">
            </label>
            <label>
              终点
              <input v-model.number="punchOut" type="number" min="0" :max="take.durationMs" step="10">
            </label>
            <button type="button" class="ns-take__btn" @click="confirmPunch(take)">设为补录区间</button>
          </div>
        </div>
      </li>
    </ol>

    <!-- 唯一试听元素：也用于监听「已有轨道」（docs/12 §7） -->
    <audio ref="playerRef" class="ns-takes__player" preload="none" @ended="playingId = null" />
  </section>
</template>

<style scoped>
.ns-takes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-takes__head {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.ns-takes__title {
  font-weight: 600;
}
.ns-takes__count {
  color: var(--ns-text-secondary, #909399);
}
.ns-takes__link {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  font-size: 12px;
  cursor: pointer;
}
.ns-takes__link:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.ns-takes__filter {
  margin: 0;
  color: var(--ns-primary, #409eff);
  font-size: 12px;
}
.ns-takes__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-takes__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ns-take {
  padding: 6px 8px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 6px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-take.is-selected {
  border-color: var(--ns-success, #67c23a);
  background: rgb(103 194 58 / 8%);
}
.ns-take.is-playing {
  outline: 1px solid var(--ns-primary, #409eff);
}
.ns-take__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: var(--ns-text-regular, #606266);
}
.ns-take__index {
  color: var(--ns-text-secondary, #909399);
}
.ns-take__play {
  width: 22px;
  height: 22px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 50%;
  background: var(--ns-bg-elevated);
  cursor: pointer;
  line-height: 1;
}
.ns-take__duration {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ns-text-primary, #303133);
}
.ns-take__metric {
  color: var(--ns-text-secondary, #909399);
}
.ns-take__badge {
  padding: 0 6px;
  border-radius: 3px;
  background: var(--ns-fill, #ebeef5);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-take__badge--ok {
  background: rgb(103 194 58 / 20%);
  color: var(--ns-success, #67c23a);
}
.ns-take__badge--flag {
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
}
.ns-take__time {
  margin-left: auto;
  color: var(--ns-text-secondary, #909399);
}
.ns-take__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.ns-take__spacer {
  flex: 1;
}
.ns-take__btn {
  padding: 2px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-primary, #303133);
  font-size: 11px;
  cursor: pointer;
}
.ns-take__btn:disabled {
  cursor: default;
  opacity: 0.5;
}
.ns-take__btn:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-take__btn--danger:hover {
  border-color: var(--ns-danger, #f56c6c);
  color: var(--ns-danger, #f56c6c);
}
.ns-take__quick {
  display: inline-flex;
  gap: 4px;
}
.ns-take__flag {
  padding: 1px 6px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  cursor: pointer;
}
.ns-take__flag.is-on {
  border-style: solid;
  border-color: var(--ns-warning, #e6a23c);
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
}
.ns-take__detail {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
  font-size: 11px;
  color: var(--ns-text-secondary, #909399);
}
.ns-take__detail-line {
  margin: 0 0 4px;
}
.ns-take__punch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ns-take__punch input {
  width: 80px;
  padding: 2px 4px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  font-size: 11px;
}
.ns-takes__player {
  display: none;
}
</style>
