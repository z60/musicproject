/**
 * Novel Studio · 任务包回收合并（全流程最关键的一环）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §9 合并规则表（linesHash 不一致 / 同 line 多 take / 缺漏 / 未知 lineId / 音质异常）
 *   · docs/11 §6.4 回收合并流程图（读包校验 → 比对 linesHash → 逐行归位 → 冲突处理 → 生成报告）
 *   · docs/11 §6.4「回收报告必须落到 UI 上，并允许『一键把新 take 设为成品』」
 *
 * 逐条落实的规则：
 *   1. `linesHash` 不一致 → 计算差异（新增/删除/修改的行数）→ 生成 `PACKAGE_LINES_CHANGED` 报告，
 *      **仍按 lineId 尽量归位**（不因为画本改了就把配音员的活儿丢掉）
 *   2. `lineId` 存在 → 音频归位为 take；不存在 → 进 `unknown`（**不入库**）
 *   3. 同 line 已有 take → 新 take **追加（不覆盖）**，计入 `duplicateTakes`
 *   4. 同 line 同 takeId 重复回传 → 按**内容哈希**去重（内容相同才去重；内容不同视为重录，追加）
 *   5. 校验失败 / 损坏文件 → 跳过并记录，**绝不整体失败**
 *   6. 产出 `TaskPackageMergeReport`（字段见 src/shared/types.ts）
 *   7. 原本没录音的行被回传 → 可「设为成品」，计入 `adopted`
 *
 * 落盘与入库都是**注入式**（`hooks.writeTake` / `hooks.insertTake` / `hooks.adoptTake`）：
 * 这样合并逻辑本身可以被完整测试，且本模块不依赖 better-sqlite3 与 fs。
 */

import type { Id, NstManifest, TaskPackageMergeReport, Timestamp } from '../../../../shared/types.ts'
import { AppError } from '../../../../shared/errors.ts'
import { parseChecksumsFile, sha256Hex, verifyPackage } from './checksums.ts'
import type { ZipReader } from './zip/reader.ts'
import {
  CHECKSUMS_FILE,
  TAKES_FILE,
} from './manifest.ts'
import {
  computeLinesHash,
  diffLines,
  listSlotEntries,
  parseTakesFile,
  type LinesDiff,
  type LinesHashInput,
} from './nst.ts'
import { checkWavCompliance, probeWav } from './wav.ts'
import type { CanvasLine, NstLine } from '../../../../shared/types.ts'

// ============================================================================
// 类型
// ============================================================================

export type ChecksumStatus = 'ok' | 'mismatch' | 'unreadable' | 'not-checked'

/** 包内一条待归位的音频 */
export interface PackageTake {
  lineId: Id
  takeId: Id
  /** 包内路径（`slots/{lineId}/{takeId}.wav`） */
  fileName: string
  durationMs: number
  peakDb: number | null
  recordedAt: Timestamp
  device: string | null
  /** 音频字节；null 表示读不出来（计入 corrupted） */
  bytes?: Uint8Array | null
  /** 内容哈希（缺省时由 bytes 计算），用于重复回传去重 */
  contentHash?: string
  /** 逐文件校验结果 */
  checksum?: ChecksumStatus
  /** 音频头合规问题（采样率/位深不符等，**不阻断归位**） */
  auditIssues?: string[]
}

export interface MergeLocalTake {
  lineId: Id
  takeId: Id
  /** 已有 take 的内容哈希（可选）；用于「同 takeId 重复回传」的内容级去重 */
  contentHash?: string | null
}

export interface MergeLocalState {
  /** 当前画本行（用于 linesHash 比对与 lineId 是否存在） */
  lines: ReadonlyArray<LinesHashInput | CanvasLine | NstLine>
  /** 本地已有 take */
  existingTakes?: readonly MergeLocalTake[]
  /** 该行是否已有成品片段；缺省时按 existingTakes 推断 */
  hasSegment?: (lineId: Id) => boolean
}

export type MergeSkipReason =
  | 'unknown-line'
  | 'checksum-mismatch'
  | 'corrupted'
  | 'duplicate'
  | 'write-failed'
  | 'audit-failed'
  | 'cancelled'

