/**
 * Novel Studio · 「按说话人导入音频」真实样本验证（可重复运行）
 * ============================================================================
 * 设计依据：docs/91 §5.2.49
 *
 * ## 这个脚本回答什么问题
 *
 * 单元测试用的是**裁小的 fixture**（几章、几行），而真实样本是
 * **100 章 / 4112 行 / 237 命中行**。算法在 3 行上正确、在 90 行上崩掉
 * 是这类分配算法最常见的失败方式（docs/91 §5.2.49 ⑫ 的两个 bug 就是这样暴露的）。
 * 所以必须有一个**拿真样本跑真规模**的入口。
 *
 * ## 它跑的是真的什么、假的什么（必须说清，否则数字没有意义）
 *
 * | 环节 | 真假 |
 * |------|------|
 * | 画本 `.docx` 解析 | **真的**（真 mammoth 抽真文件） |
 * | 文件名解析 / 角色与 CV 解析 / 选行 | **真的**（共用 `shared/audio-import/**`） |
 * | 章节对齐（章节号 vs seq） | **真的** |
 * | VAD 切句 + 铺满每一行 | **真的**（`planLineSplits`） |
 * | **音频本身** | **合成的**（440 Hz 正弦 + 静音，按命中行数造 N 段） |
 *
 * 为什么音频必须是合成的：样本 5 个文件**全是 mp3**，而解码需要 ffmpeg，
 * 本机 `capabilities.ffmpeg.available === false`。
 * 合成音频能验证**分配算法在真实行数下的行为**，但**不能**验证
 * 「VAD 在真人朗读上的切分准确度」—— 后者要等 ffmpeg 就位后才能测。
 * **不要把本脚本的输出当成「真实音频已验证」。**
 *
 * ## 运行
 *
 * ```
 * npm run verify:import-sample
 * # 或指定目录
 * node --experimental-strip-types scripts/verify-audio-import-sample.ts "D:\\其他样本"
 * ```
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildImportPlan, parseAudioFileName, type SpeakerTarget } from '../src/shared/audio-import/index.ts'
import type { ParsedCanvas } from '../src/shared/canvas/index.ts'
import { parseCanvasText } from '../src/shared/canvas/index.ts'
import { allocateLinesToSlices, type SpeechSlice } from '../src/shared/audio/allocate.ts'
import { buildDecodeToWavCommand } from '../src/shared/ffmpeg/commands.ts'
import { int16LEToFloat32, mixdownToMono } from '../src/shared/audio/pcm.ts'
import { planLineSplits } from '../src/shared/audio/split.ts'
import { parseWavHeader } from '../src/shared/audio/wav.ts'

/** 默认样本目录（与 docs/91 §5.2.49 的勘察对象一致） */
const DEFAULT_SAMPLE_DIR = 'C:\\projectText\\cloudproject\\musicproject\\样本'

/** 合成音频的采样率（与项目内录音链路一致） */
const RATE = 48_000
/** 每行前后的静音（毫秒）——让 VAD 能切出 N 片，从而走 `vad` 路径 */
const GAP_MS = 420
/** 中文朗读语速（字/秒）——与 `VAD_DEFAULTS.charsPerSecond` 一致 */
const CHARS_PER_SECOND = 4.2

/**
 * ## 真实音频模式（给了 ffmpeg 才启用）
 *
 * 样本 5 个文件全是 mp3，解码必须靠 ffmpeg。本机 ffmpeg **不在 PATH 上**，
 * 所以这里允许通过参数或环境变量显式指定：
 *
 * ```
 * node --experimental-strip-types scripts/verify-audio-import-sample.ts "" "C:\\path\\to\\ffmpeg.exe"
 * NS_FFMPEG="C:\\path\\to\\ffmpeg.exe" npm run verify:import-sample
 * ```
 *
 * ### 为什么值得专门做这一条
 *   合成音频能验证**分配算法**，但**验证不了 VAD 在真人朗读上的行为** ——
 *   真人朗读有气声、连读、呼吸、口水音，切出来的片数与行数几乎不可能恰好相等。
 *   那才是「按 VAD 切句」真正的难度所在。
 *
 * ⚠️ 用外部 ffmpeg 只做**验证**：脚本不会把它写进任何配置或代码。
 *   应用里用的是「设置 → 音频」里用户自己指定的路径（`capabilities.ffmpeg.path`）。
 */
