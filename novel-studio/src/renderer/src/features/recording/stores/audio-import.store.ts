/**
 * 录音域 · 「按说话人导入音频」向导状态
 * ============================================================================
 * 设计依据：docs/12 录音域、docs/91 §5.2.49
 *
 * ## 为什么是「扫描 → 预览 → 修正 → 导入」四步，而不是一键导入
 *
 * 真实样本暴露出三种**必须让人看一眼**的情况：
 *   1. **CV 名对不上**（把画本里的 `春哥拿大顶` 写成 `春哥那个哥`）——
 *      自动猜会静默把音频绑到错误角色，错误会一路流到对轨与成品
 *   2. **区间里有章节不在画本内**（文件名 `2127-2300` vs 画本 `2201-2300`）——
 *      要明确告诉用户「74 章不在画本里」，而不是默默按交集导入
 *   3. **同一行被多个文件覆盖** —— 会产生多条 take 抢同一行
 *
 * 所以前三步**只读**（不写库），第四步才写，且必须显式确认。
 * 这样「点错了」最坏也只是白扫一遍，不会往库里塞错数据。
 *
 * ## 为什么修正后要「重新预览」而不是本地改数字
 *
 * 人工指定角色后，**命中的行数会变**（多角色 → 单角色会变少）。
 * 如果在本地直接改那一行显示的数字，用户看到的就会和实际导入不一致 ——
 * 正是本功能最要避免的「预览与导入漂移」。
 * 所以修正只更新 overrides，**行数永远由主进程重算**。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { callSafe } from '@/shared/lib/ipc.ts'
import { cloneForIpc } from '@/shared/lib/clone.ts'
import type {
  AudioImportApplyResult,
  AudioImportCanvasScan,
  AudioImportCandidate,
  AudioImportFileOverride,
  AudioImportFilePlan,
  AudioImportPlan,
} from '@shared/types.ts'

/** 向导步骤（UI 用 el-steps 展示） */
export type ImportWizardStep = 'select' | 'scan' | 'preview' | 'done'

