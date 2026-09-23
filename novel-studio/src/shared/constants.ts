/**
 * Novel Studio · 常量与内置数据
 * ============================================================================
 * 设计依据：
 *   · docs/11 §2.3  停顿推断与情绪集
 *   · docs/14 §4.1  内置处理预设（起点参数，最终以实听为准）
 *   · docs/10 §6.2  内置分章规则
 *   · docs/06 §5.2  判定阈值默认值
 *   · docs/05 §12   音频参数速查表
 *
 * 本文件不含任何第三方依赖，可被主进程、渲染进程与 Node 脚本直接导入。
 */

import type { ChapterRuleSet, ProcessChain, ProcessPreset, VadOptions } from './types.ts'

// ============================================================================
// 音频参数（docs/05 §12）
// ============================================================================

export const AUDIO_DEFAULTS = {
  sampleRate: 48000,
  /** 采集用 float32（32）；落盘默认 24 位。32f 可救增益失误（docs/05 §2.5） */
  captureBitDepth: 32,
  fileBitDepth: 24,
  channels: 1,
  /** 采集包大小（毫秒）。128 帧太小会打满消息队列，50 ms 是延迟与开销的平衡点 */
  packMs: 50,
  fsyncIntervalMs: 1000,
  metaFlushIntervalMs: 5000,
  /** 混音分批大小：滤镜图过大会让命令行超长、内存爆（docs/05 §7.1） */
  mixBatchSize: 32,
} as const

/** WAV 头长度（RIFF/WAVE/fmt/data） */
export const WAV_HEADER_BYTES = 44

/** 单声道 48 kHz 24-bit 的估算写入速率，用于磁盘空间预检 */
export const BYTES_PER_SECOND_24BIT_MONO_48K = 48000 * 3
export const BYTES_PER_SECOND_FLOAT32_MONO_48K = 48000 * 4

export const RECORD_LIMITS = {
  /** 短于此时长视为误触（docs/12 §3.3） */
  minTakeMs: 150,
  /** 长于此时长提示确认（多半是忘了停） */
  warnTakeMs: 60_000,
  /** 录音前要求的最小可用磁盘空间 */
  requiredFreeBytes: 500 * 1024 * 1024,
  defaultMaxSessionMinutes: 240,
} as const

// ============================================================================
// VAD 默认参数（docs/05 §4.2）
// ============================================================================

export const VAD_DEFAULTS: VadOptions = {
  enabled: true,
  silenceDb: -45,
  minSilenceMs: 350,
  minSpeechMs: 120,
  minSliceMs: 180,
  maxSliceMs: 15_000,
  /** 起点向前回退，避免吃掉字头爆破音 p/b/t/d */
  headRollbackMs: 80,
  /** 保留自然收尾 */
  tailKeepMs: 200,
  autoNoiseFloor: true,
  /** 中文朗读语速估算，用于估算画本行期望时长 */
  charsPerSecond: 4.2,
}

/** 噪声底之上多少 dB 判定为语音 */
export const VAD_SPEECH_MARGIN_DB = 12
/** 两段间隔小于此值时合并（句内停顿被误切） */
export const VAD_BRIDGE_GAP_MS = 250
/** 低于「噪声底 + 此值」的切片直接丢弃（咳嗽、椅子声） */
export const VAD_DISCARD_MARGIN_DB = 6

// ============================================================================
// 修剪与对轨（docs/05 §5.3、docs/13 §4）
// ============================================================================

export const TRIM_DEFAULTS = {
  enabled: true,
  thresholdDb: -45,
  headPaddingMs: 100,
  tailPaddingMs: 120,
} as const

export const ARRANGE_DEFAULTS = {
  /** 画本行间默认留白 */
  defaultPauseMs: 500,
  /** 同轨消解后两段之间的最小间隙 */
  minGapMs: 50,
  /** 跨轨重叠在此范围内视为正常对话 */
  maxCrossTrackOverlapMs: 3000,
  /** 非章头章尾的静音超过此值告警（多半是缺录了一行） */
  maxGapMs: 5000,
  /** 片段过短/过长的判定阈值 */
  minSegmentMs: 200,
  maxSegmentMs: 60_000,
  /** 极小值：低于此 RMS 视为静音片段 */
  silentRmsDb: -60,
  defaultFadeMs: 5,
} as const

