/**
 * Novel Studio · 预设服务（`preset:*` 6 个通道）
 * ============================================================================
 * 设计依据：
 *   · docs/14 §4 预设管理：内置只读、用户改动另存副本、项目隔离、导入/导出
 *   · docs/21 §6 `process_presets`
 *   · docs/04 §8 设置里的默认预设（`processing.defaultPresetId`）—— 本域不写设置，
 *     只保证「预设被删掉后没人再引用它」这件事由 UI/设置页负责
 *
 * ### 三个必须守住的语义
 *   1. **内置预设只读**：`update`/`delete` 命中 `builtin:*` 时抛 `PERMISSION_DENIED`。
 *      docs/14 §4 的原话是「用户改动会创建副本，避免改坏后不知道怎么恢复」。
 *   2. **导入是「追加」不是「覆盖」**：文件名/名字冲突一律**建新行**（改名为 `名字 (2)`），
 *      因为「导入预设」最常见的用途是「同事发来一份参数」——覆盖掉同名预设等于毁掉用户自己的东西。
 *   3. **导出要能被自己读回来**：导出格式就是 `import` 接受的格式（含 `version`），
 *      并有往返测试钉住（否则「导出的文件导不回来」这种问题只有用户会遇到）。
 */

import { readFile, writeFile } from 'node:fs/promises'

import { AppError } from '../../../shared/errors.ts'
import { BUILTIN_PRESETS } from '../../../shared/constants.ts'
import type { Id, ProcessChain, ProcessPreset } from '../../../shared/types.ts'
import { isProcessChainEmpty, enabledEqBandCount, chainHash } from '../../../shared/audio/process.ts'
import type { Logger } from '../../infra/log/index.ts'
import { normalizeChain, type PresetRepo, type ProcessPresetInput } from './repositories/preset.repo.ts'
import { cloneChain } from './repositories/preset.repo.ts'

/** 导出文件的格式版本（将来改结构时用来判「这份文件还能不能读」） */
export const PRESET_FILE_VERSION = 1

export interface PresetFile {
  version: number
  exportedAt: number
  presets: Array<{
    name: string
    description: string | null
    tags: string[]
    sortOrder: number
    chain: ProcessChain
    /** 只做展示与排障：导入时**不**采信（链会被重新校验/补齐） */
    chainHash?: string
  }>
}

export interface PresetServiceDeps {
  repo: () => PresetRepo
  log?: Pick<Logger, 'info' | 'warn' | 'error'>
  now?: () => number
  /**
   * 允许导入/导出访问的根目录（`userData` 或用户选择的位置）。
   *
   * 契约里 `preset:import/export` 的 `path` 由渲染侧的保存/打开对话框给出（绝对路径），
   * 主进程**不做路径白名单**（用户可以导出到任意位置），但要求是绝对路径、
   * 且扩展名为 `.json` —— 避免「导出到一个目录」这种调用把写入搞成 EISDIR。
   */
  isAbsolutePath?: (p: string) => boolean
}

export interface PresetService {
  list(projectId?: Id | null): Promise<ProcessPreset[]>
  create(input: Omit<ProcessPreset, 'id' | 'createdAt' | 'updatedAt' | 'builtin'>): Promise<ProcessPreset>
  update(id: Id, patch: Partial<ProcessPreset>): Promise<ProcessPreset>
  remove(id: Id): Promise<{ ok: boolean }>
  importFrom(path: string, opts?: { projectId?: Id | null }): Promise<{ imported: number; warnings: string[] }>
  exportTo(ids: readonly Id[], path: string): Promise<{ path: string }>
  /** 解析出一个可直接执行的链（`process:*` 用）：presetId 优先，其次显式链 */
  resolveChain(presetId?: Id | null, chain?: ProcessChain | null): Promise<{ chain: ProcessChain; presetId: Id | null }>
}

