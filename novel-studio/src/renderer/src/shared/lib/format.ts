/**
 * Novel Studio · 展示层格式化（纯函数，零依赖）
 * ============================================================================
 * 设计依据：
 *   · docs/01 §3.2 —— shared/lib 放「格式化、快捷键、波形工具、防抖」
 *   · docs/12 §10  —— 走带栏时长、电平表 dB
 *   · docs/13 §4.5 —— 时间线刻度、片段起止时间
 *   · docs/15 §9   —— 导出报告里的实测响度/峰值
 *
 * 三条纪律：
 *   1. 本文件**不依赖 vue / element-plus / node**，可被 `node --experimental-strip-types`
 *      直接跑单测（见 tests/renderer/format.test.ts）。
 *   2. 所有函数对 null / undefined / NaN / Infinity **不抛错**，统一回退为 UNKNOWN（`—`）。
 *      理由：UI 里大量字段是可空的（lufs/peakDb/measuredAt），让每个调用点写 `?? '-'`
 *      既啰嗦又容易出现五种不同的占位符。
 *   3. 单位一律显式带上（dB / LUFS / ms），避免「-16 到底是 LUFS 还是 dB」的歧义。
 */

// ---------------------------------------------------------------------------
// 占位符
// ---------------------------------------------------------------------------

/** 未知值统一占位符（全应用只允许这一个） */
export const UNKNOWN = '—'

/** 是否为「无值」：null / undefined / 空串 / 非有限数 */
export function isUnknown(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true
  if (typeof v === 'number') return !Number.isFinite(v)
  if (v instanceof Date) return Number.isNaN(v.getTime())
  return false
}

