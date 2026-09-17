<!--
  Novel Studio · 校验报告面板（docs/13 §5）
  ============================================================================
  设计依据：
    · docs/13 §5 —— 校验报告 UI 的三条硬要求：
        1. **按类型分组**（`AlignIssueKind` 11 类），分组顺序稳定（用户才记得住）；
        2. 点击某条 → **跳到时间线对应位置并选中**；
        3. **「一条一条处理」引导模式**（类似待确认队列）。
    · docs/13 §5 —— `wrong_order`（轨内顺序与画本顺序相反）值得单独说：它几乎一定
      是**错绑**（把第 50 行录的内容绑到了第 20 行）。因此它单独置顶、单独高亮，
      并给一个直达「录制对齐」页的入口。
    · docs/13 §5 / docs/10 §7.2 —— 无问题时必须给**正反馈**（「校验通过」），
      而不是一片空白：用户需要确认「我确实校验过了，且没问题」。

  职责边界：本组件不做判据（判据在主进程 shared/arrange/validate.ts），
  也**不自己编错误文案**（`row.message` 一律取自主进程 / validation store），
  只负责组织、跳转与引导节奏。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Id } from '@shared/types.ts'
import { isEditableTarget, matchEvent } from '@/shared/lib/shortcuts.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useValidationStore } from '../stores/validation.store.ts'
import type { IssueSeverity, ValidationIssueRow } from '../stores/validation.store.ts'

const props = withDefaults(defineProps<{
  /** 当前方案 id（重新校验要用）；null = 还没选方案 */
  arrangementId?: Id | null
  /** 是否显示「重新校验」按钮（MatchReviewView 里可能不需要） */
  showValidateButton?: boolean
}>(), {
  arrangementId: null,
  showValidateButton: true,
})

const emit = defineEmits<{
  /** 跳转并选中（视图负责居中滚动 + 选中 item） */
  focus: [row: ValidationIssueRow]
  /** 引导模式下按 Enter「处理」：由视图决定打开哪个工具（消解重叠 / 跳到画本行 / 去录音） */
  handle: [row: ValidationIssueRow]
  /** 去「录制对齐」页处理错绑（wrong_order 的主场） */
  'open-matcher': []
  /** 去消解同轨重叠（OverlapResolver） */
  'open-overlaps': []
}>()

const validation = useValidationStore()

/** 引导模式的键盘容器（必须聚焦才收得到键，见 panel ref） */
const panel = ref<HTMLElement | null>(null)

const busy = computed(() => validation.loading)
const hasResult = computed(() => validation.hasResult)
const clean = computed(() => validation.clean)

/** 分组：wrong_order 单独抽出来置顶（其余按 store 给的稳定顺序） */
const wrongOrderGroup = computed(() => validation.groups.find(g => g.kind === 'wrong_order') ?? null)
const otherGroups = computed(() => validation.groups.filter(g => g.kind !== 'wrong_order'))

const currentRow = computed(() => validation.currentGuideRow)

const severityTag = (severity: IssueSeverity): 'danger' | 'warning' | 'info' => {
  if (severity === 'blocking') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'info'
}

const summaryText = computed(() => {
  if (!hasResult.value) return '还没有校验结果'
  if (clean.value) return '校验通过：未发现问题'
  return `共 ${validation.totalCount} 项（必修 ${validation.blockingCount}）`
})

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function runValidate(): Promise<void> {
  if (!props.arrangementId) return
  await validation.validate(props.arrangementId)
}

function focusRow(row: ValidationIssueRow): void {
  validation.focusRow(row.key)
  emit('focus', row)
}

/** 引导模式的「处理」：不同 kind 交回视图走不同工具（组件不该知道路由与面板） */
function handleRow(row: ValidationIssueRow): void {
  emit('handle', row)
  // 处理完自动前进到下一项（同类问题通常连着好几条）
  validation.next()
}

function handleCurrent(): void {
  const row = currentRow.value
  if (!row) return
  handleRow(row)
}

function startGuide(): void {
  validation.startGuide()
  // 引导模式要能收键盘：聚焦容器（不聚焦的话 ↑/↓/Enter/S 都不会到组件）
  requestAnimationFrame(() => panel.value?.focus())
}

function stopGuide(): void {
  validation.stopGuide()
}