const FFMPEG_PATH = process.env.NS_FFMPEG ?? ''

/** 用 ffmpeg 把真实 mp3 解成 48 kHz / 单声道 / 16 位 WAV（与导入链路同一条命令） */
function transcodeWithFfmpeg(ffmpegPath: string, input: string, output: string): void {
  const argv = buildDecodeToWavCommand({ input, output, ffmpegPath })
  execFileSync(argv[0]!, argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60 * 1000 })
}

/** 读一个 16 位 WAV 并下混成单声道 Float32（与 `readAudioFile` 同口径） */
async function readWavMono(path: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const buf = await readFile(path)
  const parsed = parseWavHeader(buf)
  const end = Math.min(buf.length, parsed.dataOffset + parsed.dataBytes)
  const payload = Buffer.from(buf.subarray(parsed.dataOffset, Math.max(parsed.dataOffset, end)))
  const interleaved = int16LEToFloat32(payload)
  const samples = parsed.format.channels > 1 ? mixdownToMono(interleaved, parsed.format.channels) : interleaved
  return { samples, sampleRate: parsed.format.sampleRate }
}

interface FileReport {
  fileName: string
  parsed: boolean
  status: string
  target: string
  lineCount: number
  chunkCount: number
  method: string
  sliceCount: number
  needsReview: number
  durationMs: number
  /** 四条不变量全部成立的检查结果 */
  ordered: boolean
  gapless: boolean
  noOverlap: boolean
  coversEnd: boolean
  positive: boolean
  firstStartMs: number
  lastEndMs: number
}

/**
 * 造一段 PCM：每行一个语音片，**每片的时长按该行文本长度算**。
 *
 * 为什么必须按文本长度而不是给每行同样的时长：
 * `allocateLinesToSlices` 的分配依据就是「文本长度权重」。如果合成的音频
 * 每行一样长、而文本长短不一，两者的边界必然对不上，于是几乎每一行
 * 都会被判成低置信度 —— 那**不是算法的问题，是我造的假数据自相矛盾**。
 * 按文本长度造，才是「朗读得比较规矩」的合理模型，输出的 `needsReview`
 * 数字也才有参考价值。
 */
function synth(msPerChunk: readonly number[]): Float32Array {
  const chunks = msPerChunk.map((ms) => Math.max(1, Math.round((ms / 1000) * RATE)))
  const gap = Math.round((GAP_MS / 1000) * RATE)
  const total = chunks.reduce((s, n) => s + n + gap, gap)
  const out = new Float32Array(total)
  let cursor = gap // 开头留一段静音：真实录音常有板声/空白
  for (const n of chunks) {
    for (let j = 0; j < n; j++) out[cursor + j] = 0.5 * Math.sin((2 * Math.PI * 440 * (cursor + j)) / RATE)
    cursor += n + gap
  }
  return out
}

/** 按中文语速把台词长度换算成朗读时长（毫秒），并夹到一个合理区间 */
function readMsOf(text: string): number {
  const chars = [...String(text ?? '')].length
  return Math.min(8000, Math.max(250, Math.round((chars / CHARS_PER_SECOND) * 1000)))
}

/**
 * 一段区间与所有语音片的重叠时长总和。
 *
 * 用来回答「这一行到底有没有拿到语音」—— 这是比「区间长度 > 0」强得多的判据：
 * 一行完全落在两片之间的静音里，区间长度照样是正的，但用户听到的是**一段空白**。
 */
function speechOverlap(slices: readonly SpeechSlice[], startMs: number, endMs: number): number {
  return slices.reduce((sum, s) => sum + Math.max(0, Math.min(endMs, s.endMs) - Math.max(startMs, s.startMs)), 0)
}

/** 说话人目标 → 一行可读说明（`SpeakerTarget` 是联合类型，逐种列举） */
function describeTarget(t: SpeakerTarget): string {
  switch (t.kind) {
    case 'narration':
      return '旁白行'
    case 'character':
      return `角色「${t.character}」`
    case 'cv-single-role':
      return `角色「${t.character}」（由 CV 推断）`
    case 'multiRole':
      return `多角色（CV「${t.cvName}」名下全部角色）`
    default:
      return '未判定（需人工指定）'
  }
}

