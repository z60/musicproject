<!--
  Novel Studio · 对轨「文本参照」面板（docs/13 §4.5 Judge 区 / §6 试听）
  ============================================================================
  真机需求：「对轨模块 需要添加可以听 并且可以参照文本的功能」。

  对轨是**拿耳朵对着文字**的活：画布上只画波形 + 行首 10 个字，看不了整句。
  这个面板按**画本顺序**把整章列出来（缺录的行也在，标出来），每行给：
    · 原文（完整、可换行；悬停看全文）
    · 时间线起点（与画布同一口径）
    · ▶ 单行试听（点一下听这一句；再点一下停）
    · 状态标：待确认 / 缺录 / 无音频 —— 这三种就是需要人工处理的
  点一行会把画布选中并滚动到它；正在播的那一行会高亮并自动跟随。

  职责边界：本组件**不碰 AudioContext**（试听由视图调 `usePlaybackScheduler`，
  通过 `audition` 事件转发），也不改排布数据 —— 只做「看 + 点」。
-->

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { ArrangementItem, Id } from '@shared/types.ts'
import { formatDuration } from '@/shared/lib/format.ts'
import { useScriptReference, type ScriptRow } from '../composables/useScriptReference.ts'
import { useArrangementStore } from '../stores/arrangement.store.ts'
import { usePlaybackStore } from '../stores/playback.store.ts'
import { useTimelineStore } from '../stores/timeline.store.ts'

const emit = defineEmits<{
  /** 试听某一行（视图调用 usePlaybackScheduler.auditionItem / 再次点击则暂停） */
  audition: [itemId: Id]
  /** 该行缺录/无音频：视图负责跳去画本编辑 */
  'jump-line': [lineId: Id]
}>()

const arrangement = useArrangementStore()
const timeline = useTimelineStore()
const playback = usePlaybackStore()

const query = ref('')
/** 跟随播放头：正在播的那一行自动滚进视野（默认开，用户滚动列表后可关） */
const follow = ref(true)

/** lineId → item（一行只可能有一个片段；重复时取第一个，与画布同一约定） */
const itemByLineId = computed<Map<Id, ArrangementItem>>(() => {
  const map = new Map<Id, ArrangementItem>()
  for (const item of arrangement.items) if (!map.has(item.lineId)) map.set(item.lineId, item)
  return map
})

const script = useScriptReference({
  lines: computed(() => arrangement.lines),
  itemByLineId,
  hasAudio: (item) => arrangement.resolveSource(item, playback.useProcessed) !== null,
  playheadMs: computed(() => timeline.playheadMs),
  query,
})

const rows = script.visibleRows
const activeLineId = script.activeLineId

/** 行元素（自动滚动用）。不用 $refs 数组：列表会被筛选，下标不稳定 */
const rowElements = reactive(new Map<Id, HTMLElement>())
function registerRow(lineId: Id, element: unknown): void {
  if (element instanceof HTMLElement) rowElements.set(lineId, element)
  else rowElements.delete(lineId)
}

function isSelected(row: ScriptRow): boolean {
  return row.itemId !== null && timeline.primarySelectedId === row.itemId
}

function isPlaying(row: ScriptRow): boolean {
  return row.itemId !== null && playback.auditionItemId === row.itemId
}

function onRowClick(row: ScriptRow): void {
  if (row.itemId !== null && row.startMs !== null) {
    timeline.select(row.itemId)
    /**
     * ★ 点一行**同时把播放头挪到这一行**。
     *
     * 只 `select` 不动播放头的话，用户点完这一行按空格，播的还是上一次的播放头位置 ——
     * 真机需求原话就是「按空格可以从指定位置开始播放」。
     */
    timeline.setPlayhead(row.startMs)
    playback.setCurrentMs(row.startMs)
    timeline.ensureTimeVisible(row.startMs)
    return
  }
  timeline.setHint(
    row.state === 'missing'
      ? '这一行还没排进时间线：回画本确认是否缺录，或点「自动对轨」重排'
      : '这一行解析不到音频文件：到录音页确认这一行的 Take',
  )
}

function onRowDoubleClick(row: ScriptRow): void {
  if (row.itemId === null) emit('jump-line', row.lineId)
}

function onPlay(row: ScriptRow): void {
  if (row.itemId === null || row.state !== 'arranged') return
  emit('audition', row.itemId)
}

/**
 * 跟随播放头：只在**正在播**的时候自动滚动。
 *
 * 不跟 `timeline.playheadMs` 的每一次变化（拖动刻度尺时不该抢滚动条），
 * 只看「播放头落在了哪一行」，并且只在那一行变化时滚一次。
 */
