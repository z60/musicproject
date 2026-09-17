<!--
  Novel Studio · 帮助与快捷键
  ============================================================================
  设计依据：
    · docs/01 §4.1 —— 主链顺序即导航顺序：导入 → 生成画本 → 校对 → 录音 → 对轨 →
      混音导出。帮助页要能对着这条链逐步回答「这一步产出什么、下一步是什么」。
    · docs/12 §9.1 / docs/12 §9.3 —— 默认快捷键表；**录音页激活时会接管全局快捷键**，
      因此快捷键必须按作用域分组展示，并明确说明「在别的页面按这些键不会生效」。
    · docs/11 §4.5 —— 待确认队列的全键盘操作（目标 3 分钟清 100 行）。
    · docs/22 §8   —— 「报障三步」写进帮助页：① 记下编号 ② 导出诊断包 ③ 一起发给支持。
    · docs/README §6 —— 术语速查表（book / canvas / take / alignment / .nst / .nsp …）。
    · docs/22 §7   —— FAQ 里的「去设置改哪里」都用 `?focus=<语义键>` 深链，
      与提示条上的「前往设置」走同一套定位逻辑（设置页按 focus 高亮并滚动）。

  本页不做任何写操作：只读 IPC（app:getInfo / app:getPaths / app:diagnostics）+
  路由跳转。这样用户在任何状态下都能打开帮助页，不会因为状态不允许而被拦住。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/app/store/ui.store.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { formatShortcut, DEFAULT_RECORDING_SHORTCUTS, REVIEW_QUEUE_SHORTCUTS } from '@/shared/lib/shortcuts.ts'
import type { ShortcutBinding } from '@/shared/lib/shortcuts.ts'
import type { AppInfo, AppPaths } from '@shared/types.ts'

const router = useRouter()
const ui = useUiStore()

// ============================================================================
// 主链六步
// ============================================================================

interface StepAction {
  label: string
  path: string
}

interface StepDef {
  no: number
  title: string
  icon: string
  output: string
  next: string
  actions: StepAction[]
}

const STEPS: StepDef[] = [
  {
    no: 1,
    title: '导入书籍',
    icon: '📥',
    output: '一本书：章节已切好、正文已清洗（页尾导航、广告行、零宽字符都去掉），并确认了编码。',
    next: '下一步进「画本编辑」，对某一章生成画本。',
    actions: [{ label: '打开导入向导', path: '/import' }, { label: '打开书架', path: '/bookshelf' }],
  },
  {
    no: 2,
    title: '生成画本',
    icon: '📝',
    output: '这一章的画本行：每行一句话，带说话人、情绪、语速、句末留白。',
    next: '下一步在校对视图里过一遍「待确认」的行（低置信度的会自动进队列）。',
    actions: [{ label: '打开画本编辑', path: '/canvas' }],
  },
  {
    no: 3,
    title: '校对画本',
    icon: '✅',
    output: '人工确认过的说话人与断行，以及确认好的角色表（角色的别名越全，判定越准）。',
    next: '下一步按行录音；长行会提示拆分，避免一口气读不完。',
    actions: [{ label: '打开画本编辑', path: '/canvas' }, { label: '管理章节', path: '/chapters' }],
  },
  {
    no: 4,
    title: '录音',
    icon: '🎙',
    output: '每个画本行的 take（同一行可以录多条做 A/B 对比），并选出最终使用的那一条。',
    next: '下一步做对轨：把片段按时间线排成整章。',
    actions: [{ label: '开始录音', path: '/recording' }, { label: '设备自检', path: '/recording/diagnostics' }],
  },
  {
    no: 5,
    title: '对轨',
    icon: '🎚',
    output: '整章时间线：片段位置、留白、交叠处理结果，并给出缺录与异常告警。',
    next: '下一步混音：加背景音乐/音效、做闪避与响度归一化。',
    actions: [{ label: '打开对轨', path: '/alignment' }],
  },
  {
    no: 6,
    title: '混音与导出',
    icon: '📤',
    output: '成品：MP3 / WAV / 带章节的 M4B，附质检报告（实测响度、真峰、跳过与失败明细）。',
    next: '走完了：成品在导出目录里，可以直接分发；也可以导成 .nsp 项目包做归档。',
    actions: [{ label: '打开混音台', path: '/mixing' }, { label: '打开导出向导', path: '/export' }],
  },
]

// ============================================================================
// 快捷键速查（按作用域分组）
// ============================================================================

interface ShortcutRow extends ShortcutBinding {
  /** 规范化后的展示串（formatShortcut 的结果） */
  display: string
}