export interface MergeSkip {
  lineId: Id | null
  takeId: Id | null
  fileName: string | null
  reason: MergeSkipReason
  message: string
}

export interface WriteTakeResult {
  /** 入库用的相对路径（相对项目根，docs/03 §2 相对路径原则） */
  filePath: string
}

export interface MergeHooks {
  /**
   * 把音频写进 `takes/{lineId}/{takeId}.wav`，返回相对路径。
   * 不实现写盘（本模块不做 IO），由主进程的音频仓储注入。
   */
  writeTake?: (
    input: { lineId: Id; takeId: Id; fileName: string; bytes: Uint8Array; contentHash: string },
  ) => Promise<WriteTakeResult | string> | WriteTakeResult | string
  /**
   * 登记一条 take。返回可选的 `takeId` 覆盖值
   * （当同 line 同 takeId 但内容不同时，仓储可以换一个新 takeId 以避免主键冲突）。
   */
  insertTake?: (
    input: {
      lineId: Id
      takeId: Id
      filePath: string | null
      durationMs: number
      peakDb: number | null
      recordedAt: Timestamp
      device: string | null
      contentHash: string
      /** 该行原本是否已有 take（true = 本次是追加，进 A/B 对比队列） */
      appendedToExisting: boolean
      packageId: Id
    },
  ) => Promise<{ takeId: Id } | void> | { takeId: Id } | void
  /** 把该行「设为成品」（原本没有录音/成品时） */
  adoptTake?: (
    input: { lineId: Id; takeId: Id; filePath: string | null; durationMs: number },
  ) => Promise<void> | void
  /** 跳过回调（写 package_history / 质检报告） */
  onSkip?: (skip: MergeSkip) => void
  onProgress?: (info: { stage: string; progress: number; total: number; done: number }) => void
  signal?: AbortSignal
  now?: () => number
  /** 是否做音频头合规检查（默认 true） */
  validateAudio?: boolean
  /** 音频过短阈值（毫秒），默认 0（不判定） */
  minDurationMs?: number
  /** 原本没录音的行是否自动设为成品，默认 true（docs/11 §6.4） */
  adoptWhenNoRecording?: boolean
}

export interface MergeTaskPackageInput {
  manifest: NstManifest
  takes: readonly PackageTake[]
  local: MergeLocalState
  hooks?: MergeHooks
}

export interface PlacedTake {
  lineId: Id
  takeId: Id
  /** 实际入库的 takeId（可能与包内不同：冲突时仓储换过 id） */
  storedTakeId: Id
  filePath: string | null
  durationMs: number
  contentHash: string
  /** true = 该行原本已有 take，本次是追加 */
  appended: boolean
  /** 原本没有录音 → 本次已设为成品 */
  adopted: boolean
}

