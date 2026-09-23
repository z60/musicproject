<!--
  书籍导入域 · 导入向导（docs/10 §7 / §7.1 的 7 步向导）
  ============================================================================
  设计依据：
    · docs/10 §7.1 —— 七步：来源 / 解析与编码 / 分章规则 / 清洗报告 / 章节列表 /
      确认导入 / 完成；**每一步都可后退，后退不丢已解析数据**
    · docs/10 §7.1 —— Step 5 必须能预览正文（右侧抽屉，由 ChapterPreviewTable 承载）
    · docs/10 §7.1 —— Step 7「进度 → 结果摘要 → 进入画本」
    · docs/10 §9    —— 去重三选一（打开已有 / 作为副本 / 取消），绝不静默选择
    · docs/04 §2.4 —— 长任务进度统一用 TaskProgressCard（导入走任务通道时）
    · docs/22 §6.2 —— 本视图不弹提示、不自拼错误文案：错误一律由 error-bus 兑现

  视图职责（刻意很薄，与 useImportFlow 的分工）：
    · 状态：`stores/import.store.ts`（步骤、源、编码、规则、清洗、草稿都在 store 里，
      所以「后退不丢数据」只需要 `goto()` 改一个数字）；
    · 编排：`composables/useImportFlow.ts`（步骤守卫、防抖重算、去重三选一、
      走哪条提交通道、任务订阅与取消/重试、完成后的跳转）；
    · 本文件：布局 + 把 5 个子组件的事件接到上面两者。

  契约缺口（显式降级，见 useImportFlow 的注释）：
    · URL 来源没有 previewSplit 通道 → 步骤 2~5 不可进入，1 → 6 直达；
    · `book:commitImport` 不接受 duplicatePolicy → 「作为副本导入」只能走任务通道，
      该通道按源文件重新解析，第 5 步的人工改名/合并不会被带入（界面明确写出这一后果）。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { formatBytes, formatCount, formatDuration, formatInt } from '@/shared/lib/format.ts'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import CleanReportPanel from '@/features/book/components/CleanReportPanel.vue'
import ChapterMergeDialog from '@/features/book/components/ChapterMergeDialog.vue'
import ChapterPreviewTable from '@/features/book/components/ChapterPreviewTable.vue'
import EncodingPanel from '@/features/book/components/EncodingPanel.vue'
import SourcePicker from '@/features/book/components/SourcePicker.vue'
import SplitRuleEditor from '@/features/book/components/SplitRuleEditor.vue'
import { useImportFlow } from '@/features/book/composables/useImportFlow.ts'
import type { WizardStep } from '@/features/book/stores/import.store.ts'

const router = useRouter()
const flow = useImportFlow()
const store = flow.store

/**
 * 注意：`flow.step / blockReason / canGoNext / canGoPrev` 在 composable 里是**取用时快照**
 * （pinia store 的 ref 已被解包），用在界面上会停在旧值；因此步骤相关的判断一律读 store，
 * 只有 `busy / projectRootHint` 是 ComputedRef，可以安全取 `.value`。
 */
const steps = flow.steps
const busy = computed(() => flow.busy.value)
const projectRoot = computed(() => flow.projectRootHint.value)

/** 语言候选（导出元数据用；docs/10 §7 Step6 的字段之一） */
const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en-US', label: '英语' },
  { value: 'ja-JP', label: '日语' },
]

/** 本地状态提示（批量改名的生效条数、合并/拆分结果）——纯界面反馈，不是错误文案 */
const notice = ref('')

// ── 步骤导航 ───────────────────────────────────────────────────────────────

onMounted(() => { void flow.init() })

/** 允许跳到的步骤：已走过的可自由回退，未来只允许前进一步（且必须满足守卫） */
function canJump(target: WizardStep): boolean {
  if (target === store.step) return true
  // URL 来源没有解析预览通道：步骤 2~5 一律不可进入
  if (!store.canPreview && target >= 2 && target <= 5) return false
  if (target < store.step) return true
  return target === store.step + 1 && store.canGoNext
}

