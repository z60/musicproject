-- ============================================================================
-- Novel Studio · 001_init.sql
-- ============================================================================
-- 唯一来源：docs/21-数据字典与SQL.md §2 ~ §11（完整抄录，含全部表、索引、视图）
-- 设计理由见 docs/03-数据模型与存储.md
--
-- 约定（docs/21 §1）：
--   · 主键 TEXT（UUID v4）：跨项目包迁移时保留 ID（任务包回传依赖它）
--   · 时间 INTEGER（Unix 毫秒）：时区无关、排序快、JS 直接可用
--   · 布尔 INTEGER 0/1；JSON TEXT；路径 TEXT 且**相对项目目录**
--   · 枚举 TEXT + CHECK；外键显式声明（PRAGMA foreign_keys=ON 由 pragma.ts 负责）
--   · 软删除 deleted_at INTEGER NULL；行版本 rev INTEGER NOT NULL DEFAULT 1
--   · 所有 CREATE 带 IF NOT EXISTS，便于重复执行不报错（幂等）
--
-- 迁移纪律（docs/21 §13）：本文件**发布后不可修改**（migrate.ts 校验 sha256）。
-- 需要变更请新增 003_*.sql。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §2 元信息与设置
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 预置：schema_version / app_version / created_at / last_backup_at / last_integrity_check_at

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,          -- 'audio.sampleRate', 'canvas.attributionThreshold' ...
  value      TEXT NOT NULL,             -- JSON 序列化值
  is_secret  INTEGER NOT NULL DEFAULT 0,-- 1 = value 是 safeStorage 加密后的 base64
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settings_secret ON settings(is_secret);

CREATE TABLE IF NOT EXISTS metrics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,             -- 'canvas.generate' / 'audio.render' / 'record.dropped_frames'
  value      REAL NOT NULL,
  unit       TEXT,                      -- 'ms','count','lufs','ratio'
  project_id TEXT,
  context    TEXT,                      -- JSON 附加维度
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON metrics(name, created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_created ON metrics(created_at);

-- ---------------------------------------------------------------------------
-- §3 项目与书籍
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  root_dir       TEXT NOT NULL,          -- 绝对路径（唯一允许存绝对路径的地方）
  schema_version INTEGER NOT NULL,
  settings       TEXT,                   -- JSON：项目级覆盖设置
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);

