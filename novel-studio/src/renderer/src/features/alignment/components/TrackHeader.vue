<!--
  Novel Studio · 轨道头（docs/13 §4.1 / §4.5 / §4.6）
  ============================================================================
  设计依据：
    · docs/13 §4.1 —— 轨道构成：旁白固定第一轨，其后是角色轨，最后是 BGM / 音效；
      轨道颜色 = 片段填充色（同一颜色在画布上出现，用户才能一眼对上）；
    · docs/13 §4.5 —— 左侧一列轨道头，与画布上的轨道行**逐行对齐**（行高由视图统一给）；
    · docs/13 §4.6 —— 每轨独立 Solo / Mute（用于听单轨与检查重叠）、音量、轨道高度；
    · docs/13 §11 —— 角色被归档后仍有 item：轨道头要标注「已归档」，但**仍可播放**
      （不能因为角色归档就把音频藏起来）。

  职责边界：本组件**不直接改状态**。Solo/Mute/音量/锁定/重置都通过 emits 上抛，
  由视图决定写哪个 store（playback / arrangement / timeline）——这样它可被
  MatchReviewView 之类页面复用而不产生副作用。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { formatDb, formatDuration } from '@/shared/lib/format.ts'
import type { TrackView } from '../stores/arrangement.store.ts'

const props = withDefaults(defineProps<{
  /** 轨道视图模型（tracks computed 的元素） */
  track: TrackView
  /** 行高（像素，与画布上的 TrackRow.height 必须一致） */
  height: number
  /** 是否被选中（当前操作轨；画布上会加亮该行） */
  selected?: boolean
  solo?: boolean
  muted?: boolean
  /** 该轨音量（dB） */
  gainDb?: number
  /** 该轨全部片段是否已锁定（docs/13 §4.7） */
  locked?: boolean
  /** 该轨同轨重叠数（>0 时红灯，引导用户去 OverlapResolver） */
  conflictCount?: number
  /** 该轨可听（Solo 生效时非 Solo 轨为 false，用降透明度表达） */
  audible?: boolean
  /** 是否允许重置该轨（无 item 时禁用） */
  resettable?: boolean
}>(), {
  selected: false,
  solo: false,
  muted: false,
  gainDb: 0,
  locked: false,
  conflictCount: 0,
  audible: true,
  resettable: true,
})

const emit = defineEmits<{
  /** 点击选中该轨（视图记录当前轨，供「重置整轨」等操作使用） */
  select: [trackId: string]
  solo: [trackId: string, value: boolean]
  mute: [trackId: string, value: boolean]
  /** 音量变化（dB） */
  gain: [trackId: string, db: number]
  /** 整轨锁定 / 解锁 */
  lock: [trackId: string, value: boolean]
  /** 重置整轨为自动排布（alignment:resetTrack） */
  'reset-track': [trackId: string]
  /** 切换轨道高度预设（全局：紧凑/标准/宽松，docs/13 §4.6） */
  'cycle-height': []
}>()

/** 轨道种类 → 中文标注（BGM/音效要能一眼区分，它们不是「人声」） */
const kindLabel = computed(() => {
  switch (props.track.kind) {
    case 'narration': return '旁白'
    case 'music': return 'BGM'
    case 'sfx': return '音效'
    case 'character': return '角色'
    default: return '未识别轨'
  }
})

/** 轨尾时间：给了用户「这一轨排到哪了」的量感 */
const endLabel = computed(() => formatDuration(props.track.endMs))

const gainLabel = computed(() => formatDb(props.gainDb))

/** 名字过长时截断（轨道头只有 180px，绝不换行把行高撑破） */
const displayName = computed(() => {
  const name = props.track.name || props.track.trackId
  return name.length > 8 ? `${name.slice(0, 8)}…` : name
})

const title = computed(() => [
  props.track.name,
  kindLabel.value,
  `${props.track.itemCount} 段`,
  `尾 ${endLabel.value}`,
  props.track.isArchived ? '角色已归档' : '',
].filter(Boolean).join(' · '))

function onGainInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  emit('gain', props.track.trackId, value)
}

function toggleLock(): void {
  emit('lock', props.track.trackId, !props.locked)
}
</script>

