<!--
  画本编辑 · 说话人单元格（docs/11 §4.2「说话人：角色名 + 置信度色带 + 候选提示，可编辑（下拉 + 快捷键）」）
  ============================================================================
  设计要点：
    · 置信度色带必须复用 @/shared/ui/ConfidenceBadge.vue（内部用 CONFIDENCE_BANDS），
      不要在表格里自己算阈值颜色 —— 否则「哪里要改」的视觉语言会不一致。
    · 5000 行下表里**不挂下拉**：紧凑形态只渲染文字 + 色带，点击才弹面板（面板懒挂载）。
    · 写库走 useSpeakerAssign → canvas.store.assignSpeaker（decidedBy 强制 human），
      本组件不直接调 IPC；成功后 emit('change') 让父组件刷新队列 / 质检。
    · 数字键 1/2/3 的快捷指派由 useCanvasKeyboard 在视图层统一处理（见 EDITOR_SHORTCUTS）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CanvasLine, Id } from '@shared/types.ts'
import ConfidenceBadge from '@/shared/ui/ConfidenceBadge.vue'
import { useSpeakerAssign } from '../composables/useSpeakerAssign.ts'
import { useCharactersStore } from '../stores/characters.store.ts'

const props = withDefaults(defineProps<{
  /** 目标行 */
  line: CanvasLine
  /** 只读（任务包模式） */
  readonly?: boolean
  /** 紧凑形态（表格单元格） */
  compact?: boolean
  /** 是否显示候选面板入口 */
  showCandidates?: boolean
  /** 判定阈值（标出「刚好过线」的行） */
  threshold?: number | null
  /** 候选按钮上是否显示数字键提示 */
  showHotkeys?: boolean
}>(), {
  readonly: false,
  compact: true,
  showCandidates: true,
  threshold: null,
  showHotkeys: true,
})

const emit = defineEmits<{
  /** 指派成功（父组件刷新队列 / 质检 / 状态栏） */
  change: [lineId: Id, characterId: Id | null]
  /** 请求打开单行编辑抽屉 */
  open: [lineId: Id]
  /** 请求定位到原文（右栏原文对照） */
  locate: [lineId: Id]
}>()

const characters = useCharactersStore()
const speaker = useSpeakerAssign()

const panelOpen = ref(false)
/** 面板里的下拉（filterable 角色搜索） */
const keyword = ref('')

const label = computed(() => speaker.speakerLabel(props.line))
const unassigned = computed(() => speaker.isUnassigned(props.line))
const candidates = computed(() => speaker.candidatesOf(props.line))
const color = computed(() => characters.colorOf(props.line.characterId))
const pending = computed(() => speaker.pendingIds.value.has(props.line.id))

/** 是否「需要看一眼」：待确认 / 未分配 / 置信度低 */
const suspicious = computed(() => props.line.needsReview || unassigned.value)

const filteredCharacters = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const list = characters.activeCharacters
  if (!kw) return list
  return list.filter(c =>
    c.name.toLowerCase().includes(kw)
    || c.aliases.some(alias => alias.toLowerCase().includes(kw)))
})

async function assign(characterId: Id | null): Promise<void> {
  if (props.readonly) return
  const result = await speaker.assign(props.line, characterId)
  if (result.ok) {
    panelOpen.value = false
    keyword.value = ''
    emit('change', props.line.id, characterId)
  }
}

async function pickCandidate(characterId: Id): Promise<void> {
  await assign(characterId)
}

async function setNarration(): Promise<void> {
  if (props.readonly) return
  const result = await speaker.setNarration(props.line)
  if (result.ok) {
    panelOpen.value = false
    emit('change', props.line.id, null)
  }
}

function onPanelChange(open: boolean): void {
  if (props.readonly) {
    emit('open', props.line.id)
    return
  }
  panelOpen.value = open
}

/** 角色下拉（el-select）：选项值为角色 Id，或 '__narration__'（旁白 → null） */
function onSpeakerSelectInput(value: string): void {
  void assign(value === '__narration__' ? null : value)
}
</script>

