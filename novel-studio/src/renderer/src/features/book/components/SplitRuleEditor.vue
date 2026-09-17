<!--
  书籍导入域 · 分章规则编辑器（docs/10 §6 分章 / §7.1 Step 3）
  ============================================================================
  设计依据：
    · docs/10 §6.1 —— 规则集结构（patterns 的 linePattern / maxLineLength /
      requireBlankAround / titleGroup / kind）
    · docs/10 §6.2 —— 内置规则集默认开启；勾选/取消勾选要立刻看到「切出 N 章」
    · docs/10 §6.3 —— 宁可漏切不可错切：maxLineLength 与 requireBlankAround 是防误切的
      两个旋钮，界面上要写清它们的意图，否则用户会把它们当噪音
    · docs/10 §6.4 —— 无匹配时的备选策略（空行分块 / 长度均分 / 整本一章 / 自动）
    · docs/10 §6.5 —— 自定义正则：客户端先做预检（validateLinePatternLocal），
      权威实现是主进程的 validateLinePattern；危险正则（回溯爆炸）必须在输入时就提示
    · docs/10 §7.1 —— 规则改动后「实时预览」；本组件只发 changed / recalc，
      300 ms 防抖由父视图的 useImportFlow.schedulePreview 统一负责
      （组件里再防抖一次会让一次改动触发两遍解析，反而更慢）

  契约说明：`book:previewSplit` 只接受规则集 **id**，所以改动必须先落库
  （store.ensureRuleSetPersisted 会在重算前自动做这件事，界面用 notice/dirty 显示状态）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ENCODING_CANDIDATES } from '@shared/constants.ts'
import type { ChapterKind, ChapterRule, ChapterRuleSet } from '@shared/types.ts'
import { formatCount, formatInt } from '@/shared/lib/format.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import {
  FALLBACK_LABELS,
  validateLinePatternLocal,
  validateRuleSetPatterns,
  type FallbackStrategy,
} from '@/features/book/stores/import.store.ts'

const props = withDefaults(defineProps<{
  /** book:ruleSets 的列表（失败时 store 回退 BUILTIN_RULE_SETS） */
  ruleSets?: ChapterRuleSet[]
  /** 当前选中的规则集 id */
  activeRuleSetId?: string
  /** 可编辑副本（内置集只读，改动会派生出 builtin=false 的副本） */
  draft?: ChapterRuleSet | null
  /** 去掉取消勾选后的有效规则集（预览实际用的是它） */
  effective?: ChapterRuleSet | null
  /** 被用户取消勾选的规则 id */
  disabledPatternIds?: string[]
  /** 备选分章策略 */
  fallbackStrategy?: FallbackStrategy
  /** 解析出来的章数与总字数（「切出 N 章」） */
  draftCount?: number
  totalChars?: number
  /** 规则集自身的校验错误（store.ruleSetPreviewError） */
  previewErrorText?: string | null
  /** 解析失败的原因（store.previewError.message，可能为空） */
  parseErrorText?: string | null
  /** 规则集状态提示（store.ruleSetNotice，如「已保存为自定义规则集」） */
  notice?: string
  /** 有未落库到主进程的改动 */
  dirty?: boolean
  /** 解析 / 保存中 */
  busy?: boolean
  /** 粘贴来源才有正文在手，才能本地按空行或长度切 */
  hasLocalText?: boolean
}>(), {
  ruleSets: () => [],
  activeRuleSetId: '',
  draft: null,
  effective: null,
  disabledPatternIds: () => [],
  fallbackStrategy: 'none',
  draftCount: 0,
  totalChars: 0,
  previewErrorText: null,
  parseErrorText: null,
  notice: '',
  dirty: false,
  busy: false,
  hasLocalText: false,
})

const emit = defineEmits<{
  /** 切换规则集 */
  'select-set': [id: string]
  /** 勾选 / 取消勾选单条规则 */
  'toggle-pattern': [ruleId: string]
  /** 修改单条规则（只 patch 变化字段），改完由父视图 300 ms 防抖重算 */
  'update-pattern': [ruleId: string, patch: Partial<ChapterRule>]
  /** 新增一条自定义正则 */
  'add-pattern': []
  /** 删除一条规则 */
  'remove-pattern': [ruleId: string]
  /** 允许「纯数字标题」（与页码清洗冲突，主进程会自动打开 protectPureDigitLines） */
  'set-numeric-only': [value: boolean]
  /** 改规则集名 */
  'rename-set': [name: string]
  /** 另存为自定义规则集（内置集永不被改写） */
  'save-as': [name: string]
  /** 删除自定义规则集 */
  'delete-set': [id: string]
  /** 选备选分章策略 */
  'set-fallback': [strategy: FallbackStrategy]
  /** 规则/开关改动 → 父视图 300 ms 防抖后重算预览 */
  changed: []
  /** 立即重算（用户显式点「立即重算」，不吃防抖） */
  recalc: []
  /** 用本地正文按备选策略切一遍（仅粘贴来源；book:previewSplit 不接受 URL/纯文本兜底） */
  'apply-local-fallback': [strategy: Exclude<FallbackStrategy, 'none'>]
  /** 重新载入规则集（book:ruleSets，失败时 store 会回退内置规则） */
  'reload-sets': []
}>()