export const useAudioImportStore = defineStore('recording/audioImport', () => {
  // ── 选择的输入 ─────────────────────────────────────────────────────────────
  /** 画本文件（.docx / .txt） */
  const canvasPath = ref<string | null>(null)
  /** 音频文件夹 */
  const audioDir = ref<string | null>(null)
  /** 是否递归扫描子目录 */
  const recursive = ref(false)

  // ── 扫描结果 ───────────────────────────────────────────────────────────────
  const canvasScan = ref<AudioImportCanvasScan | null>(null)
  const candidates = ref<AudioImportCandidate[]>([])
  const plan = ref<AudioImportPlan | null>(null)
  const result = ref<AudioImportApplyResult | null>(null)
  /**
   * 正在跑（或刚提交）的导入任务 id。
   *
   * 非空 = 导入已提交为后台任务：视图据此渲染 `TaskProgressCard`，
   * 并在 `task:finished` 时把结果交给 `acceptTaskResult`。
   */
  const applyTaskId = ref<string | null>(null)

  // ── 人工修正：filePath → overrides ─────────────────────────────────────────
  /**
   * 只存「用户改过什么」，不存整份计划。
   *
   * 好处：`refreshPlan` 重新拉取时，修正会**自动重新应用**，
   * 不会出现「重新预览后用户的修正丢了」。
   */
  const overrides = ref<Record<string, AudioImportFileOverride>>({})

  const step = ref<ImportWizardStep>('select')
  const busy = ref(false)
  /** 当前正在进行的动作名（用于按钮 loading 文案） */
  const busyLabel = ref('')
  const lastError = ref<unknown>(null)

  // ── 派生 ───────────────────────────────────────────────────────────────────
  const files = computed<AudioImportFilePlan[]>(() => plan.value?.files ?? [])
  const summary = computed(() => plan.value?.summary ?? null)

  /** 只选音频目录即可扫描：画本直接用数据库里已导入的那份（不需要再选画本文件） */
  const canScan = computed(() => Boolean(audioDir.value))
  /** 有「就绪」或「需确认」的文件才能导入 */
  const canImport = computed(() => Boolean(plan.value && plan.value.summary.totalLines > 0))
  /** 需要用户处理的文件（未解析 / 需确认） */
  const filesNeedingAttention = computed(() =>
    files.value.filter((f) => f.status === 'needs-review' || f.status === 'unresolved-speaker'),
  )

  /** 只导入勾选的文件：默认全选「就绪 / 需确认 / 重叠」的 */
  const selectedFiles = ref<Record<string, boolean>>({})

  function selectedFileNames(): string[] {
    return files.value.filter((f) => selectedFiles.value[f.fileName] === true).map((f) => f.fileName)
  }

  /** 每次计划刷新后，把「可导入」的文件默认勾上（用户改过的保留） */
  function syncSelection(): void {
    const next: Record<string, boolean> = {}
    for (const f of files.value) {
      const importable = f.status === 'ready' || f.status === 'needs-review' || f.status === 'duplicate-lines'
      const prev = selectedFiles.value[f.fileName]
      next[f.fileName] = importable ? (prev === undefined ? true : prev) : false
    }
    selectedFiles.value = next
  }

  // ── 动作 ───────────────────────────────────────────────────────────────────
  async function pickCanvas(): Promise<void> {
    // `callSafe` 直接返回**数据**（失败返回 null 并已静默记日志），
    // 不是 `{ ok, data }` 那种结果对象 —— 所以这里判 null 而不是 .ok
    const r = await callSafe('app:openFileDialog', {
      title: '选择画本文件',
      filters: [
        { name: '画本文档', extensions: ['docx', 'txt', 'md'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    // null = 调用失败（错误已上报）；paths 为空 = 用户取消，两者都不该改状态
    const path = r?.paths[0]
    if (path) {
      canvasPath.value = path
      // 换了画本，之前的计划与修正全部失效（章节/角色都可能不同）
      resetPlan()
    }
  }

  async function pickAudioDir(): Promise<void> {
    const r = await callSafe('app:openFolderDialog', { title: '选择音频文件夹' })
    if (r?.path) {
      audioDir.value = r.path
      candidates.value = []
      resetPlan()
    }
  }

  function resetPlan(): void {
    plan.value = null
    canvasScan.value = null
    result.value = null
    selectedFiles.value = {}
    step.value = audioDir.value ? 'scan' : 'select'
  }

  /**
   * 并发守卫：尝试取得「正在忙」的所有权。
   *
   * ### 为什么需要它（`busy` 原来只用来显示 loading，没真挡住重复调用）
   *   用户双击按钮、或界面上还有别的入口时，两次 `importApply` 会**并发写库** ——
   *   同一行插入两条 `partIndex` 相同的 take，之后
   *   「按 partIndex 排序 === 录制顺序」这个约定就不成立了。
   *   按钮上的 `:disabled="busy"` 只是 UI 层的软防护，store 必须自己再挡一次。
   *
   * ### 为什么用「先检查再置位」而不是「置位后再判断」
   *   早期写法是 `busy = true; let owns = true` —— `owns` 恒为真，是**死代码**，
   *   守卫根本没生效。改成一个函数：只有真正拿到的调用返回 true，
   *   拿不到的立刻返回 false **且不动 `busy`**（否则会把正在跑的那次的状态清掉）。
   */
  function tryOwn(): boolean {
    if (busy.value) return false
    busy.value = true
    return true
  }

  /** ① 扫描画本 + 音频目录 */
  async function scan(input: { projectId: string; bookId: string }): Promise<boolean> {
    if (!audioDir.value) return false
    if (!tryOwn()) return false
    busyLabel.value = '正在扫描画本与音频文件…'
    lastError.value = null
    try {
      const [scanRes, filesRes] = await Promise.all([
        // `canvasPath` 省略 = 用数据库里已导入的画本；只有用户显式选了文件才传
        callSafe('record:importScanCanvas', {
          projectId: input.projectId,
          bookId: input.bookId,
          ...(canvasPath.value ? { canvasPath: canvasPath.value } : {}),
        }),
        callSafe('record:importScanFiles', {
          dir: audioDir.value,
          recursive: recursive.value,
        }),
      ])
      // 两个都必须成功：少了画本不知道有哪些行，少了文件列表没什么可导
      if (!scanRes || !filesRes) {
        lastError.value = { title: '扫描失败', detail: '画本或音频目录读取失败，详情见日志' }
        return false
      }
      canvasScan.value = scanRes
      candidates.value = filesRes
      step.value = 'scan'
      return true
    } finally {
      busy.value = false
      busyLabel.value = ''
    }
  }

  /**
   * ② 生成预览。
   *
   * 修正后**必须**重跑这里的逻辑（而不是本地改数字）—— 见文件头说明。
   */
  async function refreshPlan(input: { projectId: string; bookId: string }): Promise<boolean> {
    if (candidates.value.length === 0) return false
    if (!tryOwn()) return false // 并发守卫，见 `tryOwn` 的说明
    busyLabel.value = '正在匹配画本行…'
    lastError.value = null
    try {
      const reqFiles = candidates.value.map((c) => ({
        filePath: c.filePath,
        ...(overrides.value[c.filePath] ? { overrides: overrides.value[c.filePath] } : {}),
      }))
      /**
       * ⚠️ 必须经 `cloneForIpc`：`candidates` 与 `overrides` 都是 Vue 响应式 **Proxy**，
       * 而 IPC 的结构化克隆**不能序列化 Proxy**。
       *
       * 一旦用户设过「人工修正」（例如在对话框里选了 CV），载荷里就带上了 Proxy，
       * 请求直接抛 `DataCloneError` —— 界面只看到一句「生成预览失败 / 主进程未能完成匹配」，
       * 而**最初**（overrides 还是空对象时）却是好的。真机事故同 docs/91 §5.2.5。
       */
      const r = await callSafe('record:importPlan', cloneForIpc({
        projectId: input.projectId,
        bookId: input.bookId,
        ...(canvasPath.value ? { canvasPath: canvasPath.value } : {}),
        files: reqFiles,
      }))
      if (!r) {
        lastError.value = { title: '生成预览失败', detail: '主进程未能完成匹配，详情见日志' }
        return false
      }
      plan.value = r.plan
      canvasScan.value = r.scan
      syncSelection()
      step.value = 'preview'
      return true
    } finally {
      busy.value = false
      busyLabel.value = ''
    }
  }

  /** 记录人工修正（不立即重算；由 UI 决定何时调 `refreshPlan`） */
  function setOverride(filePath: string, patch: AudioImportFileOverride | null): void {
    if (patch === null) {
      const next = { ...overrides.value }
      delete next[filePath]
      overrides.value = next
      return
    }
    overrides.value = { ...overrides.value, [filePath]: { ...overrides.value[filePath], ...patch } }
  }

  function overrideOf(filePath: string): AudioImportFileOverride | undefined {
    return overrides.value[filePath]
  }

  /**
   * ③ 执行导入（写库）——**作为后台任务**（`record:importStart`）。
   *
   * 为什么改任务：一个文件要「解码 → 逐帧能量 → VAD → 铺满每行」，几十个文件是几分钟。
   * 同步调用时渲染进程只能一直转圈、不能离开向导；做成任务后可以关掉向导，
   * 在任务中心看进度，失败还能重试（真机需求：「导入变为后台的一个任务」）。
   *
   * 返回 `true` 只表示**已成功入队**；最终结果由 `applyTaskId` + `task:finished` 落地
   * （见 `acceptTaskResult`）。
   */
  async function apply(input: { projectId: string; bookId: string; skipNeedsReview?: boolean }): Promise<boolean> {
    // ⚠️ 画本文件是**可选**的（省略则用数据库里已导入的画本）。
    // 这里原来写的是 `if (!canvasPath.value) return false` —— 不选画本时
    // 「导入选中的文件」会**静默返回 false**，界面看起来就是「按钮点不动」。
    if (candidates.value.length === 0) return false
    // 并发守卫**在这里尤其重要**：两次 apply 会并发写库，产生重复 take
    if (!tryOwn()) return false
    busyLabel.value = '正在导入音频…'
    lastError.value = null
    try {
      const only = selectedFileNames()
      // 一个都没勾选 → 不动作。**不能**就这么发下去：`onlyFiles` 为空会被契约
      // 理解为「不限制 → 导入全部就绪文件」，与「导入选中的 N 个」自相矛盾。
      if (only.length === 0) {
        lastError.value = { title: '没有勾选任何文件', detail: '请在表格「导入」列至少勾选一个文件' }
        return false
      }
      const reqFiles = candidates.value.map((c) => ({
        filePath: c.filePath,
        ...(overrides.value[c.filePath] ? { overrides: overrides.value[c.filePath] } : {}),
      }))
      // 同 `refreshPlan`：overrides 是响应式 Proxy，必须 cloneForIpc 才能过 IPC
      const r = await callSafe('record:importStart', cloneForIpc({
        projectId: input.projectId,
        bookId: input.bookId,
        ...(canvasPath.value ? { canvasPath: canvasPath.value } : {}),
        files: reqFiles,
        ...(only.length > 0 ? { onlyFiles: only } : {}),
        ...(input.skipNeedsReview !== undefined ? { skipNeedsReview: input.skipNeedsReview } : {}),
        // 契约要求显式 true —— 写库不可逆，不该因为一次误触发生
        confirm: true,
      })) as { taskId?: string } | null
      if (!r?.taskId) {
        lastError.value = { title: '导入任务提交失败', detail: '主进程没有返回任务 id，详情见日志' }
        return false
      }
      applyTaskId.value = r.taskId
      return true
    } finally {
      busy.value = false
      busyLabel.value = ''
    }
  }

  /**
   * 任务跑完（`task:finished`）后把结果落到向导上 —— 由视图在订阅到终态时调用。
   *
   * 失败/取消同样走这里：把状态收回来并给出文案，而不是让向导永远停在「导入中」。
   */
  function acceptTaskResult(payload: { status: string; result?: unknown }): void {
    applyTaskId.value = null
    if (payload.status === 'succeeded' && payload.result) {
      result.value = payload.result as AudioImportApplyResult
      step.value = 'done'
      return
    }
    if (payload.status === 'cancelled') {
      lastError.value = { title: '导入已取消', detail: '已写入的 take 会保留（不回滚），未处理的行照旧' }
      return
    }
    lastError.value = {
      title: '导入失败',
      detail: '任务执行失败，可在任务中心查看原因并重试；详情见日志',
    }
  }

  /**
   * 「继续导入」：只清掉**这一批的内容**，保留音频文件夹与画本选择。
   *
   * 与 `reset()` 的区别就是那两个输入：真机上「再导一批」要重新挑一次文件夹很烦，
   * 而多数情况下用户就是在同一个文件夹里分批导（真机需求：「导入一批可以继续导入」）。
   */
  function resetForAnotherBatch(): void {
    canvasScan.value = null
    candidates.value = []
    plan.value = null
    result.value = null
    overrides.value = {}
    selectedFiles.value = {}
    applyTaskId.value = null
    lastError.value = null
    step.value = audioDir.value ? 'scan' : 'select'
  }

  /** 重置整个向导（导入完成后「再导一批」用） */
  function reset(): void {
    canvasPath.value = null
    audioDir.value = null
    canvasScan.value = null
    candidates.value = []
    plan.value = null
    result.value = null
    overrides.value = {}
    selectedFiles.value = {}
    step.value = 'select'
    lastError.value = null
    applyTaskId.value = null
  }

  return {
    // 状态
    canvasPath,
    audioDir,
    recursive,
    canvasScan,
    candidates,
    plan,
    result,
    applyTaskId,
    overrides,
    step,
    busy,
    busyLabel,
    lastError,
    selectedFiles,
    // 派生
    files,
    summary,
    canScan,
    canImport,
    filesNeedingAttention,
    // 动作
    pickCanvas,
    pickAudioDir,
    scan,
    refreshPlan,
    setOverride,
    overrideOf,
    selectedFileNames,
    apply,
    acceptTaskResult,
    reset,
    resetForAnotherBatch,
    resetPlan,
  }
})
