<!--
  Novel Studio · 预设套用范围选择（docs/14 §4.2「应用范围」、§7.1 第 1 步「解析目标集合」）
  ============================================================================
  为什么要有这一步：
    处理链是**逐片段**生效的，而用户脑子里想的是「把女主这条线全部换成明亮预设」。
    中间必须有一次明确的「将处理 N 个片段」换算，否则最危险的误操作就是
    「我以为只改一条，结果全书 1240 条都被重跑了」。

  二次确认的门槛（BULK_CONFIRM_THRESHOLD）：超过 20 个片段时再问一次，
  并把前 5 条明细列出来。低于门槛直接执行，避免「什么都弹框」的疲劳。

  提交路径（IPC 契约）：
    · 单片段 → `process:apply`（store.applyToSegment）
    · 其余范围 → `process:batchApply`（store.batchApply，主进程按 process:{segmentId}:{presetHash} 幂等去重）
  两者都返回 taskId，进度用 TaskProgressCard 显示；失败明细走 BatchProcessReport（本组件不逐条弹提示）。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useProcessChainStore } from '../stores/processChain.store.ts'
import { usePresetsStore } from '../stores/presets.store.ts'
import { useMixStore } from '../stores/mix.store.ts'
import { summarizeChain } from '../stores/processChain.store.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import type { Id, ProcessChain, ProcessScope } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  modelValue: boolean
  /** 要套用的预设；为空表示「套用当前编辑链」（chain 参数或 store 里的链） */
  presetId?: Id | null
  /** 当前编辑链（未保存为预设时直接套用这条链） */
  chain?: ProcessChain | null
  /** 对话框标题里显示的名字 */
  label?: string
}>(), {
  presetId: null,
  chain: null,
  label: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 已派发任务（父级可据此刷新列表 / 打开报告） */
  applied: [taskId: Id]
}>()

const chainStore = useProcessChainStore()
const presets = usePresetsStore()
const mix = useMixStore()

/** 超过这个数量就再确认一次（docs/14 §7.1：批量前必须让用户看清目标集合） */
const BULK_CONFIRM_THRESHOLD = 20

const SCOPE_OPTIONS: Array<{ value: ProcessScope; label: string; hint: string }> = [
  { value: 'segment', label: '单片段', hint: '只处理选中的一个片段，用来先试听确认效果' },
  { value: 'character', label: '整个角色', hint: '该角色在本章的全部片段（docs/14 §4.2 最省事的用法）' },
  { value: 'chapter', label: '整章（当前筛选范围）', hint: '本章对轨结果里的全部片段，逐条对比找差异用这个' },
  { value: 'book', label: '全书', hint: '逐章解析目标集合，章数多时较慢，确认后再跑' },
]

const scope = ref<ProcessScope>('character')
const characterId = ref<Id | null>(null)
const segmentId = ref<Id | null>(null)
const taskId = ref<Id | null>(null)
const confirmVisible = ref(false)
const submitting = ref(false)

const task = useTaskProgress(taskId)

// 打开时重置：上一次的进度不该带到这一次
watch(() => props.modelValue, (open) => {
  if (!open) return
  taskId.value = null
  confirmVisible.value = false
  submitting.value = false
  if (!chainStore.segmentIndex.length) void chainStore.loadSegmentIndex()
  if (!mix.characters.length) void mix.loadCharacters()
  const firstCharacter = mix.characters[0]?.value ?? null
  characterId.value = characterId.value ?? firstCharacter
  segmentId.value = segmentId.value ?? chainStore.segmentIndex[0]?.segmentId ?? null
  void resolve()
})

// 范围变化即换算目标集合（这一步是纯读取，不改任何状态）
watch([scope, characterId, segmentId], () => { if (props.modelValue) void resolve() })

async function resolve(): Promise<void> {
  if (scope.value === 'segment') {
    await chainStore.resolveScope('segment', { segmentIds: segmentId.value ? [segmentId.value] : [] })
    return
  }
  if (scope.value === 'character') {
    await chainStore.resolveScope('character', { characterId: characterId.value })
    return
  }
  await chainStore.resolveScope(scope.value)
}

// ── 表单事件：类型只写在脚本里（模板表达式按 JS 解析，不能写 TS 语法）──────
/**
 * 应用范围：el-radio-group 的 change 载荷即选项值（SCOPE_OPTIONS 的值，类型 ProcessScope）。
 *
 * 参数收宽 + 体内收窄：Element Plus 2.14 起事件参数类型是
 * `string | number | boolean | undefined`，精确类型会因逆变而不可赋值。
 */
