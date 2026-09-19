/**
 * Novel Studio · 项目包 / 任务包任务（`package.export` / `package.import` / `package.merge`）
 * ============================================================================
 * 设计依据：
 *   · docs/03 §8   `.nsp` 项目包（导出内容清单、导入规则 1~5：版本校验、逐文件校验、
 *                  ID 重映射、音频按新 projectId 重写目录、解压防护）
 *   · docs/03 §9   `.nst` 任务包（task.json 形状、回传包变体、合并规则表）
 *   · docs/11 §6.2–§6.5（导出选项、`linesHash` 口径、回收归位与报告、增量下发）
 *   · docs/04 §2   任务队列（进度上报、取消、并发键、幂等键）
 *   · docs/20 §4   `package:*` 7 个通道的契约
 *   · docs/21 §6   `packages` 表（历史行的列与取值域）
 *
 * ### 为什么三个任务写在一个文件里
 *   `package.export`（.nsp / .nst 两种载荷，用 `op` 区分）、`package.import`、
 *   `package.merge` 共用同一套脚手架：读库 → 拼文件清单 → 落盘 → 写历史行。
 *   拆成三个文件会让「包放哪」「历史行怎么记」「失败了怎么留痕」出现三份实现。
 *
 * ### 实现边界（**如实标注，不假装**）
 *   ✅ 已实现：
 *     · `.nsp` 导出：`VACUUM INTO` 真数据库快照、按 `contents` 收集音频/成品、逐文件
 *       checksums、manifest 计数与体积、历史行；
 *     · `.nst` 导出：按配音员作用域选行、上下文/提示/发音/参考音选项、增量下发
 *       （`onlyChangedLines`，docs/11 §6.5）、历史行（行 id 就是 `manifest.packageId`）；
 *     · `.nsp` 导入：**真解包落盘**（`{projectRoot}/{新 projectId}/…`）+ `id_map.json`
 *       + 登记 `projects` 行 + 历史行；
 *     · `.nst` 回收合并：真读包、真写 `takes/{lineId}/{takeId}.wav`、真入 `takes` 表、
 *       真生成成品片段（`segments/{id}.wav` + `voice_segments` 行）、真落回收报告。
 *   ⚠ 未实现（在结果与历史里**明确写出**，不静默）：
 *     1. `.nsp` 导入**不把包内业务数据（books/chapters/canvas_lines/…）合并进主库**。
 *        `nsp.ts` 已把这一步设计成注入式 `rewriteDatabase`，而按 ID 映射改写整份快照
 *        （含所有外键列）当前没有可验证的实现，硬做会把**错误的行**写进用户的库 ——
 *        比「导进来暂时看不到内容」严重得多。因此导入结果 `businessDataMerged=false`
 *        并带一条明确 warning（测试里断言了这条 warning 存在）。
 *     2. 文件是**逐个读进内存**再交给 zip writer（`ZipWriter.addFile` 的签名就是字节）；
 *        因此单文件占内存，但包总量不受内存限制。> 4 GiB 的包直接拒绝：自研 ZIP
 *        读取器不支持 ZIP64，产出**自己都读不回来**的包比导出失败更糟。
 *     3. `package.import` 读包同样是整份读进内存（导入是一次性动作，可接受；真要支持
 *        GB 级流式读取需要另一套流式 ZIP 读取器，已登记在 docs/91 的未验证项里）。
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { AppError } from '../../../../shared/errors.ts'
import type {
  CanvasLine,
  Character,
  DecidedBy,
  Id,
  LineKind,
  LineState,
  NstLine,
  SpeakerCandidate,
  TaskKind,
  TaskPackageMergeReport,
} from '../../../../shared/types.ts'
import type { DbLike } from '../../../infra/db/types.ts'
import { sqlStringLiteral } from '../../../infra/db/types.ts'
import { latestSchemaVersion } from '../../../infra/db/migrations/index.ts'
import { projectAudioRoot } from '../../audio/audio-root.ts'
import { sha256Hex } from './checksums.ts'
import {
  DEFAULT_RECORD_SETTINGS,
  ID_MAP_FILE,
  MANIFEST_FILE,
  NSP_CONTENT_PRESETS,
  buildNstManifest,
  type NspContents,
} from './manifest.ts'
import {
  buildNstLines,
  computeLinesHash,
  createPackageId,
  diffLines,
  exportTaskPackage,
  listSlotEntries,
  parseTaskPackage,
  type LinesHashInput,
} from './nst.ts'
import { collectIdsDeep, exportProjectPackage, importProjectPackage, serializeIdMap, type NamedFile } from './nsp.ts'
import { mergeTaskPackageFromZip, type MergeHooks, type MergeLocalState, type MergeSkip } from './merge.ts'
import { probeWav } from './wav.ts'
import { openZip, type ZipReader } from './zip/reader.ts'
import {
  createArchiverZipWriter,
  createStoreZipWriter,
  type ArchiverFactoryLike,
  type WritableLike,
  type ZipWriter,
} from './zip/writer.ts'
import type { PackageRepo, PackageRow, PackageStats } from './repositories/package.repo.ts'
import type { TaskQueue } from '../../../infra/queue/queue.ts'
import type { TaskContext, TaskSpec } from '../../../infra/queue/types.ts'

// ============================================================================
// 载荷与结果
// ============================================================================

/** `.nsp` 导出的载荷 */
export interface PackageExportProjectPayload {
  op: 'project'
  projectId: Id
  options: Record<string, unknown>
}

/** `.nst` 导出的载荷 */
export interface PackageExportTaskPayload {
  op: 'task'
  bookId: Id
  actorId: Id
  options: Record<string, unknown>
}

export type PackageExportPayload = PackageExportProjectPayload | PackageExportTaskPayload

export interface PackageImportPayload {
  path: string
  options: Record<string, unknown>
}

export interface PackageMergePayload {
  projectId: Id
  path: string
}

export interface PackageExportProjectResult {
  /** `packages` 行 id（= 导出记录的身份） */
  packageId: Id
  filePath: string
  kind: 'nsp'
  files: number
  bytes: number
  uncompressedBytes: number
  /** 因 `contents` 关闭而未写入的类别（必须让用户看到，docs/03 §8） */
  skipped: string[]
  warnings: string[]
}

export interface PackageExportTaskResult {
  /**
   * `packages` 行 id = `manifest.packageId`。
   * 两者刻意相同：回收时要靠它溯源（docs/11 §6.2 第 5 步「记录 packageId + linesHash」）。
   */
  packageId: Id
  filePath: string
  kind: 'nst'
  linesHash: string
  lines: number
  characters: number
  referenceFiles: number
  files: number
  bytes: number
  uncompressedBytes: number
  warnings: string[]
}

export interface PackageImportResult {
  /** `packages` 行 id */
  packageId: Id
  /** 来源包路径 */
  filePath: string
  /** 新分配的项目 id（导入永远换新 id，docs/03 §8 规则 3） */
  projectId: Id
  /** 解包落盘目录 */
  projectDir: string
  writtenFiles: number
  skippedFiles: number
  /** 是否做了内部 ID 重映射（映射表写在 `id_map.json`） */
  remapped: boolean
  /** **恒为 false**：本轮没有实现业务数据入库合并（见文件头「实现边界」） */
  businessDataMerged: boolean
  warnings: string[]
}

/** 合并任务的结果就是回收报告本身（渲染侧 `packages.store.ts` 直接把它当报告用） */
export type PackageMergeResult = TaskPackageMergeReport

// ============================================================================
// 依赖
// ============================================================================

export interface PackageTaskLog {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error?(event: string, fields?: Record<string, unknown>): void
}

export interface PackageTaskDeps {
  getDb: () => DbLike | null
  queue?: TaskQueue
  /** `{userData}/projects`；库内相对路径的基准是 `{projectRoot}/{projectId}` */
  projectRoot: () => string
  /** 导出目录（设置里的 `paths.exportDir`）：默认的包就落在这里 */
  exportDir: () => string
  /** 写进 manifest.app（生产是 `app.getVersion()`） */
  app: () => { name: string; version: string }
  repo: () => PackageRepo
  log: PackageTaskLog
  /** 注入 id 生成器（测试可确定性） */
  newId?: () => Id
  now?: () => number
}

export interface PackageTasks {
  taskSpecs(): Array<TaskSpec<unknown, unknown>>
  enqueueExportProject(projectId: Id, options: Record<string, unknown>): Promise<{ taskId: Id }>
  enqueueExportTask(bookId: Id, actorId: Id, options: Record<string, unknown>): Promise<{ taskId: Id }>
  enqueueImportProject(path: string, options: Record<string, unknown>): Promise<{ taskId: Id }>
  enqueueMergeTask(projectId: Id, path: string): Promise<{ taskId: Id }>
  /** 供测试与「同步重跑」直接调用：不经队列 */
  runNowExport(
    payload: PackageExportPayload,
    ctx: TaskContext,
  ): Promise<PackageExportProjectResult | PackageExportTaskResult>
  runNowImport(payload: PackageImportPayload, ctx: TaskContext): Promise<PackageImportResult>
  runNowMerge(payload: PackageMergePayload, ctx: TaskContext): Promise<PackageMergeResult>
}

// ============================================================================
// 选项解析（未知 key 一律报告：界面上的勾选项没生效是最难发现的一类问题）
// ============================================================================

const NSP_OPTION_KEYS = ['contents', 'outputPath'] as const
const NST_OPTION_KEYS = [
  'includeContext',
  'includeNotes',
  'includePronunciation',
  'includeReference',
  'allowOtherCharacterLines',
  'characterIds',
  'chapterIds',
  'onlyChangedLines',
  'recordSettings',
  'outputPath',
  'maxReferenceFiles',
] as const

function unknownOptionKeys(options: Record<string, unknown>, known: readonly string[]): string[] {
  const allowed = new Set(known)
  return Object.keys(options).filter((k) => !allowed.has(k))
}

function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function optionBool(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = options[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'boolean') {
    throw new AppError('INVALID_PAYLOAD', {
      details: { field: `options.${key}`, expected: 'boolean', actual: typeof v },
    })
  }
  return v
}

