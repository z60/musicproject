/**
 * Novel Studio · ASR 输出解析（纯逻辑）
 * ============================================================================
 * 「音频转文字」由外部引擎产出（whisper.cpp / openai-whisper CLI / 自定义脚本），
 * 三种常见形状都要认 —— 用户在设置里换引擎不该让整条链路失配。
 *
 * | 形状 | 来源 | 时间单位 |
 * |------|------|---------|
 * | `{ transcription: [{ offsets:{from,to}, text, tokens? }] }` | whisper.cpp `-oj` / `-ojf` | **毫秒** |
 * | `{ segments: [{ start, end, text }] }` | openai-whisper `--output_format json` | **秒** |
 * | `[{ startMs, endMs, text }]` | 自定义脚本（本项目约定） | 毫秒 |
 *
 * `-ojf`（full）会额外给出**每个 token 的起止**（比整段细一个量级，中文 token 通常 1~3 字）：
 * 「2221 章长句尾音丢失」的根因就是**整段的时间太粗**（一行文字横跨两段）。
 * token 时间戳让 `char-align.ts` 能直接把每个字钉到毫秒。拿不到 token 时退回按段对齐。
 *
 * 解析失败**不抛错**：返回空 segments + 原因，由调用方决定退回 VAD。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import type { AsrSegment } from './text-match.ts'

export type AsrOutputShape = 'whisper.cpp' | 'openai-whisper' | 'plain' | 'unknown'

/** 一个 token 的文本 + 起止（whisper.cpp `-ojf` 的 `tokens[]`，毫秒） */
export interface AsrToken {
  text: string
  startMs: number
  endMs: number
  /** token 概率 0~1（whisper 会给；拿不到时为 undefined） */
  probability?: number
}

export interface ParseAsrOutputResult {
  segments: AsrSegment[]
  /** token 级时间戳（越细越准）；引擎不给时为空数组，由调用方退回按段对齐 */
  tokens: AsrToken[]
  shape: AsrOutputShape
  warnings: string[]
}

/** 特殊标记 token（`[_BEG_]` / `[_TT_123]` 等）不参与文本比对 */
function isSpecialToken(text: string): boolean {
  return text.startsWith('[_') || text.startsWith('<|')
}

function numberOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 解析 ASR 输出；三种形状任一成功即可，都失败时 shape='unknown' + 空数组 */
export function parseAsrOutput(raw: string | null | undefined): ParseAsrOutputResult {
  const warnings: string[] = []
  const text = String(raw ?? '').trim()
  if (text.length === 0) return { segments: [], tokens: [], shape: 'unknown', warnings: ['ASR 输出为空'] }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { segments: [], tokens: [], shape: 'unknown', warnings: ['ASR 输出不是合法 JSON'] }
  }

  // ── 形状 1：whisper.cpp（offsets 毫秒；-ojf 还带 tokens[]）────────────────
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { transcription?: unknown[] }).transcription)) {
    const list = (parsed as { transcription: unknown[] }).transcription
    const segments: AsrSegment[] = []
    const tokens: AsrToken[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const row = item as { offsets?: { from?: unknown; to?: unknown }; text?: unknown; tokens?: unknown }
      const from = numberOf(row.offsets?.from)
      const to = numberOf(row.offsets?.to)
      const body = textOf(row.text).trim()
      if (from === null || to === null || body.length === 0) continue
      segments.push({ startMs: from, endMs: to, text: body })
      if (!Array.isArray(row.tokens)) continue
      for (const raw of row.tokens) {
        if (!raw || typeof raw !== 'object') continue
        const tk = raw as { text?: unknown; offsets?: { from?: unknown; to?: unknown }; p?: unknown }
        const tokenText = textOf(tk.text).trim()
        if (tokenText.length === 0 || isSpecialToken(tokenText)) continue
        const tkFrom = numberOf(tk.offsets?.from)
        const tkTo = numberOf(tk.offsets?.to)
        if (tkFrom === null || tkTo === null) continue
        const p = numberOf(tk.p)
        tokens.push({
          text: tokenText,
          startMs: tkFrom,
          endMs: Math.max(tkFrom, tkTo),
          ...(p !== null ? { probability: p } : {}),
        })
      }
    }
    return { segments, tokens, shape: 'whisper.cpp', warnings }
  }

  // ── 形状 2：openai-whisper（start/end 秒）────────────────────────────────
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { segments?: unknown[] }).segments)) {
    const list = (parsed as { segments: unknown[] }).segments
    const segments: AsrSegment[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const row = item as { start?: unknown; end?: unknown; text?: unknown }
      const start = numberOf(row.start)
      const end = numberOf(row.end)
      const body = textOf(row.text).trim()
      if (start === null || end === null || body.length === 0) continue
      segments.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text: body })
    }
    return { segments, tokens: [], shape: 'openai-whisper', warnings }
  }

  // ── 形状 3：自定义脚本（本项目约定：毫秒 + camelCase）────────────────────
  if (Array.isArray(parsed)) {
    const segments: AsrSegment[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as { startMs?: unknown; endMs?: unknown; start?: unknown; end?: unknown; text?: unknown }
      const start = numberOf(row.startMs) ?? numberOf(row.start)
      const end = numberOf(row.endMs) ?? numberOf(row.end)
      const body = textOf(row.text).trim()
      if (start === null || end === null || body.length === 0) continue
      segments.push({ startMs: Math.round(start), endMs: Math.round(end), text: body })
    }
    if (segments.length === 0) warnings.push('数组里没有任何 { startMs, endMs, text } 形状的段落')
    return { segments, tokens: [], shape: 'plain', warnings }
  }

  return {
    segments: [],
    tokens: [],
    shape: 'unknown',
    warnings: ['ASR 输出的形状不认识（既没有 transcription[]，也没有 segments[]，也不是数组）'],
  }
}
