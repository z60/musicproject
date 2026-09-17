<!--
  Novel Studio · 通道条（docs/15 §9 TrackStrip、§2 MixTrack）
  ============================================================================
  一条轨 = 一个通道条。从上到下：名称 → 类型/角色标识 → 推子 + 表头 + 声像 →
  Mute/Solo → 预设绑定 → 排序/删除/新增。

  「Solo 时侧链源被静音」这个坑（docs/14 §9 常见错误 1）必须在**看得见的地方**提醒：
  Solo 了 BGM 而人声全被压住时，ducking 的侧链源就没了，BGM 不会下潜 —— 用户会以为是
  「闪避坏了」。所以本组件在音乐轨上直接给出这条提示。

  组件约定：业务动作直接调 mix store（乐观 UI + 防抖落库都在 store 里），
  只有「选中哪条轨」「要不要展开 BGM 编辑器」这类视图态才 emit 给 MixerView。

  电平表说明：主进程没有 `mix:level` 实时事件，轨道表头的数据来自
  `mix.sampleTrackLevels()` 的实测推送（analysis:metrics），因此默认标注为「实测」；
  未采样时由视图把 meterSource 传成 idle，表头显示「未采样」而不是假装有电平。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import FaderControl from './FaderControl.vue'
import PanControl from './PanControl.vue'
import BusMeter from './BusMeter.vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import { useMixStore, trackMeterId } from '../stores/mix.store.ts'
import { usePresetsStore } from '../stores/presets.store.ts'
import { formatDb } from '@/shared/lib/format.ts'
import type { BusKind, MixTrack } from '@shared/types.ts'

const props = withDefaults(defineProps<{
  track: MixTrack
  index: number
  total: number
  /** 表头数据来源标签：采样前是 idle（未采样），采样后是 static（实测） */
  meterSource?: 'live' | 'static' | 'idle'
}>(), {
  meterSource: 'static',
})

const emit = defineEmits<{
  /** 选中该轨（视图用它决定右侧编辑对象与 BGM 编辑器目标） */
  select: [trackId: string]
  /** 打开该轨的 BGM/SFX 配置 */
  'edit-music': [trackId: string]
}>()

const mix = useMixStore()
const presets = usePresetsStore()

const removing = ref(false)

const KIND_LABELS: Record<BusKind, string> = { voice: '人声', music: 'BGM', sfx: '音效' }

const kindLabel = computed(() => {
  if (props.track.kind !== 'voice') return KIND_LABELS[props.track.kind]
  if (!props.track.refId) return '旁白'
  return mix.characters.find(item => item.value === props.track.refId)?.label ?? '角色'
})

/** 类型标识配色：人声用默认色（最重要的一条），BGM/音效用不同色区分 */
const tagType = computed<'success' | 'warning' | undefined>(() => {
  if (props.track.kind === 'music') return 'success'
  if (props.track.kind === 'sfx') return 'warning'
  return undefined
})

const isSelected = computed(() => mix.selectedTrackId === props.track.id)

/** Solo 状态下未 Solo 的轨道变暗：一眼看出「现在只听到哪几条」 */
const dimmed = computed(() => mix.anySolo && !props.track.isSolo)

/** 音乐轨且 Solo 把人声全压住 → ducking 的侧链源消失（docs/14 §9） */
const duckingBroken = computed(() => (
  (props.track.kind === 'music' || props.track.kind === 'sfx')
  && props.track.music?.ducking.enabled === true
  && mix.anySolo
  && !mix.voiceAudible
))

const meterSource = computed<'live' | 'static' | 'idle'>(() => {
  if (props.meterSource === 'idle') return 'idle'
  return props.track.kind === 'voice' ? props.meterSource : 'idle'
})

const boundPreset = computed(() => presets.getById(props.track.presetId))

const canMoveUp = computed(() => props.index > 0)
const canMoveDown = computed(() => props.index < props.total - 1)

