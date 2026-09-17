<!--
  Novel Studio · 混音台（docs/15 §9 UI 结构、docs/14 §11 UI 结构）
  ============================================================================
  布局（自上而下 / 自左而右）：
    工具条：MixProjectSelector（方案）+ AutoSaveIndicator（保存状态）+ 章节预听 + 批量处理入口
    左主区：通道条横排（每轨一个 TrackStrip）
    右侧主控区：主控表头（BusMeter）+ MasterStrip + 成品留白 + ProcessChainEditor
                + EQ 响应概览（只读）+ PresetManager
    底部折叠区：BGM 配置 / 闪避 / 素材库 / 批量报告 四个页签
    固定条：AbCompareBar（A=原始 / B=处理后，同一位置切换）

  三件必须显式做对的事：
    ① 保存失败**必须让用户看到「修改仍在内存中」**（docs/11 §4.9）：AutoSaveIndicator 之外
       再加一条醒目的 el-alert —— 用户最容易误判的就是「我改了但它没存」。
    ② 切换方案前先 flush：由 MixProjectSelector → store.switchProject 内部保证，写库失败时
       弹确认框而不是静默丢改动。
    ③ MIX_TARGET_CONFLICT（响度与真峰目标冲突）：由 MasterStrip 在主控旁给出建议
       （它就在主控区里，与「目标响度」两个输入框直接相邻）。

  数据来源（不臆造 API）：
    · 轨道/主控/方案/素材 → mix.store；
    · 处理链/预设/批量报告/A-B → processChain.store + presets.store；
    · 保存状态 → AutoSaveIndicator（status 直接取 mix.saveStatus，语义与 store 一致）。

  组件交互约定：业务组件直接调 store，纯受控组件（EqCurveCanvas/FaderControl/PanControl/BusMeter）
  用 props/emits；本视图只处理「视图态」——底部页签、对话框开关、滚动定位。
-->

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AutoSaveIndicator from '@/shared/ui/AutoSaveIndicator.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import LoadingBlock from '@/shared/ui/LoadingBlock.vue'
import BusMeter from '../components/BusMeter.vue'
import FaderControl from '../components/FaderControl.vue'
import MixProjectSelector from '../components/MixProjectSelector.vue'
import TrackStrip from '../components/TrackStrip.vue'
import MasterStrip from '../components/MasterStrip.vue'
import ProcessChainEditor from '../components/ProcessChainEditor.vue'
import EqCurveCanvas from '../components/EqCurveCanvas.vue'
import PresetManager from '../components/PresetManager.vue'
import PresetApplyDialog from '../components/PresetApplyDialog.vue'
import BatchProcessReport from '../components/BatchProcessReport.vue'
import AbCompareBar from '../components/AbCompareBar.vue'
import MusicLibraryPanel from '../components/MusicLibraryPanel.vue'
import MusicTrackEditor from '../components/MusicTrackEditor.vue'
import DuckingPanel from '../components/DuckingPanel.vue'
import { useMixStore, MASTER_METER_ID } from '../stores/mix.store.ts'
import { useProcessChainStore, emptyChain } from '../stores/processChain.store.ts'
import { usePresetsStore } from '../stores/presets.store.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { previewPendingCount, resolvePreviewUrl } from '../composables/usePreview.ts'
import { EXPORT_DEFAULTS } from '@shared/constants.ts'
import { formatCount } from '@/shared/lib/format.ts'
import type { Id } from '@shared/types.ts'
import type { PreviewSide } from '../composables/usePreview.ts'

const router = useRouter()
const mix = useMixStore()
const chain = useProcessChainStore()
const presets = usePresetsStore()
const session = useSessionStore()

/** 「采样过轨道电平」：表头由「未采样」变为「实测」标签的依据 */
const levelsSampled = ref(false)
const bottomTab = ref<'bgm' | 'ducking' | 'library' | 'report'>('bgm')
const bottomCollapsed = ref(false)
const bottomRef = ref<HTMLElement | null>(null)
const applyVisible = ref(false)
const applyPresetId = ref<Id | null>(null)
const previewBusy = ref(false)
const toast = ref<string | null>(null)

const orderedTracks = computed(() => [...mix.tracks].sort((a, b) => a.sortOrder - b.sortOrder))

const saveErrorText = computed(() => {
  if (mix.saveStatus !== 'error') return null
  const error = mix.saveError as { message?: string } | null
  return error?.message ?? null
})

/** 套用对话框的链：给了预设就用预设，否则用当前编辑链 */
const applyChain = computed(() => (applyPresetId.value ? null : chain.chain))
const applyLabel = computed(() => (applyPresetId.value ? '' : chain.origin.label))

