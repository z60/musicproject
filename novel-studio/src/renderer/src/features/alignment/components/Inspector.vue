<!--
  Novel Studio · 片段检查器（docs/13 §4.5 右下「Judge」区 / §4.7 手动微调）
  ============================================================================
  设计依据：
    · docs/13 §4.5 —— 底部状态条显示「选中：萧炎 @ 3:12.4 - 3:18.9 | 源 0:00.0-0:06.5
      | locked | offset +120」；本组件是它的**详细版**：所有属性可改、所有相关操作在手边；
    · docs/13 §4.7 —— 手动微调表：拖动整体改 `timelineStartMs`、拖左边缘改
      `timelineStartMs + srcInMs`（反向补偿）、拖右边缘改 `srcOutMs`、锁定、重置；
      ★ **陷阱**：在检查器里改 `srcInMs` 是「裁剪入点」语义（起点不动、时长变化），
      与「拖左边缘」（内容绝对位置不变）**不是一回事**。界面上把两者分开说明，
      避免用户用错工具还以为「对轨坏了」。
    · docs/13 §5 —— 检查器要能直接看到该片段相关的校验线索（重叠对象 / 相邻间隙）；
    · docs/05 §11.4 —— 键盘微调 ±10 ms（`Shift` ±1、`Ctrl` ±100）在画布上已实现，
      这里给等价的加减按钮（不用键盘的用户也要能微调）。

  写入策略（为什么不是「每敲一个字发一次 IPC」）：
    输入过程中只调 `patchLocalInPlace`（内存 + 脏标记，画布立刻反馈，**不发 IPC**），
    停手 400 ms 后由 `commitChanges` 合并成**一条撤销命令 + 一次批量落库**。
    这与拖动松手提交同一条路径（docs/13 §4.8「一次撤销整组」、§11「限制批量操作提交频率」）。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import type { ArrangementItem, ArrangementItemPatch, Id } from '@shared/types.ts'
import { ARRANGE_DEFAULTS } from '@shared/constants.ts'
import { formatDuration, formatOffsetMs, UNKNOWN } from '@/shared/lib/format.ts'
import { debounce } from '@/shared/lib/editable-debounce.ts'
import { itemDurationMs } from '@shared/arrange/layout.ts'
import { useArrangementStore } from '../stores/arrangement.store.ts'

const props = withDefaults(defineProps<{
  /** 主选中 item（来自 timeline.primarySelectedId）；null = 未选中 */
  itemId?: Id | null
  /** 数值改动的提交防抖窗口（毫秒） */
  commitDelayMs?: number
}>(), {
  itemId: null,
  commitDelayMs: 400,
})

const emit = defineEmits<{
  /** 试听该片段（视图调用 usePlaybackScheduler.auditionItem） */
  audition: [itemId: Id]
  /** 跳到画本行（视图负责路由跳转，组件不知道路由） */
  'jump-line': [lineId: Id]
  /** 请求关闭检查器面板 */
  close: []
}>()

const arrangement = useArrangementStore()

// ---------------------------------------------------------------------------
// 选中项与派生展示
// ---------------------------------------------------------------------------

/** 依赖 `dragRevision`：拖动/本地补丁后属性要立刻跟着变（store 的既有约定） */
const item = computed<ArrangementItem | null>(() => {
  void arrangement.dragRevision
  return arrangement.itemById(props.itemId ?? null)
})

const line = computed(() => arrangement.lineOf(item.value))
const track = computed(() => {
  const trackId = item.value?.trackId
  if (!trackId) return null
  return arrangement.tracks.find(t => t.trackId === trackId) ?? null
})

const label = computed(() => (item.value ? arrangement.lineLabel(item.value, 10) : ''))
const seq = computed(() => (item.value ? arrangement.lineSeq(item.value) : null))

const startMs = computed(() => item.value?.timelineStartMs ?? 0)
const durationMs = computed(() => (item.value ? arrangement.durationOf(item.value) : 0))
const endMs = computed(() => startMs.value + durationMs.value)

const source = computed(() => (item.value ? arrangement.resolveSource(item.value, true) : null))
const sourceDurationMs = computed(() => source.value?.durationMs ?? null)

/** 重叠对象：item.overlapWith 是主进程给的配对 id（可能是双向的，取对端即可） */
const overlapItem = computed(() => {
  const id = item.value?.overlapWith ?? null
  if (!id) return null
  return arrangement.itemById(id)
})

