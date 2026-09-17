/**
 * 启动编排 · 崩溃恢复（docs/04 §7 完整流程）
 * ============================================================================
 * 设计依据：
 *   · docs/04 §7「启动时按序执行」1~5 步
 *   · docs/05 §3「崩溃恢复（数据安全核心）」——含「放弃恢复的情况必须明确报告」
 *   · docs/01 §10「5 崩溃恢复必须在 6 清理临时之前」（本文件是那个「5」）
 *
 * ```
 * 1. 扫描 projects/{id}/recordings/*.wav.tmp 与 *.pcm.part
 * 2. 对每个文件：
 *    a. 读取伴生元数据 {sessionId}.meta.json（设备/采样率/位深/声道/写入样本数）
 *    b. 校验数据体长度是否与样本数一致（截断到完整帧边界）
 *    c. 生成合法 WAV 头（RIFF/WAVE/fmt/data，data size = 样本数 × 帧字节）
 *    d. 原子改名为 {sessionId}.wav
 *    e. 写入 recording_sessions（status='recovered'）
 * 3. 把 tasks 中 status ∈ {running, waiting} 的记录标为 interrupted
 * 4. 清理不在恢复清单内的过期临时文件（由 bootstrap/cleanup.ts 执行，**必须在 3 之后**）
 * 5. 若发生恢复，向 UI 推送「已恢复 N 段录音（共 X 分钟），可继续录制」
 * ```
 *
 * **为什么顺序不能反**：`.wav.tmp` 与 `.tmp/` 目录里的垃圾在文件名上难以区分，
 * 若先清理就会把「待修复的录音」当垃圾删掉 —— 这是**用户素材丢失**级别的事故。
 * 因此本模块返回的 `manifest`（恢复清单）会被 cleanup 当作白名单。
 *
 * 铁律：恢复过程**永不删除原始 tmp**（除非成功改名）。失败时保留原文件并报告，
 * 让用户/人工去救 —— 宁可留一堆可疑文件，也不要赌一把删掉用户两小时的录音。
 */

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { AppError, wrapUnknown } from '../../shared/errors.ts'
import { isUserAssetPath } from '../infra/fs/index.ts'
import { sha256File } from '../infra/fs/hash.ts'
import {
  availableFrames,
  buildWavHeader,
  bytesPerFrame,
  formatFromParsed,
  framesToMs,
  parseWavHeader,
  WAV_HEADER_BYTES,
  type WavFormat,
} from './wav.ts'

export {
  availableFrames,
  buildWavHeader,
  bytesPerFrame,
  formatFromParsed,
  framesToMs,
  parseWavHeader,
  WAV_HEADER_BYTES,
  type ParsedWav,
  type WavFormat,
} from './wav.ts'

// ---------------------------------------------------------------------------
// 伴生元数据（docs/04 §7）
// ---------------------------------------------------------------------------

/**
 * `{sessionId}.meta.json`。
 * docs/04 §7 原话：「**这是录音安全的核心**：没有它，崩溃后的裸 PCM 无法可靠还原为音频」。
 */
export interface RecordingMetaFile {
  sessionId: string
  projectId: string
  chapterId?: string | null
  sampleRate: number
  bitDepth: number
  channels: number
  /** 32 位时的样本类型（本仓库扩展字段；缺省 PCM） */
  float?: boolean
  mode?: string
  startedAt?: number
  /** 写入器累计的帧数（崩溃时可能落后于文件实际长度，故要与文件大小取 min） */
  framesWritten?: number
  peakDb?: number | null
  gainDb?: number
  device?: { label?: string; deviceId?: string }
  finalized?: boolean
}

