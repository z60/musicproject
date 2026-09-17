/**
 * Novel Studio · 项目包（.nsp）导出 / 导入编排
 * ============================================================================
 * 设计依据：docs/03 §8 `.nsp` 项目包格式
 *
 * 导出规则：
 *   · manifest.json 记录格式版本、内容清单、计数与体积（docs/03 §8）
 *   · 只写 `contents` 里开启的内容 → 其余**跳过并报告**（「仅含成品片段」能显著缩小体积）
 *   · checksums.sha256 覆盖除自身以外的全部条目
 *
 * 导入规则（docs/03 §8 的四条）：
 *   1. 校验 formatVersion（过高 → PACKAGE_VERSION_TOO_NEW）
 *   2. 逐文件校验 checksums；不匹配的文件跳过并列报告，**不整体失败**
 *   3. **ID 冲突处理**：给项目分配新 projectId；内部 ID 默认保留原值
 *      （这样任务包回传才能对得上）；若与已有数据冲突则**整体重映射**并产出 id_map
 *   4. 音频按新 projectId 重写目录；库里的相对路径不变（相对路径设计的收益）
 *   5. 解压防护交给 zip/reader.ts（总大小 / 条目数 / 路径穿越 / 符号链接）
 *
 * 数据库改写需要 SQLite：本模块**不 import better-sqlite3**，
 * 而是要求注入 `rewriteDatabase`（生产用主进程的 db 事务内的 UPDATE）。
 * 缺少注入且确实需要重映射时，会在结果里标出 `requiresDatabaseRewrite` 并给出 warning，
 * 而不是假装改好了。
 */

import { randomUUID } from 'node:crypto'

import { AppError } from '../../../../shared/errors.ts'
import type { Id, NspManifest } from '../../../../shared/types.ts'
import {
  AUDIO_DIR,
  CHECKSUMS_FILE,
  DATABASE_FILE,
  EXPORTS_DIR,
  MANIFEST_FILE,
  PROJECT_FILE,
  buildNspManifest,
  validateNspManifest,
  type NspContents,
} from './manifest.ts'
import { formatChecksumsFile, sha256Hex, verifyPackage, type VerifyPackageResult, type ChecksumEntry } from './checksums.ts'
import { throwIfAborted, type ZipWriter } from './zip/writer.ts'
import type { ZipReader } from './zip/reader.ts'

// ============================================================================
// 导出
// ============================================================================

/** 由调用方（主进程）按 contents 准备好的文件清单 —— 本模块不做 IO */
export interface NspExportFiles {
  /** 数据库快照字节（VACUUM INTO 的产物）；contents.database=false 时忽略 */
  database?: Uint8Array | null
  /** project.json 的内容（任意可 JSON 序列化对象） */
  projectJson?: unknown
  /** 音频目录内容：键为 `recordings`/`takes`/`segments`/`processed`/`music` */
  audio?: Partial<Record<'recordings' | 'takes' | 'segments' | 'processed' | 'music', ReadonlyArray<NamedFile>>>
  /** 导出成品（`exports/…`） */
  exports?: ReadonlyArray<NamedFile>
}

export interface NamedFile {
  /** 相对于所在目录的名字（允许带子目录，如 `第1章/001.mp3`） */
  name: string
  data: Uint8Array
}

export interface NspExportInput {
  zip: ZipWriter
  project: { id: Id; name: string; totalDurationMs: number }
  schemaVersion: number
  contents: NspContents
  counts: { chapters: number; lines: number; segments: number }
  files?: NspExportFiles
  app?: { name: string; version: string }
  exportedAt?: string
  onProgress?: (info: { stage: string; progress: number; entries: number; bytes: number }) => void
  signal?: AbortSignal
}

export interface NspExportResult {
  manifest: NspManifest
  entries: string[]
  files: number
  uncompressedBytes: number
  bytes: number
  /** 因 contents 关闭而未写入的类别（必须在 UI 上说明，避免用户以为导出完整） */
  skipped: string[]
  checksumEntries: number
}

const AUDIO_KEYS = ['recordings', 'takes', 'segments', 'processed', 'music'] as const

