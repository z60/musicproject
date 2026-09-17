<!--
  Novel Studio · 方案选择与管理（docs/13 §7 多方案 FR-4.13）
  ============================================================================
  设计依据：
    · docs/13 §7 —— 一个章节可以有多个 arrangement（标准版 / 紧凑版 / 带 BGM 版）；
      切换方案时**时间线视图整体切换**；复制方案（基于现有方案修改）；
      **默认方案** `isDefault=1`，自动对轨时写入该方案。
    · docs/13 §11 —— 方案被混音导出引用后又改了对轨：必须提示
      「该方案已被用于导出，修改后需重新渲染」。因此摘要里显式列出引用它的混音方案名。
    · docs/13 §4.5 —— 顶部工具条第二个控件就是「方案：标准版 ▾」。

  ★ 契约缺口（不臆造接口）：
    IPC 契约里只有 `alignment:create / duplicate / delete / setDefault / listArrangements`，
    **没有 rename / update 通道**（已逐条核对 `src/shared/ipc.ts`）。
    因此「重命名」按钮做成**显式禁用 + 说明**，并给出可行替代：
    「复制为新名称」再删除旧方案。绝不偷偷用 create+delete 冒充重命名
    （那会换掉 arrangementId，让已引用它的混音方案指向一个不存在的方案）。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ArrangeStrategy, Arrangement, Id } from '@shared/types.ts'
import { ARRANGE_STRATEGY_LABELS } from '@shared/constants.ts'
import { formatDuration, formatRelativeTime } from '@/shared/lib/format.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import { useArrangementStore } from '../stores/arrangement.store.ts'

const props = withDefaults(defineProps<{
  /** 章节 id（换章时重新拉方案列表） */
  chapterId?: Id | null
  /** 紧凑模式（放在工具条里时隐藏摘要） */
  compact?: boolean
}>(), {
  chapterId: null,
  compact: false,
})

const emit = defineEmits<{
  /** 方案切换完成（视图据此复位视口/选中，并重新绑定时间线章节） */
  changed: [arrangementId: Id]
  /** 当前方案已被混音导出引用（视图可在状态条给一条提醒） */
  'referenced': [projectNames: string[]]
  /** 请求打开「预览渲染」对话框 */
  'open-preview': []
}>()

const arrangement = useArrangementStore()

// ---------------------------------------------------------------------------
// 表单态（新建 / 复制共用一个内联表单，不用弹窗，避免打断时间线操作）
// ---------------------------------------------------------------------------

type FormMode = 'create' | 'duplicate'

const formMode = ref<FormMode | null>(null)
const formName = ref('')
const formStrategy = ref<ArrangeStrategy>('serialize')
const busy = ref(false)
const confirmDelete = ref(false)

const current = computed(() => arrangement.arrangement)
const list = computed<Arrangement[]>(() => arrangement.arrangements)

const options = computed(() => list.value.map(item => ({
  value: item.id,
  label: item.isDefault ? `${item.name}（默认）` : item.name,
  strategy: ARRANGE_STRATEGY_LABELS[item.strategy] ?? item.strategy,
  durationMs: item.totalDurationMs,
  version: item.version,
})))

const strategyOptions = computed(() => (Object.keys(ARRANGE_STRATEGY_LABELS) as ArrangeStrategy[])
  .map(value => ({ value, label: ARRANGE_STRATEGY_LABELS[value] ?? value })))

const summary = computed(() => {
  const item = current.value
  if (!item) return null
  return {
    name: item.name,
    strategy: ARRANGE_STRATEGY_LABELS[item.strategy] ?? item.strategy,
    durationText: formatDuration(item.totalDurationMs > 0 ? item.totalDurationMs : arrangement.totalDurationMs),
    version: item.version,
    isDefault: item.isDefault,
    updatedText: formatRelativeTime(item.updatedAt),
  }
})

const referencedNames = computed(() => arrangement.referencedByMixProjects.map(p => p.name))

