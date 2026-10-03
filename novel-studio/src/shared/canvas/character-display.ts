/**
 * Novel Studio · 角色/说话人显示名（纯逻辑）
 * ============================================================================
 * 说话人列的口径：**有 CV 显示 CV，没有 CV 显示角色名**（配音员要一眼看到「谁来念」）。
 * CV 的两处来源：绑定的主配音员（由 store 查绑定表）+ 角色备注里的 `CV：xxx`。
 * 后者是画本导入写进去的（`Character` 没有独立 CV 列，见 canvas-import.service
 * 的 `buildScriptCharacterNote`），格式：`CV：嬉小天｜音色：青叔音｜年龄：25`。
 */

/** 从角色备注里取 CV 名；没有或为空返回 null */
export function parseCvFromNote(note: string | null | undefined): string | null {
  if (!note) return null
  // CV 必须是独立的一段（行首，或紧跟分隔符），避免误匹配「建议CV老师…」这类正文
  const matched = /(?:^|[｜|;；\n])\s*CV\s*[:：]\s*([^｜|;；\n]+)/.exec(note)
  const cv = matched?.[1]?.trim()
  return cv && cv.length > 0 ? cv : null
}

/**
 * CV 名归一化：比较「是不是同一个配音员」时用。
 * 空白（含全角空格）与 ASCII 大小写差异不该造出第二个配音员 ——
 * 画本表格里 `阿翼爱热闹` 与 `阿翼爱热闹 ` 是同一人。
 */
export function normalizeCvName(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+/g, '').toLowerCase()
}

/**
 * 占位 CV：画本表里常写「未知 / 待定 / —」，把它们建成配音员只会在 CV 表里加噪声。
 * 注意判空也在这里（空字符串一样不可用）。
 */
const PLACEHOLDER_CV_NAMES = new Set([
  '未知', '未知角色', '未知cv', '未知名', '未定', '待定', '待确认', '无', '暂无',
  '—', '-', '--', '/', '?', '？', 'n/a', 'na', 'tbd', 'null', 'undefined',
])

export function isPlaceholderCvName(name: string | null | undefined): boolean {
  const key = normalizeCvName(name)
  return key.length === 0 || PLACEHOLDER_CV_NAMES.has(key)
}

/** 说话人显示名：有 CV 用 CV，否则用角色名 */
export function speakerDisplayName(characterName: string, cvName: string | null | undefined): string {
  return cvName && cvName.length > 0 ? cvName : characterName
}
