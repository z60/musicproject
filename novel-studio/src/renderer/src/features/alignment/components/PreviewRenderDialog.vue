<!--
  Novel Studio · 轻量渲染预览（docs/13 §6.2 / FR-6.10）
  ============================================================================
  设计依据：
    · docs/13 §6.2 —— 试听用的是**渲染进程的播放器混音**（Web Audio 按
      `timelineStartMs` 调度），与最终 ffmpeg 渲染结果**可能有细微差异**，
      尤其是 ducking（闪避）这类依赖真实处理链的环节。因此在导出前提供
      「渲染前 N 秒」按钮，用真实的 ffmpeg 管线渲染一小段来确认预设。
      ★ 这句差异说明必须写在界面上（docs/13 §6.2 的原文要求），
        否则用户会把「试听没闪避」当成 bug。
    · docs/04 §2.4 —— 长任务进度**统一用 TaskProgressCard**，禁止自建进度 UI；
      取消/重试也一律走任务中心（`task:cancel` / `task:retry`）。
    · docs/15 §5.5 —— 导出向导第 3 步要选混音方案；预览渲染同样要能选
      （`alignment:previewRender` 的 `mixProjectId`），因为 ducking / BGM 音量
      都写在混音方案里，不选就等于「没有 BGM 的版本」。

  本组件只做三件事：收集参数 → 提交任务 → 完成后把结果交给 <audio> 播放。
  结果路径解析是**防御式**的：契约只声明 `{ taskId }`，没有声明结果形状，
  因此依次尝试 path / filePath / outputPath，都拿不到就明确说「没有可播放路径」，
  绝不假装播放成功。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Id, MixProject } from '@shared/types.ts'
import { formatDuration, UNKNOWN } from '@/shared/lib/format.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { tryBuildMediaUrl } from '@/shared/lib/media-url.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useTasksStore } from '@/app/store/tasks.store.ts'