/** 读取伴生元数据；文件不存在/内容损坏都返回 null（不抛错：恢复流程不能被它打断） */
export async function readRecordingMeta(metaPath: string): Promise<RecordingMetaFile | null> {
  try {
    const text = await fsp.readFile(metaPath, 'utf8')
    const parsed = JSON.parse(text) as RecordingMetaFile
    if (!parsed || typeof parsed !== 'object') return null
    if (!Number.isFinite(parsed.sampleRate) || !Number.isFinite(parsed.channels)) return null
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 单文件修复
// ---------------------------------------------------------------------------

export interface RepairWavOptions {
  /** 待修复的 `.wav.tmp` / `.pcm.part` */
  tmpPath: string
  /** 伴生元数据路径（默认同目录 `{sessionId}.meta.json`） */
  metaPath?: string | null
  /** 输出路径（默认去掉 `.tmp` / `.part` 后缀） */
  outPath?: string
  /** 隔离目录：成功后把原 tmp 移进去保留（docs/05 §3 第 7 步：保留 7 天） */
  quarantineDir?: string | null
  /** 显式格式（不传则依次尝试 meta / 现有头） */
  format?: WavFormat
}

export interface RepairResult {
  status: 'repaired' | 'abandoned'
  sessionId: string
  tmpPath: string
  /** 修复后的成品路径（abandoned 时为 null） */
  outPath: string | null
  format: WavFormat | null
  frames: number
  dataBytes: number
  durationMs: number
  /** 帧数来源：'meta'（伴生元数据） | 'filesize'（按文件大小反推） */
  framesSource: 'meta' | 'filesize' | null
  /** 放弃原因（abandoned 时必有） */
  reason?: string
  /** 原 tmp 的隔离位置（保留供人工抢救） */
  quarantinePath?: string | null
  /** 处理前的原始大小（诊断用） */
  originalSizeBytes: number
  sha256?: string
}

/** 从文件名推断 sessionId：`{sessionId}.wav.tmp` / `{sessionId}.pcm.part` → `{sessionId}` */
export function sessionIdFromTmpName(fileName: string): string {
  return fileName.replace(/\.(wav\.tmp|pcm\.part|wav\.recovered\.wav|tmp|part)$/i, '') || fileName
}

/** 默认输出路径：去掉 `.tmp` / `.part`，得到 `{sessionId}.wav` */
export function recoveredPathFor(tmpPath: string): string {
  return tmpPath.replace(/\.(wav\.tmp|pcm\.part|tmp|part)$/i, '.wav')
}

/**
 * 修复单个录音文件（docs/04 §7 步骤 2 的 a~d）。
 *
 * 实现方式（docs/05 §3 第 4 步「copy → 修复副本 → 原子改名」）：
 *   1. 读出真实帧数 = min(meta.framesWritten ?? 可用帧数, 可用帧数)
 *   2. 把 `44 + frames × 帧字节` 字节流式复制到 `{sessionId}.recovered.wav`
 *   3. 用 pwrite 覆盖正确头
 *   4. `rename` 到最终名（同盘 rename 原子）
 *   5. 原 tmp 移入隔离目录（**不删除**）
 * 只有第 1~4 步全部成功才动原文件；任何一步失败都保留现场并返回 `abandoned`。
 */
export async function repairWavHeader(opts: RepairWavOptions): Promise<RepairResult> {
  const tmpPath = opts.tmpPath
  const fileName = basename(tmpPath)
  const sessionId = sessionIdFromTmpName(fileName)
  const base: RepairResult = {
    status: 'abandoned',
    sessionId,
    tmpPath,
    outPath: null,
    format: null,
    frames: 0,
    dataBytes: 0,
    durationMs: 0,
    framesSource: null,
    originalSizeBytes: 0,
  }

  let size = 0
  try {
    const st = await fsp.stat(tmpPath)
    size = st.size
    base.originalSizeBytes = size
  } catch (e) {
    return { ...base, reason: `文件不可读：${String((e as { code?: string }).code ?? e)}` }
  }

  // 放弃恢复的情况 1：文件小于 44 字节（只有头，没有素材，docs/05 §3）
  if (size <= WAV_HEADER_BYTES) {
    return { ...base, reason: `文件只有 ${size} 字节（≤ ${WAV_HEADER_BYTES}），没有可用素材` }
  }

  const metaPath = opts.metaPath === undefined ? join(dirname(tmpPath), `${sessionId}.meta.json`) : opts.metaPath
  const meta = metaPath ? await readRecordingMeta(metaPath) : null

  // 格式优先级：显式 → meta → 现有头 fmt 块
  let format: WavFormat | null = opts.format ?? (meta ? metaFormat(meta) : null)
  let framesSource: RepairResult['framesSource'] = format ? 'meta' : null

  if (!format) {
    try {
      const head = await readRange(tmpPath, 0, 4096)
      const parsed = parseWavHeader(head)
      format = formatFromParsed(parsed)
      if (format) framesSource = 'filesize'
    } catch {
      format = null
    }
  }
  if (!format) {
    // 放弃恢复的情况 2：连格式都无法确定（docs/05 §3：保留原始文件供人工抢救）
    return { ...base, reason: '既没有 meta.json，现有头部也无法解析出采样率/位深/声道' }
  }

  const frameBytes = bytesPerFrame(format)
  const usable = availableFrames(size, format, WAV_HEADER_BYTES)
  const declared = typeof meta?.framesWritten === 'number' && meta.framesWritten > 0
    ? Math.floor(meta.framesWritten)
    : null
  // 以文件为准（docs/05 §3 第 2 步：头大身子小时按实际字节截断到完整帧边界）
  const frames = Math.min(declared ?? usable, usable)
  if (frames <= 0) {
    return { ...base, format, reason: `数据体不足一帧（可用 ${usable} 帧，帧字节 ${frameBytes}）` }
  }
  const framesSourceFinal: RepairResult['framesSource'] = declared !== null && declared <= usable ? 'meta' : 'filesize'
  framesSource = framesSourceFinal

  const outPath = opts.outPath ?? recoveredPathFor(tmpPath)
  const workingPath = `${outPath}.recovered.working`
  const dataBytes = frames * frameBytes

  try {
    // 1) 流式复制数据体（避免把几百 MB 读进内存）
    await copyPrefix(tmpPath, workingPath, WAV_HEADER_BYTES + dataBytes)
    // 2) 覆盖正确头
    const fh = await fsp.open(workingPath, 'r+')
    try {
      await fh.write(buildWavHeader(format, frames), 0, WAV_HEADER_BYTES, 0)
      await fh.sync()
    } finally {
      await fh.close()
    }
    // 3) 原子改名
    await fsp.rename(workingPath, outPath)
  } catch (e) {
    await fsp.rm(workingPath, { force: true }).catch(() => undefined)
    return { ...base, format, frames, dataBytes, durationMs: framesToMs(frames, format.sampleRate), framesSource, reason: `修复失败：${String(e)}` }
  }

  // 4) 原 tmp 移入隔离目录（保留，不删除）
  let quarantinePath: string | null = null
  if (opts.quarantineDir) {
    try {
      await fsp.mkdir(opts.quarantineDir, { recursive: true })
      const target = join(opts.quarantineDir, `${fileName}.${Date.now().toString(36)}`)
      await fsp.rename(tmpPath, target)
      quarantinePath = target
    } catch {
      // 隔离失败不影响恢复结果：原 tmp 留在原地即可（cleanup 的白名单会保护它）
      quarantinePath = null
    }
  }

  let sha256: string | undefined
  try {
    sha256 = await sha256File(outPath)
  } catch {
    sha256 = undefined
  }

  return {
    status: 'repaired',
    sessionId,
    tmpPath,
    outPath,
    format,
    frames,
    dataBytes,
    durationMs: framesToMs(frames, format.sampleRate),
    framesSource,
    quarantinePath,
    originalSizeBytes: size,
    ...(sha256 ? { sha256 } : {}),
  }
}

function metaFormat(meta: RecordingMetaFile): WavFormat | null {
  if (!Number.isFinite(meta.sampleRate) || !Number.isFinite(meta.bitDepth) || !Number.isFinite(meta.channels)) return null
  if (meta.sampleRate <= 0 || meta.channels <= 0 || meta.bitDepth <= 0) return null
  return {
    sampleRate: meta.sampleRate,
    bitDepth: meta.bitDepth,
    channels: meta.channels,
    ...(meta.float === true ? { float: true } : {}),
  }
}

/** 读取文件的一段（用于只解析头部，不读整个大文件） */
async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const fh = await fsp.open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** 复制源文件的前 `bytes` 字节到目标（流式，固定大小缓冲） */
async function copyPrefix(src: string, dest: string, bytes: number): Promise<void> {
  const inFh = await fsp.open(src, 'r')
  const outFh = await fsp.open(dest, 'w')
  try {
    const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(64 * 1024, bytes)))
    let remaining = bytes
    let position = 0
    while (remaining > 0) {
      const want = Math.min(chunk.length, remaining)
      const { bytesRead } = await inFh.read(chunk, 0, want, position)
      if (bytesRead <= 0) break
      await outFh.write(chunk, 0, bytesRead, position)
      position += bytesRead
      remaining -= bytesRead
    }
    await outFh.sync()
  } finally {
    await inFh.close().catch(() => undefined)
    await outFh.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 扫描与整体恢复（docs/04 §7 步骤 1、3、5）
// ---------------------------------------------------------------------------

export interface RecoveredSessionInput {
  sessionId: string
  projectId: string
  chapterId: string | null
  /** 相对项目目录的路径：`recordings/{id}.wav`（docs/03 §2：入库只存相对路径） */
  filePath: string
  format: WavFormat
  durationMs: number
  frames: number
  peakDb: number | null
  gainDb: number
  mode: string | null
  startedAt: number
  finishedAt: number
  sha256?: string
}

export interface RecordingSessionWriter {
  /** 写入 recording_sessions，status = 'recovered' */
  insertRecoveredSession(input: RecoveredSessionInput): void | Promise<void>
}

export interface TaskRecoveryPort {
  /** 把 tasks 中 running/waiting 标记为 interrupted，返回处理条数 */
  markInterrupted(): number | Promise<number>
}

export interface RecoveryDeps {
  /** `{userData}/projects` */
  projectRoot: string
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
    error: (event: string, fields: Record<string, unknown>) => void
  }
  /** 只扫描这些项目（默认扫描 projectRoot 下的全部目录） */
  projectIds?: readonly string[]
  /** 隔离目录（默认 `<projectRoot>/../.quarantine` 由调用方给出更合适） */
  quarantineDir?: string | null
  /** 入库端口；**不注入时不会假装成功**，只在报告里注明未落库 */
  sessions?: RecordingSessionWriter
  /** 任务恢复端口 */
  tasks?: TaskRecoveryPort
  now?: () => number
  /** 只扫描不修改（预演） */
  dryRun?: boolean
}

export interface RecoveryReport {
  scannedProjects: number
  candidates: number
  repaired: RepairResult[]
  abandoned: RepairResult[]
  /** 成功落库的 session 数 */
  persistedSessions: number
  /** 尚未落库（缺少 sessions 端口）的 session 数 */
  unpersistedSessions: number
  recoveredMs: number
  interruptedTasks: number
  /** 恢复清单：cleanup 必须把这些路径当白名单（docs/04 §7 步骤 4） */
  manifest: string[]
  warnings: string[]
  elapsedMs: number
  dryRun: boolean
}

/** 扫描一个项目目录下的待恢复文件（`*.wav.tmp` 与 `*.pcm.part`） */
export async function findRecoverableFiles(projectDir: string): Promise<string[]> {
  const recordingsDir = join(projectDir, 'recordings')
  let entries: string[] = []
  try {
    entries = await fsp.readdir(recordingsDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => /\.(wav\.tmp|pcm\.part)$/i.test(name))
    .map((name) => join(recordingsDir, name))
    .sort()
}

/**
 * 执行崩溃恢复（docs/04 §7 的 1、2、3 步）。
 *
 * @returns 报告（含 `manifest`：给 cleanup 的白名单）
 */
export async function recoverRecordings(deps: RecoveryDeps): Promise<RecoveryReport> {
  const started = deps.now ? deps.now() : Date.now()
  const warnings: string[] = []
  const repaired: RepairResult[] = []
  const abandoned: RepairResult[] = []
  const manifest: string[] = []
  let candidates = 0

  const projectIds = deps.projectIds ?? (await listProjectDirs(deps.projectRoot))
  if (deps.projectIds && deps.projectIds.length === 0) {
    warnings.push('未提供任何项目 id，跳过扫描')
  }

  for (const projectId of projectIds) {
    const projectDir = join(deps.projectRoot, projectId)
    const files = await findRecoverableFiles(projectDir)
    candidates += files.length

    for (const tmpPath of files) {
      // 恢复清单：无论成功失败都要登记，cleanup 不得删除（docs/04 §7 步骤 4）
      manifest.push(tmpPath)
      const metaPath = join(dirname(tmpPath), `${sessionIdFromTmpName(basename(tmpPath))}.meta.json`)
      manifest.push(metaPath)

      if (deps.dryRun) {
        deps.log.info('recovery.dryRun.candidate', { event: 'recovery.dryRun.candidate', tmpPath, projectId })
        continue
      }

      const result = await repairWavHeader({
        tmpPath,
        metaPath,
        quarantineDir: deps.quarantineDir ?? null,
      })
      if (result.outPath) manifest.push(result.outPath)

      if (result.status === 'repaired') {
        repaired.push(result)
        deps.log.info('recovery.repaired', {
          event: 'recovery.repaired',
          sessionId: result.sessionId,
          projectId,
          frames: result.frames,
          durationMs: result.durationMs,
          sampleRate: result.format?.sampleRate,
          framesSource: result.framesSource,
        })
      } else {
        abandoned.push(result)
        // docs/05 §3：放弃恢复必须**明确报告**，而不是静默处理
        deps.log.warn('recovery.abandoned', {
          event: 'recovery.abandoned',
          sessionId: result.sessionId,
          projectId,
          tmpPath,
          reason: result.reason,
          sizeBytes: result.originalSizeBytes,
        })
        warnings.push(`${basename(tmpPath)}：${result.reason ?? '未知原因'}`)
      }
    }
  }

  // ── 入库（docs/04 §7 步骤 2e）───────────────────────────────────────────
  let persistedSessions = 0
  let unpersistedSessions = 0
  if (!deps.dryRun && repaired.length > 0) {
    if (!deps.sessions) {
      unpersistedSessions = repaired.length
      deps.log.warn('recovery.sessions.notPersisted', {
        event: 'recovery.sessions.notPersisted',
        count: repaired.length,
        reason: 'no-session-writer',
        hint: '缺少 RecordingSessionWriter 端口：录音文件已修复，但未写入 recording_sessions 表',
      })
      warnings.push(`${repaired.length} 段恢复的录音未写入数据库（未注入 sessions 端口）`)
    } else {
      const finishedAt = deps.now ? deps.now() : Date.now()
      for (const r of repaired) {
        const projectId = projectIdOf(r.tmpPath, deps.projectRoot)
        const meta = await readRecordingMeta(join(dirname(r.tmpPath), `${r.sessionId}.meta.json`))
        try {
          await deps.sessions.insertRecoveredSession({
            sessionId: r.sessionId,
            projectId: meta?.projectId ?? projectId,
            chapterId: meta?.chapterId ?? null,
            filePath: `recordings/${basename(r.outPath as string)}`,
            format: r.format as WavFormat,
            durationMs: r.durationMs,
            frames: r.frames,
            peakDb: meta?.peakDb ?? null,
            gainDb: meta?.gainDb ?? 0,
            mode: meta?.mode ?? null,
            startedAt: meta?.startedAt ?? finishedAt,
            finishedAt,
            ...(r.sha256 ? { sha256: r.sha256 } : {}),
          })
          persistedSessions++
        } catch (e) {
          unpersistedSessions++
          deps.log.error('recovery.sessions.insertFailed', {
            event: 'recovery.sessions.insertFailed',
            sessionId: r.sessionId,
            reason: String(e),
          })
          warnings.push(`session ${r.sessionId} 入库失败：${String(e)}`)
        }
      }
    }
  }

  // ── 任务中断标记（docs/04 §7 步骤 3）─────────────────────────────────────
  let interruptedTasks = 0
  if (!deps.dryRun && deps.tasks) {
    try {
      interruptedTasks = await deps.tasks.markInterrupted()
      if (interruptedTasks > 0) {
        deps.log.warn('recovery.tasks.interrupted', { event: 'recovery.tasks.interrupted', count: interruptedTasks })
      }
    } catch (e) {
      warnings.push(`标记中断任务失败：${String(e)}`)
    }
  }

  const recoveredMs = repaired.reduce((sum, r) => sum + r.durationMs, 0)
  const report: RecoveryReport = {
    scannedProjects: projectIds.length,
    candidates,
    repaired,
    abandoned,
    persistedSessions,
    unpersistedSessions,
    recoveredMs,
    interruptedTasks,
    manifest,
    warnings,
    elapsedMs: (deps.now ? deps.now() : Date.now()) - started,
    dryRun: deps.dryRun === true,
  }
  deps.log.info('recovery.done', {
    event: 'recovery.done',
    candidates,
    repaired: repaired.length,
    abandoned: abandoned.length,
    recoveredMs,
    interruptedTasks,
    elapsedMs: report.elapsedMs,
  })
  return report
}

/** 扫描 projectRoot 下的项目目录（只认目录；忽略隐藏目录与文件） */
async function listProjectDirs(projectRoot: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
  } catch {
    // 首次启动还没有 projects 目录：正常状态，不是错误
    return []
  }
}

/** 从路径反查 projectId（`{projectRoot}/{projectId}/recordings/x.wav.tmp`） */
function projectIdOf(tmpPath: string, projectRoot: string): string {
  const rel = tmpPath.slice(projectRoot.length).replace(/^[\\/]+/, '')
  return rel.split(/[\\/]+/)[0] ?? ''
}

/**
 * 恢复结果 → UI 提示所需的载荷（docs/04 §7 步骤 5：`crash:recovered` 事件）。
 * 返回 null 表示没有需要通知的内容（不要推一个「恢复了 0 段」的空事件）。
 */
export function recoveryEventPayload(report: RecoveryReport): { sessions: number; totalMs: number } | null {
  if (report.repaired.length === 0) return null
  return { sessions: report.repaired.length, totalMs: report.recoveredMs }
}

/**
 * 断言「恢复清单里的文件不会被清理」——供启动自检使用。
 * 若某个 manifest 路径被判定为「可清理的临时文件」，说明 cleanup 的白名单没接上，
 * 必须立刻失败（这是会导致用户录音丢失的致命顺序错误）。
 */
export function assertManifestProtected(manifest: readonly string[], decision: (path: string) => boolean): void {
  const violating = manifest.filter((p) => decision(p))
  if (violating.length > 0) {
    throw new AppError('TEMP_CLEANUP_PARTIAL', {
      params: { count: violating.length },
      details: {
        reason: 'recovery-manifest-not-protected',
        violating: violating.slice(0, 10),
        hint: '恢复清单必须作为 cleanup 的白名单（docs/01 §10：5 崩溃恢复必须在 6 清理之前）',
      },
    })
  }
}

/** 判断某个路径是否属于用户素材（cleanup 的兜底保护） */
export function looksLikeUserAsset(path: string, projectRoot: string): boolean {
  try {
    return isUserAssetPath(path, projectRoot)
  } catch (e) {
    throw wrapUnknown(e)
  }
}
