<!--
  Novel Studio · 预设管理（docs/14 §4 预设系统、§4.2 预设操作）
  ============================================================================
  内置预设**不可直接编辑**（docs/14 §4.2）：
    它们来自 `BUILTIN_PRESETS` 常量，用户改坏了没有「恢复出厂」的入口。
    因此点「编辑」时先弹一次确认「将创建副本」，确认后用 `presets.edit()`
    走副本分支，并明确告诉用户「内置预设保持不变，已创建副本 X」。

  预设是**共享资产**（按 projectId 存），不是某个轨道的私有配置：
    · 「应用」= 派发 process:apply / process:batchApply（走 PresetApplyDialog 的范围换算）；
    · 「载入编辑」= 只把它读进当前处理链编辑器，不落库、不改任何片段；
    · 轨道绑定（MixTrack.presetId）在混音台的通道条上选择，不在这里做。

  导入/导出是 JSON（团队共享）：导入的未知字段由主进程汇总成 warnings，
  UI 只做「提示」展示（这不是错误，不该走 error-bus 的红色报错）。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePresetsStore, PRESET_TAG_SUGGESTIONS } from '../stores/presets.store.ts'
import { useProcessChainStore } from '../stores/processChain.store.ts'
import { useMixStore } from '../stores/mix.store.ts'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { reportError } from '@/shared/lib/error-bus.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import type { Id, ProcessPreset } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  /** 预设所属项目；不传则用当前会话项目（预设是按项目存的可共享资产） */
  projectId?: Id | null
}>(), {
  projectId: null,
})

const emit = defineEmits<{
  /** 请求视图打开 PresetApplyDialog（对话框由视图统一持有，避免多份实例） */
  'apply-request': [presetId: Id]
  /** 载入了某个预设到处理链编辑器（视图可据此展开处理链区） */
  'loaded': [presetId: Id]
}>()

const presets = usePresetsStore()
const chain = useProcessChainStore()
const mix = useMixStore()
const session = useSessionStore()

/** 项目 id：显式传入优先，否则跟当前会话 */
const effectiveProjectId = computed(() => props.projectId ?? session.projectId)

onMounted(() => {
  void presets.load(effectiveProjectId.value)
  if (!mix.characters.length) void mix.loadCharacters()
})

// ── 分组（内置 / 自定义）与筛选 ────────────────────────────────────────────
const builtinList = computed(() => presets.filtered.filter(item => item.builtin))
const customList = computed(() => presets.filtered.filter(item => !item.builtin))

/** 搜索框：el-input 的 update:model-value 载荷是字符串（清空时为空串），直接写回筛选关键词 */
function onQueryInput(value: string): void {
  presets.query = value
}

/** 该预设当前被多少条轨道绑定（docs/14 §4.2「按角色套用」的可视化） */
function usageText(preset: ProcessPreset): string {
  const tracks = mix.presetUsage(preset)
  if (!tracks.length) return '未用于任何轨道'
  const names = tracks.slice(0, 3).map(track => track.name).join('、')
  return `已用于 ${tracks.length} 条轨道：${names}${tracks.length > 3 ? '…' : ''}`
}

// ── 新建（保存当前链为预设）───────────────────────────────────────────────
const creating = ref(false)
const draftName = ref('')
const draftDesc = ref('')
const draftTags = ref<string[]>([])
const opHint = ref<string | null>(null)

function openCreate(): void {
  creating.value = true
  draftName.value = chain.appliedPresetId
    ? `${presets.getById(chain.appliedPresetId)?.name ?? '预设'} 调整版`
    : `我的预设 ${presets.customPresets.length + 1}`
  draftDesc.value = chain.summary
  draftTags.value = []
  opHint.value = null
}

async function submitCreate(): Promise<void> {
  const name = draftName.value.trim()
  if (!name) {
    opHint.value = '预设名不能为空'
    return
  }
  const created = await presets.create({
    name,
    description: draftDesc.value.trim() || null,
    chain: chain.chain,
    tags: draftTags.value,
  }, effectiveProjectId.value)
  if (!created) {
    reportError(new Error('preset:create 未返回预设'), {
      event: 'mixing.preset.createFailed',
      detailOverride: '预设保存失败，处理链仍在编辑器中未丢失，可稍后重试保存。',
    })
    return
  }
  creating.value = false
  opHint.value = `已保存预设「${created.name}」`
}

function toggleDraftTag(tag: string): void {
  draftTags.value = draftTags.value.includes(tag)
    ? draftTags.value.filter(item => item !== tag)
    : [...draftTags.value, tag]
}

