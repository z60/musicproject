<!--
  Novel Studio · 画本质检问题面板（docs/11 §5「画本质检 FR-2.4.8」）
  ============================================================================
  设计依据：
    · docs/11 §5 —— 问题按类型分组、点击跳转到对应行；「一键修复」仅限安全项
      （no_pause 补默认停顿、missing_pronunciation 用多音字字典建议），其余交人工。
    · docs/13 §5 —— 提供「一条一条处理」引导模式：↑/↓ 移动、Enter 处理、S 跳过、F 修复、Esc 退出。
    · docs/13 §5 —— 无问题时给正反馈（EmptyState），不是一片空白。

  分工：问题数据与写动作全部走 canvas.store（issues / loadIssueList / autoFixIssue），
  本组件不调 IPC、不弹提示；真正的失败由 store 内部的 error-bus 兑现，
  这里只维护「引导模式进度」这类纯 UI 状态。
-->

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Id, QualityIssue, QualityIssueKind } from '@shared/types.ts'
import { formatCount } from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import { useCanvasStore } from '../stores/canvas.store.ts'

const props = withDefaults(defineProps<{
  /** 面板是否可见（可见时引导模式才接管键盘，避免与表格抢键） */
  active?: boolean
  /** 只读（任务包模式 docs/11 §6.3）：只能看与跳转，不能修复 */
  readonly?: boolean
}>(), { active: true, readonly: false })

const emit = defineEmits<{
  /** 跳到并选中某一行（父组件负责滚动与高亮） */
  'focus-line': [lineId: Id]
  /** 请求打开单行编辑抽屉（Enter「处理」） */
  open: [lineId: Id]
  /** 请求关闭面板 */
  close: []
  /** 问题被改动（一键修复后父组件刷新状态栏） */
  changed: []
}>()

const canvas = useCanvasStore()

// ── 问题类型元信息（docs/11 §5 的 12 类；顺序 = 面板展示顺序 = 建议处理优先级）────
const ISSUE_META: Array<{ kind: QualityIssueKind; label: string; hint: string }> = [
  { kind: 'empty_text', label: '空文本', hint: '这一行没有可录文本，补上内容或软删除该行。' },
  { kind: 'quote_unmatched', label: '引号不配对', hint: '原文引号缺失或嵌套，切句可能把旁白与台词切错。' },
  { kind: 'unassigned', label: '未分配说话人', hint: '台词没有角色，去待确认队列按 1/2/3 逐条过最快。' },
  { kind: 'suspicious_speaker', label: '归属可疑', hint: '置信度低于 0.5 且非人工确认，需要人工判断。' },
  { kind: 'narration_run', label: '连续旁白过长', hint: '连续多行旁白（默认阈值 15），可能漏判了对白。' },
  { kind: 'dialogue_run', label: '连续对白过长', hint: '同一角色连续多行（默认阈值 20），可能是旁白被误判。' },
  { kind: 'too_long', label: '文本过长', hint: '超过单行字数上限，建议拆成两行，否则一口气念不完。' },
  { kind: 'no_pause', label: '缺少停顿', hint: '相邻同角色行停顿为 0 会粘连，可一键补默认停顿。' },
  { kind: 'missing_pronunciation', label: '缺少发音提示', hint: '命中多音字表但没写提示，可一键填入字典建议。' },
  { kind: 'duplicate_text', label: '重复文本', hint: '相邻两行文本完全相同，多为切句或误粘贴造成。' },
  { kind: 'no_character_ref', label: '角色未被引用', hint: '角色表里有这个角色，但本章没有它的台词。' },
  { kind: 'recorded_missing', label: '录音文件缺失', hint: '已标记为已录，但片段文件不在，需要重录。' },
]

const META = new Map(ISSUE_META.map((item, index) => [item.kind, { ...item, order: index }]))
const labelOf = (kind: QualityIssueKind): string => META.get(kind)?.label ?? kind
const hintOf = (kind: QualityIssueKind): string => META.get(kind)?.hint ?? ''
const orderOf = (kind: QualityIssueKind): number => META.get(kind)?.order ?? 99