function jumpReason(target: WizardStep): string {
  if (canJump(target)) return ''
  if (!store.canPreview && target >= 2 && target <= 5) return 'URL 来源没有解析预览通道，第 2~5 步会跳过'
  if (target > store.step + 1) return '请按顺序完成前面的步骤'
  return store.blockReason ?? '当前步骤还有必填项没完成'
}

function onStepClick(target: WizardStep): void {
  if (!canJump(target)) return
  flow.goto(target)
}

const stepIndex = computed(() => store.step)

// ── 合并 / 拆分对话框（Step 5）──────────────────────────────────────────────

const mergeDialog = ref<{ mode: 'merge' | 'split'; ids: string[] } | null>(null)

const mergeItems = computed(() => {
  const target = mergeDialog.value
  if (!target) return []
  return store.drafts
    .filter(draft => target.ids.includes(draft.tempId))
    .map(draft => ({ id: draft.tempId, title: draft.title, charCount: draft.charCount, rawText: draft.rawText }))
})

function openMergeDialog(ids: string[]): void {
  notice.value = ''
  mergeDialog.value = { mode: 'merge', ids }
}

function openSplitDialog(tempId: string): void {
  notice.value = ''
  mergeDialog.value = { mode: 'split', ids: [tempId] }
}

function onMergeDialogVisible(visible: boolean): void {
  if (!visible) mergeDialog.value = null
}

function onMergeDialogConfirm(payload:
  | { mode: 'merge'; ids: string[]; title: string }
  | { mode: 'split'; id: string; offsets: number[] }): void {
  if (payload.mode === 'merge') {
    const merged = store.mergeDrafts(payload.ids, payload.title)
    notice.value = merged
      ? `已把 ${formatInt(payload.ids.length)} 章合并为「${merged.title}」（${formatInt(merged.charCount)} 字）——提交时会作为一个章节入库`
      : '合并没有生效：至少需要两章（且必须是相邻章节）'
  } else {
    const created = store.splitDraft(payload.id, payload.offsets)
    notice.value = created
      ? `已拆成 ${formatInt(created.length)} 章（标题自动加上「(i/N)」后缀，可在列表里改名）`
      : '拆分没有生效：拆分点必须落在正文内部（0 < 偏移 < 正文长度）'
  }
  mergeDialog.value = null
}

// ── Step 5：批量改名结果提示 ────────────────────────────────────────────────

function onAffix(payload: { affix: string; position: 'prefix' | 'suffix'; action: 'add' | 'remove' }): void {
  const changed = store.applyTitleAffix(payload.affix, payload.position, payload.action)
  notice.value = changed
    ? `已${payload.action === 'add' ? '添加' : '去除'}「${payload.affix}」：影响 ${formatInt(changed)} 章（只作用于已勾选章节）`
    : `没有章节需要改动：「${payload.affix}」${payload.action === 'add' ? '已存在或没有勾选章节' : '不在已勾选章节的标题前后'}`
}

/** Step 5 范围勾选：起止章号（留空 = 用解析出的整段范围） */
const rangeFrom = ref('')
const rangeTo = ref('')

const rangeHint = computed(() => {
  const r = store.chapterNumberRange
  if (r.mapped === 0) return ''
  return `识别到的章号范围：第 ${r.min} ~ ${r.max} 章（标题里没有章号的按列表序号回退）`
})

function onSelectRange(): void {
  const r = store.chapterNumberRange
  const from = rangeFrom.value.trim() ? Number(rangeFrom.value) : r.min
  const to = rangeTo.value.trim() ? Number(rangeTo.value) : r.max
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    notice.value = '章号范围无效：请填数字，或留空表示整段'
    return
  }
  const selected = store.selectRangeByChapterNumber(from, to)
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  notice.value = selected > 0
    ? `已只勾选第 ${lo} ~ ${hi} 章：共 ${formatInt(selected)} 章`
    : `第 ${lo} ~ ${hi} 章里没有章节：请检查章号范围`
}

