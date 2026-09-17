/**
 * 第三方原生模块的类型补充（stub）
 * ============================================================================
 * 为什么需要这个文件：
 *   本仓库在「无网络环境」下也要保持 `tsc` 与打包链路自洽，因此对少数
 *   体积大 / 平台相关的原生依赖只声明本项目实际用到的接口。
 *
 * 注意：
 *   · 一旦安装了真实依赖（npm install），若真实包自带类型，请删除对应段落，
 *     让 TS 使用上游类型；本文件仅作占位，不是长期替代品。
 *   · 这里只声明「本项目用到的成员」，不追求完整还原上游 API。
 *
 * 对应文档：docs/02-技术选型与依赖.md §2、§4
 */

// ---------------------------------------------------------------------------
// better-sqlite3（docs/02 §2.1）
// ---------------------------------------------------------------------------

declare module 'better-sqlite3' {
  export interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }

  export interface Statement<BindParameters extends unknown[] = unknown[]> {
    run(...params: BindParameters): RunResult
    get(...params: BindParameters): unknown
    all(...params: BindParameters): unknown[]
    iterate(...params: BindParameters): IterableIterator<unknown>
    columns(): Array<{ name: string; column: string | null; table: string | null; type: string | null }>
    bind(...params: BindParameters): Statement<BindParameters>
    raw(toggle?: boolean): Statement<BindParameters>
    safeIntegers(toggle?: boolean): Statement<BindParameters>
    pluck(toggle?: boolean): Statement<BindParameters>
    expand(toggle?: boolean): Statement<BindParameters>
  }

  export interface Database {
    prepare<BindParameters extends unknown[] = unknown[]>(source: string): Statement<BindParameters>
    exec(source: string): this
    pragma(source: string, options?: { simple?: boolean }): unknown
    transaction<F extends (...args: never[]) => unknown>(fn: F): F & {
      default: F
      deferred: F
      immediate: F
      exclusive: F
    }
    close(): this
    open(): this
    inTransaction: boolean
    readonly open: boolean
    readonly memory: boolean
    readonly name: string
    backup(destination: string, options?: { progress?: (p: { totalPages: number; remainingPages: number }) => number }): Promise<{ totalPages: number; remainingPages: number }>
  }

  export interface DatabaseOptions {
    readonly?: boolean
    fileMustExist?: boolean
    timeout?: number
    verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void
    nativeBinding?: string
  }

  export interface SqliteError extends Error {
    code: string
  }

  const Database: {
    new (filename: string, options?: DatabaseOptions): Database
    (filename: string, options?: DatabaseOptions): Database
  }

  export default Database
  export { Database as SqliteDatabase }
}

// ---------------------------------------------------------------------------
// onnxruntime-node（docs/06 §4.1）
// ---------------------------------------------------------------------------

declare module 'onnxruntime-node' {
  export type TensorType = 'float32' | 'float64' | 'int32' | 'int64' | 'uint8' | 'bool' | 'string'

  export class Tensor {
    constructor(type: TensorType, data: readonly number[] | BigInt64Array | Float32Array | Int32Array | Uint8Array | string[], dims: readonly number[])
    readonly type: TensorType
    readonly dims: readonly number[]
    readonly data: unknown
  }

  export interface SessionOptions {
    intraOpNumThreads?: number
    interOpNumThreads?: number
    executionProviders?: string[]
    graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all'
    enableCpuMemArena?: boolean
    enableMemPattern?: boolean
    logSeverityLevel?: 0 | 1 | 2 | 3 | 4
  }

  export interface InferenceSession {
    readonly inputNames: readonly string[]
    readonly outputNames: readonly string[]
    run(feeds: Record<string, Tensor>, options?: unknown): Promise<Record<string, Tensor>>
    release(): Promise<void>
  }

  export namespace InferenceSession {
    function create(path: string, options?: SessionOptions): Promise<InferenceSession>
  }

  export function getDefaultExecutionProvider(): string
  export const env: { wasm?: unknown; versions?: Record<string, string> }
}

// ---------------------------------------------------------------------------
// fluent-ffmpeg（docs/02 §2.1、docs/05 §6）
// ---------------------------------------------------------------------------

declare module 'fluent-ffmpeg' {
  export interface FfmpegCommand {
    input(source: string): this
    inputOptions(...options: string[]): this
    outputOptions(...options: string[]): this
    output(target: string): this
    audioCodec(codec: string): this
    audioBitrate(bitrate: string | number): this
    audioChannels(count: number): this
    audioFrequency(rate: number): this
    videoCodec(codec: string): this
    videoBitrate(bitrate: string | number): this
    size(size: string): this
    seekInput(time: string | number): this
    duration(time: string | number): this
    complexFilter(filters: unknown, map?: string | string[]): this
    audioFilters(filters: string | string[]): this
    format(fmt: string): this
    on(event: 'start', cb: (commandLine: string) => void): this
    on(event: 'progress', cb: (progress: { frames?: number; percent?: number; timemark?: string; currentKbps?: number; targetSize?: number; speed?: string }) => void): this
    on(event: 'stderr', cb: (line: string) => void): this
    on(event: 'error', cb: (err: Error, stdout?: string, stderr?: string) => void): this
    on(event: 'end', cb: (stdout?: string, stderr?: string) => void): this
    on(event: string, cb: (...args: never[]) => void): this
    kill(signal?: string): this
    run(): this
  }

