<!--
  Novel Studio · 混音方案选择器（docs/15 §2「多方案」、§9 MixProjectSelector）
  ============================================================================
  为什么一个章节要有多份方案：干声版 / 带 BGM 版 / 广播版 的差别不在对轨（位置），
  而在音量与效果。混音方案与对轨方案是**两层**，方案之间只共享 arrangementId，
  绝不合并（docs/15 §2 明确要求）。

  切换方案前必须先 flush（用户最痛的一类丢数据）：
    store.switchProject() 内部会先 `writeNow()`；写库失败时**不静默丢改动**，
    返回 `{ switched:false, reason:'save-failed' }`，这里据此弹确认框
    「保存失败，是否放弃修改并切换？」——只有用户明确同意才 force 切换。

  「设为默认」的写库口径：
    非当前方案走 `mix:save`（与 store.renameProject 同一做法）；
    当前方案先 `writeNow()` 把内存改动落库，再写 isDefault，最后 `loadProject` 回读，
    保证 store 里的状态与库一致（不做「本地改了但没存」的假象）。
    `isDefault` 的唯一性由主进程保证，UI 只标记用户选中的那一个。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { useMixStore } from '../stores/mix.store.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import { call } from '@/shared/lib/ipc.ts'
import { formatDb, formatLufs } from '@/shared/lib/format.ts'
import type { Id, MixProject } from '@shared/types.ts'

const emit = defineEmits<{
  /** 已切换/新建/删除后当前方案发生变化：视图据此重载资产与处理链目标 */
  switched: [projectId: Id | null]
}>()

const mix = useMixStore()
const session = useSessionStore()

const creating = ref(false)
const draftName = ref('')
const renamingId = ref<Id | null>(null)
const renameText = ref('')
const deleteTarget = ref<MixProject | null>(null)
const forceSwitchId = ref<Id | null>(null)
const busy = ref(false)
const hint = ref<string | null>(null)

onMounted(() => {
  if (!mix.projects.length) void mix.listProjects(session.chapterId ?? '')
})

/** 当前章节的对轨方案名（方案摘要里显示「这一版是基于哪次对轨」） */
const arrangementName = computed(() => {
  const id = mix.current?.arrangementId
  if (!id) return null
  return mix.arrangements.find(item => item.id === id)?.name ?? null
})

/** 列表项摘要：轨道数 / 目标响度 / 是否含 BGM（docs/15 §9 的「显示摘要」） */
function summarize(project: MixProject): string {
  const parts = [
    `${project.tracks.length} 条轨`,
    `目标 ${formatLufs(project.master.targetLufs)}`,
  ]
  const bgm = project.tracks.filter(track => track.kind === 'music').length
  const sfx = project.tracks.filter(track => track.kind === 'sfx').length
  parts.push(bgm ? `含 BGM ×${bgm}` : '无 BGM')
  if (sfx) parts.push(`音效 ×${sfx}`)
  parts.push(`真峰 ${formatDb(project.master.truePeakDb)} dBTP`)
  return parts.join(' · ')
}

function labelOf(project: MixProject): string {
  const star = project.isDefault ? '★ ' : ''
  const id = project.id === mix.currentId ? '● ' : ''
  return `${star}${id}${project.name}`
}

// ── 切换（先 flush，失败时二次确认）──────────────────────────────────────
async function switchTo(projectId: Id): Promise<void> {
  if (projectId === mix.currentId) {
    hint.value = `已经是当前方案「${mix.current?.name ?? ''}」`
    return
  }
  busy.value = true
  const result = await mix.switchProject(projectId)
  busy.value = false
  if (result.switched) {
    hint.value = mix.saveFeedback?.text ?? '已切换方案'
    emit('switched', projectId)
    return
  }
  if (result.reason === 'save-failed') {
    // 保存失败 → 让用户决定是否放弃内存中的改动
    forceSwitchId.value = projectId
    return
  }
  hint.value = '切换失败：方案可能已被删除，请刷新列表'
}

/** el-select 的载荷是所选方案 id（el-option :value="project.id"）*/
function onProjectChange(value: Id | null): void {
  if (value) void switchTo(String(value))
}

async function confirmForceSwitch(): Promise<void> {
  const projectId = forceSwitchId.value
  forceSwitchId.value = null
  if (!projectId) return
  busy.value = true
  const result = await mix.switchProject(projectId, { force: true })
  busy.value = false
  if (result.switched) {
    hint.value = '已放弃未保存的改动并切换方案'
    emit('switched', projectId)
  } else {
    hint.value = '切换仍然失败，请检查方案是否还存在'
  }
}