// ── 改动（全部经 store，保证标脏 + 防抖保存）───────────────────────────────
function rename(name: string): void {
  mix.patchTrack(props.track.id, { name: name.trim() || props.track.name })
}

function setGain(value: number): void {
  mix.patchTrack(props.track.id, { gainDb: value })
}

function setPan(value: number): void {
  mix.patchTrack(props.track.id, { pan: value })
}

function setMute(value: boolean): void {
  mix.syncMuteSolo({ trackId: props.track.id, field: 'isMute', value })
}

function setSolo(value: boolean): void {
  mix.syncMuteSolo({ trackId: props.track.id, field: 'isSolo', value })
}

function bindPreset(value: unknown): void {
  const id = value === null || value === undefined || value === '' ? null : String(value)
  mix.bindPreset(props.track.id, id)
  emit('select', props.track.id)
}

/** 把该预设套用到本轨所属角色的**所有**轨道（docs/14 §4.2 最省事的用法） */
function bindToCharacter(): void {
  if (!props.track.presetId || props.track.kind !== 'voice') return
  mix.bindPresetToCharacter(props.track.refId, props.track.presetId)
}

async function confirmRemove(): Promise<void> {
  removing.value = false
  mix.removeTrack(props.track.id)
}

function addAfter(kind: BusKind): void {
  const created = mix.addTrack(kind, null)
  if (created) emit('select', created.id)
}
</script>

<template>
  <article
    class="ns-strip"
    :class="{ 'is-selected': isSelected, 'is-dimmed': dimmed, 'is-kind-music': track.kind !== 'voice' }"
    @click="emit('select', track.id)"
  >
    <header class="ns-strip__head">
      <el-tag size="small" :type="tagType">
        {{ KIND_LABELS[track.kind] }}
      </el-tag>
      <span class="ns-strip__role">{{ kindLabel }}</span>
      <span class="ns-strip__seq">#{{ index + 1 }}</span>
    </header>

    <el-input
      :model-value="track.name"
      size="small"
      class="ns-strip__name"
      @change="rename"
    />

    <div class="ns-strip__body">
      <FaderControl
        :model-value="track.gainDb"
        :min="-60"
        :max="12"
        :step="0.5"
        :default-value="track.kind === 'voice' ? 0 : -21"
        label="增益"
        unit="dB"
        hint="增益 -60~+12 dB；BGM 建议比人声低 18~24 dB。双击推子恢复默认"
        :precision="1"
        orientation="vertical"
        :height="150"
        :compact="true"
        @change="setGain"
      />

      <BusMeter
        :meter-id="trackMeterId(track.id)"
        :label="track.name"
        :height="150"
        :history-height="60"
        :source="meterSource"
        compact
        orientation="vertical"
        @clear-clip="() => {}"
      />
    </div>

    <PanControl
      :model-value="track.pan"
      :kind="track.kind"
      label="声像"
      compact
      @change="setPan"
    />

    <div class="ns-strip__toggles">
      <el-button size="small" :type="track.isMute ? 'danger' : 'default'" @click.stop="setMute(!track.isMute)">
        M
      </el-button>
      <el-button size="small" :type="track.isSolo ? 'warning' : 'default'" @click.stop="setSolo(!track.isSolo)">
        S
      </el-button>
      <span class="ns-strip__level">{{ formatDb(track.gainDb) }} dB</span>
    </div>

    <div class="ns-strip__preset">
      <el-select
        :model-value="track.presetId ?? ''"
        size="small"
        clearable
        filterable
        placeholder="未绑定预设"
        @change="bindPreset"
      >
        <el-option label="不处理（仅统一格式）" value="" />
        <el-option
          v-for="preset in presets.filtered"
          :key="preset.id"
          :label="preset.builtin ? `${preset.name}（内置）` : preset.name"
          :value="preset.id"
        />
      </el-select>
      <el-button
        v-if="track.kind === 'voice' && boundPreset"
        size="small"
        text
        title="把该预设套用到本角色的全部轨道"
        @click.stop="bindToCharacter"
      >
        套用到该角色
      </el-button>
      <p v-else-if="boundPreset" class="ns-strip__preset-hint">{{ presets.summaryOf(boundPreset) }}</p>
    </div>

    <p v-if="duckingBroken" class="ns-strip__warn">
      Solo 已把所有人声压住 → 闪避没有侧链源，BGM 不会下潜（MIX_DUCKING_SIDECHAIN_MISSING）
    </p>
    <p v-else-if="dimmed" class="ns-strip__dim">有其他轨道处于 Solo，本轨当前不发声</p>

    <footer class="ns-strip__ops">
      <el-button size="small" :disabled="!canMoveUp" @click.stop="mix.moveTrack(track.id, -1)">上移</el-button>
      <el-button size="small" :disabled="!canMoveDown" @click.stop="mix.moveTrack(track.id, 1)">下移</el-button>
      <el-button v-if="track.kind !== 'voice'" size="small" @click.stop="emit('edit-music', track.id)">
        BGM 配置
      </el-button>
      <el-button size="small" type="danger" text @click.stop="removing = true">删除</el-button>
    </footer>

    <div class="ns-strip__add">
      <span class="ns-strip__add-label">新增</span>
      <el-button size="small" text @click.stop="addAfter('voice')">人声</el-button>
      <el-button size="small" text @click.stop="addAfter('music')">BGM</el-button>
      <el-button size="small" text @click.stop="addAfter('sfx')">音效</el-button>
    </div>

    <ConfirmDialog
      :model-value="removing"
      title="删除轨道"
      :message="`删除轨道「${track.name}」？该轨的增益/声像/预设绑定会一起删除（录音素材不受影响）。`"
      type="danger"
      confirm-text="删除轨道"
      @confirm="confirmRemove"
      @cancel="removing = false"
    />
  </article>
