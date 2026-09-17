/**
 * Novel Studio · 任务包（.nst）构造、导出行程与解析
 * ============================================================================
 * 设计依据：
 *   · docs/03 §9  `.nst` 任务包格式（task.json / slots / reference / checksums）
 *   · docs/11 §6.2 导出流程（选项：上下文 / 参考音 / 发音提示与备注 / 录音建议）
 *   · docs/11 §6.2 linesHash 口径「对全部行的 id + text + speaker + 情绪 + 停顿 稳定序列化后哈希」
 *   · docs/11 §6.3 配音员侧「保留原始 task.json 与 linesHash 用于比对」
 *   · docs/11 §6.4 回收合并的输入（本文件只负责**读**，归位逻辑在 merge.ts）
 *
 * 包结构：
 *   manifest.json      完整 manifest（通用工具识别用）
 *   task.json          与 manifest 同内容（配音端只需读这一个，docs/03 §9 的 task.json 形状即此）
 *   reference/…        可选参考音
 *   slots/{lineId}/{takeId}.wav   导出时为空目录；回传时被填充
 *   checksums.sha256   逐文件 sha256（不含自身）
 */

import { randomUUID } from 'node:crypto'

import { AppError } from '../../../../shared/errors.ts'
import type {
  CanvasLine,
  Character,
  Id,
  NstLine,
  NstManifest,
  NstTakesFile,
  SpeedMark,
} from '../../../../shared/types.ts'
import {
  CHECKSUMS_FILE,
  MANIFEST_FILE,
  REFERENCE_DIR,
  SLOTS_DIR,
  TASK_FILE,
  TAKES_FILE,
  validateNstManifest,
} from './manifest.ts'
import { formatChecksumsFile, sha256Hex, type ChecksumEntry } from './checksums.ts'
import { throwIfAborted, type ZipWriter } from './zip/writer.ts'
import type { ZipReader } from './zip/reader.ts'

// ============================================================================
// 常量
// ============================================================================

/** 旁白行的角色名（配音端 UI 与包内都用它，保持一处定义） */
export const NARRATION_LABEL = '旁白'

/** linesHash 的算法版本前缀：算法变更时改这里，避免「同样的画本算出不同的哈希」被当成画本已改 */
export const LINES_HASH_ALGORITHM = 'ns-lines-v1'

// ============================================================================
// buildNstLine（docs/03 §9 / docs/11 §6.2）
// ============================================================================

/** 上下文行的形态：可以直接给文本，也可以给「说话人 + 文本」以便渲染成「（药老）小子，别冲动。」 */
export interface NstNeighborLine {
  text: string
  characterName?: string | null
}

export interface NstLineBuildContext {
  /** 章节标题（配音端按章节分组） */
  chapterTitle: string
  /** 上一行（上下文） */
  prev?: NstNeighborLine | string | null
  /** 下一行（上下文） */
  next?: NstNeighborLine | string | null
  /** 是否有参考音（对手戏片段） */
  hasReference?: boolean
  /** 是否包含上下文（docs/11 §6.2 选项，默认 true） */
  includeContext?: boolean
  /** 是否包含表演提示与备注（默认 true） */
  includeNotes?: boolean
  /** 是否包含发音提示（默认 true） */
  includePronunciation?: boolean
  /** 角色表里找不到时的兜底角色名 */
  characterName?: string
}

/** 解析说话人名：旁白 → 「旁白」；角色 → 角色表里的 name；查不到 → 兜底名 */
export function resolveSpeakerName(
  line: Pick<CanvasLine, 'speakerType' | 'characterId'>,
  characters: readonly Character[] | ReadonlyMap<Id, Character>,
  fallback?: string,
): string {
  if (line.speakerType === 'narration' || !line.characterId) return NARRATION_LABEL
  const found = findCharacter(characters, line.characterId)
  return found?.name ?? fallback ?? NARRATION_LABEL
}

function findCharacter(
  characters: readonly Character[] | ReadonlyMap<Id, Character>,
  id: Id,
): Character | undefined {
  if (isMap(characters)) return characters.get(id)
  return characters.find((c) => c.id === id)
}

function isMap(v: readonly Character[] | ReadonlyMap<Id, Character>): v is ReadonlyMap<Id, Character> {
  return typeof (v as ReadonlyMap<Id, Character>).get === 'function'
}