/**
 * 对轨问题类型的中文标签（`alignment:issueKindLabels` 的唯一文案来源）。
 *
 * 为什么放在主进程而不是渲染侧：同一个 issue 会在**时间线、校验面板、导出预检**
 * 三处出现，文案分散就意味着三处叫法不同（「缺录」/「未录音」/「没有音频」），
 * 用户会以为是三种问题。渲染侧有兜底表（`ISSUE_KIND_FALLBACK_LABELS`），
 * 但它只在主进程不可用时生效。
 */
export const ALIGN_ISSUE_LABELS: Record<
  | 'missing_line'
  | 'unarranged_line'
  | 'orphan_segment'
  | 'same_track_overlap'
  | 'cross_track_overlap_warn'
  | 'long_gap'
  | 'short_segment'
  | 'long_segment'
  | 'silent_segment'
  | 'clipped_segment'
  | 'file_missing'
  | 'wrong_order',
  string
> = {
  missing_line: '缺录（画本行没有录音）',
  unarranged_line: '有录音但未排布（重新自动排布即可归位）',
  orphan_segment: '孤儿片段（画本行已删除）',
  same_track_overlap: '同轨重叠（必须消解）',
  cross_track_overlap_warn: '跨轨重叠过大',
  long_gap: '过长静音（可能缺录一行）',
  short_segment: '片段过短',
  long_segment: '片段过长',
  silent_segment: '片段是静音',
  clipped_segment: '片段削波',
  file_missing: '音频文件丢失',
  wrong_order: '顺序颠倒（疑似错绑）',
}

/** 阻断项（必须处理才能导出）—— 与 `shared/arrange/validate.ts` 的 `isBlockingIssue` 一致 */
export const ALIGN_BLOCKING_ISSUES = [
  'missing_line',
  // 有录音却没排进方案 → 渲染/导出会丢掉这段音频，和缺录一样是阻断项
  'unarranged_line',
  'same_track_overlap',
  'file_missing',
] as const

/** 停顿推断表（docs/11 §2.3） */
export const PAUSE_RULES: Array<{ label: string; match: string; pauseMs: number }> = [
  { label: '句号结尾', match: '。', pauseMs: 500 },
  { label: '感叹号结尾', match: '！', pauseMs: 450 },
  { label: '问号结尾', match: '？', pauseMs: 450 },
  { label: '省略号/破折号（拖音或被打断）', match: '……', pauseMs: 700 },
  { label: '逗号结尾（分行未断句）', match: '，', pauseMs: 200 },
  { label: '段落结束', match: '\\n\\n', pauseMs: 900 },
  { label: '场景切换（说话人变化 + 段落结束）', match: '__scene_change__', pauseMs: 1200 },
  { label: '连续对白（同一角色）', match: '__same_speaker__', pauseMs: 350 },
]

/** 全局节奏预设：对全部停顿值乘系数 */
export const TEMPO_PRESETS = [
  { id: 'tight', label: '紧凑', factor: 0.8 },
  { id: 'normal', label: '标准', factor: 1.0 },
  { id: 'relaxed', label: '舒缓', factor: 1.3 },
] as const

// ============================================================================
// 画本与判定（docs/06 §5.2、docs/11 §5）
// ============================================================================

export const CANVAS_DEFAULTS = {
  attributionThreshold: 0.62,
  attributionMargin: 0.06,
  contextWindow: 2,
  autoAcceptConfidence: 0.85,
  defaultPauseAfterMs: 500,
  defaultEmotion: '平静',
  maxLineChars: 120,
  /** 短于此长度的行不做向量判定（不可靠） */
  shortLineChars: 6,
  /** 连续旁白超过此行数视为可疑（可能漏判对白） */
  maxNarrationRun: 15,
  /** 连续同一角色对白超过此行数视为可疑 */
  maxDialogueRun: 20,
} as const

/** 置信度分档用于 UI 色带（docs/11 §4.2） */
export const CONFIDENCE_BANDS = [
  { min: 0.85, label: '高', color: '#67c23a' },
  { min: 0.62, label: '中', color: '#e6a23c' },
  { min: 0, label: '低', color: '#f56c6c' },
] as const

