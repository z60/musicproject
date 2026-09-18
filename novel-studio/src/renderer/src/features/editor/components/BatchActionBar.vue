<!--
  Novel Studio · 批量操作条（docs/11 §4.7）
  ============================================================================
  设计依据：
    · docs/11 §4.7 —— 筛选后（例如「说话人=unknown 且 kind=dialogue」）可执行：
        批量指派说话人（含「按候选第一位自动指派」）/ 批量设置情绪·语速·停顿 /
        批量加·移除标记 / 批量合并相邻旁白（合并后文本用句号连接）/
        批量设置 decidedBy='human'（锁定，防重算覆盖）/ 批量软删除·恢复。
    · docs/11 §4.7 + docs/22 §7 —— 破坏性操作前必须**说清影响行数**：本条每一项都先弹
        ConfirmDialog，明细里写明「将影响 N 行」与作用范围（筛选条件 / 选中行）。
    · docs/11 §4.7 —— 提交必须走 store 的批量动作（canvas:batchUpdate 一个事务、
        撤销栈里一条命令），**不在组件里逐行发请求**：一次批量只产生一次汇总提示，
        逐条失败由 store 的 callCollecting + reportBatchFailures 汇总（不刷 N 条提示）。

  作用范围语义（与 useCanvasFilter 的 counts 对齐）：
    有显式选中 → 只作用于选中行；没有选中但有筛选 → 作用于筛选结果（整批）。
    这两个数字都写在状态行上，用户永远知道「这一下会改多少行」。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CanvasLine, Id, SpeedMark } from '@shared/types.ts'
import { CANVAS_DEFAULTS, EMOTIONS, SPEED_OPTIONS } from '@shared/constants.ts'
import { formatCount, formatPercent } from '@/shared/lib/format.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import { useCanvasStore, CANVAS_FLAG_OPTIONS } from '../stores/canvas.store.ts'
import { useCharactersStore } from '../stores/characters.store.ts'
import { useSpeakerAssign } from '../composables/useSpeakerAssign.ts'

const props = withDefaults(defineProps<{
  /** 作用范围内的行（有选中 = 选中行；无选中 = 筛选结果） */
  targets: CanvasLine[]
  /** 显式选中的行数（0 表示按筛选结果整批作用） */
  selectedCount?: number
  /** 筛选条件的人类可读摘要（useCanvasFilter.summary） */
  filterSummary?: string[]
  /** 是否处于「有筛选」状态 */
  filterActive?: boolean
  /** 只读（任务包模式 docs/11 §6.3） */
  readonly?: boolean
}>(), {
  selectedCount: 0,
  filterSummary: () => [],
  filterActive: false,
  readonly: false,
})

const emit = defineEmits<{
  /** 一次批量操作完成（父组件据此刷新状态栏 / 质检 / 队列） */
  applied: [summary: string]
  /** 请求清空选中 */
  'clear-selection': []
}>()

const canvas = useCanvasStore()
const characters = useCharactersStore()
const speaker = useSpeakerAssign()

/** 作用范围（一次批量最多会影响多少行） */
const scopeIds = computed<Id[]>(() => props.targets.map(line => line.id))
const scopeCount = computed(() => scopeIds.value.length)
const bySelection = computed(() => props.selectedCount > 0)
const scopeLabel = computed(() => (bySelection.value
  ? `已选 ${formatCount(props.selectedCount)} 行`
  : props.filterActive
    ? `筛选结果 ${formatCount(scopeCount.value)} 行`
    : `本章可见 ${formatCount(scopeCount.value)} 行`))

const scopeDetails = computed(() => {
  const details = [`作用范围：${scopeLabel.value}`]
  if (props.filterSummary.length) details.push(`筛选条件：${props.filterSummary.join(' · ')}`)
  else details.push('筛选条件：无（当前是全部可见行）')
  return details
})

// ── 表单态 ───────────────────────────────────────────────────────────────────
const speakerId = ref<Id | null>(null)

/**
 * 「旁白（无角色）」这个选项的绑定值。
 *
 * **运行时它就是 `null`** —— 本组件的逻辑用 `speakerId.value === null` 判断「旁白」
 * （见 askAssignSpeaker），语义不能改成 `''`。这里只是把类型收敛到 `el-option` 的
 * `value` prop 允许的范围内（它不接受 `null`）。断言放在脚本里而不是模板里：
 * 模板表达式按 JS 解析，写不了 TS 断言（见 package.json 的 template-types 说明）。
 */