/** 把画本行转成上下文行（自动带上说话人前缀信息） */
export function toNeighborLine(
  line: Pick<CanvasLine, 'text' | 'speakerType' | 'characterId'>,
  characters: readonly Character[] | ReadonlyMap<Id, Character>,
): NstNeighborLine {
  return { text: line.text, characterName: resolveSpeakerName(line, characters) }
}

function formatNeighbor(n: NstNeighborLine | string | null | undefined): string | null {
  if (n === null || n === undefined) return null
  if (typeof n === 'string') return n
  const name = n.characterName?.trim()
  return name ? `（${name}）${n.text}` : n.text
}

/**
 * 由画本行构造任务包行（docs/03 §9 的 `lines[]` 形状）。
 *
 * 字段映射：
 *   characterId   ← line.characterId（旁白为 null）
 *   characterName ← 角色表查名字，旁白为「旁白」
 *   prevLine/nextLine ← 上下文，按 docs/03 §9 的示例渲染成「（药老）小子，别冲动。」
 *   hasReference  ← context.hasReference
 *   emotion / emotionIntensity / speed / pauseAfterMs ← 原样带出（配音端的表演依据）
 *   pronunciation / note ← 受 includePronunciation / includeNotes 开关控制（docs/11 §6.2）
 */
export function buildNstLine(
  line: CanvasLine,
  characters: readonly Character[] | ReadonlyMap<Id, Character>,
  context: NstLineBuildContext,
): NstLine {
  const includeContext = context.includeContext !== false
  const includeNotes = context.includeNotes !== false
  const includePronunciation = context.includePronunciation !== false

  return {
    id: line.id,
    seq: line.seq,
    chapterTitle: context.chapterTitle,
    characterId: line.speakerType === 'narration' ? null : line.characterId,
    characterName: resolveSpeakerName(line, characters, context.characterName),
    text: line.text,
    emotion: line.emotion,
    emotionIntensity: line.emotionIntensity,
    speed: line.speed as SpeedMark | null,
    pauseAfterMs: line.pauseAfterMs,
    pronunciation: includePronunciation ? line.pronunciation : null,
    note: includeNotes ? line.note : null,
    prevLine: includeContext ? formatNeighbor(context.prev) : null,
    nextLine: includeContext ? formatNeighbor(context.next) : null,
    hasReference: context.hasReference === true,
  }
}

/** 批量构造：自动按数组顺序补齐 prev/next 上下文 */
export function buildNstLines(
  lines: readonly CanvasLine[],
  characters: readonly Character[] | ReadonlyMap<Id, Character>,
  context: Omit<NstLineBuildContext, 'prev' | 'next'> & { chapterTitleOf?: (line: CanvasLine) => string },
): NstLine[] {
  return lines.map((line, i) => {
    const prev = i > 0 ? toNeighborLine(lines[i - 1], characters) : null
    const next = i < lines.length - 1 ? toNeighborLine(lines[i + 1], characters) : null
    const chapterTitle = context.chapterTitleOf ? context.chapterTitleOf(line) : context.chapterTitle
    return buildNstLine(line, characters, { ...context, chapterTitle, prev, next })
  })
}

// ============================================================================
// linesHash 与差异比对（docs/11 §6.2 / §6.4）
// ============================================================================

/**
 * 参与 linesHash 的行字段。
 * 既接受画本行（`CanvasLine`）也接受任务包行（`NstLine`），口径保持一致。
 */
export interface LinesHashInput {
  id: Id
  text: string
  /** 优先用它；缺失时退回 speakerType，再退回 'narration' */
  characterId?: Id | null
  speakerType?: string | null
  /** 直接给说话人名（任务包行用 characterName） */
  speaker?: string | null
  emotion?: string | null
  pauseAfterMs?: number
}

/** 一行的稳定签名：`id ␟ text ␟ speaker ␟ emotion ␟ pause` */
export function lineSignature(line: LinesHashInput): string {
  return [line.id, line.text, speakerKey(line), line.emotion ?? '', String(line.pauseAfterMs ?? 0)].join('\u001f')
}