/** 预设名输入：el-input 的载荷是字符串 */
function onDraftNameInput(value: string): void {
  draftName.value = value
}

/** 描述输入：el-input 的载荷是字符串 */
function onDraftDescInput(value: string): void {
  draftDesc.value = value
}

// ── 载入编辑 / 应用 ───────────────────────────────────────────────────────
function loadIntoEditor(preset: ProcessPreset): void {
  chain.loadFromPreset(preset, { kind: 'scratch', id: null, label: preset.name })
  opHint.value = `已把「${preset.name}」读入处理链编辑器（未改动任何片段）`
  emit('loaded', preset.id)
}

// ── 重命名 / 复制 / 删除（内置编辑 → 创建副本）───────────────────────────
const renamingId = ref<Id | null>(null)
const renameText = ref('')
const builtinEditTarget = ref<ProcessPreset | null>(null)
const pendingEditPatch = ref<{ description: string | null } | null>(null)
const deleteTarget = ref<ProcessPreset | null>(null)
const busy = ref(false)

function startRename(preset: ProcessPreset): void {
  if (preset.builtin) {
    // 内置预设：先问「将创建副本」，不直接改
    pendingEditPatch.value = { description: preset.description }
    builtinEditTarget.value = preset
    return
  }
  renamingId.value = preset.id
  renameText.value = preset.name
}

async function confirmRename(): Promise<void> {
  const id = renamingId.value
  if (!id) return
  const name = renameText.value.trim()
  if (!name) {
    opHint.value = '预设名不能为空'
    return
  }
  busy.value = true
  const result = await presets.edit(id, { name })
  busy.value = false
  renamingId.value = null
  opHint.value = result.preset ? `已重命名为「${result.preset.name}」` : '重命名失败，请重试'
}

/** 重命名输入框：el-input 的载荷是字符串 */
function onRenameInput(value: string): void {
  renameText.value = value
}

/** 内置预设编辑：确认后走 edit()，store 会创建副本并返回 copied=true */
async function confirmBuiltinEdit(): Promise<void> {
  const preset = builtinEditTarget.value
  builtinEditTarget.value = null
  if (!preset) return
  busy.value = true
  const result = await presets.edit(preset.id, {
    name: `${preset.name}（副本）`,
    description: pendingEditPatch.value?.description ?? preset.description,
  }, effectiveProjectId.value)
  busy.value = false
  pendingEditPatch.value = null
  if (result.copied && result.preset) {
    opHint.value = `内置预设不可直接编辑，已创建副本「${result.preset.name}」；原内置预设保持不变`
    renamingId.value = result.preset.id
    renameText.value = result.preset.name
    return
  }
  opHint.value = '创建副本失败，请重试'
}

async function duplicatePreset(preset: ProcessPreset): Promise<void> {
  busy.value = true
  const copy = await presets.duplicate(preset.id, undefined, effectiveProjectId.value)
  busy.value = false
  opHint.value = copy ? `已复制为「${copy.name}」` : '复制失败，请重试'
}

async function confirmDelete(): Promise<void> {
  const preset = deleteTarget.value
  deleteTarget.value = null
  if (!preset) return
  busy.value = true
  const ok = await presets.remove(preset.id)
  busy.value = false
  opHint.value = ok ? `已删除「${preset.name}」` : '删除失败（内置预设不可删除）'
}

// ── 导出 / 导入 ───────────────────────────────────────────────────────────
async function exportOne(preset: ProcessPreset): Promise<void> {
  const path = await presets.exportToFile([preset.id])
  opHint.value = path ? `已导出到 ${path}` : '已取消导出'
}

async function exportAll(): Promise<void> {
  const ids = [...builtinList.value, ...customList.value].map(item => item.id)
  const path = await presets.exportToFile(ids)
  opHint.value = path ? `已导出 ${ids.length} 个预设到 ${path}` : '已取消导出'
}

async function importPresets(): Promise<void> {
  const result = await presets.importFromFile()
  if (!result) {
    opHint.value = '已取消导入'
    return
  }
  opHint.value = `已导入 ${result.imported} 个预设${result.warnings.length ? `，${result.warnings.length} 条警告` : ''}`
}

/** 载入当前链之后「覆盖保存」到该预设（自定义预设才有意义） */
async function saveChainInto(preset: ProcessPreset): Promise<void> {
  if (preset.builtin) {
    startRename(preset)
    return
  }
  busy.value = true
  const updated = await presets.update(preset.id, { chain: chain.chain, description: chain.summary })
  busy.value = false
  opHint.value = updated ? `已用当前处理链更新「${updated.name}」` : '更新失败，请重试'
}
</script>

