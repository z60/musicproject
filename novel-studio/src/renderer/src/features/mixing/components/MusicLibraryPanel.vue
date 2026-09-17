<!--
  Novel Studio · BGM / 音效素材库（docs/14 §8）
  ============================================================================
  本面板负责「素材本身」：导入、列表、试听、探测、标签/备注/授权说明、删除，
  以及「把素材指派到某条 BGM/SFX 轨」。章节内怎么用（入出点/循环/淡入淡出）在
  MusicTrackEditor，闪避在 DuckingPanel —— 三处职责不重叠。

  两个必须保留的合规/质量细节（docs/14 §8）：
    · 导入前提示「请确认你拥有该素材的使用权」（合规提示，不做强制）；
    · 探测后给出峰值建议（峰值过高会挤压后续压缩/限幅的余量）。

  ⚠ 已知契约缺口（如实写在界面上，不假装能做）：
    IPC 契约里只有 `music:import / list / probe / delete`，**没有 `music:update`**。
    因此「重命名 / 标签 / 备注 / 授权说明」的编辑只在本次会话内生效（本地覆盖层），
    主进程侧补上更新通道后才可能落库。界面上用一条 info 提示说明这件事，
    避免用户改完以为已经存进去了。

  试听走 `ns-media://` URL（mix.assetUrl → tryBuildMediaUrl），不直接读文件路径。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { useMixStore } from '../stores/mix.store.ts'
import { call } from '@/shared/lib/ipc.ts'
import { formatBytes, formatDb, formatDuration, formatSampleRate, UNKNOWN } from '@/shared/lib/format.ts'
import type { Id, MusicAsset } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  /** 初始页签：BGM 还是音效（视图可以按当前选中的通道条类型传进来） */
  kind?: 'bgm' | 'sfx'
}>(), {
  kind: 'bgm',
})

const emit = defineEmits<{
  /** 指派到轨之后，视图可以把对应通道条高亮 / 展开 BGM 配置 */
  'assigned': [trackId: Id]
}>()

const mix = useMixStore()

