/**
 * Novel Studio · 书籍导入域 · 行映射（snake_case ↔ camelCase）
 * ============================================================================
 * 设计依据：docs/01「命名约定」（领域层 camelCase）、docs/21「数据字典」（存储层 snake_case）
 *
 * ### 为什么映射单独一层
 *   · SQL 列名是 snake_case（`content_hash`、`source_type`），领域类型是 camelCase
 *     （`contentHash`、`sourceType`）。两边的命名约定都是有意的，不该为了一致性改动任一侧。
 *   · 映射是**最容易写错且最难发现**的地方：`content_hash` 写成 `contentHash` 不会报错，
 *     只会让某个字段永远是 `undefined`。把它集中在一处，出错面最小。
 *
 * ### NULL 的处理纪律
 *   数据库里可空列读出来是 `null`，而领域类型里有的字段是 `string | null`、
 *   有的是 `string`（非空，用 '' 表示空）。这里**逐字段显式处理**，不用
 *   `?? null` 一把梭 —— 那会让「非空字段」拿到 null，进而在 UI 上显示成 "null"。
 */

import type {
  Book,
  BookSourceType,
  Chapter,
  ChapterCanvasState,
  ChapterKind,
  Id,
  Timestamp,
} from '../../../../../shared/types.ts'

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string
  name: string
  description: string | null
  root_dir: string
  schema_version: number
  settings: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface Project {
  id: Id
  name: string
  description: string | null
  rootDir: string
  schemaVersion: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rootDir: row.root_dir,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// books
// ---------------------------------------------------------------------------

export interface BookRow {
  id: string
  project_id: string
  title: string
  author: string | null
  narrator: string | null
  language: string
  source_type: string
  source_path: string | null
  source_pages: string | null
  encoding: string | null
  content_hash: string
  char_count: number
  chapter_count: number
  cover_path: string | null
  metadata: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export function bookFromRow(row: BookRow): Book {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    // 可空列 → 领域类型也是 `| null`，直接透传
    author: row.author,
    // `narrator` 在库里可空、在领域类型里是**非空 string**（空串表示未设置）。
    // 这里必须合并 null → ''，否则 UI 会显示 "null"。
    narrator: row.narrator ?? '',
    language: row.language,
    sourceType: row.source_type as BookSourceType,
    sourcePath: row.source_path,
    encoding: row.encoding,
    contentHash: row.content_hash,
    charCount: row.char_count,
    chapterCount: row.chapter_count,
    coverPath: row.cover_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 领域对象 → INSERT 参数。
 *
 * 用**显式列名 + 显式值**（而不是 `INSERT ... SELECT` 或对象展开）：
 * 列顺序与值顺序必须一一对应，这是唯一能让人一眼核对的方式。
 */
export function bookToInsertParams(book: Book): unknown[] {
  return [
    book.id,
    book.projectId,
    book.title,
    book.author,
    book.narrator,
    book.language,
    book.sourceType,
    book.sourcePath,
    null, // source_pages：URL 抓取的页面列表由 web.parser 单独处理，这里不写
    book.encoding,
    book.contentHash,
    book.charCount,
    book.chapterCount,
    book.coverPath,
    null, // metadata
    book.createdAt,
    book.updatedAt,
  ]
}

/** books 表里允许被 `update()` 改的列（camelCase → 列名）；id/projectId/createdAt 不可改 */
export const BOOK_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  author: 'author',
  narrator: 'narrator',
  language: 'language',
  sourceType: 'source_type',
  sourcePath: 'source_path',
  encoding: 'encoding',
  contentHash: 'content_hash',
  charCount: 'char_count',
  chapterCount: 'chapter_count',
  coverPath: 'cover_path',
}

// ---------------------------------------------------------------------------
// chapters
// ---------------------------------------------------------------------------

export interface ChapterRow {
  id: string
  book_id: string
  seq: number
  title: string
  kind: string
  volume_seq: number | null
  volume_title: string | null
  raw_text: string
  source_text: string | null
  char_count: number
  start_offset: number
  end_offset: number
  clean_report: string | null
  canvas_state: string
  line_count: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export function chapterFromRow(row: ChapterRow): Chapter {
  return {
    id: row.id,
    bookId: row.book_id,
    seq: row.seq,
    title: row.title,
    kind: row.kind as ChapterKind,
    volumeSeq: row.volume_seq,
    volumeTitle: row.volume_title,
    charCount: row.char_count,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    canvasState: row.canvas_state as ChapterCanvasState,
    lineCount: row.line_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function chapterToInsertParams(
  chapter: Chapter,
  rawText: string,
  sourceText: string | null,
  cleanReportJson: string | null,
): unknown[] {
  return [
    chapter.id,
    chapter.bookId,
    chapter.seq,
    chapter.title,
    chapter.kind,
    chapter.volumeSeq,
    chapter.volumeTitle,
    rawText,
    sourceText,
    chapter.charCount,
    chapter.startOffset,
    chapter.endOffset,
    cleanReportJson,
    chapter.canvasState,
    chapter.lineCount,
    chapter.createdAt,
    chapter.updatedAt,
  ]
}

/** chapters 表里允许被 `update()` 改的列；文本列走 updateText，不在这里 */
export const CHAPTER_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  seq: 'seq',
  title: 'title',
  kind: 'kind',
  volumeSeq: 'volume_seq',
  volumeTitle: 'volume_title',
  charCount: 'char_count',
  startOffset: 'start_offset',
  endOffset: 'end_offset',
  canvasState: 'canvas_state',
  lineCount: 'line_count',
}
