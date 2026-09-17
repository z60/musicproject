/**
 * Novel Studio · 混音方案 store（docs/15 §2 / §3 / §4 / §9）
 * ============================================================================
 * 设计依据：
 *   · docs/15 §2  —— MixProject / MixTrack / MixMaster 三层模型
 *     （「混音方案与对轨方案是两层：对轨管位置，混音管音量与效果，**不要合并**」）
 *   · docs/15 §3.2 —— 时长口径必须与对轨一致（本 store 不做时长推算，只显示渲染结果）
 *   · docs/15 §4  —— 响度标准化：Pass 1 测 input_i/input_tp/input_lra →
 *     gainDb = target_I - input_i → Pass 2 线性 volume + alimiter。
 *     本 store 把这条推导链**显式展示**出来（用户需要理解「为什么要加 -3.2 dB」）
 *   · docs/15 §11 —— 目标 LUFS 与真峰冲突（MIX_TARGET_CONFLICT）
 *   · docs/14 §8  —— BGM/SFX 素材库（music:*）
 *   · docs/14 §9  —— ducking 配置与「开/关对比试听」
 *   · docs/11 §4.9 —— 乐观 UI + 500 ms 防抖落库；失败必须说清「修改仍在内存中」
 *
 * 保存策略（本 store 最核心的一段）：
 *   任何轨道/主控改动 → 立即改内存（乐观 UI）→ 500 ms 防抖 `mix:save`（整份 MixProject）
 *   → Ctrl+S / 切换方案前 `flush()`。
 *   用整份保存而不是增量补丁的原因：混音方案本身就是一个小文档（轨道数组 + 主控），
 *   增量补丁会让「主进程校验 + 版本号 version」变得很难对齐；
 *   500 ms 防抖已经把 IPC 频率压到「拖动结束时一次」。
 */

import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppSettings,
  Arrangement,
  AudioMetrics,
  BusKind,
  DuckingConfig,
  Id,
  LoudnessMeasurement,
  MixMaster,
  MixProject,
  MixTrack,
  MusicAsset,
  MusicTrackConfig,
  ProcessPreset,
} from '@shared/types.ts'
import { EXPORT_DEFAULTS, LOUDNESS_TARGETS } from '@shared/constants.ts'
import { call, callSafe, callCollecting } from '@/shared/lib/ipc.ts'
import { debounce } from '@/shared/lib/editable-debounce.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import { reportBatchFailures, reportError } from '@/shared/lib/error-bus.ts'
import { tryBuildMediaUrl } from '@/shared/lib/media-url.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { useProcessChainStore } from '@/features/mixing/stores/processChain.store.ts'
import { resolvePreviewUrl, previewPendingCount } from '@/features/mixing/composables/usePreview.ts'
import { pushStaticLevels, clearMeterLevels } from '@/features/mixing/composables/useMeter.ts'

/** 保存防抖间隔（docs/11 §4.9：文本编辑 500 ms；混音方案的整份保存用同一口径） */
export const SAVE_DEBOUNCE_MS = 500

/** 总线条目 id（BusMeter / LoudnessMeter 共用） */
export const MASTER_METER_ID = 'mix:master'

/** 某条轨的表头 id */
export function trackMeterId(trackId: Id): string {
  return `mix:track:${trackId}`
}

/**
 * 「限幅需要压掉多少 dB 才算冲突」的阈值。
 * docs/15 §11 只给了现象（-14 LUFS + -1 dBTP 且素材很响）没给数值，
 * 3 dB 是本实现取的工程阈值：超过 3 dB 的削峰在旁白上已经能听出失真。
 */
export const PEAK_REDUCTION_WARN_DB = 3

/**
 * 混音路由（docs/15 §9）：一条 BGM/SFX 轨的默认配置。
 *
 * 注意这里**没有** gainDb 参数：增益属于轨道（`MixTrack.gainDb`），
 * 素材级配置（MusicTrackConfig）只描述「这段音乐从哪开始、怎么淡入淡出、怎么被压低」。
 * 早期签名收了一个从未使用的 gainDb，既误导调用方又报 noUnusedParameters，已删。
 */
function createMusicConfig(assetId: Id, ducking: DuckingConfig): MusicTrackConfig {
  return {
    assetId,
    startMs: 0,
    endMs: null,
    loop: true,
    fadeInMs: 1500,
    fadeOutMs: 2000,
    ducking: { ...ducking },
  }
}

function createDuckingConfig(input: {
  amountDb: number
  attackMs: number
  releaseMs: number
}): DuckingConfig {
  return {
    enabled: false,
    amountDb: input.amountDb,
    // docs/14 §9：threshold 默认 -30（人声电平）；注意 ffmpeg 侧要线性值，
    // 单位换算由主进程按 docs/14 §3.1 的实测结果处理。
    thresholdDb: -30,
    attackMs: input.attackMs,
    releaseMs: input.releaseMs,
    mode: 'sidechain',
  }
}

/** 深拷贝（MixProject 是纯数据，JSON 往返足够且不依赖 structuredClone 的可用性） */
function cloneProject(project: MixProject): MixProject {
  return JSON.parse(JSON.stringify(project)) as MixProject
}

function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/** 响度推导（响度表下方那段「输入响度 → 目标偏移 → 预计增益」的说明） */
export interface LoudnessDerivation {
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetLufs: number
  /** 主进程给的偏移（targetOffset），正常情况下 = targetLufs - inputI */
  targetOffset: number
  /** 预计增益（docs/15 §4 Pass 2 的 gainDb） */
  gainDb: number
  /** 施加增益后的预测真峰 */
  predictedTpDb: number
  /** 为满足真峰目标，限幅器至少要压掉的量（dB） */
  peakReductionDb: number
  /** 是否构成 MIX_TARGET_CONFLICT */
  conflict: boolean
  suggestion: string
}