/** 导入允许的容器（docs/14 §8：mp3/wav/m4a/flac/ogg） */
const IMPORT_FILTERS = [
  { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg'] },
  { name: '全部文件', extensions: ['*'] },
]

const kind = ref<'bgm' | 'sfx'>(props.kind)
const query = ref('')
const importing = ref(false)
const probingAll = ref(false)
const licenseVisible = ref(false)
const deleteTarget = ref<MusicAsset | null>(null)
const assigningAsset = ref<MusicAsset | null>(null)
const assignTrackId = ref<Id | null>(null)
const editingId = ref<Id | null>(null)
const hint = ref<string | null>(null)

/** 会话内的元数据覆盖层（契约缺 music:update，见文件头说明） */
const localMeta = ref<Record<Id, Partial<Pick<MusicAsset, 'name' | 'tags' | 'note' | 'licenseNote'>>>>({})
const draftName = ref('')
const draftTags = ref('')
const draftNote = ref('')
const draftLicense = ref('')

const list = computed(() => {
  const source = kind.value === 'bgm' ? mix.bgmAssets : mix.sfxAssets
  const keyword = query.value.trim().toLowerCase()
  return source
    .map(asset => ({ ...asset, ...localMeta.value[asset.id] }))
    .filter((asset) => {
      if (!keyword) return true
      return asset.name.toLowerCase().includes(keyword)
        || (asset.note ?? '').toLowerCase().includes(keyword)
        || asset.tags.some(tag => tag.toLowerCase().includes(keyword))
    })
})

const targetTracks = computed(() => (
  kind.value === 'sfx' ? mix.sfxTracks : mix.musicTracks
))

function metricsOf(asset: MusicAsset) {
  return mix.assetMetrics[asset.id] ?? null
}

// ── 试听（ns-media:// URL）─────────────────────────────────────────────────
const audio = typeof Audio !== 'undefined' ? new Audio() : null
const playingId = ref<Id | null>(null)

function togglePlay(asset: MusicAsset): void {
  const url = mix.assetUrl(asset)
  if (!audio || !url) {
    hint.value = '这条素材没有可播放的地址（项目未选择或文件已被移动）'
    return
  }
  if (playingId.value === asset.id) {
    audio.pause()
    playingId.value = null
    return
  }
  audio.src = url
  audio.onended = () => { playingId.value = null }
  void audio.play()
    .then(() => { playingId.value = asset.id })
    .catch(() => {
      playingId.value = null
      hint.value = '试听失败：可能是文件格式不受支持，或文件已被移动'
    })
}

onBeforeUnmount(() => {
  if (!audio) return
  audio.pause()
  audio.removeAttribute('src')
})

// ── 导入（先给授权提示，再开文件对话框）──────────────────────────────────
function startImport(): void {
  licenseVisible.value = true
}

async function pickAndImport(): Promise<void> {
  importing.value = true
  try {
    const picked = await call('app:openFileDialog', {
      title: kind.value === 'bgm' ? '导入 BGM 素材' : '导入音效素材',
      filters: IMPORT_FILTERS,
      multi: true,
    })
    const files = picked?.paths ?? []
    if (!files.length) {
      hint.value = '已取消导入'
      return
    }
    const result = await mix.importAssets(kind.value, files)
    hint.value = `本次导入 ${result.imported} 个素材${result.failed ? `，${result.failed} 个失败（见提示明细）` : ''}`
    await mix.loadAssets()
  } finally {
    importing.value = false
  }
}

async function probeAll(): Promise<void> {
  probingAll.value = true
  try {
    const ok = await mix.probeAllAssets()
    hint.value = `已探测 ${ok} / ${mix.allAssets.length} 个素材`
  } finally {
    probingAll.value = false
  }
}

// ── 元数据（本地覆盖层）──────────────────────────────────────────────────
function startEdit(asset: MusicAsset): void {
  editingId.value = asset.id
  draftName.value = asset.name
  draftTags.value = asset.tags.join('、')
  draftNote.value = asset.note ?? ''
  draftLicense.value = asset.licenseNote ?? ''
}

function saveEdit(asset: MusicAsset): void {
  localMeta.value = {
    ...localMeta.value,
    [asset.id]: {
      name: draftName.value.trim() || asset.name,
      tags: draftTags.value.split(/[、,，\s]+/).map(item => item.trim()).filter(Boolean),
      note: draftNote.value.trim() || null,
      licenseNote: draftLicense.value.trim() || null,
    },
  }
  editingId.value = null
  hint.value = '已更新素材信息（本次会话内生效：IPC 契约目前没有 music:update 通道）'
}

// ── 指派到轨 ─────────────────────────────────────────────────────────────
function openAssign(asset: MusicAsset): void {
  assigningAsset.value = asset
  assignTrackId.value = targetTracks.value[0]?.id ?? null
}

function confirmAssign(): void {
  const asset = assigningAsset.value
  const trackId = assignTrackId.value
  assigningAsset.value = null
  if (!asset || !trackId) return
  const ok = mix.assignMusicAsset(trackId, asset)
  hint.value = ok ? `已把「${asset.name}」指派给所选轨道` : '指派失败：目标轨道类型与素材不匹配'
  if (ok) emit('assigned', trackId)
}

async function confirmDelete(): Promise<void> {
  const asset = deleteTarget.value
  deleteTarget.value = null
  if (!asset) return
  const ok = await mix.deleteAsset(asset.id)
  hint.value = ok ? `已删除「${asset.name}」` : '删除失败（可能仍被其它方案引用）'
}

function usageText(asset: MusicAsset): string {
  const used = mix.assetUsage(asset.id)
  if (!used.length) return '未被任何轨道使用'
  return `已用于 ${used.length} 条轨：${used.slice(0, 3).map(track => track.name).join('、')}`
}

function toggleKind(next: 'bgm' | 'sfx'): void {
  kind.value = next
  editingId.value = null
  void mix.loadAssets(next)
}

// ── 模板事件处理器（el-* 是全局组件，模板里拿不到载荷类型，统一在这里声明）──
/** el-radio-group 的载荷是组内 el-radio-button 的 value：'bgm' / 'sfx' */
function onKindChange(value: 'bgm' | 'sfx'): void {
  toggleKind(String(value) === 'sfx' ? 'sfx' : 'bgm')
}

/** 搜索框输入（el-input 的 update:model-value 载荷是字符串）*/
function onQueryInput(value: string): void {
  query.value = value
}

/** 元数据编辑表单的名称输入（el-input 的载荷是字符串）*/
function onDraftNameInput(value: string): void {
  draftName.value = value
}

/** 标签输入（el-input 的载荷是字符串）*/
function onDraftTagsInput(value: string): void {
  draftTags.value = value
}

/** 备注输入（el-input 的载荷是字符串）*/
function onDraftNoteInput(value: string): void {
  draftNote.value = value
}

/** 授权说明输入（el-input 的载荷是字符串）*/
function onDraftLicenseInput(value: string): void {
  draftLicense.value = value
}

/** 指派目标轨下拉：载荷是所选轨道 id（el-option :value="track.id"；清空时给空值）*/
function onAssignTrackChange(value: Id | null): void {
  assignTrackId.value = value ?? null
}

// 首次进入时把两类素材都读进来（切 tab 不再等）
onMounted(() => { void mix.loadAssets() })
</script>

<template>
  <section class="ns-lib">
    <header class="ns-lib__head">
      <div>
        <h3>素材库</h3>
        <p class="ns-hint">
          素材按项目托管（导入时复制进项目目录，源文件被移动也不影响成品）。
          导入前请确认你拥有该素材的使用权。
        </p>
      </div>
      <div class="ns-lib__ops">
        <el-button size="small" type="primary" :loading="importing" @click="startImport">导入素材…</el-button>
        <el-button size="small" :loading="probingAll" @click="probeAll">探测全部</el-button>
        <el-button size="small" :loading="mix.assetsLoading" @click="mix.loadAssets()">刷新</el-button>
      </div>
    </header>

    <div class="ns-lib__filters">
      <el-radio-group :model-value="kind" size="small" @change="onKindChange">
        <el-radio-button value="bgm">BGM（{{ mix.bgmAssets.length }}）</el-radio-button>
        <el-radio-button value="sfx">音效（{{ mix.sfxAssets.length }}）</el-radio-button>
      </el-radio-group>
      <el-input
        :model-value="query"
        size="small"
        clearable
        placeholder="搜索名称 / 标签 / 备注"
        class="ns-lib__search"
        @update:model-value="onQueryInput"
      />
      <span class="ns-hint">
        建议 BGM 音量：{{ formatDb(mix.suggestedMusicGainDb()) }} dB（比人声低 18~24 dB）
      </span>
    </div>

    <el-alert
      v-if="hint"
      class="ns-lib__hint"
      type="info"
      :closable="true"
      show-icon
      :title="hint"
      @close="hint = null"
    />

    <EmptyState
      v-if="!list.length"
      size="small"
      icon="🎵"
      :title="query ? '没有匹配的素材' : (kind === 'bgm' ? '还没有 BGM 素材' : '还没有音效素材')"
      description="点「导入素材…」把 mp3 / wav / m4a / flac / ogg 复制进项目"
      action-text="导入素材…"
      @action="startImport"
    />

    <div v-else class="ns-lib__list">
      <article v-for="asset in list" :key="asset.id" class="ns-asset">
        <header class="ns-asset__head">
          <strong>{{ asset.name }}</strong>
          <el-tag v-if="asset.loopable" size="small" type="success">可循环</el-tag>
          <el-tag v-for="tag in asset.tags.slice(0, 3)" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
          <span class="ns-asset__use">{{ usageText(asset) }}</span>
        </header>

        <p class="ns-asset__meta">
          {{ formatDuration(metricsOf(asset)?.durationMs ?? asset.durationMs) }} ·
          {{ formatSampleRate(metricsOf(asset)?.sampleRate ?? asset.sampleRate) }} ·
          {{ metricsOf(asset)?.channels ?? asset.channels ?? UNKNOWN }} 声道 ·
          峰值 {{ formatDb(metricsOf(asset)?.peakDb ?? asset.peakDb) }} dBFS ·
          响度 {{ formatDb(metricsOf(asset)?.lufs ?? asset.lufs) }} LUFS ·
          {{ formatBytes(metricsOf(asset)?.fileSize ?? null) }}
        </p>
        <p v-if="mix.peakAdvice(asset)" class="ns-asset__warn">{{ mix.peakAdvice(asset) }}</p>
        <p v-if="asset.note" class="ns-asset__note">备注：{{ asset.note }}</p>
        <p v-if="asset.licenseNote" class="ns-asset__note">授权说明：{{ asset.licenseNote }}</p>

        <!-- 元数据编辑（会话内覆盖，见文件头契约缺口说明）-->
        <div v-if="editingId === asset.id" class="ns-asset__edit">
          <el-input
            :model-value="draftName"
            size="small"
            placeholder="名称"
            @update:model-value="onDraftNameInput"
          />
          <el-input
            :model-value="draftTags"
            size="small"
            placeholder="标签（用、或空格分隔）"
            @update:model-value="onDraftTagsInput"
          />
          <el-input
            :model-value="draftNote"
            size="small"
            placeholder="备注（如：来自 XX 素材库，用于战斗场景）"
            @update:model-value="onDraftNoteInput"
          />
          <el-input
            :model-value="draftLicense"
            size="small"
            placeholder="授权说明（如：CC0 / 已购买商用授权）"
            @update:model-value="onDraftLicenseInput"
          />
          <div class="ns-asset__editops">
            <span class="ns-hint">IPC 契约没有 music:update，改动仅在本次会话生效</span>
            <el-button size="small" @click="editingId = null">取消</el-button>
            <el-button size="small" type="primary" @click="saveEdit(asset)">保存</el-button>
          </div>
        </div>

        <div v-if="assigningAsset?.id === asset.id" class="ns-asset__assign">
          <el-select
            :model-value="assignTrackId"
            size="small"
            placeholder="选择目标轨道"
            class="ns-lib__search"
            @change="onAssignTrackChange"
          >
            <el-option
              v-for="track in targetTracks"
              :key="track.id"
              :label="`${track.name}（${formatDb(track.gainDb)} dB）`"
              :value="track.id"
            />
          </el-select>
          <el-button size="small" @click="assigningAsset = null">取消</el-button>
          <el-button size="small" type="primary" :disabled="!assignTrackId" @click="confirmAssign">指派</el-button>
          <span v-if="!targetTracks.length" class="ns-hint">
            当前方案里还没有{{ kind === 'sfx' ? '音效' : 'BGM' }}轨：先在混音台新增一条
          </span>
        </div>

        <footer class="ns-asset__ops">
          <el-button size="small" @click="togglePlay(asset)">
            {{ playingId === asset.id ? '停止' : '试听' }}
          </el-button>
          <el-button size="small" :loading="mix.assetsLoading" @click="mix.probeAsset(asset.id)">探测</el-button>
          <el-button size="small" @click="startEdit(asset)">编辑信息</el-button>
          <el-button size="small" @click="openAssign(asset)">指派到轨…</el-button>
          <el-button size="small" type="danger" text @click="deleteTarget = asset">删除</el-button>
        </footer>
      </article>
    </div>

    <!-- 导入前的授权提示（合规，不做强制）-->
    <ConfirmDialog
      v-model="licenseVisible"
      title="导入素材前的确认"
      message="请确认你拥有该素材的使用权（自制、已购买授权或公有领域）。Novel Studio 只负责把文件复制进项目目录，不校验版权。"
      type="info"
      confirm-text="我确认，开始选择文件"
      @confirm="pickAndImport"
    />

    <ConfirmDialog
      :model-value="deleteTarget !== null"
      title="删除素材"
      :message="deleteTarget
        ? `删除「${deleteTarget.name}」？${usageText(deleteTarget)}被引用的轨道会清空素材引用。`
        : ''"
      type="danger"
      confirm-text="删除"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </section>
</template>

<style scoped>
.ns-lib { display: flex; flex-direction: column; gap: 8px; }
.ns-lib__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ns-lib h3 { margin: 0; font-size: 13.5px; color: var(--ns-text-primary, #303133); }
.ns-lib__ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-lib__filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-lib__search { width: 200px; }
.ns-lib__hint { margin: 0; }
.ns-lib__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 8px; }
.ns-asset {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 6px; background: var(--ns-bg-elevated, #fff);
}
.ns-asset__head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.ns-asset__head strong { color: var(--ns-text-primary, #303133); font-size: 12.5px; }
.ns-asset__use { margin-left: auto; color: var(--ns-text-secondary, #909399); font-size: 10.5px; }
.ns-asset__meta { margin: 0; color: var(--ns-text-regular, #606266); font-size: 11px; font-family: ui-monospace, Consolas, monospace; line-height: 1.45; }
.ns-asset__warn { margin: 0; color: var(--ns-warning, #e6a23c); font-size: 11px; }
.ns-asset__note { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; }
.ns-asset__edit,
.ns-asset__assign { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px dashed var(--ns-primary, #409eff); border-radius: 6px; }
.ns-asset__assign { flex-direction: row; align-items: center; flex-wrap: wrap; }
.ns-asset__editops { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.ns-asset__ops { display: flex; flex-wrap: wrap; gap: 4px; }
</style>