function optionStringArray(options: Record<string, unknown>, key: string): Id[] {
  const v = options[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
    throw new AppError('INVALID_PAYLOAD', {
      details: { field: `options.${key}`, expected: 'string[]', actual: describeValue(v) },
    })
  }
  return [...(v as string[])]
}

/**
 * `contents` 选项（docs/03 §8 的内容清单）。
 *
 * 接受三种形态：预设名（`'full'|'standard'|'slim'`）、部分布尔对象、缺省。
 * **缺省是 standard 而不是 full**：docs/03 §8 的结论就是「默认不含
 * recordings / takes / processed」；把默认值定成「整包带走」会把几 GB 的原始录音
 * 塞进一个用户以为只有几百 MB 的包里。
 */
export function resolveNspContents(raw: unknown): NspContents {
  if (raw === undefined || raw === null) return { ...NSP_CONTENT_PRESETS.standard }
  if (typeof raw === 'string') {
    if (raw === 'full' || raw === 'standard' || raw === 'slim') return { ...NSP_CONTENT_PRESETS[raw] }
    throw new AppError('INVALID_PAYLOAD', {
      details: { field: 'options.contents', expected: ['full', 'standard', 'slim'], actual: raw },
    })
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        field: 'options.contents',
        expected: 'preset-name | Partial<NspContents>',
        actual: describeValue(raw),
      },
    })
  }
  const merged: NspContents = { ...NSP_CONTENT_PRESETS.standard }
  const unknown: string[] = []
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in merged)) {
      // 未知 key **必须报错**：写成 `recording`（少个 s）的用户会得到一个「以为带上了原始录音、
      // 实际没带」的包 —— 这种静默偏差在换机恢复时才会暴露。
      unknown.push(k)
      continue
    }
    if (typeof v !== 'boolean') {
      throw new AppError('INVALID_PAYLOAD', {
        details: { field: `options.contents.${k}`, expected: 'boolean', actual: describeValue(v) },
      })
    }
    merged[k as keyof NspContents] = v
  }
  if (unknown.length > 0) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        field: 'options.contents',
        reason: 'unknown-content-keys',
        unknown,
        allowed: Object.keys(NSP_CONTENT_PRESETS.standard),
      },
    })
  }
  return merged
}

/** 录音建议（docs/03 §9）：结构不合法就报错，不静默用默认值代替用户的选择 */
function resolveRecordSettings(raw: unknown): typeof DEFAULT_RECORD_SETTINGS {
  if (raw === undefined || raw === null) return { ...DEFAULT_RECORD_SETTINGS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('INVALID_PAYLOAD', {
      details: {
        field: 'options.recordSettings',
        expected: 'NstManifest.recordSettings',
        actual: describeValue(raw),
      },
    })
  }
  const o: Record<string, unknown> = { ...DEFAULT_RECORD_SETTINGS, ...(raw as Record<string, unknown>) }
  for (const k of ['sampleRate', 'bitDepth', 'channels', 'recommendGainDb', 'targetPeakDb']) {
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { field: `options.recordSettings.${k}`, expected: 'number', actual: describeValue(o[k]) },
      })
    }
  }
  if (typeof o.fileNameTemplate !== 'string' || o.fileNameTemplate.trim() === '') {
    throw new AppError('INVALID_PAYLOAD', {
      details: { field: 'options.recordSettings.fileNameTemplate', expected: 'non-empty string' },
    })
  }
  return o as unknown as typeof DEFAULT_RECORD_SETTINGS
}

// ============================================================================
// 文件系统小工具
// ============================================================================

/**
 * 递归列出一个目录下的文件（相对该目录的路径 + 字节），**跳过符号链接**。
 * 符号链接可以指到项目目录之外（`ns-media://` 的边界就守在这条规则上），
 * 把链接目标打进包里等于把用户机器上任意文件送出去。
 */
async function collectDirFiles(absDir: string, onSkip?: (message: string) => void): Promise<NamedFile[]> {
  if (!existsSync(absDir)) return []
  const out: NamedFile[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    // 排序让包内条目顺序稳定（便于对比两次导出的差异）
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const abs = join(dir, e.name)
      const relName = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isSymbolicLink()) {
        onSkip?.(`跳过了符号链接 ${relName}（可能指向项目目录之外）`)
        continue
      }
      if (e.isDirectory()) {
        await walk(abs, relName)
        continue
      }
      if (!e.isFile()) continue
      out.push({ name: relName, data: await readFile(abs) })
    }
  }
  await walk(absDir, '')
  return out
}

function dirSizeOf(files: readonly NamedFile[]): number {
  return files.reduce((n, f) => n + f.data.byteLength, 0)
}

/** 目标文件必须存在（不存在 → `FILE_NOT_FOUND`，比 PACKAGE_INVALID 更可行动） */
function requireExistingFile(path: string): string {
  const abs = resolve(path)
  let ok = false
  try {
    ok = statSync(abs).isFile()
  } catch {
    ok = false
  }
  if (!ok) throw new AppError('FILE_NOT_FOUND', { params: { path: abs }, details: { path: abs } })
  return abs
}

/**
 * 默认包路径：`{exportDir}/{文件名}`；`options.outputPath` 可覆盖（相对路径按 exportDir 解析）。
 *
 * `avoidOverwrite`（只在**没显式给路径**时为真）：默认路径撞名时自动加序号。
 * 为什么：`packages` 历史行里存的是绝对路径，如果第二次导出悄悄覆盖了第一次的包，
 * 历史里那条旧记录就指向了**另一个包** —— 用户按历史去恢复会拿到错误的内容。
 * 用户显式选了路径（保存对话框已经问过「要覆盖吗」）时则按用户的意愿覆盖。
 */
function resolveOutputPath(options: Record<string, unknown>, defaultName: string, exportDir: string): string {
  const raw = options.outputPath
  if (raw === undefined || raw === null) return join(exportDir, defaultName)
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError('INVALID_PAYLOAD', {
      details: { field: 'options.outputPath', expected: 'non-empty string' },
    })
  }
  const trimmed = raw.trim()
  const target = isAbsolute(trimmed) ? trimmed : join(exportDir, trimmed)
  // 用户给了目录 → 自动补默认文件名（「另存为」对话框有时只回一个目录）
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, defaultName)
  return target
}

/** 没显式给路径时避开同名包（见 `resolveOutputPath` 的说明）；返回实际路径与是否改过名 */
function avoidOverwrite(target: string, enabled: boolean): { path: string; renamed: boolean } {
  if (!enabled || !existsSync(target)) return { path: target, renamed: false }
  for (let n = 1; n < 1000; n++) {
    const candidate = target.replace(/(\.[^.\\/]+)$/, ` (${n})$1`)
    if (!existsSync(candidate)) return { path: candidate, renamed: true }
  }
  return { path: target, renamed: false }
}

/** 文件名清洗：`\ / : * ? " < > |` 在 Windows 上会让创建文件直接失败 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return cleaned === '' ? '未命名' : cleaned
}

function fileSizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ============================================================================
// ZIP 写入（生产用 archiver 流式 deflate，缺依赖时退化为 store 实现）
// ============================================================================

interface PackageWriterHandle {
  zip: ZipWriter
  /** 收尾：store 实现要把输出流关掉并等落盘；archiver 实现由 finalize 负责 */
  finish(): Promise<void>
  abort(): Promise<void>
}

/**
 * 动态加载 archiver。
 *
 * 为什么是动态：`zip/writer.ts` 刻意不 import 第三方包（离线环境要能编译与测试），
 * 而生产要用流式 deflate（`.nsp` 动辄几 GB，store 实现不压缩且占内存）。
 * 这里补上那一环：能加载就用 archiver，加载不到就用 store 实现 —— **不假装压缩过**。
 */
async function loadArchiverFactory(): Promise<ArchiverFactoryLike | null> {
  try {
    const mod = (await import('archiver')) as unknown as { default?: unknown }
    const candidate = mod.default ?? (mod as unknown)
    return typeof candidate === 'function' ? (candidate as ArchiverFactoryLike) : null
  } catch {
    return null
  }
}

async function openPackageWriter(targetPath: string, signal?: AbortSignal): Promise<PackageWriterHandle> {
  await mkdir(dirname(targetPath), { recursive: true })
  const archiverFactory = await loadArchiverFactory()
  if (archiverFactory) {
    const fileStream = createWriteStream(targetPath)
    const archive = archiverFactory('zip', { zlib: { level: 6 } })
    archive.pipe(fileStream)

    /**
     * 为什么要在 archiver 与适配层之间再包一层 output 代理（本轮实测发现的竞态）：
     *   `createArchiverZipWriter.finalize()` 在 `await archive.finalize()` 之后会**自己**
     *   调用 `output.end()`。实测中 archiver 有时在那一刻还没把中央目录与 EOCD 写进输出流，
     *   于是 `end()` 之后到来的写入被丢弃（`ERR_STREAM_WRITE_AFTER_END`，被适配层的
     *   `failure` 记下但**无人检查**），结果是**一个能写出来、却打不开的包**
     *   （复现症状：`openZip` 报 `eocd-not-found`，文件大小看起来正常）。
     *
     *   处理：把 `end()` 推迟到 archiver 真正 emit 'end' 之后，让 `pipe` 自己收尾；
     *   再叠加导出后的 `assertPackageComplete()` 兜底 —— 自研读取器读不回自己的包，
     *   比导出失败严重得多（用户会以为归档成功了）。
     */
    let archiveEnded = false
    archive.on('end', () => {
      archiveEnded = true
    })
    const output: WritableLike = {
      on(event, listener) {
        fileStream.on(event, listener)
        return output
      },
      write(chunk) {
        return fileStream.write(chunk)
      },
      end() {
        if (archiveEnded) fileStream.end()
        else archive.on('end', () => fileStream.end())
      },
    }

    const zip = createArchiverZipWriter({ archive, output, zlibLevel: 6 })
    return {
      zip,
      async finish() {
        if (fileStream.closed) return
        await new Promise<void>((done) => {
          fileStream.once('close', () => done())
          // 监听注册前流可能已经关了（此时 'close' 不会再触发）→ 下一轮事件循环复查兜底
          setImmediate(() => {
            if (fileStream.closed) done()
          })
        })
      },
      async abort() {
        try {
          await zip.abort()
        } finally {
          fileStream.destroy()
        }
      },
    }
  }
  const stream = createWriteStream(targetPath)
  const zip = createStoreZipWriter({
    name: targetPath,
    ...(signal ? { signal } : {}),
    sink: async (chunk) => {
      if (!stream.write(chunk)) await once(stream, 'drain')
    },
  })
  return {
    zip,
    async finish() {
      await new Promise<void>((done, fail) => {
        stream.once('error', fail)
        stream.end(() => done())
      })
    },
    async abort() {
      try {
        await zip.abort()
      } finally {
        stream.destroy()
      }
    },
  }
}