/**
 * 说话人标识（参与 linesHash）。
 *
 * 关键：**画本行与任务包行必须算出同一个键**，否则「下发时的 linesHash」与
 * 「用任务包行重算的 linesHash」会不一致，回收时会把没改过的画本误判成「已变更」。
 *   · 有 characterId → 用 id（最稳定）
 *   · 无 characterId → 把「旁白 / narration / 空」统一成 `narration`
 *   · 其余情况用给定名字（例如角色已删除、只剩名字）
 */
export function speakerKey(line: LinesHashInput): string {
  if (line.characterId) return line.characterId
  const label = line.speaker ?? line.speakerType ?? 'narration'
  if (label === '' || label === 'narration' || label === NARRATION_LABEL) return 'narration'
  return label
}

/** 把画本行 / 任务包行都归一成 hash 输入 */
export function toLinesHashInput(line: LinesHashInput | CanvasLine | NstLine): LinesHashInput {
  const anyLine = line as CanvasLine & NstLine
  return {
    id: anyLine.id,
    text: anyLine.text,
    characterId: anyLine.characterId ?? null,
    speakerType: anyLine.speakerType ?? null,
    speaker: anyLine.characterName ?? null,
    emotion: anyLine.emotion ?? null,
    pauseAfterMs: anyLine.pauseAfterMs ?? 0,
  }
}

/**
 * 计算画本快照哈希（docs/11 §6.2）。
 *
 * 口径：**对全部行的 `id + text + speaker + 情绪 + 停顿` 稳定序列化后 sha256**。
 * 顺序参与计算（画本顺序变化也应被发现），算法版本前缀参与计算（换算法要能被识别）。
 */
export function computeLinesHash(lines: readonly (LinesHashInput | CanvasLine | NstLine)[]): string {
  const payload = lines.map((l) => lineSignature(toLinesHashInput(l))).join('\n')
  return sha256Hex(`${LINES_HASH_ALGORITHM}\n${lines.length}\n${payload}`)
}

export interface LinesDiff {
  /** 画本里新增的行（下发时没有，现在有） */
  added: Id[]
  /** 画本里删掉的行（下发时有，现在没了） */
  removed: Id[]
  /** 内容被改过的行 */
  modified: Id[]
  unchanged: number
  /** added + removed + modified */
  count: number
  changed: boolean
}

/**
 * 比对两份画本（通常是「任务包里的 lines」与「当前画本」）。
 * docs/11 §6.4：不一致时列出增删改的行，仍按 lineId 尽力归位。
 */
export function diffLines(
  previous: readonly (LinesHashInput | CanvasLine | NstLine)[],
  current: readonly (LinesHashInput | CanvasLine | NstLine)[],
): LinesDiff {
  const prevMap = new Map(previous.map((l) => [toLinesHashInput(l).id, lineSignature(toLinesHashInput(l))]))
  const currMap = new Map(current.map((l) => [toLinesHashInput(l).id, lineSignature(toLinesHashInput(l))]))

  const added: Id[] = []
  const removed: Id[] = []
  const modified: Id[] = []
  let unchanged = 0

  for (const [id, sig] of currMap) {
    if (!prevMap.has(id)) added.push(id)
    else if (prevMap.get(id) !== sig) modified.push(id)
    else unchanged++
  }
  for (const id of prevMap.keys()) {
    if (!currMap.has(id)) removed.push(id)
  }

  const count = added.length + removed.length + modified.length
  return { added, removed, modified, unchanged, count, changed: count > 0 }
}

// ============================================================================
// 导出（docs/11 §6.2）
// ============================================================================

export interface TaskPackageExportInput {
  zip: ZipWriter
  manifest: NstManifest
  /** 参考音（对手戏片段）：包内路径为 `reference/{name}` */
  referenceFiles?: ReadonlyArray<{ name: string; data: Uint8Array }>
  /** 是否写一个空的 `slots/` 目录条目（docs/03 §9：导出时为空目录） */
  writeSlotsDir?: boolean
  onProgress?: (info: { stage: string; progress: number; entries: number; bytes: number }) => void
  signal?: AbortSignal
}

export interface TaskPackageExportResult {
  packageId: Id
  linesHash: string
  entries: string[]
  files: number
  uncompressedBytes: number
  bytes: number
}