<template>
  <div class="ns-speaker" :class="{ 'ns-speaker--compact': compact, 'is-unassigned': unassigned, 'is-pending': pending }">
    <template v-if="compact">
      <el-popover
        :model-value="panelOpen"
        trigger="click"
        placement="bottom-start"
        :width="300"
        @update:model-value="onPanelChange"
      >
        <template #reference>
          <span class="ns-speaker__cell" :title="readonly ? `${label}（只读）` : `点击指派说话人：${label}`">
            <i class="ns-speaker__dot" :style="{ background: color }" />
            <span class="ns-speaker__name">{{ label }}</span>
            <span v-if="suspicious" class="ns-speaker__flag" :title="unassigned ? '未分配说话人' : '待人工确认'">
              {{ unassigned ? '?' : '待' }}
            </span>
          </span>
        </template>

        <div class="ns-speaker__panel">
          <div class="ns-speaker__panel-head">
            <span class="ns-speaker__panel-title">指派说话人</span>
            <span class="ns-speaker__seq">#{{ line.seq }}</span>
          </div>

          <ConfidenceBadge
            :confidence="line.confidence"
            :decided-by="line.decidedBy"
            :candidates="candidates"
            :threshold="threshold"
            @pick="(characterId) => pickCandidate(characterId)"
          />

          <el-input
            v-model="keyword"
            size="small"
            placeholder="搜索角色名或别名"
            clearable
          />

          <div class="ns-speaker__list">
            <button
              v-for="character in filteredCharacters"
              :key="character.id"
              type="button"
              class="ns-speaker__option"
              :class="{ 'is-active': character.id === line.characterId }"
              @click="assign(character.id)"
            >
              <i class="ns-speaker__dot" :style="{ background: characters.colorOf(character.id) }" />
              <span class="ns-speaker__option-name">{{ character.name }}</span>
              <span v-if="character.aliases.length" class="ns-speaker__aliases">
                {{ character.aliases.slice(0, 2).join('/') }}
              </span>
            </button>
            <p v-if="!filteredCharacters.length" class="ns-speaker__empty">没有匹配的角色（可在右栏角色表里新增）</p>
          </div>

          <div class="ns-speaker__panel-actions">
            <el-button size="small" @click="setNarration">设为旁白</el-button>
            <el-button size="small" text @click="emit('locate', line.id)">看原文</el-button>
            <el-button size="small" text @click="emit('open', line.id)">完整编辑</el-button>
          </div>
        </div>
      </el-popover>
    </template>

    <template v-else>
      <div class="ns-speaker__full">
        <el-select
          :model-value="line.characterId ?? '__narration__'"
          :disabled="readonly"
          filterable
          size="small"
          placeholder="选择角色"
          class="ns-speaker__select"
          @update:model-value="onSpeakerSelectInput"
        >
          <el-option label="旁白（无角色）" value="__narration__" />
          <el-option
            v-for="character in characters.activeCharacters"
            :key="character.id"
            :label="character.aliases.length ? `${character.name}（${character.aliases.join('/')}）` : character.name"
            :value="character.id"
          />
        </el-select>

        <ConfidenceBadge
          :confidence="line.confidence"
          :decided-by="line.decidedBy"
          :threshold="threshold"
          :candidates="null"
        />
      </div>

      <div v-if="candidates.length" class="ns-speaker__candidates">
        <span class="ns-speaker__candidates-label">候选（点击即改）</span>
        <button
          v-for="(candidate, index) in candidates"
          :key="candidate.characterId"
          type="button"
          class="ns-speaker__candidate"
          :disabled="readonly"
          @click="pickCandidate(candidate.characterId)"
        >
          <em v-if="showHotkeys">{{ index + 1 }}</em>
          <i class="ns-speaker__dot" :style="{ background: characters.colorOf(candidate.characterId) }" />
          {{ candidate.name || characters.nameOf(candidate.characterId) }}
          <span class="ns-speaker__score">{{ speaker.scoreText(candidate.score) }}</span>
        </button>
        <el-button size="small" text :disabled="readonly" @click="setNarration">都不是 → 旁白</el-button>
      </div>

      <p v-if="unassigned" class="ns-speaker__warn">
        这一行是台词但说话人为空，会被质检列为 unassigned；重算归属或人工指派都可以。
      </p>
    </template>
  </div>
</template>

<style scoped>
.ns-speaker {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.ns-speaker__cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  cursor: pointer;
}
.ns-speaker__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
}
.ns-speaker__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-speaker__flag {
  flex: 0 0 auto;
  padding: 0 3px;
  border-radius: 2px;
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
  font-size: 10px;
}
.ns-speaker.is-unassigned .ns-speaker__name {
  color: var(--ns-warning, #e6a23c);
}
.ns-speaker.is-pending .ns-speaker__name {
  font-weight: 600;
}
.ns-speaker__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ns-speaker__panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.ns-speaker__panel-title {
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-speaker__seq {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-speaker__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
}
.ns-speaker__option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.ns-speaker__option:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-speaker__option.is-active {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 10%);
  color: var(--ns-primary, #409eff);
}
.ns-speaker__option-name {
  flex: 1;
}
.ns-speaker__aliases {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-speaker__empty {
  margin: 4px 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-speaker__panel-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
  padding-top: 6px;
}
.ns-speaker__full {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.ns-speaker__select {
  flex: 1;
  min-width: 140px;
}
.ns-speaker__candidates {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.ns-speaker__candidates-label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-speaker__candidate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 10px;
  background: var(--ns-bg-elevated);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  cursor: pointer;
}
.ns-speaker__candidate:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-speaker__candidate em {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--ns-fill, #ebeef5);
  font-size: 10px;
  font-style: normal;
}
.ns-speaker__score {
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-speaker__warn {
  margin: 6px 0 0;
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.5;
}
</style>