// ── 本地 UI 状态 ───────────────────────────────────────────────────────────
/** 「另存为」输入框（非空即可点保存） */
const saveAsName = ref('')

/** 单条规则的正则预检结果（docs/10 §6.5） */
function patternIssue(pattern: string): string | null {
  const result = validateLinePatternLocal(pattern)
  if (!result.ok) return result.error ?? '正则无效'
  if (result.unsafe) return '这条正则可能触发灾难性回溯（嵌套量词），大文件上会卡住，建议改写'
  return null
}

/** 规则的启用态：契约的 ChapterRule 没有 enabled 字段，未勾选的 id 单独记在 disabledPatternIds */
function isEnabled(ruleId: string): boolean {
  return !props.disabledPatternIds.includes(ruleId)
}

const patterns = computed<ChapterRule[]>(() => props.draft?.patterns ?? [])
const effectivePatterns = computed(() => props.effective?.patterns.length ?? 0)
const setError = computed(() => props.previewErrorText ?? validateRuleSetPatterns(props.effective))

const KIND_OPTIONS: Array<{ value: ChapterKind; label: string }> = [
  { value: 'chapter', label: '正文' },
  { value: 'front', label: '前言' },
  { value: 'back', label: '后记' },
  { value: 'extra', label: '番外' },
  { value: 'volume', label: '卷' },
]

/** 编码相关的自定义正则提示：Big5 等编码下标题行的字形不同，需要在第 2 步先确认编码 */
const encodingHint = `自定义正则前请先在第 2 步确认编码（常见候选：${ENCODING_CANDIDATES.join(' / ')}）：编码错误时中文标题全部是乱码，再好的正则也切不出来。`

// ── 交互 ───────────────────────────────────────────────────────────────────

function onSelectSet(event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  if (!id) return
  emit('select-set', id)
  emit('changed')
}

function onToggleNumericOnly(event: Event): void {
  emit('set-numeric-only', (event.target as HTMLInputElement).checked)
  emit('changed')
}

function onPatternText(rule: ChapterRule, event: Event): void {
  emit('update-pattern', rule.id, { linePattern: (event.target as HTMLInputElement).value })
  emit('changed')
}

/** 只 patch 真正变化的那个字段（不做 { [field]: value } 这种动态键，避免类型被放宽） */
function onPatternNumber(rule: ChapterRule, field: 'maxLineLength' | 'titleGroup', event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  const value = field === 'maxLineLength' ? Math.max(1, Math.round(raw)) : Math.max(0, Math.round(raw))
  emit('update-pattern', rule.id, field === 'maxLineLength' ? { maxLineLength: value } : { titleGroup: value })
  emit('changed')
}

function onPatternBlank(rule: ChapterRule, event: Event): void {
  emit('update-pattern', rule.id, { requireBlankAround: (event.target as HTMLInputElement).checked })
  emit('changed')
}

function onPatternKind(rule: ChapterRule, event: Event): void {
  const value = (event.target as HTMLSelectElement).value as ChapterKind
  emit('update-pattern', rule.id, { kind: value })
  emit('changed')
}

function onTogglePattern(ruleId: string): void {
  emit('toggle-pattern', ruleId)
  emit('changed')
}

function onAddPattern(): void {
  emit('add-pattern')
  emit('changed')
}

function onRemovePattern(ruleId: string): void {
  emit('remove-pattern', ruleId)
  emit('changed')
}

function onRenameSet(event: Event): void {
  emit('rename-set', (event.target as HTMLInputElement).value)
  emit('changed')
}

function onSaveAs(): void {
  const name = saveAsName.value.trim()
  if (!name) return
  emit('save-as', name)
  saveAsName.value = ''
}

function onDeleteSet(): void {
  const id = props.activeRuleSetId
  if (!id) return
  emit('delete-set', id)
  emit('changed')
}

function onFallback(strategy: FallbackStrategy): void {
  emit('set-fallback', strategy)
  emit('changed')
}

function onLocalFallback(): void {
  const strategy = props.fallbackStrategy === 'none' ? 'blank-blocks' : props.fallbackStrategy
  emit('apply-local-fallback', strategy)
  emit('recalc')
}