const canDelete = computed(() => list.value.length > 1)

// 换章时重新拉一次列表（loadChapter 也会拉，但这里保证「只有 store 没有章节上下文」时也能用）
watch(
  () => props.chapterId,
  (chapterId) => {
    if (!chapterId) return
    if (arrangement.chapter?.id === chapterId && list.value.length) return
    void arrangement.loadArrangements(chapterId)
  },
  { immediate: true },
)

watch(referencedNames, (names) => {
  if (names.length) emit('referenced', names)
})

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function onSelect(id: Id): Promise<void> {
  if (id === current.value?.id) return
  busy.value = true
  try {
    await arrangement.selectArrangement(id)
    emit('changed', id)
  } finally {
    busy.value = false
  }
}

function openCreate(): void {
  formMode.value = 'create'
  formName.value = `方案 ${list.value.length + 1}`
  formStrategy.value = current.value?.strategy ?? 'serialize'
}

function openDuplicate(): void {
  if (!current.value) return
  formMode.value = 'duplicate'
  formName.value = `${current.value.name} 副本`
  formStrategy.value = current.value.strategy
}

function closeForm(): void {
  formMode.value = null
}

async function submitForm(): Promise<void> {
  const name = formName.value.trim()
  if (!name || !formMode.value) return
  busy.value = true
  try {
    const created = formMode.value === 'create'
      ? await arrangement.createArrangement(name, formStrategy.value)
      : await arrangement.duplicateArrangement(name)
    if (created) {
      emit('changed', created.id)
      closeForm()
    }
  } finally {
    busy.value = false
  }
}

async function onSetDefault(): Promise<void> {
  if (!current.value || current.value.isDefault) return
  busy.value = true
  try {
    await arrangement.setDefaultArrangement()
  } finally {
    busy.value = false
  }
}

async function onDelete(): Promise<void> {
  confirmDelete.value = false
  busy.value = true
  try {
    const ok = await arrangement.deleteArrangement()
    if (ok && arrangement.arrangement) emit('changed', arrangement.arrangement.id)
  } finally {
    busy.value = false
  }
}

const deleteDetails = computed(() => {
  const item = current.value
  if (!item) return []
  const details = [
    `方案「${item.name}」下的全部片段位置（${arrangement.items.length} 段）会一并删除。`,
    '音频文件本身不会被删除（录音仍在，随时可以重跑自动对轨）。',
  ]
  if (referencedNames.value.length) {
    details.push(`⚠ 该方案已被混音方案 ${referencedNames.value.join('、')} 引用：删除后它们将无法重新渲染。`)
  }
  return details
})
</script>