function toRows(bindings: ShortcutBinding[], scope: string): ShortcutRow[] {
  return bindings
    .filter(binding => binding.scope === scope)
    .map(binding => ({ ...binding, display: formatShortcut(binding.shortcut) }))
}

const recordingShortcuts = computed(() => toRows(DEFAULT_RECORDING_SHORTCUTS, 'recording'))
const reviewShortcuts = computed(() => toRows(REVIEW_QUEUE_SHORTCUTS, 'review'))

/** 录音页是否正在接管快捷键（ui.capturingShortcuts 由录音页写入，docs/12 §9.3） */
const capturing = computed(() => ui.capturingShortcuts)

// ============================================================================
// 术语速查（docs/README §6）
// ============================================================================

interface TermDef {
  term: string
  field: string
  meaning: string
}

const TERMS: TermDef[] = [
  { term: '书籍', field: 'book', meaning: '导入的原始文本整体，可含多章。' },
  { term: '章节', field: 'chapter', meaning: '分章后的文本单元，是录音与导出的调度单位。' },
  { term: '画本', field: 'canvas', meaning: '章节的「表演脚本」集合，由一个或多个画本行组成。' },
  { term: '画本行', field: 'canvas_line', meaning: '唯一主轴。一行 = 一句/一段要录的内容，带说话人、情绪、停顿与音色绑定。' },
  { term: '说话人', field: 'speaker', meaning: '画本行归属：narration（旁白）或某个 character（角色）。' },
  { term: '角色', field: 'character', meaning: '作品内的人物，可含多个别名（同一人的不同称呼）。' },
  { term: '配音员', field: 'voice_actor', meaning: '现实中的人；一个配音员可担任多个角色，一个角色可有多个候选。' },
  { term: '音色档案', field: 'voice_profile', meaning: '配音员的参考录音与声学画像，供后续 TTS / 匹配预留。' },
  { term: '原型向量', field: 'centroid', meaning: '某角色全部台词的 embedding 均值，用于判定新句子归属。' },
  { term: '录音会话', field: 'recording_session', meaning: '一次按下录音到停止之间的连续素材，落成一个 WAV。' },
  { term: '录音片段', field: 'voice_segment', meaning: '绑定到画本行的成品音频片段（可能由某个 take 裁切而来）。' },
  { term: '试录', field: 'take', meaning: '同一画本行的多次录制版本，可 A/B 对比后择一。' },
  { term: '对轨', field: 'alignment / arrangement', meaning: '把片段按时间线排布成整章轨道，处理留白与重叠。' },
  { term: '任务包', field: '.nst', meaning: '下发给单个配音员的角色子集 + 空白录音位。' },
  { term: '项目包', field: '.nsp', meaning: '整个项目的可迁移归档（含数据库、录音与成品）。' },
]

// ============================================================================
// FAQ（每条都给「去设置改哪里」的深链，走与提示条相同的 focus 机制）
// ============================================================================

interface FaqAction {
  label: string
  path: string
  focus?: string
}

interface FaqDef {
  question: string
  answer: string
  actions: FaqAction[]
}

const FAQS: FaqDef[] = [
  {
    question: '导入后中文全是乱码',
    answer: '多半是编码选错了。导入向导会列出编码候选与预览，挑能读出正常中文的那一个；GBK 会按 GB18030 解码以覆盖生僻字（docs/10 §4）。',
    actions: [
      { label: '去导入向导', path: '/import' },
      { label: '设置：编码相关', path: '/settings', focus: 'ENCODING_UNCERTAIN' },
    ],
  },
  {
    question: 'PDF 导入后没有文字',
    answer: '扫描版 PDF 里没有文本层，本版本不做 OCR：请改用 TXT，或先用外部工具做 OCR 再导入。',
    actions: [
      { label: '去导入向导', path: '/import' },
      { label: '设置：导入上限', path: '/settings', focus: 'PDF_NO_TEXT_LAYER' },
    ],
  },
  {
    question: '导出时提示有缺录行',
    answer: '这一章里还有画本行没有绑定音频。回到对轨页可以看到缺录清单，补齐后再导出；也可以刻意跳过（导出报告里会记为缺失）。',
    actions: [
      { label: '去对轨补齐', path: '/alignment' },
      { label: '设置：相关设置', path: '/settings', focus: 'EXPORT_MISSING_LINES' },
    ],
  },
  {
    question: '导出后响度不达标 / 提示目标冲突',
    answer: '目标响度太低而素材动态太大时，需要大幅压限，可能与真峰上限冲突。可把目标响度放宽到 -16 LUFS、真峰设为 -1 dBTP，或在混音台里先做一段压缩。',
    actions: [
      { label: '设置：响度与真峰', path: '/settings', focus: 'EXPORT_LOUDNESS_OUT_OF_RANGE' },
      { label: '打开混音台', path: '/mixing' },
    ],
  },
  {
    question: '录音没有信号，或者电平一直削波',
    answer: '先确认输入设备与增益：设备选错、系统静音、AGC 把底噪抬起来都会出现这两种现象。设备诊断页会测信号、削波与丢帧。',
    actions: [
      { label: '设置：音频与增益', path: '/settings', focus: 'RECORD_NO_SIGNAL' },
      { label: '设备自检', path: '/recording/diagnostics' },
    ],
  },
  {
    question: '提示「未启用语义判定，准确率会下降」',
    answer: '语义模型缺失或校验失败时，画本生成会降级为规则判定（生成报告里 embeddingUsed = false）。把模型文件放到模型目录后重新探测即可恢复；期间可以先人工校对。',
    actions: [
      { label: '设置：模型状态', path: '/settings', focus: 'MODEL_MISSING' },
      { label: '设置：向量判定', path: '/settings', focus: 'CANVAS_EMBEDDING_UNAVAILABLE' },
    ],
  },
]