export interface MergeTaskPackageResult {
  /** 与 types.ts 的 TaskPackageMergeReport 完全一致（可直接落 package_history） */
  report: TaskPackageMergeReport
  /** 画本差异明细（新增/删除/修改的行） */
  diff: LinesDiff
  placed: PlacedTake[]
  skipped: MergeSkip[]
  /** 音频合规提示（不阻断归位，但要在质检里显示） */
  auditIssues: Array<{ lineId: Id; takeId: Id; issues: string[] }>
  warnings: string[]
  /** 明细计数（report 之外的补充信息，便于 UI 展开） */
  counters: {
    returned: number
    appendedTakes: number
    dedupedTakes: number
    adoptedCount: number
    writeFailed: number
  }
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 合并一个回传任务包（纯逻辑 + 注入式副作用）。
 *
 * **绝不整体失败**：单条音频的任何问题都只影响它自己，其余照常归位。
 */
export async function mergeTaskPackage(input: MergeTaskPackageInput): Promise<MergeTaskPackageResult> {
  const { manifest, takes, local } = input
  const hooks = input.hooks ?? {}
  const now = hooks.now ?? Date.now
  const validateAudio = hooks.validateAudio !== false
  const adoptWhenNoRecording = hooks.adoptWhenNoRecording !== false

  const warnings: string[] = []
  const skipped: MergeSkip[] = []
  const placed: PlacedTake[] = []
  const auditIssues: MergeTaskPackageResult['auditIssues'] = []

  const skip = (s: MergeSkip): void => {
    skipped.push(s)
    hooks.onSkip?.(s)
  }

  // ---- 1) 本地画本索引与已有 take 索引 ----
  const localLineIds = new Set(local.lines.map((l) => (l as { id: Id }).id))
  const existingByLine = new Map<Id, MergeLocalTake[]>()
  for (const t of local.existingTakes ?? []) {
    const list = existingByLine.get(t.lineId)
    if (list) list.push(t)
    else existingByLine.set(t.lineId, [t])
  }
  const hadRecording = (lineId: Id): boolean => {
    if (local.hasSegment) return local.hasSegment(lineId)
    return (existingByLine.get(lineId)?.length ?? 0) > 0
  }

  // ---- 2) linesHash 比对（docs/11 §6.4 第 2 步）----
  const currentHash = computeLinesHash(local.lines)
  const linesChanged = currentHash !== manifest.linesHash
  const diff = diffLines(manifest.lines, local.lines)
  if (linesChanged) {
    warnings.push(
      `画本与下发时有 ${diff.count} 处差异（新增 ${diff.added.length} / 删除 ${diff.removed.length} / 修改 ${diff.modified.length}），已按 lineId 尽力归位`,
    )
  }

  // ---- 3) 逐条归位（docs/11 §6.4 第 3 步）----
  const unknown: Id[] = []
  const unknownSeen = new Set<Id>()
  let checksumFailed = 0
  let corrupted = 0
  let appendedTakes = 0
  let dedupedTakes = 0
  let adoptedCount = 0
  let writeFailed = 0

  const total = takes.length
  let done = 0

  for (const take of takes) {
    if (hooks.signal?.aborted) throw new AppError('TASK_CANCELLED')
    done++
    hooks.onProgress?.({ stage: `归位 ${done}/${total}`, progress: total ? done / total : 1, total, done })

    const lineId = take.lineId
    const takeId = take.takeId

    // 3.1 逐文件校验失败 → 跳过并计数（docs/03 §8 导入规则 2）
    if (take.checksum === 'mismatch') {
      checksumFailed++
      skip({ lineId, takeId, fileName: take.fileName, reason: 'checksum-mismatch', message: '文件内容与校验和不一致，已跳过' })
      continue
    }
    if (take.checksum === 'unreadable' || take.bytes === null || take.bytes === undefined) {
      corrupted++
      skip({ lineId, takeId, fileName: take.fileName, reason: 'corrupted', message: '音频无法读取（文件缺失或解压失败），已跳过' })
      continue
    }

    // 3.2 音频合规检查（损坏 → 跳过；格式不符 → 入库但记提示，docs/03 §9「入库但标记 flags」）
    const bytes = take.bytes
    if (validateAudio) {
      const compliance = checkWavCompliance(bytes, manifest.recordSettings, {
        minDurationMs: hooks.minDurationMs ?? 0,
      })
      const fatal = compliance.issues.filter((i) => i.kind === 'not-wav' || i.kind === 'empty')
      if (fatal.length > 0) {
        corrupted++
        skip({ lineId, takeId, fileName: take.fileName, reason: 'corrupted', message: fatal.map((i) => i.message).join('；') })
        continue
      }
      if (compliance.issues.length > 0) {
        const issues = compliance.issues.map((i) => i.message)
        auditIssues.push({ lineId, takeId, issues })
      }
    }

    // 3.3 lineId 不存在 → 进 unknown，不入库（docs/03 §9）
    if (!localLineIds.has(lineId)) {
      if (!unknownSeen.has(lineId)) {
        unknownSeen.add(lineId)
        unknown.push(lineId)
      }
      skip({ lineId, takeId, fileName: take.fileName, reason: 'unknown-line', message: '画本里已经没有这一行，未入库' })
      continue
    }

    // 3.4 重复回传去重（docs/11 §6.4 第 4 步）
    const contentHash = take.contentHash ?? sha256Hex(bytes)
    const existing = existingByLine.get(lineId) ?? []
    const sameTakeId = existing.find((t) => t.takeId === takeId)
    if (sameTakeId && sameTakeId.contentHash && sameTakeId.contentHash === contentHash) {
      dedupedTakes++
      skip({
        lineId,
        takeId,
        fileName: take.fileName,
        reason: 'duplicate',
        message: '同一 take 重复回传且内容相同，已按内容哈希去重',
      })
      continue
    }
    const appendedToExisting = existing.length > 0
    // ⚠ 必须在落位**之前**判断「原本有没有录音/成品」：
    // 落位后本地索引里就有这条 take 了，会把「原本没录音」误判成「已有」。
    const wasEmptyBefore = !hadRecording(lineId)

    // 3.5 落盘 + 入库（注入式）
    let filePath: string | null = null
    try {
      if (hooks.writeTake) {
        const written = await hooks.writeTake({ lineId, takeId, fileName: take.fileName, bytes, contentHash })
        filePath = typeof written === 'string' ? written : written.filePath
      }
      let storedTakeId = takeId
      if (hooks.insertTake) {
        const inserted = await hooks.insertTake({
          lineId,
          takeId,
          filePath,
          durationMs: take.durationMs,
          peakDb: take.peakDb,
          recordedAt: take.recordedAt || now(),
          device: take.device,
          contentHash,
          appendedToExisting,
          packageId: manifest.packageId,
        })
        if (inserted && typeof inserted.takeId === 'string') storedTakeId = inserted.takeId
      }

      if (appendedToExisting) appendedTakes++

      // 把刚落位的 take 记进本地索引：这样**同一次回传里**再出现同一个
      // (lineId, takeId, 内容) 时也能被去重，而不是重复入库两遍。
      const lineTakes = existingByLine.get(lineId)
      if (lineTakes) lineTakes.push({ lineId, takeId: storedTakeId, contentHash })
      else existingByLine.set(lineId, [{ lineId, takeId: storedTakeId, contentHash }])

      // 3.6 原本没录音的行 → 设为成品（docs/11 §6.4「一键把新 take 设为成品」）
      let adopted = false
      if (wasEmptyBefore && adoptWhenNoRecording && hooks.adoptTake) {
        await hooks.adoptTake({ lineId, takeId: storedTakeId, filePath, durationMs: take.durationMs })
        adoptedCount++
        adopted = true
      }

      placed.push({
        lineId,
        takeId,
        storedTakeId,
        filePath,
        durationMs: take.durationMs,
        contentHash,
        appended: appendedToExisting,
        adopted,
      })
    } catch (e) {
      // 写盘/入库失败只影响这一条，其余继续（绝不整体失败）
      writeFailed++
      skip({
        lineId,
        takeId,
        fileName: take.fileName,
        reason: 'write-failed',
        message: e instanceof Error ? e.message : '写入失败',
      })
    }
  }

  // ---- 4) 缺漏（docs/11 §6.4 第 5 步）----
  const returnedLineIds = new Set(takes.map((t) => t.lineId))
  const missing: Id[] = []
  for (const line of manifest.lines) {
    const id = line.id
    if (!localLineIds.has(id)) continue // 本地已删除的行不需要催录
    if (!returnedLineIds.has(id)) missing.push(id)
  }

  const report: TaskPackageMergeReport = {
    packageId: manifest.packageId,
    actorName: manifest.assignee.name,
    placed: placed.length,
    missing,
    unknown,
    checksumFailed,
    corrupted,
    linesChanged,
    diffCount: diff.count,
    duplicateTakes: appendedTakes + dedupedTakes,
    adopted: adoptedCount,
  }

  if (checksumFailed > 0) warnings.push(`${checksumFailed} 个文件校验不通过，已跳过并列在报告中`)
  if (corrupted > 0) warnings.push(`${corrupted} 个音频损坏或缺失，已跳过`)
  if (unknown.length > 0) warnings.push(`${unknown.length} 行的 lineId 在本地画本中不存在，未入库`)
  if (writeFailed > 0) warnings.push(`${writeFailed} 条音频写入失败，其余已正常归位`)
  if (appendedTakes > 0) warnings.push(`${appendedTakes} 条新 take 已追加（未覆盖原 take），请到 A/B 对比队列挑选`)
  if (adoptedCount > 0) warnings.push(`${adoptedCount} 行原本没有录音，已把回传的 take 设为成品`)

  return {
    report,
    diff,
    placed,
    skipped,
    auditIssues,
    warnings,
    counters: {
      returned: takes.length,
      appendedTakes,
      dedupedTakes,
      adoptedCount,
      writeFailed,
    },
  }
}

// ============================================================================
// 从 zip 读包（校验 + 音频提取）
// ============================================================================

export interface CollectPackageTakesOptions {
  /** `checksums.sha256` 的原文；给了就逐条核对（docs/03 §8 导入规则 2） */
  checksumsText?: string | null
  /** 是否检查音频头合规，默认 true */
  validateAudio?: boolean
  minDurationMs?: number
  onProgress?: (info: { stage: string; progress: number; total: number; done: number }) => void
  signal?: AbortSignal
}

export interface CollectPackageTakesResult {
  takes: PackageTake[]
  skipped: MergeSkip[]
  checksumFailed: number
  corrupted: number
  /** slots/ 下不符合 `{lineId}/{takeId}.wav` 命名的条目 */
  unrecognizedSlots: string[]
  warnings: string[]
  /** takes.json 是否存在/可用 */
  hasTakesFile: boolean
}

/**
 * 从回传包中读出所有音频（含逐文件校验与音频头探测）。
 *
 * 复用 `verifyPackage`：**不匹配的文件跳过并列报告，绝不整体失败**（docs/03 §8 导入规则 2）。
 */
export function collectPackageTakes(
  zip: ZipReader,
  manifest: NstManifest,
  options: CollectPackageTakesOptions = {},
): CollectPackageTakesResult {
  const warnings: string[] = []
  const skipped: MergeSkip[] = []
  const takes: PackageTake[] = []

  const checksumsText = options.checksumsText ?? (zip.has(CHECKSUMS_FILE) ? safeReadText(zip, CHECKSUMS_FILE) : null)
  const expected = checksumsText ? parseChecksumsFile(checksumsText) : []
  const verify = expected.length > 0 ? verifyPackage(zip, expected) : null
  if (expected.length === 0) warnings.push('包内没有可用的 checksums.sha256，已跳过逐文件校验')

  const mismatchSet = new Set(verify?.mismatch ?? [])

  // takes.json 里的录音元数据（时长/峰值/设备），按 `lineId|takeId` 索引
  // （fileName 在回传包里可能只是文件名，也可能是 `lineId/takeId.wav`，用 id 索引最稳）
  let metaById = new Map<
    string,
    { durationMs: number; peakDb: number | null; recordedAt: Timestamp; device: string | null }
  >()
  let hasTakesFile = false
  if (zip.has(TAKES_FILE)) {
    hasTakesFile = true
    const raw = safeReadJson(zip, TAKES_FILE)
    const parsed = parseTakesFile(raw)
    if (parsed) {
      metaById = new Map(
        parsed.takes.map((t) => [
          `${t.lineId}|${t.takeId}`,
          { durationMs: t.durationMs, peakDb: t.peakDb, recordedAt: t.recordedAt, device: t.device },
        ]),
      )
    } else {
      warnings.push('takes.json 结构异常，已忽略并改为按音频头推断时长')
    }
  }

  const { entries: slots, unrecognized } = listSlotEntries(zip)
  const total = slots.length
  let done = 0
  let checksumFailed = 0
  let corrupted = 0

  for (const slot of slots) {
    if (options.signal?.aborted) throw new AppError('TASK_CANCELLED')
    done++
    options.onProgress?.({ stage: `读取音频 ${done}/${total}`, progress: total ? done / total : 1, total, done })

    if (mismatchSet.has(slot.path)) {
      checksumFailed++
      skipped.push({
        lineId: slot.lineId,
        takeId: slot.takeId,
        fileName: slot.path,
        reason: 'checksum-mismatch',
        message: '文件内容与 checksums.sha256 不一致，已跳过',
      })
      continue
    }

    let bytes: Buffer
    try {
      bytes = zip.readEntry(slot.path)
    } catch (e) {
      corrupted++
      skipped.push({
        lineId: slot.lineId,
        takeId: slot.takeId,
        fileName: slot.path,
        reason: 'corrupted',
        message: e instanceof Error ? e.message : '音频读取失败',
      })
      continue
    }

    if (bytes.byteLength === 0) {
      corrupted++
      skipped.push({
        lineId: slot.lineId,
        takeId: slot.takeId,
        fileName: slot.path,
        reason: 'corrupted',
        message: '音频是 0 字节',
      })
      continue
    }

    const info = options.validateAudio === false ? null : probeWav(bytes)
    if (options.validateAudio !== false && !info) {
      corrupted++
      skipped.push({
        lineId: slot.lineId,
        takeId: slot.takeId,
        fileName: slot.path,
        reason: 'corrupted',
        message: '不是可识别的 WAV 文件（文件头损坏）',
      })
      continue
    }

    const meta = metaById.get(`${slot.lineId}|${slot.takeId}`)
    takes.push({
      lineId: slot.lineId,
      takeId: slot.takeId,
      fileName: slot.path,
      durationMs: meta?.durationMs ?? info?.durationMs ?? 0,
      peakDb: meta?.peakDb ?? null,
      recordedAt: meta?.recordedAt ?? 0,
      device: meta?.device ?? null,
      bytes,
      contentHash: sha256Hex(bytes),
      checksum: verify ? (mismatchSet.has(slot.path) ? 'mismatch' : 'ok') : 'not-checked',
    })
  }

  if (unrecognized.length > 0) {
    warnings.push(`slots/ 下有 ${unrecognized.length} 个条目命名不符合 {lineId}/{takeId}.wav，已忽略`)
  }
  void manifest

  return { takes, skipped, checksumFailed, corrupted, unrecognizedSlots: unrecognized, warnings, hasTakesFile }
}

/** 一站式：读包 → 合并 */
export async function mergeTaskPackageFromZip(input: {
  zip: ZipReader
  manifest: NstManifest
  local: MergeLocalState
  hooks?: MergeHooks
  checksumsText?: string | null
}): Promise<MergeTaskPackageResult & { collect: CollectPackageTakesResult }> {
  const collect = collectPackageTakes(input.zip, input.manifest, {
    checksumsText: input.checksumsText,
    validateAudio: input.hooks?.validateAudio,
    minDurationMs: input.hooks?.minDurationMs,
    signal: input.hooks?.signal,
    onProgress: input.hooks?.onProgress,
  })
  const result = await mergeTaskPackage({
    manifest: input.manifest,
    takes: collect.takes,
    local: input.local,
    hooks: input.hooks,
  })
  return {
    ...result,
    // collect 阶段（读取/校验/音频头探测）拦下的问题也必须计入报告 ——
    // 否则「校验失败」与「损坏文件」会在 UI 上凭空消失，用户以为包是干净的。
    report: {
      ...result.report,
      checksumFailed: result.report.checksumFailed + collect.checksumFailed,
      corrupted: result.report.corrupted + collect.corrupted,
    },
    skipped: [...collect.skipped, ...result.skipped],
    warnings: [...collect.warnings, ...result.warnings],
    counters: {
      ...result.counters,
      returned: collect.takes.length + collect.skipped.length,
    },
    // 把收集阶段的明细一并交出：调用方（归位 UI）要展示「哪些槽位被忽略、为什么被跳过」，
    // 只给汇总计数会让这些问题在界面上凭空消失。
    collect,
  }
}

function safeReadText(zip: ZipReader, name: string): string | null {
  try {
    return zip.readText(name)
  } catch {
    return null
  }
}

function safeReadJson(zip: ZipReader, name: string): unknown {
  const text = safeReadText(zip, name)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
