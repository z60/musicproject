<!--
  画本编辑 · 角色表（docs/11 §4.6）
  ============================================================================
  功能清单（逐条对应文档表格）：
    增删改        名称、别名（多标签）、性别、年龄段、性格描述、备注、颜色、默认表演参数
    别名管理      别名参与判定（拼进原型文本），所以改名/增删别名后必须提示重算归属
    自动抽取      从文本提取候选角色名 → 一键添加（CharacterCandidate）
    合并          多选 → CharacterMergeDialog（别名冲突 + 将影响 N 行）
    归档          不物理删除（保留引用），只标 archived，可恢复
    配音员绑定    角色 → 配音员（主 / 备）；一个配音员可多角色
    默认表演参数  默认语速/情绪/音量偏移/停顿（画本行未指定时继承）
    出场统计      行数、字数、预估时长、已录时长（character:stats）

  两处刻意的「多一步」：
    · 改名或删别名后弹出「需要重算归属」提示条，给「仅低置信 / 全量」两个按钮
      （docs/11 §4.6 + ATTRIBUTION_RECOMPUTE_REQUIRED：不重算的话判定结果会与角色表脱节）。
    · 合并前一定先看冲突清单，不让人盲合。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AgeGroup, Character, Gender, Id, SpeedMark } from '@shared/types.ts'
import { EMOTIONS, SPEED_OPTIONS } from '@shared/constants.ts'
import { formatCount, formatDuration, formatInt } from '@/shared/lib/format.ts'
import { reportByKey } from '@/shared/lib/error-bus.ts'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import CharacterMergeDialog from './CharacterMergeDialog.vue'
import { useCanvasStore } from '../stores/canvas.store.ts'
import { useCharactersStore } from '../stores/characters.store.ts'

const props = withDefaults(defineProps<{
  /** 只读（任务包模式） */
  readonly?: boolean
  /** 当前章节 id（抽取候选时作为范围提示） */
  chapterId?: Id | null
}>(), {
  readonly: false,
  chapterId: null,
})

const emit = defineEmits<{
  /** 请求把某行滚到视野（点统计里的「看台词」） */
  'focus-character': [characterId: Id]
  /** 角色表变化（父组件刷新状态栏） */
  changed: []
}>()

const canvas = useCanvasStore()
const characters = useCharactersStore()

const GENDER_LABELS: Record<Gender, string> = { male: '男', female: '女', other: '其他', unknown: '未定' }
const AGE_LABELS: Record<AgeGroup, string> = {
  child: '儿童', teen: '少年', young: '青年', middle: '中年', elder: '老年', unknown: '未定',
}

const keyword = ref('')
const archivePromptOpen = ref(false)
/** 编辑表单（新建或修改） */
const editOpen = ref(false)
const editingId = ref<Id | null>(null)
const editForm = ref<{
  name: string
  aliases: string[]
  gender: Gender | null
  ageGroup: AgeGroup | null
  description: string
  note: string
  color: string
  defaultSpeed: SpeedMark | null
  defaultEmotion: string | null
  /** 表单里用 undefined 表示「未填」（el-input-number 的口径），保存时转回 null */
  defaultGainDb: number | undefined
  defaultPauseMs: number | undefined
}>({
  name: '',
  aliases: [],
  gender: null,
  ageGroup: null,
  description: '',
  note: '',
  color: '#409eff',
  defaultSpeed: null,
  defaultEmotion: null,
  defaultGainDb: undefined,
  defaultPauseMs: undefined,
})
const aliasDraft = ref('')
const saving = ref(false)

/** 合并多选与对话框 */
const mergeSelection = ref<Set<Id>>(new Set())
const mergeOpen = ref(false)
const mergeTargetId = ref<Id | null>(null)
const mergeLoading = ref(false)
const mergeResult = ref<string | null>(null)

/** 配音员绑定的待提交选择 */
const bindActorId = ref<Record<Id, Id | null>>({})
const bindPrimary = ref<Record<Id, boolean>>({})

const showWorkload = ref(false)
/** 归档确认 */
const confirmArchive = ref<{ open: boolean; character: Character | null; archived: boolean }>({
  open: false,
  character: null,
  archived: true,
})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  // 归档开关在本地也过一遍：主进程过滤是权威，但本地列表可能还留着刚归档的角色
  const list = characters.includeArchived
    ? characters.characters
    : characters.characters.filter(c => !c.isArchived)
  if (!kw) return list
  return list.filter(c =>
    c.name.toLowerCase().includes(kw)
    || c.aliases.some(alias => alias.toLowerCase().includes(kw)))
})