async function readDocxText(filePath: string): Promise<string> {
  /**
   * 与 `ports.ts` 完全相同的读法（动态 import + `extractRawText`）——
   * 换成别的读法就测不到真机那条路径了。
   */
  const mammoth = (await import(/* @vite-ignore */ 'mammoth')) as unknown as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>
  }
  const r = await mammoth.extractRawText({ buffer: await readFile(filePath) })
  return r.value
}

/**
 * 把画本解析结果落成「数据库行」的形状。
 *
 * 真机上这一步由画本编辑域完成；脚本里必须**独立实现**它，
 * 否则「解析器与落库口径一致」这件事就成了自我印证。
 * 这里刻意只做最小映射：行 id / 章节号 / 说话人类型 / 文本。
 */
/**
 * 画本解析结果 → 章节号与角色名的规模统计。
 *
 * 这个脚本走的是**纯逻辑层**的 `buildImportPlan`（入参就是解析结果），
 * 所以不需要「假数据库行」；这个函数只负责把规模报出来 ——
 * 真实样本的「100 章 / 4112 行 / 95 角色」是判断「画本解析有没有坏」的第一手信号。
 */
function canvasIndex(canvas: ParsedCanvas): {
  chapters: number
  lines: number
  characters: number
  chapterRange: { from: number; to: number } | null
} {
  const nos = [...canvas.chapters].sort((a, b) => a - b)
  return {
    chapters: nos.length,
    lines: canvas.lines.length,
    characters: canvas.roster.length,
    chapterRange: nos.length > 0 ? { from: nos[0]!, to: nos[nos.length - 1]! } : null,
  }
}