// ============================================================================
// 报障三步与版本信息
// ============================================================================

const info = ref<AppInfo | null>(null)
const paths = ref<AppPaths | null>(null)
const exportBusy = ref(false)
const reportPath = ref<string | null>(null)

/**
 * 导出诊断包（docs/04 §5.4）。
 * 失败原因交给 error-bus：这里用 call() 而不是 callSafe()，这样失败会真的弹出来。
 */
async function exportDiagnostics(): Promise<void> {
  exportBusy.value = true
  try {
    const result = await call('app:diagnostics', undefined)
    reportPath.value = (result as { reportPath: string }).reportPath
  } catch {
    reportPath.value = null
  } finally {
    exportBusy.value = false
  }
}

async function reveal(target: string | null | undefined): Promise<void> {
  if (!target) return
  await callSafe('app:showItemInFolder', { path: target })
}

function go(action: FaqAction | StepAction): void {
  const query = 'focus' in action && action.focus ? { focus: action.focus } : undefined
  void router.push(query ? { path: action.path, query } : { path: action.path })
}

onMounted(async () => {
  const [loadedInfo, loadedPaths] = await Promise.all([
    callSafe('app:getInfo', undefined),
    callSafe('app:getPaths', undefined),
  ])
  if (loadedInfo) info.value = loadedInfo as AppInfo
  if (loadedPaths) paths.value = loadedPaths as AppPaths
})
</script>