/** 情绪集（docs/11 §5 与 docs/21 §12） */
export const EMOTIONS = [
  '平静', '喜悦', '愤怒', '悲伤', '惊讶', '恐惧', '厌恶', '嘲讽',
  '激动', '低沉', '温柔', '焦急', '决绝', '无奈',
] as const

export type Emotion = (typeof EMOTIONS)[number]

export const SPEED_OPTIONS = [
  { value: 'slow', label: '慢' },
  { value: 'normal', label: '正常' },
  { value: 'fast', label: '快' },
] as const

/**
 * 多音字表（docs/11 §5）：命中则提示人工确认读音。
 * 不做自动替换 —— 那会错得更离谱。
 */
export const POLYPHONE_HINTS: Array<{ char: string; readings: string[]; hint: string }> = [
  { char: '行', readings: ['xíng', 'háng'], hint: '行走 / 行业、银行' },
  { char: '重', readings: ['zhòng', 'chóng'], hint: '重要 / 重复' },
  { char: '还', readings: ['hái', 'huán'], hint: '还有 / 归还' },
  { char: '长', readings: ['cháng', 'zhǎng'], hint: '长度 / 成长' },
  { char: '乐', readings: ['lè', 'yuè'], hint: '快乐 / 音乐' },
  { char: '地', readings: ['dì', 'de'], hint: '土地 / 助词' },
  { char: '了', readings: ['le', 'liǎo'], hint: '助词 / 了解' },
  { char: '差', readings: ['chà', 'chā', 'chāi'], hint: '差不多 / 差别 / 出差' },
  { char: '藏', readings: ['cáng', 'zàng'], hint: '躲藏 / 宝藏、西藏' },
  { char: '率', readings: ['lǜ', 'shuài'], hint: '效率 / 率领' },
  { char: '血', readings: ['xuè', 'xiě'], hint: '书面 / 口语' },
  { char: '薄', readings: ['báo', 'bó', 'bò'], hint: '薄片 / 单薄 / 薄荷' },
  { char: '露', readings: ['lù', 'lòu'], hint: '露水 / 露面' },
  { char: '处', readings: ['chǔ', 'chù'], hint: '处理 / 处所' },
  { char: '为', readings: ['wéi', 'wèi'], hint: '作为 / 为了' },
  { char: '着', readings: ['zhe', 'zháo', 'zhuó'], hint: '助词 / 着急 / 着装' },
  { char: '得', readings: ['de', 'dé', 'děi'], hint: '助词 / 得到 / 必须' },
  { char: '种', readings: ['zhǒng', 'zhòng'], hint: '种类 / 种植' },
]

/** 音效提示行的括号族（docs/11 §2.2） */
export const SFX_BRACKETS: Array<[string, string]> = [
  ['【', '】'],
  ['（音效：', '）'],
  ['(音效：', ')'],
]

/** 引号族（成对，按最内层优先配对） */
export const QUOTE_PAIRS: Array<[string, string]> = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
  ['‘', '’'],
]

// ============================================================================
// 响度与导出（docs/05 §8、docs/15）
// ============================================================================

export const LOUDNESS_TARGETS = [
  { id: 'audiobook', label: '有声书 / 播客（-16 LUFS）', lufs: -16, lra: 11 },
  { id: 'streaming', label: '流媒体（-14 LUFS）', lufs: -14, lra: 11 },
  { id: 'broadcast', label: '广播 EBU R128（-23 LUFS）', lufs: -23, lra: 15 },
] as const

export const EXPORT_DEFAULTS = {
  headSilenceMs: 500,
  tailSilenceMs: 1500,
  mp3Bitrate: 192,
  m4bBitrate: 96,
  /** MP3 输出常用 44.1 kHz */
  mp3SampleRate: 44100,
  /** alimiter 的 limit 是线性值，不是 dB（docs/14 §3.1） */
  truePeakDb: -1,
  fileNameTemplate: '{bookTitle}/{chapterIndex:03}_{chapterTitle}',
  chapterTitleTemplate: '第{index}章 {title}',
  /** 超过此章数时部分播放器章节列表异常，建议按卷拆分 */
  m4bChapterWarnThreshold: 200,
  /** M4B 单文件时长上限（小时） */
  m4bMaxHours: 24,
} as const