const overlapLabel = computed(() => {
  const other = overlapItem.value
  if (!other) return null
  const otherSeq = arrangement.lineSeq(other)
  const otherText = arrangement.lineLabel(other, 10)
  return otherSeq === null ? otherText || other.id : `${otherSeq} ${otherText}`
})

/** 相邻间隙：同轨前后两段与本段的空隙（负值 = 重叠，交给 OverlapResolver 处理） */
const gaps = computed(() => {
  const current = item.value
  if (!current) return { prevMs: null as number | null, nextMs: null as number | null }
  const list = arrangement.trackItems(current.trackId)
  const index = list.findIndex(i => i.id === current.id)
  if (index < 0) return { prevMs: null, nextMs: null }
  const prev = list[index - 1] ?? null
  const next = list[index + 1] ?? null
  const prevGap = prev ? current.timelineStartMs - (prev.timelineStartMs + itemDurationMs(prev)) : null
  const nextGap = next ? next.timelineStartMs - (current.timelineStartMs + itemDurationMs(current)) : null
  return { prevMs: prevGap, nextMs: nextGap }
})

// ---------------------------------------------------------------------------
// 数值字段：本地镜像 + 防抖提交
// ---------------------------------------------------------------------------

type NumericField = 'timelineStartMs' | 'srcInMs' | 'srcOutMs' | 'fadeInMs' | 'fadeOutMs'

const local = reactive<Record<NumericField, number>>({
  timelineStartMs: 0,
  srcInMs: 0,
  srcOutMs: 0,
  fadeInMs: ARRANGE_DEFAULTS.defaultFadeMs,
  fadeOutMs: ARRANGE_DEFAULTS.defaultFadeMs,
})

function syncLocal(current: ArrangementItem | null): void {
  if (!current) {
    local.timelineStartMs = 0
    local.srcInMs = 0
    local.srcOutMs = 0
    local.fadeInMs = 0
    local.fadeOutMs = 0
    return
  }
  local.timelineStartMs = current.timelineStartMs
  local.srcInMs = current.srcInMs
  local.srcOutMs = current.srcOutMs
  local.fadeInMs = current.fadeInMs
  local.fadeOutMs = current.fadeOutMs
  lastCommitted.value = { ...current }
}

/** 一次防抖窗口的起始快照（撤销命令的 before） */
const lastCommitted = { value: null as ArrangementItem | null } as { value: ArrangementItem | null }

const dirtyFields = computed(() => {
  const current = item.value
  if (!current) return false
  return local.timelineStartMs !== current.timelineStartMs
    || local.srcInMs !== current.srcInMs
    || local.srcOutMs !== current.srcOutMs
    || local.fadeInMs !== current.fadeInMs
    || local.fadeOutMs !== current.fadeOutMs
})

watch(
  () => [props.itemId, item.value?.timelineStartMs, item.value?.srcInMs, item.value?.srcOutMs,
    item.value?.fadeInMs, item.value?.fadeOutMs],
  () => {
    // 外部变化（拖动、撤销、切方案）覆盖本地镜像；没有未提交改动时不会打断输入
    if (!dirtyFields.value) syncLocal(item.value)
  },
  { immediate: true },
)

function clampPatch(field: NumericField, value: number): number {
  const current = item.value
  if (!current) return Math.max(0, Math.round(value))
  const rounded = Math.round(value)
  switch (field) {
    case 'timelineStartMs':
      return Math.max(0, rounded)
    case 'srcInMs': {
      // 裁剪入点不能越过出点（至少留 10 ms，避免产出负时长片段）
      const upper = Math.max(0, current.srcOutMs - 10)
      return Math.min(upper, Math.max(0, rounded))
    }
    case 'srcOutMs': {
      const lower = current.srcInMs + 10
      const upper = sourceDurationMs.value ?? Number.POSITIVE_INFINITY
      return Math.min(upper, Math.max(lower, rounded))
    }
    case 'fadeInMs':
    case 'fadeOutMs': {
      // 淡入/淡出不能超过片段自身时长（超过时渲染会按比例压缩，见下方提示）
      const upper = Math.max(0, arrangement.durationOf(current))
      return Math.min(upper, Math.max(0, rounded))
    }
    default:
      return rounded
  }
}

const commitLabel = '修改片段属性'

