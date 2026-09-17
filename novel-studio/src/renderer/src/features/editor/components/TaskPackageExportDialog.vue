<!--
  Novel Studio · 任务包导出对话框 .nst（docs/11 §6.2「任务包导出 FR-7.3」）
  ============================================================================
  设计依据（严格按 docs/11 §6.2 的五步）：
    1. 选择目标配音员（或按角色选择）
    2. 预览清单：行数、字数、预估时长、涉及章节
    3. 选项：包含上下文 / 包含参考音（显著增大包体积）/ 包含发音提示与备注 /
       允许该配音员看到其它角色的词（默认关）/ 录音建议（采样率·位深·声道·推荐增益·文件名模板）
    4. 生成 .nst（zip）—— 长任务，只拿 taskId
    5. 记录导出记录（packageId + linesHash + 时间），供回收时比对

  另外两项硬约束：
    · docs/04 §2.4 —— 长任务进度**禁止自建 UI**，统一用 TaskProgressCard（本文件只喂 taskId）。
    · docs/11 §6.5 —— `linesHash` 不一致时要能「仅重发变更行」，因此这里提供 `onlyChangedLines`
      （选项写在 packages.store 的 exportOptions 里，导出时一并交给主进程）。
    · docs/15 §5.3 + shared/lib/template.ts —— 文件名模板必须**实时预览**，并且用与主进程
      同一个 buildFileName，避免「预览一个样、写盘另一个样」。

  状态分工：所有导出参数与任务 id 都在 packages.store（切页/关窗不丢），
  本组件只持有「表单草稿 → 提交时写回 store」这一层薄映射。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Chapter, Id, VoiceActor } from '@shared/types.ts'
import { formatCount, formatDuration, formatDurationLong, formatInt } from '@/shared/lib/format.ts'
import { call } from '@/shared/lib/ipc.ts'
import { buildFileName } from '@/shared/lib/template.ts'
import EmptyState from '@/shared/ui/EmptyState.vue'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { useCharactersStore } from '@/features/editor/stores/characters.store.ts'
import { usePackagesStore } from '@/features/editor/stores/packages.store.ts'
import type { NstRecordSettings } from '@/features/editor/stores/packages.store.ts'

const props = withDefaults(defineProps<{
  /** 双向绑定：是否显示 */
  modelValue: boolean
  /** 只读（例如任务包模式下不允许再导出） */
  readonly?: boolean
}>(), { readonly: false })

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 导出结束（父组件可刷新历史 / 提示进入回收流程） */
  exported: [filePath: string]
}>()

const session = useSessionStore()
const characters = useCharactersStore()
const packages = usePackagesStore()

// ── 表单草稿（打开时从 store 的 exportOptions 初始化）────────────────────────
const actorId = ref<Id | null>(null)
const chapterIds = ref<Id[]>([])
const characterIds = ref<Id[]>([])
const includeContext = ref(true)
const includeReference = ref(false)
const includeNotes = ref(true)
const allowOtherCharacterLines = ref(false)
const onlyChangedLines = ref(false)
const record = ref<NstRecordSettings>({ ...packages.exportOptions.recordSettings })

const chapters = ref<Chapter[]>([])
const loadingChapters = ref(false)
const feedback = ref('')

const bookId = computed<Id | null>(() => session.book?.id ?? null)
const projectId = computed<Id | null>(() => session.projectId)
const book = computed(() => session.book)

// ── 任务 ─────────────────────────────────────────────────────────────────────
const taskId = ref<Id | null>(null)
const exported = ref<{ filePath: string; actorName: string; lineCount: number; hasReference: boolean } | null>(null)
const live = useTaskProgress(computed(() => taskId.value))

