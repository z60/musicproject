<!--
  画本编辑 · 角色合并对话框（docs/11 §4.6「合并」、§8「合并角色时有同名别名冲突」）
  ============================================================================
  合并前必须让用户看清三件事（缺一件都会合错）：
    1. **将影响 N 行** —— 台词会从被合并角色迁到保留角色（N 来自 character:stats 或本地行数）
    2. **别名冲突清单** —— 「萧炎」同时是 A 的别名和 B 的正名时，必须让人决定保留哪个
    3. 别名是否保留（keepAliases）—— 丢掉别名会让之后的重算找不到这个角色

  冲突文案不在这里自拼：真正合并时主进程会抛 CHARACTER_MERGE_CONFLICT，
  由调用方交给 error-bus 兑现（本组件只展示预览清单，属于界面说明而非错误提示）。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Character, CharacterStats, Id } from '@shared/types.ts'
import { formatCount, formatDuration, formatInt } from '@/shared/lib/format.ts'
import type { MergePreview } from '../stores/characters.store.ts'

const props = withDefaults(defineProps<{
  /** 双向绑定：是否显示 */
  modelValue: boolean
  /** 参与合并的角色（含保留目标） */
  characters: Character[]
  /** 预览数据（别名冲突 / 迁移别名 / 影响行数），由 characters.store.previewMerge 计算 */
  preview?: MergePreview | null
  /** 各角色的出场统计（「将影响 N 行」的明细） */
  stats?: Record<Id, CharacterStats>
  /** 提交中 */
  loading?: boolean
}>(), {
  preview: null,
  stats: () => ({}),
  loading: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 确认合并：targetId 保留，sourceIds 被并入 */
  confirm: [payload: { targetId: Id; sourceIds: Id[]; keepAliases: boolean }]
  cancel: []
}>()

/** 保留哪个角色（默认选行数最多的，通常是正主） */
const targetId = ref<Id | null>(null)
const keepAliases = ref(true)

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  keepAliases.value = true
  targetId.value = pickHeaviest()
})

watch(() => props.characters, () => {
  if (!props.modelValue) return
  if (!targetId.value || !props.characters.some(c => c.id === targetId.value)) targetId.value = pickHeaviest()
})

/** 行数最多的角色作为默认保留目标 */
function pickHeaviest(): Id | null {
  let best: Character | null = null
  let bestLines = -1
  for (const character of props.characters) {
    const lines = props.stats[character.id]?.lines ?? 0
    if (lines > bestLines) {
      bestLines = lines
      best = character
    }
  }
  return best?.id ?? props.characters[0]?.id ?? null
}

const sourceIds = computed(() => props.characters.filter(c => c.id !== targetId.value).map(c => c.id))
const target = computed(() => props.characters.find(c => c.id === targetId.value) ?? null)

/** 「将影响 N 行」：优先用主进程给的真实统计，缺失时退回预览里的估算 */
const affectedLines = computed(() => {
  const fromStats = sourceIds.value.reduce((sum, id) => sum + (props.stats[id]?.lines ?? 0), 0)
  return fromStats || props.preview?.affectedLines || 0
})

const affectedChars = computed(() =>
  sourceIds.value.reduce((sum, id) => sum + (props.stats[id]?.chars ?? 0), 0))

const affectedDuration = computed(() =>
  sourceIds.value.reduce((sum, id) => sum + (props.stats[id]?.estimatedDurationMs ?? 0), 0))

const aliasConflicts = computed(() => props.preview?.aliasConflicts ?? [])
const movingAliases = computed(() => props.preview?.movingAliases ?? [])

function close(): void {
  emit('update:modelValue', false)
}

/** 对话框显隐：el-dialog 的 update:model-value 载荷为 boolean */
function onVisibleInput(value: boolean): void {
  emit('update:modelValue', value)
}

function onCancel(): void {
  emit('cancel')
  close()
}