CREATE TABLE IF NOT EXISTS books (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  author         TEXT,
  narrator       TEXT DEFAULT '',        -- 默认朗读/旁白配音员名（导出元数据用）
  language       TEXT NOT NULL DEFAULT 'zh-CN',
  source_type    TEXT NOT NULL CHECK (source_type IN ('txt','docx','pdf','paste','url')),
  source_path    TEXT,                   -- 源文件路径或 URL
  source_pages   TEXT,                   -- JSON：URL 抓取的页面列表
  encoding       TEXT,                   -- 检测到的编码
  content_hash   TEXT NOT NULL,          -- SHA-256（清洗后全文），用于去重
  char_count     INTEGER NOT NULL DEFAULT 0,
  chapter_count  INTEGER NOT NULL DEFAULT 0,
  cover_path     TEXT,                   -- 相对路径（导出封面）
  metadata       TEXT,                   -- JSON：其它元数据（ISBN、简介等）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_books_project ON books(project_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_books_hash ON books(content_hash);

CREATE TABLE IF NOT EXISTS chapters (
  id                 TEXT PRIMARY KEY,
  book_id            TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,         -- 全书顺序（1 起，允许非连续）
  title              TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'chapter'
                     CHECK (kind IN ('chapter','front','back','extra','volume')),
  volume_seq         INTEGER,                  -- 所属卷序号（kind='volume' 时为自身）
  volume_title       TEXT,
  raw_text           TEXT NOT NULL,            -- 清洗后文本
  source_text        TEXT,                     -- 清洗前原文（用于「查看被删内容」）
  char_count         INTEGER NOT NULL DEFAULT 0,
  start_offset       INTEGER NOT NULL DEFAULT 0,   -- 在全书中的字符偏移
  end_offset         INTEGER NOT NULL DEFAULT 0,
  clean_report       TEXT,                     -- JSON：CleanReport
  canvas_state       TEXT NOT NULL DEFAULT 'none'
                     CHECK (canvas_state IN ('none','generated','edited','done')),
  line_count         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chapters_book_seq ON chapters(book_id, seq);
CREATE INDEX IF NOT EXISTS idx_chapters_state ON chapters(book_id, canvas_state);

CREATE TABLE IF NOT EXISTS chapter_rule_sets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = 全局
  name        TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0,
  definition  TEXT NOT NULL,            -- JSON：ChapterRuleSet
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rulesets_project ON chapter_rule_sets(project_id);

-- ---------------------------------------------------------------------------
-- §4 角色与配音员
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS characters (
  id               TEXT PRIMARY KEY,
  book_id          TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  aliases          TEXT,                    -- JSON 数组：["炎帝","小炎子"]
  gender           TEXT CHECK (gender IN ('male','female','other','unknown')),
  age_group        TEXT CHECK (age_group IN ('child','teen','young','middle','elder','unknown')),
  description      TEXT,                    -- 性格描述（参与原型向量构造）
  note             TEXT,
  color            TEXT,                    -- UI 配色（#RRGGBB）
  default_speed    TEXT CHECK (default_speed IN ('slow','normal','fast')),
  default_emotion  TEXT,
  default_gain_db  REAL,
  default_pause_ms INTEGER,
  is_archived      INTEGER NOT NULL DEFAULT 0,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_book ON characters(book_id, is_archived);

CREATE TABLE IF NOT EXISTS character_aliases (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  UNIQUE (character_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_alias_text ON character_aliases(alias);

CREATE TABLE IF NOT EXISTS voice_actors (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  contact     TEXT,
  note        TEXT,
  profile     TEXT,                         -- JSON：VoiceProfile（样本路径、性别、音域、语速）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_actors_project ON voice_actors(project_id);

CREATE TABLE IF NOT EXISTS character_voice_bindings (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  actor_id     TEXT NOT NULL REFERENCES voice_actors(id) ON DELETE CASCADE,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  UNIQUE (character_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_binding_actor ON character_voice_bindings(actor_id);

-- 角色原型向量：支持增量更新（sum_vector + sample_count）与快照（centroid）
CREATE TABLE IF NOT EXISTS character_centroids (
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  sum_vector    BLOB NOT NULL,        -- 未归一化的 Σ(归一化行向量)，Float32
  sample_count  INTEGER NOT NULL DEFAULT 0,
  centroid      BLOB NOT NULL,        -- 归一化后的 sum/count，Float32
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (character_id, model_id)
);

-- ---------------------------------------------------------------------------
-- §5 画本
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS canvas_lines (
  id                 TEXT PRIMARY KEY,
  chapter_id         TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  book_id            TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,  -- 冗余，避免 join
  seq                INTEGER NOT NULL,
  speaker_type       TEXT NOT NULL DEFAULT 'narration'
                     CHECK (speaker_type IN ('narration','character')),
  character_id       TEXT REFERENCES characters(id) ON DELETE SET NULL,
  kind               TEXT NOT NULL DEFAULT 'narration'
                     CHECK (kind IN ('dialogue','narration','inner','sfx_note')),
  text               TEXT NOT NULL,
  source_text        TEXT,
  char_start         INTEGER NOT NULL DEFAULT 0,
  char_end           INTEGER NOT NULL DEFAULT 0,
  emotion            TEXT,
  emotion_intensity  INTEGER CHECK (emotion_intensity BETWEEN 1 AND 5),
  speed              TEXT CHECK (speed IN ('slow','normal','fast')),
  gain_db            REAL,
  pause_after_ms     INTEGER NOT NULL DEFAULT 500,
  pause_inline       TEXT,                    -- JSON 数组：句内停顿的字符索引
  pronunciation      TEXT,
  note               TEXT,
  state              TEXT NOT NULL DEFAULT 'draft'
                     CHECK (state IN ('draft','assigned','recorded','aligned')),
  confidence         REAL,
  candidates         TEXT,                    -- JSON：[{characterId, score}]
  decided_by         TEXT CHECK (decided_by IN ('rule','vector','llm','human')),
  needs_review       INTEGER NOT NULL DEFAULT 0,
  flags              TEXT,                    -- JSON 数组
  is_title           INTEGER NOT NULL DEFAULT 0,   -- 章首标题念白行
  deleted_at         INTEGER,
  rev                INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_chapter_seq ON canvas_lines(chapter_id, seq);
CREATE INDEX IF NOT EXISTS idx_lines_character ON canvas_lines(character_id, state);
CREATE INDEX IF NOT EXISTS idx_lines_review ON canvas_lines(chapter_id, needs_review);
CREATE INDEX IF NOT EXISTS idx_lines_state ON canvas_lines(chapter_id, state);
CREATE INDEX IF NOT EXISTS idx_lines_book_char ON canvas_lines(book_id, character_id);

CREATE TABLE IF NOT EXISTS line_embeddings (
  line_id       TEXT PRIMARY KEY REFERENCES canvas_lines(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vector        BLOB NOT NULL,          -- L2 归一化后的 Float32Array
  content_hash  TEXT NOT NULL,          -- sha256(modelId + '|' + 判定文本)
  context_scope INTEGER NOT NULL DEFAULT 2,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_model ON line_embeddings(model_id);
CREATE INDEX IF NOT EXISTS idx_emb_hash ON line_embeddings(content_hash);

CREATE TABLE IF NOT EXISTS canvas_snapshots (
  id          TEXT PRIMARY KEY,
  chapter_id  TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  label       TEXT,
  reason      TEXT,                     -- 'pre_generate' | 'manual' | 'pre_restore'
  line_count  INTEGER NOT NULL,
  payload     BLOB NOT NULL,            -- JSON 序列化的全部行（gzip 后）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_chapter ON canvas_snapshots(chapter_id, created_at);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key   TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  response    TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_created ON ai_cache(created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  purpose           TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL,
  accepted          INTEGER,             -- 人工是否采纳（回填）
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_project ON ai_usage(project_id, created_at);

-- ---------------------------------------------------------------------------
-- §6 录音与片段
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recording_sessions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id     TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('line_by_line','continuous','role','punch_in','package')),
  actor_id       TEXT REFERENCES voice_actors(id) ON DELETE SET NULL,
  file_path      TEXT NOT NULL,          -- 相对：recordings/{id}.wav
  sample_rate    INTEGER NOT NULL,
  bit_depth      INTEGER NOT NULL,
  channels       INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  peak_db        REAL,
  rms_db         REAL,
  gain_db        REAL NOT NULL DEFAULT 0,
  device_label   TEXT,
  device_id      TEXT,
  dropped_frames INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','finalized','aborted','recovered','failed')),
  marks          TEXT,                   -- JSON：录制中打的标记 [{kind,atMs}]
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_chapter ON recording_sessions(chapter_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON recording_sessions(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON recording_sessions(status);

CREATE TABLE IF NOT EXISTS takes (
  id             TEXT PRIMARY KEY,
  line_id        TEXT NOT NULL REFERENCES canvas_lines(id) ON DELETE CASCADE,
  session_id     TEXT REFERENCES recording_sessions(id) ON DELETE SET NULL,
  file_path      TEXT NOT NULL,          -- 相对：takes/{lineId}/{takeId}.wav
  part_index     INTEGER NOT NULL DEFAULT 0,   -- 超长行分段录时的顺序
  src_in_ms      INTEGER NOT NULL DEFAULT 0,   -- 在会话文件中的区间
  src_out_ms     INTEGER NOT NULL,
  trimmed_in_ms  INTEGER NOT NULL DEFAULT 0,   -- 修剪后区间（相对 take 文件）
  trimmed_out_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL,
  peak_db        REAL,
  rms_db         REAL,
  lufs           REAL,
  gain_db        REAL NOT NULL DEFAULT 0,
  sample_rate    INTEGER NOT NULL,
  bit_depth      INTEGER NOT NULL,
  channels       INTEGER NOT NULL,
  source         TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','package','import')),
  package_id     TEXT,
  flags          TEXT,                   -- JSON：['clip','too_short','noise','reported']
  is_selected    INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  recorded_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_takes_line ON takes(line_id, part_index, recorded_at);
CREATE INDEX IF NOT EXISTS idx_takes_session ON takes(session_id);
CREATE INDEX IF NOT EXISTS idx_takes_selected ON takes(line_id, is_selected);

-- 成品片段：一行画本对应一个（唯一约束由 UNIQUE(line_id) 保证）
CREATE TABLE IF NOT EXISTS voice_segments (
  id              TEXT PRIMARY KEY,
  line_id         TEXT NOT NULL UNIQUE REFERENCES canvas_lines(id) ON DELETE CASCADE,
  chapter_id      TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  take_id         TEXT REFERENCES takes(id) ON DELETE SET NULL,
  file_path       TEXT NOT NULL,         -- 相对：segments/{id}.wav
  processed_path  TEXT,                  -- 相对：processed/{id}.{presetHash}.wav
  preset_hash     TEXT,
  src_in_ms       INTEGER NOT NULL DEFAULT 0,
  src_out_ms      INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  peak_db         REAL,
  rms_db          REAL,
  lufs            REAL,
  flags           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_chapter ON voice_segments(chapter_id);
CREATE INDEX IF NOT EXISTS idx_segments_take ON voice_segments(take_id);

CREATE TABLE IF NOT EXISTS audio_metrics (
  file_path     TEXT PRIMARY KEY,        -- 相对路径
  file_size     INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  peak_db       REAL,
  true_peak_db  REAL,
  rms_db        REAL,
  lufs          REAL,
  lra           REAL,
  sample_rate   INTEGER,
  channels      INTEGER,
  measured_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vad_slices (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  slice_index  INTEGER NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  rms_db       REAL,
  peak_db      REAL,
  matched_line TEXT REFERENCES canvas_lines(id) ON DELETE SET NULL,
  match_score  REAL,
  accepted     INTEGER NOT NULL DEFAULT 0,
  flags        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slices_session ON vad_slices(session_id, slice_index);

-- ---------------------------------------------------------------------------
-- §7 对轨
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS arrangements (
  id                TEXT PRIMARY KEY,
  chapter_id        TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  is_default        INTEGER NOT NULL DEFAULT 0,
  strategy          TEXT NOT NULL DEFAULT 'serialize'
                    CHECK (strategy IN ('serialize','keep','compress-pause','tighten')),
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,   -- 每次整体重排 +1（供导出 paramsHash）
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arrangements_chapter ON arrangements(chapter_id, is_default);

CREATE TABLE IF NOT EXISTS arrangement_items (
  id                TEXT PRIMARY KEY,
  arrangement_id    TEXT NOT NULL REFERENCES arrangements(id) ON DELETE CASCADE,
  segment_id        TEXT NOT NULL REFERENCES voice_segments(id) ON DELETE CASCADE,
  line_id           TEXT NOT NULL REFERENCES canvas_lines(id) ON DELETE CASCADE,
  track_id          TEXT NOT NULL,          -- 'narration' 或 characterId
  timeline_start_ms INTEGER NOT NULL,
  src_in_ms         INTEGER NOT NULL DEFAULT 0,
  src_out_ms        INTEGER NOT NULL,
  fade_in_ms        INTEGER NOT NULL DEFAULT 5,
  fade_out_ms       INTEGER NOT NULL DEFAULT 5,
  locked            INTEGER NOT NULL DEFAULT 0,
  order_in_track    INTEGER NOT NULL DEFAULT 0,
  overlap_with      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_arrangement ON arrangement_items(arrangement_id, timeline_start_ms);
CREATE INDEX IF NOT EXISTS idx_items_track ON arrangement_items(arrangement_id, track_id, order_in_track);
CREATE INDEX IF NOT EXISTS idx_items_line ON arrangement_items(line_id);
CREATE INDEX IF NOT EXISTS idx_items_segment ON arrangement_items(segment_id);

CREATE TABLE IF NOT EXISTS asr_results (
  id           TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL CHECK (target_type IN ('segment','take','session')),
  target_id    TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  language     TEXT,
  transcript   TEXT,
  words        TEXT,                    -- JSON：词级时间戳
  overall_score REAL,
  verdict      TEXT CHECK (verdict IN ('ok','partial','mismatch')),
  audio_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asr_target ON asr_results(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_asr_hash ON asr_results(audio_hash);

-- ---------------------------------------------------------------------------
-- §8 处理预设与素材
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS process_presets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 全局（内置）
  name        TEXT NOT NULL,
  description TEXT,
  builtin     INTEGER NOT NULL DEFAULT 0,
  chain       TEXT NOT NULL,           -- JSON：ProcessChain
  tags        TEXT,                    -- JSON 数组
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presets_project ON process_presets(project_id, builtin);

CREATE TABLE IF NOT EXISTS music_assets (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('bgm','sfx')),
  name         TEXT NOT NULL,
  file_path    TEXT NOT NULL,           -- 相对：music/{kind}/{id}.{ext}
  original_name TEXT,
  duration_ms  INTEGER,
  sample_rate  INTEGER,
  channels     INTEGER,
  peak_db      REAL,
  lufs         REAL,
  loopable     INTEGER NOT NULL DEFAULT 0,
  tags         TEXT,
  note         TEXT,
  license_note TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_music_project ON music_assets(project_id, kind);

-- ---------------------------------------------------------------------------
-- §9 混音与导出
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mix_projects (
  id             TEXT PRIMARY KEY,
  chapter_id     TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  arrangement_id TEXT NOT NULL REFERENCES arrangements(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0,
  tracks         TEXT NOT NULL,          -- JSON：MixTrack[]
  master         TEXT NOT NULL,          -- JSON：master 配置
  head_silence_ms INTEGER NOT NULL DEFAULT 500,
  tail_silence_ms INTEGER NOT NULL DEFAULT 1500,
  title_reading  TEXT,                   -- JSON
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mix_chapter ON mix_projects(chapter_id, is_default);

-- 轨道级独立表（便于查询与统计；tracks JSON 保留为快照）
CREATE TABLE IF NOT EXISTS mix_tracks (
  id            TEXT PRIMARY KEY,
  mix_project_id TEXT NOT NULL REFERENCES mix_projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('voice','music','sfx')),
  ref_id        TEXT,                    -- characterId 或 musicAssetId
  name          TEXT NOT NULL,
  gain_db       REAL NOT NULL DEFAULT 0,
  pan           REAL NOT NULL DEFAULT 0,
  is_mute       INTEGER NOT NULL DEFAULT 0,
  is_solo       INTEGER NOT NULL DEFAULT 0,
  preset_id     TEXT REFERENCES process_presets(id) ON DELETE SET NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  music_config  TEXT,                    -- JSON：入出点/循环/淡入淡出/ducking
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mix_tracks_project ON mix_tracks(mix_project_id, sort_order);

CREATE TABLE IF NOT EXISTS export_jobs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  book_id           TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id        TEXT REFERENCES chapters(id) ON DELETE CASCADE,   -- NULL = 整本任务
  mix_project_id    TEXT REFERENCES mix_projects(id) ON DELETE SET NULL,
  arrangement_id    TEXT REFERENCES arrangements(id) ON DELETE SET NULL,
  params            TEXT NOT NULL,          -- JSON：导出参数
  params_hash       TEXT NOT NULL,          -- 幂等与断点续传依据
  output_path       TEXT,
  output_size       INTEGER,
  measured_lufs     REAL,
  measured_tp_db    REAL,
  adjusted_gain_db  REAL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','succeeded','failed','skipped','interrupted')),
  error             TEXT,                   -- JSON：IpcError
  warnings          TEXT,                   -- JSON 数组
  started_at        INTEGER,
  finished_at       INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_book ON export_jobs(book_id, status);
CREATE INDEX IF NOT EXISTS idx_export_jobs_hash ON export_jobs(chapter_id, params_hash, status);
CREATE INDEX IF NOT EXISTS idx_export_jobs_task ON export_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS export_reports (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  book_id     TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  report      TEXT NOT NULL,          -- JSON：ExportReport 全文
  file_path   TEXT,                   -- 相对：exports/report-{id}.json
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_book ON export_reports(book_id, created_at);

-- ---------------------------------------------------------------------------
-- §10 任务、包、日志
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                  ('queued','waiting','running','succeeded','failed','cancelled','interrupted')),
  priority        INTEGER NOT NULL DEFAULT 50,
  project_id      TEXT,
  payload         TEXT NOT NULL,        -- JSON
  progress        REAL NOT NULL DEFAULT 0,
  stage           TEXT,
  result          TEXT,                 -- JSON
  error           TEXT,                 -- JSON：IpcError
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 1,
  concurrency_key TEXT,
  dedupe_key      TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued','waiting','running');

CREATE TABLE IF NOT EXISTS packages (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('nsp','nst')),
  direction     TEXT NOT NULL CHECK (direction IN ('export','import','merge')),
  actor_id      TEXT REFERENCES voice_actors(id) ON DELETE SET NULL,
  book_id       TEXT REFERENCES books(id) ON DELETE SET NULL,
  file_path     TEXT NOT NULL,
  lines_hash    TEXT,                   -- .nst 的画本快照哈希（回收时比对）
  manifest      TEXT,                   -- JSON
  stats         TEXT,                   -- JSON：行数/文件数/体积
  status        TEXT NOT NULL DEFAULT 'done'
                CHECK (status IN ('pending','running','done','failed')),
  report        TEXT,                   -- JSON：回收报告
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_packages_project ON packages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_packages_actor ON packages(actor_id, direction);

CREATE TABLE IF NOT EXISTS backups (
  id             TEXT PRIMARY KEY,
  file_path      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  reason         TEXT NOT NULL,        -- 'auto' | 'manual' | 'pre_migrate' | 'pre_restore'
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at);

CREATE TABLE IF NOT EXISTS app_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('error','warn','info','debug','trace')),
  event      TEXT NOT NULL,
  data       TEXT,                     -- JSON（已脱敏）
  project_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON app_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_level ON app_logs(level, ts);

-- ---------------------------------------------------------------------------
-- §11 视图（简化查询）
-- ---------------------------------------------------------------------------

-- 章节进度概览：行数、已录、待确认、时长
CREATE VIEW IF NOT EXISTS v_chapter_progress AS
SELECT
  c.id                AS chapter_id,
  c.book_id           AS book_id,
  c.seq               AS seq,
  c.title             AS title,
  COUNT(l.id)         AS line_count,
  SUM(CASE WHEN l.state IN ('recorded','aligned') THEN 1 ELSE 0 END) AS recorded_count,
  SUM(CASE WHEN l.needs_review = 1 THEN 1 ELSE 0 END)                AS review_count,
  SUM(CASE WHEN l.speaker_type = 'character' AND l.character_id IS NULL THEN 1 ELSE 0 END) AS unassigned_count,
  COALESCE(SUM(s.duration_ms), 0)                                    AS audio_ms,
  SUM(l.char_count)                                                  AS char_count
FROM chapters c
LEFT JOIN canvas_lines l ON l.chapter_id = c.id AND l.deleted_at IS NULL
LEFT JOIN voice_segments s ON s.line_id = l.id
WHERE c.deleted_at IS NULL
GROUP BY c.id;

-- 配音员工作量
CREATE VIEW IF NOT EXISTS v_actor_workload AS
SELECT
  b.id       AS book_id,
  va.id      AS actor_id,
  va.name    AS actor_name,
  COUNT(l.id) AS line_count,
  SUM(LENGTH(l.text)) AS char_count,
  SUM(CASE WHEN l.state IN ('recorded','aligned') THEN 1 ELSE 0 END) AS recorded_count
FROM voice_actors va
JOIN character_voice_bindings cb ON cb.actor_id = va.id
JOIN characters ch ON ch.id = cb.character_id
JOIN canvas_lines l ON l.character_id = ch.id AND l.deleted_at IS NULL
JOIN chapters c ON c.id = l.chapter_id
JOIN books b ON b.id = c.book_id
GROUP BY b.id, va.id;

-- 缺录行（对轨与导出预检用）
CREATE VIEW IF NOT EXISTS v_missing_lines AS
SELECT l.id AS line_id, l.chapter_id, l.seq, l.text, l.speaker_type, l.character_id
FROM canvas_lines l
LEFT JOIN voice_segments s ON s.line_id = l.id
WHERE s.id IS NULL AND l.deleted_at IS NULL;

-- 孤儿片段（无对应画本行）
CREATE VIEW IF NOT EXISTS v_orphan_segments AS
SELECT s.id AS segment_id, s.chapter_id, s.file_path
FROM voice_segments s
LEFT JOIN canvas_lines l ON l.id = s.line_id
WHERE l.id IS NULL;

-- 响度异常章节（导出质检用）
CREATE VIEW IF NOT EXISTS v_loudness_outliers AS
SELECT book_id, chapter_id, measured_lufs, measured_tp_db,
       ABS(measured_lufs - CAST(json_extract(params, '$.targetLufs') AS REAL)) AS lufs_delta
FROM export_jobs
WHERE status = 'succeeded' AND measured_lufs IS NOT NULL
  AND ABS(measured_lufs - CAST(json_extract(params, '$.targetLufs') AS REAL)) > 1.0;