/** MP3 VBR 质量档（export:vbrPresets 的数据源；value 是 -q:a 的档位，不是码率） */
export const VBR_PRESETS = [
  { label: 'V0 最高（约 245 kbps）', value: 0 },
  { label: 'V1 高（约 225 kbps）', value: 1 },
  { label: 'V2 推荐（约 190 kbps）', value: 2 },
  { label: 'V3 中（约 175 kbps）', value: 3 },
  { label: 'V4 较小（约 165 kbps）', value: 4 },
  { label: 'V5 小（约 130 kbps）', value: 5 },
  { label: 'V6 很小（约 115 kbps）', value: 6 },
  { label: 'V7 最小（约 100 kbps）', value: 7 },
  { label: 'V8 极低（约 85 kbps）', value: 8 },
  { label: 'V9 最低（约 65 kbps）', value: 9 },
] as const

/** 响度验收阈值（docs/15 §6.2） */
export const QC_THRESHOLDS = {
  /** 目标响度允许偏差（LU） */
  lufsTolerance: 1.0,
  /** 章间响度差上限（LU）—— 超出听众会觉得「这章响那章轻」 */
  chapterLufsSpread: 1.5,
  /** 整章 RMS 低于此值判定渲染失败 */
  silentRmsDb: -60,
  /** 异常长静音（秒） */
  longSilenceSec: 10,
  /** 成品与预期时长的允许偏差（毫秒） */
  durationToleranceMs: 1000,
} as const

// ============================================================================
// 处理链（docs/14 §2、§4.1）
// ============================================================================

/** 空处理链（全关） */
export function createEmptyChain(): ProcessChain {
  return {
    highpass: { enabled: false, freq: 80, poles: 2 },
    denoise: { enabled: false, nr: 12, nf: -30, tn: false },
    deesser: { enabled: false, intensity: 0.5, freq: 0.5 },
    eq: [],
    compressor: { enabled: false, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 0 },
    limiter: { enabled: true, limitDb: -1, attackMs: 5, releaseMs: 80 },
    repair: {
      dcOffset: false,
      polarityInvert: false,
      declick: [],
      silenceFill: [],
      tempo: { enabled: false, factor: 1 },
    },
  }
}

function chain(partial: {
  highpass?: ProcessChain['highpass']
  denoise?: ProcessChain['denoise']
  deesser?: ProcessChain['deesser']
  eq?: ProcessChain['eq']
  compressor?: ProcessChain['compressor']
  limiter?: ProcessChain['limiter']
}): ProcessChain {
  const base = createEmptyChain()
  return {
    ...base,
    ...partial,
    eq: partial.eq ?? base.eq,
    repair: base.repair,
  }
}

/**
 * 内置预设（起点参数，最终以实听为准；docs/14 §4.1）。
 * 内置预设不可直接编辑 —— 用户改动会创建副本，避免改坏后不知道怎么恢复。
 */