const NARRATION_SPEAKER = null as unknown as Id
const emotion = ref<string | null>(null)
const speed = ref<SpeedMark | null>(null)
const pauseMs = ref<number>(CANVAS_DEFAULTS.defaultPauseAfterMs)
const flagToAdd = ref<string | null>(null)
const flagToRemove = ref<string | null>(null)

const emotionOptions = computed(() => [...EMOTIONS])
const characterOptions = computed(() => characters.activeCharacters)

// ── 执行器：统一「先确认、再执行、后汇总」────────────────────────────────────
interface PendingAction {
  title: string
  message: string
  details: string[]
  type: 'info' | 'warning' | 'danger'
  run: () => Promise<string>
}

const pending = ref<PendingAction | null>(null)
const confirmVisible = ref(false)
const busy = ref(false)
/** 最近一次批量结果（状态行显示，避免刷多条 toast） */
const lastResult = ref('')

function ask(action: PendingAction): void {
  if (props.readonly) {
    lastResult.value = '任务包模式下画本为只读，批量操作已禁用。'
    return
  }
  if (!scopeCount.value) {
    lastResult.value = '作用范围内没有行：先选中若干行，或用筛选条件缩小范围。'
    return
  }
  pending.value = action
  confirmVisible.value = true
}

async function onConfirm(): Promise<void> {
  const action = pending.value
  if (!action) return
  busy.value = true
  try {
    lastResult.value = await action.run()
    emit('applied', lastResult.value)
  } finally {
    busy.value = false
    confirmVisible.value = false
    pending.value = null
  }
}

function onCancel(): void {
  confirmVisible.value = false
  pending.value = null
}

/** 统一的「影响 N 行」明细行 */
function impact(count: number, extra: string[] = []): string[] {
  return [`将影响 ${formatCount(count)} 行`, ...extra, ...scopeDetails.value]
}

// ── 1. 批量指派说话人 ────────────────────────────────────────────────────────
function askAssignSpeaker(): void {
  if (speakerId.value === null) {
    lastResult.value = '先在左侧选择要指派的角色（或选「设为旁白」）。'
    return
  }
  const name = speakerId.value ? characters.nameOf(speakerId.value) : '旁白'
  ask({
    title: '批量指派说话人',
    message: `把 ${scopeLabel.value}的说话人统一改为「${name}」？`,
    details: impact(scopeCount.value, [
      '每行都会写入 decidedBy=human（人工确认），重算不会覆盖',
      'needsReview 会被清掉，这些行将从待确认队列移除',
    ]),
    type: 'warning',
    run: async () => {
      const result = await speaker.assignMany(props.targets, speakerId.value)
      return `批量指派「${name}」完成：已改 ${formatCount(result.assigned)} 行，跳过 ${formatCount(result.skipped)} 行（本来就一致）。`
    },
  })
}

function askAssignTopCandidate(): void {
  const withCandidate = props.targets.filter(line => (line.candidates ?? []).length > 0).length
  ask({
    title: '按候选第一位自动指派',
    message: `对 ${scopeLabel.value}逐行采用置信度最高的候选角色？`,
    details: impact(withCandidate, [
      `有候选的行：${formatCount(withCandidate)} 行（其余行会被跳过，不会乱改）`,
      '判定结果写入 decidedBy=human，之后重算不会覆盖；改错了可 Ctrl+Z 整批撤销',
    ]),
    type: 'warning',
    run: async () => {
      const result = await speaker.assignTopCandidate(props.targets)
      return `自动指派完成：已改 ${formatCount(result.assigned)} 行，跳过 ${formatCount(result.skipped)} 行（无候选）。建议接着打开待确认队列复查低置信行。`
    },
  })
}