const activeSet = computed(() => props.draft)
const isBuiltin = computed(() => activeSet.value?.builtin !== false)
</script>

<template>
  <section class="rule">
    <!-- 内置 + 自定义规则集选择 -->
    <header class="rule__head">
      <label class="rule__field">
        <span>规则集</span>
        <select class="rule__select" :value="activeRuleSetId" :disabled="busy" @change="onSelectSet">
          <option v-for="set in ruleSets" :key="set.id" :value="set.id">
            {{ set.name }}{{ set.builtin ? '（内置）' : '' }}
          </option>
        </select>
      </label>

      <label class="rule__field rule__field--grow">
        <span>规则集名</span>
        <input
          class="rule__input"
          type="text"
          :value="activeSet?.name ?? ''"
          :disabled="busy || !activeSet"
          placeholder="给这套规则起个名字"
          @change="onRenameSet"
        >
      </label>

      <label class="rule__check" title="开启后「纯数字行」不会再被页码清洗删掉">
        <input
          type="checkbox"
          :checked="activeSet?.allowNumericOnly === true"
          :disabled="busy || !activeSet"
          @change="onToggleNumericOnly"
        >
        允许纯数字标题
      </label>
    </header>

    <p v-if="isBuiltin && activeSet" class="rule__note">
      当前选的是内置规则集：直接改会派生出一份自定义副本，内置规则集本身永远不会被改写（docs/10 §6.2）。
    </p>
    <p v-else-if="!activeSet" class="rule__note">
      还没有规则集数据：点下方「重新载入规则集」（book:ruleSets，失败时回退内置规则）。
    </p>
    <!-- 逐条规则 -->
    <table v-if="patterns.length" class="rule__table">
      <thead>
        <tr>
          <th class="rule__col-on">启用</th>
          <th>正则（整行匹配，自动加 ^ $）</th>
          <th class="rule__col-num" title="行长度上限：防止匹配到正文里提到的「第三章」">行长上限</th>
          <th class="rule__col-blank" title="要求标题行前后是空行，提高精度但可能漏切">前后空行</th>
          <th class="rule__col-group" title="标题提取组（0 = 整个匹配）">标题组</th>
          <th class="rule__col-kind">类型</th>
          <th class="rule__col-op">操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="rule in patterns" :key="rule.id">
          <tr class="rule__row" :class="{ 'rule__row--off': !isEnabled(rule.id) }">
            <td>
              <input
                type="checkbox"
                :checked="isEnabled(rule.id)"
                :disabled="busy"
                @change="onTogglePattern(rule.id)"
              >
            </td>
            <td>
              <input
                class="rule__input rule__input--mono"
                type="text"
                :value="rule.linePattern"
                :disabled="busy"
                spellcheck="false"
                @change="onPatternText(rule, $event)"
              >
            </td>
            <td>
              <input
                class="rule__input rule__input--num"
                type="number"
                min="1"
                :value="rule.maxLineLength"
                :disabled="busy"
                @change="onPatternNumber(rule, 'maxLineLength', $event)"
              >
            </td>
            <td class="rule__center">
              <input
                type="checkbox"
                :checked="rule.requireBlankAround"
                :disabled="busy"
                @change="onPatternBlank(rule, $event)"
              >
            </td>
            <td>
              <input
                class="rule__input rule__input--num"
                type="number"
                min="0"
                :value="rule.titleGroup"
                :disabled="busy"
                @change="onPatternNumber(rule, 'titleGroup', $event)"
              >
            </td>
            <td>
              <select class="rule__select" :value="rule.kind" :disabled="busy" @change="onPatternKind(rule, $event)">
                <option v-for="option in KIND_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </td>
            <td>
              <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="onRemovePattern(rule.id)">
                删除
              </button>
            </td>
          </tr>
          <tr v-if="patternIssue(rule.linePattern)" :key="`${rule.id}-issue`" class="rule__issue-row">
            <td />
            <td colspan="6" class="rule__issue">{{ patternIssue(rule.linePattern) }}</td>
          </tr>
        </template>
      </tbody>
    </table>

    <EmptyState
      v-else
      title="这套规则一条都没有"
      description="加一条自定义正则，或换成内置规则集（中文小说·标准 / 宽松）。"
      icon="✂️"
      size="small"
      action-text="新增一条规则"
      @action="onAddPattern"
    />

    <div class="rule__ops">
      <button type="button" class="ns-btn" :disabled="busy" @click="onAddPattern">新增规则</button>
      <button type="button" class="ns-btn" :disabled="busy" title="重新读取 book:ruleSets（失败时回退内置规则）" @click="emit('reload-sets')">
        重新载入规则集
      </button>
      <input v-model="saveAsName" class="rule__input rule__input--grow" type="text" placeholder="自定义规则集名称">
      <button type="button" class="ns-btn" :disabled="busy || !saveAsName.trim()" @click="onSaveAs">另存为</button>
      <button
        type="button"
        class="ns-btn ns-btn--danger"
        :disabled="busy || !activeSet || isBuiltin"
        :title="isBuiltin ? '内置规则集不能删除' : '删除这套自定义规则集'"
        @click="onDeleteSet"
      >
        删除规则集
      </button>
    </div>

    <!-- 备选分章策略（docs/10 §6.4） -->
    <fieldset class="rule__fallback">
      <legend>切不出章节时怎么办（备选策略）</legend>
      <label v-for="option in FALLBACK_LABELS" :key="option.value" class="rule__fallback-item">
        <input
          type="radio"
          name="ns-fallback"
          :value="option.value"
          :checked="fallbackStrategy === option.value"
          :disabled="busy"
          @change="onFallback(option.value)"
        >
        <span class="rule__fallback-label">{{ option.label }}</span>
        <span class="rule__fallback-hint">{{ option.hint }}</span>
      </label>
      <button
        v-if="hasLocalText"
        type="button"
        class="ns-btn ns-btn--small rule__fallback-local"
        :disabled="busy"
        @click="onLocalFallback"
      >
        用本地正文按此策略切一遍（粘贴来源可用）
      </button>
    </fieldset>

    <!-- 预览结果 -->
    <footer class="rule__preview">
      <div class="rule__preview-main">
        <strong class="rule__preview-count">切出 {{ formatInt(draftCount) }} 章</strong>
        <span class="rule__preview-sub">
          有效规则 {{ formatInt(effectivePatterns) }} 条 · 正文 {{ formatCount(totalChars) }}字
          <span v-if="dirty" class="rule__dirty">（有改动，重算时会自动保存到主进程）</span>
        </span>
      </div>
      <div class="rule__preview-ops">
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('recalc')">
          {{ busy ? '重算中…' : '立即重算' }}
        </button>
      </div>
    </footer>

    <p v-if="setError" class="rule__error" role="alert">{{ setError }}</p>
    <p v-else-if="parseErrorText" class="rule__error" role="alert">{{ parseErrorText }}</p>
    <p v-else-if="notice" class="rule__hint">{{ notice }}</p>

    <p v-if="draftCount === 0 && !busy" class="rule__hint">
      一章都没切出来：通常是「标题行长度上限」太小或「前后空行」太严，也可以直接选一种备选策略先把书导进来。
    </p>
    <p class="rule__hint">{{ encodingHint }}</p>
  </section>