export const BUILTIN_PRESETS: ProcessPreset[] = [
  {
    id: 'builtin:narration-male',
    projectId: null,
    name: '男声·旁白·沉稳',
    description: '去闷 + 提清晰度，适合长篇旁白',
    builtin: true,
    tags: ['男声', '旁白'],
    sortOrder: 10,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({
      highpass: { enabled: true, freq: 70, poles: 2 },
      denoise: { enabled: true, nr: 10, nf: -30, tn: false },
      deesser: { enabled: true, intensity: 0.3, freq: 0.5 },
      eq: [
        { id: 'n1', type: 'peak', freq: 250, gainDb: -2, q: 1, enabled: true },
        { id: 'n2', type: 'peak', freq: 3500, gainDb: 2, q: 1.2, enabled: true },
      ],
      compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 },
    }),
  },
  {
    id: 'builtin:character-female',
    projectId: null,
    name: '女声·角色·明亮',
    description: '加空气感、削低频浊音',
    builtin: true,
    tags: ['女声', '角色'],
    sortOrder: 20,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({
      highpass: { enabled: true, freq: 90, poles: 2 },
      denoise: { enabled: true, nr: 8, nf: -32, tn: false },
      deesser: { enabled: true, intensity: 0.5, freq: 0.5 },
      eq: [
        { id: 'f1', type: 'peak', freq: 400, gainDb: -1.5, q: 1, enabled: true },
        { id: 'f2', type: 'highshelf', freq: 6000, gainDb: 1.5, q: 0.7, enabled: true },
      ],
      compressor: { enabled: true, thresholdDb: -20, ratio: 2.5, attackMs: 8, releaseMs: 150, makeupDb: 2 },
    }),
  },
  {
    id: 'builtin:broadcast',
    projectId: null,
    name: '广播·有力',
    description: '厚实靠前，适合宣传与有力台词',
    builtin: true,
    tags: ['广播', '有力'],
    sortOrder: 30,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({
      highpass: { enabled: true, freq: 80, poles: 2 },
      denoise: { enabled: true, nr: 12, nf: -28, tn: false },
      deesser: { enabled: true, intensity: 0.5, freq: 0.5 },
      eq: [
        { id: 'b1', type: 'peak', freq: 200, gainDb: -3, q: 1, enabled: true },
        { id: 'b2', type: 'peak', freq: 3000, gainDb: 3, q: 1.2, enabled: true },
        { id: 'b3', type: 'highshelf', freq: 8000, gainDb: 1.5, q: 0.7, enabled: true },
      ],
      compressor: { enabled: true, thresholdDb: -16, ratio: 4, attackMs: 5, releaseMs: 150, makeupDb: 3 },
    }),
  },
  {
    id: 'builtin:phone-rescue',
    projectId: null,
    name: '手机录音·抢救',
    description: '强力降噪 + 大幅补中高频，用于条件差的素材',
    builtin: true,
    tags: ['抢救', '手机录音'],
    sortOrder: 40,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({
      highpass: { enabled: true, freq: 120, poles: 2 },
      denoise: { enabled: true, nr: 18, nf: -26, tn: true },
      deesser: { enabled: true, intensity: 0.7, freq: 0.5 },
      eq: [
        { id: 'p1', type: 'peak', freq: 300, gainDb: -4, q: 1, enabled: true },
        { id: 'p2', type: 'peak', freq: 2500, gainDb: 3, q: 1.2, enabled: true },
      ],
      compressor: { enabled: true, thresholdDb: -15, ratio: 4, attackMs: 5, releaseMs: 120, makeupDb: 3 },
    }),
  },
  {
    id: 'builtin:asmr',
    projectId: null,
    name: 'ASMR·贴近',
    description: '轻处理，保留气声与细节',
    builtin: true,
    tags: ['ASMR', '轻处理'],
    sortOrder: 50,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({
      highpass: { enabled: true, freq: 100, poles: 2 },
      denoise: { enabled: true, nr: 6, nf: -36, tn: false },
      deesser: { enabled: true, intensity: 0.2, freq: 0.5 },
      eq: [{ id: 'a1', type: 'peak', freq: 5000, gainDb: 2, q: 0.8, enabled: true }],
      compressor: { enabled: true, thresholdDb: -22, ratio: 2, attackMs: 15, releaseMs: 250, makeupDb: 1 },
    }),
  },
  {
    id: 'builtin:old-tape',
    projectId: null,
    name: '老录音·去嘶声',
    description: '压制高频嘶声与底噪',
    builtin: true,
    tags: ['修复', '去嘶'],
    sortOrder: 60,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({
      highpass: { enabled: true, freq: 150, poles: 2 },
      denoise: { enabled: true, nr: 14, nf: -24, tn: true },
      deesser: { enabled: true, intensity: 0.8, freq: 0.55 },
      eq: [
        { id: 't1', type: 'peak', freq: 350, gainDb: -2, q: 1, enabled: true },
        { id: 't2', type: 'peak', freq: 7000, gainDb: -1, q: 1, enabled: true },
        { id: 't3', type: 'peak', freq: 2000, gainDb: 1.5, q: 1, enabled: true },
      ],
      compressor: { enabled: true, thresholdDb: -18, ratio: 3, attackMs: 8, releaseMs: 180, makeupDb: 2 },
    }),
  },
  {
    id: 'builtin:trim-only',
    projectId: null,
    name: '仅修剪（不做处理）',
    description: '只统一格式与峰值，不改音色',
    builtin: true,
    tags: ['无处理'],
    sortOrder: 70,
    createdAt: 0,
    updatedAt: 0,
    chain: chain({}),
  },
]