/**
 * 导出后的完整性护栏：最后 22 字节必须是 EOCD 签名。
 *
 * 两个写入器（archiver 适配 / store）都写**零长度注释**，因此 EOCD 必然紧贴文件末尾；
 * 这个检查一次只读 22 字节，却能把「写了一半的包」当场变成一次明确的导出失败。
 */
async function assertPackageComplete(filePath: string): Promise<void> {
  const size = fileSizeOf(filePath)
  if (size < 22) {
    throw new AppError('PACKAGE_EXPORT_FAILED', {
      params: { reason: `导出产物只有 ${size} 字节，不是完整的 zip` },
      details: { reason: 'package-too-small', filePath, size },
    })
  }
  const handle = await open(filePath, 'r')
  try {
    const tail = Buffer.alloc(22)
    await handle.read(tail, 0, 22, size - 22)
    if (tail.readUInt32LE(0) !== 0x06054b50) {
      throw new AppError('PACKAGE_EXPORT_FAILED', {
        params: { reason: '导出产物缺少 zip 结束记录（EOCD），包可能被截断' },
        details: {
          reason: 'package-truncated',
          filePath,
          size,
          tail: tail.subarray(0, 8).toString('hex'),
          hint: '这是导出器的缺陷（写入流被提前关闭）；请重试一次，并把日志里的 package-truncated 报上来',
        },
      })
    }
  } finally {
    await handle.close()
  }
}

// ============================================================================
// 读库：行类型与 SQL
// ============================================================================

interface ProjectSqlRow {
  id: string
  name: string
  schema_version: number
  deleted_at: number | null
}

interface BookSqlRow {
  id: string
  project_id: string
  title: string
}

interface ActorSqlRow {
  id: string
  project_id: string
  name: string
  note: string | null
}

interface LineSqlRow {
  id: string
  chapter_id: string
  book_id: string
  seq: number
  speaker_type: string
  character_id: string | null
  kind: string
  text: string
  source_text: string | null
  char_start: number
  char_end: number
  emotion: string | null
  emotion_intensity: number | null
  speed: string | null
  gain_db: number | null
  pause_after_ms: number
  pause_inline: string | null
  pronunciation: string | null
  note: string | null
  state: string
  confidence: number | null
  candidates: string | null
  decided_by: string | null
  needs_review: number
  flags: string | null
  is_title: number
  rev: number
  created_at: number
  updated_at: number
  chapter_title: string
  chapter_seq: number
}

interface CharacterSqlRow {
  id: string
  book_id: string
  name: string
  aliases: string | null
  gender: string | null
  age_group: string | null
  description: string | null
  note: string | null
  color: string | null
  default_speed: string | null
  default_emotion: string | null
  default_gain_db: number | null
  default_pause_ms: number | null
  is_archived: number
  sort_order: number
  created_at: number
  updated_at: number
}

/** 任务包只需要角色表的一小部分字段 */
interface CharacterSqlRowLite {
  id: string
  name: string
  description: string | null
  note: string | null
  default_speed: string | null
  default_emotion: string | null
}

const SELECT_LINE_SQL = `SELECT l.id, l.chapter_id, l.book_id, l.seq, l.speaker_type, l.character_id, l.kind,
         l.text, l.source_text, l.char_start, l.char_end, l.emotion, l.emotion_intensity, l.speed,
         l.gain_db, l.pause_after_ms, l.pause_inline, l.pronunciation, l.note, l.state, l.confidence,
         l.candidates, l.decided_by, l.needs_review, l.flags, l.is_title, l.rev, l.created_at, l.updated_at,
         c.title AS chapter_title, c.seq AS chapter_seq
    FROM canvas_lines l
    JOIN chapters c ON c.id = l.chapter_id`

/** SQLite 的 `IN (?, ?, …)` 需要显式占位符；id 列表可能上千个，按块查 */
const SQL_CHUNK = 400

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