// ── Step 6：确认导入 ───────────────────────────────────────────────────────

/**
 * Step 6「导入到」：空 = 新建一本书；选了某本书 = 追加到它末尾（book:commitImport 的 targetBookId）。
 * 切回「新建」时 flow 会重新跑去重（追加模式跳过了去重）。
 */
function onTargetBookChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  void flow.onTargetBookChanged(value ? value : null)
}

/** Step 7 展示的书名：追加时用目标书（bookMeta 在追加模式下不要求填） */
const commitTitle = computed(() => store.targetBook?.title || store.bookMeta.title || '未命名作品')

async function onCommit(): Promise<void> {
  notice.value = ''
  const result = await flow.submit()
  if (result === 'duplicate') notice.value = '内容与已有书籍重复：请在下方选择「打开已有书籍」或「作为副本导入」'
  if (result === 'blocked') notice.value = store.blockReason ?? '当前条件还不足以导入'
}

const commitStats = computed(() => [
  { label: '章节', value: `${formatInt(store.includedCount)} 章` },
  { label: '总字数', value: `${formatCount(store.includedChars)}字` },
  { label: '预估时长', value: formatDuration(store.includedDurationMs) },
])

/** 书名 / 作者 / 旁白 / 语言：不在模板里写 as 断言，统一走这几个小处理器 */
function onTitleInput(event: Event): void {
  store.setBookMeta({ title: (event.target as HTMLInputElement).value })
}

function onAuthorInput(event: Event): void {
  store.setBookMeta({ author: (event.target as HTMLInputElement).value })
}

function onNarratorInput(event: Event): void {
  store.setBookMeta({ narrator: (event.target as HTMLInputElement).value })
}

function onLanguageChange(event: Event): void {
  store.setBookMeta({ language: (event.target as HTMLSelectElement).value })
}

/** 去重命中时的「打开已有书籍」（bookId 可能缺失，此时按钮禁用） */
function onOpenExisting(): void {
  const bookId = store.duplicate?.bookId
  if (!bookId) return
  void flow.openExistingBook(bookId)
}

// ── 模板用的小工具 ─────────────────────────────────────────────────────────

const sourceSummary = computed(() => {
  if (store.mode === 'file') return store.filePath ?? '还没有选择文件'
  if (store.mode === 'paste') return `粘贴文本 ${formatCount(store.pasteText.length)}字`
  return store.url || '还没有填写网页地址'
})
</script>

