<!--
  Novel Studio · 备份面板（设置页「备份」分类）
  ============================================================================
  设计依据：
    · docs/04 §8.2 —— advanced 分组：autoBackup（daily/weekly/off）、keepBackups；
      「备份」是数据库级操作，属于设置页里唯一会**覆盖当前数据**的动作
    · docs/04 §1.1 —— 备份走 SQLite 的在线备份（VACUUM INTO / backup API），
      因此恢复必须整体替换文件，不能「合并」
    · docs/22 §7   —— 破坏性操作必须二次确认：这里用 ConfirmDialog + 输入关键词
      （docs/11 §4.7 的纪律：破坏性操作要先说清影响范围）
    · docs/15 §5.1 —— 覆盖类操作必须明确「会被覆盖的是什么」

  一条硬纪律：**恢复前先提示用户备份**。
    恢复会整体替换数据库文件；如果用户直接点恢复，当前进度就没了。
    因此确认框里必须写清「会覆盖当前数据」并给出「先立即备份」的引导。
-->

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@/shared/ui/ConfirmDialog.vue'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { call, callSafe } from '@/shared/lib/ipc.ts'
import { isAppError } from '@shared/errors.ts'
import { formatBytes, formatDate, formatInt } from '@/shared/lib/format.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import type { AppSettings } from '@shared/types.ts'
import type { DeepPartial } from '@shared/ipc.ts'

interface SaveState {
  status: SaveStatus
  error?: string | null
}

/** db:listBackups 的返回元素（与 src/shared/ipc.ts 的契约一致） */
interface BackupEntry {
  id: string
  filePath: string
  sizeBytes: number
  schemaVersion: number
  reason: string
  createdAt: number
}

const props = withDefaults(defineProps<{
  /** 备份目录（来自 app:getPaths.backupDir / settings.paths.backupDir） */
  backupDir?: string
  /** 需要高亮的设置键（?focus=，docs/22 §7） */
  highlightKeys?: string[]
}>(), {
  backupDir: '',
  highlightKeys: () => [],
})

const emit = defineEmits<{
  saveState: [state: SaveState]
  /** 恢复完成（父级可以据此提示或重新读取设置） */
  restored: [path: string]
}>()

const settings = useSettingsStore()

const advanced = computed<AppSettings['advanced'] | null>(() => settings.settings?.advanced ?? null)

const backups = ref<BackupEntry[]>([])
const listBusy = ref(false)
const backupBusy = ref(false)
const restoreBusy = ref(false)
const lastBackupPath = ref<string | null>(null)
/** 待恢复的备份（确认框里的目标） */
const pendingRestore = ref<BackupEntry | null>(null)
const confirmVisible = ref(false)

const AUTO_BACKUP_OPTIONS: Array<{ value: AppSettings['advanced']['autoBackup']; label: string; hint: string }> = [
  { value: 'daily', label: '每天一次', hint: '推荐：每天首次启动时自动备份，出问题最多丢一天的工作量。' },
  { value: 'weekly', label: '每周一次', hint: '适合低频使用；建议同时手动备份重要节点。' },
  { value: 'off', label: '不自动备份', hint: '关闭后只能手动点「立即备份」，请自行保证有可回退的备份。' },
]

/** 备份原因的中文标签（未知值原样显示，不做猜测） */
const REASON_LABELS: Record<string, string> = {
  manual: '手动备份',
  auto: '自动备份',
  'pre-restore': '恢复前自动备份',
  'pre-migration': '迁移前自动备份',
  'pre-import': '导入前自动备份',
}

const confirmDetails = computed<string[]>(() => {
  const target = pendingRestore.value
  if (!target) return []
  return [
    `将用该备份覆盖当前数据库：${target.filePath}`,
    `备份时间：${formatDate(target.createdAt)} · 结构版本：${target.schemaVersion} · 大小：${formatBytes(target.sizeBytes)}`,
    '当前数据（书籍、画本、录音记录、导出历史、设置）会全部被替换为备份中的内容，此操作不可撤销。',
    '恢复前建议先点「立即备份」，并确认没有正在运行的任务（导入 / 生成画本 / 导出）。',
    '恢复完成后界面会重新读取设置；若列表没有变化，请切到别的页面再回来。',
  ]
})