// 任务成功结束 → 取结果并落进 store 的导出记录（回收比对的 linesHash 由主进程写入）
watch([live.isFinished, live.status], async ([finished, status]) => {
  if (!finished || status !== 'succeeded') {
    if (finished && status !== 'succeeded') feedback.value = '导出任务未成功结束，可重试或到任务中心查看原因。'
    return
  }
  const id = taskId.value
  if (!id) return
  const result = await callSafeResult(id)
  if (!result) {
    feedback.value = '任务已完成，但没读到导出结果，可在任务中心查看详情。'
    return
  }
  const actorName = actor.value?.name ?? '未命名配音员'
  exported.value = {
    filePath: result.filePath ?? '',
    actorName,
    lineCount: result.lineCount ?? 0,
    hasReference: result.hasReference ?? includeReference.value,
  }
  if (exported.value.filePath) {
    packages.noteExportDone(exported.value)
    feedback.value = '导出完成。'
    emit('exported', exported.value.filePath)
  }
})

interface ExportTaskResult {
  filePath?: string
  lineCount?: number
  hasReference?: boolean
}

async function callSafeResult(id: Id): Promise<ExportTaskResult | null> {
  // 走统一的 call，失败交给 error-bus（这里是「任务结果读取」这一条明确动作）
  try {
    return await call('task:result', { taskId: id }) as ExportTaskResult
  } catch {
    return null
  }
}

// ── 派生数据 ─────────────────────────────────────────────────────────────────
const actor = computed<VoiceActor | null>(() => characters.actors.find(a => a.id === actorId.value) ?? null)

/** 该配音员绑定的角色（选项里默认不勾选 = 用绑定的全部角色） */
const boundCharacters = computed(() => {
  const id = actorId.value
  if (!id) return []
  const bound = new Set(characters.bindings.filter(b => b.actorId === id).map(b => b.characterId))
  return characters.activeCharacters.filter(c => bound.has(c.id))
})

/** 该配音员在本书的工作量（预览清单第 2 步的数据来源） */
const workload = computed(() => characters.workload.find(w => w.actorId === actorId.value) ?? null)

const selectedChapters = computed(() => chapters.value.filter(c => chapterIds.value.includes(c.id)))

const scopeText = computed(() => {
  const parts: string[] = []
  parts.push(actorId.value ? `配音员：${actor.value?.name ?? '—'}` : '配音员：未选择')
  parts.push(characterIds.value.length
    ? `角色：${formatCount(characterIds.value.length)} 个`
    : (boundCharacters.value.length ? `角色：绑定的 ${formatCount(boundCharacters.value.length)} 个` : '角色：全部'))
  parts.push(chapterIds.value.length
    ? `章节：${formatCount(chapterIds.value.length)} 章`
    : `章节：全书 ${formatCount(book.value?.chapterCount ?? chapters.value.length)} 章`)
  return parts.join(' · ')
})

/** 文件名模板预览（与主进程同一个 buildFileName，docs/15 §5.3） */
const fileNamePreview = computed(() => {
  const first = selectedChapters.value[0] ?? chapters.value[0] ?? null
  return buildFileName(record.value.fileNameTemplate, {
    bookTitle: book.value?.title ?? null,
    author: book.value?.author ?? null,
    chapterIndex: first?.seq ?? null,
    chapterTitle: first?.title ?? null,
    volumeTitle: first?.volumeTitle ?? null,
    narrator: actor.value?.name ?? book.value?.narrator ?? null,
    date: new Date(),
    totalChapters: book.value?.chapterCount ?? chapters.value.length,
  }, '.wav')
})

// ── 打开时初始化 ─────────────────────────────────────────────────────────────
watch(() => props.modelValue, async (visible) => {
  if (!visible) return
  feedback.value = ''
  exported.value = null
  const options = packages.exportOptions
  includeContext.value = options.includeContext
  includeReference.value = options.includeReference
  includeNotes.value = options.includeNotes
  allowOtherCharacterLines.value = options.allowOtherCharacterLines
  onlyChangedLines.value = options.onlyChangedLines
  characterIds.value = [...options.characterIds]
  chapterIds.value = [...options.chapterIds]
  record.value = { ...options.recordSettings }
  if (!actorId.value) actorId.value = packages.lastExportActorId ?? session.actorId ?? null
  await ensureData()
})

async function ensureData(): Promise<void> {
  characters.setProjectId(projectId.value)
  characters.setBookId(bookId.value)
  // 角色表与配音员列表都要有（导出范围与预览清单都依赖它们）
  await Promise.all([
    characters.loadActors(),
    characters.loadWorkload(),
    characters.characters.length ? Promise.resolve() : characters.load(bookId.value, projectId.value),
  ])
  await loadChapters()
}