</template>

<style scoped>
.ns-strip {
  display: flex; flex-direction: column; gap: 6px; width: 168px; padding: 8px;
  border: 1px solid var(--ns-border, #dcdfe6); border-radius: 8px;
  background: var(--ns-bg-elevated, #fff); cursor: pointer;
}
.ns-strip.is-selected { border-color: var(--ns-primary, #409eff); box-shadow: 0 0 0 2px rgb(64 158 255 / 14%); }
.ns-strip.is-dimmed { opacity: 0.6; }
.ns-strip.is-kind-music { background: var(--ns-bg-subtle, #fafafa); }
.ns-strip__head { display: flex; align-items: center; gap: 4px; }
.ns-strip__role { flex: 1; overflow: hidden; color: var(--ns-text-regular, #606266); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.ns-strip__seq { color: var(--ns-text-secondary, #909399); font: 10px/1 ui-monospace, Consolas, monospace; }
.ns-strip__name :deep(.el-input__inner) { font-size: 12px; }
.ns-strip__body { display: flex; align-items: flex-end; justify-content: center; gap: 6px; }
.ns-strip__toggles { display: flex; align-items: center; gap: 4px; }
.ns-strip__level { margin-left: auto; color: var(--ns-text-secondary, #909399); font: 10.5px/1 ui-monospace, Consolas, monospace; }
.ns-strip__preset { display: flex; flex-direction: column; gap: 3px; }
.ns-strip__preset-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 10.5px; line-height: 1.4; }
.ns-strip__warn { margin: 0; color: var(--ns-warning, #e6a23c); font-size: 10.5px; line-height: 1.45; }
.ns-strip__dim { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 10.5px; }
.ns-strip__ops { display: flex; flex-wrap: wrap; gap: 3px; }
.ns-strip__add { display: flex; align-items: center; gap: 2px; border-top: 1px dashed var(--ns-border, #dcdfe6); padding-top: 4px; }
.ns-strip__add-label { color: var(--ns-text-secondary, #909399); font-size: 10.5px; }
</style>