export interface LoudnessTargetRef {
  kind: 'segment' | 'chapter'
  id: Id | null
  label: string
}

export interface BatchImportResult {
  imported: number
  failed: number
}

export const useMixStore = defineStore('mixing/mix', () => {
  const session = useSessionStore()
  const settingsStore = useSettingsStore()

  const projects = ref<MixProject[]>([])
  const currentId = ref<Id | null>(null)
  const current = ref<MixProject | null>(null)
  const arrangements = ref<Arrangement[]>([])
  const characters = ref<Array<{ value: Id; label: string }>>([])
  const loading = ref(false)
  const loadError = shallowRef<unknown>(null)
  const selectedTrackId = ref<Id | null>(null)

  // ── 设置项代理（settings 未加载时给出与 docs 一致的默认值）────────────────
  function setting(key: keyof AppSettings['mixing'], fallback: number): number {
    const mixing = settingsStore.mixing
    const value = mixing ? mixing[key] : undefined
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  const mixingDefaults = computed(() => ({
    targetLufs: setting('targetLufs', -16),
    truePeakDb: setting('truePeakDb', EXPORT_DEFAULTS.truePeakDb),
    headSilenceMs: setting('headSilenceMs', EXPORT_DEFAULTS.headSilenceMs),
    tailSilenceMs: setting('tailSilenceMs', EXPORT_DEFAULTS.tailSilenceMs),
    defaultMusicGainDb: setting('defaultMusicGainDb', -21),
    duckAmountDb: setting('duckAmountDb', -12),
    duckAttackMs: setting('duckAttackMs', 20),
    duckReleaseMs: setting('duckReleaseMs', 400),
  }))

  // ── 保存状态（docs/11 §4.9）─────────────────────────────────────────────
  const saveStatus = ref<SaveStatus>('idle')
  const savedAt = ref<number | null>(null)
  const saveError = shallowRef<unknown>(null)
  const dirty = ref(false)
  /** 保存期间又发生的编辑次数：用它决定「写完后是否需要再写一次」 */
  let revision = 0
  const saveFeedback = ref<{ at: number; ok: boolean; text: string } | null>(null)

  const persist = debounce(() => { void writeNow() }, SAVE_DEBOUNCE_MS)

  const tracks = computed<MixTrack[]>(() => current.value?.tracks ?? [])
  const voiceTracks = computed(() => tracks.value.filter(t => t.kind === 'voice'))
  const musicTracks = computed(() => tracks.value.filter(t => t.kind === 'music'))
  const sfxTracks = computed(() => tracks.value.filter(t => t.kind === 'sfx'))
  const selectedTrack = computed(() => tracks.value.find(t => t.id === selectedTrackId.value) ?? null)
  /** 当前选中的音乐轨（DuckingPanel / MusicTrackEditor 用它作为编辑目标） */
  const selectedMusicTrack = computed(() => {
    const track = selectedTrack.value
    return track && track.kind === 'music' ? track : musicTracks.value[0] ?? null
  })

  const anySolo = computed(() => tracks.value.some(t => t.isSolo))
  /** 是否还有有效的人声（决定 ducking 的侧链源是否存在，docs/14 §9） */
  const voiceAudible = computed(() => voiceTracks.value.some(t => !t.isMute))
  const soloedTracks = computed(() => tracks.value.filter(t => t.isSolo))

  const master = computed<MixMaster>(() => current.value?.master ?? {
    targetLufs: mixingDefaults.value.targetLufs,
    truePeakDb: mixingDefaults.value.truePeakDb,
    lra: 11,
    limiterEnabled: true,
    sampleRate: 48000,
    channels: 1,
  })

  /** 与 LOUDNESS_TARGETS 匹配的标准目标（UI 上做预设下拉） */
  const loudnessTargetPresets = computed(() => LOUDNESS_TARGETS.map(item => ({ ...item })))
  const matchedTargetId = computed(() => (
    LOUDNESS_TARGETS.find(item => Math.abs(item.lufs - master.value.targetLufs) < 0.05)?.id ?? null
  ))

  /** 新音乐轨的 ducking 默认值（也供 DuckingPanel 在无选中轨时编辑） */
  const duckingDefaults = ref<DuckingConfig>(createDuckingConfig({
    amountDb: -12,
    attackMs: 20,
    releaseMs: 400,
  }))

  function syncDuckingDefaults(): void {
    duckingDefaults.value = createDuckingConfig({
      amountDb: mixingDefaults.value.duckAmountDb,
      attackMs: mixingDefaults.value.duckAttackMs,
      releaseMs: mixingDefaults.value.duckReleaseMs,
    })
  }

  // ── 改动入口 ────────────────────────────────────────────────────────────
  /** 所有修改都必须经过它：乐观 UI + 标脏 + 排一次防抖保存 */
  function mutate(mutator: (draft: MixProject) => void): void {
    const project = current.value
    if (!project) return
    const draft = cloneProject(project)
    mutator(draft)
    draft.updatedAt = Date.now()
    current.value = draft
    revision += 1
    dirty.value = true
    saveStatus.value = 'dirty'
    persist()
  }

  /** 立即写库（Ctrl+S / 切换方案 / 应用预设前调用） */
  async function writeNow(): Promise<boolean> {
    const project = current.value
    if (!project) return true
    if (!dirty.value) return true

    persist.cancel()
    const rev = revision
    const snapshot = cloneProject(project)
    saveStatus.value = 'saving'

    try {
      const saved = await call('mix:save', { mixProject: snapshot }, { onError: 'throw' }) as MixProject
      // 主进程可能回填 version/updatedAt；但**不能**覆盖写库期间的新编辑
      if (saved && revision === rev) {
        current.value = saved
        dirty.value = false
      }
      savedAt.value = Date.now()
      saveError.value = null
      saveStatus.value = revision === rev ? 'saved' : 'dirty'
      return true
    } catch (error) {
      saveError.value = error
      saveStatus.value = 'error'
      // 失败**不回滚**：docs/11 §4.9 要求「改动仍在内存中」对用户可见（不能假装存上了）
      reportError(error, {
        event: 'mixing.mix.saveFailed',
        detailOverride: '保存失败，你的修改仍在内存中（尚未写入数据库）。可点「重试」重新保存。',
        action: 'retry',
        // retryFn 契约是「重试一次，无返回值」；writeNow() 返回 boolean，
        // 用 async 形态吞掉返回值（Promise<boolean> 不能赋给 Promise<void>）。
        retryFn: async () => {
          await writeNow()
        },
      })
      return false
    } finally {
      // 写库期间又改了 → 再排一次（否则最后一次编辑会丢）
      if (revision !== rev) persist()
    }
  }

  /** 别名：Ctrl+S 的语义就是「强制保存」 */
  const flush = writeNow

  async function retrySave(): Promise<boolean> {
    return await writeNow()
  }

  /** 放弃内存中的改动，回到最近一次落库的版本 */
  function discardLocalChanges(): void {
    persist.cancel()
    dirty.value = false
    saveStatus.value = 'idle'
    saveError.value = null
    if (currentId.value) void loadProject(currentId.value)
  }

  // ── 方案管理（docs/15 §2「多方案」）──────────────────────────────────────
  async function loadArrangements(): Promise<void> {
    const chapterId = session.chapterId
    if (!chapterId) {
      arrangements.value = []
      return
    }
    const list = await callSafe('alignment:listArrangements', { chapterId }) as Arrangement[] | null
    arrangements.value = list ?? []
  }

  async function loadCharacters(): Promise<void> {
    const bookId = session.bookId
    if (!bookId) {
      characters.value = []
      return
    }
    const list = await callSafe('character:list', { bookId }) as
      Array<{ id: Id; name: string; isArchived: boolean }> | null
    characters.value = (list ?? [])
      .filter(item => !item.isArchived)
      .map(item => ({ value: item.id, label: item.name }))
  }

  async function listProjects(chapterId: Id): Promise<MixProject[]> {
    const list = await callSafe('mix:listProjects', { chapterId }) as MixProject[] | null
    projects.value = list ?? []
    return projects.value
  }

  async function loadProject(mixProjectId: Id): Promise<boolean> {
    loading.value = true
    try {
      const project = await call('mix:get', { mixProjectId }) as MixProject
      if (!project) return false
      current.value = project
      currentId.value = project.id
      revision += 1
      dirty.value = false
      saveStatus.value = 'idle'
      saveError.value = null
      selectedTrackId.value = project.tracks[0]?.id ?? null
      return true
    } catch (error) {
      loadError.value = error
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 初始化混音台：列出本章方案 → 选中默认方案 → 载入。
   * 同时把对轨方案与角色列表读进来（新增轨道、创建方案都要用）。
   */
  async function initialize(): Promise<boolean> {
    const chapterId = session.chapterId
    if (!chapterId) return false
    loading.value = true
    try {
      syncDuckingDefaults()
      await Promise.all([loadArrangements(), loadCharacters()])
      const list = await listProjects(chapterId)
      const preferred = list.find(item => item.isDefault)?.id ?? list[0]?.id ?? null
      if (!preferred) {
        current.value = null
        currentId.value = null
        return false
      }
      return await loadProject(preferred)
    } finally {
      loading.value = false
    }
  }

  /**
   * 切换方案。有未保存改动时先 flush；flush 失败时**不静默丢改动**，
   * 返回 `{ switched: false, reason: 'save-failed' }` 让 UI 弹确认框
   * （「保存失败，是否放弃修改并切换？」）。
   */
  async function switchProject(
    mixProjectId: Id,
    options: { force?: boolean } = {},
  ): Promise<{ switched: boolean; reason?: 'save-failed' | 'load-failed' }> {
    if (dirty.value && currentId.value && currentId.value !== mixProjectId) {
      const ok = await writeNow()
      saveFeedback.value = {
        at: Date.now(),
        ok,
        text: ok ? '切换方案前已保存当前改动' : '切换方案前保存失败',
      }
      if (!ok && !options.force) return { switched: false, reason: 'save-failed' }
    }
    const loaded = await loadProject(mixProjectId)
    return loaded ? { switched: true } : { switched: false, reason: 'load-failed' }
  }

  async function createProject(name: string, arrangementId?: Id): Promise<MixProject | null> {
    const chapterId = session.chapterId
    if (!chapterId) return null
    const chosenArrangement = arrangementId
      ?? arrangements.value.find(item => item.isDefault)?.id
      ?? arrangements.value[0]?.id
      ?? null
    if (!chosenArrangement) {
      // 没有对轨方案就无法建混音方案（docs/15 §2：混音引用 arrangementId）
      reportError(new Error('本章还没有对轨方案'), {
        event: 'mixing.mix.createWithoutArrangement',
        detailOverride: '这一章还没有对轨结果，无法创建混音方案。请先完成自动对轨或手工排布。',
      })
      return null
    }
    const created = await callSafe('mix:create', {
      chapterId,
      arrangementId: chosenArrangement,
      name: name.trim() || `混音方案 ${projects.value.length + 1}`,
    }) as MixProject | null
    if (!created) return null
    projects.value = [...projects.value, created]
    current.value = created
    currentId.value = created.id
    dirty.value = false
    saveStatus.value = 'idle'
    return created
  }

  async function duplicateProject(name?: string): Promise<MixProject | null> {
    const id = currentId.value
    if (!id) return null
    await writeNow()
    const copy = await callSafe('mix:duplicate', {
      mixProjectId: id,
      name: name ?? `${current.value?.name ?? '混音方案'} 副本`,
    }) as MixProject | null
    if (!copy) return null
    projects.value = [...projects.value, copy]
    await switchProject(copy.id)
    return copy
  }

  async function renameProject(mixProjectId: Id, name: string): Promise<void> {
    if (mixProjectId === currentId.value) {
      mutate((draft) => { draft.name = name })
      await writeNow()
      const index = projects.value.findIndex(item => item.id === mixProjectId)
      if (index >= 0 && current.value) projects.value[index] = current.value
      return
    }
    const target = projects.value.find(item => item.id === mixProjectId)
    if (!target) return
    const updated = await callSafe('mix:save', { mixProject: { ...target, name } }) as MixProject | null
    if (updated) {
      const index = projects.value.findIndex(item => item.id === mixProjectId)
      if (index >= 0) projects.value[index] = updated
    }
  }

  async function deleteProject(mixProjectId: Id): Promise<boolean> {
    const res = await callSafe('mix:delete', { mixProjectId }) as { ok: boolean } | null
    if (!res?.ok) return false
    projects.value = projects.value.filter(item => item.id !== mixProjectId)
    if (currentId.value === mixProjectId) {
      current.value = null
      currentId.value = null
      const next = projects.value.find(item => item.isDefault) ?? projects.value[0] ?? null
      if (next) await loadProject(next.id)
    }
    return true
  }

  // ── 轨道操作（docs/15 §2、docs/15 §9 通道条）────────────────────────────
  function newTrackObject(kind: BusKind, refId: Id | null, name: string, sortOrder: number): MixTrack {
    const projectId = currentId.value ?? ''
    const ducking = createDuckingConfig({
      amountDb: mixingDefaults.value.duckAmountDb,
      attackMs: mixingDefaults.value.duckAttackMs,
      releaseMs: mixingDefaults.value.duckReleaseMs,
    })
    return {
      id: newId('track'),
      mixProjectId: projectId,
      kind,
      refId,
      name,
      gainDb: kind === 'music' ? mixingDefaults.value.defaultMusicGainDb : 0,
      pan: 0,
      isMute: false,
      isSolo: false,
      presetId: null,
      sortOrder,
      music: kind === 'music' || kind === 'sfx' ? createMusicConfig('', ducking) : null,
    }
  }

  function addTrack(kind: BusKind, refId: Id | null = null, name?: string): MixTrack | null {
    if (!current.value) return null
    const fallbackName = kind === 'voice'
      ? (characters.value.find(item => item.value === refId)?.label ?? '旁白 / 角色')
      : kind === 'music' ? 'BGM' : '音效'
    const track = newTrackObject(kind, refId, name ?? fallbackName, tracks.value.length)
    mutate((draft) => { draft.tracks = [...draft.tracks, track] })
    selectedTrackId.value = track.id
    return track
  }

  /**
   * 按角色生成轨道（最省事的用法，docs/14 §4.2「按角色套用」的物理载体）：
   * 已经有轨道的角色不重复创建。
   */
  function buildTracksFromCharacters(): number {
    if (!current.value) return 0
    const existing = new Set(voiceTracks.value.map(t => t.refId))
    const created: MixTrack[] = []
    // 旁白轨（refId = null）先建：docs/15 §9 的通道条顺序是「旁白 / 每角色 / BGM / SFX」
    if (!existing.has(null)) {
      created.push(newTrackObject('voice', null, '旁白', 0))
    }
    for (const character of characters.value) {
      if (existing.has(character.value)) continue
      created.push(newTrackObject('voice', character.value, character.label, created.length + 1))
    }
    if (!created.length) return 0
    mutate((draft) => { draft.tracks = [...created, ...draft.tracks] })
    return created.length
  }

  function patchTrack(trackId: Id, patch: Partial<MixTrack>): void {
    mutate((draft) => {
      draft.tracks = draft.tracks.map(track => (track.id === trackId ? { ...track, ...patch } : track))
    })
  }

  function removeTrack(trackId: Id): void {
    mutate((draft) => {
      draft.tracks = draft.tracks.filter(track => track.id !== trackId).map((track, index) => ({ ...track, sortOrder: index }))
    })
    if (selectedTrackId.value === trackId) selectedTrackId.value = current.value?.tracks[0]?.id ?? null
  }

  /** 排序：与相邻轨交换位置（delta = -1 上移 / +1 下移） */
  function moveTrack(trackId: Id, delta: -1 | 1): void {
    mutate((draft) => {
      const ordered = [...draft.tracks].sort((a, b) => a.sortOrder - b.sortOrder)
      const index = ordered.findIndex(track => track.id === trackId)
      const target = index + delta
      if (index < 0 || target < 0 || target >= ordered.length) return
      const a = ordered[index]!
      const b = ordered[target]!
      const tmp = a.sortOrder
      a.sortOrder = b.sortOrder
      b.sortOrder = tmp
      draft.tracks = ordered.sort((x, y) => x.sortOrder - y.sortOrder).map((track, i) => ({ ...track, sortOrder: i }))
    })
  }

  /** 绑定轨道级处理链（docs/15 §2 MixTrack.presetId） */
  function bindPreset(trackId: Id, presetId: Id | null): void {
    patchTrack(trackId, { presetId })
  }

  /**
   * 按角色套用预设（docs/14 §4.2 `applyTo='character'` 语义的落地）：
   * 把该角色的所有轨道（含旁白轨，refId=null 时用 `forNarration` 指定）绑到同一个预设。
   * 返回受影响轨道数，便于 UI 反馈「已按角色套用 N 条轨道」。
   */
  function bindPresetToCharacter(characterId: Id | null, presetId: Id): number {
    const affected = voiceTracks.value.filter(track => track.refId === characterId)
    if (!affected.length) return 0
    const ids = new Set(affected.map(track => track.id))
    mutate((draft) => {
      draft.tracks = draft.tracks.map(track => (ids.has(track.id) ? { ...track, presetId } : track))
    })
    return affected.length
  }

  /** 「按角色套用」的批量入口：一次给多个角色绑不同预设（docs/14 §4.2 的省事用法） */
  function bindPresetsByCharacter(map: Array<{ characterId: Id | null; presetId: Id | null }>): number {
    if (!map.length) return 0
    let count = 0
    mutate((draft) => {
      draft.tracks = draft.tracks.map((track) => {
        if (track.kind !== 'voice') return track
        const hit = map.find(item => item.characterId === track.refId)
        if (!hit) return track
        count += 1
        return { ...track, presetId: hit.presetId }
      })
    })
    return count
  }

  /** 该角色当前绑定的预设（预设列表里显示「已用于：萧炎、药老」） */
  function charactersUsingPreset(presetId: Id): Array<{ id: Id | null; name: string }> {
    return voiceTracks.value
      .filter(track => track.presetId === presetId)
      .map(track => ({ id: track.refId, name: track.name }))
  }

  function syncMuteSolo(input: { trackId: Id; field: 'isMute' | 'isSolo'; value: boolean }): void {
    patchTrack(input.trackId, { [input.field]: input.value } as Partial<MixTrack>)
  }

  /** 一键清掉所有 Mute/Solo（混音台常见操作） */
  function clearMuteSolo(): void {
    mutate((draft) => {
      draft.tracks = draft.tracks.map(track => ({ ...track, isMute: false, isSolo: false }))
    })
  }

  // ── 音乐轨配置（docs/14 §8「使用位置」、docs/15 §2 MixTrack.music）──────
  function patchMusic(trackId: Id, patch: Partial<MusicTrackConfig>): void {
    mutate((draft) => {
      draft.tracks = draft.tracks.map((track) => {
        if (track.id !== trackId) return track
        const base = track.music ?? createMusicConfig(
          '',
          createDuckingConfig({
            amountDb: mixingDefaults.value.duckAmountDb,
            attackMs: mixingDefaults.value.duckAttackMs,
            releaseMs: mixingDefaults.value.duckReleaseMs,
          }),
        )
        return { ...track, music: { ...base, ...patch } }
      })
    })
  }

  function patchMusicDucking(trackId: Id, patch: Partial<DuckingConfig>): void {
    mutate((draft) => {
      draft.tracks = draft.tracks.map((track) => {
        if (track.id !== trackId) return track
        const base = track.music ?? createMusicConfig('', duckingDefaults.value)
        return {
          ...track,
          music: {
            ...base,
            ducking: { ...base.ducking, ...patch },
          },
        }
      })
    })
  }

  /** 从素材库拖拽/点击指派到某条 BGM/SFX 轨（docs/14 §8：本域只做「指派到轨」） */
  function assignMusicAsset(trackId: Id, asset: MusicAsset): boolean {
    const track = tracks.value.find(item => item.id === trackId)
    if (!track || (track.kind !== 'music' && track.kind !== 'sfx')) return false
    mutate((draft) => {
      draft.tracks = draft.tracks.map((item) => {
        if (item.id !== trackId) return item
        const base = item.music ?? createMusicConfig(asset.id, duckingDefaults.value)
        return {
          ...item,
          refId: asset.id,
          name: item.name && item.name !== 'BGM' && item.name !== '音效' ? item.name : asset.name,
          music: {
            ...base,
            assetId: asset.id,
            // 素材时长已知时用它做默认出点，避免「循环到天荒地老」
            endMs: asset.durationMs ?? base.endMs,
          },
        }
      })
    })
    return true
  }

  /** 某条轨引用的素材（MusicLibraryPanel 显示「被引用」用） */
  function assetUsage(assetId: Id): MixTrack[] {
    return tracks.value.filter(track => track.music?.assetId === assetId)
  }

  // ── 主控（docs/15 §2 MixMaster、§4 响度、§9 MasterStrip）───────────────
  function patchMaster(patch: Partial<MixMaster>): void {
    mutate((draft) => { draft.master = { ...draft.master, ...patch } })
  }

  /** 套用标准响度目标（LOUDNESS_TARGETS 预设，同时带上对应的 LRA） */
  function applyLoudnessTargetPreset(id: string): void {
    const preset = LOUDNESS_TARGETS.find(item => item.id === id)
    if (!preset) return
    patchMaster({ targetLufs: preset.lufs, lra: preset.lra })
  }

  function patchSilence(patch: { headSilenceMs?: number; tailSilenceMs?: number }): void {
    mutate((draft) => {
      if (typeof patch.headSilenceMs === 'number') draft.headSilenceMs = patch.headSilenceMs
      if (typeof patch.tailSilenceMs === 'number') draft.tailSilenceMs = patch.tailSilenceMs
    })
  }

  function patchTitleReading(patch: Partial<MixProject['titleReading']>): void {
    mutate((draft) => { draft.titleReading = { ...draft.titleReading, ...patch } })
  }

  // ── 响度测量与推导展示（docs/15 §4）────────────────────────────────────
  const loudness = shallowRef<LoudnessMeasurement | null>(null)
  const loudnessMetric = shallowRef<AudioMetrics | null>(null)
  const measuring = ref(false)
  const loudnessTarget = shallowRef<LoudnessTargetRef | null>(null)

  const loudnessDerivation = computed<LoudnessDerivation | null>(() => {
    const measured = loudness.value
    if (!measured) return null
    const targetLufs = master.value.targetLufs
    const truePeakDb = master.value.truePeakDb
    // docs/15 §4 Pass 2：gainDb = target_I - input_i（线性 volume，不用 loudnorm 二遍）
    const gainDb = targetLufs - measured.inputI
    const predictedTpDb = measured.inputTp + gainDb
    const peakReductionDb = Math.max(0, predictedTpDb - truePeakDb)
    const conflict = peakReductionDb > PEAK_REDUCTION_WARN_DB
    return {
      inputI: measured.inputI,
      inputTp: measured.inputTp,
      inputLra: measured.inputLra,
      inputThresh: measured.inputThresh,
      targetLufs,
      targetOffset: measured.targetOffset,
      gainDb,
      predictedTpDb,
      peakReductionDb,
      conflict,
      suggestion: conflict
        ? `需要限幅器额外压掉约 ${peakReductionDb.toFixed(1)} dB 才能满足 ${truePeakDb} dBTP，可能产生可听失真；建议把目标响度降低约 ${(peakReductionDb - PEAK_REDUCTION_WARN_DB).toFixed(1)} LU`
        : '目标响度与真峰目标相容',
    }
  })

  /** MIX_TARGET_CONFLICT 的判定结果（主控旁提示用） */
  const targetConflict = computed(() => (loudnessDerivation.value?.conflict ? loudnessDerivation.value : null))

  /**
   * 响度测量。
   *   · `segment`：直接测一个片段（快，适合「素材很响/很轻」的快速判断）；
   *   · `chapter`：先渲染一段章节预览（`alignment:previewRender`）再测产物 ——
   *     这才是「成品会是什么响度」的正确口径（docs/15 §8 强调试听与渲染可能不一致）。
   * 注意：IPC 契约里**没有** docs/15 §10 列的 `mix:previewRender`，
   * 因此章节口径走对轨域的区间预览渲染通道（只在渲染进程侧组合，不修改对轨状态）。
   */
  async function measureLoudness(target: LoudnessTargetRef): Promise<LoudnessMeasurement | null> {
    measuring.value = true
    loudnessTarget.value = target
    try {
      const targetLufs = master.value.targetLufs
      if (target.kind === 'segment' && target.id) {
        const measurement = await call('mix:measureLoudness', {
          segmentId: target.id,
          targetLufs,
        }) as LoudnessMeasurement
        loudness.value = measurement ?? null
        loudnessMetric.value = await callSafe('analysis:metrics', { segmentId: target.id }) as AudioMetrics | null
        return loudness.value
      }

      const project = current.value
      if (!project) return null
      const chainStore = useProcessChainStore()
      const rendered = await chainStore.renderChapterPreview({
        arrangementId: project.arrangementId,
        mixProjectId: project.id,
      })
      if (!rendered.path) {
        loudness.value = null
        loudnessMetric.value = null
        return null
      }
      const measurement = await call('mix:measureLoudness', {
        path: rendered.path,
        targetLufs,
      }) as LoudnessMeasurement
      loudness.value = measurement ?? null
      loudnessMetric.value = await callSafe('analysis:metrics', { path: rendered.path }) as AudioMetrics | null
      return loudness.value
    } catch {
      // call() 已经按 error-bus 兑现了提示；这里只把「没有测量结果」体现在状态里
      loudness.value = null
      return null
    } finally {
      measuring.value = false
    }
  }

  function clearLoudness(): void {
    loudness.value = null
    loudnessMetric.value = null
    loudnessTarget.value = null
  }

  // ── 素材库（docs/14 §8）────────────────────────────────────────────────
  const bgmAssets = ref<MusicAsset[]>([])
  const sfxAssets = ref<MusicAsset[]>([])
  const assetsLoading = ref(false)
  const assetMetrics = ref<Record<Id, AudioMetrics>>({})

  const allAssets = computed(() => [...bgmAssets.value, ...sfxAssets.value])

  async function loadAssets(kind?: 'bgm' | 'sfx'): Promise<void> {
    const projectId = session.projectId
    if (!projectId) return
    assetsLoading.value = true
    try {
      if (!kind || kind === 'bgm') {
        bgmAssets.value = (await callSafe('music:list', { projectId, kind: 'bgm' }) as MusicAsset[] | null) ?? []
      }
      if (!kind || kind === 'sfx') {
        sfxAssets.value = (await callSafe('music:list', { projectId, kind: 'sfx' }) as MusicAsset[] | null) ?? []
      }
    } finally {
      assetsLoading.value = false
    }
  }

  /**
   * 导入素材（docs/14 §8）。
   * 逐文件失败用 callCollecting 收集 + 一次汇总（docs/22 §7：不要刷 N 条提示），
   * 因为「一个 mp3 坏了」不该淹没整批导入。
   */
  async function importAssets(kind: 'bgm' | 'sfx', files: string[]): Promise<BatchImportResult> {
    const projectId = session.projectId
    if (!projectId || !files.length) return { imported: 0, failed: 0 }
    const sink: Array<{ label: string; code: string; message: string }> = []
    let imported = 0

    for (const file of files) {
      const result = await callCollecting('music:import', { projectId, files: [file], kind }, sink, file)
      if (result.ok) imported += (result.data ?? []).length
    }

    reportBatchFailures({ total: files.length, ok: imported, failed: sink.length, samples: sink })
    await loadAssets()
    return { imported, failed: sink.length }
  }

  /** 探测素材指标（docs/14 §8：自动读取时长、采样率、峰值，并提示峰值过高） */
  async function probeAsset(assetId: Id): Promise<AudioMetrics | null> {
    const metrics = await callSafe('music:probe', { assetId }) as AudioMetrics | null
    if (metrics) assetMetrics.value = { ...assetMetrics.value, [assetId]: metrics }
    return metrics
  }

  /** 批量探测（列表中「探测全部」按钮；逐条失败静默，一次汇总） */
  async function probeAllAssets(): Promise<number> {
    const sink: Array<{ label: string; code: string; message: string }> = []
    let ok = 0
    for (const asset of allAssets.value) {
      const result = await callCollecting('music:probe', { assetId: asset.id }, sink, asset.name)
      if (result.ok && result.data) {
        assetMetrics.value = { ...assetMetrics.value, [asset.id]: result.data as AudioMetrics }
        ok += 1
      }
    }
    reportBatchFailures({ total: allAssets.value.length, ok, failed: sink.length, samples: sink })
    return ok
  }

  const PROBE_WARN_PEAK_DB = -1

  /** 峰值是否过高（docs/14 §8：提示「峰值过高，建议降 X dB」） */
  function peakAdvice(asset: MusicAsset): string | null {
    const metrics = assetMetrics.value[asset.id]
    const peak = metrics?.peakDb ?? asset.peakDb
    if (peak === null || peak === undefined || !Number.isFinite(peak)) return null
    if (peak <= PROBE_WARN_PEAK_DB) return null
    return `峰值 ${peak.toFixed(1)} dBFS 偏高，建议先降低 ${(peak - PROBE_WARN_PEAK_DB).toFixed(1)} dB`
  }

  /** 建议的 BGM 音量（docs/14 §8：比人声低 18~24 dB，取中值 21 dB） */
  function suggestedMusicGainDb(): number {
    const voiceLufs = loudness.value?.inputI ?? loudnessMetric.value?.lufs ?? null
    const base = typeof voiceLufs === 'number' && Number.isFinite(voiceLufs) ? voiceLufs : -16
    return Math.round((base - 21) * 10) / 10
  }

  async function deleteAsset(assetId: Id): Promise<boolean> {
    const res = await callSafe('music:delete', { assetId }) as { ok: boolean } | null
    if (!res?.ok) return false
    bgmAssets.value = bgmAssets.value.filter(item => item.id !== assetId)
    sfxAssets.value = sfxAssets.value.filter(item => item.id !== assetId)
    // 引用它的轨道要把 assetId 清掉，否则渲染时会找不到文件
    mutate((draft) => {
      draft.tracks = draft.tracks.map(track => (
        track.music?.assetId === assetId
          ? { ...track, refId: track.refId === assetId ? null : track.refId, music: { ...track.music, assetId: '' } }
          : track
      ))
    })
    return true
  }

  function assetUrl(asset: MusicAsset | null | undefined): string | null {
    if (!asset) return null
    return tryBuildMediaUrl(session.projectId, asset.filePath)
  }

  // ── 轨道电平采样（表头的静态数据源）────────────────────────────────────
  const samplingLevels = ref(false)

  /**
   * 采样各轨的实测电平，点亮通道条表头。
   *
   * 为什么是「手动触发」而不是自动：主进程没有 `mix:level` 事件
   * （IPC 契约里的实时电平只有录音域的 `record:level`），
   * 因此混音台拿不到实时电平；若自动按轨去调 `analysis:metrics`，
   * 一进页面就是几十个 IPC（每轨 × 6 个片段）。改成用户点一次「采样轨道电平」，
   * 既避免启动抖动，又真实反映「各轨响度是否失衡」。
   */
  async function sampleTrackLevels(maxSegmentsPerTrack = 6): Promise<number> {
    const project = current.value
    if (!project) return 0
    samplingLevels.value = true
    try {
      const chainStore = useProcessChainStore()
      const index = await chainStore.loadSegmentIndex()
      let sampled = 0

      for (const track of project.tracks) {
        if (track.kind !== 'voice') {
          clearMeterLevels(trackMeterId(track.id))
          continue
        }
        const matched = index
          .filter(item => item.characterId === track.refId)
          .slice(0, maxSegmentsPerTrack)
        if (!matched.length) {
          clearMeterLevels(trackMeterId(track.id))
          continue
        }

        let peakDb: number | null = null
        let energy = 0
        let count = 0
        for (const item of matched) {
          const metrics = await callSafe('analysis:metrics', { segmentId: item.segmentId }) as AudioMetrics | null
          if (!metrics) continue
          if (typeof metrics.peakDb === 'number' && Number.isFinite(metrics.peakDb)) {
            peakDb = peakDb === null ? metrics.peakDb : Math.max(peakDb, metrics.peakDb)
          }
          if (typeof metrics.rmsDb === 'number' && Number.isFinite(metrics.rmsDb)) {
            energy += Math.pow(10, metrics.rmsDb / 10)
            count += 1
          }
        }
        if (count === 0 && peakDb === null) {
          clearMeterLevels(trackMeterId(track.id))
          continue
        }
        const rmsDb = count > 0 ? 10 * Math.log10(energy / count) : null
        pushStaticLevels(trackMeterId(track.id), rmsDb, peakDb)
        sampled += 1
      }
      return sampled
    } finally {
      samplingLevels.value = false
    }
  }

  // ── ducking 开/关对比试听（docs/14 §9）───────────────────────────────
  const duckingCompareRunning = ref(false)

  /**
   * 「试听对比（开/关 ducking）」。
   * 做法：把该轨 ducking 关掉渲一段 → 打开再渲一段 → 两段落进 A/B 对比条。
   * 之所以要真渲染两次：ducking 是**混音期**效果（sidechaincompress 在人声总线上取侧链），
   * 渲染进程里模拟不出来；docs/15 §8 明确「试听与渲染结果可能不一致」。
   *
   * 已知契约缺口：docs/15 §10 列的 `mix:previewRender` 在 IPC 契约里不存在，
   * 因此这里用对轨域的区间预览渲染（`alignment:previewRender`）代替。
   */
  async function previewDuckingCompare(): Promise<boolean> {
    const project = current.value
    const track = selectedMusicTrack.value
    if (!project || !track?.music) return false

    duckingCompareRunning.value = true
    const original = { ...track.music.ducking }
    try {
      const chainStore = useProcessChainStore()

      patchMusicDucking(track.id, { enabled: false })
      await writeNow()
      const off = await chainStore.renderChapterPreview({
        arrangementId: project.arrangementId,
        mixProjectId: project.id,
      })

      patchMusicDucking(track.id, { ...original, enabled: true })
      await writeNow()
      const on = await chainStore.renderChapterPreview({
        arrangementId: project.arrangementId,
        mixProjectId: project.id,
      })

      if (!off.path || !on.path) {
        // 还原用户原本的设置（对比失败不该留下被改过的配置）
        patchMusicDucking(track.id, original)
        await writeNow()
        return false
      }

      chainStore.patchAb({
        enabled: true,
        mode: 'ducking',
        segmentId: null,
        label: `${track.name}：A=关 ducking / B=开 ducking`,
        originalUrl: resolvePreviewUrl(off.path, session.projectId),
        originalLevels: null,
        processedUrl: resolvePreviewUrl(on.path, session.projectId),
        processedLevels: null,
        loading: false,
        side: 'A',
        error: null,
        remembered: null,
      })

      // 保留 B（开 ducking）的配置：这正是用户想听的那一版
      patchMusicDucking(track.id, { ...original, enabled: true })
      await writeNow()
      return true
    } finally {
      duckingCompareRunning.value = false
    }
  }

  // ── 会话切换 ───────────────────────────────────────────────────────────
  /** 章节变化时把状态清干净（否则会把上一章的方案画在这一章上） */
  function resetForChapter(): void {
    persist.cancel()
    // 先清表头：current 被置空后就拿不到轨道 id 了
    for (const track of tracks.value) clearMeterLevels(trackMeterId(track.id))
    clearMeterLevels(MASTER_METER_ID)

    projects.value = []
    current.value = null
    currentId.value = null
    selectedTrackId.value = null
    arrangements.value = []
    characters.value = []
    loudness.value = null
    loudnessMetric.value = null
    loudnessTarget.value = null
    assetMetrics.value = {}
    dirty.value = false
    saveStatus.value = 'idle'
    saveError.value = null
  }

  /** 供顶栏/工具栏显示：`斗破苍穹 · 第12章 · 带 BGM 版` */
  const breadcrumb = computed(() => {
    const parts: string[] = []
    if (session.book) parts.push(session.book.title)
    if (session.chapter) parts.push(session.chapter.title)
    if (current.value) parts.push(current.value.name)
    return parts.join(' · ')
  })

  /** 预设绑定情况（PresetManager 显示「已用于」时用） */
  function presetUsage(preset: ProcessPreset): MixTrack[] {
    return tracks.value.filter(track => track.presetId === preset.id)
  }

  return {
    // 方案
    projects, currentId, current, arrangements, characters, loading, loadError, selectedTrackId,
    tracks, voiceTracks, musicTracks, sfxTracks, selectedTrack, selectedMusicTrack,
    anySolo, soloedTracks, voiceAudible, master, mixingDefaults,
    loudnessTargetPresets, matchedTargetId, duckingDefaults,
    // 保存
    saveStatus, savedAt, saveError, dirty, saveFeedback,
    writeNow, flush, retrySave, discardLocalChanges,
    // 方案管理
    initialize, loadArrangements, loadCharacters, listProjects, loadProject, switchProject,
    createProject, duplicateProject, renameProject, deleteProject,
    // 轨道
    addTrack, buildTracksFromCharacters, patchTrack, removeTrack, moveTrack,
    bindPreset, bindPresetToCharacter, bindPresetsByCharacter, charactersUsingPreset, presetUsage,
    syncMuteSolo, clearMuteSolo,
    patchMusic, patchMusicDucking, assignMusicAsset, assetUsage,
    // 主控
    patchMaster, applyLoudnessTargetPreset, patchSilence, patchTitleReading,
    // 响度
    loudness, loudnessMetric, measuring, loudnessTarget, loudnessDerivation, targetConflict,
    measureLoudness, clearLoudness,
    // 素材
    bgmAssets, sfxAssets, allAssets, assetsLoading, assetMetrics,
    loadAssets, importAssets, probeAsset, probeAllAssets, peakAdvice, suggestedMusicGainDb,
    deleteAsset, assetUrl,
    // 表头采样
    samplingLevels, sampleTrackLevels,
    // ducking 对比
    duckingCompareRunning, previewDuckingCompare,
    // 其它
    resetForChapter, breadcrumb,
    previewPendingCount,
  }
})