/**
 * 编排 .nsp 导出。
 *
 * 顺序：manifest.json → project.json → database.sqlite → audio/** → exports/** →
 *       checksums.sha256 → finalize（每步可取消、可报进度）
 */
export async function exportProjectPackage(input: NspExportInput): Promise<NspExportResult> {
  const { zip, contents } = input
  const skipped: string[] = []
  const checksumInputs: ChecksumEntry[] = []
  /** 逐条目原始大小（ZipWriter 接口不提供回读，所以写入时自己记账） */
  const sizeByPath = new Map<string, number>()
  const report = (stage: string, progress: number): void =>
    input.onProgress?.({ stage, progress, entries: zip.entries.length, bytes: 0 })

  try {
    throwIfAborted(input.signal)

    const addEntry = async (path: string, data: Uint8Array, store = true): Promise<void> => {
      throwIfAborted(input.signal)
      await zip.addFile(path, data, { store })
      checksumInputs.push({ path, hash: sha256Hex(data) })
      sizeByPath.set(path, data.byteLength)
    }

    // ---- 1) project.json ----
    report('写入 project.json', 0.05)
    const projectJson = input.files?.projectJson ?? {
      project: input.project,
      contents: input.contents,
      schemaVersion: input.schemaVersion,
    }
    await addEntry(PROJECT_FILE, Buffer.from(JSON.stringify(projectJson, null, 2), 'utf8'))

    // ---- 2) database.sqlite ----
    if (contents.database) {
      const db = input.files?.database
      if (db && db.byteLength > 0) {
        report('写入数据库快照', 0.15)
        await addEntry(DATABASE_FILE, db)
      } else {
        skipped.push('数据库快照（本次没有可用的快照文件）')
      }
    } else {
      skipped.push('数据库快照')
    }

    // ---- 3) audio/** ----
    let audioWritten = 0
    const totalAudio = AUDIO_KEYS.reduce((n, k) => n + (contents[k] ? (input.files?.audio?.[k]?.length ?? 0) : 0), 0)
    for (const key of AUDIO_KEYS) {
      if (!contents[key]) {
        skipped.push(`音频目录 ${AUDIO_DIR}/${key}`)
        continue
      }
      const list = input.files?.audio?.[key] ?? []
      for (const f of list) {
        audioWritten++
        report(
          `写入 ${AUDIO_DIR}/${key}/${f.name}`,
          0.15 + 0.55 * (audioWritten / Math.max(1, totalAudio)),
        )
        await addEntry(`${AUDIO_DIR}/${key}/${normalizeRelPath(f.name)}`, f.data)
      }
    }

    // ---- 4) exports/** ----
    if (contents.exports) {
      const list = input.files?.exports ?? []
      for (const f of list) {
        throwIfAborted(input.signal)
        report(`写入 ${EXPORTS_DIR}/${f.name}`, 0.75)
        await addEntry(`${EXPORTS_DIR}/${normalizeRelPath(f.name)}`, f.data)
      }
    } else {
      skipped.push('导出成品目录')
    }

    // ---- 5) manifest.json（最后写，因为要统计 files/bytes）----
    throwIfAborted(input.signal)
    report('写入 manifest.json', 0.85)
    const uncompressedBytes = [...sizeByPath.values()].reduce((n, v) => n + v, 0)
    const manifest = buildNspManifest({
      project: input.project,
      schemaVersion: input.schemaVersion,
      contents: input.contents,
      counts: input.counts,
      files: checksumInputs.length + 2, // + manifest.json + checksums.sha256
      uncompressedBytes,
      app: input.app,
      exportedAt: input.exportedAt,
    })
    const manifestJson = JSON.stringify(manifest, null, 2)
    await zip.addFile(MANIFEST_FILE, Buffer.from(manifestJson, 'utf8'), { store: true })

    // ---- 6) checksums.sha256（不含自身与 manifest）----
    throwIfAborted(input.signal)
    report('写入 checksums.sha256', 0.92)
    const checksumsText = formatChecksumsFile(checksumInputs)
    await zip.addFile(CHECKSUMS_FILE, Buffer.from(checksumsText, 'utf8'), { store: true })

    throwIfAborted(input.signal)
    const result = await zip.finalize()
    report('导出完成', 1)
    return {
      manifest,
      entries: result.entries,
      files: result.entries.filter((e) => !e.endsWith('/')).length,
      uncompressedBytes,
      bytes: result.bytes,
      skipped,
      checksumEntries: checksumInputs.length,
    }
  } catch (e) {
    await zip.abort()
    throw e
  }
}