function onScopeChange(value: string | number | boolean | undefined): void {
  scope.value = value as ProcessScope
}

/** 角色下拉：el-select 的载荷即选项值（mix.characters 的 value，类型 Id），清空时为 null */
function onCharacterChange(value: Id | null): void {
  characterId.value = value ?? null
}

/** 片段下拉：el-select 的载荷即选项值（SegmentRef.segmentId，类型 Id），清空时为 null */
function onSegmentChange(value: Id | null): void {
  segmentId.value = value ?? null
}

const targets = computed(() => chainStore.scopeTargets)
const targetCount = computed(() => targets.value?.ids.length ?? 0)

/** 将要套用的链：预设优先（预设是共享资产），否则用当前编辑链 */
const effectiveChain = computed(() => {
  const preset = presets.getById(props.presetId)
  if (preset) return preset.chain
  return props.chain ?? chainStore.chain
})

const chainSummary = computed(() => summarizeChain(effectiveChain.value))

const titleText = computed(() => {
  const preset = presets.getById(props.presetId)
  const name = preset?.name ?? props.label ?? '当前处理链'
  return `套用「${name}」`
})

const scopeHint = computed(() => SCOPE_OPTIONS.find(item => item.value === scope.value)?.hint ?? '')

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (scope.value === 'segment') return Boolean(segmentId.value)
  if (scope.value === 'character') return Boolean(characterId.value) && targetCount.value > 0
  return targetCount.value > 0
})

function close(): void {
  emit('update:modelValue', false)
}

/** 「开始处理」：超过门槛先弹二次确认，否则直接派发 */
function onSubmit(): void {
  if (!canSubmit.value) return
  if (scope.value !== 'segment' && targetCount.value > BULK_CONFIRM_THRESHOLD) {
    confirmVisible.value = true
    return
  }
  void dispatch()
}

async function dispatch(): Promise<void> {
  submitting.value = true
  try {
    if (scope.value === 'segment') {
      const id = await chainStore.applyToSegment(segmentId.value as Id, props.presetId ?? null)
      if (id) {
        taskId.value = id
        emit('applied', id)
      }
      return
    }
    const id = await chainStore.batchApply({
      scope: scope.value,
      ids: targets.value?.ids ?? [],
      presetId: props.presetId ?? undefined,
      // 有预设就按 presetId 处理（主进程按 presetHash 去重）；否则把当前链整条送过去
      ...(props.presetId ? {} : { chain: effectiveChain.value }),
    })
    if (id) {
      taskId.value = id
      emit('applied', id)
    }
  } finally {
    submitting.value = false
    confirmVisible.value = false
  }
}

// 任务终态：把结果留在对话框里，并让父级去收集报告（明细统一在 BatchProcessReport 里看）
watch(() => task.isFinished.value, (finished) => {
  if (!finished || !taskId.value) return
  void chainStore.collectReport(taskId.value)
})
</script>

