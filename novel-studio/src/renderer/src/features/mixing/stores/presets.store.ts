/**
 * Novel Studio · 处理预设 store（docs/14 §4）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §4.1 内置预设表（起点参数，需实测微调）—— 数据来源是
 *     `@shared/constants.ts` 的 BUILTIN_PRESETS，渲染进程**只读**它
 *   · docs/14 §4.2 预设操作：保存当前为预设 / **复制内置预设**（内置不可直接编辑，
 *     编辑时提示「将创建副本」）/ 导入导出（JSON）/ 按角色套用 / 预设对比
 *   · docs/14 §4.3 参数摘要要能一眼看懂（列表里显示 chain 摘要）
 *   · docs/14 §13  导入外部预设时「保留未知字段并给出警告，不要静默丢弃」
 *
 * 边界说明（与契约相关，别在这里改）：
 *   · `ProcessPreset` 类型里**没有** `applyTo` / `characterIds` 字段
 *     （docs/14 §4.2 写到了这两个概念）。当前契约下「按角色套用」的落地点是
 *     **混音轨的 presetId**（`MixTrack.refId = characterId`，见 docs/15 §2），
 *     因此本 store 只负责预设集合，绑定动作在 mix.store.ts 的
 *     `bindPresetToCharacter()` 里（避免两个 store 互相 import 造成环）。
 *   · 预设的增删改查全部走后端通道（`preset:*`），本 store 不做本地持久化，
 *     唯一例外是「编辑内置预设 → 创建副本」这一条交互规则（docs/14 §4.2）。
 */

import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Id, ProcessChain, ProcessPreset } from '@shared/types.ts'
import { BUILTIN_PRESETS } from '@shared/constants.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { summarizeChain } from '@/features/mixing/stores/processChain.store.ts'

/** 新建预设的入参（`preset:create` 的载荷形状） */
export interface PresetDraft {
  name: string
  description?: string | null
  chain: ProcessChain
  tags?: string[]
}

export interface PresetImportResult {
  imported: number
  warnings: string[]
}

export interface PresetEditResult {
  /** 保存后的预设（内置预设的情况是**新副本**） */
  preset: ProcessPreset | null
  /** 是否因为「内置预设不可直接编辑」而创建了副本（UI 据此提示用户） */
  copied: boolean
}

/** 预设上可用的快捷标签（docs/14 §4.1 的内置标签 + §4.2 的用途标签） */
export const PRESET_TAG_SUGGESTIONS = [
  '男声', '女声', '旁白', '角色', '广播', '有力', '抢救', '手机录音',
  'ASMR', '轻处理', '修复', '去嘶', '无处理', '儿童', '老人',
] as const