<template>
  <section class="wiz">
    <!-- 步骤条 -->
    <header class="wiz__head">
      <div class="wiz__headline">
        <h2 class="wiz__title">导入书籍</h2>
        <p class="wiz__sub">
          来源：{{ sourceSummary }}
          <span v-if="store.probe"> · {{ formatBytes(store.probe.sizeBytes) }}</span>
          <span v-if="projectRoot"> · 项目根目录 {{ projectRoot }}</span>
        </p>
      </div>
      <div class="wiz__head-ops">
        <button type="button" class="ns-btn" @click="router.push({ path: '/bookshelf' })">返回书架</button>
        <button type="button" class="ns-btn" @click="flow.startOver()">清空重来</button>
      </div>
    </header>

    <ol class="wiz__steps">
      <li
        v-for="item in steps"
        :key="item.step"
        class="wiz__step"
        :class="{
          'wiz__step--current': item.step === stepIndex,
          'wiz__step--done': item.step < stepIndex,
          'wiz__step--locked': !canJump(item.step),
        }"
        :title="jumpReason(item.step) || item.tip"
      >
        <button type="button" class="wiz__step-btn" :disabled="!canJump(item.step)" @click="onStepClick(item.step)">
          <span class="wiz__step-no">{{ item.step }}</span>
          <span class="wiz__step-text">
            <span class="wiz__step-title">{{ item.title }}</span>
            <span class="wiz__step-tip">{{ item.tip }}</span>
          </span>
        </button>
      </li>
    </ol>

    <p v-if="notice" class="wiz__notice" role="status">{{ notice }}</p>

    <!-- Step 1 来源 -->
    <section v-if="stepIndex === 1" class="wiz__panel">
      <SourcePicker
        :mode="store.mode"
        :file-name="store.fileName"
        :file-path="store.filePath"
        :probe="store.probe"
        :file-too-large="store.fileTooLarge"
        :max-file-size-bytes="store.maxFileSizeBytes"
        :paste-text="store.pasteText"
        :url="store.url"
        :busy="busy"
        @update:mode="store.setMode"
        @update:paste-text="flow.onPasteTextChanged"
        @update:url="flow.onUrlChanged"
        @pick-file="flow.pickFile()"
        @file-dropped="flow.onFileDropped"
      />
      <!-- 导入模式：文档本身已经是画本（【角色-CV】“台词” + 角色表） -->
      <div class="wiz__mode">
        <el-checkbox
          :model-value="store.importMode === 'canvas'"
          @update:model-value="(v) => store.setImportMode(v ? 'canvas' : 'text')"
        >
          这份文档<strong>已经是画本</strong>（按 `【角色名-CV名】“台词”` 标注，且每章末尾有角色表）
        </el-checkbox>
        <p class="wiz__hint">
          勾选后：直接按【角色-CV】把每一行写进画本，并按角色表建立角色（CV / 音色 / 年龄写进角色备注）；
          <strong>不会</strong>再跑说话人判定。不勾选 = 普通小说，导入后再生成画本。
        </p>
      </div>
      <p class="wiz__hint">
        小贴士：把 TXT / DOCX / PDF 直接拖进上面的虚线框即可（本应用走磁盘路径读取，不把大文件读进界面）；
        网页地址会在确认页之后走任务通道抓取（单页 5 MB、最多 50 页）。
      </p>
    </section>

    <!-- Step 2 解析与编码 -->
    <section v-else-if="stepIndex === 2" class="wiz__panel">
      <EncodingPanel
        :detection="store.detection"
        :selected-encoding="store.selectedEncoding"
        :parsed-encoding="store.parsedEncoding"
        :needs-user-choice="store.needsUserEncodingChoice"
        :differs-from-parsed="store.encodingDiffersFromParsed"
        :busy="store.detectBusy || store.previewBusy"
        :draft-count="store.drafts.length"
        :preview-error-text="store.previewError?.message ?? null"
        :container-format="store.probe?.kind === 'docx' || store.probe?.kind === 'pdf'"
        @select="flow.onEncodingSelected"
        @redetect="flow.reloadEncoding()"
        @reparse="flow.runPreviewNow()"
      />
      <dl class="wiz__facts">
        <div><dt>正文规模</dt><dd>{{ formatCount(store.totalChars) }}字</dd></div>
        <div><dt>解析编码</dt><dd>{{ store.parsedEncoding || '未知' }}</dd></div>
        <div><dt>内容哈希</dt><dd>{{ store.contentHash ? `${store.contentHash.slice(0, 16)}…` : '主进程未返回（本次跳过去重检查）' }}</dd></div>
        <div><dt>解析标题</dt><dd>{{ store.parsedTitle || '未识别' }}</dd></div>
      </dl>
    </section>

    <!-- Step 3 分章规则 -->
    <section v-else-if="stepIndex === 3" class="wiz__panel">
      <SplitRuleEditor
        :rule-sets="store.ruleSets"
        :active-rule-set-id="store.activeRuleSetId"
        :draft="store.ruleSetDraft"
        :effective="store.effectiveRuleSet"
        :disabled-pattern-ids="store.disabledPatternIds"
        :fallback-strategy="store.fallbackStrategy"
        :draft-count="store.drafts.length"
        :total-chars="store.totalChars"
        :preview-error-text="store.ruleSetPreviewError"
        :parse-error-text="store.previewError?.message ?? null"
        :notice="store.ruleSetNotice"
        :dirty="store.ruleSetDirty"
        :busy="store.previewBusy"
        :has-local-text="store.hasLocalText"
        @select-set="store.selectRuleSet"
        @toggle-pattern="store.togglePatternEnabled"
        @update-pattern="store.updatePattern"
        @add-pattern="store.addPattern()"
        @remove-pattern="store.removePattern"
        @set-numeric-only="store.setAllowNumericOnly"
        @rename-set="store.renameRuleSet"
        @save-as="flow.saveRuleSetAs"
        @delete-set="flow.removeRuleSet"
        @set-fallback="store.setFallbackStrategy"
        @reload-sets="store.loadRuleSets()"
        @changed="flow.onSplitOptionsChanged()"
        @recalc="flow.runPreviewNow()"
        @apply-local-fallback="store.applyLocalFallback"
      />
    </section>

    <!-- Step 4 清洗报告 -->
    <section v-else-if="stepIndex === 4" class="wiz__panel">
      <CleanReportPanel
        :report="store.cleanReport"
        :detail="store.cleanReportDetail"
        :options="store.cleanOptions"
        :enabled-count="store.enabledCleanCount"
        :removed-line-count="store.removedLineCount"
        :remaining-chars="store.totalChars"
        :draft-count="store.drafts.length"
        :busy="store.previewBusy"
        @toggle-option="store.setCleanOption"
        @reset-options="store.resetCleanOptions()"
        @changed="flow.onCleanOptionsChanged()"
      />
    </section>

    <!-- Step 5 章节列表（人工干预） -->
    <section v-else-if="stepIndex === 5" class="wiz__panel">
      <div class="wiz__range">
        <span class="wiz__range-label">按章节范围勾选</span>
        <input v-model="rangeFrom" class="wiz__input wiz__range-input" type="number" min="1" placeholder="起始章号">
        <span class="wiz__range-tilde">~</span>
        <input v-model="rangeTo" class="wiz__input wiz__range-input" type="number" min="1" placeholder="结束章号">
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="onSelectRange">只勾选此范围</button>
        <span class="wiz__hint">{{ rangeHint }}</span>
      </div>
      <ChapterPreviewTable
        :drafts="store.drafts"
        :included-count="store.includedCount"
        :total-chars="store.totalDraftChars"
        :included-chars="store.includedChars"
        :included-duration-ms="store.includedDurationMs"
        :removed-drafts="store.removedDrafts"
        :preview-draft="store.previewDraft"
        :suspicious-split="store.suspiciousSplit"
        :split-warnings="store.splitWarnings"
        :drafts-edited="store.draftsEdited"
        :busy="store.previewBusy"
        :longest-draft="store.longestDraft"
        @rename="store.setDraftTitle"
        @toggle="store.toggleDraftIncluded"
        @set-all="store.setAllIncluded"
        @invert="store.invertIncluded()"
        @move="store.moveDraftBy"
        @drop="store.moveDraft"
        @sort-by-number="store.sortByTitleNumber()"
        @remove="store.removeDraft"
        @restore="store.restoreDraft"
        @restore-all="store.restoreAllDrafts()"
        @affix="onAffix"
        @open-preview="store.setPreviewDraft"
        @close-preview="store.setPreviewDraft(null)"
        @merge-request="openMergeDialog"
        @split-request="openSplitDialog"
      />
    </section>

    <!-- Step 6 确认导入 -->
    <section v-else-if="stepIndex === 6" class="wiz__panel">
      <!-- 「追加到已有书籍」只在可预览来源（文件/粘贴）开放：URL 走任务通道，只能新建 -->
      <div v-if="store.canPreview" class="wiz__target">
        <label class="wiz__field">
          <span>导入到</span>
          <select class="wiz__input" :value="store.targetBookId ?? ''" :disabled="store.booksBusy" @change="onTargetBookChange">
            <option value="">新建一本书</option>
            <option v-for="b in store.availableBooks" :key="b.id" :value="b.id">
              追加到：{{ b.title }}（当前 {{ formatInt(b.chapterCount) }} 章）
            </option>
          </select>
        </label>
        <p class="wiz__hint">
          {{ store.appendMode
            ? `本次 ${formatInt(store.includedCount)} 章会接到《${store.targetBook?.title ?? ''}》末尾，书名/作者/封面沿用原书。`
            : '新建一本书；书架里已有书时也可以选「追加到…」，把多份画本文件合成同一本书。' }}
        </p>
      </div>

      <div v-if="!store.appendMode" class="wiz__form">
        <label class="wiz__field">
          <span>书名 <em>*</em></span>
          <input
            class="wiz__input"
            type="text"
            :value="store.bookMeta.title"
            placeholder="必填：将作为书架里的书名"
            @input="onTitleInput"
          >
        </label>
        <label class="wiz__field">
          <span>作者</span>
          <input
            class="wiz__input"
            type="text"
            :value="store.bookMeta.author"
            placeholder="可留空"
            @input="onAuthorInput"
          >
        </label>
        <label class="wiz__field">
          <span>旁白配音员</span>
          <input
            class="wiz__input"
            type="text"
            :value="store.bookMeta.narrator"
            placeholder="默认朗读/旁白配音员名"
            @input="onNarratorInput"
          >
        </label>
        <label class="wiz__field">
          <span>语言</span>
          <select
            class="wiz__input"
            :value="store.bookMeta.language"
            @change="onLanguageChange"
          >
            <option v-for="option in LANGUAGE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <div class="wiz__field wiz__field--cover">
          <span>封面</span>
          <span class="wiz__cover-path">{{ store.bookMeta.coverPath || '未选择（可稍后在书架里更换）' }}</span>
          <button type="button" class="ns-btn ns-btn--small" @click="flow.setCover()">选择图片</button>
        </div>
      </div>

      <dl class="wiz__facts">
        <div v-for="item in commitStats" :key="item.label">
          <dt>{{ item.label }}</dt><dd>{{ item.value }}</dd>
        </div>
        <div><dt>来源</dt><dd>{{ store.sourceType.toUpperCase() }}</dd></div>
      </dl>

      <p v-if="!store.projectId" class="wiz__block" role="alert">
        {{ store.projectHint || '缺少项目上下文：导入会写进主进程的默认项目；若这里一直为空，请重启应用以重建默认项目。' }}
      </p>

      <!-- 去重（docs/10 §9 三选一，绝不静默选择）；追加模式不会新建书，去重不适用 -->
      <section v-if="!store.appendMode" class="wiz__dup" :class="{ 'wiz__dup--hit': store.duplicate !== null }">
        <header class="wiz__dup-head">
          <strong>重复检查</strong>
          <button type="button" class="ns-btn ns-btn--small" :disabled="!store.contentHash" @click="store.checkDuplicate()">
            重新检查
          </button>
        </header>
        <p v-if="!store.contentHash" class="wiz__hint">
          主进程没有返回内容哈希（book:previewSplit 的契约只保证 drafts/cleanReport/encoding），
          因此本次<strong>跳过去重检查</strong>：不做任何静默判断，直接导入。
        </p>
        <template v-else-if="store.duplicate">
          <p class="wiz__dup-warn">
            已在当前项目里找到内容相同的书籍（内容哈希一致）。请选择处理方式：
          </p>
          <div class="wiz__dup-ops">
            <button
              type="button"
              class="ns-btn ns-btn--primary"
              :disabled="!store.duplicate.bookId"
              @click="onOpenExisting"
            >
              打开已有书籍
            </button>
            <button type="button" class="ns-btn" @click="flow.importAsCopy()">作为副本导入</button>
            <button type="button" class="ns-btn" @click="flow.cancelDuplicate()">取消（回到第 5 步）</button>
          </div>
          <p class="wiz__hint">
            注意：「作为副本导入」走任务通道（book:importFile / importText / importUrl），
            该通道按<strong>源文件</strong>重新解析，第 5 步的人工改名/合并/删除结果不会被带入。
          </p>
        </template>
        <p v-else-if="store.duplicateChecked" class="wiz__hint">没有找到内容相同的书籍，可以放心导入。</p>
        <p v-else class="wiz__hint">还没有检查过。点「重新检查」用 book:findDuplicate 比对内容哈希。</p>
      </section>

      <div class="wiz__commit">
        <button
          type="button"
          class="ns-btn ns-btn--primary ns-btn--large"
          :disabled="!store.canCommit"
          @click="onCommit"
        >
          {{ store.committing ? '正在导入…' : '开始导入' }}
        </button>
        <span v-if="!store.canCommit" class="wiz__commit-block">{{ store.blockReason }}</span>
        <span v-else class="wiz__hint">{{ store.appendMode ? `将追加 ${formatInt(store.includedCount)} 章到《${store.targetBook?.title ?? ''}》` : `将写入 ${formatInt(store.includedCount)} 章（book:commitImport，携带第 5 步的人工调整）` }}</span>
      </div>

      <!-- 走任务通道时（URL 来源 / 作为副本）显示统一进度卡 -->
      <TaskProgressCard
        v-if="store.taskId"
        :task-id="store.taskId"
        :title="`导入《${commitTitle}》`"
        kind="book.import"
        cancelable
        retryable
        openable
        @cancel="flow.cancelTask"
        @retry="flow.retryTask"
        @open="router.push({ path: '/tasks' })"
      />
    </section>

    <!-- Step 7 完成 -->
    <section v-else class="wiz__panel">
      <TaskProgressCard
        v-if="store.taskId && !store.outcome"
        :task-id="store.taskId"
        :title="`导入《${commitTitle}》`"
        kind="book.import"
        cancelable
        retryable
        openable
        @cancel="flow.cancelTask"
        @retry="flow.retryTask"
        @open="router.push({ path: '/tasks' })"
      />

      <div v-if="store.outcome" class="wiz__done">
        <h3 class="wiz__done-title">导入完成</h3>
        <dl class="wiz__facts">
          <div><dt>书名</dt><dd>{{ commitTitle }}</dd></div>
          <div><dt>方式</dt><dd>{{ store.appendMode ? '追加到已有书籍' : '新建书籍' }}</dd></div>
          <div><dt>章节数</dt><dd>{{ formatInt(store.outcome.chapterCount) }} 章</dd></div>
          <div><dt>总字数</dt><dd>{{ formatCount(store.includedChars) }}字</dd></div>
          <div><dt>预估时长</dt><dd>{{ formatDuration(store.includedDurationMs) }}</dd></div>
          <div><dt>耗时</dt><dd>{{ formatDuration(store.outcome.elapsedMs) }}</dd></div>
          <div><dt>通道</dt><dd>{{ store.outcome.taskId ? '任务通道（按源文件解析）' : 'book:commitImport（含人工调整）' }}</dd></div>
        </dl>
        <div class="wiz__done-ops">
          <button type="button" class="ns-btn ns-btn--primary" @click="flow.goChapters()">进入章节列表</button>
          <button type="button" class="ns-btn" @click="flow.goCanvas()">生成画本</button>
          <button type="button" class="ns-btn" @click="flow.startOver()">再导入一本</button>
        </div>
        <p class="wiz__hint">
          「生成画本」会跳到画本编辑并自动定位到第一章：画本是全系统主轴，之后的录音、对轨、混音导出都从它出发。
        </p>
      </div>

      <p v-else-if="!store.taskId" class="wiz__hint">
        还没有导入结果。若刚刚的提交中断了，可回到第 6 步重试（错误提示里也有「重试」入口）。
      </p>
    </section>

    <!-- 底部导航：未完成必填项时禁用并说明原因 -->
    <footer class="wiz__foot">
      <div class="wiz__foot-left">
        <button type="button" class="ns-btn" :disabled="!store.canGoPrev" @click="flow.prev()">上一步</button>
        <button
          type="button"
          class="ns-btn ns-btn--primary"
          :disabled="!store.canGoNext"
          @click="flow.next()"
        >
          下一步
        </button>
        <span v-if="store.blockReason" class="wiz__foot-block">{{ store.blockReason }}</span>
        <span v-else-if="store.step === 7" class="wiz__hint">已是最后一步</span>
      </div>
      <span class="wiz__foot-progress">第 {{ stepIndex }} / {{ steps.length }} 步 · {{ store.stepDef.title }}</span>
    </footer>

    <ChapterMergeDialog
      :model-value="mergeDialog !== null"
      :mode="mergeDialog?.mode ?? 'merge'"
      :items="mergeItems"
      @update:model-value="onMergeDialogVisible"
      @confirm="onMergeDialogConfirm"
      @cancel="mergeDialog = null"
    />
  </section>