export function createPresetService(deps: PresetServiceDeps): PresetService {
  const now = deps.now ?? (() => Date.now())

  function isAbsolute(p: string): boolean {
    if (deps.isAbsolutePath) return deps.isAbsolutePath(p)
    return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p)
  }

  function assertJsonPath(p: string, op: string): void {
    if (!p || !isAbsolute(p)) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { op, reason: 'path-must-be-absolute', path: p, hint: '请用「另存为 / 打开文件」对话框给出的绝对路径' },
      })
    }
    if (!/\.json$/i.test(p)) {
      throw new AppError('INVALID_PAYLOAD', {
        details: { op, reason: 'path-must-be-json', path: p, hint: '预设文件的扩展名必须是 .json' },
      })
    }
  }

  /**
   * 合并「库里的预设」与「代码里的内置常量」。
   *
   * ⚠️ 内置预设**同时存在于两处**：`002_seed.sql`（发布过的迁移，`builtin = 1`）
   * 与 `BUILTIN_PRESETS`（`shared/constants.ts`）。若直接拼接两份，用户会看到
   * **每个内置预设出现两次**（本文件的第一版就是这样，被测试当场抓住）。
   *
   * 以**库**为准（它是运行期真正被应用的那份：`002_seed` 是发布过的迁移，
   * 用户机器上已经存在），代码里的常量只作为「库里缺了这一条」的兜底
   * （例如测试里手工建的空库、或将来迁移调整过内置集合）。
   */
  async function listPresets(projectId: Id | null): Promise<ProcessPreset[]> {
    const rows = await deps.repo().list(projectId)
    const byId = new Set(rows.map((r) => r.id))
    const missingBuiltins = BUILTIN_PRESETS.filter((b) => !byId.has(b.id)).map(clonePreset)
    return [...rows, ...missingBuiltins].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    )
  }

  return {
    async list(projectId) {
      return listPresets(projectId ?? null)
    },

    async create(input) {
      const name = (input.name ?? '').trim()
      if (!name) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'preset:create', reason: 'empty-name', hint: '预设名不能为空（列表里会出现一排无法区分的项）' },
        })
      }
      // 链必须先**规范化**再落库：渲染侧送来的链可能少了新加的字段，
      // 存进去就会在「应用预设」时才炸（见 preset.repo.sqlite.ts 的 parseChain 注释）
      const chain = normalizeChain(input.chain)
      const created = await deps.repo().create({
        projectId: input.projectId ?? null,
        name,
        description: input.description ?? null,
        chain,
        tags: input.tags ?? [],
        sortOrder: input.sortOrder ?? 100,
      })
      deps.log?.info?.('preset.created', {
        event: 'preset.created',
        presetId: created.id,
        name: created.name,
        chainHash: chainHash(chain),
        empty: isProcessChainEmpty(chain),
        eqBands: enabledEqBandCount(chain),
      })
      return created
    },

    async update(id, patch) {
      const cur = await deps.repo().get(id)
      if (!cur) {
        // 内置预设不在库里：`get` 返回 null，但错误原因不是「不存在」而是「只读」。
        // 分开报能让 UI 显示对的提示（「这是内置预设」而不是「预设不见了」）。
        if (BUILTIN_PRESETS.some((p) => p.id === id)) {
          throw new AppError('PERMISSION_DENIED', {
            details: { op: 'preset:update', reason: 'builtin-readonly', id, hint: '内置预设不可编辑，请另存为副本' },
          })
        }
        throw new AppError('NOT_FOUND', { details: { entity: 'process_preset', id } })
      }
      if (patch.name !== undefined && !patch.name.trim()) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'preset:update', reason: 'empty-name', id },
        })
      }
      const updated = await deps.repo().update(id, {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.chain !== undefined ? { chain: normalizeChain(patch.chain) } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      })
      deps.log?.info?.('preset.updated', {
        event: 'preset.updated',
        presetId: id,
        chainHash: chainHash(updated.chain),
      })
      return updated
    },

    async remove(id) {
      if (BUILTIN_PRESETS.some((p) => p.id === id)) {
        throw new AppError('PERMISSION_DENIED', {
          details: { op: 'preset:delete', reason: 'builtin-readonly', id, hint: '内置预设不可删除' },
        })
      }
      const ok = await deps.repo().remove(id)
      deps.log?.info?.('preset.removed', { event: 'preset.removed', presetId: id, ok })
      return { ok }
    },

    async importFrom(path, opts) {
      assertJsonPath(path, 'preset:import')
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (e) {
        throw new AppError('FILE_NOT_FOUND', { cause: e, details: { op: 'preset:import', path } })
      }
      const warnings: string[] = []
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        throw new AppError('INVALID_PAYLOAD', {
          cause: e,
          details: { op: 'preset:import', reason: 'not-json', path },
        })
      }
      const list = extractPresetList(parsed)
      if (list.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'preset:import',
            reason: 'no-presets',
            path,
            hint: '文件里没有 presets 数组（导出格式见 docs/14 §4）',
          },
        })
      }

      const existing = await deps.repo().list(opts?.projectId ?? null)
      const takenNames = new Set([...existing.map((p) => p.name), ...BUILTIN_PRESETS.map((p) => p.name)])
      const inputs: ProcessPresetInput[] = []
      for (const [index, item] of list.entries()) {
        const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : ''
        if (!name) {
          warnings.push(`第 ${index + 1} 条缺少 name，已跳过`)
          continue
        }
        try {
          const chain = normalizeChain(item.chain, name)
          if (isProcessChainEmpty(chain)) {
            warnings.push(`「${name}」是空处理链（什么都不做），已导入但请确认这是有意的`)
          }
          inputs.push({
            projectId: opts?.projectId ?? null,
            // 名字冲突 → 建新行并改名（导入是追加，不覆盖用户已有的东西）
            name: uniqueName(name, takenNames),
            description: typeof item.description === 'string' ? item.description : null,
            chain,
            tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [],
            sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : 100,
          })
        } catch (e) {
          warnings.push(`「${name}」导入失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (inputs.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: { op: 'preset:import', reason: 'all-invalid', path, warnings },
        })
      }
      const created = await deps.repo().createMany(inputs)
      const version = typeof (parsed as { version?: unknown }).version === 'number'
        ? (parsed as { version: number }).version
        : null
      if (version !== null && version > PRESET_FILE_VERSION) {
        warnings.push(
          `文件版本 ${version} 高于当前支持的 ${PRESET_FILE_VERSION}：已按当前格式尽力导入，未识别的字段被忽略`,
        )
      }
      deps.log?.info?.('preset.imported', {
        event: 'preset.imported',
        path,
        imported: created.length,
        skipped: list.length - created.length,
        warnings: warnings.length,
      })
      return { imported: created.length, warnings }
    },

    async exportTo(ids, path) {
      assertJsonPath(path, 'preset:export')
      // 逐个按 id 解析：内置在常量里、用户预设在库里、可能还带项目归属 ——
      // 只查「全局预设」会漏掉项目级预设（用户选了半天却导出一个空文件）
      const chosen: ProcessPreset[] = []
      const missing: Id[] = []
      for (const id of [...new Set(ids)]) {
        // 库优先（内置预设也在 002_seed 里，以库为准才不会与列表显示的内容不一致）
        const row = await deps.repo().get(id)
        if (row) {
          chosen.push(row)
          continue
        }
        const builtin = BUILTIN_PRESETS.find((p) => p.id === id)
        if (builtin) {
          chosen.push(clonePreset(builtin))
          continue
        }
        missing.push(id)
      }
      if (chosen.length === 0) {
        throw new AppError('INVALID_PAYLOAD', {
          details: {
            op: 'preset:export',
            reason: 'no-presets-selected',
            requested: ids.length,
            missing,
            hint: '至少要选一个存在的预设；导出空文件没有意义',
          },
        })
      }
      if (missing.length > 0) {
        deps.log?.warn?.('preset.exportMissing', {
          event: 'preset.exportMissing',
          missing,
          note: '选中的部分预设不存在（可能已被删除）：导出其余项，并在日志里留痕',
        })
      }
      const file: PresetFile = {
        version: PRESET_FILE_VERSION,
        exportedAt: now(),
        presets: chosen.map((p) => ({
          name: p.name,
          description: p.description,
          tags: [...p.tags],
          sortOrder: p.sortOrder,
          chain: cloneChain(p.chain),
          chainHash: chainHash(p.chain),
        })),
      }
      try {
        await writeFile(path, JSON.stringify(file, null, 2), 'utf8')
      } catch (e) {
        throw new AppError('EXPORT_METADATA_WRITE_FAILED', {
          cause: e,
          details: { op: 'preset:export', path, reason: e instanceof Error ? e.message : String(e) },
        })
      }
      deps.log?.info?.('preset.exported', {
        event: 'preset.exported',
        path,
        count: file.presets.length,
        missing: missing.length,
      })
      return { path }
    },

    async resolveChain(presetId, chain) {
      if (presetId) {
        // 库优先：内置预设也在 `002_seed.sql` 里，用库里的那份才能保证
        // 「看到的就是会生效的」（常量与种子万一漂移，用户不该被两头耍）
        const row = await deps.repo().get(presetId)
        if (row) return { chain: cloneChain(row.chain), presetId }
        const builtin = BUILTIN_PRESETS.find((p) => p.id === presetId)
        if (builtin) return { chain: cloneChain(builtin.chain), presetId }
        throw new AppError('NOT_FOUND', { details: { entity: 'process_preset', id: presetId } })
      }
      if (chain) return { chain: normalizeChain(chain), presetId: null }
      throw new AppError('INVALID_PAYLOAD', {
        details: {
          op: 'process',
          reason: 'no-chain',
          hint: '必须给 presetId 或 chain 之一（契约里两者都是可选的，但不能都不给）',
        },
      })
    },
  }

  function uniqueName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) {
      taken.add(name)
      return name
    }
    for (let i = 2; i < 1000; i++) {
      const candidate = `${name} (${i})`
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
    }
    const fallback = `${name} (${Date.now()})`
    taken.add(fallback)
    return fallback
  }
}

/** 从任意「看起来像预设文件」的 JSON 里取出条目数组（兼容裸数组与 `{presets: [...]}`） */
export function extractPresetList(parsed: unknown): Array<Partial<ProcessPreset> & { chain?: unknown }> {
  if (Array.isArray(parsed)) return parsed as Array<Partial<ProcessPreset>>
  if (typeof parsed === 'object' && parsed !== null) {
    const maybe = (parsed as { presets?: unknown }).presets
    if (Array.isArray(maybe)) return maybe as Array<Partial<ProcessPreset>>
  }
  return []
}

function clonePreset(p: ProcessPreset): ProcessPreset {
  return { ...p, chain: cloneChain(p.chain), tags: [...p.tags] }
}