watch(
  () => (playback.isPlaying && follow.value ? activeLineId.value : null),
  (lineId) => {
    if (!lineId) return
    void nextTick(() => {
      rowElements.get(lineId)?.scrollIntoView({ block: 'nearest' })
    })
  },
)

/** 点行号直接筛这一行（#12 → 只看第 12 行） */
function filterBySeq(seq: number): void {
  query.value = '#' + seq
}
</script>

<template>
  <div class="ns-script">
    <div class="ns-script__head">
      <div class="ns-script__title">
        文本参照
        <span class="ns-script__count">{{ script.playableCount.value }} 句可听</span>
        <span v-if="script.problemCount.value" class="ns-script__count is-warn">
          {{ script.problemCount.value }} 句要人工处理
        </span>
      </div>
      <el-input
        v-model="query"
        size="small"
        class="ns-script__query"
        placeholder="筛选台词或 #行号"
        clearable
      />
      <el-checkbox v-model="follow" size="small" class="ns-script__follow">跟随播放头</el-checkbox>
    </div>

    <div class="ns-script__list">
      <div
        v-for="row in rows"
        :key="row.lineId"
        class="ns-script__row"
        :class="{
          'is-selected': isSelected(row),
          'is-current': row.lineId === activeLineId,
          'is-playing': isPlaying(row),
          'is-problem': row.state !== 'arranged',
        }"
        :ref="(element) => registerRow(row.lineId, element)"
        @click="onRowClick(row)"
        @dblclick="onRowDoubleClick(row)"
      >
        <button
          type="button"
          class="ns-script__seq"
          title="只看这一行"
          @click.stop="filterBySeq(row.seq)"
        >
          #{{ row.seq }}
        </button>
        <span class="ns-script__text" :title="row.text">{{ row.text || '（空行）' }}</span>
        <span class="ns-script__time">
          {{ row.startMs === null ? '未排布' : formatDuration(row.startMs, { showMs: true }) }}
        </span>
        <span v-if="row.needsReview" class="ns-script__chip">待确认</span>
        <span v-if="row.state === 'missing'" class="ns-script__chip is-warn">缺录</span>
        <span v-else-if="row.state === 'no-audio'" class="ns-script__chip is-warn">无音频</span>
        <button
          type="button"
          class="ns-script__play"
          :disabled="row.state !== 'arranged'"
          :title="row.state === 'arranged' ? '试听这一行' : '这一行没有可播放的音频'"
          @click.stop="onPlay(row)"
        >
          {{ isPlaying(row) ? '❚❚' : '▶' }}
        </button>
      </div>

      <p v-if="!rows.length" class="ns-script__empty">
        {{ query ? '没有匹配的台词' : '这一章还没有画本行' }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.ns-script {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.ns-script__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--ns-border, #e6e9f0);
}
.ns-script__title {
  flex: 1 1 auto;
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  font-weight: 600;
}
.ns-script__count {
  margin-left: 6px;
  color: var(--ns-text-secondary, #909399);
  font-weight: 400;
}
.ns-script__count.is-warn { color: var(--ns-warning, #e6a23c); }
.ns-script__query { width: 150px; }
.ns-script__follow { font-size: 12px; }
.ns-script__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden auto;
  padding: 4px 6px 12px;
}
.ns-script__row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto auto 24px;
  align-items: start;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.ns-script__row:hover { background: var(--ns-bg-subtle, #f5f7fa); }
.ns-script__row.is-selected {
  border-color: var(--ns-primary, #409eff);
  background: color-mix(in srgb, var(--ns-primary, #409eff) 8%, transparent);
}
.ns-script__row.is-current { box-shadow: inset 2px 0 0 var(--ns-primary, #409eff); }
.ns-script__row.is-playing { background: color-mix(in srgb, var(--ns-success, #67c23a) 12%, transparent); }
.ns-script__row.is-problem { opacity: 0.72; }
.ns-script__seq {
  padding: 1px 2px;
  border: none;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.ns-script__seq:hover { color: var(--ns-primary, #409eff); text-decoration: underline; }
.ns-script__text {
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.ns-script__time {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ns-script__chip {
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ns-text-secondary, #909399) 15%, transparent);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  white-space: nowrap;
}
.ns-script__chip.is-warn {
  background: color-mix(in srgb, var(--ns-warning, #e6a23c) 18%, transparent);
  color: var(--ns-warning, #e6a23c);
}
.ns-script__play {
  width: 24px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--ns-border, #e6e9f0);
  border-radius: 4px;
  background: var(--ns-bg, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 11px;
  cursor: pointer;
}
.ns-script__play:hover:not(:disabled) { border-color: var(--ns-primary, #409eff); color: var(--ns-primary, #409eff); }
.ns-script__play:disabled { cursor: not-allowed; opacity: 0.45; }
.ns-script__empty {
  margin: 12px 4px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  text-align: center;
}
</style>