// ── 分组 ─────────────────────────────────────────────────────────────────────
/** 排序：先按类型优先级、同类按行号（同类问题从上往下处理最省心） */
const sorted = computed<QualityIssue[]>(() => [...canvas.issues].sort((a, b) =>
  orderOf(a.kind) - orderOf(b.kind) || (a.seq ?? 0) - (b.seq ?? 0)))

interface IssueGroup {
  kind: QualityIssueKind
  label: string
  hint: string
  items: QualityIssue[]
  autoFixableCount: number
}

const groups = computed<IssueGroup[]>(() => {
  const map = new Map<QualityIssueKind, QualityIssue[]>()
  for (const issue of sorted.value) map.set(issue.kind, [...(map.get(issue.kind) ?? []), issue])
  return [...map.entries()]
    .map(([kind, items]) => ({
      kind,
      label: labelOf(kind),
      hint: hintOf(kind),
      items,
      autoFixableCount: items.filter(i => i.autoFixable && i.lineId).length,
    }))
    .sort((a, b) => orderOf(a.kind) - orderOf(b.kind))
})

const total = computed(() => canvas.issues.length)
const autoFixableTotal = computed(() => canvas.issues.filter(i => i.autoFixable && i.lineId).length)
/** 无行号的问题（如 no_character_ref 是角色维度的）无法跳转，单独提示 */
const noLineCount = computed(() => canvas.issues.filter(i => !i.lineId).length)

const collapsed = ref<Set<QualityIssueKind>>(new Set())
const isCollapsed = (kind: QualityIssueKind): boolean => collapsed.value.has(kind)

function toggleGroup(kind: QualityIssueKind): void {
  const next = new Set(collapsed.value)
  next.has(kind) ? next.delete(kind) : next.add(kind)
  collapsed.value = next
}

// ── 一键修复（安全项判定在 store 内部）────────────────────────────────────────
const fixingKind = ref<QualityIssueKind | null>(null)
const fixHint = ref('')

async function fixOne(issue: QualityIssue): Promise<boolean> {
  if (props.readonly) {
    fixHint.value = '任务包模式下画本为只读，不能修改。'
    return false
  }
  if (!issue.autoFixable || !issue.lineId) {
    // 不是错误，是「这类问题按设计就不自动改」——把原因说清楚，别让用户以为按钮坏了
    fixHint.value = `「${labelOf(issue.kind)}」按设计不自动修复：${hintOf(issue.kind)}`
    return false
  }
  const ok = await canvas.autoFixIssue(issue)
  fixHint.value = ok
    ? `已修复 #${issue.seq ?? '?'} 的「${labelOf(issue.kind)}」，可以 Ctrl+Z 撤销。`
    : `#${issue.seq ?? '?'} 的「${labelOf(issue.kind)}」未能自动修复，请手工处理（可能是缺发音建议或行已不存在）。`
  if (ok) emit('changed')
  return ok
}

async function fixGroup(group: IssueGroup): Promise<void> {
  if (props.readonly) {
    fixHint.value = '任务包模式下画本为只读，不能修改。'
    return
  }
  const targets = group.items.filter(i => i.autoFixable && i.lineId)
  if (!targets.length) {
    fixHint.value = `「${group.label}」没有可自动修复的条目。`
    return
  }
  fixingKind.value = group.kind
  fixHint.value = ''
  let ok = 0
  try {
    // 逐条走 store 的安全修复（每条都是一次 commitFields，可整批撤销）
    for (const issue of targets) if (await canvas.autoFixIssue(issue)) ok += 1
    fixHint.value = `「${group.label}」共 ${formatCount(targets.length)} 条，已修复 ${formatCount(ok)} 条。`
    if (ok > 0) emit('changed')
  } finally {
    fixingKind.value = null
  }
}