function chunked<T>(items: readonly T[], size = SQL_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function parseJsonArray<T>(text: string | null): T[] | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

function dedupe<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

function isSpeedMark(v: string | null): v is 'slow' | 'normal' | 'fast' {
  return v === 'slow' || v === 'normal' || v === 'fast'
}

/** SQL 行 → `CanvasLine`（`buildNstLines` 要的就是这个形状，字段必须真读库，不能编） */
function toCanvasLine(row: LineSqlRow): CanvasLine {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    bookId: row.book_id,
    seq: row.seq,
    speakerType: row.speaker_type === 'character' ? 'character' : 'narration',
    characterId: row.character_id,
    kind: row.kind as LineKind,
    text: row.text,
    sourceText: row.source_text,
    charStart: row.char_start,
    charEnd: row.char_end,
    emotion: row.emotion,
    emotionIntensity: row.emotion_intensity,
    speed: isSpeedMark(row.speed) ? row.speed : null,
    gainDb: row.gain_db,
    pauseAfterMs: row.pause_after_ms,
    pauseInline: parseJsonArray<number>(row.pause_inline),
    pronunciation: row.pronunciation,
    note: row.note,
    state: row.state as LineState,
    confidence: row.confidence,
    candidates: parseJsonArray<SpeakerCandidate>(row.candidates),
    decidedBy: (row.decided_by as DecidedBy | null) ?? null,
    needsReview: row.needs_review === 1,
    flags: parseJsonArray<string>(row.flags) ?? [],
    isTitle: row.is_title === 1,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** SQL 行 → `Character`（角色表 → 共享类型的完整映射，避免半成品对象流进判定逻辑） */
function toCharacter(row: CharacterSqlRow): Character {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    aliases: parseJsonArray<string>(row.aliases) ?? [],
    gender: row.gender as Character['gender'],
    ageGroup: row.age_group as Character['ageGroup'],
    description: row.description,
    note: row.note,
    color: row.color,
    defaultSpeed: isSpeedMark(row.default_speed) ? row.default_speed : null,
    defaultEmotion: row.default_emotion,
    defaultGainDb: row.default_gain_db,
    defaultPauseMs: row.default_pause_ms,
    isArchived: row.is_archived === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 角色 → 任务包里的角色条目（`note` 优先用描述：那是「少年，语气倔强」这类表演提示） */
function toManifestCharacter(row: CharacterSqlRowLite): {
  id: Id
  name: string
  note: string | null
  defaultSpeed: 'slow' | 'normal' | 'fast' | null
  defaultEmotion: string | null
} {
  return {
    id: row.id,
    name: row.name,
    note: row.description ?? row.note,
    defaultSpeed: isSpeedMark(row.default_speed) ? row.default_speed : null,
    defaultEmotion: row.default_emotion,
  }
}

function dedupeCharacters<T extends { id: Id }>(items: readonly T[]): T[] {
  const seen = new Map<Id, T>()
  for (const item of items) seen.set(item.id, item)
  return [...seen.values()]
}

function toLineHashInput(row: LineSqlRow): LinesHashInput {
  return {
    id: row.id,
    text: row.text,
    characterId: row.character_id,
    speakerType: row.speaker_type,
    emotion: row.emotion,
    pauseAfterMs: row.pause_after_ms,
  }
}

// ============================================================================
// 创建任务集
// ============================================================================

export function createPackageTasks(deps: PackageTaskDeps): PackageTasks {
  const log = deps.log
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => randomUUID())

  function requireDb(): DbLike {
    const db = deps.getDb()
    if (!db) throw new AppError('DB_NOT_OPEN', { details: { feature: 'package' } })
    return db
  }

  function requireQueue(): TaskQueue {
    if (!deps.queue) {
      throw new AppError('TASK_QUEUE_UNAVAILABLE', { details: { op: 'package', reason: 'queue-not-injected' } })
    }
    return deps.queue
  }

  function loadProject(db: DbLike, projectId: Id): ProjectSqlRow {
    const row = db
      .prepare(`SELECT id, name, schema_version, deleted_at FROM projects WHERE id = ?`)
      .get(projectId) as ProjectSqlRow | undefined
    if (!row || row.deleted_at !== null) {
      throw new AppError('NOT_FOUND', { details: { entity: 'project', id: projectId } })
    }
    return row
  }

  function loadBook(db: DbLike, bookId: Id): BookSqlRow {
    const row = db
      .prepare(`SELECT id, project_id, title FROM books WHERE id = ? AND deleted_at IS NULL`)
      .get(bookId) as BookSqlRow | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'book', id: bookId } })
    return row
  }

  function loadActor(db: DbLike, actorId: Id): ActorSqlRow {
    const row = db.prepare(`SELECT id, project_id, name, note FROM voice_actors WHERE id = ?`).get(actorId) as
      | ActorSqlRow
      | undefined
    if (!row) throw new AppError('NOT_FOUND', { details: { entity: 'voice_actor', id: actorId } })
    return row
  }

  function loadBookCharacters(db: DbLike, bookId: Id): CharacterSqlRow[] {
    return db
      .prepare(`SELECT * FROM characters WHERE book_id = ? ORDER BY sort_order ASC, name ASC`)
      .all(bookId) as CharacterSqlRow[]
  }

  // -------------------------------------------------------------------------
  // ① package.export · .nsp（项目包）
  // -------------------------------------------------------------------------

  interface ProjectCounts {
    chapters: number
    lines: number
    segments: number
    totalDurationMs: number
  }

  function loadProjectCounts(db: DbLike, projectId: Id): ProjectCounts {
    const chapters = db
      .prepare(
        `SELECT COUNT(*) AS n FROM chapters c JOIN books b ON b.id = c.book_id
          WHERE b.project_id = ? AND c.deleted_at IS NULL`,
      )
      .get(projectId) as { n: number }
    const lines = db
      .prepare(
        `SELECT COUNT(*) AS n FROM canvas_lines l JOIN books b ON b.id = l.book_id
          WHERE b.project_id = ? AND l.deleted_at IS NULL`,
      )
      .get(projectId) as { n: number }
    const segments = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(s.duration_ms), 0) AS total
           FROM voice_segments s JOIN chapters c ON c.id = s.chapter_id
           JOIN books b ON b.id = c.book_id
          WHERE b.project_id = ?`,
      )
      .get(projectId) as { n: number; total: number }
    return { chapters: chapters.n, lines: lines.n, segments: segments.n, totalDurationMs: segments.total }
  }

  /**
   * 数据库快照（docs/03 §8：`VACUUM INTO` 生成，**不是**直接拷贝主库）。
   *
   * 直接拷贝会拿到「正在被写」的半成品（WAL 里还有未合并的页），
   * 而 `VACUUM INTO` 产出的是一个自洽的单文件数据库。
   * 失败时**明确报错**而不是悄悄少写一个 database.sqlite：manifest 里写着
   * `contents.database=true`，包却不含库 —— 用户会在换机恢复时才发现。
   */
  async function snapshotDatabase(db: DbLike, targetPath: string): Promise<Uint8Array> {
    await rm(targetPath, { force: true })
    try {
      db.exec(`VACUUM INTO ${sqlStringLiteral(targetPath)}`)
    } catch (e) {
      throw new AppError('PACKAGE_EXPORT_FAILED', {
        cause: e,
        params: { reason: '数据库快照失败（VACUUM INTO）' },
        details: { reason: 'db-snapshot-failed', targetPath },
      })
    }
    return readFile(targetPath)
  }

  async function runExportProject(
    payload: PackageExportProjectPayload,
    ctx: TaskContext,
  ): Promise<PackageExportProjectResult> {
    const db = requireDb()
    const repo = deps.repo()
    const options = payload.options ?? {}
    const project = loadProject(db, payload.projectId)
    const contents = resolveNspContents(options.contents)
    const warnings = unknownOptionKeys(options, NSP_OPTION_KEYS).map(
      (k) => `忽略了未知的导出选项 ${k}（支持的选项：${NSP_OPTION_KEYS.join(' / ')}）`,
    )
    const counts = loadProjectCounts(db, project.id)
    const root = projectAudioRoot(deps.projectRoot(), project.id)
    const skippedByWalker: string[] = []

    ctx.report(0.02, '收集待打包内容')
    let database: Uint8Array | null = null
    if (contents.database) {
      database = await snapshotDatabase(db, join(ctx.tempDir, 'database.sqlite'))
    }

    const AUDIO_KEYS = ['recordings', 'takes', 'segments', 'processed', 'music'] as const
    const audio: Partial<Record<(typeof AUDIO_KEYS)[number], NamedFile[]>> = {}
    for (const key of AUDIO_KEYS) {
      if (!contents[key]) continue
      ctx.throwIfAborted()
      audio[key] = await collectDirFiles(join(root, key), (m) => skippedByWalker.push(m))
    }
    const exportsFiles = contents.exports
      ? await collectDirFiles(join(root, 'exports'), (m) => skippedByWalker.push(m))
      : []

    const totalBytes =
      (database?.byteLength ?? 0) +
      AUDIO_KEYS.reduce((n, k) => n + dirSizeOf(audio[k] ?? []), 0) +
      dirSizeOf(exportsFiles)
    if (totalBytes > ZIP64_LIMIT_BYTES) {
      throw new AppError('PACKAGE_EXPORT_FAILED', {
        params: {
          reason: '内容超过 4 GiB（自研 ZIP 读取器不支持 ZIP64，产出将无法被本应用读回）',
        },
        details: {
          reason: 'package-too-large',
          totalBytes,
          limit: ZIP64_LIMIT_BYTES,
          hint: '请在 contents 里关掉 recordings / takes 等大项后再试',
        },
      })
    }

    const target = resolveOutputPath(options, `${sanitizeFileName(project.name)}.nsp`, deps.exportDir())
    const unique = avoidOverwrite(target, options.outputPath === undefined)
    if (unique.renamed) warnings.push(`同名包已存在，本次写到 ${unique.path}（未覆盖已有包）`)
    const filePath = unique.path
    const handle = await openPackageWriter(filePath, ctx.signal)
    let result: Awaited<ReturnType<typeof exportProjectPackage>>
    try {
      result = await exportProjectPackage({
        zip: handle.zip,
        project: { id: project.id, name: project.name, totalDurationMs: counts.totalDurationMs },
        schemaVersion: latestSchemaVersion(),
        contents,
        counts: { chapters: counts.chapters, lines: counts.lines, segments: counts.segments },
        files: { ...(database ? { database } : {}), audio, exports: exportsFiles },
        app: deps.app(),
        onProgress: (info) => ctx.report(clamp01(info.progress), info.stage),
        signal: ctx.signal,
      })
      await handle.finish()
      await assertPackageComplete(filePath)
    } catch (e) {
      await handle.abort()
      throw e
    }

    const bytes = fileSizeOf(filePath)
    const historyId = `nsp_${newId()}`
    const skipped = [...result.skipped, ...skippedByWalker]
    await repo.insert({
      id: historyId,
      projectId: project.id,
      kind: 'nsp',
      direction: 'export',
      actorId: null,
      bookId: null,
      filePath,
      linesHash: null,
      manifest: result.manifest,
      stats: {
        files: result.files,
        bytes,
        uncompressedBytes: result.uncompressedBytes,
        chapters: counts.chapters,
        lines: counts.lines,
        segments: counts.segments,
        skipped: skipped.length,
      },
      status: 'done',
      report: null,
      createdAt: now(),
      finishedAt: now(),
    })

    log.info('package.exportProjectDone', {
      event: 'package.exportProjectDone',
      taskId: ctx.taskId,
      projectId: project.id,
      filePath,
      files: result.files,
      bytes,
      skipped: skipped.length,
    })
    return {
      packageId: historyId,
      filePath,
      kind: 'nsp',
      files: result.files,
      bytes,
      uncompressedBytes: result.uncompressedBytes,
      skipped,
      warnings,
    }
  }

  // -------------------------------------------------------------------------
  // ② package.export · .nst（任务包）
  // -------------------------------------------------------------------------

  /**
   * 该配音员的作用域角色。
   *
   * 优先用显式的 `options.characterIds`（UI 的「按角色过滤」），否则用
   * `character_voice_bindings`（docs/11 §6.1「一个配音员可担任多个角色」）。
   * 两者都空 → **明确报错**：给一个没有角色的配音员导包，只会得到
   * 一个空包，而用户会以为「导出成功了」。
   */
  function resolveScopeCharacters(
    db: DbLike,
    book: BookSqlRow,
    actorId: Id,
    requested: readonly Id[],
  ): CharacterSqlRowLite[] {
    const bookCharacters = db
      .prepare(
        `SELECT id, name, description, note, default_speed, default_emotion
           FROM characters WHERE book_id = ? AND is_archived = 0 ORDER BY sort_order ASC, name ASC`,
      )
      .all(book.id) as CharacterSqlRowLite[]
    const byId = new Map(bookCharacters.map((c) => [c.id, c]))

    if (requested.length > 0) {
      const outside = requested.filter((id) => !byId.has(id))
      if (outside.length > 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            field: 'options.characterIds',
            reason: 'character-not-in-book',
            bookId: book.id,
            ids: outside.slice(0, 10),
          },
        })
      }
      return requested.map((id) => byId.get(id)!)
    }

    const bound = db.prepare(`SELECT character_id FROM character_voice_bindings WHERE actor_id = ?`).all(actorId) as
      | Array<{ character_id: string }>
    const ids = bound.map((r) => r.character_id).filter((id) => byId.has(id))
    if (ids.length === 0) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          field: 'actorId',
          reason: 'actor-has-no-bound-character',
          actorId,
          bookId: book.id,
          hint: '请先在角色面板把角色分配给该配音员，或显式传 options.characterIds',
        },
      })
    }
    return ids.map((id) => byId.get(id)!)
  }

  function loadLines(db: DbLike, bookId: Id, characterIds: readonly Id[], chapterIds: readonly Id[]): LineSqlRow[] {
    const params: unknown[] = [bookId]
    let sql = `${SELECT_LINE_SQL} WHERE l.book_id = ? AND l.deleted_at IS NULL AND c.deleted_at IS NULL`
    if (characterIds.length > 0) {
      sql += ` AND l.character_id IN (${placeholders(characterIds.length)})`
      params.push(...characterIds)
    } else {
      sql += ` AND 1 = 0`
    }
    if (chapterIds.length > 0) {
      sql += ` AND l.chapter_id IN (${placeholders(chapterIds.length)})`
      params.push(...chapterIds)
    }
    // 顺序即 linesHash 的输入顺序（docs/11 §6.2「稳定序列化」）：章节序 → 行序
    sql += ` ORDER BY c.seq ASC, l.seq ASC`
    return db.prepare(sql).all(...params) as LineSqlRow[]
  }

  /** 「允许看到其它角色的词」时的作用域：该书全部行（含旁白） */
  function loadAllBookLines(db: DbLike, bookId: Id, chapterIds: readonly Id[]): LineSqlRow[] {
    const params: unknown[] = [bookId]
    let sql = `${SELECT_LINE_SQL} WHERE l.book_id = ? AND l.deleted_at IS NULL AND c.deleted_at IS NULL`
    if (chapterIds.length > 0) {
      sql += ` AND l.chapter_id IN (${placeholders(chapterIds.length)})`
      params.push(...chapterIds)
    }
    sql += ` ORDER BY c.seq ASC, l.seq ASC`
    return db.prepare(sql).all(...params) as LineSqlRow[]
  }

  /**
   * 参考音（docs/11 §6.2「对手戏片段，便于对词」）。
   *
   * 取每一行的**紧邻对手行**（前后各一行里说话人不同的那一行）已有的成品片段。
   * 总量受 `maxReferenceFiles` / `MAX_REFERENCE_BYTES` 限制并在结果里报告截断 ——
   * 否则「包含参考音」这个勾选项要么无声无效，要么把整本书的音频塞进一个包。
   */
  async function collectReferenceFiles(
    db: DbLike,
    root: string,
    lines: readonly LineSqlRow[],
    maxFiles: number,
  ): Promise<{ files: NamedFile[]; lineIds: Set<Id>; pairCount: number; warnings: string[] }> {
    const warnings: string[] = []
    const files: NamedFile[] = []
    const lineIds = new Set<Id>()
    if (lines.length === 0 || maxFiles <= 0) return { files, lineIds, pairCount: 0, warnings }

    const wanted = new Set<Id>()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const prev = i > 0 ? lines[i - 1] : null
      const next = i + 1 < lines.length ? lines[i + 1] : null
      for (const neighbor of [prev, next]) {
        if (!neighbor || neighbor.character_id === line.character_id) continue
        wanted.add(neighbor.id)
      }
    }
    if (wanted.size === 0) return { files, lineIds, pairCount: 0, warnings }

    const segmentByLine = new Map<Id, string>()
    for (const part of chunked([...wanted])) {
      const rows = db
        .prepare(`SELECT line_id, file_path FROM voice_segments WHERE line_id IN (${placeholders(part.length)})`)
        .all(...part) as Array<{ line_id: string; file_path: string }>
      for (const r of rows) segmentByLine.set(r.line_id, r.file_path)
    }

    let bytes = 0
    let truncated = false
    for (let i = 0; i < lines.length && !truncated; i++) {
      const line = lines[i]
      const candidates: Array<{ row: LineSqlRow; side: 'prev' | 'next' }> = []
      const prev = i > 0 ? lines[i - 1] : null
      const next = i + 1 < lines.length ? lines[i + 1] : null
      if (prev && prev.character_id !== line.character_id) candidates.push({ row: prev, side: 'prev' })
      if (next && next.character_id !== line.character_id) candidates.push({ row: next, side: 'next' })
      for (const cand of candidates) {
        const filePath = segmentByLine.get(cand.row.id)
        if (!filePath) continue
        if (files.length >= maxFiles || bytes >= MAX_REFERENCE_BYTES) {
          truncated = true
          break
        }
        const abs = join(root, filePath)
        if (!existsSync(abs)) continue
        const data = await readFile(abs)
        files.push({ name: `${line.id}_${cand.side}.wav`, data })
        lineIds.add(line.id)
        bytes += data.byteLength
      }
    }
    if (truncated) {
      warnings.push(
        `参考音超过上限（${maxFiles} 个文件 / ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)} MB），已截断；` +
          '需要完整参考音请调大 options.maxReferenceFiles',
      )
    }
    return { files, lineIds, pairCount: wanted.size, warnings }
  }

  async function runExportTask(payload: PackageExportTaskPayload, ctx: TaskContext): Promise<PackageExportTaskResult> {
    const db = requireDb()
    const repo = deps.repo()
    const options = payload.options ?? {}
    const warnings = unknownOptionKeys(options, NST_OPTION_KEYS).map(
      (k) => `忽略了未知的导出选项 ${k}（支持的选项：${NST_OPTION_KEYS.join(' / ')}）`,
    )
    const book = loadBook(db, payload.bookId)
    const actor = loadActor(db, payload.actorId)
    if (actor.project_id !== book.project_id) {
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          field: 'actorId',
          reason: 'actor-not-in-book-project',
          actorProjectId: actor.project_id,
          bookProjectId: book.project_id,
        },
      })
    }
    const includeContext = optionBool(options, 'includeContext', true)
    const includeNotes = optionBool(options, 'includeNotes', true)
    const includePronunciation = optionBool(options, 'includePronunciation', true)
    const includeReference = optionBool(options, 'includeReference', false)
    const allowOtherCharacterLines = optionBool(options, 'allowOtherCharacterLines', false)
    const onlyChangedLines = optionBool(options, 'onlyChangedLines', false)
    const requestedCharacters = optionStringArray(options, 'characterIds')
    const chapterIds = optionStringArray(options, 'chapterIds')
    const recordSettings = resolveRecordSettings(options.recordSettings)
    const maxReferenceFiles =
      typeof options.maxReferenceFiles === 'number' && Number.isFinite(options.maxReferenceFiles)
        ? Math.max(0, Math.floor(options.maxReferenceFiles))
        : DEFAULT_MAX_REFERENCE_FILES

    const scopeCharacters = resolveScopeCharacters(db, book, actor.id, requestedCharacters)
    const scopeCharacterIds = scopeCharacters.map((c) => c.id)
    if (chapterIds.length > 0) {
      const rows = db
        .prepare(`SELECT id FROM chapters WHERE book_id = ? AND id IN (${placeholders(chapterIds.length)})`)
        .all(book.id, ...chapterIds) as Array<{ id: string }>
      const known = new Set(rows.map((r) => r.id))
      const outside = chapterIds.filter((id) => !known.has(id))
      if (outside.length > 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            field: 'options.chapterIds',
            reason: 'chapter-not-in-book',
            bookId: book.id,
            ids: outside.slice(0, 10),
          },
        })
      }
    }

    ctx.report(0.05, '读取画本行')
    const allCharacters = loadBookCharacters(db, book.id)
    // 「允许看到其它角色的词」= 该书的全部行（含旁白）；默认只给自己的角色
    const scopeLines = allowOtherCharacterLines
      ? loadAllBookLines(db, book.id, chapterIds)
      : loadLines(db, book.id, scopeCharacterIds, chapterIds)
    if (scopeLines.length === 0) {
      throw new AppError('NOT_FOUND', {
        details: {
          entity: 'canvas_line',
          bookId: book.id,
          hint: '这个范围内没有可下发的行（先确认角色分配与章节范围）',
        },
      })
    }

    const canvasLines = scopeLines.map(toCanvasLine)
    const chapterTitleById = new Map(scopeLines.map((r) => [r.id, r.chapter_title]))
    const linesForContext = buildNstLines(canvasLines, allCharacters.map(toCharacter), {
      chapterTitle: scopeLines[0].chapter_title,
      chapterTitleOf: (line) => chapterTitleById.get(line.id) ?? '',
      includeContext,
      includeNotes,
      includePronunciation,
    })

    // 增量下发（docs/11 §6.5）：与上一次下发给同一配音员的包比对，只带变更过的行
    let exportLines = linesForContext
    if (onlyChangedLines) {
      const previous = await findPreviousTaskPackage(repo, book.project_id, actor.id)
      const prevLines = previous ? extractPackageLines(previous.manifest) : null
      if (!prevLines) {
        warnings.push('没有找到上一次的任务包，无法做「仅含变更行」的增量下发，已改为全量下发')
      } else {
        const diff = diffLines(prevLines, linesForContext)
        const keep = new Set<Id>([...diff.added, ...diff.modified])
        exportLines = linesForContext.filter((l) => keep.has(l.id))
        if (diff.removed.length > 0) {
          warnings.push(`有 ${diff.removed.length} 行已在画本中删除，本次下发不含它们`)
        }
        if (exportLines.length === 0) {
          throw new AppError('CONFLICT', {
            details: {
              reason: 'no-changed-lines',
              bookId: book.id,
              actorId: actor.id,
              hint: '画本自上次下发后没有变化，无需重新下发',
            },
          })
        }
        log.info('package.incrementalExport', {
          event: 'package.incrementalExport',
          added: diff.added.length,
          modified: diff.modified.length,
          removed: diff.removed.length,
        })
      }
    }

    // linesHash 始终按**完整作用域**算（docs/11 §6.2「全部行」）：
    // 只按增量子集算，会让回收时的比对必然不一致 —— 假报警比不报警更坏。
    const linesHash = computeLinesHash(linesForContext)
    const packageId = createPackageId()
    const root = projectAudioRoot(deps.projectRoot(), book.project_id)

    let reference: { files: NamedFile[]; lineIds: Set<Id>; pairCount: number; warnings: string[] } = {
      files: [],
      lineIds: new Set<Id>(),
      pairCount: 0,
      warnings: [],
    }
    if (includeReference) {
      ctx.report(0.2, '收集参考音')
      reference = await collectReferenceFiles(db, root, scopeLines, maxReferenceFiles)
      if (reference.files.length === 0) {
        warnings.push(
          reference.pairCount === 0
            ? '勾选了「包含参考音」，但本次下发的行之间没有对手戏（相邻行的说话人相同），包内没有参考音'
            : '勾选了「包含参考音」，但对手戏的行还没有成品片段，本次包内没有参考音',
        )
      }
      warnings.push(...reference.warnings)
    }

    const manifestCharacters = allowOtherCharacterLines
      ? allCharacters.filter((c) => c.is_archived === 0).map(toManifestCharacter)
      : scopeCharacters.map(toManifestCharacter)
    const manifest = buildNstManifest({
      packageId,
      source: { projectId: book.project_id, bookId: book.id },
      assignee: { voiceActorId: actor.id, name: actor.name, note: actor.note },
      recordSettings,
      characters: dedupeCharacters(manifestCharacters),
      lines: exportLines.map((l) => ({ ...l, hasReference: reference.lineIds.has(l.id) })),
      linesHash,
    })

    const filePath = (() => {
      const target = resolveOutputPath(
        options,
        `${sanitizeFileName(actor.name)}-${sanitizeFileName(book.title)}.nst`,
        deps.exportDir(),
      )
      const unique = avoidOverwrite(target, options.outputPath === undefined)
      if (unique.renamed) warnings.push(`同名包已存在，本次写到 ${unique.path}（未覆盖已有包）`)
      return unique.path
    })()
    const handle = await openPackageWriter(filePath, ctx.signal)
    let result: Awaited<ReturnType<typeof exportTaskPackage>>
    try {
      result = await exportTaskPackage({
        zip: handle.zip,
        manifest,
        referenceFiles: reference.files,
        onProgress: (info) => ctx.report(clamp01(info.progress), info.stage),
        signal: ctx.signal,
      })
      await handle.finish()
      await assertPackageComplete(filePath)
    } catch (e) {
      await handle.abort()
      throw e
    }

    const bytes = fileSizeOf(filePath)
    await repo.insert({
      id: packageId,
      projectId: book.project_id,
      kind: 'nst',
      direction: 'export',
      actorId: actor.id,
      bookId: book.id,
      filePath,
      linesHash,
      manifest,
      stats: {
        lines: manifest.lines.length,
        scopeLines: linesForContext.length,
        characters: manifest.characters.length,
        referenceFiles: reference.files.length,
        incremental: onlyChangedLines ? 1 : 0,
        files: result.files,
        bytes,
        uncompressedBytes: result.uncompressedBytes,
      },
      status: 'done',
      report: null,
      createdAt: now(),
      finishedAt: now(),
    })

    log.info('package.exportTaskDone', {
      event: 'package.exportTaskDone',
      taskId: ctx.taskId,
      bookId: book.id,
      actorId: actor.id,
      packageId,
      filePath,
      lines: manifest.lines.length,
      bytes,
    })
    return {
      packageId,
      filePath,
      kind: 'nst',
      linesHash,
      lines: manifest.lines.length,
      characters: manifest.characters.length,
      referenceFiles: reference.files.length,
      files: result.files,
      bytes,
      uncompressedBytes: result.uncompressedBytes,
      warnings,
    }
  }

  // -------------------------------------------------------------------------
  // ③ package.import（.nsp 导入）
  // -------------------------------------------------------------------------

  async function runImportProject(payload: PackageImportPayload, ctx: TaskContext): Promise<PackageImportResult> {
    const db = requireDb()
    const repo = deps.repo()
    const options = payload.options ?? {}
    const sourcePath = requireExistingFile(payload.path)
    const warnings: string[] = []

    ctx.report(0.05, '读取包')
    const raw = await readFile(sourcePath)
    const reader = openZip(raw, { strict: false })
    try {
      assertNoZip64(reader)
      warnings.push(...summarizeViolations(reader))

      const newProjectId = typeof options.targetProjectId === 'string' ? options.targetProjectId : newId()
      const finalDir = projectAudioRoot(deps.projectRoot(), newProjectId)
      // 先解到临时目录，成功后再改名 —— 中途失败不会在项目根下留半个项目
      const stagingDir = `${finalDir}.importing-${now()}`
      await rm(stagingDir, { recursive: true, force: true })
      await mkdir(stagingDir, { recursive: true })

      // 本地已有 id：用于 ID 冲突判定（docs/03 §8 规则 3）
      const existingProjectIds = (db.prepare(`SELECT id FROM projects`).all() as Array<{ id: string }>).map(
        (r) => r.id,
      )
      const manifestRaw = reader.has(MANIFEST_FILE) ? safeJson(reader, MANIFEST_FILE) : null
      const projectJsonRaw = reader.has('project.json') ? safeJson(reader, 'project.json') : null
      const internalIds = dedupe([...collectIdsDeep(manifestRaw ?? {}), ...collectIdsDeep(projectJsonRaw ?? {})])
      const existingEntityIds = findExistingIds(db, internalIds)

      let importResult: Awaited<ReturnType<typeof importProjectPackage>>
      try {
        importResult = await importProjectPackage({
          zip: reader,
          newProjectId,
          existingIds: { projectIds: existingProjectIds, entityIds: existingEntityIds },
          internalIds,
          idStrategy: 'preserve',
          newId,
          writeFile: async (relPath, data) => {
            const target = safeJoin(stagingDir, relPath)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, data)
          },
          onProgress: (info) => ctx.report(0.05 + clamp01(info.progress) * 0.75, info.stage),
          signal: ctx.signal,
        })
      } catch (e) {
        await rm(stagingDir, { recursive: true, force: true })
        throw e
      }

      ctx.report(0.85, '写入 ID 映射表')
      await writeFile(join(stagingDir, ID_MAP_FILE), serializeIdMap(importResult.idMap), 'utf8')
      await rm(finalDir, { recursive: true, force: true })
      await mkdir(dirname(finalDir), { recursive: true })
      await rename(stagingDir, finalDir)

      // 登记项目行：让导入的项目在列表里可见（业务数据仍为空，见下面的 warning）
      const ts = now()
      db.prepare(
        `INSERT INTO projects (id, name, description, root_dir, schema_version, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        newProjectId,
        importResult.manifest.project.name,
        `由 ${sourcePath} 导入`,
        finalDir,
        latestSchemaVersion(),
        ts,
        ts,
      )

      warnings.push(...importResult.warnings)
      // ⚠ 本轮**明确未实现**的部分，必须让用户看到（见文件头「实现边界」）
      warnings.push(
        '包内的业务数据（书籍 / 章节 / 画本行 / 角色）尚未合并进主库：本次只完成了文件解包与项目登记，' +
          '导入的项目暂时是空的；ID 映射表在同目录的 id_map.json',
      )

      const historyId = `nsp_${newId()}`
      await repo.insert({
        id: historyId,
        projectId: newProjectId,
        kind: 'nsp',
        direction: 'import',
        actorId: null,
        bookId: null,
        filePath: sourcePath,
        linesHash: null,
        manifest: importResult.manifest,
        stats: {
          writtenFiles: importResult.writtenFiles,
          skippedFiles: importResult.skippedFiles,
          checksumFailed: importResult.checksum.mismatch.length,
          remapped: importResult.idMap.remapped ? 1 : 0,
          businessDataMerged: 0,
        },
        status: 'done',
        report: null,
        createdAt: ts,
        finishedAt: ts,
      })

      ctx.report(1, '导入完成')
      log.info('package.importProjectDone', {
        event: 'package.importProjectDone',
        taskId: ctx.taskId,
        filePath: sourcePath,
        newProjectId,
        writtenFiles: importResult.writtenFiles,
        skippedFiles: importResult.skippedFiles,
        remapped: importResult.idMap.remapped,
      })
      return {
        packageId: historyId,
        filePath: sourcePath,
        projectId: newProjectId,
        projectDir: finalDir,
        writtenFiles: importResult.writtenFiles,
        skippedFiles: importResult.skippedFiles,
        remapped: importResult.idMap.remapped,
        businessDataMerged: false,
        warnings,
      }
    } finally {
      reader.close()
    }
  }

  // -------------------------------------------------------------------------
  // ④ package.merge（.nst 回收合并）
  // -------------------------------------------------------------------------

  async function runMerge(payload: PackageMergePayload, ctx: TaskContext): Promise<PackageMergeResult> {
    const db = requireDb()
    const repo = deps.repo()
    const project = loadProject(db, payload.projectId)
    const sourcePath = requireExistingFile(payload.path)

    ctx.report(0.05, '读取回传包')
    const raw = await readFile(sourcePath)
    const reader = openZip(raw, { strict: false })
    try {
      assertNoZip64(reader)
      const parsed = parseTaskPackage(reader)
      const manifest = parsed.manifest
      for (const w of [...parsed.warnings, ...summarizeViolations(reader)]) {
        log.warn('package.mergeWarning', { event: 'package.mergeWarning', taskId: ctx.taskId, warning: w })
      }
      if (manifest.source.projectId !== project.id) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            field: 'path',
            reason: 'package-project-mismatch',
            expectedProjectId: project.id,
            actualProjectId: manifest.source.projectId,
            hint: '这个任务包不属于当前项目；跨项目回传需要先用 id_map.json 翻译 id（本轮未接线）',
          },
        })
      }

      const historyId = newId()
      // 先落一行 running：崩溃后历史里能看出「这次合并没收尾」，而不是凭空消失
      await repo.insert({
        id: historyId,
        projectId: project.id,
        kind: 'nst',
        direction: 'merge',
        actorId: manifest.assignee.voiceActorId,
        bookId: manifest.source.bookId,
        filePath: sourcePath,
        linesHash: manifest.linesHash,
        manifest,
        stats: { returned: 0, placed: 0 },
        status: 'running',
        report: null,
        createdAt: now(),
        finishedAt: null,
      })

      try {
        ctx.report(0.15, '比对画本与已有 take')
        const local = await loadMergeLocalState(db, project.id, manifest, reader)
        const skips: MergeSkip[] = []
        const hooks = buildMergeHooks(db, project.id, manifest, ctx, skips)
        const merged = await mergeTaskPackageFromZip({ zip: reader, manifest, local, hooks })
        const report = merged.report
        for (const w of merged.warnings) {
          log.warn('package.mergeWarning', { event: 'package.mergeWarning', taskId: ctx.taskId, warning: w })
        }
        // 音质异常（采样率/位深不符、过短）：**入库但标记 flags**（docs/03 §9），
        // 供质检视图筛选。merge.ts 只在报告里给出明细，flags 落库要在这里补。
        for (const issue of merged.auditIssues) {
          db.prepare(`UPDATE takes SET flags = ? WHERE id = ?`).run(JSON.stringify(issue.issues), issue.takeId)
        }
        const stats: PackageStats = {
          returned: merged.counters.returned,
          placed: report.placed,
          missing: report.missing.length,
          unknown: report.unknown.length,
          checksumFailed: report.checksumFailed,
          corrupted: report.corrupted,
          duplicateTakes: report.duplicateTakes,
          adopted: report.adopted,
          diffCount: report.diffCount,
          skipped: skips.length,
          auditIssues: merged.auditIssues.length,
        }
        await repo.update(historyId, { status: 'done', report, stats, finishedAt: now() })
        ctx.report(1, '合并完成')
        log.info('package.mergeDone', {
          event: 'package.mergeDone',
          taskId: ctx.taskId,
          projectId: project.id,
          packageId: manifest.packageId,
          placed: report.placed,
          missing: report.missing.length,
          unknown: report.unknown.length,
          linesChanged: report.linesChanged,
        })
        return report
      } catch (e) {
        await repo.update(historyId, {
          status: 'failed',
          finishedAt: now(),
          stats: { returned: 0, placed: 0, failed: 1 },
        })
        throw e
      }
    } finally {
      reader.close()
    }
  }

  /**
   * 合并用的本地状态。
   *
   * ### 作用域必须与导出时**一致**（这一点错了整个回收就废了）
   *   `merge.ts` 用 `computeLinesHash(local.lines)` 与 `manifest.linesHash` 比对，
   *   而 `.nst` 只带**该配音员作用域内的行**（docs/11 §6.2）。所以本地也必须只取
   *   同一作用域（`manifest.characters` 里的角色 + 包内出现过的行）。
   *   若这里传「全项目的行」，每一次回收都会报「画本已变更」—— 假报警会让用户
   *   再也不相信这个提示，比不提示更糟（docs/11 §8 的那条边界就靠这里守住）。
   */
  async function loadMergeLocalState(
    db: DbLike,
    projectId: Id,
    manifest: { characters: Array<{ id: Id }>; lines: Array<{ id: Id }> },
    reader: ZipReader,
  ): Promise<MergeLocalState> {
    const characterIds = manifest.characters.map((c) => c.id)
    const manifestLineIds = manifest.lines.map((l) => l.id)
    const rows: LineSqlRow[] = []
    if (characterIds.length > 0) {
      for (const part of chunked(characterIds)) {
        rows.push(
          ...(db
            .prepare(`${SELECT_LINE_SQL}
               JOIN books b ON b.id = l.book_id
              WHERE b.project_id = ? AND l.deleted_at IS NULL AND c.deleted_at IS NULL
                AND l.character_id IN (${placeholders(part.length)})`)
            .all(projectId, ...part) as LineSqlRow[]),
        )
      }
    }
    if (manifestLineIds.length > 0) {
      for (const part of chunked(manifestLineIds)) {
        rows.push(
          ...(db
            .prepare(`${SELECT_LINE_SQL}
               JOIN books b ON b.id = l.book_id
              WHERE b.project_id = ? AND l.deleted_at IS NULL AND c.deleted_at IS NULL
                AND l.id IN (${placeholders(part.length)})`)
            .all(projectId, ...part) as LineSqlRow[]),
        )
      }
    }
    // 去重 + 按（章节序, 行序）排序：与导出时的顺序一致（linesHash 对顺序敏感）
    const unique = new Map<Id, LineSqlRow>()
    for (const r of rows) unique.set(r.id, r)
    const ordered = [...unique.values()].sort(
      (a, b) => a.chapter_seq - b.chapter_seq || a.seq - b.seq || (a.id < b.id ? -1 : 1),
    )

    // 已有 take：只对**同一 takeId** 的文件算内容哈希（去重只比较同 takeId 的内容，
    // 所以不必把整库的音频都读一遍 —— 那会让回收在几 GB 的项目上卡死）
    const incoming = listSlotEntries(reader)
    const incomingTakeIds = new Map<Id, Set<Id>>()
    for (const e of incoming.entries) {
      const set = incomingTakeIds.get(e.lineId)
      if (set) set.add(e.takeId)
      else incomingTakeIds.set(e.lineId, new Set([e.takeId]))
    }
    const involvedLineIds = dedupe([...ordered.map((l) => l.id), ...incomingTakeIds.keys()])
    const takeRows: Array<{ id: string; line_id: string; file_path: string }> = []
    for (const part of chunked(involvedLineIds)) {
      takeRows.push(
        ...(db
          .prepare(
            `SELECT id, line_id, file_path FROM takes
              WHERE line_id IN (${placeholders(part.length)}) AND deleted_at IS NULL`,
          )
          .all(...part) as Array<{ id: string; line_id: string; file_path: string }>),
      )
    }
    const root = projectAudioRoot(deps.projectRoot(), projectId)
    const existingTakes: Array<{ lineId: Id; takeId: Id; contentHash?: string | null }> = []
    for (const t of takeRows) {
      if (incomingTakeIds.get(t.line_id)?.has(t.id) !== true) {
        existingTakes.push({ lineId: t.line_id, takeId: t.id })
        continue
      }
      const abs = join(root, t.file_path)
      existingTakes.push({
        lineId: t.line_id,
        takeId: t.id,
        contentHash: existsSync(abs) ? sha256Hex(await readFile(abs)) : null,
      })
    }

    const segmentLineIds = new Set<Id>()
    for (const part of chunked(involvedLineIds)) {
      const segRows = db
        .prepare(`SELECT line_id FROM voice_segments WHERE line_id IN (${placeholders(part.length)})`)
        .all(...part) as Array<{ line_id: string }>
      for (const r of segRows) segmentLineIds.add(r.line_id)
    }

    return {
      lines: ordered.map(toLineHashInput),
      existingTakes,
      hasSegment: (lineId) => segmentLineIds.has(lineId),
    }
  }

  /**
   * 合并的副作用钩子（docs/11 §6.4 第 3 步「逐行归位」）。
   *
   * 全部是**真实 IO**：
   *   · `writeTake`  → 落盘 `takes/{lineId}/{takeId}.wav`
   *   · `insertTake` → 写 `takes` 表（`source='package'`，带 package_id 溯源）
   *   · `adoptTake`  → 复制成品片段 `segments/{id}.wav` 并写 `voice_segments` 行
   */
  function buildMergeHooks(
    db: DbLike,
    projectId: Id,
    manifest: {
      packageId: Id
      recordSettings: { sampleRate: number; bitDepth: number; channels: number }
    },
    ctx: TaskContext,
    skips: MergeSkip[],
  ): MergeHooks {
    const root = projectAudioRoot(deps.projectRoot(), projectId)
    const written = new Map<string, Uint8Array>()

    return {
      signal: ctx.signal,
      now,
      validateAudio: true,
      adoptWhenNoRecording: true,
      onProgress: (info) => ctx.report(clamp01(info.progress), info.stage),
      onSkip: (skip) => {
        skips.push(skip)
        ctx.log('package.mergeSkip', {
          lineId: skip.lineId,
          takeId: skip.takeId,
          reason: skip.reason,
          message: skip.message,
        })
      },

      async writeTake({ lineId, takeId, bytes, contentHash }) {
        const rel = `takes/${lineId}/${takeId}.wav`
        const abs = join(root, rel)
        let targetRel = rel
        if (existsSync(abs)) {
          // 同 takeId 但内容不同 = 重录：**绝不覆盖**（docs/11 §6.4「新 take 追加，不覆盖」）
          const existingHash = sha256Hex(await readFile(abs))
          if (existingHash !== contentHash) targetRel = `takes/${lineId}/${takeId}-${contentHash.slice(0, 8)}.wav`
        }
        const targetAbs = join(root, targetRel)
        await mkdir(dirname(targetAbs), { recursive: true })
        await writeFile(targetAbs, bytes)
        written.set(`${lineId}|${takeId}`, bytes)
        return { filePath: targetRel }
      },

      async insertTake(input) {
        const bytes = written.get(`${input.lineId}|${input.takeId}`)
        // 采样率/位深/声道是 NOT NULL：优先按**真实音频头**填，退而用任务包里的录音建议
        const info = bytes ? probeWav(bytes) : null
        const sampleRate = info?.sampleRate ?? manifest.recordSettings.sampleRate
        const bitDepth = info?.bitDepth ?? manifest.recordSettings.bitDepth
        const channels = info?.channels ?? manifest.recordSettings.channels
        const durationMs = Math.max(0, Math.round(input.durationMs || info?.durationMs || 0))
        const insert = (takeId: Id): void => {
          db.prepare(
            `INSERT INTO takes (id, line_id, session_id, file_path, part_index, src_in_ms, src_out_ms,
                                trimmed_in_ms, trimmed_out_ms, duration_ms, peak_db, rms_db, lufs, gain_db,
                                sample_rate, bit_depth, channels, source, package_id, flags, is_selected,
                                note, recorded_at, created_at)
             VALUES (?, ?, NULL, ?, 0, 0, ?, 0, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, 'package', ?, '[]', 0,
                     NULL, ?, ?)`,
          ).run(
            takeId,
            input.lineId,
            input.filePath,
            durationMs,
            durationMs,
            durationMs,
            input.peakDb,
            sampleRate,
            bitDepth,
            channels,
            input.packageId,
            input.recordedAt || now(),
            now(),
          )
        }
        try {
          insert(input.takeId)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!/UNIQUE|PRIMARY/i.test(msg)) throw e
          // 同 takeId 已在库里（多为软删除行或不同内容的重录）→ 换一个新 id，两边都保住
          const replacement = `take_${newId()}`
          insert(replacement)
          log.warn('package.takeIdReplaced', {
            event: 'package.takeIdReplaced',
            lineId: input.lineId,
            requestedTakeId: input.takeId,
            storedTakeId: replacement,
          })
          return { takeId: replacement }
        }
        return undefined
      },

      async adoptTake(input) {
        // 已有成品片段 → 不动（`voice_segments.line_id` 是 UNIQUE，docs/03 §11）
        const existing = db.prepare(`SELECT id FROM voice_segments WHERE line_id = ?`).get(input.lineId) as
          | { id: string }
          | undefined
        if (existing) return
        const lineRow = db.prepare(`SELECT chapter_id FROM canvas_lines WHERE id = ?`).get(input.lineId) as
          | { chapter_id: string }
          | undefined
        if (!lineRow) return
        if (!input.filePath) {
          log.warn('package.adoptSkipped', {
            event: 'package.adoptSkipped',
            lineId: input.lineId,
            reason: 'take-file-missing',
          })
          return
        }
        const srcAbs = join(root, input.filePath)
        if (!existsSync(srcAbs)) {
          // 绝不写一个指向不存在文件的成品片段行：那会让播放按钮永远报 404
          log.warn('package.adoptSkipped', {
            event: 'package.adoptSkipped',
            lineId: input.lineId,
            reason: 'take-file-not-on-disk',
            filePath: input.filePath,
          })
          return
        }
        const segmentId = `seg_${newId()}`
        const segmentRel = `segments/${segmentId}.wav`
        await mkdir(join(root, 'segments'), { recursive: true })
        const srcBytes = await readFile(srcAbs)
        await copyFile(srcAbs, join(root, segmentRel))
        const info = probeWav(srcBytes)
        const durationMs = Math.max(0, Math.round(input.durationMs || info?.durationMs || 0))
        const ts = now()
        // peak/rms 留 NULL：它们要**解码**音频才算得出来，而 `wav.ts` 只读文件头。
        // 填 0 或 -6 这种「看起来有值」的假数据，会让质检界面显示误导性的数字。
        db.prepare(
          `INSERT INTO voice_segments (id, line_id, chapter_id, take_id, file_path, processed_path, preset_hash,
                                       src_in_ms, src_out_ms, duration_ms, peak_db, rms_db, lufs, flags,
                                       created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL, NULL, NULL, '[]', ?, ?)`,
        ).run(
          segmentId,
          input.lineId,
          lineRow.chapter_id,
          input.takeId,
          segmentRel,
          durationMs,
          durationMs,
          ts,
          ts,
        )
      },
    }
  }

  // -------------------------------------------------------------------------
  // 对外
  // -------------------------------------------------------------------------

  const exportSpec: TaskSpec<PackageExportPayload, unknown> = {
    kind: 'package.export' as TaskKind,
    // 导出是 IO 密集型（可能写几 GB）；与 ffmpeg 分开限流，避免导出把转码挤掉
    concurrencyKey: 'package',
    priority: 0,
    dedupeKey: (payload) =>
      payload.op === 'project'
        ? `package.nsp:${payload.projectId}`
        : `package.nst:${payload.bookId}:${payload.actorId}:${JSON.stringify(payload.options ?? {})}`,
    run: (ctx, payload) => (payload.op === 'project' ? runExportProject(payload, ctx) : runExportTask(payload, ctx)),
  }

  const importSpec: TaskSpec<PackageImportPayload, PackageImportResult> = {
    kind: 'package.import' as TaskKind,
    concurrencyKey: 'package',
    priority: 0,
    dedupeKey: (payload) => `package.import:${resolve(payload.path)}`,
    run: (ctx, payload) => runImportProject(payload, ctx),
  }

  const mergeSpec: TaskSpec<PackageMergePayload, PackageMergeResult> = {
    kind: 'package.merge' as TaskKind,
    concurrencyKey: 'package',
    priority: 0,
    dedupeKey: (payload) => `package.merge:${payload.projectId}:${resolve(payload.path)}`,
    run: (ctx, payload) => runMerge(payload, ctx),
  }

  return {
    taskSpecs() {
      return [
        exportSpec as TaskSpec<unknown, unknown>,
        importSpec as TaskSpec<unknown, unknown>,
        mergeSpec as TaskSpec<unknown, unknown>,
      ]
    },

    async enqueueExportProject(projectId, options) {
      const queue = requireQueue()
      const project = loadProject(requireDb(), projectId)
      const task = await queue.enqueue(
        'package.export',
        { op: 'project', projectId: project.id, options: options ?? {} } satisfies PackageExportProjectPayload,
        { projectId: project.id },
      )
      log.info('package.enqueued', {
        event: 'package.enqueued',
        taskId: task.taskId,
        kind: 'package.export(nsp)',
        projectId: project.id,
      })
      return { taskId: task.taskId }
    },

    async enqueueExportTask(bookId, actorId, options) {
      const queue = requireQueue()
      const db = requireDb()
      const book = loadBook(db, bookId)
      const actor = loadActor(db, actorId)
      if (actor.project_id !== book.project_id) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { field: 'actorId', reason: 'actor-not-in-book-project', actorId, bookId },
        })
      }
      const task = await queue.enqueue(
        'package.export',
        { op: 'task', bookId: book.id, actorId: actor.id, options: options ?? {} } satisfies PackageExportTaskPayload,
        { projectId: book.project_id },
      )
      log.info('package.enqueued', {
        event: 'package.enqueued',
        taskId: task.taskId,
        kind: 'package.export(nst)',
        bookId,
        actorId,
      })
      return { taskId: task.taskId }
    },

    async enqueueImportProject(path, options) {
      const queue = requireQueue()
      const abs = requireExistingFile(path)
      const task = await queue.enqueue(
        'package.import',
        { path: abs, options: options ?? {} } satisfies PackageImportPayload,
        {},
      )
      log.info('package.enqueued', {
        event: 'package.enqueued',
        taskId: task.taskId,
        kind: 'package.import',
        path: abs,
      })
      return { taskId: task.taskId }
    },

    async enqueueMergeTask(projectId, path) {
      const queue = requireQueue()
      const project = loadProject(requireDb(), projectId)
      const abs = requireExistingFile(path)
      const task = await queue.enqueue(
        'package.merge',
        { projectId: project.id, path: abs } satisfies PackageMergePayload,
        { projectId: project.id },
      )
      log.info('package.enqueued', {
        event: 'package.enqueued',
        taskId: task.taskId,
        kind: 'package.merge',
        projectId: project.id,
      })
      return { taskId: task.taskId }
    },

    runNowExport: (payload, ctx) =>
      payload.op === 'project' ? runExportProject(payload, ctx) : runExportTask(payload, ctx),
    runNowImport: (payload, ctx) => runImportProject(payload, ctx),
    runNowMerge: (payload, ctx) => runMerge(payload, ctx),
  }
}