const props = withDefaults(defineProps<{
  /** 对话框可见性（v-model） */
  modelValue: boolean
  /** 方案 id（previewRender 必需） */
  arrangementId?: Id | null
  /** 章节 id（列混音方案用） */
  chapterId?: Id | null
  /** 默认起始时间（一般传当前播放头；0 = 从章首开始） */
  initialStartMs?: number
  /** 默认时长：docs/13 §6.2 要求「前 30 秒」 */
  defaultDurationMs?: number
}>(), {
  arrangementId: null,
  chapterId: null,
  initialStartMs: 0,
  defaultDurationMs: 30_000,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 打开任务中心（TaskProgressCard 的「查看」） */
  'open-tasks': []
  /** 渲染成功且拿到可播放路径（视图可用于记日志/埋点） */
  rendered: [payload: { taskId: Id; path: string | null }]
}>()

const session = useSessionStore()
const tasks = useTasksStore()

/** 预览参数 */
const startMs = ref(0)
const durationMs = ref(props.defaultDurationMs)
const mixProjectId = ref<Id | null>(null)

/** 混音方案列表（可选：带上 BGM/ducking） */
const mixProjects = ref<MixProject[]>([])
const loadingProjects = ref(false)

/** 任务 id → 订阅进度（useTaskProgress 支持传 ref，换任务自动重绑） */
const taskId = ref<Id | null>(null)
const live = useTaskProgress(taskId)

/** 渲染结果 */
const resultPath = ref<string | null>(null)
const resultLoaded = ref(false)
const resultMissing = ref(false)

const previewResult = ref<{ path: string | null; durationMs: number | null } | null>(null)

/** DURATION 预设：15 / 30 / 60 秒（默认 30 s，docs/13 §6.2） */
const DURATION_PRESETS = [15_000, 30_000, 60_000] as const

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const canSubmit = computed(() => Boolean(props.arrangementId) && durationMs.value > 0 && !live.isRunning.value)

const rangeText = computed(() => `${formatDuration(startMs.value, { showMs: true })} → ${formatDuration(startMs.value + durationMs.value, { showMs: true })}`)

const playerUrl = computed(() => {
  const path = resultPath.value
  if (!path) return null
  return tryBuildMediaUrl(session.projectId, path)
})

const mixHint = computed(() => {
  if (!mixProjects.value.length) return '本章还没有混音方案：预览只渲染对轨后的干声（没有 BGM / 闪避）。'
  if (!mixProjectId.value) return '未选择混音方案：预览不会包含 BGM 与 ducking。'
  const hit = mixProjects.value.find(p => p.id === mixProjectId.value)
  return hit ? `使用混音方案「${hit.name}」：包含 BGM、音量与 ducking。` : ''
})

// ---------------------------------------------------------------------------
// 打开时：复位参数 + 拉混音方案
// ---------------------------------------------------------------------------

watch(() => props.modelValue, async (open) => {
  if (!open) return
  startMs.value = Math.max(0, Math.round(props.initialStartMs))
  durationMs.value = props.defaultDurationMs
  mixProjectId.value = null
  taskId.value = null
  resultPath.value = null
  resultLoaded.value = false
  resultMissing.value = false
  previewResult.value = null
  await loadMixProjects()
})

async function loadMixProjects(): Promise<void> {
  const chapterId = props.chapterId ?? session.chapterId
  if (!chapterId) return
  loadingProjects.value = true
  try {
    const list = await callSafe('mix:listProjects', { chapterId })
    mixProjects.value = list ?? []
  } finally {
    loadingProjects.value = false
  }
}

// ---------------------------------------------------------------------------
// 提交任务
// ---------------------------------------------------------------------------

async function submit(): Promise<void> {
  const arrangementId = props.arrangementId
  if (!arrangementId || !canSubmit.value) return
  resultPath.value = null
  resultLoaded.value = false
  resultMissing.value = false
  previewResult.value = null
  try {
    const res = await call('alignment:previewRender', {
      arrangementId,
      mixProjectId: mixProjectId.value,
      startMs: Math.max(0, Math.round(startMs.value)),
      durationMs: Math.max(500, Math.round(durationMs.value)),
    })
    taskId.value = res.taskId
  } catch {
    // 失败提示由 ipc.call 交给 error-bus；这里不留半截任务 id
    taskId.value = null
  }
}

/**
 * 任务完成 → 取结果。
 * 契约只说返回 `{ taskId }`，结果的真实形状没有声明，因此这里按已知的几种字段名依次尝试。
 */
async function loadResult(id: Id): Promise<void> {
  if (resultLoaded.value) return
  resultLoaded.value = true
  interface PreviewResultShape {
    path?: string
    filePath?: string
    outputPath?: string
    durationMs?: number
  }
  const res = await tasks.result<PreviewResultShape>(id)
  const path = res?.path ?? res?.filePath ?? res?.outputPath ?? null
  resultPath.value = path
  resultMissing.value = path === null
  previewResult.value = { path, durationMs: res?.durationMs ?? null }
  emit('rendered', { taskId: id, path })
}

watch(
  () => live.status.value,
  (status) => {
    const id = taskId.value
    if (!id) return
    if (status === 'succeeded') void loadResult(id)
  },
)

// ---------------------------------------------------------------------------
// 任务卡事件 → 任务中心
// ---------------------------------------------------------------------------

async function onCancel(id: string): Promise<void> {
  await tasks.cancel(id)
}

async function onRetry(id: string): Promise<void> {
  const next = await tasks.retry(id)
  if (next) {
    taskId.value = next
    resultLoaded.value = false
    resultPath.value = null
    resultMissing.value = false
  }
}

function onClose(): void {
  taskId.value = null
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="轻量渲染预览"
    width="560px"
    append-to-body
    destroy-on-close
  >
    <div class="ns-preview">
      <!-- 参数 -->
      <div class="ns-preview__row">
        <label class="ns-preview__label">起始时间</label>
        <el-input-number
          v-model="startMs"
          :min="0"
          :step="1000"
          size="small"
          controls-position="right"
          :disabled="live.isRunning.value"
        />
        <span class="ns-preview__unit">ms</span>
        <el-button size="small" text :disabled="live.isRunning.value" @click="startMs = 0">回到章首</el-button>
      </div>

      <div class="ns-preview__row">
        <label class="ns-preview__label">时长</label>
        <el-input-number
          v-model="durationMs"
          :min="500"
          :max="300000"
          :step="1000"
          size="small"
          controls-position="right"
          :disabled="live.isRunning.value"
        />
        <span class="ns-preview__unit">ms</span>
        <el-button
          v-for="preset in DURATION_PRESETS"
          :key="preset"
          size="small"
          :type="durationMs === preset ? 'primary' : 'default'"
          :disabled="live.isRunning.value"
          @click="durationMs = preset"
        >
          {{ preset / 1000 }} s
        </el-button>
      </div>

      <div class="ns-preview__row">
        <label class="ns-preview__label">混音方案</label>
        <el-select
          v-model="mixProjectId"
          size="small"
          class="ns-preview__select"
          clearable
          placeholder="不选 = 只渲染干声"
          :loading="loadingProjects"
          :disabled="live.isRunning.value"
        >
          <el-option
            v-for="project in mixProjects"
            :key="project.id"
            :value="project.id"
            :label="project.name"
          />
        </el-select>
        <span class="ns-preview__range">{{ rangeText }}</span>
      </div>

      <p class="ns-preview__hint">{{ mixHint }}</p>

      <!-- ★ 差异说明（docs/13 §6.2 原文要求） -->
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="试听是播放器混音，渲染结果可能有细微差异"
        description="时间线上的试听由 Web Audio 按片段实时调度；这里的预览走真实 ffmpeg 管线。两者在淡入淡出、响度归一与闪避（ducking）上可能有可听差异——以本预览为准。"
      />

      <div class="ns-preview__actions">
        <el-button type="primary" size="small" :disabled="!canSubmit" :loading="live.isRunning.value" @click="submit">
          {{ taskId ? '重新渲染这一段' : '渲染这一段' }}
        </el-button>
        <span v-if="!arrangementId" class="ns-preview__blocked">尚未选择方案，无法预览渲染</span>
      </div>

      <!-- 任务进度：统一卡片（docs/04 §2.4） -->
      <TaskProgressCard
        v-if="taskId"
        :task-id="taskId"
        title="轻量渲染预览"
        kind="audio.render"
        cancelable
        retryable
        closable
        openable
        @cancel="onCancel"
        @retry="onRetry"
        @close="onClose"
        @open="emit('open-tasks')"
      />

      <!-- 完成后试听 -->
      <section v-if="taskId && live.status.value === 'succeeded'" class="ns-preview__result">
        <div class="ns-preview__result-head">
          <strong>渲染完成</strong>
          <span class="ns-preview__muted">
            {{ previewResult?.durationMs ? formatDuration(previewResult.durationMs, { showMs: true }) : UNKNOWN }}
          </span>
        </div>
        <div v-if="playerUrl" class="ns-preview__player">
          <!-- 结果文件走 ns-media:// 协议（相对项目根），不直接用 file:// -->
          <audio :src="playerUrl" controls preload="metadata" />
        </div>
        <p v-else-if="resultMissing" class="ns-preview__muted">
          任务已完成，但结果里没有可播放的文件路径（契约未声明结果形状）。
          请到任务中心查看该任务的日志与输出文件。
        </p>
        <el-button size="small" text @click="emit('open-tasks')">去任务中心查看输出</el-button>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.ns-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.ns-preview__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ns-preview__label {
  flex: 0 0 auto;
  width: 62px;
  color: var(--ns-text-secondary, #909399);
}
.ns-preview__unit {
  color: var(--ns-text-secondary, #909399);
}
.ns-preview__select {
  width: 200px;
}
.ns-preview__range {
  margin-left: auto;
  color: var(--ns-text-regular, #606266);
  font-variant-numeric: tabular-nums;
}
.ns-preview__hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-preview__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-preview__blocked {
  color: var(--ns-danger, #f56c6c);
  font-size: 11px;
}
.ns-preview__result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--ns-border, #ebeef5);
  border-radius: 6px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-preview__result-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ns-text-primary, #303133);
}
.ns-preview__muted {
  color: var(--ns-text-secondary, #909399);
  font-weight: 400;
}
.ns-preview__player audio {
  width: 100%;
}
</style>