// ── 跳转 ─────────────────────────────────────────────────────────────────────
function jumpTo(issue: QualityIssue, openDrawer = false): void {
  if (!issue.lineId) {
    fixHint.value = `「${labelOf(issue.kind)}」是角色维度的问题，没有对应的单行，请在角色表里处理。`
    return
  }
  emit('focus-line', issue.lineId)
  if (openDrawer) emit('open', issue.lineId)
}

// ── 引导模式（docs/13 §5「一条一条处理」）─────────────────────────────────────
const guideMode = ref(false)
const guideIndex = ref(0)
const showSkipped = ref(false)
/** 本轮已处理 / 已跳过的行（纯 UI 状态，不改数据；跳过的只是本轮不再出现） */
const handledIds = ref<Set<Id>>(new Set())
const skippedIds = ref<Set<Id>>(new Set())
const bodyRef = ref<HTMLElement | null>(null)

const guideList = computed<QualityIssue[]>(() =>
  sorted.value.filter(issue => showSkipped.value || !(issue.lineId && skippedIds.value.has(issue.lineId))))
const guideCurrent = computed<QualityIssue | null>(() => guideList.value[guideIndex.value] ?? null)
const guideDone = computed(() => guideList.value.length > 0 && guideIndex.value >= guideList.value.length)

function startGuide(): void {
  guideMode.value = true
  guideIndex.value = 0
  handledIds.value = new Set()
  skippedIds.value = new Set()
  fixHint.value = ''
  void scrollGuideIntoView()
}

function stopGuide(): void {
  guideMode.value = false
  fixHint.value = ''
}

async function scrollGuideIntoView(): Promise<void> {
  await nextTick()
  bodyRef.value?.querySelector('.ns-issues__item.is-guide-current')?.scrollIntoView({ block: 'center' })
}

function moveGuide(delta: number): void {
  const next = Math.min(Math.max(0, guideIndex.value + delta), guideList.value.length)
  if (next === guideIndex.value) return
  guideIndex.value = next
  const issue = guideList.value[next]
  if (issue) jumpTo(issue)
  void scrollGuideIntoView()
}

function markCurrentHandled(withDrawer: boolean): void {
  const issue = guideCurrent.value
  if (!issue) return
  if (issue.lineId) handledIds.value = new Set(handledIds.value).add(issue.lineId)
  jumpTo(issue, withDrawer)
  moveGuide(1)
}

function skipCurrent(): void {
  const issue = guideCurrent.value
  if (!issue) return
  if (issue.lineId) skippedIds.value = new Set(skippedIds.value).add(issue.lineId)
  moveGuide(1)
}

async function fixCurrent(): Promise<void> {
  const issue = guideCurrent.value
  if (!issue) return
  const ok = await fixOne(issue)
  if (ok) {
    if (issue.lineId) handledIds.value = new Set(handledIds.value).add(issue.lineId)
    moveGuide(1)
  }
}

const isHandled = (issue: QualityIssue): boolean => Boolean(issue.lineId && handledIds.value.has(issue.lineId))
const isSkipped = (issue: QualityIssue): boolean => Boolean(issue.lineId && skippedIds.value.has(issue.lineId))