async function loadChapters(): Promise<void> {
  if (!bookId.value) {
    chapters.value = []
    return
  }
  loadingChapters.value = true
  try {
    chapters.value = await call('chapter:list', { bookId: bookId.value })
  } finally {
    loadingChapters.value = false
  }
}

function selectAllChapters(): void {
  chapterIds.value = chapters.value.map(c => c.id)
}

function clearChapters(): void {
  chapterIds.value = []
}

// ── 提交导出 ─────────────────────────────────────────────────────────────────
function snapshotOptions(): void {
  packages.setExportOptions({
    includeContext: includeContext.value,
    includeReference: includeReference.value,
    includeNotes: includeNotes.value,
    allowOtherCharacterLines: allowOtherCharacterLines.value,
    onlyChangedLines: onlyChangedLines.value,
    characterIds: [...characterIds.value],
    chapterIds: [...chapterIds.value],
    fileNameTemplate: record.value.fileNameTemplate,
    recordSettings: { ...record.value },
  })
}

async function startExport(): Promise<void> {
  feedback.value = ''
  exported.value = null
  if (props.readonly) {
    feedback.value = '当前为只读模式，不能导出任务包。'
    return
  }
  if (!bookId.value) {
    feedback.value = '还没有选中书籍：先到书架选择一本书。'
    return
  }
  if (!actorId.value) {
    feedback.value = '先选择目标配音员：任务包是按配音员下发的。'
    return
  }
  snapshotOptions()
  taskId.value = await packages.exportTask(bookId.value, actorId.value)
  if (!taskId.value) feedback.value = '导出没有启动成功（详见提示），可检查导出目录后重试。'
}

async function openFolder(): Promise<void> {
  const file = exported.value?.filePath ?? packages.lastExport?.filePath
  if (!file) {
    feedback.value = '还没有导出结果，无法定位文件夹。'
    return
  }
  await call('app:showItemInFolder', { path: file })
}

function close(): void {
  emit('update:modelValue', false)
}

/** 对话框显隐：el-dialog 的 update:model-value 载荷为 boolean */
function onVisibleInput(value: boolean): void {
  emit('update:modelValue', value)
}