// ============================================================================
// 分章规则（docs/10 §6.2）
// ============================================================================

export const BUILTIN_RULE_SETS: ChapterRuleSet[] = [
  {
    id: 'builtin:cn-standard',
    name: '中文小说·标准',
    builtin: true,
    allowNumericOnly: false,
    patterns: [
      { id: 'cn-num', linePattern: '第[零一二三四五六七八九十百千万两0-9]+章.*', maxLineLength: 40, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
      { id: 'cn-jie', linePattern: '第[零一二三四五六七八九十百千万两0-9]+节.*', maxLineLength: 40, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
      { id: 'cn-hui', linePattern: '第[零一二三四五六七八九十百千万两0-9]+回.*', maxLineLength: 40, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
      { id: 'cn-juan', linePattern: '第[零一二三四五六七八九十百千万两0-9]+[卷部篇].*', maxLineLength: 30, requireBlankAround: true, titleGroup: 0, kind: 'volume' },
      { id: 'special', linePattern: '^(序章|序言|序|楔子|引子|前言|后记|尾声|终章|番外|大结局).*', maxLineLength: 30, requireBlankAround: false, titleGroup: 0, kind: 'extra' },
      { id: 'en-chapter', linePattern: '(?i)chapter\\s+[\\dIVXLC]+\\.?.*', maxLineLength: 60, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
      { id: 'bracket', linePattern: '^[\\[【]第[零一二三四五六七八九十百千万两0-9]+章.*[\\]】]$', maxLineLength: 40, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
    ],
  },
  {
    id: 'builtin:cn-loose',
    name: '中文小说·宽松（含纯数字标题）',
    builtin: true,
    allowNumericOnly: true,
    patterns: [
      { id: 'cn-num', linePattern: '第[零一二三四五六七八九十百千万两0-9]+章.*', maxLineLength: 40, requireBlankAround: false, titleGroup: 0, kind: 'chapter' },
      { id: 'num-only', linePattern: '^[0-9]{1,4}$', maxLineLength: 6, requireBlankAround: true, titleGroup: 0, kind: 'chapter' },
      { id: 'special', linePattern: '^(序章|序言|楔子|引子|尾声|番外).*', maxLineLength: 30, requireBlankAround: false, titleGroup: 0, kind: 'extra' },
    ],
  },
]

/**
 * 画本导入专用的分章规则。
 *
 * **不能直接用 cn-standard**：它有一条 `^(序章|序言|序|楔子|…).*` 规则，
 * 而画本每章末尾的角色表表头正是「**序号**」—— 会被切成一个假章；
 * 更宽的「节/回/番外」匹配也会把角色表附近的文本误当边界。
 * 画本文档的结构只有「第N章」（偶尔「第N卷/部/篇」）是权威的。
 */
export const CANVAS_IMPORT_RULE_SET: ChapterRuleSet = {
  id: 'builtin:canvas-script',
  name: '画本导入（仅第N章）',
  builtin: true,
  allowNumericOnly: false,
  patterns: [
    {
      id: 'canvas-cn-chapter',
      linePattern: '第[零一二三四五六七八九十百千万两0-9]+章.*',
      maxLineLength: 80,
      requireBlankAround: false,
      titleGroup: 0,
      kind: 'chapter',
    },
    {
      id: 'canvas-cn-volume',
      linePattern: '第[零一二三四五六七八九十百千万两0-9]+[卷部篇].*',
      maxLineLength: 60,
      requireBlankAround: true,
      titleGroup: 0,
      kind: 'volume',
    },
  ],
}

// ============================================================================
// 导入清洗（docs/10 §5.1）
// ============================================================================

/** 站点广告行关键词 */
export const AD_LINE_PATTERNS = [
  '请记住本站',
  '最新章节',
  '手机版阅读',
  '加入书签',
  '天才一秒记住',
  '本章未完',
  '点击下一页',
  '内容未完',
  '记住本站域名',
  '无弹窗',
  'txt下载',
  '全集下载',
  '首发',
  '转码',
  '笔趣阁',
  '亲们',
  '求收藏',
  '求推荐票',
  '求月票',
] as const

/** 页尾导航组合行 */
export const NAV_LINE_PATTERNS = [
  '上一章',
  '下一章',
  '返回目录',
  '章节报错',
  '章节目录',
  '加入书架',
] as const

export const IMPORT_LIMITS = {
  maxFileSizeBytes: 200 * 1024 * 1024,
  maxUrlPages: 50,
  /** 抓取间隔（礼貌），docs/10 §8.4 */
  fetchDelayMs: 1500,
  maxUrlPageBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
} as const

// ============================================================================
// 项目（docs/10 §7 / docs/21 §3）
// ============================================================================

/**
 * 默认项目的 id（**固定值**：让「用户重装后项目 id 不变」成为确定行为）。
 *
 * 为什么放在 `shared` 而不是 main 的仓储里：**渲染进程也要用它**。
 * 契约里没有「当前项目」通道，而 `book:commitImport` 等导入通道要求 `projectId` 必填；
 * 书架为空（全新安装、或用户把书都删了）时渲染进程无从推断项目 —— 只能落到主进程
 * 启动期就已经 `ensureDefault` 建好的默认项目上。
 * 缺了它就会形成死锁：**导入需要项目 → 项目需要书 → 书需要导入**（真机事故 docs/91 §5.2.4）。
 *
 * 单一来源：main 的 `project.repo.ts` 也从这里取，不要再各写一份字面量。
 */
export const DEFAULT_PROJECT_ID = 'default'

// ============================================================================
// 编码（docs/10 §4）
// ============================================================================

/**
 * 中文场景必须把 GBK 升级到 GB18030：
 * GBK 是 GB18030 的子集，用 GB18030 解码更安全，能处理生僻字。
 * 这是中文小说导入最容易踩的坑。
 */
export const ENCODING_UPGRADE: Record<string, string> = {
  GBK: 'GB18030',
  GB2312: 'GB18030',
  gbk: 'GB18030',
  'x-gbk': 'GB18030',
  GB18030: 'GB18030',
}

/** 常见编码候选（嗅探不出时按此顺序尝试） */
export const ENCODING_CANDIDATES = ['UTF-8', 'GB18030', 'Big5', 'UTF-16LE', 'UTF-16BE'] as const

export const BOM_TABLE: Array<{ bytes: number[]; encoding: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'UTF-8' },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'UTF-32LE' },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'UTF-32BE' },
  { bytes: [0xff, 0xfe], encoding: 'UTF-16LE' },
  { bytes: [0xfe, 0xff], encoding: 'UTF-16BE' },
]

// ============================================================================
// 界面文案映射
// ============================================================================

export const LINE_KIND_LABELS: Record<string, string> = {
  dialogue: '台词',
  narration: '旁白',
  inner: '内心',
  sfx_note: '音效',
}

export const LINE_STATE_LABELS: Record<string, string> = {
  draft: '未处理',
  assigned: '已分配',
  recorded: '已录',
  aligned: '已对轨',
}

export const DECIDED_BY_LABELS: Record<string, string> = {
  rule: '规则',
  vector: '语义判定',
  llm: 'AI 复核',
  human: '人工确认',
}

export const ARRANGE_STRATEGY_LABELS: Record<string, string> = {
  serialize: '串行化',
  keep: '保留交叠',
  'compress-pause': '压缩留白',
  tighten: '紧贴',
}

export const SEVERITY_LABELS: Record<string, string> = {
  info: '提示',
  warning: '警告',
  error: '错误',
  fatal: '阻断',
}

export const TASK_KIND_LABELS: Record<string, string> = {
  'book.import': '导入书籍',
  'canvas.generate': '生成画本',
  'canvas.recompute': '重算说话人判定',
  'character.centroid': '重建角色音色原型',
  'embedding.batch': '语义向量化',
  'asr.transcribe': '语音识别',
  'audio.process': '音频处理',
  'audio.render': '混音渲染',
  'export.chapter': '导出章节',
  'export.book': '导出整本',
  'package.export': '导出项目包',
  'package.import': '导入项目包',
  'package.merge': '回收任务包',
  'db.backup': '数据库备份',
  'cache.clean': '清理缓存',
}