const mergeCharacters = computed(() =>
  characters.characters.filter(c => mergeSelection.value.has(c.id)))

const mergePreview = computed(() => {
  const target = mergeTargetId.value ?? mergeCharacters.value[0]?.id ?? null
  if (!target || mergeCharacters.value.length < 2) return null
  return characters.previewMerge(target, mergeCharacters.value.map(c => c.id))
})

/** 合并对话框的保留目标默认取行数最多的那个 */
function openMerge(): void {
  if (mergeCharacters.value.length < 2) return
  let best: Character | null = null
  let bestLines = -1
  for (const character of mergeCharacters.value) {
    const lines = characters.statsOf(character.id)?.lines ?? 0
    if (lines > bestLines) {
      bestLines = lines
      best = character
    }
  }
  mergeTargetId.value = best?.id ?? mergeCharacters.value[0]!.id
  mergeOpen.value = true
}

function toggleMergeSelection(characterId: Id, checked: boolean): void {
  const next = new Set(mergeSelection.value)
  if (checked) next.add(characterId)
  else next.delete(characterId)
  mergeSelection.value = next
}

/** 合并多选（el-checkbox）：载荷为 boolean | string | number，v-for 内需带上角色上下文 */
function onMergeSelectionInput(characterId: Id): (value: boolean | string | number) => void {
  return (value: boolean | string | number): void => {
    toggleMergeSelection(characterId, Boolean(value))
  }
}

