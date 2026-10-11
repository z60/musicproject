/**
 * Novel Studio · 静音区间（ffmpeg `silencedetect` 的解析 + 边界吸附）
 * ============================================================================
 * 真机需求（第三次复报同一行）：「【石志坚笑了…】音频的最后还是有下一段的杂音【众】，
 * 我需要**治本**的方法」。
 *
 * 前面几轮把「段 ↔ 行」「夹层切点」「右界不切进下一个字」都做了，仍然会漏一点：
 * **whisper 的字级时间戳本身有几十~几百毫秒的误差**（它还随线程数/模型而变）。
 * 只靠识别结果去定边界，就总有「下一句第一个字的起音被切进上一行」的可能。
 *
 * 真正不会错的是**音频里有没有声音**：两句话之间如果有一段静音，边界就该落在静音里。
 * 所以这里引入第三条（也是最硬的一条）判据：
 *
 *   ffmpeg `silencedetect` 量出「哪里是静音」 → 把边界**吸附**到静音区间内。
 *
 * 吸附是**受限**的：只允许在
 * `[上一行自己认出来的话结束, 下一行自己认出来的话开始]` 这个窗口里移动。
 * 于是它天然安全 ——
 *   · 不会切掉上一行**认出来的**话（窗口左界就是它的结束）；
 *   · 不会把下一行**认出来的**话留在上一行（窗口右界就是它的开始）；
 *   · 落在静音里就说明那段本来没声音，也就不会丢掉任何「没被认出来但确实在说」的字。
 *
 * 本目录禁止引入任何第三方依赖。
 */

/** 一段静音（毫秒，含头不含尾的约定与音频区间一致） */
export interface AudioSilence {
  startMs: number
  endMs: number
}

/**
 * 解析 ffmpeg `silencedetect` 写到 stderr 的区间。
 *
 * 输出形如（时间单位是**秒**）：
 * ```
 * [silencedetect @ ...] silence_start: 3.52
 * [silencedetect @ ...] silence_end: 3.86 | silence_duration: 0.34
 * ```
 *
 * 三种边界情况都当正常处理（不抛错）：
 *   · 文件开头就是静音 → 只有 `silence_end`（起点按 0 算）；
 *   · 文件结尾是静音 → 只有 `silence_start`（终点用 `fallbackEndMs`，没给就丢掉）；
 *   · 一整段里没有静音 → 返回空数组。
 */
export function parseSilencedetect(raw: string, fallbackEndMs?: number): AudioSilence[] {
  const out: AudioSilence[] = []
  let open: number | null = null
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[0-9.]+)/.exec(line)
    if (start) {
      const ms = Math.max(0, Math.round(Number(start[1]) * 1000))
      open = Number.isFinite(ms) ? ms : null
      continue
    }
    const end = /silence_end:\s*(-?[0-9.]+)/.exec(line)
    if (end) {
      const endMs = Math.max(0, Math.round(Number(end[1]) * 1000))
      const startMs = open ?? 0
      if (endMs > startMs) out.push({ startMs, endMs })
      open = null
    }
  }
  if (open !== null && fallbackEndMs !== undefined && fallbackEndMs > open) {
    out.push({ startMs: open, endMs: Math.round(fallbackEndMs) })
  }
  return out
}

/**
 * 离 `atMs` 最近的**够长**的静音区间的中心。
 *
 * 这是「token 窗口里没有静音」时的退路 —— 真机实测就是这么救回来的：
 * 识别（small）把「看向众人」之后那个 739ms 的停顿报在了 36400~37140，
 * 却把边界定在 36000（正好切在上一行自己的「众」上，用户：「在【众人】的众就断了」）。
 * token 的归属可能错，但**音频里的停顿不会撒谎**：句子边界就在那个静音里。
 *
 * @param maxDistanceMs 静音区间到 `atMs` 的距离上限（超过就不动，宁可保持原样）
 * @param minLengthMs   太短的静音不算（默认 200ms）
 */
export function nearestSilenceCenter(
  atMs: number,
  silences: readonly AudioSilence[],
  opts: { maxDistanceMs?: number; minLengthMs?: number } = {},
): number | null {
  const maxDistance = opts.maxDistanceMs ?? 900
  const minLength = opts.minLengthMs ?? 200
  let best: { distance: number; length: number; center: number } | null = null
  for (const s of silences) {
    const length = s.endMs - s.startMs
    if (length < minLength) continue
    const distance = atMs < s.startMs ? s.startMs - atMs : atMs > s.endMs ? atMs - s.endMs : 0
    if (distance > maxDistance) continue
    const center = Math.round((s.startMs + s.endMs) / 2)
    // 先比距离（越近越好），距离相同取更长的那个
    if (best === null || distance < best.distance || (distance === best.distance && length > best.length)) {
      best = { distance, length, center }
    }
  }
  return best?.center ?? null
}

/**
 * 在 `[lowerMs, upperMs]` 窗口里，挑一个「落在静音里」的时刻当边界。
 *
 * 取静音与窗口**交集的中心**：既离两边的语音都远一点，也不偏向任何一侧。
 * 窗口里没有静音时返回 null（调用方保留原来的边界）。
 */
export function snapBoundaryToSilence(
  lowerMs: number,
  upperMs: number,
  silences: readonly AudioSilence[],
): number | null {
  if (!(upperMs > lowerMs)) return null
  let best: { startMs: number; endMs: number } | null = null
  for (const s of silences) {
    const from = Math.max(lowerMs, s.startMs)
    const to = Math.min(upperMs, s.endMs)
    if (to <= from) continue
    // 取与窗口相交最长的那段静音（并列时取更早的）
    if (best === null || to - from > best.endMs - best.startMs) best = { startMs: from, endMs: to }
  }
  if (best === null) return null
  return Math.round((best.startMs + best.endMs) / 2)
}