async function main(): Promise<void> {
  const sampleDir = process.argv[2] ?? DEFAULT_SAMPLE_DIR
  let names: string[]
  try {
    names = await readdir(sampleDir)
  } catch (e) {
    console.error(`[verify] 读不到样本目录：${sampleDir}`)
    console.error(`         ${e instanceof Error ? e.message : String(e)}`)
    console.error('         传一个存在的目录作为第一个参数，或忽略参数用默认路径。')
    process.exitCode = 1
    return
  }

  const docx = names.filter((n) => n.toLowerCase().endsWith('.docx'))
  const mp3 = names.filter((n) => n.toLowerCase().endsWith('.mp3')).sort()
  if (docx.length === 0 || mp3.length === 0) {
    console.error(`[verify] 样本目录里没有 .docx/.mp3：${sampleDir}`)
    process.exitCode = 1
    return
  }

  /**
   * 用**文件名区间最大**的那份画本。
   *
   * 5 个样本的区间是 2127~2300，而 `重生：崛起香江` 那份是 2201~2300 ——
   * 只有它覆盖了全部样本。选错画本会让报告看起来「命中行数少得可怜」，
   * 而那是选错文件，不是实现问题。
   */
  const canvasFile = docx.find((n) => n.includes('2201')) ?? docx[0]!
  const canvasPath = join(sampleDir, canvasFile)

  console.log('─'.repeat(78))
  console.log('[verify] 按说话人导入音频 · 真实样本验证')
  console.log(`[verify] 样本目录：${sampleDir}`)
  console.log(`[verify] 画本：${canvasFile}`)
  console.log('─'.repeat(78))

  const t0 = Date.now()
  const canvasText = await readDocxText(canvasPath)
  const canvas = parseCanvasText(canvasText)
  const parseMs = Date.now() - t0
  if (canvas.warnings.length > 0) {
    console.log(`[verify] 画本警告 ${canvas.warnings.length} 条：`)
    for (const w of canvas.warnings.slice(0, 5)) {
      // `CanvasParseWarning` 是对象，直接插值会打出 `[object Object]`
      console.log(`         · 源行 ${w.sourceLine} ${w.reason}：「${w.detail}」`)
    }
  }

  // 文件名 → 解析结果（先把「命名不合规」的文件挑出来，不混进计划里）
  const resolved = mp3.map((n) => ({ name: n, parsed: parseAudioFileName(n) }))
  for (const r of resolved) {
    if (!r.parsed.ok) console.log(`[verify] ⚠ 文件名无法解析：${r.name}（${r.parsed.detail}）`)
  }

  const plan = buildImportPlan(
    resolved
      .filter((r) => r.parsed.ok)
      .map((r) => ({
        filePath: join(sampleDir, r.name),
        fileName: r.name,
        parsed: r.parsed.ok ? r.parsed.value : null,
      })),
    canvas,
  )

  console.log('─'.repeat(78))
  const idx = canvasIndex(canvas)
  console.log(
    `[verify] 画本规模：${idx.chapters} 章 / ${idx.lines} 行正文 / ${idx.characters} 条角色表` +
      (idx.chapterRange ? ` / 章节号 ${idx.chapterRange.from}~${idx.chapterRange.to}` : '') +
      ` / 解析 ${parseMs}ms`,
  )
  console.log(
    `[verify] 计划：${plan.summary.totalFiles} 文件 / 命中合计 ${plan.summary.totalLines} 行 / ` +
      `ready ${plan.summary.readyFiles} / needs-review ${plan.summary.needsReviewFiles} / ` +
      `no-lines ${plan.summary.noLinesFiles}`,
  )

  // ── 逐文件跑「真实规模的切句」 ────────────────────────────────────────────
  const reports: FileReport[] = []
  const reviewReasons: Array<{ fileName: string; reasons: Map<string, number> }> = []
  for (const f of plan.files) {
    if (f.lineCount === 0) {
      reports.push({
        fileName: f.fileName,
        parsed: true,
        status: f.status,
        target: f.target ? describeTarget(f.target) : '—',
        lineCount: 0,
        chunkCount: 0,
        method: '—',
        sliceCount: 0,
        needsReview: 0,
        durationMs: 0,
        ordered: true,
        gapless: true,
        noOverlap: true,
        coversEnd: true,
        positive: true,
        firstStartMs: 0,
        lastEndMs: 0,
      })
      continue
    }

    /**
     * 按命中行数造同规模的音频（每片时长按该行文本长度算），然后跑**真的**切句。
     *
     * `lineCount` 行 → 造 `lineCount` 段语音，这样 VAD 若能切出
     * `lineCount` 片就是「一片一行」的理想情形 —— 用来验证算法在真实规模下的
     * 四条不变量，而不是验证切分准确度（那是音频质量决定的）。
     */
    const lineTexts = Array.from({ length: f.lineCount }, (_, i) => {
      // 样例只有有限条，循环取用；不足时退化成一个固定长度，不影响规模
      return f.samples[i % Math.max(1, f.samples.length)]?.text ?? '测试台词'
    })
    const samples = synth(lineTexts.map(readMsOf))
    const lines = lineTexts.map((text, i) => ({ lineId: `${f.fileName}#${i + 1}`, text }))
    const r = planLineSplits({ samples, sampleRate: RATE, lines })

    const positive = r.ranges.length === f.lineCount && r.ranges.every((x) => x.endMs > x.startMs)
    let ordered = true
    let gapless = true
    let noOverlap = true
    for (let i = 1; i < r.ranges.length; i++) {
      const prev = r.ranges[i - 1]!
      const cur = r.ranges[i]!
      if (cur.startMs < prev.startMs) ordered = false
      if (cur.startMs !== prev.endMs) gapless = false
      if (cur.startMs < prev.endMs) noOverlap = false
    }
    const lastSliceEnd = r.slices.length > 0 ? r.slices[r.slices.length - 1]!.endMs : 0
    const coversEnd = r.ranges.length > 0 && r.ranges[r.ranges.length - 1]!.endMs >= lastSliceEnd

    /**
     * 低置信度行的**原因分布**。
     *
     * 只报「有 19 行需复核」是不够的 —— 得知道它们为什么被判低。
     * `allocate.ts` 只在**吸附失败**时给低置信度（成功时恒 ≥ 0.7），
     * 所以原因的措辞直接指出是哪一类失败。
     */
    const reasons = new Map<string, number>()
    for (const range of r.ranges) {
      if (range.confidence >= 0.5) continue
      for (const reason of range.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
    reviewReasons.push({ fileName: f.fileName, reasons })

    reports.push({
      fileName: f.fileName,
      parsed: true,
      status: f.status,
      target: f.target ? describeTarget(f.target) : '—',
      lineCount: f.lineCount,
      chunkCount: f.lineCount,
      method: r.method,
      sliceCount: r.stats.sliceCount,
      needsReview: r.needsReview.length,
      durationMs: r.stats.durationMs,
      ordered,
      gapless,
      noOverlap,
      coversEnd,
      positive,
      firstStartMs: r.ranges[0]?.startMs ?? 0,
      lastEndMs: r.ranges[r.ranges.length - 1]?.endMs ?? 0,
    })
  }

  /**
   * ── 真实音频：用 ffmpeg 解真 mp3 → 真 PCM → 真 VAD ────────────────────────
   *
   * 这是整个脚本里**唯一能验证「VAD 在真人朗读上切得怎么样」**的一段。
   * 没给 ffmpeg 时跳过，并在结论里明确写「未跑」—— 不能让它看起来像跑过了。
   */
  interface RealReport {
    fileName: string
    lines: number
    slices: number
    needsReview: number
    silent: number
    durationMs: number
    oneToOne: boolean
    avgConfidence: number
    method: string
    ok: boolean
  }
  const real: RealReport[] = []
  const realErrors: string[] = []
  let tempDir: string | null = null

  if (FFMPEG_PATH) {
    tempDir = mkdtempSync(join(tmpdir(), 'ns-real-audio-'))
    for (const f of plan.files) {
      if (f.lineCount === 0) continue
      const out = join(tempDir, `${f.fileName.replace(/[^\w.-]/g, '_')}.wav`)
      try {
        transcodeWithFfmpeg(FFMPEG_PATH, join(sampleDir, f.fileName), out)
      } catch (e) {
        realErrors.push(`${f.fileName} 转码失败：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
        continue
      }
      const decoded = await readWavMono(out)
      const lineTexts = Array.from(
        { length: f.lineCount },
        (_, i) => f.samples[i % Math.max(1, f.samples.length)]?.text ?? '测试台词',
      )
      const r = planLineSplits({
        samples: decoded.samples,
        sampleRate: decoded.sampleRate,
        lines: lineTexts.map((text, i) => ({ lineId: `${f.fileName}#${i + 1}`, text })),
      })

      const silentIds = r.ranges
        .filter((range) => speechOverlap(r.slices, range.startMs, range.endMs) <= 0)
        .map((range) => range.lineId)
      const allFlagged = silentIds.every(
        (id) =>
          r.ranges.find((x) => x.lineId === id)?.reasons.some((reason) => /静音/.test(reason)) === true &&
          r.needsReview.includes(id),
      )
      const invariantsOk =
        r.ranges.length === lineTexts.length &&
        r.ranges.every((x, i) => x.endMs > x.startMs && (i === 0 || x.startMs === r.ranges[i - 1]!.endMs)) &&
        (r.ranges.length === 0 || r.ranges[r.ranges.length - 1]!.endMs >= (r.slices[r.slices.length - 1]?.endMs ?? 0))

      real.push({
        fileName: f.fileName,
        lines: lineTexts.length,
        slices: r.stats.sliceCount,
        needsReview: r.needsReview.length,
        silent: silentIds.length,
        durationMs: r.stats.durationMs,
        oneToOne: r.stats.oneToOne,
        avgConfidence: r.stats.avgConfidence,
        method: r.method,
        ok: invariantsOk && allFlagged,
      })
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  }

  if (FFMPEG_PATH) {
    console.log('─'.repeat(78))
    console.log('真实音频（真 mp3 → ffmpeg 解码 → 真 PCM → 真 VAD）')
    console.log('  文件'.padEnd(36) + '行数'.padStart(6) + '片数'.padStart(6) + '一片一行'.padStart(10) + '复核'.padStart(6) + '零语音'.padStart(8) + '  时长')
    for (const x of real) {
      console.log(
        `  ${x.fileName}`.padEnd(36) +
          String(x.lines).padStart(6) +
          String(x.slices).padStart(6) +
          (x.oneToOne ? '是' : '否').padStart(10) +
          String(x.needsReview).padStart(6) +
          String(x.silent).padStart(8) +
          `  ${(x.durationMs / 1000).toFixed(1)}s`,
      )
    }
    for (const e of realErrors) console.log(`  ✗ ${e}`)
    console.log('  注：「片数 ≠ 行数」在真人朗读上是**常态**（连读/气声/呼吸都会影响）——')
    console.log('      这正是下一步要接 ASR 文本比对的原因（`text-match.ts` 已有，未接线）。')
  }

  /**
   * ── 鲁棒性：**故意少给语音片**（模拟 VAD 漏检）────────────────────────────
   *
   * 真实录音里 VAD 漏检是常态（连读、气声、环境噪声都会让两句话并成一片）。
   * 这时片数 < 行数，会走通用路径（按语音时长比例硬切）——
   * 而那条路径上曾经有个**会让某些行完全拿不到语音**的缺陷：
   * 目标位置按「整条时间轴（含静音）」的比例算，短行的容差容不下一个间隙，
   * 于是相邻行把边界抢走，隔一行就剩下一段**纯静音**。
   *
   * 这里拿真实行数（最大的那个文件）跑三种漏检率，断言：
   * 每一行都覆盖到语音、四条不变量成立、没有反向/零长区间。
   */
  const robustness: Array<{ dropRate: string; fileName: string; lines: number; slices: number; silent: number; ok: boolean }> = []
  const biggest = plan.files.filter((f) => f.lineCount > 0).sort((a, b) => b.lineCount - a.lineCount)[0]
  if (biggest) {
    const lineTexts = Array.from({ length: biggest.lineCount }, (_, i) => {
      return biggest.samples[i % Math.max(1, biggest.samples.length)]?.text ?? '测试台词'
    })
    const full = synth(lineTexts.map(readMsOf))
    const fullPlan = planLineSplits({
      samples: full,
      sampleRate: RATE,
      lines: lineTexts.map((text, i) => ({ lineId: `r${i + 1}`, text })),
    })
    for (const rate of [0, 0.2, 0.34]) {
      /**
       * 按比例丢掉一部分语音片（保留首尾，模拟中间连读把两句话并成一片）。
       *
       * ⚠️ 第一版写成 `i % Math.round(1 / (rate || 1)) !== 0`，本意是
       *   「rate=0 时全都保留」，实际 `1/(0||1) = 1` ⇒ `i % 1` 恒为 0
       *   ⇒ 只留下首尾两片。于是报告显示「93 行只有 2 片」，看着像算法崩了，
       *   其实是**我的脚本算错了**。这类「探针自己的错误看起来像产品缺陷」
       *   在 docs/91 §5.2.49 ⑨ 已经记过一次，这里又犯了一遍 —— 所以单独写清。
       */
      const step = rate > 0 ? Math.max(2, Math.round(1 / rate)) : 0
      const kept =
        rate === 0
          ? fullPlan.slices
          : fullPlan.slices.filter(
              (_s, i) => i === 0 || i === fullPlan.slices.length - 1 || i % step !== 0,
            )
      const r = allocateLinesToSlices(
        kept,
        lineTexts.map((text, i) => ({ lineId: `r${i + 1}`, text })),
      )
      const silentIds = r.ranges
        .filter((range) => speechOverlap(kept, range.startMs, range.endMs) <= 0)
        .map((range) => range.lineId)
      /**
       * 每一个零语音行都**必须**被标注原因并进复核清单。
       *
       * 这才是这条鲁棒性检查真正在断言的东西：零语音行本身是纯时长分配的
       * **能力边界**（漏检区域在分配器眼里就是静音），但它**绝不能静默**——
       * 否则表现为「某几行导入了却没声音」而界面一切正常。
       */
      const allFlagged = silentIds.every(
        (id) =>
          r.ranges.find((x) => x.lineId === id)?.reasons.some((reason) => /静音/.test(reason)) === true &&
          r.needsReview.includes(id),
      )
      const ok =
        r.ranges.length === lineTexts.length &&
        r.ranges.every((x, i) => x.endMs > x.startMs && (i === 0 || x.startMs === r.ranges[i - 1]!.endMs)) &&
        allFlagged
      robustness.push({
        dropRate: rate === 0 ? '0%（片数=行数）' : `丢 ${Math.round(rate * 100)}%`,
        fileName: biggest.fileName,
        lines: lineTexts.length,
        slices: kept.length,
        silent: silentIds.length,
        ok,
      })
    }
  }

  if (robustness.length > 0) {
    console.log('─'.repeat(78))
    console.log(`鲁棒性：故意少给语音片（模拟 VAD 漏检）· ${robustness[0]!.fileName}`)
    console.log('  漏检      行数    片数   零语音行   已标注+进复核')
    for (const x of robustness) {
      console.log(
        `  ${x.dropRate}`.padEnd(12) +
          String(x.lines).padStart(6) +
          String(x.slices).padStart(8) +
          String(x.silent).padStart(11) +
          `   ${x.ok ? '✓' : '✗'}`,
      )
    }
    console.log('  注：零语音行是**纯时长分配的能力边界**（漏检区在分配器眼里就是静音），')
    console.log('      脚本断言的是「它们必须被标注原因并进复核清单」，而不是「必须为 0」。')
  }

  console.log('─'.repeat(78))
  console.log('逐文件：')
  console.log(
    '  文件'.padEnd(36) +
      '命中'.padStart(6) +
      '片数'.padStart(6) +
      '方法'.padStart(16) +
      '复核'.padStart(6) +
      '  不变量',
  )
  for (const r of reports) {
    const inv = r.positive && r.ordered && r.gapless && r.noOverlap && r.coversEnd ? '✓ 四条' : '✗ 有破'
    console.log(
      `  ${r.fileName}`.padEnd(36) +
        String(r.lineCount).padStart(6) +
        String(r.sliceCount).padStart(6) +
        r.method.padStart(16) +
        String(r.needsReview).padStart(6) +
        `  ${inv}`,
    )
  }

  const totalLines = reports.reduce((s, r) => s + r.lineCount, 0)
  const bad = reports.filter((r) => !(r.positive && r.ordered && r.gapless && r.noOverlap && r.coversEnd))
  const covered = reports.filter((r) => r.lineCount > 0)

  const totalReview = covered.reduce((s, r) => s + r.needsReview, 0)
  if (totalReview > 0) {
    console.log('─'.repeat(78))
    console.log(`复核原因分布（共 ${totalReview} 行被判低置信度）：`)
    for (const item of reviewReasons) {
      if (item.reasons.size === 0) continue
      console.log(`  ${item.fileName}`)
      for (const [reason, n] of item.reasons) console.log(`      ${n} 行 · ${reason}`)
    }
  }

  console.log('─'.repeat(78))
  console.log(`[verify] 命中行合计：${totalLines}`)
  console.log(`[verify] 参与切句的文件：${covered.length}（其余没有命中行）`)
  console.log(`[verify] 四条不变量（顺序/无缝/不重叠/覆盖末尾 + 正长度）全部成立的文件：${covered.length - bad.length}/${covered.length}`)

  // ── 判定 ─────────────────────────────────────────────────────────────────
  const failures: string[] = []
  if (totalLines === 0) failures.push('一个行都没命中 —— 章节对齐或 CV 解析很可能坏了')
  if (bad.length > 0) failures.push(`不变量被破坏：${bad.map((b) => b.fileName).join(', ')}`)
  for (const r of covered) {
    if (r.method !== 'vad') failures.push(`${r.fileName} 没走 VAD 路径（method=${r.method}）`)
    if (r.chunkCount !== r.lineCount) failures.push(`${r.fileName} 行数与音频段数不一致`)
  }
  for (const x of robustness) {
    if (!x.ok) failures.push(`鲁棒性（${x.dropRate}，${x.lines} 行/${x.slices} 片）不变量或标注失败`)
  }
  if (FFMPEG_PATH) {
    if (real.length === 0) failures.push('给了 ffmpeg 但一个真实音频都没处理成功')
    for (const x of real) {
      if (!x.ok) failures.push(`真实音频 ${x.fileName} 的不变量或零语音标注失败`)
    }
    for (const e of realErrors) failures.push(e)
  }

  console.log()
  console.log('─'.repeat(78))
  if (failures.length === 0) {
    console.log('[verify] 全部通过 ✓')
  } else {
    console.log('[verify] 有问题：')
    for (const f of failures) console.log(`         ✗ ${f}`)
    process.exitCode = 1
  }
  console.log()
  if (FFMPEG_PATH) {
    console.log('✔ 已跑**真实音频**模式（真 mp3 → ffmpeg 解码 → 真 PCM → 真 VAD）。')
    console.log('  注意「片数 ≠ 行数」是真人朗读的常态，所以逐行区间必然包含')
    console.log('  「按语音时长比例硬切」的部分 —— 要更准必须接 ASR 文本比对。')
  } else {
    console.log('⚠ 未跑真实音频模式：**音频是合成的**（每行一段正弦 + 静音）。')
    console.log('  它验证了分配算法在真实行数下的行为，但**不能**验证')
    console.log('  「VAD 在真人朗读上切得怎么样」。想跑真实音频需要 ffmpeg：')
    console.log('    NS_FFMPEG="C:\\path\\to\\ffmpeg.exe" npm run verify:import-sample')
    console.log('  （样本 5 个文件全是 mp3，解码必须靠 ffmpeg。）')
  }
}

await main()