/**
 * 编排 .nst 导出：manifest.json → task.json → reference/** → checksums.sha256 → slots/ → finalize。
 *
 * 可取消（`signal`）与可观测（`onProgress`）：每一步都先 `throwIfAborted`，
 * 取消时调用 `zip.abort()` 清理半成品后抛 `TASK_CANCELLED`（docs/04 §2 的任务语义）。
 */
export async function exportTaskPackage(input: TaskPackageExportInput): Promise<TaskPackageExportResult> {
  const { zip, manifest } = input
  const report = (stage: string, progress: number): void =>
    input.onProgress?.({ stage, progress, entries: zip.entries.length, bytes: 0 })

  try {
    throwIfAborted(input.signal)
    const manifestJson = JSON.stringify(manifest, null, 2)
    const checksumInputs: ChecksumEntry[] = []

    report('写入 manifest.json', 0.05)
    await zip.addFile(MANIFEST_FILE, Buffer.from(manifestJson, 'utf8'), { store: true })
    checksumInputs.push({ path: MANIFEST_FILE, hash: sha256Hex(manifestJson) })

    throwIfAborted(input.signal)
    report('写入 task.json', 0.15)
    // task.json 与 manifest.json 同内容（docs/03 §9 的 task.json 形状就是完整 manifest），
    // 配音端只读 task.json 即可，通用工具看 manifest.json。
    await zip.addFile(TASK_FILE, Buffer.from(manifestJson, 'utf8'), { store: true })
    checksumInputs.push({ path: TASK_FILE, hash: sha256Hex(manifestJson) })

    const refs = input.referenceFiles ?? []
    for (let i = 0; i < refs.length; i++) {
      throwIfAborted(input.signal)
      const ref = refs[i]
      const path = `${REFERENCE_DIR}/${ref.name}`
      report(`写入参考音 ${i + 1}/${refs.length}`, 0.15 + 0.45 * ((i + 1) / Math.max(1, refs.length)))
      await zip.addFile(path, ref.data)
      checksumInputs.push({ path, hash: sha256Hex(ref.data) })
    }

    throwIfAborted(input.signal)
    report('写入 checksums.sha256', 0.7)
    const checksumsText = formatChecksumsFile(checksumInputs)
    await zip.addFile(CHECKSUMS_FILE, Buffer.from(checksumsText, 'utf8'), { store: true })

    throwIfAborted(input.signal)
    report('准备录音槽位', 0.85)
    if (input.writeSlotsDir !== false) await zip.addDirectory(SLOTS_DIR)

    throwIfAborted(input.signal)
    report('打包完成', 0.95)
    const result = await zip.finalize()
    report('导出完成', 1)
    return {
      packageId: manifest.packageId,
      linesHash: manifest.linesHash,
      entries: result.entries,
      files: result.entries.filter((e) => !e.endsWith('/')).length,
      uncompressedBytes: result.uncompressedBytes,
      bytes: result.bytes,
    }
  } catch (e) {
    await zip.abort()
    throw e
  }
}

/** 便捷构造：随机 packageId（生产应由调用方传入并落库，便于回收时溯源） */
export function createPackageId(): Id {
  return randomUUID()
}

// ============================================================================
// 解析（回传包 / 下发包通用）
// ============================================================================

export interface ParsedTaskPackage {
  manifest: NstManifest
  lines: NstLine[]
  /** takes.json 的内容；缺失或损坏时为 null（损坏只记 warning，不整体失败） */
  takes: NstTakesFile['takes'] | null
  hasTakesFile: boolean
  /** manifest.json 与 task.json 是否一致（不一致时以 task.json 为准并给出 warning） */
  consistent: boolean
  warnings: string[]
}

/**
 * 解析 .nst（下发包或回传包）。
 *
 * @throws `PACKAGE_INVALID`   缺 task.json/manifest.json、JSON 损坏、字段结构非法
 * @throws `PACKAGE_VERSION_TOO_NEW` 包来自更新版本的应用
 */
