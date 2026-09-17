/**
 * 画本编辑域 · 指派说话人（候选列表 + 确认）
 * ============================================================================
 * 设计依据：docs/11-功能域-画本编辑.md §4.2 / §4.4 / §4.5 / §4.7
 *   · 候选列表：Top-3 角色及其分数，点击即改（比下拉找角色快得多）
 *   · 待确认队列：数字键 1/2/3 直接选候选，Enter 确认并下一行
 *   · 批量：按候选第一位自动指派（「说话人=unknown 且 kind=dialogue」这类筛选后的动作）
 *   · 任何人工指派都写 decidedBy='human'（写在 canvas.store.assignSpeaker 里）并把 needsReview 清掉，
 *     否则重算会覆盖人工结果 —— docs/11 §3 明确说这是「最恼人的 bug」。
 *
 * 本 composable 不直接调 IPC：一切写操作都走 canvas.store（撤销栈与落库策略只在那里实现一次）。
 */

import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type { CanvasLine, Id, SpeakerCandidate } from '@shared/types.ts'
import { formatScore } from '@/shared/lib/format.ts'
import { LINE_KIND_LABELS } from '@shared/constants.ts'
import { useCanvasStore } from '../stores/canvas.store.ts'
import type { LineChange } from '../stores/canvas.store.ts'
import { useCharactersStore } from '../stores/characters.store.ts'

/** 一个可选的归属项（候选 / 旁白 / 其它） */
export interface SpeakerOption {
  /** null = 旁白或未分配（由 kind 决定语义） */
  characterId: Id | null
  name: string
  /** 候选分数；非候选（旁白 / 未分配）为 null */
  score: number | null
  /** narration = 旁白行；unknown = 明确「未分配」 */
  kind: 'character' | 'narration' | 'unknown'
  /** 数字键提示（1/2/3…） */
  hotkey: string | null
}

export interface AssignResult {
  ok: boolean
  lineId: Id
  characterId: Id | null
}

export interface UseSpeakerAssign {
  /** 正在指派的行（按钮 loading 用） */
  pendingIds: Ref<Set<Id>>
  lastAssigned: Ref<{ lineId: Id; characterId: Id | null; at: number } | null>
  /** 行上显示的说话人名字（旁白 / 未分配 / 角色名） */
  speakerLabel: (line: CanvasLine | null | undefined) => string
  /** 该行是否「未分配」（dialogue 但没有角色） */
  isUnassigned: (line: CanvasLine | null | undefined) => boolean
  /** 候选列表（截断到 topN，按分数降序） */
  candidatesOf: (line: CanvasLine | null | undefined, topN?: number) => SpeakerCandidate[]
  /** 队列底部的全部选项：候选 + 旁白 + 其它 */
  optionsOf: (line: CanvasLine | null | undefined, topN?: number) => SpeakerOption[]
  /** 候选分数文本（UI 展示用，统一走 format.formatScore） */
  scoreText: (score: number | null | undefined) => string
  /** 指派（human 强制标记 + 清 needsReview） */
  assign: (line: CanvasLine, characterId: Id | null, options?: { speakerType?: 'narration' | 'character'; label?: string }) => Promise<AssignResult>
  /** 按候选序号指派（1 起，对应数字键 1/2/3） */
  assignByIndex: (line: CanvasLine, index: number) => Promise<AssignResult>
  /** 显式设为旁白行 */
  setNarration: (line: CanvasLine) => Promise<AssignResult>
  /** 显式设为「未分配」（交回给重算或后续人工） */
  setUnassigned: (line: CanvasLine) => Promise<AssignResult>
  /** 批量：按候选第一位自动指派（一次批量 = 撤销栈一条命令） */
  assignTopCandidate: (targets: CanvasLine[]) => Promise<{ assigned: number; skipped: number }>
  /** 批量：把同一个角色指派给多行 */
  assignMany: (targets: CanvasLine[], characterId: Id | null) => Promise<{ assigned: number; skipped: number }>
  /** 一条行的归属描述：`萧炎（人工确认）` */
  describe: (line: CanvasLine | null | undefined) => string
}

const DEFAULT_TOP_N = 3

