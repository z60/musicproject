-- ============================================================================
-- Novel Studio · 002_seed.sql
-- ============================================================================
-- 唯一来源：docs/21-数据字典与SQL.md §13（预置数据）
--           + src/shared/constants.ts（BUILTIN_RULE_SETS / BUILTIN_PRESETS / 默认值）
--
-- 本文件由 scripts/gen-seed-sql.ts 生成，请勿手工编辑：
--   node --experimental-strip-types scripts/gen-seed-sql.ts
-- 校验是否与常量同步：
--   node --experimental-strip-types scripts/gen-seed-sql.ts --check
--
-- 迁移纪律（docs/21 §13）：发布后不可修改（migrate.ts 校验 sha256），需要变更请新增迁移。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) meta：预置时间戳占位（schema_version 由 migrate.ts 写入，app_version 由启动时
--    从 package.json 读取后写入 —— 不在这里写死版本号，避免两处维护）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO meta(key, value) VALUES ('created_at', CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO meta(key, value) VALUES ('last_backup_at', '0');
INSERT OR IGNORE INTO meta(key, value) VALUES ('last_integrity_check_at', '0');

-- ---------------------------------------------------------------------------
-- 2) 内置分章规则集（docs/10 §6.2；project_id = NULL 表示全局）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO chapter_rule_sets(id, project_id, name, builtin, definition, created_at, updated_at) VALUES ('builtin:cn-standard', NULL, '中文小说·标准', 1, '{"id":"builtin:cn-standard","name":"中文小说·标准","builtin":true,"allowNumericOnly":false,"patterns":[{"id":"cn-num","linePattern":"第[零一二三四五六七八九十百千万两0-9]+章.*","maxLineLength":40,"requireBlankAround":false,"titleGroup":0,"kind":"chapter"},{"id":"cn-jie","linePattern":"第[零一二三四五六七八九十百千万两0-9]+节.*","maxLineLength":40,"requireBlankAround":false,"titleGroup":0,"kind":"chapter"},{"id":"cn-hui","linePattern":"第[零一二三四五六七八九十百千万两0-9]+回.*","maxLineLength":40,"requireBlankAround":false,"titleGroup":0,"kind":"chapter"},{"id":"cn-juan","linePattern":"第[零一二三四五六七八九十百千万两0-9]+[卷部篇].*","maxLineLength":30,"requireBlankAround":true,"titleGroup":0,"kind":"volume"},{"id":"special","linePattern":"^(序章|序言|序|楔子|引子|前言|后记|尾声|终章|番外|大结局).*","maxLineLength":30,"requireBlankAround":false,"titleGroup":0,"kind":"extra"},{"id":"en-chapter","linePattern":"(?i)chapter\\s+[\\dIVXLC]+\\.?.*","maxLineLength":60,"requireBlankAround":false,"titleGroup":0,"kind":"chapter"},{"id":"bracket","linePattern":"^[\\[【]第[零一二三四五六七八九十百千万两0-9]+章.*[\\]】]$","maxLineLength":40,"requireBlankAround":false,"titleGroup":0,"kind":"chapter"}]}', 0, 0);
INSERT OR IGNORE INTO chapter_rule_sets(id, project_id, name, builtin, definition, created_at, updated_at) VALUES ('builtin:cn-loose', NULL, '中文小说·宽松（含纯数字标题）', 1, '{"id":"builtin:cn-loose","name":"中文小说·宽松（含纯数字标题）","builtin":true,"allowNumericOnly":true,"patterns":[{"id":"cn-num","linePattern":"第[零一二三四五六七八九十百千万两0-9]+章.*","maxLineLength":40,"requireBlankAround":false,"titleGroup":0,"kind":"chapter"},{"id":"num-only","linePattern":"^[0-9]{1,4}$","maxLineLength":6,"requireBlankAround":true,"titleGroup":0,"kind":"chapter"},{"id":"special","linePattern":"^(序章|序言|楔子|引子|尾声|番外).*","maxLineLength":30,"requireBlankAround":false,"titleGroup":0,"kind":"extra"}]}', 0, 0);