const SAMPLE_RATES = [48000, 44100] as const
const BIT_DEPTHS = [16, 24, 32] as const
const CHANNELS = [1, 2] as const
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    title="导出任务包（.nst）"
    width="720px"
    :close-on-click-modal="false"
    @update:model-value="onVisibleInput"
  >
    <div class="ns-nst">
      <EmptyState
        v-if="!bookId"
        size="small"
        icon="📚"
        title="还没有选中书籍"
        description="任务包按书下发：先在书架打开一本书，再回到这里导出。"
      />

      <template v-else>
        <!-- 1. 配音员 -->
        <section class="ns-nst__section">
          <h4 class="ns-nst__title">1. 目标配音员</h4>
          <div class="ns-nst__row">
            <el-select v-model="actorId" size="small" filterable placeholder="选择配音员" class="ns-nst__select">
              <el-option v-for="item in characters.actors" :key="item.id" :value="item.id" :label="item.name" />
            </el-select>
            <span class="ns-nst__muted">
              <template v-if="boundCharacters.length">
                已绑定角色：{{ boundCharacters.map(c => c.name).join('、') }}
              </template>
              <template v-else-if="actorId">该配音员还没有绑定角色，包里将按「选择的角色」下发。</template>
              <template v-else>还没有配音员？先在角色表里新建并绑定角色。</template>
            </span>
          </div>
        </section>

        <!-- 2. 预览清单 -->
        <section class="ns-nst__section">
          <h4 class="ns-nst__title">2. 预览清单</h4>
          <ul class="ns-nst__stats">
            <li>行数：<strong>{{ formatInt(workload?.lines ?? 0) }}</strong> 行</li>
            <li>字数：{{ formatCount(workload?.chars ?? 0) }} 字</li>
            <li>预估时长：{{ formatDurationLong(workload?.estimatedDurationMs ?? 0) }}</li>
            <li>已录：{{ formatInt(workload?.recordedCount ?? 0) }} 行</li>
            <li>涉及章节：{{ chapterIds.length ? formatCount(chapterIds.length) : formatCount(book?.chapterCount ?? chapters.length) }} 章</li>
          </ul>
          <p class="ns-nst__muted">
            以上为「该配音员在本书」的全部工作量；勾选章节范围后实际下发会更少。
            {{ scopeText }}
          </p>
        </section>

        <!-- 3. 范围与选项 -->
        <section class="ns-nst__section">
          <h4 class="ns-nst__title">3. 范围与选项</h4>

          <div class="ns-nst__row">
            <span class="ns-nst__label">角色范围</span>
            <el-select v-model="characterIds" size="small" multiple collapse-tags placeholder="默认：该配音员绑定的全部角色" class="ns-nst__select is-wide">
              <el-option v-for="item in characters.activeCharacters" :key="item.id" :value="item.id" :label="item.name" />
            </el-select>
          </div>

          <div class="ns-nst__row">
            <span class="ns-nst__label">章节范围</span>
            <el-select v-model="chapterIds" size="small" multiple collapse-tags placeholder="默认：全书" class="ns-nst__select is-wide">
              <el-option v-for="item in chapters" :key="item.id" :value="item.id" :label="`${item.seq}. ${item.title}`" />
            </el-select>
            <el-button size="small" text :loading="loadingChapters" @click="selectAllChapters">全选</el-button>
            <el-button size="small" text @click="clearChapters">清空</el-button>
          </div>

          <div class="ns-nst__checks">
            <el-checkbox v-model="includeContext">包含上下文（前后各 1 行，帮助入戏）</el-checkbox>
            <el-checkbox v-model="includeReference">包含参考音（对手戏片段；会显著增大包体积）</el-checkbox>
            <el-checkbox v-model="includeNotes">包含发音提示与备注</el-checkbox>
            <el-checkbox v-model="allowOtherCharacterLines">允许看到其它角色的词（默认关，只看自己的更专注）</el-checkbox>
            <el-checkbox v-model="onlyChangedLines">仅重发变更行（增量下发，需已有上次导出记录）</el-checkbox>
          </div>
        </section>

        <!-- 4. 录音建议 -->
        <section class="ns-nst__section">
          <h4 class="ns-nst__title">4. 录音建议（写进包里的 manifest，配音员侧照此录音）</h4>
          <div class="ns-nst__row">
            <span class="ns-nst__label">采样率</span>
            <el-select v-model="record.sampleRate" size="small" class="ns-nst__select is-narrow">
              <el-option v-for="item in SAMPLE_RATES" :key="item" :value="item" :label="`${item} Hz`" />
            </el-select>
            <span class="ns-nst__label">位深</span>
            <el-select v-model="record.bitDepth" size="small" class="ns-nst__select is-narrow">
              <el-option v-for="item in BIT_DEPTHS" :key="item" :value="item" :label="`${item} bit`" />
            </el-select>
            <span class="ns-nst__label">声道</span>
            <el-select v-model="record.channels" size="small" class="ns-nst__select is-narrow">
              <el-option v-for="item in CHANNELS" :key="item" :value="item" :label="item === 1 ? '单声道' : '立体声'" />
            </el-select>
          </div>
          <div class="ns-nst__row">
            <span class="ns-nst__label">推荐增益</span>
            <el-input-number v-model="record.recommendGainDb" size="small" :min="-24" :max="12" :step="1" controls-position="right" class="ns-nst__number" />
            <span class="ns-nst__muted">dB</span>
            <span class="ns-nst__label">目标峰值</span>
            <el-input-number v-model="record.targetPeakDb" size="small" :min="-24" :max="0" :step="1" controls-position="right" class="ns-nst__number" />
            <span class="ns-nst__muted">dBFS</span>
          </div>
          <div class="ns-nst__row">
            <span class="ns-nst__label">文件名模板</span>
            <el-input v-model="record.fileNameTemplate" size="small" class="ns-nst__select is-wide" placeholder="{lineId}_{take}.wav" />
          </div>
          <p class="ns-nst__preview">
            预览：<code>{{ fileNamePreview.fileName }}</code>
            <span v-if="fileNamePreview.dir" class="ns-nst__muted">（目录：{{ fileNamePreview.dir }}）</span>
            <span v-if="fileNamePreview.unknownTokens.length" class="ns-nst__warn">
              含导出侧不认识的占位符：{{ fileNamePreview.unknownTokens.join('、') }}（如 {lineId} / {take} 由录音链路替换）
            </span>
          </p>
        </section>

        <!-- 5. 执行与结果 -->
        <section class="ns-nst__section">
          <h4 class="ns-nst__title">5. 生成任务包</h4>
          <div class="ns-nst__row">
            <el-button type="primary" :disabled="props.readonly || !actorId" :loading="packages.busy" @click="startExport">
              开始导出
            </el-button>
            <el-button @click="openFolder">打开导出文件夹</el-button>
            <el-button text @click="close">关闭</el-button>
          </div>

          <TaskProgressCard
            v-if="taskId"
            :task-id="taskId"
            title="导出任务包"
            kind="package.export"
            @close="taskId = null"
            @retry="startExport"
          />

          <div v-if="exported" class="ns-nst__result">
            <p>
              导出完成：<strong>{{ exported.actorName }}</strong>
              · {{ formatCount(exported.lineCount) }} 行
              · {{ exported.hasReference ? '含参考音' : '不含参考音' }}
            </p>
            <p class="ns-nst__path">{{ exported.filePath || '（主进程未返回文件路径）' }}</p>
            <el-button size="small" @click="openFolder">打开文件夹</el-button>
          </div>

          <p v-if="packages.lastExport && !exported" class="ns-nst__muted">
            上次导出：{{ packages.lastExport.actorName }} · {{ formatCount(packages.lastExport.lineCount) }} 行 ·
            {{ packages.lastExport.hasReference ? '含参考音' : '不含参考音' }}
          </p>

          <p v-if="feedback" class="ns-nst__feedback">{{ feedback }}</p>
        </section>
      </template>
    </div>

    <template #footer>
      <span class="ns-nst__muted">
        预估下发时长 {{ formatDuration(workload?.estimatedDurationMs ?? 0) }}；导出记录会自动写入历史，供回收时比对 linesHash。
      </span>
    </template>
  </el-dialog>