</template>

<style scoped>
.wiz {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 20px 28px;
}
.wiz__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.wiz__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
  font-weight: 600;
}
.wiz__sub {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wiz__head-ops {
  display: flex;
  gap: 8px;
}
.wiz__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wiz__step {
  flex: 1 1 150px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.wiz__step--current {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 10%);
}
.wiz__step--done {
  border-color: var(--ns-success, #67c23a);
}
.wiz__step--locked {
  opacity: 0.55;
}
.wiz__step-btn {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.wiz__step-btn:disabled {
  cursor: not-allowed;
}
.wiz__step-no {
  display: flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ns-fill, #ebeef5);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.wiz__step--current .wiz__step-no {
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.wiz__step-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wiz__step-title {
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.wiz__step-tip {
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wiz__notice {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  line-height: 1.6;
}
.wiz__panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 10px;
  background: var(--ns-bg-elevated, #fff);
}
.wiz__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.wiz__range {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.wiz__range-label {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.wiz__range-input {
  width: 110px;
}
.wiz__range-tilde {
  color: var(--ns-text-secondary, #909399);
}
.wiz__target {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wiz__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 22px;
  margin: 0;
}
.wiz__facts div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wiz__facts dt {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.wiz__facts dd {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.wiz__form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 14px;
}
.wiz__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.wiz__field em {
  color: var(--ns-danger, #f56c6c);
  font-style: normal;
}
.wiz__field--cover {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.wiz__cover-path {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wiz__input {
  padding: 6px 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.wiz__block {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-danger, #f56c6c);
  border-radius: 4px;
  background: rgb(245 108 108 / 8%);
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  line-height: 1.6;
}
.wiz__dup {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
}
.wiz__dup--hit {
  border-color: var(--ns-warning, #e6a23c);
  background: rgb(230 162 60 / 8%);
}
.wiz__dup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.wiz__dup-warn {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.wiz__dup-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wiz__commit {
  display: flex;
  align-items: center;
  gap: 12px;
}
.wiz__commit-block {
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
}
.wiz__done {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wiz__done-title {
  margin: 0;
  color: var(--ns-success, #67c23a);
  font-size: 16px;
  font-weight: 600;
}
.wiz__done-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wiz__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}
.wiz__foot-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wiz__foot-block {
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
}
.wiz__foot-progress {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
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
.ns-btn--large {
  padding: 9px 22px;
  font-size: 14px;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