<template>
  <div class="ns-help">
    <header class="ns-help__head">
      <h1 class="ns-help__heading">帮助与快捷键</h1>
      <p class="ns-help__sub">
        从一本书到有声成品的六步都在下面；出问题时先看「报障三步」，把错误编号和诊断包一起发给支持。
      </p>
    </header>

    <!-- ── 主链六步 ─────────────────────────────────────────────────── -->
    <section class="ns-card">
      <h2 class="ns-card__title">主链六步：每一步产出什么、下一步做什么</h2>
      <ol class="ns-steps">
        <li v-for="step in STEPS" :key="step.no" class="ns-step">
          <span class="ns-step__icon" aria-hidden="true">{{ step.icon }}</span>
          <div class="ns-step__body">
            <h3 class="ns-step__title">
              <span class="ns-step__no">{{ step.no }}</span>{{ step.title }}
            </h3>
            <p class="ns-step__line"><strong>产出：</strong>{{ step.output }}</p>
            <p class="ns-step__line ns-step__line--next"><strong>下一步：</strong>{{ step.next }}</p>
            <div class="ns-step__actions">
              <el-button
                v-for="action in step.actions"
                :key="action.path + action.label"
                size="small"
                @click="go(action)"
              >
                {{ action.label }}
              </el-button>
            </div>
          </div>
        </li>
      </ol>
    </section>

    <!-- ── 快捷键速查 ───────────────────────────────────────────────── -->
    <section class="ns-card">
      <h2 class="ns-card__title">快捷键速查</h2>
      <p class="ns-card__note">
        <strong>录音页会接管全局快捷键</strong>：只有停留在录音页（以及连续录制确认页）时下面这些键才生效，
        在其他页面按它们不会有任何反应，也不会影响你在输入框里打字。
        当前状态：
        <el-tag size="small" :type="capturing ? 'warning' : 'info'">
          {{ capturing ? '正在接管快捷键' : '未接管' }}
        </el-tag>
        录音页的四个常用键（停止 / 下一行 / 重录 / 播放）可以在「设置 → 录音」里改。
      </p>

      <div class="ns-shortcuts">
        <div class="ns-shortcuts__group">
          <h3 class="ns-shortcuts__title">录音页（scope = recording）</h3>
          <table class="ns-table">
            <thead>
              <tr><th>按键</th><th>动作</th><th>绑定标识</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in recordingShortcuts" :key="row.id">
                <td><kbd class="ns-kbd">{{ row.display }}</kbd></td>
                <td>{{ row.label ?? row.id }}</td>
                <td class="ns-table__mono">{{ row.id }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="ns-shortcuts__group">
          <h3 class="ns-shortcuts__title">待确认队列（scope = review）</h3>
          <table class="ns-table">
            <thead>
              <tr><th>按键</th><th>动作</th><th>绑定标识</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in reviewShortcuts" :key="row.id">
                <td><kbd class="ns-kbd">{{ row.display }}</kbd></td>
                <td>{{ row.label ?? row.id }}</td>
                <td class="ns-table__mono">{{ row.id }}</td>
              </tr>
            </tbody>
          </table>
          <p class="ns-card__note">
            队列是全键盘操作的：数字键选候选、Enter 确认并跳下一行、S 跳过、Z 撤销，
            目标是 3 分钟清 100 行（docs/11 §4.5）。
          </p>
        </div>
      </div>
    </section>

    <!-- ── 报障三步 ─────────────────────────────────────────────────── -->
    <section class="ns-card" data-anchor="help.report">
      <h2 class="ns-card__title">报障三步</h2>
      <ol class="ns-report">
        <li>
          <strong>记下提示里的编号</strong>（形如 <code>E400012</code>）。
          提示条上就有；事后也可以在「设置 → 日志与诊断」的实时日志流里找到。
        </li>
        <li>
          <strong>点「导出诊断包」</strong>。
          诊断包里是脱敏后的配置、最近 3 天日志、崩溃清单与任务历史（不含作品正文与密钥）。
        </li>
        <li>
          <strong>把编号与诊断包一起发给支持</strong>。
          有了编号，支持人员可以直接定位到消息表条目，不必靠描述猜问题。
        </li>
      </ol>

      <div class="ns-report__actions">
        <el-button type="primary" :loading="exportBusy" @click="exportDiagnostics">导出诊断包</el-button>
        <template v-if="reportPath">
          <code class="ns-path">{{ reportPath }}</code>
          <el-button size="small" @click="reveal(reportPath)">打开所在文件夹</el-button>
        </template>
        <el-button size="small" @click="go({ label: '日志与诊断', path: '/settings', focus: 'diagnostics' })">
          打开日志与诊断
        </el-button>
      </div>
    </section>

    <!-- ── 术语速查 ─────────────────────────────────────────────────── -->
    <section class="ns-card">
      <h2 class="ns-card__title">术语速查</h2>
      <table class="ns-table ns-table--terms">
        <thead>
          <tr><th>术语</th><th>英文 / 字段</th><th>含义</th></tr>
        </thead>
        <tbody>
          <tr v-for="term in TERMS" :key="term.field">
            <td>{{ term.term }}</td>
            <td class="ns-table__mono">{{ term.field }}</td>
            <td>{{ term.meaning }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ── FAQ ─────────────────────────────────────────────────────── -->
    <section class="ns-card">
      <h2 class="ns-card__title">常见问题</h2>
      <dl class="ns-faq">
        <div v-for="faq in FAQS" :key="faq.question" class="ns-faq__item">
          <dt class="ns-faq__q">{{ faq.question }}</dt>
          <dd class="ns-faq__a">
            <p class="ns-faq__text">{{ faq.answer }}</p>
            <div class="ns-faq__actions">
              <el-button
                v-for="action in faq.actions"
                :key="action.path + (action.focus ?? '')"
                size="small"
                @click="go(action)"
              >
                {{ action.label }}
              </el-button>
            </div>
          </dd>
        </div>
      </dl>
      <p class="ns-card__note">
        带「设置」的按钮会带着定位标记跳过去：设置页会自动切到对应分类、高亮相关项并滚动到它，
        与提示条上的「前往设置」是同一套逻辑（docs/22 §7）。
      </p>
    </section>

    <!-- ── 版本信息 ─────────────────────────────────────────────────── -->
    <section class="ns-card">
      <h2 class="ns-card__title">版本与路径</h2>
      <dl class="ns-kv">
        <div class="ns-kv__row"><dt>应用版本</dt><dd>{{ info?.version ?? '—' }}</dd></div>
        <div class="ns-kv__row"><dt>Electron / Node / Chrome</dt><dd>{{ info ? `${info.electron} / ${info.node} / ${info.chrome}` : '—' }}</dd></div>
        <div class="ns-kv__row"><dt>平台 / 架构</dt><dd>{{ info ? `${info.platform} ${info.arch}` : '—' }}</dd></div>
        <div class="ns-kv__row">
          <dt>运行形态</dt>
          <dd>
            {{ info?.isPackaged ? '打包版' : '开发模式' }}
            <el-tag v-if="info?.portable" size="small" effect="plain">便携版</el-tag>
          </dd>
        </div>
        <div class="ns-kv__row"><dt>用户数据目录</dt><dd><span class="ns-table__mono">{{ paths?.userData ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.userData)">打开</el-button></dd></div>
        <div class="ns-kv__row"><dt>项目根目录</dt><dd><span class="ns-table__mono">{{ paths?.projectRoot ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.projectRoot)">打开</el-button></dd></div>
        <div class="ns-kv__row"><dt>导出目录</dt><dd><span class="ns-table__mono">{{ paths?.exportDir ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.exportDir)">打开</el-button></dd></div>
        <div class="ns-kv__row"><dt>日志目录</dt><dd><span class="ns-table__mono">{{ paths?.logDir ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.logDir)">打开</el-button></dd></div>
        <div class="ns-kv__row"><dt>备份目录</dt><dd><span class="ns-table__mono">{{ paths?.backupDir ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.backupDir)">打开</el-button></dd></div>
        <div class="ns-kv__row"><dt>模型目录</dt><dd><span class="ns-table__mono">{{ paths?.modelDir ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.modelDir)">打开</el-button></dd></div>
        <div class="ns-kv__row"><dt>资源目录</dt><dd><span class="ns-table__mono">{{ paths?.resourceDir ?? '—' }}</span><el-button v-if="paths" size="small" link @click="reveal(paths.resourceDir)">打开</el-button></dd></div>
      </dl>
      <p class="ns-card__note">
        报障时请把上面的版本信息一并附上（诊断包里已经包含，不必手抄）。
      </p>
    </section>
  </div>
</template>

<style scoped>
.ns-help {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.ns-help__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-help__heading {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 20px;
}
.ns-help__sub {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-card {
  padding: 14px 16px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-card__title {
  margin: 0 0 10px;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ns-card__note {
  margin: 8px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.8;
}
.ns-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ns-step {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--ns-border, #dcdfe6);
}
.ns-step:last-child {
  border-bottom: none;
}
.ns-step__icon {
  font-size: 22px;
  line-height: 1.2;
}
.ns-step__body {
  flex: 1;
  min-width: 0;
}
.ns-step__title {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-step__no {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--ns-primary, #409eff);
  color: #fff;
  font-size: 11px;
}
.ns-step__line {
  margin: 0 0 2px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
.ns-step__line--next {
  color: var(--ns-text-secondary, #909399);
}
.ns-step__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.ns-shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.ns-shortcuts__group {
  flex: 1 1 320px;
  min-width: 300px;
}
.ns-shortcuts__title {
  margin: 0 0 6px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.ns-table th,
.ns-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--ns-fill, #ebeef5);
  color: var(--ns-text-regular, #606266);
  text-align: left;
  vertical-align: top;
}
.ns-table th {
  color: var(--ns-text-secondary, #909399);
  font-weight: 600;
}
.ns-table--terms td:first-child {
  white-space: nowrap;
}
.ns-table__mono {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}
.ns-kbd {
  display: inline-block;
  min-width: 30px;
  padding: 1px 6px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-primary, #303133);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  text-align: center;
}
.ns-report {
  margin: 0;
  padding-left: 20px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.9;
}
.ns-report code,
.ns-path {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  font-family: ui-monospace, Consolas, monospace;
}
.ns-report__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}
.ns-path {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  word-break: break-all;
}
.ns-faq {
  margin: 0;
}
.ns-faq__item {
  padding: 10px 0;
  border-bottom: 1px dashed var(--ns-border, #dcdfe6);
}
.ns-faq__item:last-child {
  border-bottom: none;
}
.ns-faq__q {
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  font-weight: 600;
}
.ns-faq__a {
  margin: 4px 0 0;
}
.ns-faq__text {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.8;
}
.ns-faq__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.ns-kv {
  margin: 0;
}
.ns-kv__row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.7;
}
.ns-kv__row dt {
  flex: 0 0 170px;
  color: var(--ns-text-secondary, #909399);
}
.ns-kv__row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ns-text-regular, #606266);
  word-break: break-all;
}
</style>