function normalizeRelPath(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, '')
}

// ============================================================================
// 导入
// ============================================================================

export interface NspIdMap {
  /** 旧 projectId → 新 projectId */
  projectId: { from: Id; to: Id }
  /** 旧内部 ID → 新内部 ID（保留策略时为空对象） */
  map: Record<Id, Id>
  /** 是否真的做了重映射 */
  remapped: boolean
  /** 触发重映射的原因（诊断与 UI 提示） */
  reason: string
}

export interface NspExistingIds {
  projectIds?: readonly Id[]
  bookIds?: readonly Id[]
  chapterIds?: readonly Id[]
  lineIds?: readonly Id[]
  characterIds?: readonly Id[]
  voiceActorIds?: readonly Id[]
  /** 除项目 id 外的其它实体 id（统一处理） */
  entityIds?: readonly Id[]
}

export interface NspImportInput {
  zip: ZipReader
  /** 新 projectId（导入时重新分配；不传则随机生成） */
  newProjectId?: Id
  /** 库里已有的 id 集合（用于冲突检测） */
  existingIds?: NspExistingIds
  /**
   * 本项目内部实体 id（推荐由调用方从数据库快照里查出后传入）。
   * 不传时会退化为「manifest 的 project.id + project.json 里递归出现的 id」。
   */
  internalIds?: readonly Id[]
  /**
   * ID 策略：
   *   · 'preserve'（默认，docs/03 §8 规则 3）—— 内部 ID 保留原值，冲突时整体重映射
   *   · 'remap'                    —— 强制整体重映射
   */
  idStrategy?: 'preserve' | 'remap'
  /** 落盘钩子：把条目写到新项目目录（相对项目根路径 + 字节） */
  writeFile?: (relPath: string, data: Uint8Array) => Promise<void> | void
  /**
   * 数据库改写钩子（重映射时必需）：
   * 生产实现用 better-sqlite3 在事务里跑 `UPDATE ... SET id = ?` 与所有外键列。
   */
  rewriteDatabase?: (bytes: Uint8Array, idMap: NspIdMap) => Promise<Uint8Array> | Uint8Array
  /** 注入 id 生成器（测试可确定性） */
  newId?: () => Id
  onProgress?: (info: { stage: string; progress: number; entries: number; bytes: number }) => void
  signal?: AbortSignal
}

export interface NspImportFileResult {
  path: string
  bytes: number
  /** 'written' | 'skipped-mismatch' | 'skipped-missing' | 'skipped-unreadable' */
  status: 'written' | 'skipped-mismatch' | 'skipped-missing' | 'skipped-unreadable'
}

export interface NspImportResult {
  manifest: NspManifest
  newProjectId: Id
  idMap: NspIdMap
  checksum: VerifyPackageResult
  files: NspImportFileResult[]
  /** 需要调用方补齐数据库改写（本模块不改 SQLite） */
  requiresDatabaseRewrite: boolean
  warnings: string[]
  writtenFiles: number
  skippedFiles: number
}

/**
 * 编排 .nsp 导入（docs/03 §8 规则 1~4）。
 *
 * 注意：**不做解压防护**（那在 `openZip` 里，打开时就已经拦住了）。
 */