/** 引导模式接管键盘（输入框里一律不抢键，与 useCanvasKeyboard 的约定一致） */
function onKeydown(event: KeyboardEvent): void {
  if (!props.active || !guideMode.value) return
  const target = event.target as HTMLElement | null
  const tag = target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return

  if (event.key === 'ArrowDown') { event.preventDefault(); moveGuide(1); return }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveGuide(-1); return }
  if (event.key === 'Escape') { event.preventDefault(); stopGuide(); return }
  const issue = guideCurrent.value
  if (!issue) return
  const key = event.key.toLowerCase()
  if (event.key === 'Enter') { event.preventDefault(); markCurrentHandled(true); return }
  if (key === 's') { event.preventDefault(); skipCurrent(); return }
  if (key === 'f') { event.preventDefault(); void fixCurrent() }
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────
async function refresh(): Promise<void> {
  if (!canvas.chapterId || canvas.issuesLoading) return
  await canvas.loadIssueList()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void refresh()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// 面板重新可见时刷新（画本被改过之后问题列表会变）
watch(() => props.active, visible => { if (visible) void refresh() })

// 换章后 store 已重新拉过问题，这里只重置引导进度
watch(() => canvas.chapterId, () => {
  guideIndex.value = 0
  handledIds.value = new Set()
  skippedIds.value = new Set()
  fixHint.value = ''
})

defineExpose({ refresh })
</script>

<template>
  <section class="ns-issues">
    <header class="ns-issues__head">
      <span class="ns-issues__title">质检问题</span>
      <el-tag v-if="total" size="small" type="warning">{{ formatCount(total) }} 条</el-tag>
      <el-tag v-else size="small" type="success">干净</el-tag>
      <span class="ns-issues__grow" />
      <el-button size="small" :disabled="canvas.issuesLoading" @click="refresh">重新检查</el-button>
      <el-button v-if="!guideMode" size="small" type="primary" :disabled="!total" @click="startGuide">一条一条处理</el-button>
      <el-button v-else size="small" @click="stopGuide">退出处理模式</el-button>
      <el-button size="small" text @click="emit('close')">关闭</el-button>
    </header>

    <div v-if="guideMode" class="ns-issues__guide">
      <div class="ns-issues__guide-bar">
        <span>
          第 {{ Math.min(guideIndex + 1, guideList.length) }} / {{ formatCount(guideList.length) }} 条 ·
          已处理 {{ formatCount(handledIds.size) }} · 已跳过 {{ formatCount(skippedIds.size) }}
        </span>
        <el-switch v-model="showSkipped" size="small" active-text="显示已跳过" />
      </div>
      <p class="ns-issues__hint">
        键盘：<b>↑ / ↓</b> 移动 · <b>Enter</b> 处理（跳到该行并打开抽屉） · <b>S</b> 跳过 ·
        <b>F</b> 一键修复 · <b>Esc</b> 退出
      </p>
      <p v-if="guideDone" class="ns-issues__done">
        本轮问题已全部过完。建议点「重新检查」确认是否真的清了，再退出处理模式看分组列表。
      </p>
    </div>

    <div ref="bodyRef" class="ns-issues__body">
      <LoadingBlock v-if="canvas.issuesLoading && !total" text="正在质检…" />

      <EmptyState
        v-else-if="!total"
        size="small"
        icon="✅"
        title="没有发现问题"
        description="空文本、过长、未分配、引号不配对、连续旁白、缺停顿、多音字等 12 项检查都已通过。"
        hint="质检只覆盖可自动判断的项；建议再用「待确认队列」过一遍低置信行，然后就可以去录音了。"
      />

      <div v-else class="ns-issues__groups">
        <div class="ns-issues__toolbar">
          <el-button size="small" text @click="collapsed = new Set()">全部展开</el-button>
          <el-button size="small" text @click="collapsed = new Set(groups.map(g => g.kind))">全部折叠</el-button>
          <span class="ns-issues__muted">
            可一键修复 {{ formatCount(autoFixableTotal) }} 条
            <template v-if="noLineCount"> · {{ formatCount(noLineCount) }} 条无对应行</template>
          </span>
        </div>

        <article v-for="group in groups" :key="group.kind" class="ns-issues__group">
          <header class="ns-issues__group-head" @click="toggleGroup(group.kind)">
            <span class="ns-issues__caret">{{ isCollapsed(group.kind) ? '▸' : '▾' }}</span>
            <span class="ns-issues__group-title">{{ group.label }}</span>
            <el-tag size="small" type="info">{{ formatCount(group.items.length) }}</el-tag>
            <el-tag v-if="group.autoFixableCount" size="small" type="success">可修复 {{ formatCount(group.autoFixableCount) }}</el-tag>
            <span class="ns-issues__grow" />
            <el-button
              v-if="group.autoFixableCount && !props.readonly"
              size="small"
              :loading="fixingKind === group.kind"
              @click.stop="fixGroup(group)"
            >
              一键修复这一类
            </el-button>
          </header>

          <p v-if="!isCollapsed(group.kind)" class="ns-issues__hint ns-issues__group-hint">{{ group.hint }}</p>

          <ul v-if="!isCollapsed(group.kind)" class="ns-issues__list">
            <li
              v-for="issue in group.items"
              :key="`${issue.kind}-${issue.lineId ?? issue.seq ?? issue.message}`"
              class="ns-issues__item"
              :class="{
                'is-guide-current': guideMode && guideCurrent === issue,
                'is-handled': isHandled(issue),
                'is-skipped': isSkipped(issue),
                'is-noline': !issue.lineId,
              }"
              @click="jumpTo(issue)"
            >
              <span class="ns-issues__seq">{{ issue.seq === null ? '—' : `#${issue.seq}` }}</span>
              <span class="ns-issues__message">{{ issue.message }}</span>
              <el-tag v-if="issue.autoFixable" size="small" type="success" effect="plain">可修复</el-tag>
              <el-tag v-else size="small" type="info" effect="plain">需人工</el-tag>
              <el-button
                v-if="issue.autoFixable && issue.lineId && !props.readonly"
                size="small"
                text
                @click.stop="fixOne(issue)"
              >
                修复
              </el-button>
              <el-button v-if="issue.lineId" size="small" text @click.stop="jumpTo(issue, true)">编辑</el-button>
            </li>
          </ul>
        </article>
      </div>
    </div>

    <footer v-if="fixHint" class="ns-issues__foot">{{ fixHint }}</footer>
  </section>
