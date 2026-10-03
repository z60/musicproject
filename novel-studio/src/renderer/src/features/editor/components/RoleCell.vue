<!--
  画本编辑 · 角色名单元格（docs/11 §4.2）
  ============================================================================
  说话人列回答「谁来念」（CV），这一列回答「演的是谁」（角色）。真机反馈：
  「画本编辑的主视图里说话人需要选择 CV，角色需要选择角色名」—— 两列都必须能直接改。

  设计要点：
    · 与 SpeakerCell 同一套写法：紧凑形态只渲染文字，点击才弹面板（5000 行不挂几百个下拉）；
    · 写库走 useSpeakerAssign.assign（decidedBy 强制 human），成功后 emit('change') 让父组件刷新；
    · 选中「旁白」提交的是 characterId = null（旁白不是普通角色，见 shared/canvas/speaker-options.ts）；
    · 音效行（kind='sfx_note'）不给下拉：它的类型由「类型」列/抽屉决定，在角色列改会得到
      「选了角色但角色名仍显示音效」的怪状态。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CanvasLine, Id } from '@shared/types.ts'
import { filterSpeakerOptions } from '@shared/canvas/speaker-options.ts'
import { useSpeakerAssign } from '../composables/useSpeakerAssign.ts'
import { useCharactersStore } from '../stores/characters.store.ts'

const props = withDefaults(defineProps<{
  line: CanvasLine
  readonly?: boolean
}>(), { readonly: false })

const emit = defineEmits<{
  /** 指派成功（父组件刷新队列 / 质检 / 状态栏） */
  change: [lineId: Id, characterId: Id | null]
  /** 请求打开单行编辑抽屉 */
  open: [lineId: Id]
}>()

const characters = useCharactersStore()
const speaker = useSpeakerAssign()

const panelOpen = ref(false)
const keyword = ref('')

const label = computed(() => characters.roleNameOf(props.line))
/** 音效行不挂下拉（理由见文件头） */
const editable = computed(() => props.line.kind !== 'sfx_note')
const options = computed(() => (editable.value ? filterSpeakerOptions(characters.rolePickerOptions, keyword.value) : []))

async function assign(characterId: Id | null): Promise<void> {
  if (props.readonly) return
  const result = await speaker.assign(props.line, characterId)
  if (result.ok) {
    panelOpen.value = false
    keyword.value = ''
    emit('change', props.line.id, characterId)
  }
}

function onPanelChange(open: boolean): void {
  if (props.readonly) {
    emit('open', props.line.id)
    return
  }
  panelOpen.value = open
}
</script>

<template>
  <div class="ns-role" :class="{ 'ns-role--static': !editable }">
    <el-popover
      v-if="editable"
      :model-value="panelOpen"
      trigger="click"
      placement="bottom-start"
      :width="280"
      @update:model-value="onPanelChange"
    >
      <template #reference>
        <span class="ns-role__cell" :title="readonly ? `${label}（只读）` : `点击选择角色名：${label}`">
          <span class="ns-role__name">{{ label }}</span>
        </span>
      </template>

      <div class="ns-role__panel">
        <div class="ns-role__panel-head">
          <span class="ns-role__panel-title">选择角色名</span>
          <span class="ns-role__seq">#{{ line.seq }}</span>
        </div>

        <el-input v-model="keyword" size="small" placeholder="搜索角色名或别名" clearable />

        <div class="ns-role__list">
          <button
            v-for="item in options"
            :key="`${item.characterId ?? 'narration'}::${item.label}`"
            type="button"
            class="ns-role__option"
            :class="{ 'is-active': item.characterId === line.characterId }"
            @click="assign(item.characterId)"
          >
            <i
              class="ns-role__dot"
              :style="{ background: item.characterId ? characters.colorOf(item.characterId) : 'transparent' }"
            />
            <span class="ns-role__option-name">{{ item.label }}</span>
            <span v-if="item.hint" class="ns-role__aliases">{{ item.hint }}</span>
          </button>
          <p v-if="!options.length" class="ns-role__empty">没有匹配的角色（可在右栏角色表里新增）</p>
        </div>

        <div class="ns-role__panel-actions">
          <el-button size="small" text @click="emit('open', line.id)">完整编辑</el-button>
        </div>
      </div>
    </el-popover>

    <span v-else class="ns-role__name" :title="label">{{ label }}</span>
  </div>
</template>

<style scoped>
.ns-role {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.ns-role__cell {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  cursor: pointer;
}
.ns-role__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-role__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ns-role__panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.ns-role__panel-title {
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-role__seq {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-role__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
}
.ns-role__option {
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
.ns-role__option:hover {
  background: var(--ns-fill-light, #f5f7fa);
}
.ns-role__option.is-active {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 10%);
  color: var(--ns-primary, #409eff);
}
.ns-role__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
}
.ns-role__option-name {
  flex: 1;
}
.ns-role__aliases {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-role__empty {
  margin: 4px 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-role__panel-actions {
  display: flex;
  justify-content: flex-end;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
  padding-top: 6px;
}
</style>