export const usePresetsStore = defineStore('mixing/presets', () => {
  const presets = ref<ProcessPreset[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const lastError = shallowRef<unknown>(null)
  const loadedForProject = ref<Id | null>(null)

  /** 列表筛选：标签（多选，命中任一即可）与名称/描述关键字 */
  const tagFilter = ref<string[]>([])
  const query = ref('')
  /** 当前在管理面板里选中的预设（右侧详情 / 应用目标） */
  const selectedId = ref<Id | null>(null)
  const lastImport = shallowRef<PresetImportResult | null>(null)

  const builtinPresets = computed(() => presets.value.filter(p => p.builtin))
  const customPresets = computed(() => presets.value.filter(p => !p.builtin))

  /** 全部标签（内置 + 自定义去重，按出现次数排序，便于常用标签靠前） */
  const allTags = computed(() => {
    const counts = new Map<string, number>()
    for (const preset of presets.value) {
      for (const tag of preset.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
      .map(([tag]) => tag)
  })

  const filtered = computed(() => {
    const q = query.value.trim().toLowerCase()
    return presets.value.filter((preset) => {
      if (tagFilter.value.length && !tagFilter.value.some(tag => preset.tags.includes(tag))) return false
      if (!q) return true
      return preset.name.toLowerCase().includes(q)
        || (preset.description ?? '').toLowerCase().includes(q)
        || preset.tags.some(tag => tag.toLowerCase().includes(q))
    })
  })

  const selected = computed(() => presets.value.find(p => p.id === selectedId.value) ?? null)

  function getById(id: Id | null | undefined): ProcessPreset | null {
    if (!id) return null
    return presets.value.find(p => p.id === id) ?? null
  }

  /** 预设一句话摘要（列表与详情共用） */
  function summaryOf(preset: ProcessPreset | null | undefined): string {
    if (!preset) return '—'
    return summarizeChain(preset.chain)
  }

  /**
   * 载入预设集合。
   * 合并策略：内置预设来自常量（离线可用、保证「改坏也能恢复」），
   * 用户预设来自 `preset:list`。同名不算冲突（id 才是身份）。
   */
  async function load(projectId: Id | null = null, force = false): Promise<void> {
    if (!force && loadedForProject.value === projectId && presets.value.length) return
    loading.value = true
    try {
      const remote = await callSafe('preset:list', projectId ? { projectId } : {}) as ProcessPreset[] | null
      const merged = new Map<Id, ProcessPreset>()
      for (const preset of BUILTIN_PRESETS) merged.set(preset.id, preset)
      for (const preset of remote ?? []) merged.set(preset.id, preset)
      presets.value = [...merged.values()].sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
        return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
      loadedForProject.value = projectId
      lastError.value = null
      if (!selectedId.value && presets.value.length) selectedId.value = presets.value[0]!.id
    } catch (error) {
      lastError.value = error
    } finally {
      loading.value = false
    }
  }

  function toggleTag(tag: string): void {
    tagFilter.value = tagFilter.value.includes(tag)
      ? tagFilter.value.filter(item => item !== tag)
      : [...tagFilter.value, tag]
  }

  function clearFilters(): void {
    tagFilter.value = []
    query.value = ''
  }

  // -------------------------------------------------------------------------
  // 增删改
  // -------------------------------------------------------------------------

  async function create(draft: PresetDraft, projectId: Id | null = null): Promise<ProcessPreset | null> {
    saving.value = true
    try {
      const created = await call('preset:create', {
        preset: {
          projectId,
          name: draft.name.trim() || '未命名预设',
          description: draft.description ?? null,
          chain: draft.chain,
          tags: draft.tags ?? [],
          sortOrder: 100 + customPresets.value.length,
        },
      }) as ProcessPreset
      if (created) {
        presets.value = [...presets.value, created]
        selectedId.value = created.id
      }
      return created ?? null
    } catch {
      return null
    } finally {
      saving.value = false
    }
  }

  /** 直接更新（内置预设会被拒绝：必须先走 edit() 创建副本，docs/14 §4.2） */
  async function update(id: Id, patch: Partial<ProcessPreset>): Promise<ProcessPreset | null> {
    const target = getById(id)
    if (!target || target.builtin) return null
    saving.value = true
    try {
      const updated = await call('preset:update', { id, patch }) as ProcessPreset
      if (updated) {
        presets.value = presets.value.map(p => (p.id === id ? updated : p))
      }
      return updated ?? null
    } catch {
      return null
    } finally {
      saving.value = false
    }
  }

  /**
   * 编辑入口（唯一被 UI 使用的编辑动作）。
   * 内置预设 → **创建副本**（docs/14 §4.2：「内置预设不可直接编辑，
   * 防止用户改坏后不知道怎么恢复」），返回 `copied: true` 供 UI 提示。
   */
  async function edit(id: Id, patch: Partial<ProcessPreset>, projectId: Id | null = null): Promise<PresetEditResult> {
    const target = getById(id)
    if (!target) return { preset: null, copied: false }

    if (target.builtin) {
      const copy = await create({
        name: patch.name ?? `${target.name}（副本）`,
        description: patch.description ?? target.description,
        chain: patch.chain ?? target.chain,
        tags: patch.tags ?? target.tags,
      }, projectId)
      return { preset: copy, copied: true }
    }

    const updated = await update(id, patch)
    return { preset: updated, copied: false }
  }

  /** 复制预设（内置与自定义都允许）：id 与名字都新建 */
  async function duplicate(id: Id, name?: string, projectId: Id | null = null): Promise<ProcessPreset | null> {
    const target = getById(id)
    if (!target) return null
    return await create({
      name: name ?? `${target.name} 副本`,
      description: target.description,
      chain: target.chain,
      tags: [...target.tags],
    }, projectId)
  }

  async function remove(id: Id): Promise<boolean> {
    const target = getById(id)
    if (!target) return false
    if (target.builtin) return false // 内置预设不提供删除（它来自常量，删了也会回来）
    const res = await callSafe('preset:delete', { id }) as { ok: boolean } | null
    if (res?.ok) {
      presets.value = presets.value.filter(p => p.id !== id)
      if (selectedId.value === id) selectedId.value = presets.value[0]?.id ?? null
      return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // 导入 / 导出（JSON，团队共享用）
  // -------------------------------------------------------------------------

  const IMPORT_FILTERS = [{ name: '预设 JSON', extensions: ['json'] }]

  /**
   * 从文件导入预设。
   * `preset:import` 返回 `{ imported, warnings }`：未知字段、非法参数都由主进程
   * 汇总成 warnings（docs/14 §13：保留未知字段并给出警告，不要静默丢弃），
   * 这里把它们交给 UI 展示，而**不**走 error-bus（这不是错误，是提示）。
   */
  async function importFromFile(path?: string): Promise<PresetImportResult | null> {
    let filePath = path
    if (!filePath) {
      const picked = await callSafe('app:openFileDialog', { title: '导入处理预设', filters: IMPORT_FILTERS, multi: false }) as
        { paths: string[] } | null
      filePath = picked?.paths?.[0]
    }
    if (!filePath) return null

    const result = await callSafe('preset:import', { path: filePath }) as PresetImportResult | null
    if (!result) return null
    lastImport.value = result
    await load(loadedForProject.value, true)
    return result
  }

  async function exportToFile(ids: Id[], path?: string): Promise<string | null> {
    if (!ids.length) return null
    let filePath = path
    if (!filePath) {
      const picked = await callSafe('app:saveFileDialog', {
        title: '导出处理预设',
        defaultPath: 'novel-studio-presets.json',
        filters: IMPORT_FILTERS,
      }) as { path: string | null } | null
      filePath = picked?.path ?? undefined
    }
    if (!filePath) return null
    const result = await callSafe('preset:export', { ids, path: filePath }) as { path: string } | null
    return result?.path ?? null
  }

  function clearImportWarnings(): void {
    lastImport.value = null
  }

  return {
    presets, loading, saving, lastError,
    tagFilter, query, selectedId, selected, lastImport,
    builtinPresets, customPresets, allTags, filtered,
    load, getById, summaryOf, toggleTag, clearFilters,
    create, update, edit, duplicate, remove,
    importFromFile, exportToFile, clearImportWarnings,
  }
})