export async function importProjectPackage(input: NspImportInput): Promise<NspImportResult> {
  const { zip } = input
  const newId = input.newId ?? randomUUID
  const warnings: string[] = []
  const files: NspImportFileResult[] = []

  if (!zip.has(MANIFEST_FILE)) {
    throw new AppError('PACKAGE_INVALID', {
      details: { reason: 'manifest-missing', expected: MANIFEST_FILE },
    })
  }

  const manifestText = zip.readText(MANIFEST_FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch (e) {
    throw new AppError('PACKAGE_INVALID', { cause: e, details: { reason: 'manifest-json-parse-failed' } })
  }
  // 规则 1：格式版本校验（过高 → PACKAGE_VERSION_TOO_NEW）
  const manifest = validateNspManifest(parsed)
  const newProjectId = input.newProjectId ?? newId()

  // 规则 2：逐文件校验，不匹配跳过并列报告，绝不整体失败
  const checksumsText = zip.has(CHECKSUMS_FILE) ? safeReadText(zip, CHECKSUMS_FILE) : null
  if (checksumsText === null) warnings.push('包内没有 checksums.sha256，已跳过逐文件校验')
  const checksum: VerifyPackageResult = checksumsText
    ? verifyPackage(zip, checksumsText)
    : { ok: [], mismatch: [], missing: [], unreadable: [], checked: 0 }
  if (checksum.mismatch.length > 0) {
    warnings.push(`${checksum.mismatch.length} 个文件校验不通过，已跳过（其余文件照常导入）`)
  }
  if (checksum.missing.length > 0) warnings.push(`${checksum.missing.length} 个文件在包内缺失，已跳过`)
  if (checksum.unreadable.length > 0) warnings.push(`${checksum.unreadable.length} 个文件损坏，已跳过`)

  // 规则 3：ID 冲突处理
  const projectJsonRaw = zip.has(PROJECT_FILE) ? safeReadJson(zip, PROJECT_FILE) : null
  const idMap = buildIdMap({
    manifest,
    projectJson: projectJsonRaw,
    internalIds: input.internalIds,
    oldProjectId: manifest.project.id,
    newProjectId,
    existing: input.existingIds,
    strategy: input.idStrategy ?? 'preserve',
    newId,
  })

  // 规则 4：写文件（相对路径不变，只有音频目录前缀随 projectId 变化）
  const entries = zip.listEntries()
  let index = 0
  for (const entry of entries) {
    if (input.signal?.aborted) throw new AppError('TASK_CANCELLED')
    index++
    input.onProgress?.({
      stage: `导入 ${entry.name}`,
      progress: entries.length ? index / entries.length : 1,
      entries: entries.length,
      bytes: entry.uncompressedSize,
    })

    const status: NspImportFileResult['status'] = classifyEntry(entry.name, checksum)

    let size = entry.uncompressedSize
    if (status === 'written') {
      try {
        let data = zip.readEntry(entry.name)
        if (entry.name === DATABASE_FILE && idMap.remapped) {
          if (input.rewriteDatabase) {
            data = Buffer.from(await input.rewriteDatabase(data, idMap))
          } else {
            warnings.push('数据库需要按新的 ID 映射改写，但未注入改写实现，已按原样写入（请随后用应用内的迁移流程修正）')
          }
        }
        if (input.writeFile) await input.writeFile(entry.name, data)
        size = data.byteLength
      } catch (e) {
        files.push({ path: entry.name, bytes: 0, status: 'skipped-unreadable' })
        warnings.push(`条目 ${entry.name} 读取失败，已跳过：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
    }
    files.push({ path: entry.name, bytes: size, status })
  }

  const requiresDatabaseRewrite = idMap.remapped && !input.rewriteDatabase && zip.has(DATABASE_FILE)

  return {
    manifest,
    newProjectId,
    idMap,
    checksum,
    files,
    requiresDatabaseRewrite,
    warnings,
    writtenFiles: files.filter((f) => f.status === 'written').length,
    skippedFiles: files.filter((f) => f.status !== 'written').length,
  }
}

export interface BuildIdMapInput {
  manifest: NspManifest
  /** `project.json` 的内容（会递归扫描其中的 `id` 字段） */
  projectJson?: unknown
  /** 调用方额外提供的内部实体 id（例如从数据库快照里查出来的画本行 id） */
  internalIds?: readonly Id[]
  oldProjectId: Id
  newProjectId: Id
  existing?: NspExistingIds
  strategy: 'preserve' | 'remap'
  newId: () => Id
}

/**
 * ID 冲突处理（docs/03 §8 导入规则 3）。
 *
 * 语义：
 *   · 项目 id **总是**换成新的（避免与已有项目撞名撞目录）
 *   · 其它内部实体 id 默认**保留原值**（保持任务包回传的 lineId 对应关系）
 *   · 一旦发现**任何冲突**，或策略为 'remap' → **整体重映射**
 *     （只改冲突的那几个会让 id_map 半新半旧，任务包回传时更容易错位）
 */
export function buildIdMap(input: BuildIdMapInput): NspIdMap {
  const existing = new Set<Id>([
    ...(input.existing?.projectIds ?? []),
    ...(input.existing?.bookIds ?? []),
    ...(input.existing?.chapterIds ?? []),
    ...(input.existing?.lineIds ?? []),
    ...(input.existing?.characterIds ?? []),
    ...(input.existing?.voiceActorIds ?? []),
    ...(input.existing?.entityIds ?? []),
  ])

  const internalIds = collectInternalIds(input.manifest, input.projectJson, input.internalIds)
  const conflicts = internalIds.filter((id) => existing.has(id))

  const forced = input.strategy === 'remap'
  const mustRemap = forced || conflicts.length > 0 || existing.has(input.oldProjectId)

  if (!mustRemap) {
    return {
      projectId: { from: input.oldProjectId, to: input.newProjectId },
      map: {},
      remapped: false,
      reason: '内部 ID 与现有数据无冲突，按原值保留（任务包回传的 lineId 才能对得上）',
    }
  }

  const map: Record<Id, Id> = {}
  for (const id of internalIds) map[id] = input.newId()

  return {
    projectId: { from: input.oldProjectId, to: input.newProjectId },
    map,
    remapped: true,
    reason: forced
      ? '按调用方要求强制整体重映射'
      : `检测到 ${conflicts.length + (existing.has(input.oldProjectId) ? 1 : 0)} 处 ID 冲突，已整体重映射`,
  }
}

/**
 * 需要参与冲突检测的内部实体 id。
 *
 * 来源：
 *   1. manifest.project.id（包的身份）
 *   2. `project.json` 里递归出现的 `id` 字段（项目元信息快照，docs/03 §2）
 *   3. 调用方从数据库快照里查出来的一批 id（最权威，推荐生产使用）
 */
function collectInternalIds(
  manifest: NspManifest,
  projectJson?: unknown,
  extra?: readonly Id[],
): Id[] {
  const ids = new Set<Id>([manifest.project.id])
  if (projectJson !== undefined) for (const id of collectIdsDeep(projectJson)) ids.add(id)
  for (const id of extra ?? []) ids.add(id)
  return [...ids]
}

/** 递归收集对象树里所有名为 `id` 的字符串值（去重、稳定顺序） */
export function collectIdsDeep(value: unknown): Id[] {
  const out: Id[] = []
  const seen = new Set<unknown>()
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const item of v) walk(item)
      return
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'id' && typeof child === 'string' && child.length > 0) out.push(child)
      else walk(child)
    }
  }
  walk(value)
  return [...new Set(out)]
}

/** 把 id_map 序列化成 `id_map.json`（docs/03 §8 规则 3：存于导入结果目录，供任务包回传时二次翻译） */
export function serializeIdMap(idMap: NspIdMap): string {
  return JSON.stringify(
    {
      format: 'nsp-id-map',
      formatVersion: 1,
      projectId: idMap.projectId,
      remapped: idMap.remapped,
      reason: idMap.reason,
      entities: idMap.map,
    },
    null,
    2,
  )
}

/** 按 id_map 翻译一个 id（保留策略下原样返回） */
export function translateId(idMap: NspIdMap, oldId: Id): Id {
  return idMap.map[oldId] ?? oldId
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

/**
 * 判断一个条目的导入状态（docs/03 §8 规则 2）。
 * 校验不通过/缺失/损坏 → 跳过并分类，**绝不让整体导入失败**。
 */
function classifyEntry(name: string, checksum: VerifyPackageResult): NspImportFileResult['status'] {
  if (checksum.mismatch.includes(name)) return 'skipped-mismatch'
  if (checksum.unreadable.includes(name)) return 'skipped-unreadable'
  if (checksum.missing.includes(name)) return 'skipped-missing'
  return 'written'
}
