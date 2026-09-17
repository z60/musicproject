/**
 * Novel Studio · 默认设置项（settings 表种子数据）
 * ============================================================================
 * 唯一来源依据：
 *   · docs/04 §8.2「设置项清单」（字段与取值域的权威定义）
 *   · src/shared/types.ts 的 AppSettings（类型单一来源）
 *   · src/shared/constants.ts（数值默认值的单一来源）
 *   · docs/12 §9.1（默认快捷键）、docs/15（响度与混音）、docs/06 §5.2（判定阈值）
 *
 * 本文件被 scripts/gen-seed-sql.ts 引用，生成 002_seed.sql 的 settings INSERT。
 * 放在 scripts/ 而不是 src/shared/：因为它是**迁移种子**（只写一次、之后由用户改），
 * 而不是运行时读取的常量（运行时读的是数据库里的值）。
 *
 * 约定：key 为点分路径，value 为 JSON 可序列化值，与 AppSettings 的字段一一对应。
 */

export const DEFAULT_SETTINGS_SEED: ReadonlyArray<readonly [string, unknown]> = [
  // ── paths（docs/04 §8.2：其余路径运行时推导，见 002_seed.sql 注释）──────────
  ['paths.ffmpegPath', null],
  ['paths.modelDir', null],

  // ── audio（docs/04 §8.2、docs/05 §2.1）────────────────────────────────────
  ['audio.sampleRate', 48000],
  // 24-bit 是空间与质量的平衡点；docs/05 §2.5 建议 32f（可救增益失误），用户可在设置里改
  ['audio.bitDepth', 24],
  ['audio.channels', 1],
  ['audio.defaultInputDeviceId', null],
  ['audio.monitorEnabled', false],
  ['audio.monitorGainDb', 0],
  ['audio.inputGainDb', 0],
  ['audio.agcEnabled', false],
  ['audio.countdownMs', 3000],
  ['audio.autoTrim', true],
  ['audio.trimThresholdDb', -45],
  ['audio.trimPaddingMs', 100],
  ['audio.echoCancellation', false],

  // ── recording（docs/12 §9.1 默认快捷键、docs/05 §4.2 VAD 默认）──────────────
  ['recording.defaultMode', 'line_by_line'],
  ['recording.stopKey', 'Space'],
  ['recording.nextLineKey', 'ArrowDown'],
  ['recording.redoKey', 'Ctrl+R'],
  ['recording.playKey', 'P'],
  ['recording.footPedalEnabled', false],
  ['recording.footPedalMapping', { F13: 'stop_and_next', F14: 'redo' }],
  ['recording.vad', {
    enabled: true,
    silenceDb: -45,
    minSilenceMs: 350,
    minSpeechMs: 120,
    minSliceMs: 180,
    maxSliceMs: 15000,
    headRollbackMs: 80,
    tailKeepMs: 200,
    autoNoiseFloor: true,
    charsPerSecond: 4.2,
  }],
  ['recording.maxSessionMinutes', 240],

  // ── canvas（docs/06 §5.2、docs/11 §5）────────────────────────────────────
  ['canvas.attributionThreshold', 0.62],
  ['canvas.attributionMargin', 0.06],
  ['canvas.contextWindow', 2],
  ['canvas.autoAcceptConfidence', 0.85],
  ['canvas.defaultPauseAfterMs', 500],
  ['canvas.defaultEmotion', '平静'],
  ['canvas.maxLineChars', 120],
  ['canvas.maxNarrationRun', 15],
  ['canvas.shortLineChars', 6],

  // ── mixing（docs/05 §8 响度、§7.5 闪避、docs/13 §4 排布）─────────────────
  ['mixing.targetLufs', -16],
  ['mixing.truePeakDb', -1],
  ['mixing.headSilenceMs', 500],
  ['mixing.tailSilenceMs', 1500],
  ['mixing.defaultMusicGainDb', -18],
  ['mixing.duckAmountDb', -12],
  ['mixing.duckAttackMs', 150],
  ['mixing.duckReleaseMs', 400],
  ['mixing.maxCrossTrackOverlapMs', 3000],
  ['mixing.maxGapMs', 5000],

  // ── export（docs/05 §9.3、docs/15）──────────────────────────────────────
  ['export.format', 'mp3'],
  ['export.mp3Bitrate', 192],
  ['export.m4bBitrate', 96],
  ['export.fileNameTemplate', '{bookTitle}/{chapterIndex:03}_{chapterTitle}'],
  ['export.chapterTitleTemplate', '第{index}章 {title}'],
  ['export.writeMetadata', true],
  ['export.coverPath', null],
  ['export.splitM4bEvery', 0],

  // ── ai（docs/04 §10、docs/06）───────────────────────────────────────────
  // 默认 mock：不联网也能跑通全流程；allowSendTextToCloud 默认 false（隐私优先）
  ['ai.provider', 'mock'],
  ['ai.baseUrl', ''],
  ['ai.model', 'mock'],
  ['ai.timeoutMs', 60000],
  ['ai.maxConcurrency', 2],
  ['ai.allowSendTextToCloud', false],

  // ── embedding / asr（docs/06 §4、docs/05 §4）────────────────────────────
  ['embedding.modelId', 'bge-small-zh-v1.5'],
  ['embedding.batchSize', 16],
  ['embedding.threads', 4],
  ['asr.modelId', 'ggml-base.bin'],
  ['asr.language', 'zh'],
  ['asr.threads', 4],
  ['asr.translate', false],

  // ── import（docs/10 §2：单文件 200 MB、单页 5 MB、总页数 50、礼貌间隔 1.5 s）──
  ['import.maxFileSizeBytes', 200 * 1024 * 1024],
  ['import.maxUrlPages', 50],
  ['import.fetchDelayMs', 1500],

  // ── ui / advanced（docs/04 §8.2、§5.1）──────────────────────────────────
  ['ui.theme', 'system'],
  ['ui.language', 'zh-CN'],
  ['ui.editorDensity', 'normal'],
  ['advanced.logLevel', 'info'],
  ['advanced.autoBackup', 'daily'],
  ['advanced.keepBackups', 7],
  ['advanced.autoCleanupTakes', false],
]
