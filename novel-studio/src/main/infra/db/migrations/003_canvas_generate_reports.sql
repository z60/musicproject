-- ============================================================================
-- Novel Studio · 迁移 003 · 画本生成报告表
-- ============================================================================
-- 设计依据：
--   · docs/11 §2.4「生成报告」：生成完一章后要能回答「这一章是怎么切出来的」
--     —— 用了多少行、各类行多少、判定结果分布、低置信多少行、**有没有真的用上向量**
--     （模型缺失时必须显著告知用户，docs/06 §8）、耗时、告警。
--   · docs/20 §4.3：契约里有 `canvas:getGenerateReport`，但**没有规定存哪** ——
--     这就是本迁移存在的理由（此前该通道只能返回占位错误，见 docs/91 §5.2.9）。
--
-- 为什么**一章一行**（PRIMARY KEY = chapter_id）：
--   契约的签名是 `{ chapterId } → CanvasGenerateReport | null`，没有 id / 没有历史。
--   生成会替换整章画本行，UI 要看的是「**本次**生成的结果」，所以按章 upsert 即可。
--   要留历史的话应该走画本快照（`canvas_snapshots`，那里已经有 payload 与 reason），
--   而不是在这张表里堆副本。
--
-- 为什么既存 `payload` 又存几个标量列：
--   `payload` 是**完整报告**（含 byKind / bySpeaker / byDecision 这些嵌套结构），
--   读取路径**只用它**重建 DTO —— 保证只有一份真相。
--   标量列是同一条 INSERT 里一起写入的**冗余索引**，用于「统计/排查」类 SQL
--   （例如「哪些章其实没跑向量判定」），不参与 DTO 重建，因此不会与 payload 分叉。
--
-- 注意：本文件是**已发布迁移的追加**，不要修改 001/002（它们的 hash 被钉住，
--       改动会导致启动时 DB_MIGRATION_FAILED）。
-- ============================================================================

CREATE TABLE IF NOT EXISTS canvas_generate_reports (
  chapter_id     TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  total_lines    INTEGER NOT NULL DEFAULT 0,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  -- 0/1 而不是布尔：与 001 里 needs_review / is_title 的写法保持一致
  embedding_used INTEGER NOT NULL DEFAULT 0,
  llm_used       INTEGER NOT NULL DEFAULT 0,
  elapsed_ms     INTEGER NOT NULL DEFAULT 0,
  -- CanvasGenerateReport 的 JSON（**读取的唯一天真来源**）
  payload        TEXT    NOT NULL,
  generated_at   INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 按时间查「最近生成过什么」（排查「昨天还好好的」这类问题时最先用上）
CREATE INDEX IF NOT EXISTS idx_generate_reports_time ON canvas_generate_reports(generated_at DESC);