// ============================================================================
// 常量与纯函数（供任务体内外共用）
// ============================================================================

/** 4 GiB：自研 ZIP 读取器不支持 ZIP64，超过它产出的包本应用读不回来 */
const ZIP64_LIMIT_BYTES = 4 * 1024 ** 3
const MAX_REFERENCE_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_REFERENCE_FILES = 100

/**
 * 上一份下发给同一配音员的任务包（增量下发的比对基准，docs/11 §6.5）。
 *
 * 走仓储的 `listByProject` 而不是自己写 SQL：JSON 列的解析口径只应该有一份，
 * 否则「增量下发」与「历史列表」会对同一份 manifest 给出不同理解。
 */
async function findPreviousTaskPackage(repo: PackageRepo, projectId: Id, actorId: Id): Promise<PackageRow | null> {
  const rows = await repo.listByProject(projectId, 200)
  return (
    rows.find(
      (r) => r.kind === 'nst' && r.direction === 'export' && r.actorId === actorId && r.status === 'done',
    ) ?? null
  )
}

/** 从上一份包的 manifest 里取出行（增量下发的比对基准） */
function extractPackageLines(manifest: unknown): NstLine[] | null {
  if (manifest === null || typeof manifest !== 'object') return null
  const lines = (manifest as { lines?: unknown }).lines
  return Array.isArray(lines) ? (lines as NstLine[]) : null
}