// ── 初始化与章节切换 ──────────────────────────────────────────────────────
onMounted(async () => {
  // 先把预设读进来，再初始化方案：这样「选中轨道 → 载入它绑定的预设」在首屏就能命中
  await Promise.all([presets.load(session.projectId), mix.loadAssets()])
  await mix.initialize()
})

watch(() => session.chapterId, async (chapterId) => {
  // 章节变了必须清干净：否则上一章的方案会被画在这一章上（store.resetForChapter 的注释也这么说）
  mix.resetForChapter()
  chain.reset()
  levelsSampled.value = false
  toast.value = null
  if (!chapterId) return
  await mix.initialize()
  await Promise.all([presets.load(session.projectId), mix.loadAssets(), mix.loadArrangements()])
})

// 选中轨道 → 把该轨绑定的预设读进处理链编辑器（没有绑定就是「不处理」）
watch(() => mix.selectedTrackId, (trackId) => {
  const track = mix.tracks.find(item => item.id === trackId)
  if (!track) return
  const origin = { kind: 'track' as const, id: track.id, label: `${track.name} · 处理链` }
  const preset = presets.getById(track.presetId)
  if (preset) chain.loadFromPreset(preset, origin)
  else chain.loadChain(emptyChain(), origin)
})

// ── 工具条动作 ────────────────────────────────────────────────────────────
async function previewChapter(): Promise<void> {
  const project = mix.current
  if (!project) return
  previewBusy.value = true
  previewHintClear()
  try {
    const rendered = await chain.renderChapterPreview({
      arrangementId: project.arrangementId,
      mixProjectId: project.id,
    })
    if (!rendered.path) {
      toast.value = '章节预览渲染失败：可先到设置页确认 ffmpeg 能力探测结果'
      return
    }
    const url = resolvePreviewUrl(rendered.path, session.projectId)
    // 章节预览没有「原始」对照，因此 A 留空、B 放预览产物 —— 统一在底部 A/B 条里播放，
    // 保证全局同一时刻只有一个预听在响（usePreview 的设计约束）。
    chain.patchAb({
      enabled: true,
      mode: 'chain',
      segmentId: null,
      label: '章节预览（前 30 秒）',
      originalUrl: null,
      originalLevels: null,
      processedUrl: url,
      processedLevels: null,
      loading: false,
      side: 'B',
      blind: false,
      remembered: null,
      error: null,
    })
    toast.value = '章节预览已就绪：在底部对比条点「播放」试听'
  } finally {
    previewBusy.value = false
  }
}

function previewHintClear(): void {
  toast.value = null
}

async function sampleLevels(): Promise<void> {
  const count = await mix.sampleTrackLevels()
  levelsSampled.value = count > 0
  toast.value = count > 0
    ? `已按实测值点亮 ${formatCount(count)} 条人声轨的表头`
    : '没有可采样的片段：本章可能还没有录音结果，或该方案里没有角色轨'
}

function openBatch(): void {
  applyPresetId.value = null
  applyVisible.value = true
}

function openApplyWithPreset(presetId: Id): void {
  applyPresetId.value = presetId
  applyVisible.value = true
}

function onApplied(taskId: Id): void {
  toast.value = `已派发处理任务（${taskId.slice(0, 8)}）：完成后到「批量报告」查看成功/跳过/失败明细`
  revealBottom('report')
}

function onSwitched(projectId: Id | null): void {
  levelsSampled.value = false
  if (projectId) void mix.loadAssets()
  toast.value = '已切换混音方案'
}

function onEditMusic(trackId: Id): void {
  mix.selectedTrackId = trackId
  revealBottom('bgm')
}

function onAbResolved(side: PreviewSide): void {
  toast.value = side === 'A' ? '已采用原始版本' : '已采用处理后版本'
}

function goSettings(): void {
  void router.push({ name: 'settings' })
}