  export interface FfmpegStatic {
    (input?: string | ReadableStream | string[]): FfmpegCommand
    setFfmpegPath(path: string): void
    setFfprobePath(path: string): void
    ffprobe(file: string, cb: (err: Error | null, metadata: FfprobeData) => void): void
    ffprobe(file: string): Promise<FfprobeData>
  }

  export interface FfprobeStream {
    index: number
    codec_name?: string
    codec_type?: string
    sample_rate?: string
    channels?: number
    channel_layout?: string
    duration?: string
    bit_rate?: string
    tags?: Record<string, string>
  }

  export interface FfprobeFormat {
    filename?: string
    format_name?: string
    duration?: string
    size?: string
    bit_rate?: string
    tags?: Record<string, string>
  }

  export interface FfprobeData {
    streams: FfprobeStream[]
    format: FfprobeFormat
    chapters?: Array<{ id: number; start_time: number; end_time: number; tags?: Record<string, string> }>
  }

  const ffmpeg: FfmpegStatic
  export default ffmpeg
}

// ---------------------------------------------------------------------------
// @xenova/transformers（仅取 tokenizer，docs/06 §4.2）
// ---------------------------------------------------------------------------

declare module '@xenova/transformers' {
  export interface Encoding {
    input_ids: { data: ArrayLike<number>; dims: number[]; size: number }
    attention_mask: { data: ArrayLike<number>; dims: number[]; size: number }
    token_type_ids?: { data: ArrayLike<number>; dims: number[]; size: number }
    [key: string]: unknown
  }

  export interface Tokenizer {
    (texts: string | string[], options?: Record<string, unknown>): Promise<Encoding>
    encode(text: string, options?: Record<string, unknown>): Promise<number[]>
    decode(ids: number[], options?: Record<string, unknown>): string
  }

  export const env: {
    localModelPath: string
    allowRemoteModels: boolean
    allowLocalModels: boolean
    useBrowserCache: boolean
    backends?: Record<string, unknown>
  }

  export const AutoTokenizer: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<Tokenizer>
  }
}

// ---------------------------------------------------------------------------
// 无类型或纯 JS 的小依赖
// ---------------------------------------------------------------------------

declare module 'chardet' {
  export function detect(buf: Uint8Array | Buffer): string
  export function detectFile(path: string): Promise<string>
}

declare module 'mammoth' {
  export interface MammothResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  export function convertToHtml(input: { buffer: Buffer } | { path: string }, options?: Record<string, unknown>): Promise<MammothResult>
  export function convertToMarkdown(input: { buffer: Buffer } | { path: string }, options?: Record<string, unknown>): Promise<MammothResult>
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<MammothResult>
}

declare module 'yauzl' {
  import type { Readable } from 'node:stream'
  export interface Entry {
    fileName: string
    uncompressedSize: number
    compressedSize: number
    openReadStream(): Readable
  }
  export interface ZipFile {
    readEntry(): void
    close(): void
    on(event: 'entry', cb: (entry: Entry) => void): this
    on(event: 'end', cb: () => void): this
    on(event: 'error', cb: (err: Error) => void): this
    on(event: string, cb: (...args: never[]) => void): this
  }
  export function open(path: string, options: { lazyEntries?: boolean; autoClose?: boolean; decodeStrings?: boolean; validateEntrySizes?: boolean }, cb: (err: Error | null, zip: ZipFile) => void): void
}

declare module 'archiver' {
  import type { Writable } from 'node:stream'
  export interface Archiver extends Writable {
    file(path: string, data: { name: string }): this
    directory(dir: string, dest: string | false): this
    append(source: Buffer | Readable, data: { name: string }): this
    finalize(): Promise<void>
    abort(): this
    on(event: 'progress', cb: (p: { entries: { total: number; processed: number }; fs: { totalBytes: number; processedBytes: number } }) => void): this
    on(event: 'warning', cb: (err: Error) => void): this
    on(event: 'error', cb: (err: Error) => void): this
    on(event: 'close', cb: () => void): this
  }
  export interface ArchiverOptions {
    zlib?: { level?: number }
    store?: boolean
    highWaterMark?: number
  }
  export function create(format: 'zip' | 'tar', options?: ArchiverOptions): Archiver
}