/** 防抖提交：一条撤销命令 + 一次批量落库（docs/13 §4.8 / §11） */
const flush = debounce(() => {
  const before = lastCommitted.value
  const current = item.value
  if (!before || !current) return
  if (before.timelineStartMs === current.timelineStartMs
    && before.srcInMs === current.srcInMs
    && before.srcOutMs === current.srcOutMs
    && before.fadeInMs === current.fadeInMs
    && before.fadeOutMs === current.fadeOutMs) {
    return
  }
  arrangement.commitChanges(commitLabel, [before])
  lastCommitted.value = { ...current }
}, Math.max(50, props.commitDelayMs))

/** 输入即预览：内存改动 + 脏标记（不发 IPC） */
function onFieldInput(field: NumericField, value: number | undefined): void {
  const current = item.value
  if (!current || value === undefined || value === null || !Number.isFinite(value)) return
  const next = clampPatch(field, value)
  local[field] = next
  if (!lastCommitted.value) lastCommitted.value = { ...current }
  const patch: ArrangementItemPatch = { [field]: next }
  arrangement.patchLocalInPlace(current.id, patch)
  flush()
}

/** 数值输入（el-input-number）：载荷为 number，输入框被清空时为 undefined */
function onNumberFieldInput(field: NumericField): (value: number | undefined) => void {
  return (value: number | undefined): void => {
    onFieldInput(field, value)
  }
}

/** 微调按钮：±10 ms（与键盘方向键同一档，docs/13 §4.7） */
function nudge(field: 'timelineStartMs', deltaMs: number): void {
  onFieldInput(field, local.timelineStartMs + deltaMs)
}

/** 失焦/回车立刻提交，不等防抖（用户已经「确认」了这个值） */
function flushNow(): void {
  flush.flush()
}

onBeforeUnmount(() => {
  flush.flush()
  flush.cancel()
})

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function onLockChange(value: boolean): void {
  const current = item.value
  if (!current) return
  void arrangement.setLocked(current.id, value)
}

/** 锁定开关（el-switch）：载荷为 boolean | string | number */
function onLockSwitchInput(value: boolean | string | number): void {
  onLockChange(Boolean(value))
}

function onResetAuto(): void {
  const current = item.value
  if (!current) return
  arrangement.resetItemToAuto(current.id)
  syncLocal(arrangement.itemById(current.id))
}

function onTrimSilence(): void {
  const current = item.value
  if (!current) return
  void arrangement.trimItemSilence(current.id).then((ok) => {
    if (ok) syncLocal(arrangement.itemById(current.id))
  })
}

function onAudition(): void {
  const current = item.value
  if (!current) return
  if (!source.value) return
  emit('audition', current.id)
}

function onJumpLine(): void {
  const lineId = item.value?.lineId
  if (!lineId) return
  emit('jump-line', lineId)
}

// ---------------------------------------------------------------------------
// 展示文本
// ---------------------------------------------------------------------------

const timelineRangeText = computed(() => `${formatDuration(startMs.value, { showMs: true })} – ${formatDuration(endMs.value, { showMs: true })}`)
const sourceRangeText = computed(() => {
  const current = item.value
  if (!current) return UNKNOWN
  return `${formatDuration(current.srcInMs, { showMs: true })} – ${formatDuration(current.srcOutMs, { showMs: true })}`
})
const gapText = computed(() => {
  const { prevMs, nextMs } = gaps.value
  const format = (ms: number | null): string => (ms === null ? '—' : formatOffsetMs(ms))
  return `前 ${format(prevMs)} / 后 ${format(nextMs)}`
})
const sourceHint = computed(() => {
  if (source.value) {
    return source.value.isProcessed ? '使用处理后文件（可切换为原始文件在试听设置里）' : '使用原始录音文件'
  }
  return '该片段没有可用的音频文件：时间线上不画波形、不可试听（校验会报 file_missing）'
})
const fadeWarning = computed(() => {
  const current = item.value
  if (!current) return ''
  const sum = local.fadeInMs + local.fadeOutMs
  const total = arrangement.durationOf(current)
  if (total > 0 && sum > total) return '淡入 + 淡出超过了片段时长：渲染时会按比例压缩'
  return ''
})
</script>