/** 可空文本：空值回退占位符 */
export function text(v: string | null | undefined, placeholder: string = UNKNOWN): string {
  return v === null || v === undefined || v === '' ? placeholder : v
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

// ---------------------------------------------------------------------------
// 时长
// ---------------------------------------------------------------------------

/**
 * 时长格式化。
 *   < 1 小时 → `MM:SS`（例：`00:31`）
 *   ≥ 1 小时 → `HH:MM:SS`（例：`01:02:03`；小时补零到 2 位便于列表对齐）
 *   showMs   → 追加一位小数（时间线/播放头显示用，例：`03:12.4`）
 *
 * 负数、NaN、Infinity → UNKNOWN（绝不让 `--:--` 之外的怪字符串漏到界面上）。
 */
export function formatDuration(
  ms: number | null | undefined,
  opts: { showMs?: boolean } = {},
): string {
  if (isUnknown(ms)) return UNKNOWN
  const value = ms as number
  if (value < 0) return UNKNOWN

  const totalSeconds = Math.floor(value / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const base = hours > 0
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`

  if (!opts.showMs) return base
  // 十分位：足够看播放头位置，又不会让数字抖动得太厉害
  const tenths = Math.floor((value % 1000) / 100)
  return `${base}.${tenths}`
}

/** 语义别名（时间线刻度与走带栏读起来更自然） */
export const formatTimecode = formatDuration

/**
 * 口语化时长：用于导入向导的「预估时长」与导出报告的汇总。
 *   < 1 分钟 → `31.2 秒`
 *   < 1 小时 → `12 分 30 秒`
 *   ≥ 1 小时 → `1 小时 2 分`
 */
export function formatDurationLong(ms: number | null | undefined): string {
  if (isUnknown(ms)) return UNKNOWN
  const value = ms as number
  if (value < 0) return UNKNOWN

  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`

  const totalSeconds = Math.floor(value / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分 ${seconds} 秒`
}

/** 秒 → `MM:SS`（VAD 切片边界等处上游给的是秒） */
export function formatSeconds(seconds: number | null | undefined): string {
  if (isUnknown(seconds)) return UNKNOWN
  return formatDuration((seconds as number) * 1000)
}

/** 毫秒差值带符号显示（对轨微调：`+120 ms` / `-10 ms`） */
export function formatOffsetMs(ms: number | null | undefined, digits = 0): string {
  if (isUnknown(ms)) return UNKNOWN
  const v = ms as number
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(digits)} ms`
}

// ---------------------------------------------------------------------------
// 字节 / 文件大小
// ---------------------------------------------------------------------------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * 字节格式化（1024 进制，与资源管理器口径一致）。
 *   1023 → `1023 B`；1536 → `1.5 KB`；0 → `0 B`
 */
export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (isUnknown(bytes)) return UNKNOWN
  let value = bytes as number
  if (value < 0) return UNKNOWN
  if (value < 1024) return `${Math.round(value)} B`

  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  // 1023.95 KB 之类四舍五入成 1024.0 很丑，这里回退一位单位
  const rounded = Number(value.toFixed(decimals))
  if (rounded >= 1024 && unit < BYTE_UNITS.length - 1) {
    return `${(rounded / 1024).toFixed(decimals)} ${BYTE_UNITS[unit + 1]}`
  }
  return `${rounded.toFixed(decimals)} ${BYTE_UNITS[unit]}`
}

/** 别名：导出报告与磁盘预检处更常叫「文件大小」 */
export const formatFileSize = formatBytes

/** 写入速率（导出进度「实时速率」）：`1.2 MB/s` */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (isUnknown(bytesPerSecond)) return UNKNOWN
  return `${formatBytes(bytesPerSecond as number)}/s`
}

// ---------------------------------------------------------------------------
// 电平 / 响度
// ---------------------------------------------------------------------------

/**
 * dB 格式化（峰值、RMS、增益、阈值、闪避量都用它）。
 *   2      → `+2.0 dB`
 *   -3     → `-3.0 dB`
 *   0      → `0.0 dB`
 *   -Inf   → `-∞ dB`（数字静音，必须与「没测」区分开）
 */
export function formatDb(db: number | null | undefined, digits = 1): string {
  if (db === null || db === undefined) return UNKNOWN
  if (db === Number.NEGATIVE_INFINITY) return '-∞ dB'
  if (!Number.isFinite(db)) return UNKNOWN
  const sign = db > 0 ? '+' : ''
  return `${sign}${db.toFixed(digits)} dB`
}

/** dBFS 语境下显式标注（导出报告里的真峰） */
export function formatDbfs(db: number | null | undefined, digits = 1): string {
  if (isUnknown(db) && db !== Number.NEGATIVE_INFINITY) return UNKNOWN
  if (db === Number.NEGATIVE_INFINITY) return '-∞ dBFS'
  return `${(db as number).toFixed(digits)} dBFS`
}

/**
 * 响度格式化（docs/15 §9 导出报告「实测响度」列）。
 *   -16.03 → `-16.0 LUFS`
 *   null   → `—`（未测量，绝不可显示成 -0.0 LUFS）
 */
export function formatLufs(lufs: number | null | undefined, digits = 1): string {
  if (isUnknown(lufs) || lufs === Number.NEGATIVE_INFINITY) return UNKNOWN
  return `${(lufs as number).toFixed(digits)} LUFS`
}

/** 响度偏差（目标 vs 实测）：`+1.2 LU`（LU 与 LUFS 是不同单位，不能混写） */
export function formatLu(delta: number | null | undefined, digits = 1): string {
  if (isUnknown(delta)) return UNKNOWN
  const v = delta as number
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)} LU`
}

/** LRA 动态范围 */
export function formatLra(lra: number | null | undefined, digits = 1): string {
  if (isUnknown(lra)) return UNKNOWN
  return `${(lra as number).toFixed(digits)} LU`
}

// ---------------------------------------------------------------------------
// 数值 / 百分比 / 字数
// ---------------------------------------------------------------------------

/** 千分位整数：1234567 → `1,234,567` */
export function formatInt(n: number | null | undefined): string {
  if (isUnknown(n)) return UNKNOWN
  return Math.round(n as number).toLocaleString('en-US')
}

/** 0~1 → 百分比：0.856 → `86%` */
export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (isUnknown(ratio)) return UNKNOWN
  return `${((ratio as number) * 100).toFixed(digits)}%`
}

/** 置信度（0~1 两位小数，画本列与候选分数都用它）：0.58 → `0.58` */
export function formatScore(score: number | null | undefined, digits = 2): string {
  if (isUnknown(score)) return UNKNOWN
  return (score as number).toFixed(digits)
}

/** 角色/章节字数：12345 → `1.2 万字`（书架卡片、章节列表） */
export function formatCount(n: number | null | undefined): string {
  if (isUnknown(n)) return UNKNOWN
  const v = n as number
  if (Math.abs(v) < 10_000) return formatInt(v)
  if (Math.abs(v) < 100_000_000) return `${(v / 10_000).toFixed(1)} 万`
  return `${(v / 100_000_000).toFixed(2)} 亿`
}

/** 语速（字/秒）：4.2 → `4.2 字/秒` */
export function formatSpeed(charsPerSecond: number | null | undefined): string {
  if (isUnknown(charsPerSecond)) return UNKNOWN
  return `${(charsPerSecond as number).toFixed(1)} 字/秒`
}

/** 采样率：48000 → `48 kHz` */
export function formatSampleRate(hz: number | null | undefined): string {
  if (isUnknown(hz)) return UNKNOWN
  const v = hz as number
  return v % 1000 === 0 ? `${v / 1000} kHz` : `${(v / 1000).toFixed(1)} kHz`
}

/** 音频格式摘要：`48 kHz / 24 bit / 单声道` */
export function formatAudioFormat(
  format: { sampleRate?: number | null; bitDepth?: number | null; channels?: number | null } | null | undefined,
): string {
  if (!format) return UNKNOWN
  const bits = isUnknown(format.bitDepth)
    ? UNKNOWN
    : (format.bitDepth === 32 ? '32f' : String(format.bitDepth))
  const channels = isUnknown(format.channels)
    ? UNKNOWN
    : (format.channels === 1 ? '单声道' : '立体声')
  return [
    isUnknown(format.sampleRate) ? UNKNOWN : formatSampleRate(format.sampleRate),
    `${bits} bit`,
    channels,
  ].join(' / ')
}

// ---------------------------------------------------------------------------
// 日期与时间
// ---------------------------------------------------------------------------

/**
 * 日期格式化（只支持这几个 token，避免引入 dayjs 的完整语义）：
 *   YYYY 年 / MM 月 / DD 日 / HH 时 / mm 分 / ss 秒
 * 不可解析的时间戳 → UNKNOWN。
 */
export function formatDate(
  ts: number | Date | null | undefined,
  pattern = 'YYYY-MM-DD HH:mm',
): string {
  if (isUnknown(ts)) return UNKNOWN
  const date = ts instanceof Date ? ts : new Date(ts as number)
  if (Number.isNaN(date.getTime())) return UNKNOWN

  return pattern
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, pad2(date.getMonth() + 1))
    .replace(/DD/g, pad2(date.getDate()))
    .replace(/HH/g, pad2(date.getHours()))
    .replace(/mm/g, pad2(date.getMinutes()))
    .replace(/ss/g, pad2(date.getSeconds()))
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 更早则显示日期 */
export function formatRelativeTime(
  ts: number | null | undefined,
  now: number = Date.now(),
): string {
  if (isUnknown(ts)) return UNKNOWN
  const diff = now - (ts as number)
  if (diff < 0) return formatDate(ts, 'YYYY-MM-DD HH:mm') // 时钟回拨，不做「未来」文案
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatDate(ts, 'YYYY-MM-DD')
}

/** 耗时（任务诊断用）：从开始到现在的秒数，`1.2 s` */
export function formatElapsed(startedAt: number | null | undefined, now: number = Date.now()): string {
  if (isUnknown(startedAt)) return UNKNOWN
  const ms = Math.max(0, now - (startedAt as number))
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return formatDuration(ms)
}

// ---------------------------------------------------------------------------
// 复合展示
// ---------------------------------------------------------------------------

/** 摘要行：`12 章 · 8.4 万字 · 约 3 小时 20 分`（书架/书籍详情） */
export function formatBookSummary(input: {
  chapters?: number | null
  chars?: number | null
  durationMs?: number | null
}): string {
  const parts: string[] = []
  if (!isUnknown(input.chapters)) parts.push(`${formatInt(input.chapters)} 章`)
  if (!isUnknown(input.chars)) parts.push(`${formatCount(input.chars)}字`)
  if (!isUnknown(input.durationMs)) parts.push(`约 ${formatDurationLong(input.durationMs)}`)
  return parts.length ? parts.join(' · ') : UNKNOWN
}

/** 完成度：`34/120（28%）` */
export function formatProgressRatio(done: number | null | undefined, total: number | null | undefined): string {
  if (isUnknown(done) || isUnknown(total)) return UNKNOWN
  const t = total as number
  if (t <= 0) return `${formatInt(done)}/${formatInt(total)}`
  return `${formatInt(done)}/${formatInt(total)}（${formatPercent((done as number) / t, 0)}）`
}