// ── 新建 / 复制 / 重命名 / 删除 ─────────────────────────────────────────
function openCreate(): void {
  creating.value = true
  draftName.value = `混音方案 ${mix.projects.length + 1}`
  hint.value = null
}

async function submitCreate(): Promise<void> {
  busy.value = true
  const created = await mix.createProject(draftName.value)
  busy.value = false
  if (!created) {
    hint.value = '新建失败：这一章可能还没有对轨结果（混音方案必须引用一个对轨方案）'
    return
  }
  creating.value = false
  hint.value = `已创建「${created.name}」；可以点「按角色生成轨道」快速起步`
  emit('switched', created.id)
}

function startRename(project: MixProject): void {
  renamingId.value = project.id
  renameText.value = project.name
}

/** 新建表单的方案名输入（el-input 的 update:model-value 载荷是字符串）*/
function onDraftNameInput(value: string): void {
  draftName.value = value
}

/** 重命名表单的名称输入（el-input 的 update:model-value 载荷是字符串）*/
function onRenameTextInput(value: string): void {
  renameText.value = value
}

async function confirmRename(project: MixProject): Promise<void> {
  const name = renameText.value.trim()
  if (!name) {
    hint.value = '方案名不能为空'
    return
  }
  busy.value = true
  await mix.renameProject(project.id, name)
  busy.value = false
  renamingId.value = null
  hint.value = `已重命名为「${name}」`
}

async function duplicate(project: MixProject): Promise<void> {
  busy.value = true
  // duplicateProject 只作用于**当前**方案：先切过去再复制，避免复制错对象
  if (project.id !== mix.currentId) {
    const switched = await mix.switchProject(project.id)
    if (!switched.switched) {
      busy.value = false
      hint.value = '复制前切换方案失败，已取消复制'
      return
    }
  }
  const copy = await mix.duplicateProject(`${project.name} 副本`)
  busy.value = false
  hint.value = copy ? `已复制为「${copy.name}」` : '复制失败，请重试'
  if (copy) emit('switched', copy.id)
}

async function confirmDelete(): Promise<void> {
  const project = deleteTarget.value
  deleteTarget.value = null
  if (!project) return
  busy.value = true
  const ok = await mix.deleteProject(project.id)
  busy.value = false
  hint.value = ok ? `已删除「${project.name}」` : '删除失败，请重试'
  if (ok) emit('switched', mix.currentId)
}

/** 设为默认方案（见文件头「写库口径」）*/
async function setDefault(project: MixProject): Promise<void> {
  busy.value = true
  try {
    if (project.id === mix.currentId) {
      // 先把内存里的改动落库，避免「写 isDefault 时把未保存的编辑丢了」
      await mix.writeNow()
      const current = mix.current
      if (!current) return
      await call('mix:save', { mixProject: { ...current, isDefault: true } })
      await mix.loadProject(project.id)
    } else {
      await call('mix:save', { mixProject: { ...project, isDefault: true } })
      await mix.listProjects(mix.current?.chapterId ?? session.chapterId ?? '')
    }
    hint.value = `已把「${project.name}」设为默认方案（下次进入本章会优先打开它）`
  } finally {
    busy.value = false
  }
}

/** 新方案从零开始很麻烦：按角色一次生成好旁白 + 每个角色一条轨（docs/14 §4.2） */
function buildTracks(): void {
  const created = mix.buildTracksFromCharacters()
  hint.value = created
    ? `已按角色生成 ${created} 条轨道（已有轨道的角色不会重复创建）`
    : '没有需要新建的轨道（角色列表可能还是空的）'
}

const canDelete = computed(() => mix.projects.length > 1)
</script>