</template>

<style scoped>
.ns-nst { display: flex; flex-direction: column; gap: 12px; max-height: 62vh; overflow: auto; }
.ns-nst__section { padding-bottom: 8px; border-bottom: 1px dashed var(--ns-border-light, #e4e7ed); }
.ns-nst__section:last-child { border-bottom: none; }
.ns-nst__title { margin: 0 0 6px; color: var(--ns-text-primary, #303133); font-size: 12px; font-weight: 600; }
.ns-nst__row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.ns-nst__label { color: var(--ns-text-regular, #606266); font-size: 12px; }
.ns-nst__select { width: 180px; } .ns-nst__select.is-wide { width: 320px; } .ns-nst__select.is-narrow { width: 108px; } .ns-nst__number { width: 112px; }
.ns-nst__muted { color: var(--ns-text-secondary, #909399); font-size: 11px; } .ns-nst__warn { color: var(--ns-warning, #e6a23c); font-size: 11px; }
.ns-nst__stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 4px; padding: 0; list-style: none; color: var(--ns-text-regular, #606266); font-size: 12px; }
.ns-nst__checks { display: flex; flex-direction: column; gap: 2px; }
.ns-nst__preview { margin: 0; color: var(--ns-text-regular, #606266); font-size: 12px; } .ns-nst__preview code { padding: 0 4px; border-radius: 2px; background: var(--ns-fill-light, #f5f7fa); }
.ns-nst__result { margin-top: 8px; padding: 8px; border-radius: 4px; background: rgb(103 194 58 / 10%); font-size: 12px; } .ns-nst__result p { margin: 0 0 4px; }
.ns-nst__path { color: var(--ns-text-secondary, #909399); word-break: break-all; } .ns-nst__feedback { margin: 6px 0 0; color: var(--ns-warning, #e6a23c); font-size: 12px; }
</style>