-- ---------------------------------------------------------------------------
-- 3) 内置处理预设（docs/14 §4.1；内置预设不可直接编辑，用户改动会创建副本）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:narration-male', NULL, '男声·旁白·沉稳', '去闷 + 提清晰度，适合长篇旁白', 1, '{"highpass":{"enabled":true,"freq":70,"poles":2},"denoise":{"enabled":true,"nr":10,"nf":-30,"tn":false},"deesser":{"enabled":true,"intensity":0.3,"freq":0.5},"eq":[{"id":"n1","type":"peak","freq":250,"gainDb":-2,"q":1,"enabled":true},{"id":"n2","type":"peak","freq":3500,"gainDb":2,"q":1.2,"enabled":true}],"compressor":{"enabled":true,"thresholdDb":-18,"ratio":3,"attackMs":8,"releaseMs":180,"makeupDb":2},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["男声","旁白"]', 10, 0, 0);
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:character-female', NULL, '女声·角色·明亮', '加空气感、削低频浊音', 1, '{"highpass":{"enabled":true,"freq":90,"poles":2},"denoise":{"enabled":true,"nr":8,"nf":-32,"tn":false},"deesser":{"enabled":true,"intensity":0.5,"freq":0.5},"eq":[{"id":"f1","type":"peak","freq":400,"gainDb":-1.5,"q":1,"enabled":true},{"id":"f2","type":"highshelf","freq":6000,"gainDb":1.5,"q":0.7,"enabled":true}],"compressor":{"enabled":true,"thresholdDb":-20,"ratio":2.5,"attackMs":8,"releaseMs":150,"makeupDb":2},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["女声","角色"]', 20, 0, 0);
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:broadcast', NULL, '广播·有力', '厚实靠前，适合宣传与有力台词', 1, '{"highpass":{"enabled":true,"freq":80,"poles":2},"denoise":{"enabled":true,"nr":12,"nf":-28,"tn":false},"deesser":{"enabled":true,"intensity":0.5,"freq":0.5},"eq":[{"id":"b1","type":"peak","freq":200,"gainDb":-3,"q":1,"enabled":true},{"id":"b2","type":"peak","freq":3000,"gainDb":3,"q":1.2,"enabled":true},{"id":"b3","type":"highshelf","freq":8000,"gainDb":1.5,"q":0.7,"enabled":true}],"compressor":{"enabled":true,"thresholdDb":-16,"ratio":4,"attackMs":5,"releaseMs":150,"makeupDb":3},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["广播","有力"]', 30, 0, 0);
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:phone-rescue', NULL, '手机录音·抢救', '强力降噪 + 大幅补中高频，用于条件差的素材', 1, '{"highpass":{"enabled":true,"freq":120,"poles":2},"denoise":{"enabled":true,"nr":18,"nf":-26,"tn":true},"deesser":{"enabled":true,"intensity":0.7,"freq":0.5},"eq":[{"id":"p1","type":"peak","freq":300,"gainDb":-4,"q":1,"enabled":true},{"id":"p2","type":"peak","freq":2500,"gainDb":3,"q":1.2,"enabled":true}],"compressor":{"enabled":true,"thresholdDb":-15,"ratio":4,"attackMs":5,"releaseMs":120,"makeupDb":3},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["抢救","手机录音"]', 40, 0, 0);
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:asmr', NULL, 'ASMR·贴近', '轻处理，保留气声与细节', 1, '{"highpass":{"enabled":true,"freq":100,"poles":2},"denoise":{"enabled":true,"nr":6,"nf":-36,"tn":false},"deesser":{"enabled":true,"intensity":0.2,"freq":0.5},"eq":[{"id":"a1","type":"peak","freq":5000,"gainDb":2,"q":0.8,"enabled":true}],"compressor":{"enabled":true,"thresholdDb":-22,"ratio":2,"attackMs":15,"releaseMs":250,"makeupDb":1},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["ASMR","轻处理"]', 50, 0, 0);
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:old-tape', NULL, '老录音·去嘶声', '压制高频嘶声与底噪', 1, '{"highpass":{"enabled":true,"freq":150,"poles":2},"denoise":{"enabled":true,"nr":14,"nf":-24,"tn":true},"deesser":{"enabled":true,"intensity":0.8,"freq":0.55},"eq":[{"id":"t1","type":"peak","freq":350,"gainDb":-2,"q":1,"enabled":true},{"id":"t2","type":"peak","freq":7000,"gainDb":-1,"q":1,"enabled":true},{"id":"t3","type":"peak","freq":2000,"gainDb":1.5,"q":1,"enabled":true}],"compressor":{"enabled":true,"thresholdDb":-18,"ratio":3,"attackMs":8,"releaseMs":180,"makeupDb":2},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["修复","去嘶"]', 60, 0, 0);
INSERT OR IGNORE INTO process_presets(id, project_id, name, description, builtin, chain, tags, sort_order, created_at, updated_at) VALUES ('builtin:trim-only', NULL, '仅修剪（不做处理）', '只统一格式与峰值，不改音色', 1, '{"highpass":{"enabled":false,"freq":80,"poles":2},"denoise":{"enabled":false,"nr":12,"nf":-30,"tn":false},"deesser":{"enabled":false,"intensity":0.5,"freq":0.5},"eq":[],"compressor":{"enabled":false,"thresholdDb":-18,"ratio":3,"attackMs":8,"releaseMs":180,"makeupDb":0},"limiter":{"enabled":true,"limitDb":-1,"attackMs":5,"releaseMs":80},"repair":{"dcOffset":false,"polarityInvert":false,"declick":[],"silenceFill":[],"tempo":{"enabled":false,"factor":1}}}', '["无处理"]', 70, 0, 0);

-- ---------------------------------------------------------------------------
-- 4) 默认设置项（docs/04 §8.2）
--
--    · key 为点分路径，value 为 JSON（settings 表约定见 docs/21 §2）
--    · paths.projectRoot / exportDir / cacheDir / backupDir 不在此预置：它们由运行时
--      从 Electron app.getPath() 推导（换机/便携模式都不同），写死会误导用户
--    · is_secret = 1 的项（API Key）绝不预置：没有密钥就是没有，预置空值会让
--      「是否已配置」判断出错（docs/04 §9）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('paths.ffmpegPath', 'null', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('paths.modelDir', 'null', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.sampleRate', '48000', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.bitDepth', '24', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.channels', '1', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.defaultInputDeviceId', 'null', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.monitorEnabled', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.monitorGainDb', '0', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.inputGainDb', '0', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.agcEnabled', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.countdownMs', '3000', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.autoTrim', 'true', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.trimThresholdDb', '-45', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.trimPaddingMs', '100', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('audio.echoCancellation', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.defaultMode', '"line_by_line"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.stopKey', '"Space"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.nextLineKey', '"ArrowDown"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.redoKey', '"Ctrl+R"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.playKey', '"P"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.footPedalEnabled', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.footPedalMapping', '{"F13":"stop_and_next","F14":"redo"}', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.vad', '{"enabled":true,"silenceDb":-45,"minSilenceMs":350,"minSpeechMs":120,"minSliceMs":180,"maxSliceMs":15000,"headRollbackMs":80,"tailKeepMs":200,"autoNoiseFloor":true,"charsPerSecond":4.2}', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('recording.maxSessionMinutes', '240', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.attributionThreshold', '0.62', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.attributionMargin', '0.06', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.contextWindow', '2', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.autoAcceptConfidence', '0.85', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.defaultPauseAfterMs', '500', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.defaultEmotion', '"平静"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.maxLineChars', '120', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.maxNarrationRun', '15', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('canvas.shortLineChars', '6', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.targetLufs', '-16', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.truePeakDb', '-1', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.headSilenceMs', '500', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.tailSilenceMs', '1500', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.defaultMusicGainDb', '-18', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.duckAmountDb', '-12', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.duckAttackMs', '150', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.duckReleaseMs', '400', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.maxCrossTrackOverlapMs', '3000', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('mixing.maxGapMs', '5000', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.format', '"mp3"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.mp3Bitrate', '192', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.m4bBitrate', '96', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.fileNameTemplate', '"{bookTitle}/{chapterIndex:03}_{chapterTitle}"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.chapterTitleTemplate', '"第{index}章 {title}"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.writeMetadata', 'true', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.coverPath', 'null', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('export.splitM4bEvery', '0', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ai.provider', '"mock"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ai.baseUrl', '""', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ai.model', '"mock"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ai.timeoutMs', '60000', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ai.maxConcurrency', '2', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ai.allowSendTextToCloud', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('embedding.modelId', '"bge-small-zh-v1.5"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('embedding.batchSize', '16', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('embedding.threads', '4', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('asr.modelId', '"ggml-base.bin"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('asr.language', '"zh"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('asr.threads', '4', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('asr.translate', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('import.maxFileSizeBytes', '209715200', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('import.maxUrlPages', '50', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('import.fetchDelayMs', '1500', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ui.theme', '"system"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ui.language', '"zh-CN"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('ui.editorDensity', '"normal"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('advanced.logLevel', '"info"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('advanced.autoBackup', '"daily"', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('advanced.keepBackups', '7', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT OR IGNORE INTO settings(key, value, is_secret, updated_at) VALUES ('advanced.autoCleanupTakes', 'false', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- ---------------------------------------------------------------------------
-- 5) 与常量一致的校验常量（供 settings 服务做范围校验；存库便于诊断包对照）
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO meta(key, value) VALUES ('seed.defaults_digest', '{"audioDefaults":{"sampleRate":48000,"captureBitDepth":32,"fileBitDepth":24,"channels":1,"packMs":50,"fsyncIntervalMs":1000,"metaFlushIntervalMs":5000,"mixBatchSize":32},"vadDefaults":{"enabled":true,"silenceDb":-45,"minSilenceMs":350,"minSpeechMs":120,"minSliceMs":180,"maxSliceMs":15000,"headRollbackMs":80,"tailKeepMs":200,"autoNoiseFloor":true,"charsPerSecond":4.2},"canvasDefaults":{"attributionThreshold":0.62,"attributionMargin":0.06,"contextWindow":2,"autoAcceptConfidence":0.85,"defaultPauseAfterMs":500,"defaultEmotion":"平静","maxLineChars":120,"shortLineChars":6,"maxNarrationRun":15,"maxDialogueRun":20},"arrangeDefaults":{"defaultPauseMs":500,"minGapMs":50,"maxCrossTrackOverlapMs":3000,"maxGapMs":5000,"minSegmentMs":200,"maxSegmentMs":60000,"silentRmsDb":-60,"defaultFadeMs":5},"exportDefaults":{"headSilenceMs":500,"tailSilenceMs":1500,"mp3Bitrate":192,"m4bBitrate":96,"mp3SampleRate":44100,"truePeakDb":-1,"fileNameTemplate":"{bookTitle}/{chapterIndex:03}_{chapterTitle}","chapterTitleTemplate":"第{index}章 {title}","m4bChapterWarnThreshold":200,"m4bMaxHours":24},"importLimits":{"maxFileSizeBytes":209715200,"maxUrlPages":50,"fetchDelayMs":1500,"maxUrlPageBytes":5242880,"maxRedirects":5},"recordLimits":{"minTakeMs":150,"warnTakeMs":60000,"requiredFreeBytes":524288000,"defaultMaxSessionMinutes":240}}');