export function useSpeakerAssign(): UseSpeakerAssign {
  const canvas = useCanvasStore()
  const characters = useCharactersStore()

  const pendingIds = ref<Set<Id>>(new Set())
  const lastAssigned = ref<{ lineId: Id; characterId: Id | null; at: number } | null>(null)

  const topN = computed(() => DEFAULT_TOP_N)

  function speakerLabel(line: CanvasLine | null | undefined): string {
    if (!line) return '—'
    if (line.speakerType === 'narration' || !line.characterId) {
      return line.kind === 'sfx_note' ? '音效' : '旁白'
    }
    return characters.nameOf(line.characterId)
  }

  function isUnassigned(line: CanvasLine | null | undefined): boolean {
    return Boolean(line && line.kind === 'dialogue' && !line.characterId)
  }

  function candidatesOf(line: CanvasLine | null | undefined, limit = topN.value): SpeakerCandidate[] {
    const list = line?.candidates ?? []
    return [...list].sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit))
  }

  function optionsOf(line: CanvasLine | null | undefined, limit = topN.value): SpeakerOption[] {
    const options: SpeakerOption[] = candidatesOf(line, limit).map((candidate, index) => ({
      characterId: candidate.characterId,
      name: candidate.name || characters.nameOf(candidate.characterId),
      score: candidate.score,
      kind: 'character' as const,
      hotkey: String(index + 1),
    }))
    options.push({ characterId: null, name: '旁白', score: null, kind: 'narration', hotkey: String(options.length + 1) })
    options.push({ characterId: null, name: '其它…', score: null, kind: 'unknown', hotkey: null })
    return options
  }

  function scoreText(score: number | null | undefined): string {
    return formatScore(score)
  }

  function describe(line: CanvasLine | null | undefined): string {
    if (!line) return '—'
    const kind = LINE_KIND_LABELS[line.kind] ?? line.kind
    const speaker = speakerLabel(line)
    const decided = line.decidedBy === 'human' ? ' · 人工确认' : ''
    return `${kind} · ${speaker}${decided}`
  }

  async function withPending<T>(lineId: Id, run: () => Promise<T>): Promise<T> {
    pendingIds.value = new Set(pendingIds.value).add(lineId)
    try {
      return await run()
    } finally {
      const next = new Set(pendingIds.value)
      next.delete(lineId)
      pendingIds.value = next
    }
  }

  async function assign(
    line: CanvasLine,
    characterId: Id | null,
    options: { speakerType?: 'narration' | 'character'; label?: string } = {},
  ): Promise<AssignResult> {
    const speakerType = options.speakerType ?? (characterId ? 'character' : 'narration')
    const ok = await withPending(line.id, () =>
      canvas.assignSpeaker(line.id, characterId, {
        speakerType,
        needsReview: false, // 人工指派即视为已确认（docs/11 §4.5：确认后从队列移除）
        label: options.label ?? (characterId ? `指派说话人：${characters.nameOf(characterId)}` : '设为旁白'),
      }))
    if (ok) lastAssigned.value = { lineId: line.id, characterId, at: Date.now() }
    return { ok, lineId: line.id, characterId }
  }

  async function assignByIndex(line: CanvasLine, index: number): Promise<AssignResult> {
    const candidates = candidatesOf(line, Number.MAX_SAFE_INTEGER)
    const candidate = candidates[index]
    if (!candidate) return { ok: false, lineId: line.id, characterId: null }
    return assign(line, candidate.characterId, { label: `指派说话人：${candidate.name}` })
  }

  async function setNarration(line: CanvasLine): Promise<AssignResult> {
    return assign(line, null, { speakerType: 'narration', label: '设为旁白' })
  }

  async function setUnassigned(line: CanvasLine): Promise<AssignResult> {
    return withPending(line.id, async () => {
      const ok = await canvas.commitFields(
        line.id,
        { characterId: null, speakerType: 'narration', decidedBy: 'human', needsReview: true },
        '标记为待确认',
      )
      return { ok, lineId: line.id, characterId: null }
    })
  }

  /** 批量指派：构造 LineChange 后一次性提交（撤销栈里是一条命令） */
  async function assignMany(targets: CanvasLine[], characterId: Id | null): Promise<{ assigned: number; skipped: number }> {
    const patch = {
      characterId,
      speakerType: (characterId ? 'character' : 'narration') as 'character' | 'narration',
      decidedBy: 'human' as const,
      needsReview: false,
    }
    let skipped = 0
    const ids: Id[] = []
    for (const line of targets) {
      if (line.characterId === characterId && line.decidedBy === 'human' && !line.needsReview) {
        skipped += 1
        continue
      }
      ids.push(line.id)
    }
    if (!ids.length) return { assigned: 0, skipped }
    const ok = await canvas.applyBatchPatch(ids, patch, characterId ? '批量指派说话人' : '批量设为旁白')
    return { assigned: ok ? ids.length : 0, skipped }
  }

  /** 批量：按候选第一位自动指派（docs/11 §4.7） */
  async function assignTopCandidate(targets: CanvasLine[]): Promise<{ assigned: number; skipped: number }> {
    let skipped = 0
    const changes: LineChange[] = []
    for (const line of targets) {
      const top = candidatesOf(line, 1)[0]
      if (!top) {
        skipped += 1
        continue
      }
      changes.push({
        lineId: line.id,
        before: {
          characterId: line.characterId,
          speakerType: line.speakerType,
          // `CanvasLine.decidedBy` 可为 null（还没判定过），而 LineChange 里是可选字段
          // （`DecidedBy | undefined`）—— null 与 undefined 语义相同，这里统一成 undefined。
          decidedBy: line.decidedBy ?? undefined,
          needsReview: line.needsReview,
        },
        after: {
          characterId: top.characterId,
          speakerType: 'character' as const,
          decidedBy: 'human' as const,
          needsReview: false,
        },
      })
    }
    if (!changes.length) return { assigned: 0, skipped }
    const result = await canvas.commitBatchChanges(changes, `按候选首位指派（${changes.length} 行）`)
    return { assigned: result.updated, skipped }
  }

  return {
    pendingIds,
    lastAssigned,
    speakerLabel,
    isUnassigned,
    candidatesOf,
    optionsOf,
    scoreText,
    assign,
    assignByIndex,
    setNarration,
    setUnassigned,
    assignTopCandidate,
    assignMany,
    describe,
  }
}