function onKeydown(event: KeyboardEvent): void {
  if (!validation.guideActive) return
  if (isEditableTarget(event.target)) return

  if (matchEvent(event, 'ArrowUp')) {
    validation.prev()
  } else if (matchEvent(event, 'ArrowDown')) {
    validation.next()
  } else if (matchEvent(event, 'Enter')) {
    handleCurrent()
  } else if (matchEvent(event, 's')) {
    validation.skipCurrent()
  } else if (matchEvent(event, 'Escape')) {
    stopGuide()
  } else {
    return
  }
  event.preventDefault()
  event.stopPropagation()
}

/** 引导队列变空（例如全部跳过）时自动退出，避免停在「0/0」上 */
watch(
  () => validation.guideQueue.length,
  (len) => {
    if (validation.guideActive && len === 0) validation.stopGuide()
  },
)

onBeforeUnmount(() => {
  stopGuide()
})
</script>

<template>
  <div
    ref="panel"
    class="ns-validation"
    :tabindex="validation.guideActive ? 0 : -1"
    @keydown="onKeydown"
  >
    <header class="ns-validation__head">
      <h3 class="ns-validation__title">校验报告</h3>
      <el-tag size="small" :type="clean ? 'success' : hasResult ? 'warning' : 'info'">
        {{ summaryText }}
      </el-tag>
      <div class="ns-validation__head-actions">
        <el-button
          v-if="showValidateButton"
          size="small"
          :loading="busy"
          :disabled="!arrangementId"
          @click="runValidate"
        >
          重新校验
        </el-button>
        <el-button
          v-if="hasResult && !clean && !validation.guideActive"
          size="small"
          type="primary"
          @click="startGuide"
        >
          一条一条处理
        </el-button>
        <el-button v-if="validation.guideActive" size="small" @click="stopGuide">退出引导</el-button>
      </div>
    </header>

    <!-- 加载中 -->
    <LoadingBlock v-if="busy" text="正在校验…" min-height="72px" />

    <!-- 未校验 -->
    <EmptyState
      v-else-if="!hasResult"
      icon="✅"
      size="small"
      title="还没有校验结果"
      description="校验会检查缺录、孤儿片段、同轨重叠、过长静音、静音/削波片段与顺序错绑。"
      hint="也可以直接点顶部的「校验」按钮。"
    />

    <!-- 无问题：正反馈（docs/13 §5） -->
    <EmptyState
      v-else-if="clean"
      icon="🎉"
      size="small"
      title="校验通过，可以进入混音/导出了"
      :description="`总时长 ${validation.result ? Math.round(validation.result.totalDurationMs / 1000) : 0} 秒，未发现阻断项。`"
      hint="改动过时间线后请再校验一次。"
    />

    <template v-else>
      <!-- 引导模式条：当前项 + 进度 + 键盘提示 -->
      <div v-if="validation.guideActive" class="ns-validation__guide">
        <div class="ns-validation__guide-row">
          <span class="ns-validation__guide-index">
            {{ validation.guideProgress.index }} / {{ validation.guideProgress.total }}
            （已跳过 {{ validation.guideProgress.skipped }}）
          </span>
          <span v-if="currentRow" class="ns-validation__guide-label">{{ currentRow.label }}</span>
        </div>
        <p v-if="currentRow" class="ns-validation__guide-msg">{{ currentRow.message }}</p>
        <div class="ns-validation__guide-actions">
          <el-button size="small" @click="validation.prev">上一项 ↑</el-button>
          <el-button size="small" @click="validation.next">下一项 ↓</el-button>
          <el-button size="small" type="primary" :disabled="!currentRow" @click="handleCurrent">处理 Enter</el-button>
          <el-button size="small" @click="validation.skipCurrent">跳过 S</el-button>
          <el-button size="small" text @click="validation.unskipAll">取消全部跳过</el-button>
        </div>
        <p class="ns-validation__guide-hint">
          键盘：↑/↓ 切换 · Enter 处理并前进 · S 跳过（沉到队尾，不会消失）· Esc 退出。
        </p>
      </div>

      <!-- wrong_order：最高优先级，单独置顶并解释为什么危险（docs/13 §5） -->
      <section v-if="wrongOrderGroup" class="ns-validation__group ns-validation__group--alert">
        <el-alert
          type="error"
          :closable="false"
          show-icon
          title="顺序颠倒（疑似错绑）"
          description="某轨的片段时间顺序与画本顺序相反，几乎一定是把某一行的录音绑到了另一行；请先去「录制对齐」核对绑定关系，再回来重跑自动对轨。"
        />
        <div class="ns-validation__group-actions">
          <el-button size="small" type="danger" @click="emit('open-matcher')">去录制对齐核对绑定</el-button>
        </div>
        <ul class="ns-validation__rows">
          <li
            v-for="row in wrongOrderGroup.rows"
            :key="row.key"
            class="ns-validation__row"
            :class="{ 'is-current': validation.guideActive && currentRow?.key === row.key, 'is-skipped': validation.isSkipped(row.key) }"
            @click="focusRow(row)"
          >
            <span class="ns-validation__row-seq">#{{ row.lineSeq ?? '—' }}</span>
            <span class="ns-validation__row-msg">{{ row.message }}</span>
          </li>
        </ul>
      </section>

      <!-- 其余分组：折叠面板，点一条就跳过去 -->
      <el-collapse class="ns-validation__groups">
        <el-collapse-item
          v-for="group in otherGroups"
          :key="group.kind"
          :name="group.kind"
        >
          <template #title>
            <span class="ns-validation__group-title">
              <el-tag size="small" :type="severityTag(group.severity)">{{ group.rows.length }}</el-tag>
              <span>{{ group.label }}</span>
            </span>
          </template>
          <ul class="ns-validation__rows">
            <li
              v-for="row in group.rows"
              :key="row.key"
              class="ns-validation__row"
              :class="{ 'is-current': validation.guideActive && currentRow?.key === row.key, 'is-skipped': validation.isSkipped(row.key) }"
              @click="focusRow(row)"
            >
              <span class="ns-validation__row-seq">#{{ row.lineSeq ?? '—' }}</span>
              <span class="ns-validation__row-msg">{{ row.message }}</span>
              <el-tag v-if="row.blocking" size="small" type="danger">必修</el-tag>
            </li>
          </ul>
          <!-- 同轨重叠分组：直达消解面板 -->
          <div v-if="group.kind === 'same_track_overlap'" class="ns-validation__group-actions">
            <el-button size="small" @click.stop="emit('open-overlaps')">打开重叠消解</el-button>
          </div>
        </el-collapse-item>
      </el-collapse>
    </template>
  </div>