/** 候选 id 在主库里的存在性（导入的 ID 冲突判定，走主键索引，不做全表扫） */
function findExistingIds(db: DbLike, ids: readonly Id[]): Id[] {
  if (ids.length === 0) return []
  const tables = ['projects', 'books', 'chapters', 'canvas_lines', 'characters', 'voice_actors']
  const existing: Id[] = []
  // 每块 100 个 id × 6 张表 = 600 个绑定参数，远低于 SQLite 的 999 上限
  for (const part of chunked(ids, 100)) {
    const marks = placeholders(part.length)
    const sql = tables.map((t) => `SELECT id FROM ${t} WHERE id IN (${marks})`).join(' UNION ')
    const rows = db.prepare(sql).all(...tables.flatMap(() => part)) as Array<{ id: string }>
    for (const r of rows) existing.push(r.id)
  }
  return dedupe(existing)
}

function safeJson(reader: ZipReader, name: string): unknown {
  try {
    return JSON.parse(reader.readText(name)) as unknown
  } catch {
    return null
  }
}

/**
 * 把条目名安全地拼到根目录下。
 *
 * `zip/reader.ts` 已经拒绝路径穿越条目，这里是**第二道**（防御性）：将来换了读取器
 * 实现、或放宽了严格模式，也不会把文件写到项目目录之外。
 */