// ── 2. 批量设置情绪 / 语速 / 停顿 ───────────────────────────────────────────
function askEmotion(): void {
  const label = emotion.value ?? '（清除）'
  ask({
    title: '批量设置情绪',
    message: `把 ${scopeLabel.value}的情绪统一设为「${label}」？`,
    details: impact(scopeCount.value, ['只改情绪标签，不动文本与说话人']),
    type: 'info',
    run: async () => {
      const ok = await canvas.applyBatchPatch(scopeIds.value, { emotion: emotion.value }, '批量设置情绪')
      return ok ? `批量设置情绪「${label}」完成：${formatCount(scopeCount.value)} 行。` : '批量设置情绪失败，改动仍在内存中（见顶部保存条），可重试或 Ctrl+Z。'
    },
  })
}

function askSpeed(): void {
  const label = SPEED_OPTIONS.find(o => o.value === speed.value)?.label ?? '（清除）'
  ask({
    title: '批量设置语速',
    message: `把 ${scopeLabel.value}的语速统一设为「${label}」？`,
    details: impact(scopeCount.value),
    type: 'info',
    run: async () => {
      const ok = await canvas.applyBatchPatch(scopeIds.value, { speed: speed.value }, '批量设置语速')
      return ok ? `批量设置语速「${label}」完成：${formatCount(scopeCount.value)} 行。` : '批量设置语速失败，改动仍在内存中，可重试或 Ctrl+Z。'
    },
  })
}

function askPause(): void {
  const value = Math.max(0, Math.round(pauseMs.value || 0))
  ask({
    title: '批量设置句末停顿',
    message: `把 ${scopeLabel.value}的句末留白统一设为 ${value} ms？`,
    details: impact(scopeCount.value, [
      `默认值 ${CANVAS_DEFAULTS.defaultPauseAfterMs} ms 来自 CANVAS_DEFAULTS；停顿是对轨直接消费的字段`,
    ]),
    type: 'info',
    run: async () => {
      const ok = await canvas.applyBatchPatch(scopeIds.value, { pauseAfterMs: value }, '批量设置停顿')
      return ok ? `批量设置停顿 ${value} ms 完成：${formatCount(scopeCount.value)} 行。` : '批量设置停顿失败，改动仍在内存中，可重试或 Ctrl+Z。'
    },
  })
}

// ── 3. 批量加 / 移除标记 ────────────────────────────────────────────────────
function askAddFlag(): void {
  const flag = flagToAdd.value
  if (!flag) {
    lastResult.value = '先选择要添加的标记。'
    return
  }
  ask({
    title: '批量添加标记',
    message: `给 ${scopeLabel.value}加上「${CANVAS_FLAG_OPTIONS.find(o => o.value === flag)?.label ?? flag}」标记？`,
    details: impact(scopeCount.value, ['已有该标记的行不会重复添加']),
    type: 'info',
    run: async () => {
      const ok = await canvas.addFlags(scopeIds.value, [flag], '批量添加标记')
      return ok ? `批量添加标记完成：${formatCount(scopeCount.value)} 行。` : '批量添加标记失败，可重试或 Ctrl+Z。'
    },
  })
}

function askRemoveFlag(): void {
  const flag = flagToRemove.value
  if (!flag) {
    lastResult.value = '先选择要移除的标记。'
    return
  }
  ask({
    title: '批量移除标记',
    message: `从 ${scopeLabel.value}移除「${CANVAS_FLAG_OPTIONS.find(o => o.value === flag)?.label ?? flag}」标记？`,
    details: impact(scopeCount.value, ['移除 deleted 标记即等于「恢复」被软删除的行']),
    type: 'info',
    run: async () => {
      const ok = await canvas.removeFlags(scopeIds.value, [flag], '批量移除标记')
      return ok ? `批量移除标记完成：${formatCount(scopeCount.value)} 行。` : '批量移除标记失败，可重试或 Ctrl+Z。'
    },
  })
}

// ── 4. 批量合并相邻旁白（合并后文本用句号连接）──────────────────────────────
function askMergeNarration(): void {
  const candidates = props.targets.filter(line =>
    line.kind === 'narration' && line.speakerType === 'narration' && !line.flags.includes('deleted'))
  ask({
    title: '合并相邻旁白行',
    message: `把 ${scopeLabel.value}中相邻的旁白行合并成一段？`,
    details: [
      `候选旁白行：${formatCount(candidates.length)} 行（可组成若干段）`,
      '合并后文本用句号连接，被并入的行打 deleted 软删除标记（不物理删除，撤销可完整还原）',
      ...scopeDetails.value,
    ],
    type: 'warning',
    run: async () => {
      const result = await canvas.mergeAdjacentNarration(scopeIds.value)
      if (!result.groups) return '没有可合并的相邻旁白：作用范围内至少要有两行连续的旁白行。'
      return `合并完成：${formatCount(result.groups)} 组，被并入 ${formatCount(result.merged)} 行（已软删除，可 Ctrl+Z 整批还原）。`
    },
  })
}

