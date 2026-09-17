/**
 * 渲染进程纯逻辑测试 · 展示层格式化
 * ============================================================================
 * 覆盖 docs/12 §10（时长、电平）、docs/13 §4.5（时间码）、docs/15 §9（实测响度）：
 *   · 时长（含超过 1 小时 / 带十分位）
 *   · 字节与文件大小
 *   · dB / LUFS（含 -∞ 与「未测量」的区别）
 *   · 未知值占位符回退（null / undefined / NaN / Infinity / 负数）
 *
 * 运行：node --experimental-strip-types tests/renderer/format.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UNKNOWN,
  formatAudioFormat,
  formatBookSummary,
  formatBytes,
  formatCount,
  formatDate,
  formatDb,
  formatDbfs,
  formatDuration,
  formatDurationLong,
  formatElapsed,
  formatInt,
  formatLra,
  formatLu,
  formatLufs,
  formatOffsetMs,
  formatPercent,
  formatProgressRatio,
  formatRate,
  formatRelativeTime,
  formatSampleRate,
  formatScore,
  formatSeconds,
  formatSpeed,
  isUnknown,
} from '../../src/renderer/src/shared/lib/format.ts'

// ---------------------------------------------------------------------------
// 时长
// ---------------------------------------------------------------------------

test('formatDuration：小于 1 小时用 MM:SS', () => {
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(500), '00:00') // 不足 1 秒向下取整（进度条不应显示 00:01）
  assert.equal(formatDuration(1000), '00:01')
  assert.equal(formatDuration(31_240), '00:31')
  assert.equal(formatDuration(59_999), '00:59')
  assert.equal(formatDuration(60_000), '01:00')
  assert.equal(formatDuration(3_599_000), '59:59')
})

test('formatDuration：超过 1 小时用 HH:MM:SS（小时补零到 2 位）', () => {
  assert.equal(formatDuration(3_600_000), '01:00:00')
  assert.equal(formatDuration(3_723_000), '01:02:03')
  assert.equal(formatDuration(36_000_000), '10:00:00')
  assert.equal(formatDuration(360_000_000), '100:00:00') // 百小时不截断
})

test('formatDuration：showMs 追加十分位（时间线播放头）', () => {
  assert.equal(formatDuration(31_240, { showMs: true }), '00:31.2')
  assert.equal(formatDuration(3_723_000, { showMs: true }), '01:02:03.0')
  assert.equal(formatDuration(999, { showMs: true }), '00:00.9')
})

test('formatDuration：非法输入回退占位符而不是输出 NaN', () => {
  for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(formatDuration(bad as number), UNKNOWN, `${String(bad)} 应回退占位符`)
  }
})

test('formatDurationLong / formatSeconds / formatOffsetMs', () => {
  assert.equal(formatDurationLong(31_200), '31.2 秒')
  assert.equal(formatDurationLong(750_000), '12 分 30 秒')
  assert.equal(formatDurationLong(3_723_000), '1 小时 2 分')
  assert.equal(formatDurationLong(null), UNKNOWN)

  assert.equal(formatSeconds(31.2), '00:31')
  assert.equal(formatSeconds(null), UNKNOWN)

  assert.equal(formatOffsetMs(120), '+120 ms')
  assert.equal(formatOffsetMs(-10), '-10 ms')
  assert.equal(formatOffsetMs(0), '0 ms')
  assert.equal(formatOffsetMs(null), UNKNOWN)
})

// ---------------------------------------------------------------------------
// 字节
// ---------------------------------------------------------------------------

test('formatBytes：1024 进制与单位切换', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1), '1 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB')
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024 * 1024), '1.5 TB')
  // 四舍五入到 1024.0 时自动升一档
  assert.equal(formatBytes(1024 * 1023.99), '1.0 MB')
  assert.equal(formatBytes(1024, 2), '1.00 KB')
})

test('formatBytes：非法输入回退占位符', () => {
  assert.equal(formatBytes(null), UNKNOWN)
  assert.equal(formatBytes(undefined), UNKNOWN)
  assert.equal(formatBytes(Number.NaN), UNKNOWN)
  assert.equal(formatBytes(-5), UNKNOWN)
  assert.equal(formatRate(1024 * 500), '500.0 KB/s')
  assert.equal(formatRate(null), UNKNOWN)
})

// ---------------------------------------------------------------------------
// dB / LUFS
// ---------------------------------------------------------------------------

test('formatDb：带符号、补一位小数、显式单位', () => {
  assert.equal(formatDb(2), '+2.0 dB')
  assert.equal(formatDb(-3), '-3.0 dB')
  assert.equal(formatDb(0), '0.0 dB')
  assert.equal(formatDb(-18.25, 2), '-18.25 dB')
  assert.equal(formatDb(2.44, 0), '+2 dB')
})

test('formatDb：数字静音显示 -∞ dB，与「未测量」区分', () => {
  assert.equal(formatDb(Number.NEGATIVE_INFINITY), '-∞ dB')
  assert.equal(formatDb(null), UNKNOWN)
  assert.equal(formatDb(Number.NaN), UNKNOWN)
  assert.notEqual(formatDb(Number.NEGATIVE_INFINITY), formatDb(null))
})

test('formatDbfs / formatLufs / formatLu / formatLra', () => {
  assert.equal(formatDbfs(-1.2), '-1.2 dBFS')
  assert.equal(formatDbfs(Number.NEGATIVE_INFINITY), '-∞ dBFS')
  assert.equal(formatDbfs(null), UNKNOWN)

  assert.equal(formatLufs(-16.03), '-16.0 LUFS')
  assert.equal(formatLufs(-23), '-23.0 LUFS')
  // 未测量必须显示占位符，绝不能是 -0.0 LUFS
  assert.equal(formatLufs(null), UNKNOWN)
  assert.equal(formatLufs(Number.NaN), UNKNOWN)
  assert.equal(formatLufs(Number.NEGATIVE_INFINITY), UNKNOWN)

  assert.equal(formatLu(1.24), '+1.2 LU')
  assert.equal(formatLu(-0.5), '-0.5 LU')
  assert.equal(formatLu(null), UNKNOWN)

  assert.equal(formatLra(11), '11.0 LU')
  assert.equal(formatLra(null), UNKNOWN)
})

// ---------------------------------------------------------------------------
// 数值
// ---------------------------------------------------------------------------

test('formatInt / formatPercent / formatScore / formatCount', () => {
  assert.equal(formatInt(1_234_567), '1,234,567')
  assert.equal(formatInt(0), '0')
  assert.equal(formatInt(1234.6), '1,235')
  assert.equal(formatInt(null), UNKNOWN)

  assert.equal(formatPercent(0.856), '86%')
  assert.equal(formatPercent(0.856, 1), '85.6%')
  assert.equal(formatPercent(null), UNKNOWN)

  assert.equal(formatScore(0.5832), '0.58')
  assert.equal(formatScore(0.5832, 3), '0.583')
  assert.equal(formatScore(null), UNKNOWN)

  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(12_345), '1.2 万')
  assert.equal(formatCount(123_456_789), '1.23 亿')
  assert.equal(formatCount(null), UNKNOWN)
})

test('formatSampleRate / formatSpeed / formatAudioFormat', () => {
  assert.equal(formatSampleRate(48_000), '48 kHz')
  assert.equal(formatSampleRate(44_100), '44.1 kHz')
  assert.equal(formatSampleRate(null), UNKNOWN)

  assert.equal(formatSpeed(4.2), '4.2 字/秒')
  assert.equal(formatSpeed(null), UNKNOWN)

  assert.equal(formatAudioFormat({ sampleRate: 48_000, bitDepth: 24, channels: 1 }), '48 kHz / 24 bit / 单声道')
  assert.equal(formatAudioFormat({ sampleRate: 44_100, bitDepth: 32, channels: 2 }), '44.1 kHz / 32f bit / 立体声')
  assert.equal(formatAudioFormat({}), `${UNKNOWN} / ${UNKNOWN} bit / ${UNKNOWN}`)
  assert.equal(formatAudioFormat(null), UNKNOWN)
})

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

test('formatDate：token 替换与非法时间戳回退', () => {
  // 本地时区：用 Date 构造再断言，避免测试机时区差异
  const ts = new Date(2024, 4, 1, 9, 7, 3).getTime()
  assert.equal(formatDate(ts), '2024-05-01 09:07')
  assert.equal(formatDate(ts, 'YYYY/MM/DD'), '2024/05/01')
  assert.equal(formatDate(ts, 'HH:mm:ss'), '09:07:03')
  assert.equal(formatDate(new Date(ts)), '2024-05-01 09:07')
  assert.equal(formatDate(null), UNKNOWN)
  assert.equal(formatDate(Number.NaN), UNKNOWN)
  assert.equal(formatDate(new Date('无效')), UNKNOWN)
})

test('formatRelativeTime：刚刚 / 分钟 / 小时 / 天 / 更早显示日期', () => {
  const now = new Date(2024, 4, 20, 12, 0, 0).getTime()
  assert.equal(formatRelativeTime(now - 5_000, now), '刚刚')
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3 小时前')
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2 天前')
  assert.equal(formatRelativeTime(now - 400 * 86_400_000, now), formatDate(now - 400 * 86_400_000, 'YYYY-MM-DD'))
  // 时钟回拨（未来时间）不显示负数「N 分钟前」
  assert.equal(formatRelativeTime(now + 60_000, now), formatDate(now + 60_000, 'YYYY-MM-DD HH:mm'))
  assert.equal(formatRelativeTime(null), UNKNOWN)
})

test('formatElapsed：任务耗时', () => {
  const now = 1_000_000
  assert.equal(formatElapsed(now - 250, now), '250 ms')
  assert.equal(formatElapsed(now - 1_500, now), '1.5 s')
  assert.equal(formatElapsed(now - 95_000, now), '01:35')
  assert.equal(formatElapsed(null, now), UNKNOWN)
})

// ---------------------------------------------------------------------------
// 复合
// ---------------------------------------------------------------------------

test('formatBookSummary / formatProgressRatio', () => {
  assert.equal(
    formatBookSummary({ chapters: 12, chars: 84_000, durationMs: 12_000_000 }),
    '12 章 · 8.4 万字 · 约 3 小时 20 分',
  )
  assert.equal(formatBookSummary({}), UNKNOWN)
  assert.equal(formatBookSummary({ chapters: 1 }), '1 章')

  assert.equal(formatProgressRatio(34, 120), '34/120（28%）')
  assert.equal(formatProgressRatio(0, 0), '0/0')
  assert.equal(formatProgressRatio(null, 10), UNKNOWN)
  assert.equal(formatProgressRatio(5, null), UNKNOWN)
})

test('isUnknown：覆盖全部「无值」形态', () => {
  assert.equal(isUnknown(null), true)
  assert.equal(isUnknown(undefined), true)
  assert.equal(isUnknown(''), true)
  assert.equal(isUnknown(Number.NaN), true)
  assert.equal(isUnknown(Number.POSITIVE_INFINITY), true)
  assert.equal(isUnknown(new Date('x')), true)
  assert.equal(isUnknown(0), false)
  assert.equal(isUnknown('0'), false)
  assert.equal(isUnknown(-1), false)
  assert.equal(isUnknown(false), false)
})