</template>

<style scoped>
.ns-issues { display: flex; flex-direction: column; height: 100%; min-height: 0; border-left: 1px solid var(--ns-border-light, #e4e7ed); background: var(--ns-bg, #fff); }
.ns-issues__head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--ns-border-light, #e4e7ed); background: var(--ns-bg-subtle, #fafafa); }
.ns-issues__title { color: var(--ns-text-primary, #303133); font-size: 13px; font-weight: 600; }
.ns-issues__grow { flex: 1; }
.ns-issues__guide { padding: 6px 8px; border-bottom: 1px dashed var(--ns-border-light, #e4e7ed); background: rgb(64 158 255 / 6%); }
.ns-issues__guide-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ns-text-regular, #606266); font-size: 12px; }
.ns-issues__hint { margin: 4px 0 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.6; }
.ns-issues__done { margin: 4px 0 0; color: var(--ns-success, #67c23a); font-size: 11px; }
.ns-issues__body { flex: 1; min-height: 0; padding: 8px; overflow: auto; }
.ns-issues__toolbar { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.ns-issues__muted { color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-issues__group { margin-bottom: 10px; }
.ns-issues__group-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; background: var(--ns-fill-light, #f5f7fa); cursor: pointer; }
.ns-issues__caret { color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-issues__group-title { color: var(--ns-text-primary, #303133); font-size: 12px; font-weight: 600; }
.ns-issues__group-hint { margin-left: 16px; }
.ns-issues__list { margin: 0; padding: 0; list-style: none; }
.ns-issues__item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-left: 2px solid transparent; border-radius: 3px; cursor: pointer; }
.ns-issues__item:hover { background: var(--ns-fill-light, #f5f7fa); }
.ns-issues__item.is-guide-current { border-left-color: var(--ns-primary, #409eff); background: rgb(64 158 255 / 12%); }
.ns-issues__item.is-handled { opacity: 0.55; text-decoration: line-through; }
.ns-issues__item.is-skipped { opacity: 0.45; }
.ns-issues__item.is-noline { cursor: default; }
.ns-issues__seq { flex: 0 0 42px; color: var(--ns-text-placeholder, #c0c4cc); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.ns-issues__message { flex: 1; color: var(--ns-text-regular, #606266); font-size: 12px; word-break: break-word; }
.ns-issues__foot { padding: 6px 8px; border-top: 1px solid var(--ns-border-light, #e4e7ed); color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.6; }
</style>