<template>
  <section class="ns-presets">
    <header class="ns-presets__head">
      <div>
        <h3>处理预设</h3>
        <p class="ns-hint">
          预设跨本书共享，可在混音台把某条轨道（或整个角色）绑定到预设；内置预设改动会创建副本。
        </p>
      </div>
      <div class="ns-presets__ops">
        <el-button size="small" type="primary" @click="openCreate">保存当前链为预设</el-button>
        <el-button size="small" @click="importPresets">导入…</el-button>
        <el-button size="small" @click="exportAll">全部导出…</el-button>
      </div>
    </header>

    <div class="ns-presets__filters">
      <el-input
        :model-value="presets.query"
        size="small"
        clearable
        placeholder="搜索名称或描述"
        class="ns-presets__search"
        @update:model-value="onQueryInput"
      />
      <el-tag
        v-for="tag in presets.allTags.slice(0, 12)"
        :key="tag"
        size="small"
        :effect="presets.tagFilter.includes(tag) ? 'dark' : 'plain'"
        class="ns-presets__tag"
        @click="presets.toggleTag(tag)"
      >
        {{ tag }}
      </el-tag>
      <el-button v-if="presets.tagFilter.length" size="small" text @click="presets.clearFilters()">清除筛选</el-button>
    </div>

    <!-- 新建表单 -->
    <div v-if="creating" class="ns-presets__create">
      <el-input
        :model-value="draftName"
        size="small"
        placeholder="预设名（如：女主·冷静·轻处理）"
        @update:model-value="onDraftNameInput"
      />
      <el-input
        :model-value="draftDesc"
        size="small"
        placeholder="描述（可选）"
        @update:model-value="onDraftDescInput"
      />
      <div class="ns-presets__tagpick">
        <el-checkbox
          v-for="tag in PRESET_TAG_SUGGESTIONS"
          :key="tag"
          size="small"
          :model-value="draftTags.includes(tag)"
          @change="() => toggleDraftTag(tag)"
        >
          {{ tag }}
        </el-checkbox>
      </div>
      <p class="ns-hint">将要保存的链：{{ chain.summary }}</p>
      <div class="ns-presets__createops">
        <el-button size="small" @click="creating = false">取消</el-button>
        <el-button size="small" type="primary" @click="submitCreate">保存</el-button>
      </div>
    </div>

    <p v-if="opHint" class="ns-presets__hint">{{ opHint }}</p>

    <!-- 导入警告（不是错误：未知字段被保留并提示） -->
    <div v-if="presets.lastImport && presets.lastImport.warnings.length" class="ns-presets__warnings">
      <p class="ns-hint">导入提示（{{
        presets.lastImport.warnings.length
      }} 条）：未知字段已保留，未被识别的参数不会生效</p>
      <ul>
        <li v-for="(warning, index) in presets.lastImport.warnings.slice(0, 5)" :key="`${index}-${warning}`">
          {{ warning }}
        </li>
      </ul>
      <el-button size="small" text @click="presets.clearImportWarnings()">关闭提示</el-button>
    </div>

    <!-- 内置预设 -->
    <div class="ns-presets__group">
      <h4>内置预设（{{ builtinList.length }}）<span class="ns-hint">起点参数，建议按自家录音实测微调</span></h4>
      <div class="ns-presets__list">
        <article v-for="preset in builtinList" :key="preset.id" class="ns-preset is-builtin">
          <header class="ns-preset__head">
            <strong>{{ preset.name }}</strong>
            <el-tag size="small" type="info">内置</el-tag>
          </header>
          <p v-if="preset.description" class="ns-preset__desc">{{ preset.description }}</p>
          <p class="ns-preset__summary">{{ presets.summaryOf(preset) }}</p>
          <p class="ns-preset__usage">{{ usageText(preset) }}</p>
          <div class="ns-preset__tags">
            <el-tag v-for="tag in preset.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
          </div>
          <div class="ns-preset__ops">
            <el-button size="small" type="primary" @click="emit('apply-request', preset.id)">应用…</el-button>
            <el-button size="small" @click="loadIntoEditor(preset)">载入编辑</el-button>
            <el-button size="small" @click="startRename(preset)">改参数</el-button>
            <el-button size="small" :loading="busy" @click="duplicatePreset(preset)">复制</el-button>
            <el-button size="small" @click="exportOne(preset)">导出</el-button>
          </div>
        </article>
      </div>
    </div>

    <!-- 自定义预设 -->
    <div class="ns-presets__group">
      <h4>我的预设（{{ customList.length }}）</h4>
      <EmptyState
        v-if="!customList.length"
        size="small"
        icon="🎛️"
        title="还没有自定义预设"
        description="调好一条链之后点「保存当前链为预设」，就能按角色一键套用"
      />
      <div v-else class="ns-presets__list">
        <article v-for="preset in customList" :key="preset.id" class="ns-preset">
          <header class="ns-preset__head">
            <template v-if="renamingId === preset.id">
              <el-input
                :model-value="renameText"
                size="small"
                class="ns-preset__rename"
                @update:model-value="onRenameInput"
              />
              <el-button size="small" type="primary" :loading="busy" @click="confirmRename">保存</el-button>
              <el-button size="small" @click="renamingId = null">取消</el-button>
            </template>
            <template v-else>
              <strong>{{ preset.name }}</strong>
              <el-button size="small" text @click="startRename(preset)">重命名</el-button>
            </template>
          </header>
          <p v-if="preset.description" class="ns-preset__desc">{{ preset.description }}</p>
          <p class="ns-preset__summary">{{ presets.summaryOf(preset) }}</p>
          <p class="ns-preset__usage">{{ usageText(preset) }}</p>
          <div class="ns-preset__tags">
            <el-tag v-for="tag in preset.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
          </div>
          <div class="ns-preset__ops">
            <el-button size="small" type="primary" @click="emit('apply-request', preset.id)">应用…</el-button>
            <el-button size="small" @click="loadIntoEditor(preset)">载入编辑</el-button>
            <el-button size="small" :loading="busy" @click="saveChainInto(preset)">用当前链更新</el-button>
            <el-button size="small" @click="duplicatePreset(preset)">复制</el-button>
            <el-button size="small" @click="exportOne(preset)">导出</el-button>
            <el-button size="small" type="danger" text @click="deleteTarget = preset">删除</el-button>
          </div>
        </article>
      </div>
    </div>

    <!-- 内置预设「将创建副本」提示（docs/14 §4.2） -->
    <ConfirmDialog
      :model-value="builtinEditTarget !== null"
      title="内置预设不可直接编辑"
      message="内置预设是所有人共享的起点参数。继续将创建一份副本，副本可以自由修改，原内置预设保持不变。"
      type="info"
      confirm-text="创建副本并编辑"
      @confirm="confirmBuiltinEdit"
      @cancel="builtinEditTarget = null"
    />

    <ConfirmDialog
      :model-value="deleteTarget !== null"
      title="删除预设"
      :message="deleteTarget ? `确定删除「${deleteTarget.name}」？${usageText(deleteTarget)}` : ''"
      type="danger"
      confirm-text="删除"
      :loading="busy"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </section>