function isHl(key: string): boolean {
  return props.highlightKeys.includes(key)
}

function errorText(error: unknown): string | null {
  return isAppError(error) ? error.resolved.title : null
}

async function save(patch: DeepPartial<AppSettings>): Promise<void> {
  emit('saveState', { status: 'saving', error: null })
  try {
    await settings.patch(patch)
    emit('saveState', { status: 'saved', error: null })
  } catch (error) {
    emit('saveState', { status: 'error', error: errorText(error) })
  }
}

async function loadBackups(): Promise<void> {
  listBusy.value = true
  try {
    const list = await callSafe('db:listBackups', undefined)
    backups.value = (list as BackupEntry[] | null) ?? []
  } finally {
    listBusy.value = false
  }
}

/** 立即备份（失败原因经 error-bus 兑现，这里只处理成功路径与本地状态） */
async function backupNow(): Promise<void> {
  backupBusy.value = true
  try {
    const result = await call('db:backup', undefined)
    lastBackupPath.value = (result as { path: string }).path
    await loadBackups()
  } catch {
    lastBackupPath.value = null
  } finally {
    backupBusy.value = false
  }
}

/**
 * el-table 的作用域插槽把 `row` 定型为 Element Plus 的 `DefaultRow`（宽松记录类型），
 * 模板里无法直接交给需要 `BackupEntry` 的函数。收敛写在脚本里 ——
 * 模板表达式按 JS 解析，写不了 TS 断言（见 package.json 的 template-types 说明）。
 */
const asBackupEntry = (row: unknown): BackupEntry => row as BackupEntry

function askRestore(entry: BackupEntry): void {
  pendingRestore.value = entry
  confirmVisible.value = true
}

/** 确认框通过后才真正恢复：破坏性动作不提供「一键恢复」 */
async function confirmRestore(): Promise<void> {
  const target = pendingRestore.value
  if (!target) return
  restoreBusy.value = true
  try {
    await call('db:restore', { path: target.filePath })
    confirmVisible.value = false
    pendingRestore.value = null
    emit('restored', target.filePath)
    await loadBackups()
  } catch {
    // 失败提示已由 error-bus 给出；保持确认框打开，用户可以重试或取消
  } finally {
    restoreBusy.value = false
  }
}

async function reveal(path: string | null | undefined): Promise<void> {
  if (!path) return
  await callSafe('app:showItemInFolder', { path })
}

onMounted(() => {
  void loadBackups()
})
</script>

