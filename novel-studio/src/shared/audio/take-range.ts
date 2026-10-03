/**
 * Novel Studio · take 在**源文件内**的播放区间（纯逻辑）
 * ============================================================================
 * 为什么需要它（真机反馈：「CV 音导入后无法播放」）：
 *
 * 「按说话人导入音频」不会为每行写一个 WAV —— 它把整段源音频转成一个文件
 * （`imports/<ts>-<原名>.wav`），每行只记**区间**：`srcInMs ~ srcOutMs`。
 * 也就是说，一条导入的 take 的音频在文件的第 739.98 秒，而不是第 0 秒。
 *
 * 而播放侧原来一律从 0 播（`<audio src=整段文件>`），听到的是文件开头（多半是别的章节），
 * 波形也画整段。用户看到的就是「导入的音频放不出来 / 放的是别的」。
 *
 * 口径（**两个来源相加**，不要只取一个）：
 *   · `srcInMs`     —— 该 take 在**源文件**里的起点（连续录制切片、导入切片都有它）
 *   · `trimmedInMs` —— 在**这个 take 内部**再裁掉的头部（试录修剪）
 *
 *   播放起点 = `srcInMs + trimmedInMs`
 *   播放终点 = `srcInMs + trimmedOutMs`（没有修剪值时依次退回 `durationMs`、`srcOutMs`）
 *
 * 老数据（本地录制的 take）`srcInMs = 0`、只有 `trimmedInMs` —— 公式退化成原来的行为，
 * 所以这里改的是「导入的 take」，不会动已录好的音频。
 */

export interface TakeRangeLike {
  /** 源文件内起点（毫秒） */
  srcInMs?: number | null
  /** 源文件内终点（毫秒） */
  srcOutMs?: number | null
  /** take 内部的修剪入点（毫秒） */
  trimmedInMs?: number | null
  /** take 内部的修剪出点（相对 take 起点，毫秒） */
  trimmedOutMs?: number | null
  /** take 时长（毫秒） */
  durationMs?: number | null
}

export interface TakeRange {
  /** 源文件内的播放起点（毫秒） */
  startMs: number
  /** 源文件内的播放终点（毫秒，**不含**） */
  endMs: number
}

function asMs(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * 一条 take 在源文件里的可播放区间。
 *
 * 返回值保证 `endMs > startMs`（至少 1 ms）：调用方直接拿它做 `currentTime` 与
 * 「播到这里停」都不会拿到空区间，省掉每处再补一次边界判断。
 */
export function takeSourceRange(take: TakeRangeLike): TakeRange {
  const srcIn = asMs(take.srcInMs)
  const startMs = srcIn + asMs(take.trimmedInMs)

  const trimmedOut = asMs(take.trimmedOutMs)
  if (trimmedOut > 0) return { startMs, endMs: Math.max(startMs + 1, srcIn + trimmedOut) }

  // `durationMs` 是**这条 take 自己的时长**（从播放起点算起），不是源内坐标
  const duration = asMs(take.durationMs)
  if (duration > 0) return { startMs, endMs: startMs + Math.max(1, duration) }

  // `srcOutMs` 本身就是**源文件内**的坐标，不能再加 srcIn
  const srcOut = asMs(take.srcOutMs)
  if (srcOut > startMs) return { startMs, endMs: srcOut }

  return { startMs, endMs: startMs + 1 }
}

/** 区间时长（毫秒），至少 1 ms */
export function takeRangeDuration(take: TakeRangeLike): number {
  const range = takeSourceRange(take)
  return Math.max(1, range.endMs - range.startMs)
}

/** 把「源文件内毫秒」换算成 `HTMLMediaElement.currentTime` 用的秒（钳到区间内） */
export function sourceMsToSeconds(take: TakeRangeLike, ms: number): number {
  const range = takeSourceRange(take)
  const clamped = Math.min(Math.max(ms, range.startMs), Math.max(range.startMs, range.endMs - 1))
  return clamped / 1000
}