function safeJoin(rootDir: string, relPath: string): string {
  const target = resolve(rootDir, relPath.replace(/\\/g, '/'))
  const base = resolve(rootDir)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'entry-escapes-target-dir', entry: relPath, target },
    })
  }
  return target
}

/** 自研读取器不支持 ZIP64：明确拒绝，而不是读出一半再失败 */
function assertNoZip64(reader: ZipReader): void {
  if (reader.violations.some((v) => v.kind === 'zip64')) {
    throw new AppError('PACKAGE_INVALID', {
      details: {
        reason: 'zip64-unsupported',
        hint: '4 GiB 以上的包需要 ZIP64 支持（当前实现不支持）；请减少内容清单后重新导出',
      },
    })
  }
}

/** 解压防护命中的条目要在结果里说清楚，否则用户只看到「少了一些文件」 */
function summarizeViolations(reader: ZipReader): string[] {
  const relevant = reader.violations.filter((v) => v.kind !== 'zip64')
  if (relevant.length === 0) return []
  const byKind = new Map<string, string[]>()
  for (const v of relevant) {
    const list = byKind.get(v.kind)
    if (list) list.push(v.name ?? '(未命名条目)')
    else byKind.set(v.kind, [v.name ?? '(未命名条目)'])
  }
  return [...byKind.entries()].map(
    ([kind, names]) => `包内有 ${names.length} 个条目被安全策略拒绝（${kind}）：${names.slice(0, 5).join(', ')}`,
  )
}