<template>
  <div v-if="props.modelValue" class="ns-apply" role="dialog" aria-modal="true" :aria-label="titleText">
    <div class="ns-apply__mask" @click="close" />
    <section class="ns-apply__panel">
      <header class="ns-apply__head">
        <h3>{{ titleText }}</h3>
        <p class="ns-apply__chain">{{ chainSummary }}</p>
      </header>

      <div class="ns-apply__body">
        <div class="ns-apply__field">
          <span class="ns-label">应用范围</span>
          <el-radio-group
            :model-value="scope"
            size="small"
            @change="onScopeChange"
          >
            <el-radio-button v-for="item in SCOPE_OPTIONS" :key="item.value" :value="item.value">
              {{ item.label }}
            </el-radio-button>
          </el-radio-group>
          <p class="ns-hint">{{ scopeHint }}</p>
        </div>

        <div v-if="scope === 'character'" class="ns-apply__field">
          <span class="ns-label">角色</span>
          <el-select
            :model-value="characterId"
            size="small"
            filterable
            placeholder="选择角色"
            @change="onCharacterChange"
          >
            <el-option v-for="item in mix.characters" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="!mix.characters.length" class="ns-hint">
            还没读到角色列表：可在混音台点「按角色生成轨道」时一并加载
          </span>
        </div>

        <div v-if="scope === 'segment'" class="ns-apply__field">
          <span class="ns-label">片段</span>
          <el-select
            :model-value="segmentId"
            size="small"
            filterable
            placeholder="选择片段"
            @change="onSegmentChange"
          >
            <el-option
              v-for="item in chainStore.segmentIndex"
              :key="item.segmentId"
              :label="item.label"
              :value="item.segmentId"
            />
          </el-select>
          <el-button size="small" :loading="chainStore.segmentIndexLoading" @click="chainStore.loadSegmentIndex(true)">
            刷新片段索引
          </el-button>
        </div>

        <!-- 「将处理 N 个片段」预览：这是整个对话框存在的理由 -->
        <div class="ns-apply__preview">
          <p class="ns-apply__count">
            <template v-if="chainStore.scopeResolving">正在解析目标集合…</template>
            <template v-else-if="scope === 'segment'">
              将处理 <strong>1</strong> 个片段（单片段套用）
            </template>
            <template v-else>将处理 <strong>{{ targetCount }}</strong> 个片段</template>
          </p>
          <ul v-if="targets && targets.preview.length" class="ns-apply__list">
            <li v-for="(item, index) in targets.preview.slice(0, 5)" :key="`${index}-${item}`">{{ item }}</li>
          </ul>
          <p v-if="targets && targetCount > targets.preview.length" class="ns-hint">
            仅列出前 {{ Math.min(5, targets.preview.length) }} 条，共 {{ targetCount }} 条
          </p>
          <p v-if="scope !== 'segment' && !chainStore.scopeResolving && targetCount === 0" class="ns-warn">
            该范围内没有可处理的片段（可能还没有对轨结果，或该角色本章没有录制）
          </p>
          <p v-if="scope === 'book'" class="ns-hint">
            全书范围会逐章读取对轨结果，章数多时需要等一会儿
          </p>
        </div>

        <TaskProgressCard
          v-if="taskId"
          :task-id="taskId"
          :title="`套用处理链（${scope === 'segment' ? '单片段' : `${targetCount} 个片段`}）`"
          :kind="scope === 'segment' ? 'process.apply' : 'process.batch'"
          size="compact"
          :openable="true"
        />
      </div>

      <footer class="ns-apply__foot">
        <span class="ns-hint">套用只写处理结果，不会改动录音素材；随时可用 process:revert 回退</span>
        <div class="ns-apply__buttons">
          <el-button size="small" @click="close">{{ taskId ? '关闭' : '取消' }}</el-button>
          <el-button size="small" type="primary" :loading="submitting" :disabled="!canSubmit" @click="onSubmit">
            开始处理
          </el-button>
        </div>
      </footer>
    </section>

    <!-- 大批量二次确认：把「将处理 N 个片段」再念一遍，并给出明细 -->
    <ConfirmDialog
      v-model="confirmVisible"
      :title="'确认批量处理'"
      :message="`将对 ${targetCount} 个片段套用该处理链，处理产物会替换这些片段当前的处理结果。`"
      type="warning"
      :details="(targets?.preview ?? []).slice(0, 5)"
      confirm-text="确认处理"
      :loading="submitting"
      @confirm="dispatch"
    />
  </div>
</template>

<style scoped>
.ns-apply { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; }
.ns-apply__mask { position: absolute; inset: 0; background: rgb(0 0 0 / 45%); }
.ns-apply__panel {
  position: relative; z-index: 1; display: flex; flex-direction: column; gap: 12px;
  width: min(560px, 92vw); max-height: 86vh; overflow: auto; padding: 16px 18px 14px;
  border-radius: 10px; background: var(--ns-bg-elevated, #fff); box-shadow: 0 12px 36px rgb(0 0 0 / 22%);
}
.ns-apply__head h3 { margin: 0; font-size: 15px; color: var(--ns-text-primary, #303133); }
.ns-apply__chain { margin: 4px 0 0; color: var(--ns-text-secondary, #909399); font-size: 11.5px; line-height: 1.5; }
.ns-apply__body { display: flex; flex-direction: column; gap: 10px; }
.ns-apply__field { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-label { min-width: 62px; color: var(--ns-text-regular, #606266); font-size: 12px; }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-warn { margin: 0; color: var(--ns-warning, #e6a23c); font-size: 11.5px; }
.ns-apply__preview {
  padding: 8px 10px; border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px; background: var(--ns-bg-subtle, #fafafa);
}
.ns-apply__count { margin: 0 0 4px; color: var(--ns-text-primary, #303133); font-size: 12.5px; }
.ns-apply__count strong { color: var(--ns-primary, #409eff); font-family: ui-monospace, Consolas, monospace; }
.ns-apply__list { margin: 0 0 4px; padding-left: 16px; color: var(--ns-text-regular, #606266); font-size: 11.5px; line-height: 1.6; }
.ns-apply__foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ns-apply__buttons { display: flex; gap: 8px; }
</style>