<template>
  <section class="ns-mixsel">
    <div class="ns-mixsel__main">
      <span class="ns-label">混音方案</span>
      <el-select
        :model-value="mix.currentId"
        size="small"
        filterable
        placeholder="选择方案"
        class="ns-mixsel__select"
        @change="onProjectChange"
      >
        <el-option
          v-for="project in mix.projects"
          :key="project.id"
          :label="labelOf(project)"
          :value="project.id"
        >
          <span class="ns-mixsel__opt">
            <strong>{{ labelOf(project) }}</strong>
            <span class="ns-hint">{{ summarize(project) }}</span>
          </span>
        </el-option>
      </el-select>

      <el-button size="small" :loading="busy" @click="openCreate">新建…</el-button>
      <el-button v-if="mix.current" size="small" @click="startRename(mix.current)">重命名</el-button>
      <el-button v-if="mix.current" size="small" @click="duplicate(mix.current)">复制</el-button>
      <el-button v-if="mix.current" size="small" @click="setDefault(mix.current)">设为默认</el-button>
      <el-button
        v-if="mix.current"
        size="small"
        type="danger"
        text
        :disabled="!canDelete"
        @click="deleteTarget = mix.current"
      >
        删除
      </el-button>
      <el-button
        v-if="mix.current && mix.tracks.length === 0"
        size="small"
        type="primary"
        @click="buildTracks"
      >
        按角色生成轨道
      </el-button>
    </div>

    <p class="ns-mixsel__summary">
      <template v-if="mix.current">
        当前：{{ mix.current.name }}
        <template v-if="mix.current.isDefault">（默认方案）</template> ·
        {{ summarize(mix.current) }}
        <template v-if="arrangementName"> · 对轨方案：{{ arrangementName }}</template>
      </template>
      <template v-else>还没有混音方案：点「新建…」开始（需要有对轨结果）</template>
    </p>

    <p v-if="hint" class="ns-mixsel__hint">{{ hint }}</p>

    <!-- 新建表单 -->
    <div v-if="creating" class="ns-mixsel__create">
      <el-input
        :model-value="draftName"
        size="small"
        placeholder="方案名（如：带 BGM 版 / 干声版 / 广播版）"
        @update:model-value="onDraftNameInput"
      />
      <el-button size="small" @click="creating = false">取消</el-button>
      <el-button size="small" type="primary" :loading="busy" @click="submitCreate">创建</el-button>
    </div>

    <!-- 重命名表单 -->
    <div v-if="renamingId && mix.current" class="ns-mixsel__create">
      <el-input
        :model-value="renameText"
        size="small"
        placeholder="新的方案名"
        @update:model-value="onRenameTextInput"
      />
      <el-button size="small" @click="renamingId = null">取消</el-button>
      <el-button size="small" type="primary" :loading="busy" @click="confirmRename(mix.current)">保存</el-button>
    </div>

    <EmptyState
      v-if="!mix.projects.length && !mix.loading"
      size="small"
      icon="🎛️"
      title="本章还没有混音方案"
      description="混音方案引用对轨方案：先完成自动对轨，再回来新建方案"
      action-text="新建混音方案"
      @action="openCreate"
    />

    <!-- 切换前的「保存失败」二次确认：不静默丢改动 -->
    <ConfirmDialog
      :model-value="forceSwitchId !== null"
      title="保存失败，是否放弃修改并切换？"
      message="当前方案的改动还没能写入数据库（它们仍在内存中）。继续切换会放弃这些改动。"
      type="warning"
      confirm-text="放弃修改并切换"
      cancel-text="留在当前方案"
      @confirm="confirmForceSwitch"
      @cancel="forceSwitchId = null"
    />

    <ConfirmDialog
      :model-value="deleteTarget !== null"
      title="删除混音方案"
      :message="deleteTarget
        ? `删除「${deleteTarget.name}」？该方案的轨道、增益、声像、预设绑定与主控设置会一起删除，录音素材不受影响。`
        : ''"
      type="danger"
      confirm-text="删除方案"
      :loading="busy"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </section>
</template>

<style scoped>
.ns-mixsel { display: flex; flex-direction: column; gap: 6px; }
.ns-mixsel__main { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ns-label { color: var(--ns-text-regular, #606266); font-size: 12px; white-space: nowrap; }
.ns-mixsel__select { width: 240px; }
.ns-mixsel__opt { display: flex; flex-direction: column; line-height: 1.35; }
.ns-hint { margin: 0; color: var(--ns-text-secondary, #909399); font-size: 11px; line-height: 1.5; }
.ns-mixsel__summary { margin: 0; color: var(--ns-text-regular, #606266); font-size: 11.5px; }
.ns-mixsel__hint { margin: 0; color: var(--ns-primary, #409eff); font-size: 11.5px; }
.ns-mixsel__create { display: flex; align-items: center; gap: 6px; max-width: 520px; }
</style>