<template>
  <div class="ns-backup">
    <!-- ── 自动备份策略 ─────────────────────────────────────────────── -->
    <section class="ns-backup__block">
      <h3 class="ns-backup__title">自动备份</h3>
      <el-form v-if="advanced" label-width="180px" label-position="left">
        <el-form-item
          label="备份频率"
          :class="{ 'ns-field--hl': isHl('advanced.autoBackup') }"
          data-anchor="advanced.autoBackup"
        >
          <el-select
            v-model="advanced.autoBackup"
            class="ns-backup__control"
            @change="save({ advanced: { autoBackup: advanced.autoBackup } })"
          >
            <el-option
              v-for="item in AUTO_BACKUP_OPTIONS"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
          <p class="ns-field__hint">
            {{ AUTO_BACKUP_OPTIONS.find(item => item.value === advanced?.autoBackup)?.hint ?? '' }}
          </p>
        </el-form-item>

        <el-form-item
          label="最多保留"
          :class="{ 'ns-field--hl': isHl('advanced.keepBackups') }"
          data-anchor="advanced.keepBackups"
        >
          <el-input-number
            v-model="advanced.keepBackups"
            :min="1"
            :max="50"
            controls-position="right"
            @change="save({ advanced: { keepBackups: advanced.keepBackups } })"
          />
          <span class="ns-field__unit">份（超出份数的旧备份会被自动清理；每天备份建议 7 份）</span>
        </el-form-item>

        <el-form-item
          label="自动清理旧录制"
          :class="{ 'ns-field--hl': isHl('advanced.autoCleanupTakes') }"
          data-anchor="advanced.autoCleanupTakes"
        >
          <el-switch
            v-model="advanced.autoCleanupTakes"
            @change="save({ advanced: { autoCleanupTakes: advanced.autoCleanupTakes } })"
          />
          <p class="ns-field__hint">
            开启后，被替换掉的旧 take 会在备份点之后清理（当前选中的 take 与其派生的处理结果永不删除）。
            关闭则磁盘占用会随重录次数增长。
          </p>
        </el-form-item>
      </el-form>
    </section>

    <!-- ── 备份文件 ─────────────────────────────────────────────────── -->
    <section class="ns-backup__block" data-anchor="backup.list">
      <header class="ns-backup__head">
        <h3 class="ns-backup__title">备份文件（{{ backups.length }}）</h3>
        <el-button type="primary" :loading="backupBusy" @click="backupNow">立即备份</el-button>
        <el-button :loading="listBusy" @click="loadBackups">刷新列表</el-button>
        <el-button :disabled="!props.backupDir" @click="reveal(props.backupDir)">打开备份目录</el-button>
      </header>

      <p class="ns-backup__dir">
        备份目录：<code>{{ props.backupDir || '（未知）' }}</code>
      </p>

      <p v-if="lastBackupPath" class="ns-backup__last">
        最近一次备份：<code>{{ lastBackupPath }}</code>
        <el-button size="small" link @click="reveal(lastBackupPath)">打开所在文件夹</el-button>
      </p>

      <el-table v-if="backups.length" :data="backups" size="small" class="ns-backup__table">
        <el-table-column label="备份时间" width="170">
          <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="原因" width="140">
          <template #default="{ row }">
            {{ REASON_LABELS[row.reason] ?? row.reason }}
          </template>
        </el-table-column>
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatBytes(row.sizeBytes) }}</template>
        </el-table-column>
        <el-table-column label="结构版本" width="100">
          <template #default="{ row }">v{{ row.schemaVersion }}</template>
        </el-table-column>
        <el-table-column prop="filePath" label="文件" min-width="260" show-overflow-tooltip />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link @click="reveal(row.filePath)">打开文件夹</el-button>
            <el-button size="small" link type="danger" @click="askRestore(asBackupEntry(row))">恢复</el-button>
          </template>
        </el-table-column>
      </el-table>

      <p v-else class="ns-backup__empty">
        还没有备份。点「立即备份」生成第一份；建议在进行大批量导入或整本导出之前手动备份一次。
      </p>

      <p class="ns-backup__note">
        恢复会**整体替换**数据库文件（不是合并）：当前进度以备份为准。
        恢复完成后，画本、录音记录、导出历史与设置都会回到备份时的状态；
        <template v-if="backups.length">共 {{ formatInt(backups.length) }} 份备份可用。</template>
      </p>
    </section>

    <!-- 恢复确认：必须输入关键词才能点确认（docs/11 §4.7） -->
    <ConfirmDialog
      v-model="confirmVisible"
      type="danger"
      title="确认恢复这份备份？"
      message="恢复会用备份内容覆盖当前数据库，且无法撤销。"
      :details="confirmDetails"
      confirm-keyword="恢复"
      confirm-text="确认恢复"
      :loading="restoreBusy"
      @confirm="confirmRestore"
    />
  </div>
</template>

<style scoped>
.ns-backup {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.ns-backup__block {
  padding: 12px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-backup__head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.ns-backup__title {
  flex: 1;
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-backup__control {
  width: 240px;
}
.ns-backup__dir,
.ns-backup__last {
  margin: 8px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-backup__dir code,
.ns-backup__last code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all;
}
.ns-backup__table {
  margin-top: 8px;
}
.ns-backup__empty {
  margin: 12px 0 0;
  padding: 14px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 6px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-backup__note {
  margin: 10px 0 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
.ns-field__unit {
  margin-left: 10px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-field__hint {
  width: 100%;
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-field--hl :deep(.el-form-item__label) {
  color: var(--ns-primary, #409eff);
}
.ns-field--hl {
  border-radius: 6px;
  outline: 2px solid rgb(64 158 255 / 45%);
  outline-offset: 2px;
  background: rgb(64 158 255 / 6%);
}
</style>