<template>
  <div
    class="ns-track-head"
    :class="{ 'is-selected': selected, 'is-silent': !audible }"
    :style="{ height: `${height}px` }"
    :title="title"
    @click="emit('select', track.trackId)"
  >
    <!-- 第一行：色块 + 名称 + 归档标记 -->
    <div class="ns-track-head__line">
      <span class="ns-track-head__color" :style="{ background: track.color }" aria-hidden="true" />
      <span class="ns-track-head__name">{{ displayName }}</span>
      <span class="ns-track-head__kind">{{ kindLabel }}</span>
      <button
        v-if="track.isArchived"
        type="button"
        class="ns-track-head__archived"
        title="角色已归档：音频仍可播放，但不会再出现在角色列表里"
        @click.stop
      >
        归档
      </button>
      <span v-if="conflictCount > 0" class="ns-track-head__alarm" :title="`${conflictCount} 处同轨重叠`">
        ⚠ {{ conflictCount }}
      </span>
    </div>

    <!-- 第二行：Solo / Mute / 锁定 / 高度 / 音量 -->
    <div class="ns-track-head__line ns-track-head__line--ctrl">
      <button
        type="button"
        class="ns-track-head__btn"
        :class="{ 'is-on': solo }"
        title="Solo：只独奏该轨（检查重叠时最常用）"
        @click.stop="emit('solo', track.trackId, !solo)"
      >
        S
      </button>
      <button
        type="button"
        class="ns-track-head__btn"
        :class="{ 'is-warn': muted }"
        title="Mute：静音该轨"
        @click.stop="emit('mute', track.trackId, !muted)"
      >
        M
      </button>
      <button
        type="button"
        class="ns-track-head__btn"
        :class="{ 'is-on': locked }"
        :title="locked ? '整轨已锁定：自动排布不会移动它' : '锁定整轨（自动排布时保留手工位置）'"
        @click.stop="toggleLock"
      >
        🔒
      </button>
      <button
        type="button"
        class="ns-track-head__btn"
        :disabled="!resettable"
        title="重置该轨为自动排布结果（docs/13 §4.7）"
        @click.stop="emit('reset-track', track.trackId)"
      >
        ↺
      </button>
      <button
        type="button"
        class="ns-track-head__btn ns-track-head__btn--wide"
        :title="`轨道高度 ${height}px（点击切换紧凑/标准/宽松）`"
        @click.stop="emit('cycle-height')"
      >
        {{ height }}px
      </button>
      <span class="ns-track-head__count">{{ track.itemCount }}</span>
    </div>

    <!-- 第三行：音量（细滑杆；只在行高够时显示，紧凑模式自动隐藏） -->
    <div v-if="height >= 52" class="ns-track-head__line ns-track-head__line--gain">
      <input
        class="ns-track-head__range"
        type="range"
        min="-60"
        max="12"
        step="1"
        :value="gainDb"
        :title="`轨道音量 ${gainLabel}`"
        @click.stop
        @input="onGainInput"
      >
      <span class="ns-track-head__gain">{{ gainLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.ns-track-head {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 0 6px;
  overflow: hidden;
  border-bottom: 1px solid var(--ns-border, #e6e9f0);
  background: var(--ns-bg, #fff);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.ns-track-head.is-selected {
  background: color-mix(in srgb, var(--ns-primary, #409eff) 8%, var(--ns-bg, #fff));
  box-shadow: inset 2px 0 0 var(--ns-primary, #409eff);
}
/* Solo 生效时未被独奏的轨降透明度：一眼看出「现在听到的是哪几轨」 */
.ns-track-head.is-silent {
  opacity: 0.55;
}
.ns-track-head__line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.ns-track-head__color {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.ns-track-head__name {
  overflow: hidden;
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-track-head__kind {
  flex: 0 0 auto;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-track-head__archived {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: transparent;
  color: var(--ns-text-secondary, #909399);
  font-size: 10px;
  cursor: help;
}
.ns-track-head__alarm {
  flex: 0 0 auto;
  color: var(--ns-danger, #f56c6c);
  font-size: 11px;
}
.ns-track-head__btn {
  flex: 0 0 auto;
  min-width: 20px;
  height: 18px;
  padding: 0 3px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: var(--ns-bg, #fff);
  color: var(--ns-text-regular, #606266);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.ns-track-head__btn:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-track-head__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ns-track-head__btn.is-on {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-track-head__btn.is-warn {
  border-color: var(--ns-warning, #e6a23c);
  background: var(--ns-warning, #e6a23c);
  color: #fff;
}
.ns-track-head__btn--wide {
  min-width: 34px;
}
.ns-track-head__count {
  margin-left: auto;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ns-track-head__line--gain {
  gap: 6px;
}
.ns-track-head__range {
  flex: 1 1 auto;
  min-width: 0;
  height: 12px;
  accent-color: var(--ns-primary, #409eff);
}
.ns-track-head__gain {
  flex: 0 0 auto;
  width: 52px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