/** 展开底部区并切到指定页签（点通道条上的「BGM 配置」也走这里） */
function revealBottom(tab: 'bgm' | 'ducking' | 'library' | 'report'): void {
  bottomTab.value = tab
  bottomCollapsed.value = false
  requestAnimationFrame(() => {
    bottomRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

/** 底部页签（el-radio-group 给的是 string | number | boolean，这里收窄回联合类型） */
function setBottomTab(value: unknown): void {
  const next = String(value)
  if (next === 'bgm' || next === 'ducking' || next === 'library' || next === 'report') {
    bottomTab.value = next
  }
}

function onPresetLoaded(presetId: Id): void {
  const preset = presets.getById(presetId)
  toast.value = `已载入预设「${preset?.name ?? presetId}」到处理链编辑器（未改动任何片段）`
}

function onAssetsAssigned(trackId: Id): void {
  mix.selectedTrackId = trackId
  toast.value = '素材已指派到轨道：该轨的出点已按素材时长填好'
}

function onDuckingReady(): void {
  toast.value = '闪避开/关对比已就绪：在底部固定对比条切换试听'
}
</script>

<template>
  <div class="ns-mixer">
    <!-- 工具条 -->
    <header class="ns-mixer__toolbar">
      <MixProjectSelector @switched="onSwitched" />
      <div class="ns-mixer__toolbar-right">
        <AutoSaveIndicator
          :status="mix.saveStatus"
          :saved-at="mix.savedAt"
          :error-text="saveErrorText"
          @retry="mix.retrySave()"
          @revert="mix.discardLocalChanges()"
        />
        <el-button size="small" :loading="previewBusy" :disabled="!mix.current" @click="previewChapter">
          章节预听（前 30 秒）
        </el-button>
        <el-button size="small" :disabled="!mix.current" @click="openBatch">批量处理…</el-button>
        <el-button size="small" :disabled="!mix.current" @click="revealBottom('report')">批量报告</el-button>
        <span v-if="previewPendingCount > 0" class="ns-hint">预览渲染排队 {{ previewPendingCount }}</span>
        <span class="ns-hint">{{ mix.breadcrumb }}</span>
      </div>
    </header>

    <!-- 保存失败：必须明说「修改仍在内存中」-->
    <el-alert
      v-if="mix.saveStatus === 'error'"
      class="ns-mixer__alert"
      type="error"
      :closable="false"
      show-icon
      title="方案保存失败：你的修改仍在内存中（尚未写入数据库）"
      :description="saveErrorText ?? '可点右上角「重试」重新保存，或点「放弃修改」回到上次保存的版本。'"
    />

    <p v-if="toast" class="ns-mixer__toast">{{ toast }}</p>

    <LoadingBlock v-if="mix.loading && !mix.current" text="正在载入混音方案…" />

    <EmptyState
      v-else-if="!mix.current"
      icon="🎚️"
      title="这一章还没有混音方案"
      description="混音方案引用对轨方案：先完成自动对轨，再用上方「新建…」创建一个方案（可再点「按角色生成轨道」快速起步）"
      hint="混音管「音量与效果」，对轨管「位置」，两者是独立的两层"
    />

    <template v-else>
      <div class="ns-mixer__body">
        <!-- 通道条横排 -->
        <main class="ns-mixer__desk">
          <div class="ns-mixer__desk-head">
            <h3>通道条（{{ orderedTracks.length }}）</h3>
            <div class="ns-mixer__desk-ops">
              <el-button size="small" :loading="mix.samplingLevels" @click="sampleLevels">
                采样轨道电平
              </el-button>
              <el-button size="small" @click="mix.clearMuteSolo()">清除 Mute/Solo</el-button>
            </div>
          </div>
          <p class="ns-hint">
            IPC 里没有混音的实时电平事件（只有录音域的 record:level），因此表头默认显示「未采样」，
            点「采样轨道电平」后用 analysis:metrics 的实测值点亮，避免拿假动画骗人。
          </p>

          <div v-if="orderedTracks.length" class="ns-mixer__strips">
            <TrackStrip
              v-for="(track, index) in orderedTracks"
              :key="track.id"
              :track="track"
              :index="index"
              :total="orderedTracks.length"
              :meter-source="levelsSampled ? 'static' : 'idle'"
              @select="(id) => { mix.selectedTrackId = id }"
              @edit-music="onEditMusic"
            />
          </div>
          <EmptyState
            v-else
            size="small"
            icon="🎙️"
            title="还没有任何轨道"
            description="用方案选择器里的「按角色生成轨道」一次建好旁白与各角色轨，再逐条绑定预设"
          />
        </main>

        <!-- 右侧主控区 -->
        <aside class="ns-mixer__master">
          <BusMeter
            :meter-id="MASTER_METER_ID"
            label="主控总线"
            :height="150"
            :history-height="70"
            source="live"
          />
          <MasterStrip @open-settings="goSettings" />

          <!-- 成品留白（MixProject.headSilenceMs / tailSilenceMs）：与「成品听感」直接相关 -->
          <section class="ns-mixer__block">
            <h4>成品留白</h4>
            <div class="ns-mixer__silence">
              <FaderControl
                :model-value="mix.current.headSilenceMs"
                :min="0"
                :max="3000"
                :step="50"
                :default-value="EXPORT_DEFAULTS.headSilenceMs"
                label="头部静音"
                unit="ms"
                hint="0~3000 ms；默认 500。开头留白让人有心理准备，也避免播放器掐掉第一个字"
                :precision="0"
                :height="100"
                compact
                @change="(value) => mix.patchSilence({ headSilenceMs: value })"
              />
              <FaderControl
                :model-value="mix.current.tailSilenceMs"
                :min="0"
                :max="5000"
                :step="50"
                :default-value="EXPORT_DEFAULTS.tailSilenceMs"
                label="尾部静音"
                unit="ms"
                hint="0~5000 ms；默认 1500。结尾留白避免与下一章「粘」在一起"
                :precision="0"
                :height="100"
                compact
                @change="(value) => mix.patchSilence({ tailSilenceMs: value })"
              />
            </div>
          </section>

          <ProcessChainEditor
            :curve-height="180"
            @apply-request="openBatch"
            @report-request="revealBottom('report')"
          />

          <!-- EQ 响应概览（只读）：处理链区可能被滚走，这里始终能看到当前链的音色走向 -->
          <section class="ns-mixer__block">
            <h4>EQ 响应概览</h4>
            <p class="ns-hint">只读概览：拖动控制点改参数请到上面「处理链 → EQ」里操作</p>
            <EqCurveCanvas :bands="chain.chain.eq" readonly :height="110" />
          </section>

          <PresetManager
            @apply-request="openApplyWithPreset"
            @loaded="onPresetLoaded"
          />
        </aside>
      </div>

      <!-- 底部折叠区（BGM 配置 / 闪避 / 素材库 / 批量报告）-->
      <section ref="bottomRef" class="ns-mixer__bottom">
        <header class="ns-mixer__bottom-head">
          <el-radio-group
            :model-value="bottomTab"
            size="small"
            @change="setBottomTab"
          >
            <el-radio-button value="bgm">BGM 配置</el-radio-button>
            <el-radio-button value="ducking">闪避</el-radio-button>
            <el-radio-button value="library">素材库</el-radio-button>
            <el-radio-button value="report">
              批量报告{{ chain.report.failures.length ? `（失败 ${chain.report.failures.length}）` : '' }}
            </el-radio-button>
          </el-radio-group>
          <el-button size="small" text @click="bottomCollapsed = !bottomCollapsed">
            {{ bottomCollapsed ? '展开' : '收起' }}
          </el-button>
        </header>

        <div v-show="!bottomCollapsed" class="ns-mixer__bottom-body">
          <template v-if="bottomTab === 'bgm'">
            <MusicTrackEditor
              v-if="mix.selectedMusicTrack"
              :track="mix.selectedMusicTrack"
              @open-ducking="revealBottom('ducking')"
              @open-library="revealBottom('library')"
            />
            <p v-else class="ns-hint">
              当前方案里还没有 BGM/音效轨：在通道条下方点「新增 BGM」后即可配置入出点、循环与淡入淡出
            </p>
          </template>

          <DuckingPanel
            v-else-if="bottomTab === 'ducking'"
            :track-id="mix.selectedMusicTrack?.id ?? null"
            @ab-ready="onDuckingReady"
          />

          <MusicLibraryPanel
            v-else-if="bottomTab === 'library'"
            :kind="mix.selectedMusicTrack?.kind === 'sfx' ? 'sfx' : 'bgm'"
            @assigned="onAssetsAssigned"
          />

          <BatchProcessReport v-else @open-presets="revealBottom('bgm')" />
        </div>
      </section>
    </template>

    <!-- 固定对比条（A/B）+ 套用范围对话框（全局唯一实例）-->
    <AbCompareBar @resolved="onAbResolved" />
    <PresetApplyDialog
      v-model="applyVisible"
      :preset-id="applyPresetId"
      :chain="applyChain"
      :label="applyLabel"
      @applied="onApplied"
    />
  </div>
</template>

<style scoped>
.ns-mixer { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 0; }
.ns-mixer__toolbar {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff);
}
.ns-mixer__toolbar-right { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ns-mixer__alert { margin: 0; }
.ns-mixer__toast { margin: 0; color: var(--ns-primary, #409eff); font-size: 11.5px; }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-mixer__body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 440px); gap: 12px; align-items: start; }
.ns-mixer__desk {
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-subtle, #fafafa);
  overflow-x: auto;
}
.ns-mixer__desk-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ns-mixer__desk h3 { margin: 0; font-size: 13.5px; color: var(--ns-text-primary, #303133); }
.ns-mixer__desk-ops { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-mixer__strips { display: flex; align-items: flex-start; gap: 8px; padding-bottom: 4px; }
.ns-mixer__master {
  display: flex; flex-direction: column; gap: 10px; padding: 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff);
}
.ns-mixer__block { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--ns-border, #dcdfe6); }
.ns-mixer__block h4 { margin: 0; font-size: 12.5px; color: var(--ns-text-primary, #303133); }
.ns-mixer__silence { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.ns-mixer__bottom {
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px; background: var(--ns-bg-elevated, #fff);
}
.ns-mixer__bottom-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ns-mixer__bottom-body { display: flex; flex-direction: column; gap: 8px; }
</style>