/** 「含归档」开关（el-switch）：载荷为 boolean | string | number */
function onIncludeArchivedInput(value: boolean | string | number): void {
  void characters.setIncludeArchived(Boolean(value))
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

function openCreate(): void {
  editingId.value = null
  editForm.value = {
    name: '',
    aliases: [],
    gender: null,
    ageGroup: null,
    description: '',
    note: '',
    color: '#409eff',
    defaultSpeed: null,
    defaultEmotion: null,
    defaultGainDb: undefined,
    defaultPauseMs: undefined,
  }
  aliasDraft.value = ''
  editOpen.value = true
}

function openEdit(character: Character): void {
  editingId.value = character.id
  editForm.value = {
    name: character.name,
    aliases: [...character.aliases],
    gender: character.gender,
    ageGroup: character.ageGroup,
    description: character.description ?? '',
    note: character.note ?? '',
    color: character.color ?? '#409eff',
    defaultSpeed: character.defaultSpeed,
    defaultEmotion: character.defaultEmotion,
    defaultGainDb: character.defaultGainDb ?? undefined,
    defaultPauseMs: character.defaultPauseMs ?? undefined,
  }
  aliasDraft.value = ''
  editOpen.value = true
}

function addAlias(): void {
  const value = aliasDraft.value.trim()
  if (!value || editForm.value.aliases.includes(value)) {
    aliasDraft.value = ''
    return
  }
  editForm.value.aliases = [...editForm.value.aliases, value]
  aliasDraft.value = ''
}

function removeAlias(alias: string): void {
  editForm.value.aliases = editForm.value.aliases.filter(item => item !== alias)
}

async function saveEdit(): Promise<void> {
  if (!editForm.value.name.trim() || props.readonly) return
  saving.value = true
  try {
    await characters.saveCharacter({
      ...(editingId.value ? { id: editingId.value } : {}),
      name: editForm.value.name.trim(),
      aliases: editForm.value.aliases,
      gender: editForm.value.gender,
      ageGroup: editForm.value.ageGroup,
      description: editForm.value.description || null,
      note: editForm.value.note || null,
      color: editForm.value.color || null,
      defaultSpeed: editForm.value.defaultSpeed,
      defaultEmotion: editForm.value.defaultEmotion,
      defaultGainDb: editForm.value.defaultGainDb ?? null,
      defaultPauseMs: editForm.value.defaultPauseMs ?? null,
    })
    editOpen.value = false
    emit('changed')
  } finally {
    saving.value = false
  }
}

/** 改名 / 别名改动之后必须提示重算（docs/11 §4.6） */
async function runRecompute(scope: 'low_confidence' | 'all'): Promise<void> {
  await canvas.recomputeAttribution(scope)
  characters.markAttributionFresh()
  archivePromptOpen.value = false
  emit('changed')
}

function dismissRecompute(): void {
  archivePromptOpen.value = false
  characters.markAttributionFresh()
}

// ---------------------------------------------------------------------------
// 归档 / 合并 / 统计 / 抽取 / 绑定
// ---------------------------------------------------------------------------

function askArchive(character: Character): void {
  confirmArchive.value = { open: true, character, archived: !character.isArchived }
}

async function doArchive(): Promise<void> {
  const target = confirmArchive.value.character
  if (!target) return
  await characters.archive(target.id, confirmArchive.value.archived)
  confirmArchive.value = { open: false, character: null, archived: true }
  emit('changed')
}

async function doMerge(payload: { targetId: Id; sourceIds: Id[]; keepAliases: boolean }): Promise<void> {
  mergeLoading.value = true
  try {
    const result = await characters.mergeCharacters(payload.targetId, payload.sourceIds, payload.keepAliases)
    mergeOpen.value = false
    mergeSelection.value = new Set()
    if (result.conflicts.length) {
      // 冲突文案统一走 error-bus 的消息表（不在组件里自拼）
      reportByKey('CHARACTER_MERGE_CONFLICT', { count: result.conflicts.length })
    }
    mergeResult.value = `已迁移 ${formatInt(result.movedLines)} 行、合并别名 ${formatInt(result.mergedAliases.length)} 个`
      + (result.conflicts.length ? `，其中 ${result.conflicts.length} 个别名冲突` : '')
    emit('changed')
  } finally {
    mergeLoading.value = false
  }
}

async function refreshStats(characterId: Id): Promise<void> {
  await characters.loadStats(characterId)
}

async function runExtract(): Promise<void> {
  await characters.extract(props.chapterId ? [props.chapterId] : undefined)
}

async function acceptCandidate(name: string): Promise<void> {
  const candidate = characters.candidates.find(item => item.name === name)
  if (!candidate) return
  await characters.addCandidate(candidate)
  emit('changed')
}

async function acceptAllCandidates(): Promise<void> {
  for (const candidate of [...characters.candidates]) {
    await characters.addCandidate(candidate)
  }
  emit('changed')
}

async function bindActor(characterId: Id): Promise<void> {
  const actorId = bindActorId.value[characterId]
  if (!actorId) return
  await characters.bindActor(characterId, actorId, bindPrimary.value[characterId] ?? false)
  bindActorId.value = { ...bindActorId.value, [characterId]: null }
  emit('changed')
}

async function unbindActor(characterId: Id, actorId: Id): Promise<void> {
  await characters.unbindActor(characterId, actorId)
  emit('changed')
}

/** 配音员下拉（el-select）：选项值为配音员 Id，v-for 内需带上角色上下文 */
function onBindActorInput(characterId: Id): (value: Id) => void {
  return (value: Id): void => {
    bindActorId.value = { ...bindActorId.value, [characterId]: value || null }
  }
}

/** 主/备复选框（el-checkbox）：载荷为 boolean | string | number，v-for 内需带上角色上下文 */
function onBindPrimaryInput(characterId: Id): (value: boolean | string | number) => void {
  return (value: boolean | string | number): void => {
    bindPrimary.value = { ...bindPrimary.value, [characterId]: Boolean(value) }
  }
}

async function rebuildCentroid(): Promise<void> {
  await characters.rebuildCentroid()
}

async function toggleWorkload(): Promise<void> {
  showWorkload.value = !showWorkload.value
  if (showWorkload.value) await characters.loadWorkload()
}

function actorName(actorId: Id): string {
  return characters.actorById.get(actorId)?.name ?? '未知配音员'
}

onMounted(async () => {
  await characters.loadAllStats()
})
</script>

<template>
  <div class="ns-chars">
    <!-- 工具行 -->
    <header class="ns-chars__head">
      <el-input v-model="keyword" size="small" placeholder="搜索角色或别名" clearable class="ns-chars__search" />
      <el-switch
        :model-value="characters.includeArchived"
        size="small"
        active-text="含归档"
        @update:model-value="onIncludeArchivedInput"
      />
      <el-button size="small" :disabled="readonly" @click="openCreate">新增角色</el-button>
      <el-button size="small" :loading="characters.extracting" @click="runExtract">自动抽取</el-button>
      <el-button size="small" :disabled="readonly" @click="rebuildCentroid">重建原型向量</el-button>
    </header>

    <!-- 重算归属提示（改名 / 别名改动后） -->
    <div v-if="characters.attributionDirty" class="ns-chars__notice">
      角色名称或别名有改动：别名参与归属判定，建议重算一次。
      <span class="ns-chars__notice-actions">
        <el-button size="small" text :disabled="readonly" @click="runRecompute('low_confidence')">仅低置信</el-button>
        <el-button size="small" text :disabled="readonly" @click="runRecompute('all')">全量重算</el-button>
        <el-button size="small" text @click="dismissRecompute">稍后</el-button>
      </span>
    </div>

    <!-- 原型向量重建任务进度 -->
    <TaskProgressCard
      v-if="characters.centroidTaskId"
      :task-id="characters.centroidTaskId"
      title="重建角色原型向量"
      kind="embedding.batch"
      size="compact"
      @cancel="() => undefined"
      @open="() => undefined"
    />

    <!-- 自动抽取候选 -->
    <section v-if="characters.candidates.length" class="ns-chars__candidates">
      <div class="ns-chars__candidates-head">
        <span>抽取到 {{ characters.candidates.length }} 个候选角色</span>
        <el-button size="small" text :disabled="readonly" @click="acceptAllCandidates">全部添加</el-button>
      </div>
      <ul class="ns-chars__candidate-list">
        <li v-for="candidate in characters.candidates" :key="candidate.name" class="ns-chars__candidate">
          <span class="ns-chars__candidate-name">{{ candidate.name }}</span>
          <span class="ns-chars__muted">
            出现 {{ formatInt(candidate.occurrences) }} 次<template v-if="candidate.firstChapterTitle"> · 首见《{{ candidate.firstChapterTitle }}》</template>
          </span>
          <span v-if="candidate.aliases.length" class="ns-chars__muted">别名 {{ candidate.aliases.join('、') }}</span>
          <el-button size="small" text :disabled="readonly" @click="acceptCandidate(candidate.name)">添加</el-button>
          <el-button size="small" text @click="characters.dismissCandidate(candidate.name)">忽略</el-button>
        </li>
      </ul>
    </section>

    <!-- 合并操作 -->
    <div v-if="mergeSelection.size" class="ns-chars__mergebar">
      已选 {{ mergeSelection.size }} 个角色
      <el-button size="small" type="primary" :disabled="readonly || mergeSelection.size < 2" @click="openMerge">
        合并…
      </el-button>
      <el-button size="small" text @click="mergeSelection = new Set()">清空选择</el-button>
      <span v-if="mergeResult" class="ns-chars__muted">{{ mergeResult }}</span>
    </div>

    <!-- 角色列表 -->
    <ul v-if="filtered.length" class="ns-chars__list">
      <li v-for="character in filtered" :key="character.id" class="ns-chars__row" :class="{ 'is-archived': character.isArchived }">
        <div class="ns-chars__row-head">
          <el-checkbox
            :model-value="mergeSelection.has(character.id)"
            @update:model-value="onMergeSelectionInput(character.id)"
          />
          <i class="ns-chars__dot" :style="{ background: character.color ?? characters.colorOf(character.id) }" />
          <span class="ns-chars__name">{{ character.name }}</span>
          <el-tag v-if="character.isArchived" size="small" type="info">已归档</el-tag>
          <el-tag v-if="character.gender" size="small" type="info">{{ GENDER_LABELS[character.gender] }}</el-tag>
          <el-tag v-if="character.ageGroup" size="small" type="info">{{ AGE_LABELS[character.ageGroup] }}</el-tag>

          <span class="ns-chars__grow" />

          <el-button size="small" text @click="emit('focus-character', character.id)">看台词</el-button>
          <el-button size="small" text :disabled="readonly" @click="openEdit(character)">编辑</el-button>
          <el-button size="small" text :disabled="readonly" @click="askArchive(character)">
            {{ character.isArchived ? '恢复' : '归档' }}
          </el-button>
        </div>

        <div v-if="character.aliases.length" class="ns-chars__aliases">
          <el-tag v-for="alias in character.aliases" :key="alias" size="small" type="warning" effect="plain">
            {{ alias }}
          </el-tag>
        </div>

        <p v-if="character.description" class="ns-chars__desc">{{ character.description }}</p>

        <div class="ns-chars__stats">
          <span>行数 {{ formatInt(characters.statsOf(character.id)?.lines ?? null) }}</span>
          <span>字数 {{ formatCount(characters.statsOf(character.id)?.chars ?? null) }}</span>
          <span>预估 {{ formatDuration(characters.statsOf(character.id)?.estimatedDurationMs ?? null) }}</span>
          <span>已录 {{ formatDuration(characters.statsOf(character.id)?.recordedMs ?? null) }}</span>
          <span class="ns-chars__muted">
            默认：{{ character.defaultEmotion ?? '情绪未设' }} / {{ character.defaultSpeed ?? '语速未设' }} / 停顿 {{ character.defaultPauseMs ?? '未设' }} ms
          </span>
          <el-button size="small" text @click="refreshStats(character.id)">刷新统计</el-button>
        </div>

        <div class="ns-chars__bindings">
          <span class="ns-chars__muted">配音员：</span>
          <template v-if="(characters.bindingsByCharacter.get(character.id) ?? []).length">
            <el-tag
              v-for="binding in characters.bindingsByCharacter.get(character.id) ?? []"
              :key="binding.actorId"
              size="small"
              :type="binding.isPrimary ? 'success' : 'info'"
              closable
              @close="unbindActor(character.id, binding.actorId)"
            >
              {{ actorName(binding.actorId) }}{{ binding.isPrimary ? '（主）' : '（备）' }}
            </el-tag>
          </template>
          <span v-else class="ns-chars__muted">未绑定</span>

          <el-select
            :model-value="bindActorId[character.id] ?? ''"
            size="small"
            placeholder="选择配音员"
            class="ns-chars__actor-select"
            :disabled="readonly"
            @update:model-value="onBindActorInput(character.id)"
          >
            <el-option v-for="actor in characters.actors" :key="actor.id" :label="actor.name" :value="actor.id" />
          </el-select>
          <el-checkbox
            :model-value="bindPrimary[character.id] ?? false"
            size="small"
            :disabled="readonly"
            @update:model-value="onBindPrimaryInput(character.id)"
          >
            主
          </el-checkbox>
          <el-button size="small" text :disabled="readonly || !bindActorId[character.id]" @click="bindActor(character.id)">绑定</el-button>
        </div>
      </li>
    </ul>

    <EmptyState
      v-else
      title="还没有角色"
      description="可以点「自动抽取」从正文里提取候选角色名（引导语主语 / 高频称谓），再一键添加。"
      icon="🎭"
      :bordered="false"
    />

    <!-- 分工负载 -->
    <section class="ns-chars__workload">
      <el-button size="small" text @click="toggleWorkload">
        {{ showWorkload ? '收起' : '展开' }}配音员分工负载
      </el-button>
      <ul v-if="showWorkload && characters.workload.length" class="ns-chars__workload-list">
        <li v-for="item in characters.workload" :key="item.actorId">
          <span class="ns-chars__name">{{ item.name }}</span>
          <span class="ns-chars__muted">
            {{ formatInt(item.lines) }} 行 · {{ formatCount(item.chars) }} 字 ·
            预估 {{ formatDuration(item.estimatedDurationMs) }} · 已录 {{ formatInt(item.recordedCount) }} 行
          </span>
        </li>
      </ul>
      <p v-else-if="showWorkload" class="ns-chars__muted">还没有配音员，或尚未绑定任何角色。</p>
    </section>

    <!-- 编辑对话框 -->
    <el-dialog
      v-model="editOpen"
      :title="editingId ? '编辑角色' : '新增角色'"
      width="520px"
      :close-on-click-modal="false"
    >
      <div class="ns-chars__form">
        <div class="ns-chars__field">
          <label>名称</label>
          <el-input v-model="editForm.name" size="small" placeholder="如：萧炎" />
        </div>

        <div class="ns-chars__field">
          <label>别名（回车添加；别名参与归属判定）</label>
          <div class="ns-chars__alias-row">
            <el-input v-model="aliasDraft" size="small" placeholder="如：炎帝 / 小炎子" @keydown.enter="addAlias" />
            <el-button size="small" @click="addAlias">添加</el-button>
          </div>
          <div v-if="editForm.aliases.length" class="ns-chars__aliases">
            <el-tag
              v-for="alias in editForm.aliases"
              :key="alias"
              size="small"
              closable
              @close="removeAlias(alias)"
            >
              {{ alias }}
            </el-tag>
          </div>
        </div>

        <div class="ns-chars__field-row">
          <div class="ns-chars__field">
            <label>性别</label>
            <el-select v-model="editForm.gender" size="small" clearable placeholder="未定">
              <el-option v-for="(label, value) in GENDER_LABELS" :key="value" :label="label" :value="value" />
            </el-select>
          </div>
          <div class="ns-chars__field">
            <label>年龄段</label>
            <el-select v-model="editForm.ageGroup" size="small" clearable placeholder="未定">
              <el-option v-for="(label, value) in AGE_LABELS" :key="value" :label="label" :value="value" />
            </el-select>
          </div>
          <div class="ns-chars__field">
            <label>颜色</label>
            <el-color-picker v-model="editForm.color" size="small" />
          </div>
        </div>

        <div class="ns-chars__field">
          <label>性格描述（拼进原型文本，影响归属判定）</label>
          <el-input v-model="editForm.description" type="textarea" :rows="2" size="small" />
        </div>

        <div class="ns-chars__field">
          <label>备注（给配音员看）</label>
          <el-input v-model="editForm.note" type="textarea" :rows="2" size="small" />
        </div>

        <div class="ns-chars__field-row">
          <div class="ns-chars__field">
            <label>默认情绪</label>
            <el-select v-model="editForm.defaultEmotion" size="small" clearable placeholder="继承全局">
              <el-option v-for="emotion in EMOTIONS" :key="emotion" :label="emotion" :value="emotion" />
            </el-select>
          </div>
          <div class="ns-chars__field">
            <label>默认语速</label>
            <el-select v-model="editForm.defaultSpeed" size="small" clearable placeholder="继承全局">
              <el-option v-for="option in SPEED_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>
        </div>

        <div class="ns-chars__field-row">
          <div class="ns-chars__field">
            <label>默认音量偏移（dB）</label>
            <el-input-number v-model="editForm.defaultGainDb" :min="-12" :max="12" :step="0.5" size="small" controls-position="right" />
          </div>
          <div class="ns-chars__field">
            <label>默认停顿（ms）</label>
            <el-input-number v-model="editForm.defaultPauseMs" :min="0" :max="3000" :step="50" size="small" controls-position="right" />
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!editForm.name.trim()" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 合并对话框 -->
    <CharacterMergeDialog
      v-model="mergeOpen"
      :characters="mergeCharacters"
      :preview="mergePreview"
      :stats="characters.stats"
      :loading="mergeLoading"
      @confirm="doMerge"
    />

    <!-- 归档确认（归档会影响重算范围，先说清后果） -->
    <ConfirmDialog
      v-model="confirmArchive.open"
      :title="confirmArchive.archived ? '归档角色' : '恢复角色'"
      :message="confirmArchive.archived
        ? '归档后该角色不再出现在新生成的画本里，但已有引用保留（不会物理删除）。'
        : '恢复后该角色重新参与归属判定与新画本生成。'"
      :details="confirmArchive.character
        ? [`角色：${confirmArchive.character.name}`, `台词引用：${formatInt(characters.statsOf(confirmArchive.character.id)?.lines ?? null)} 行`]
        : []"
      :confirm-text="confirmArchive.archived ? '归档' : '恢复'"
      @confirm="doArchive"
    />
  </div>
</template>

<style scoped>
.ns-chars {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px;
  font-size: 13px;
}
.ns-chars__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ns-chars__search {
  width: 180px;
}
.ns-chars__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgb(230 162 60 / 14%);
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
}
.ns-chars__notice-actions {
  display: inline-flex;
  gap: 4px;
}
.ns-chars__candidates {
  padding: 8px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 4px;
}
.ns-chars__candidates-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ns-chars__candidate-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-chars__candidate {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.ns-chars__candidate-name {
  font-weight: 600;
}
.ns-chars__mergebar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgb(64 158 255 / 10%);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ns-chars__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ns-chars__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 6px;
}
.ns-chars__row.is-archived {
  opacity: 0.6;
}
.ns-chars__row-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ns-chars__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.ns-chars__name {
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
  font-weight: 600;
}
.ns-chars__grow {
  flex: 1;
}
.ns-chars__aliases {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ns-chars__desc {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.6;
}
.ns-chars__stats {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-chars__bindings {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ns-chars__actor-select {
  width: 130px;
}
.ns-chars__muted {
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-chars__workload {
  padding-top: 6px;
  border-top: 1px dashed var(--ns-border-light, #e4e7ed);
}
.ns-chars__workload-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ns-chars__workload-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}
.ns-chars__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ns-chars__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.ns-chars__field label {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-chars__field-row {
  display: flex;
  gap: 10px;
}
.ns-chars__alias-row {
  display: flex;
  gap: 6px;
}
</style>