// ── 5. 锁定为人工确认（decidedBy='human'）──────────────────────────────────
function askLockHuman(): void {
  ask({
    title: '锁定为人工确认',
    message: `把 ${scopeLabel.value}标记为「人工确认」并锁定？`,
    details: impact(scopeCount.value, [
      '写入 decidedBy=human 并加 locked 标记：之后重算归属/重新生成都不会覆盖这些行',
    ]),
    type: 'warning',
    run: async () => {
      const ok = await canvas.lockHuman(scopeIds.value)
      return ok ? `已锁定 ${formatCount(scopeCount.value)} 行：重算不会再覆盖它们。` : '锁定失败，可重试或 Ctrl+Z。'
    },
  })
}

// ── 6. 软删除 / 恢复 ────────────────────────────────────────────────────────
function askDelete(): void {
  ask({
    title: '批量软删除',
    message: `删除 ${scopeLabel.value}？（软删除，不是物理删除）`,
    details: impact(scopeCount.value, [
      '软删除只打 deleted 标记：行与已录音片段都保留，随时可「恢复」',
      '软删除后不再显示在表格与剧本里（可在筛选里勾「含已删除」查看）',
    ]),
    type: 'danger',
    run: async () => {
      const ok = await canvas.setDeleted(scopeIds.value, true)
      return ok ? `已软删除 ${formatCount(scopeCount.value)} 行，可用「恢复」或 Ctrl+Z 撤回。` : '软删除失败，可重试或 Ctrl+Z。'
    },
  })
}

function askRestore(): void {
  ask({
    title: '批量恢复',
    message: `恢复 ${scopeLabel.value}中已软删除的行？`,
    details: impact(scopeCount.value, ['移除 deleted 标记，行重新出现在表格与剧本中']),
    type: 'info',
    run: async () => {
      const ok = await canvas.setDeleted(scopeIds.value, false)
      return ok ? `已恢复 ${formatCount(scopeCount.value)} 行。` : '恢复失败，可重试或 Ctrl+Z。'
    },
  })
}

/** 相对作用范围的旁白占比（提示为什么合并按钮可能是灰的） */
const narrationRatio = computed(() => {
  if (!scopeCount.value) return null
  const narration = props.targets.filter(l => l.kind === 'narration' && l.speakerType === 'narration').length
  return formatPercent(narration / scopeCount.value)
})

const undoHint = computed(() => (canvas.canUndo ? `Ctrl+Z 撤销「${canvas.undoLabel}」` : '暂时没有可撤销的批量操作'))
</script>