</template>

<style scoped>
.rule {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rule__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.rule__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.rule__field--grow {
  flex: 1;
  min-width: 180px;
}
.rule__select,
.rule__input {
  padding: 5px 8px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.rule__input--mono {
  font-family: ui-monospace, monospace;
}
.rule__input--num {
  width: 72px;
}
.rule__input--grow {
  flex: 1;
  min-width: 160px;
}
.rule__check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.rule__note {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.6;
}
.rule__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.rule__table th,
.rule__table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  text-align: left;
  vertical-align: middle;
}
.rule__table th {
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 500;
}
.rule__row--off {
  opacity: 0.5;
}
.rule__col-on,
.rule__col-num,
.rule__col-blank,
.rule__col-group,
.rule__col-kind,
.rule__col-op {
  width: 84px;
}
.rule__col-on {
  width: 48px;
}
.rule__center {
  text-align: center;
}
.rule__issue-row td {
  padding-top: 0;
}
.rule__issue {
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
}
.rule__ops {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.rule__fallback {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 10px 14px 14px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
}
.rule__fallback legend {
  padding: 0 6px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  font-weight: 600;
}
.rule__fallback-item {
  display: grid;
  grid-template-columns: 20px 130px 1fr;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
}
.rule__fallback-label {
  color: var(--ns-text-primary, #303133);
}
.rule__fallback-hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.rule__fallback-local {
  align-self: flex-start;
  margin-top: 4px;
}
.rule__preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.rule__preview-count {
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.rule__preview-sub {
  margin-left: 10px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.rule__dirty {
  color: var(--ns-warning, #e6a23c);
}
.rule__error {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-danger, #f56c6c);
  border-radius: 4px;
  background: rgb(245 108 108 / 8%);
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  line-height: 1.6;
}
.rule__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.6;
}
.ns-btn {
  padding: 6px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn--small {
  padding: 4px 10px;
  font-size: 12px;
}
.ns-btn--danger {
  border-color: var(--ns-danger, #f56c6c);
  color: var(--ns-danger, #f56c6c);
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
