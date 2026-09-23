/**
 * Novel Studio · 画本导入落库（画本脚本 → 角色 + canvas_lines）
 * ============================================================================
 * 设计依据：docs/11「画本」、docs/10 §3 第 ⑧ 步
 *
 * 「已经是画本」的文档（【角色-CV】“台词” + 角色表）导入时：
 *   1. 角色按**名字**复用/创建（不覆盖用户已经改过的资料）
 *   2. 画本行直接落库（说话人来自【】，不需要再判定）
 *   3. 章节标记为 generated，line_count 用真实画本行数
 *
 * 为什么要单独一层：导入算法（import.service.ts）是纯逻辑，不该依赖画本仓储。
 * 装配层把本实现作为 CanvasImportPort 注入进去。
 */

import { CANVAS_DEFAULTS } from '../../../../shared/constants.ts'
import type {
  AgeGroup,
  CanvasLine,
  CanvasScriptCharacter,
  Character,
  Gender,
  Id,
  SpeakerType,
} from '../../../../shared/types.ts'
import type { CanvasImportPort } from '../import/import.service.ts'
import type { CanvasRepo } from './repositories/canvas.repo.ts'
import type { CharacterRepo } from './repositories/character.repo.ts'

export interface CanvasImportChapterPatch {
  canvasState: 'generated'
  lineCount: number
}

export interface CreateCanvasImportOptions {
  /** 每次调用现取（库可能被「从备份恢复」换掉） */
  getCanvasRepo: () => CanvasRepo
  getCharacterRepo: () => CharacterRepo
  /** 写入后更新章节的 canvas_state / line_count */
  updateChapter: (chapterId: Id, patch: CanvasImportChapterPatch) => Promise<void>
  newId?: () => string
  now?: () => number
}

/** 中文性别 → Gender */
export function mapScriptGender(raw: string | null): Gender | null {
  if (raw === null) return null
  if (raw.includes('男')) return 'male'
  if (raw.includes('女')) return 'female'
  if (raw.trim().length === 0) return null
  return 'other'
}

/** 中文年龄（数字或「中年」等）→ AgeGroup */
export function mapScriptAge(raw: string | null): AgeGroup | null {
  if (raw === null || raw.trim().length === 0) return null
  const n = Number(raw.trim())
  if (Number.isFinite(n) && n > 0) {
    if (n < 12) return 'child'
    if (n < 18) return 'teen'
    if (n < 35) return 'young'
    if (n < 55) return 'middle'
    return 'elder'
  }
  if (raw.includes('老')) return 'elder'
  if (raw.includes('中')) return 'middle'
  if (raw.includes('少') || raw.includes('童')) return 'child'
  if (raw.includes('青')) return 'young'
  return 'unknown'
}

/** CV / 音色 / 年龄 → 角色备注（这些字段在 Character 上没有独立列） */
export function buildScriptCharacterNote(info: CanvasScriptCharacter | undefined): string | null {
  if (!info) return null
  const parts: string[] = []
  if (info.cv) parts.push('CV：' + info.cv)
  if (info.voiceType) parts.push('音色：' + info.voiceType)
  if (info.ageText) parts.push('年龄：' + info.ageText)
  return parts.length > 0 ? parts.join('｜') : null
}

export function createCanvasImportPort(opts: CreateCanvasImportOptions): CanvasImportPort {
  const newId = opts.newId ?? ((): string => globalThis.crypto.randomUUID())
  const now = opts.now ?? ((): number => Date.now())

  return {
    async writeChapter(input) {
      const ts = now()
      const characterRepo = opts.getCharacterRepo()
      const canvasRepo = opts.getCanvasRepo()

      // ---- 1) 角色：按名字复用，缺的才创建（不覆盖用户改过的资料） ----
      const existing = await characterRepo.listByBook(input.bookId, { includeArchived: true })
      const byName = new Map(existing.map((c) => [c.name, c] as const))
      const tableByName = new Map(input.script.characters.map((c) => [c.name, c] as const))

      const names = new Set<string>()
      for (const c of input.script.characters) names.add(c.name)
      for (const l of input.script.lines) if (l.speaker) names.add(l.speaker)

      const nameToId = new Map<string, Id>()
      const toCreate: Character[] = []
      let sortOrder = existing.length
      for (const name of names) {
        const found = byName.get(name)
        if (found) {
          nameToId.set(name, found.id)
          continue
        }
        const info = tableByName.get(name)
        const id = newId()
        toCreate.push({
          id,
          bookId: input.bookId,
          name,
          aliases: [],
          gender: mapScriptGender(info?.gender ?? null),
          ageGroup: mapScriptAge(info?.ageText ?? null),
          description: info?.description ?? null,
          note: buildScriptCharacterNote(info),
          color: null,
          defaultSpeed: null,
          defaultEmotion: null,
          defaultGainDb: null,
          defaultPauseMs: null,
          isArchived: false,
          sortOrder: sortOrder++,
          createdAt: ts,
          updatedAt: ts,
        })
        nameToId.set(name, id)
      }
      if (toCreate.length > 0) await characterRepo.upsertMany(toCreate)

      // ---- 2) 画本行：说话人来自【】，直接标 assigned（无需复核） ----
      const lines: CanvasLine[] = input.script.lines.map((l, i) => {
        const speakerType: SpeakerType = l.speaker ? 'character' : 'narration'
        return {
          id: input.chapterId + '-L' + String(i).padStart(5, '0'),
          chapterId: input.chapterId,
          bookId: input.bookId,
          seq: i,
          speakerType,
          characterId: l.speaker ? (nameToId.get(l.speaker) ?? null) : null,
          kind: l.kind,
          text: l.text,
          sourceText: l.sourceText,
          charStart: l.charStart,
          charEnd: l.charEnd,
          emotion: null,
          emotionIntensity: null,
          speed: null,
          gainDb: null,
          pauseAfterMs: CANVAS_DEFAULTS.defaultPauseAfterMs,
          pauseInline: null,
          pronunciation: null,
          // 行内标注（如 （OS））写进 note；内心独白已由解析器标成 kind=inner
          note: l.note ?? null,
          state: 'assigned',
          confidence: 1,
          candidates: null,
          decidedBy: 'human',
          needsReview: false,
          flags: [],
          isTitle: false,
          rev: 1,
          createdAt: ts,
          updatedAt: ts,
        }
      })
      // 只有真的有台词行才写画本；纯角色表（卷首总表）只建角色，不把章节标成 generated
      if (lines.length > 0) {
        await canvasRepo.replaceChapterLines(input.chapterId, lines)
        await opts.updateChapter(input.chapterId, {
          canvasState: 'generated',
          lineCount: lines.length,
        })
      }
      return { lines: lines.length, characters: toCreate.length }
    },
  }
}