<template>
  <section class="ns-batch">
    <div class="ns-batch__scope">
      <span class="ns-batch__scope-label">批量操作</span>
      <el-tag size="small" :type="bySelection ? 'primary' : 'info'">{{ scopeLabel }}</el-tag>
      <span v-if="props.filterSummary.length" class="ns-batch__filter" :title="props.filterSummary.join(' · ')">
        筛选：{{ props.filterSummary.join(' · ') }}
      </span>
      <span v-if="narrationRatio" class="ns-batch__muted">旁白占比 {{ narrationRatio }}</span>
      <span class="ns-batch__grow" />
      <span class="ns-batch__muted">{{ undoHint }} · 撤销栈 {{ canvas.undoDepth }}/{{ canvas.undoCapacity }}</span>
      <el-button v-if="bySelection" size="small" text @click="emit('clear-selection')">清空选中</el-button>
    </div>

    <div class="ns-batch__rows">
      <!-- 1. 指派说话人 -->
      <div class="ns-batch__group">
        <span class="ns-batch__label">说话人</span>
        <el-select v-model="speakerId" size="small" clearable filterable placeholder="选择角色" class="ns-batch__select">
          <el-option :value="NARRATION_SPEAKER" label="旁白（无角色）" />
          <el-option v-for="character in characterOptions" :key="character.id" :value="character.id" :label="character.name" />
        </el-select>
        <el-button size="small" :disabled="props.readonly" @click="askAssignSpeaker">指派</el-button>
        <el-button size="small" type="primary" :disabled="props.readonly" @click="askAssignTopCandidate">
          按候选第一位自动指派
        </el-button>
      </div>

      <!-- 2. 情绪 / 语速 / 停顿 -->
      <div class="ns-batch__group">
        <span class="ns-batch__label">情绪</span>
        <el-select v-model="emotion" size="small" clearable placeholder="选择情绪" class="ns-batch__select">
          <el-option v-for="item in emotionOptions" :key="item" :value="item" :label="item" />
        </el-select>
        <el-button size="small" :disabled="props.readonly" @click="askEmotion">应用情绪</el-button>

        <span class="ns-batch__label">语速</span>
        <el-select v-model="speed" size="small" clearable placeholder="选择语速" class="ns-batch__select is-narrow">
          <el-option v-for="item in SPEED_OPTIONS" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
        <el-button size="small" :disabled="props.readonly" @click="askSpeed">应用语速</el-button>

        <span class="ns-batch__label">停顿</span>
        <el-input-number v-model="pauseMs" size="small" :min="0" :max="10000" :step="50" controls-position="right" class="ns-batch__number" />
        <span class="ns-batch__muted">ms</span>
        <el-button size="small" :disabled="props.readonly" @click="askPause">应用停顿</el-button>
      </div>

      <!-- 3. 标记 / 合并 / 锁定 / 删除 -->
      <div class="ns-batch__group">
        <span class="ns-batch__label">标记</span>
        <el-select v-model="flagToAdd" size="small" placeholder="添加标记" class="ns-batch__select">
          <el-option v-for="item in CANVAS_FLAG_OPTIONS" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
        <el-button size="small" :disabled="props.readonly" @click="askAddFlag">加</el-button>
        <el-select v-model="flagToRemove" size="small" placeholder="移除标记" class="ns-batch__select">
          <el-option v-for="item in CANVAS_FLAG_OPTIONS" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
        <el-button size="small" :disabled="props.readonly" @click="askRemoveFlag">移除</el-button>

        <el-button size="small" :disabled="props.readonly" @click="askMergeNarration">合并相邻旁白</el-button>
        <el-button size="small" :disabled="props.readonly" @click="askLockHuman">锁定为人工确认</el-button>
        <el-button size="small" type="danger" plain :disabled="props.readonly" @click="askDelete">软删除</el-button>
        <el-button size="small" :disabled="props.readonly" @click="askRestore">恢复</el-button>
      </div>
    </div>

    <footer class="ns-batch__foot">
      <span v-if="lastResult" class="ns-batch__result">{{ lastResult }}</span>
      <span v-else class="ns-batch__muted">
        每一项都会先确认影响行数；整批提交为一个事务，撤销时一次退掉整批。
      </span>
    </footer>

    <ConfirmDialog
      v-model="confirmVisible"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :details="pending?.details ?? []"
      :type="pending?.type ?? 'warning'"
      :loading="busy"
      confirm-text="执行"
      @confirm="onConfirm"
      @cancel="onCancel"
    />
  </section>
</template>

<style scoped>
.ns-batch { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--ns-border-light, #e4e7ed); background: var(--ns-bg-subtle, #fafafa); }
.ns-batch__scope { display: flex; align-items: center; gap: 6px; }
.ns-batch__scope-label { color: var(--ns-text-primary, #303133); font-size: 12px; font-weight: 600; }
.ns-batch__filter { max-width: 320px; overflow: hidden; color: var(--ns-text-secondary, #909399); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.ns-batch__grow { flex: 1; }
.ns-batch__muted { color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-batch__rows { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.ns-batch__group { display: flex; align-items: center; gap: 4px; }
.ns-batch__label { color: var(--ns-text-regular, #606266); font-size: 11px; }
.ns-batch__select { width: 132px; }
.ns-batch__select.is-narrow { width: 92px; }
.ns-batch__number { width: 108px; }
.ns-batch__foot { display: flex; align-items: center; min-height: 18px; }
.ns-batch__result { color: var(--ns-success, #67c23a); font-size: 11px; }
</style>