<template>
  <div class="ns-inspector">
    <!-- 未选中：给引导而不是空白 -->
    <div v-if="!item" class="ns-inspector__empty">
      <p class="ns-inspector__empty-title">未选中片段</p>
      <p class="ns-inspector__empty-desc">
        在时间线上单击任意色块即可查看它的全部属性（起止 / 裁剪点 / 淡入淡出 / 锁定），
        并在下方做 ±10 ms 微调。
      </p>
    </div>

    <template v-else>
      <!-- 标题：行号 + 文本前 10 字（docs/13 §4.6） -->
      <header class="ns-inspector__head">
        <span class="ns-inspector__dot" :style="{ background: track?.color ?? '#909399' }" />
        <div class="ns-inspector__title">
          <span class="ns-inspector__seq">#{{ seq ?? UNKNOWN }}</span>
          <span class="ns-inspector__text">{{ label || '（画本行已删除）' }}</span>
        </div>
        <button type="button" class="ns-inspector__close" title="关闭检查器" @click="emit('close')">×</button>
      </header>

      <p v-if="line" class="ns-inspector__fulltext" :title="line.text">{{ line.text }}</p>

      <!-- 只读信息：轨道 / 时长 / 相邻间隙 / 重叠对象 -->
      <dl class="ns-inspector__facts">
        <div class="ns-inspector__fact">
          <dt>轨道</dt>
          <dd>{{ track?.name ?? item.trackId }}</dd>
        </div>
        <div class="ns-inspector__fact">
          <dt>时长</dt>
          <dd>{{ formatDuration(durationMs, { showMs: true }) }}</dd>
        </div>
        <div class="ns-inspector__fact">
          <dt>时间线</dt>
          <dd>{{ timelineRangeText }}</dd>
        </div>
        <div class="ns-inspector__fact">
          <dt>源内</dt>
          <dd>{{ sourceRangeText }}<span v-if="sourceDurationMs !== null" class="ns-inspector__muted"> / 源长 {{ formatDuration(sourceDurationMs) }}</span></dd>
        </div>
        <div class="ns-inspector__fact">
          <dt>相邻间隙</dt>
          <dd>{{ gapText }}</dd>
        </div>
        <div class="ns-inspector__fact">
          <dt>重叠对象</dt>
          <dd>
            <span v-if="overlapLabel" class="ns-inspector__danger">{{ overlapLabel }}</span>
            <span v-else class="ns-inspector__muted">无（已消解）</span>
          </dd>
        </div>
        <div class="ns-inspector__fact">
          <dt>锁定</dt>
          <dd>{{ item.locked ? '已锁定（自动排布不会移动它）' : '未锁定' }}</dd>
        </div>
        <div v-if="item.locked" class="ns-inspector__fact">
          <dt>状态</dt>
          <dd class="ns-inspector__muted">锁定中：拖动与自动排布都不动它</dd>
        </div>
      </dl>

      <!-- 可编辑数值：时间线起点（拖动整体） -->
      <section class="ns-inspector__section">
        <h4 class="ns-inspector__section-title">时间线位置（拖动整体改这里）</h4>
        <div class="ns-inspector__row">
          <el-input-number
            :model-value="local.timelineStartMs"
            :min="0"
            :step="10"
            size="small"
            controls-position="right"
            @update:model-value="onNumberFieldInput('timelineStartMs')"
            @change="flushNow"
          />
          <span class="ns-inspector__unit">ms</span>
          <button type="button" class="ns-inspector__mini" title="−10 ms（键盘 ← ）" @click="nudge('timelineStartMs', -10)">−10</button>
          <button type="button" class="ns-inspector__mini" title="+10 ms（键盘 → ）" @click="nudge('timelineStartMs', 10)">+10</button>
        </div>
        <p class="ns-inspector__note">
          微调步进：`←/→` ±10 ms、`Shift` ±1 ms、`Ctrl` ±100 ms（docs/13 §4.7）。
        </p>
      </section>

      <!-- 可编辑数值：裁剪点（与拖边缘语义不同，必须写清） -->
      <section class="ns-inspector__section">
        <h4 class="ns-inspector__section-title">裁剪点（源内）</h4>
        <div class="ns-inspector__row">
          <label class="ns-inspector__label">入点</label>
          <el-input-number
            :model-value="local.srcInMs"
            :min="0"
            :step="10"
            size="small"
            controls-position="right"
            @update:model-value="onNumberFieldInput('srcInMs')"
            @change="flushNow"
          />
          <label class="ns-inspector__label">出点</label>
          <el-input-number
            :model-value="local.srcOutMs"
            :min="0"
            :step="10"
            size="small"
            controls-position="right"
            @update:model-value="onNumberFieldInput('srcOutMs')"
            @change="flushNow"
          />
        </div>
        <p class="ns-inspector__note">
          这里的入点/出点是**裁剪**：起点不动、时长随之变化。
          若要「保持内容绝对位置不变地移动起点」，请拖时间线上片段的**左边缘**
          （那里会同时反向补偿 srcInMs，docs/13 §4.7 的语义陷阱）。
        </p>
      </section>

      <!-- 淡入淡出 -->
      <section class="ns-inspector__section">
        <h4 class="ns-inspector__section-title">淡入 / 淡出</h4>
        <div class="ns-inspector__row">
          <label class="ns-inspector__label">淡入</label>
          <el-input-number
            :model-value="local.fadeInMs"
            :min="0"
            :step="5"
            size="small"
            controls-position="right"
            @update:model-value="onNumberFieldInput('fadeInMs')"
            @change="flushNow"
          />
          <label class="ns-inspector__label">淡出</label>
          <el-input-number
            :model-value="local.fadeOutMs"
            :min="0"
            :step="5"
            size="small"
            controls-position="right"
            @update:model-value="onNumberFieldInput('fadeOutMs')"
            @change="flushNow"
          />
        </div>
        <p v-if="fadeWarning" class="ns-inspector__warn">{{ fadeWarning }}</p>
      </section>

      <!-- 操作区 -->
      <section class="ns-inspector__section">
        <h4 class="ns-inspector__section-title">操作</h4>
        <div class="ns-inspector__actions">
          <el-switch
            :model-value="item.locked"
            size="small"
            active-text="锁定"
            @update:model-value="onLockSwitchInput"
          />
          <el-button size="small" :disabled="!source" @click="onAudition">试听该片段</el-button>
          <el-button size="small" @click="onJumpLine">跳到画本行</el-button>
          <el-button size="small" @click="onResetAuto">重置为自动排布</el-button>
          <el-button size="small" @click="onTrimSilence">裁剪静音</el-button>
        </div>
        <p class="ns-inspector__note">{{ sourceHint }}</p>
        <p v-if="item.locked" class="ns-inspector__note">
          已锁定：拖动与自动排布都不会移动它；解锁后才能手工微调。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ns-inspector {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  overflow: auto;
  font-size: 12px;
}
.ns-inspector__empty {
  padding: 20px 8px;
  color: var(--ns-text-secondary, #909399);
  text-align: center;
}
.ns-inspector__empty-title {
  margin: 0 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  font-weight: 600;
}
.ns-inspector__empty-desc {
  margin: 0;
  line-height: 1.6;
}
.ns-inspector__head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ns-inspector__dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.ns-inspector__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.ns-inspector__seq {
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-inspector__text {
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-inspector__close {
  margin-left: auto;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.ns-inspector__close:hover {
  background: var(--ns-bg-subtle, #f5f7fa);
  color: var(--ns-text-primary, #303133);
}
.ns-inspector__fulltext {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--ns-bg-subtle, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  line-height: 1.6;
}
.ns-inspector__facts {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 3px 8px;
  margin: 0;
}
.ns-inspector__fact {
  display: contents;
}
.ns-inspector__fact dt {
  color: var(--ns-text-secondary, #909399);
}
.ns-inspector__fact dd {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-variant-numeric: tabular-nums;
}
.ns-inspector__muted {
  color: var(--ns-text-secondary, #909399);
}
.ns-inspector__danger {
  color: var(--ns-danger, #f56c6c);
}
.ns-inspector__section {
  padding-top: 8px;
  border-top: 1px solid var(--ns-border, #ebeef5);
}
.ns-inspector__section-title {
  margin: 0 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.ns-inspector__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ns-inspector__label {
  color: var(--ns-text-secondary, #909399);
}
.ns-inspector__unit {
  color: var(--ns-text-secondary, #909399);
}
.ns-inspector__mini {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg, #fff);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.ns-inspector__mini:hover {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-inspector__note {
  margin: 6px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-inspector__warn {
  margin: 6px 0 0;
  color: var(--ns-warning, #e6a23c);
  font-size: 11px;
}
.ns-inspector__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
</style>