function onConfirm(): void {
  if (!targetId.value || !sourceIds.value.length || props.loading) return
  emit('confirm', { targetId: targetId.value, sourceIds: sourceIds.value, keepAliases: keepAliases.value })
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    title="合并角色"
    width="560px"
    :close-on-click-modal="false"
    @update:model-value="onVisibleInput"
  >
    <div class="ns-merge">
      <p class="ns-merge__lead">
        把 {{ props.characters.length }} 个角色合并成一个：台词与别名会迁移到保留角色，
        被合并的角色默认归档（不物理删除，既有引用保留）。
      </p>

      <!-- 保留哪个 -->
      <section class="ns-merge__section">
        <h4 class="ns-merge__title">保留哪个角色</h4>
        <el-radio-group v-model="targetId" class="ns-merge__radios">
          <el-radio v-for="character in props.characters" :key="character.id" :value="character.id" border>
            <i class="ns-merge__dot" :style="{ background: character.color ?? '#909399' }" />
            {{ character.name }}
            <span class="ns-merge__muted">{{ formatInt(props.stats[character.id]?.lines ?? 0) }} 行</span>
          </el-radio>
        </el-radio-group>
      </section>

      <!-- 将影响 N 行 -->
      <section class="ns-merge__section">
        <h4 class="ns-merge__title">将影响的行</h4>
        <ul class="ns-merge__impact">
          <li>台词迁移：<strong>{{ formatInt(affectedLines) }}</strong> 行</li>
          <li>字数：{{ formatCount(affectedChars) }} 字</li>
          <li>预估时长：{{ formatDuration(affectedDuration) }}</li>
          <li v-if="target">保留角色：{{ target.name }}（别名 {{ target.aliases.length }} 个）</li>
        </ul>
        <p v-if="!affectedLines" class="ns-merge__muted">这些角色目前没有台词引用（可能只是刚抽取出来的候选）。</p>
      </section>

      <!-- 别名迁移与冲突 -->
      <section class="ns-merge__section">
        <h4 class="ns-merge__title">
          别名迁移
          <span class="ns-merge__muted">共 {{ movingAliases.length }} 个</span>
        </h4>

        <div v-if="movingAliases.length" class="ns-merge__aliases">
          <el-tag
            v-for="alias in movingAliases"
            :key="alias"
            size="small"
            :type="aliasConflicts.includes(alias) ? 'warning' : undefined"
          >
            {{ alias }}
          </el-tag>
        </div>
        <p v-else class="ns-merge__muted">没有需要迁移的别名。</p>

        <div v-if="aliasConflicts.length" class="ns-merge__conflicts">
          <p class="ns-merge__conflict-title">
            有 {{ aliasConflicts.length }} 个别名同时属于两个角色，需要人工决定保留哪个：
          </p>
          <ul>
            <li v-for="alias in aliasConflicts" :key="alias"><code>{{ alias }}</code></li>
          </ul>
          <p class="ns-merge__muted">
            处理建议：先取消合并，把冲突别名从其中一个角色上删掉再合并；或合并后手动修正。
          </p>
        </div>

        <el-checkbox v-model="keepAliases" class="ns-merge__keep">
          保留被合并角色的别名（推荐：别名参与归属判定，丢掉会让重算找不到这个角色）
        </el-checkbox>
      </section>

      <p class="ns-merge__note">
        合并会更新角色统计与原型向量来源；合并完成后建议对「低置信」的行重算一次归属。
      </p>
    </div>

    <template #footer>
      <el-button @click="onCancel">取消</el-button>
      <el-button
        type="primary"
        :loading="props.loading"
        :disabled="!targetId || !sourceIds.length"
        @click="onConfirm"
      >
        合并（保留 {{ target?.name ?? '—' }}）
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ns-merge {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ns-merge__lead {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  line-height: 1.7;
}
.ns-merge__section {
  padding-top: 8px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}
.ns-merge__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-merge__radios {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ns-merge__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  border-radius: 50%;
}
.ns-merge__impact {
  margin: 0;
  padding-left: 18px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  line-height: 1.8;
}
.ns-merge__aliases {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ns-merge__conflicts {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgb(230 162 60 / 12%);
}
.ns-merge__conflict-title {
  margin: 0 0 4px;
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  font-weight: 600;
}
.ns-merge__conflicts ul {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}
.ns-merge__keep {
  margin-top: 8px;
}
.ns-merge__muted {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-merge__note {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
</style>