<template>
  <div class="ns-arrange" :class="{ 'is-compact': compact }">
    <!-- 方案下拉 -->
    <div class="ns-arrange__row">
      <span class="ns-arrange__label">方案</span>
      <el-select
        :model-value="current?.id ?? ''"
        :loading="busy || arrangement.loading"
        size="small"
        class="ns-arrange__select"
        placeholder="选择方案"
        @update:model-value="onSelect"
      >
        <el-option
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        >
          <span class="ns-arrange__option">
            <span class="ns-arrange__option-name">{{ option.label }}</span>
            <span class="ns-arrange__option-meta">{{ option.strategy }} · {{ formatDuration(option.durationMs) }} · v{{ option.version }}</span>
          </span>
        </el-option>
      </el-select>
      <el-button size="small" :disabled="busy" @click="openCreate">新建</el-button>
      <el-button size="small" :disabled="busy || !current" @click="openDuplicate">复制</el-button>
      <el-button size="small" :disabled="busy || !current || current.isDefault" @click="onSetDefault">设为默认</el-button>
      <el-button size="small" type="danger" plain :disabled="busy || !canDelete" @click="confirmDelete = true">删除</el-button>
      <!-- 重命名：契约无该通道，显式禁用并说明可行替代（见文件头注释） -->
      <el-tooltip
        content="IPC 契约没有 alignment:rename 通道；请用「复制」建一个新名字的方案，确认无误后再删除旧的"
        placement="bottom"
      >
        <span class="ns-arrange__disabled-wrap">
          <el-button size="small" disabled>重命名</el-button>
        </span>
      </el-tooltip>
    </div>

    <!-- 内联表单：新建 / 复制（不弹窗，不打断时间线操作） -->
    <div v-if="formMode" class="ns-arrange__form">
      <el-input
        v-model="formName"
        size="small"
        class="ns-arrange__input"
        :placeholder="formMode === 'create' ? '新方案名称' : '副本名称'"
        maxlength="40"
        show-word-limit
        @keyup.enter="submitForm"
      />
      <el-select
        v-if="formMode === 'create'"
        v-model="formStrategy"
        size="small"
        class="ns-arrange__strategy"
      >
        <el-option v-for="option in strategyOptions" :key="option.value" :value="option.value" :label="option.label" />
      </el-select>
      <el-button size="small" type="primary" :loading="busy" :disabled="!formName.trim()" @click="submitForm">
        {{ formMode === 'create' ? '创建' : '复制' }}
      </el-button>
      <el-button size="small" @click="closeForm">取消</el-button>
      <span class="ns-arrange__form-hint">
        {{ formMode === 'create' ? '创建后会立即切换到新方案（自动对轨会按所选策略写入）。' : '复制会带上当前方案的全部片段位置与锁定状态。' }}
      </span>
    </div>

    <!-- 摘要：策略 / 总时长 / 版本 / 引用情况 -->
    <div v-if="!compact && summary" class="ns-arrange__summary">
      <span class="ns-arrange__summary-item">{{ summary.strategy }}</span>
      <span class="ns-arrange__summary-item">总时长 {{ summary.durationText }}</span>
      <span class="ns-arrange__summary-item">v{{ summary.version }}</span>
      <span class="ns-arrange__summary-item">{{ summary.updatedText }}更新</span>
      <span v-if="summary.isDefault" class="ns-arrange__badge">默认方案</span>
      <span v-if="referencedNames.length" class="ns-arrange__referenced" :title="referencedNames.join('、')">
        已被导出引用：{{ referencedNames.join('、') }} —— 改动后需重新渲染
      </span>
      <el-button size="small" text class="ns-arrange__preview" @click="emit('open-preview')">预览渲染</el-button>
    </div>

    <ConfirmDialog
      v-model="confirmDelete"
      type="danger"
      title="删除该方案？"
      :message="`方案「${current?.name ?? ''}」将被删除，且不可撤销。`"
      :details="deleteDetails"
      confirm-text="删除方案"
      @confirm="onDelete"
    />
  </div>
</template>

<style scoped>
.ns-arrange {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.ns-arrange__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ns-arrange__label {
  color: var(--ns-text-secondary, #909399);
}
.ns-arrange__select {
  width: 176px;
}
.ns-arrange__option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.ns-arrange__option-name {
  color: var(--ns-text-primary, #303133);
}
.ns-arrange__option-meta {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-arrange__disabled-wrap {
  display: inline-flex;
}
.ns-arrange__form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--ns-primary, #409eff);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ns-primary, #409eff) 5%, var(--ns-bg, #fff));
}
.ns-arrange__input {
  width: 180px;
}
.ns-arrange__strategy {
  width: 108px;
}
.ns-arrange__form-hint {
  flex: 1 1 200px;
  min-width: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-arrange__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-arrange__summary-item {
  font-variant-numeric: tabular-nums;
}
.ns-arrange__badge {
  padding: 0 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ns-success, #67c23a) 16%, var(--ns-bg, #fff));
  color: var(--ns-success, #67c23a);
}
.ns-arrange__referenced {
  max-width: 100%;
  overflow: hidden;
  color: var(--ns-warning, #e6a23c);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-arrange__preview {
  margin-left: auto;
}
</style>