</template>

<style scoped>
.ns-validation {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
  font-size: 12px;
  outline: none;
}
.ns-validation__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ns-validation__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-validation__head-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.ns-validation__guide {
  padding: 8px;
  border: 1px solid var(--ns-primary, #409eff);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ns-primary, #409eff) 6%, var(--ns-bg, #fff));
}
.ns-validation__guide-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-validation__guide-index {
  color: var(--ns-text-regular, #606266);
  font-variant-numeric: tabular-nums;
}
.ns-validation__guide-label {
  color: var(--ns-text-primary, #303133);
  font-weight: 600;
}
.ns-validation__guide-msg {
  margin: 6px 0;
  color: var(--ns-text-regular, #606266);
  line-height: 1.6;
}
.ns-validation__guide-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ns-validation__guide-hint {
  margin: 6px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-validation__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-validation__group--alert {
  padding: 8px;
  border: 1px solid var(--ns-danger, #f56c6c);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ns-danger, #f56c6c) 5%, var(--ns-bg, #fff));
}
.ns-validation__group-actions {
  display: flex;
  gap: 6px;
}
.ns-validation__group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ns-text-regular, #606266);
}
.ns-validation__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ns-validation__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.ns-validation__row:hover {
  background: var(--ns-bg-subtle, #f5f7fa);
}
.ns-validation__row.is-current {
  background: color-mix(in srgb, var(--ns-primary, #409eff) 12%, var(--ns-bg, #fff));
  box-shadow: inset 2px 0 0 var(--ns-primary, #409eff);
}
.ns-validation__row.is-skipped {
  opacity: 0.55;
}
.ns-validation__row-seq {
  flex: 0 0 auto;
  width: 44px;
  color: var(--ns-text-secondary, #909399);
  font-variant-numeric: tabular-nums;
}
.ns-validation__row-msg {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