</template>

<style scoped>
.ns-presets { display: flex; flex-direction: column; gap: 10px; }
.ns-presets__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-presets h3 { margin: 0; font-size: 14px; color: var(--ns-text-primary, #303133); }
.ns-presets h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 12.5px; color: var(--ns-text-primary, #303133); }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; font-weight: 400; }
.ns-presets__ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-presets__filters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ns-presets__search { width: 200px; }
.ns-presets__tag { cursor: pointer; }
.ns-presets__create {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px dashed var(--ns-primary, #409eff); border-radius: 6px; background: rgb(64 158 255 / 4%);
}
.ns-presets__tagpick { display: flex; flex-wrap: wrap; gap: 8px; }
.ns-presets__createops { display: flex; justify-content: flex-end; gap: 6px; }
.ns-presets__hint { margin: 0; color: var(--ns-primary, #409eff); font-size: 11.5px; }
.ns-presets__warnings {
  padding: 6px 10px; border: 1px solid var(--ns-warning, #e6a23c);
  border-radius: 6px; background: rgb(230 162 60 / 6%);
}
.ns-presets__warnings ul { margin: 4px 0; padding-left: 16px; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-presets__group { display: flex; flex-direction: column; }
.ns-presets__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
.ns-preset {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-elevated, #fff);
}
.ns-preset.is-builtin { background: var(--ns-bg-subtle, #fafafa); }
.ns-preset__head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ns-preset__head strong { color: var(--ns-text-primary, #303133); font-size: 12.5px; }
.ns-preset__rename { max-width: 150px; }
.ns-preset__desc { margin: 0; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-preset__summary { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; font-family: ui-monospace, Consolas, monospace; line-height: 1.45; }
.ns-preset__usage { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-preset__tags { display: flex; flex-wrap: wrap; gap: 4px; }
.ns-preset__ops { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
</style>
