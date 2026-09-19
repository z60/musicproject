/**
 * 角色抽取的范围策略与结果说明（docs/11 §4.6「自动抽取」）
 * ============================================================================
 * 真机事故（docs/91 §5.2.30）：在画本编辑里点「自动抽取」，界面上什么都不出现。
 *
 * 两个原因叠在一起：
 *   ① 抽取器只认「引导语动词（说道/沉声道）」与「称谓（老X/小X）」，而真机那本书通篇是
 *      剧本体 `无畏：“你瞎啊…”` —— 一个引导语动词都没有，整章抽出 0 个候选。
 *      （这一条已在 `src/shared/canvas/character.ts` 的信号 1b 里修掉：本章现在能抽出人。）
 *   ② 面板把**当前章节**当抽取范围，而一章本身经常供不出候选（楔子只有 82 字）。
 *      角色表是**整本书**的产物（`characters.bookId`），只在一章里找本来就是错的范围。
 *
 * 本模块只负责 ②：本章抽不到 → 扩大到全书再抽一次，并把结果**明确告诉用户**。
 * 刻意不 import 任何项目内模块（`@/` 别名只在 Vite 里生效），因此能在 Node 里直接测试。
 */

/** 抽取范围（面板只用这两种：当前章 / 全书） */
export type ExtractScope = 'chapter' | 'book'

export interface ExtractScopeInput {
  /** 本次是否带了章节范围（面板传了 `chapterId`） */
  chapterScoped: boolean
  /** 该范围抽到的候选数 */
  found: number
}

/**
 * 本章抽到 0 个候选时要不要扩大到全书？
 *
 * 只在「本来限制了章节」且「一个都没抽到」时扩大：本章能抽出人时就尊重章节范围
 * （避免把后面章节才登场的人物提前塞进角色表）——但抽不到时继续守着这一章，
 * 只会让按钮看起来是坏的。
 */
export function shouldWidenToBook(input: ExtractScopeInput): boolean {
  return input.chapterScoped && Math.max(0, input.found) === 0
}

export interface ExtractResultInput {
  /** 首次（本章范围）抽到的候选数；未限制章节时就是全书的候选数 */
  found: number
  /** 是否扩大到全书再抽了一次 */
  widened: boolean
  /** 扩大后抽到的候选数（未扩大时等于 `found`） */
  bookFound: number
  chapterScoped: boolean
}

/**
 * 把抽取结果翻成一句给用户看的话。
 *
 * 为什么必须有这句话：抽取是**异步 + 可能 0 结果**的动作，界面上没有任何变化时
 * 用户无法区分「按钮没反应」与「抽不到候选」。所以无论结果如何都要有一条明确的回执。
 */
export function describeExtractResult(input: ExtractResultInput): string {
  const found = Math.max(0, input.found)
  const bookFound = Math.max(0, input.bookFound)

  if (input.widened) {
    if (bookFound > 0) {
      return `本章没抽到候选角色，已自动扩大到全书：共 ${bookFound} 个（右侧「首见」是它们第一次出现的章节）。`
    }
    return '本章和全书都没抽到候选角色。可以点「新增角色」手动添加，或把正文里的说话人写成「名字：」再试一次。'
  }
  if (found > 0) {
    return input.chapterScoped ? `本章抽到 ${found} 个候选角色。` : `抽到 ${found} 个候选角色。`
  }
  return input.chapterScoped
    ? '本章没有抽到候选角色。'
    : '没有抽到候选角色。可以点「新增角色」手动添加，或把正文里的说话人写成「名字：」再试一次。'
}