export function parseTaskPackage(zip: ZipReader): ParsedTaskPackage {
  const warnings: string[] = []
  const hasTask = zip.has(TASK_FILE)
  const hasManifest = zip.has(MANIFEST_FILE)

  if (!hasTask && !hasManifest) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'task-file-missing', expected: [TASK_FILE, MANIFEST_FILE], entries: zip.listEntries().length },
    })
  }

  const readJson = (path: string): unknown => {
    let text: string
    try {
      text = zip.readText(path)
    } catch (e) {
      throw new AppError('PACKAGE_INVALID', { cause: e, details: { reason: 'entry-read-failed', path } })
    }
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new AppError('PACKAGE_INVALID', {
        cause: e,
        details: { reason: 'json-parse-failed', path, textChars: text.length },
      })
    }
  }

  const fromTask = hasTask ? readJson(TASK_FILE) : null
  const fromManifest = hasManifest ? readJson(MANIFEST_FILE) : null

  // task.json 优先（docs/11 §6.3：配音端保留原始 task.json 用于比对）
  const primary = validateNstManifest(fromTask ?? fromManifest)
  let consistent = true
  if (fromTask && fromManifest) {
    const other = validateNstManifest(fromManifest)
    if (other.packageId !== primary.packageId || other.linesHash !== primary.linesHash) {
      consistent = false
      warnings.push('manifest.json 与 task.json 的 packageId/linesHash 不一致，已以 task.json 为准')
    }
  }

  let takes: NstTakesFile['takes'] | null = null
  const hasTakesFile = zip.has(TAKES_FILE)
  if (hasTakesFile) {
    const raw = readJson(TAKES_FILE)
    const parsed = parseTakesFile(raw)
    if (parsed) takes = parsed.takes
    else warnings.push('takes.json 结构异常，已忽略并改为按 slots/ 目录扫描音频')
  }

  return {
    manifest: primary,
    lines: primary.lines,
    takes,
    hasTakesFile,
    consistent,
    warnings,
  }
}

/**
 * 校验 takes.json 形状（docs/03 §9 回传包）。
 * 返回 null 表示结构不可用 —— 调用方应退回「扫描 slots/」而不是让整包失败。
 */
export function parseTakesFile(raw: unknown): NstTakesFile | null {
  if (raw === null || typeof raw !== 'object') return null
  const takes = (raw as { takes?: unknown }).takes
  if (!Array.isArray(takes)) return null
  const out: NstTakesFile['takes'] = []
  for (const t of takes) {
    if (t === null || typeof t !== 'object') return null
    const o = t as Record<string, unknown>
    if (typeof o.lineId !== 'string' || typeof o.takeId !== 'string' || typeof o.fileName !== 'string') return null
    out.push({
      lineId: o.lineId,
      takeId: o.takeId,
      fileName: o.fileName,
      durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
      peakDb: typeof o.peakDb === 'number' ? o.peakDb : null,
      recordedAt: typeof o.recordedAt === 'number' ? o.recordedAt : 0,
      device: typeof o.device === 'string' ? o.device : null,
    })
  }
  return { takes: out }
}

// ============================================================================
// slots 目录扫描（回传包的真实音频来源）
// ============================================================================

export interface SlotEntry {
  /** `slots/{lineId}/{takeId}.wav` */
  path: string
  lineId: Id
  takeId: Id
  fileName: string
}

/**
 * 解析录音槽位路径：`slots/{lineId}/{takeId}.wav`。
 * 不符合该形状（例如中间多一层目录）时返回 null，由调用方记入「待处理」。
 */
export function parseSlotPath(path: string): SlotEntry | null {
  const normalized = path.replace(/\\/g, '/')
  const m = /^slots\/([^/]+)\/([^/]+)$/.exec(normalized)
  if (!m) return null
  const fileName = m[2]
  if (!/\.(wav|WAV)$/.test(fileName)) return null
  const takeId = fileName.replace(/\.(wav|WAV)$/, '')
  if (!m[1] || !takeId) return null
  return { path: normalized, lineId: m[1], takeId, fileName }
}

/** 列出包里所有录音槽位（按路径排序，保证处理顺序稳定） */
export function listSlotEntries(zip: ZipReader): { entries: SlotEntry[]; unrecognized: string[] } {
  const entries: SlotEntry[] = []
  const unrecognized: string[] = []
  for (const e of zip.listEntries()) {
    if (!e.name.startsWith(`${SLOTS_DIR}/`)) continue
    const parsed = parseSlotPath(e.name)
    if (parsed) entries.push(parsed)
    else unrecognized.push(e.name)
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries, unrecognized }
}
