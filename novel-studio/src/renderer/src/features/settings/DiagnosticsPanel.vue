<!--
  Novel Studio · 日志与诊断面板（设置页「日志与诊断」分类）
  ============================================================================
  设计依据：
    · docs/04 §5.1 —— 日志分级与输出；「渲染进程可订阅的日志流（打开「诊断面板」时）」
    · docs/04 §5.4 —— 诊断包（FR-8.6）：zip 含版本信息、脱敏配置、最近 3 天日志、
      崩溃转储清单、任务历史；一键导出，方便用户报障
    · docs/02 §5.1 —— ffmpeg 能力探测：必须验证 loudnorm / afftdn / sidechaincompress 等
      滤镜；**缺失的滤镜对应控件要隐藏或禁用**，因此这里把缺失清单明确列出来
    · docs/22 §8   —— 「报障三步」：① 记下编号 ② 导出诊断包 ③ 一起发给支持
    · docs/22 §6.2 —— 日志级别的写入走 store.patch（settings:set）+ log:subscribe；
      本组件不自编任何错误文案

  为什么诊断面板要放「缺失滤镜 → 受影响功能」这张表：
    用户看到「导出突然不能用了」，原因常常是 ffmpeg 缺 loudnorm。若只显示一行
    「missing: loudnorm, alimiter」，没人能把它和「响度归一化」联系起来。
-->

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { call, callSafe, on } from '@/shared/lib/ipc.ts'
import { isAppError } from '@shared/errors.ts'
import { formatBytes, formatDate, formatInt } from '@/shared/lib/format.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import type { AppInfo, AppPaths, AppSettings } from '@shared/types.ts'
import type { DeepPartial } from '@shared/ipc.ts'

interface SaveState {
  status: SaveStatus
  error?: string | null
}

/** log:entry 事件载荷（与 src/shared/ipc.ts 的 IpcEventMap['log:entry'] 同形） */
interface LogEntry {
  ts: number
  level: string
  event: string
  data?: Record<string, unknown>
}

interface DbStats {
  sizeBytes: number
  schemaVersion: number
  tables: Array<{ name: string; rows: number }>
}

const props = withDefaults(defineProps<{
  /** app:getPaths 的结果（日志目录等），由 SettingsView 读取后传入 */
  paths?: AppPaths | null
  /** 需要高亮的设置键（?focus=，docs/22 §7） */
  highlightKeys?: string[]
}>(), {
  paths: null,
  highlightKeys: () => [],
})

const emit = defineEmits<{
  saveState: [state: SaveState]
  /** 请求父级重新拉取能力探测（settings.refreshCapabilities()） */
  refresh: []
}>()

const settings = useSettingsStore()

const info = ref<AppInfo | null>(null)
const dbStats = ref<DbStats | null>(null)
const integrity = ref<{ ok: boolean; errors: string[] } | null>(null)
const integrityBusy = ref(false)
const statsBusy = ref(false)
const reportPath = ref<string | null>(null)
const exportBusy = ref(false)

const LOG_LEVELS: Array<{ value: AppSettings['advanced']['logLevel']; label: string; hint: string }> = [
  { value: 'error', label: 'error（仅错误）', hint: '生产默认：只记录操作失败与异常。' },
  { value: 'warn', label: 'warn（含降级与参数异常）', hint: '记录降级、可恢复异常、参数异常。' },
  { value: 'info', label: 'info（含关键业务动作）', hint: '导入完成、导出完成、录音开始/结束等。' },
  { value: 'debug', label: 'debug（流程细节与 IPC 参数）', hint: '排障用；正文只记前 20 字 + 长度（脱敏规则）。' },
  { value: 'trace', label: 'trace（逐帧/逐样本）', hint: '仅音频排查用，日志量极大，排查完请调回 error。' },
]

const LOG_LEVEL_TAG: Record<string, 'danger' | 'warning' | 'success' | 'info'> = {
  error: 'danger',
  warn: 'warning',
  info: 'success',
  debug: 'info',
  trace: 'info',
}

/** 缺失滤镜 → 受影响的功能（docs/02 §5.1 + docs/14 §3.1 的对应关系） */
const FILTER_IMPACT: Array<{ filter: string; feature: string }> = [
  { filter: 'loudnorm', feature: '响度归一化（导出成品的 -16 LUFS 目标）' },
  { filter: 'alimiter', feature: '真峰限制（truePeakDb）' },
  { filter: 'afftdn', feature: '降噪（处理链 denoise）' },
  { filter: 'deesser', feature: '齿音抑制（deesser）' },
  { filter: 'equalizer', feature: '均衡（eq 频段）' },
  { filter: 'acompressor', feature: '压缩器（compressor）' },
  { filter: 'sidechaincompress', feature: '自动闪避（背景音乐避让人声）' },
  { filter: 'amix', feature: '多轨混合' },
  { filter: 'concat', feature: '整章拼接' },
  { filter: 'atempo', feature: '变速（修复链 tempo）' },
  { filter: 'highpass', feature: '低切（highpass）' },
  { filter: 'lowpass', feature: '高切（lowpass）' },
]

/** 编码器 → 受影响功能 */
const ENCODER_IMPACT: Array<{ encoder: string; feature: string }> = [
  { encoder: 'libmp3lame', feature: 'MP3 导出' },
  { encoder: 'aac', feature: 'M4A / M4B 导出' },
]

const LOG_TAIL_LIMIT = 200

const logEntries = ref<LogEntry[]>([])
/**
 * 日志级别用本地 ref + 回写设置：
 * 直接用 computed 不能 v-model（下拉要能改），而直接 v-model 到 store 又会让
 * 「保存失败」时无法区分「已落库」与「仅在内存」，因此这里显式两步走。
 */
const logLevel = ref<AppSettings['advanced']['logLevel']>('error')
watch(
  () => settings.settings?.advanced.logLevel,
  (value) => { if (value) logLevel.value = value },
  { immediate: true },
)
/**
 * 级别变化就重新订阅一次日志流。
 * 为什么不只在 onMounted 订阅一次：设置是异步读的，若挂载时设置还没到，
 * 订阅到的会是默认的 error 级，用户根本看不到 info 事件。
 */
watch(logLevel, (level) => { void callSafe('log:subscribe', { level }) })
const ffmpeg = computed(() => settings.capabilities?.ffmpeg ?? null)
const missingFilters = computed(() => ffmpeg.value?.missing ?? [])
const missingFilterImpact = computed(() =>
  FILTER_IMPACT.filter(item => missingFilters.value.includes(item.filter)))
const missingEncoders = computed(() => {
  const encoders = ffmpeg.value?.encoders ?? []
  if (!ffmpeg.value?.available) return ENCODER_IMPACT
  return ENCODER_IMPACT.filter(item => !encoders.includes(item.encoder))
})
/** 表格行数按多少排序展示（表多时只看前 12 张，避免面板被撑爆） */
const topTables = computed(() => [...(dbStats.value?.tables ?? [])].sort((a, b) => b.rows - a.rows).slice(0, 12))

let offLog: (() => void) | null = null

function isHl(key: string): boolean {
  return props.highlightKeys.includes(key)
}

function errorText(error: unknown): string | null {
  return isAppError(error) ? error.resolved.title : null
}

function pushLog(entry: LogEntry): void {
  // 最新的放最前：排障时通常只关心「刚发生了什么」
  logEntries.value = [entry, ...logEntries.value].slice(0, LOG_TAIL_LIMIT)
}

/** 日志级别：写设置（store.patch）并让主进程按新级别推送日志流 */
async function onLogLevelChange(): Promise<void> {
  const level = logLevel.value
  if (!level) return
  emit('saveState', { status: 'saving', error: null })
  try {
    await settings.patch({ advanced: { logLevel: level } } as DeepPartial<AppSettings>)
    await callSafe('log:subscribe', { level })
    emit('saveState', { status: 'saved', error: null })
  } catch (error) {
    emit('saveState', { status: 'error', error: errorText(error) })
  }
}

async function loadInfo(): Promise<void> {
  const loaded = await callSafe('app:getInfo', undefined)
  if (loaded) info.value = loaded as AppInfo
}

async function loadStats(): Promise<void> {
  statsBusy.value = true
  try {
    const loaded = await callSafe('db:stats', undefined)
    if (loaded) dbStats.value = loaded as DbStats
  } finally {
    statsBusy.value = false
  }
}

/** 完整性检查：结果是「通过 / 有错误明细」，不抛错（docs/04 §1.1 的 integrity_check） */
async function runIntegrityCheck(): Promise<void> {
  integrityBusy.value = true
  try {
    const result = await callSafe('db:integrityCheck', undefined)
    integrity.value = (result as { ok: boolean; errors: string[] } | null) ?? null
  } finally {
    integrityBusy.value = false
  }
}

/**
 * 导出诊断包（docs/04 §5.4）。
 * 失败原因交给 error-bus（call 的默认策略会展示），这里只处理成功路径。
 */
async function exportDiagnostics(): Promise<void> {
  exportBusy.value = true
  try {
    const result = await call('app:diagnostics', undefined)
    reportPath.value = (result as { reportPath: string }).reportPath
  } catch {
    reportPath.value = null
  } finally {
    exportBusy.value = false
  }
}

async function reveal(path: string | null | undefined): Promise<void> {
  if (!path) return
  await callSafe('app:showItemInFolder', { path })
}

function logDataText(entry: LogEntry): string {
  if (!entry.data) return ''
  try {
    const text = JSON.stringify(entry.data)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return '（无法序列化的上下文）'
  }
}

onMounted(() => {
  void loadInfo()
  void loadStats()
  // 打开诊断面板时才订阅日志流（docs/04 §5.1）；级别已由上面的 watch 负责跟随设置
  if (settings.settings) void callSafe('log:subscribe', { level: logLevel.value })
  offLog = on('log:entry', (raw) => {
    const entry = raw as LogEntry
    if (!entry || typeof entry.ts !== 'number') return
    pushLog(entry)
  })
})

onBeforeUnmount(() => {
  // 注意：契约里没有 log:unsubscribe，因此这里只解除本地监听；
  // 主进程侧的日志级别由「日志级别」设置决定（面板卸载不改设置）。
  offLog?.()
  offLog = null
})
</script>

<template>
  <div class="ns-diag">
    <!-- ── 日志级别与日志流 ───────────────────────────────────────────── -->
    <section class="ns-diag__block">
      <header class="ns-diag__head">
        <h3 class="ns-diag__title">日志</h3>
        <el-button size="small" @click="logEntries = []">清空视图</el-button>
        <el-button size="small" :disabled="!props.paths?.logDir" @click="reveal(props.paths?.logDir)">
          打开日志目录
        </el-button>
      </header>

      <el-form label-width="180px" label-position="left">
        <el-form-item
          label="日志级别"
          :class="{ 'ns-field--hl': isHl('advanced.logLevel') }"
          data-anchor="advanced.logLevel"
        >
          <el-select
            v-model="logLevel"
            class="ns-diag__control"
            @change="onLogLevelChange"
          >
            <el-option v-for="item in LOG_LEVELS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <p class="ns-field__hint">
            {{ LOG_LEVELS.find(item => item.value === logLevel)?.hint ?? '' }}
            日志落盘在 <code>{{ props.paths?.logDir || '（未知）' }}</code>，保留 14 天；
            正文与密钥按脱敏规则处理（docs/04 §5.2）。
          </p>
        </el-form-item>
      </el-form>

      <div class="ns-log">
        <div class="ns-log__head">
          <span>实时日志流（最多保留 {{ LOG_TAIL_LIMIT }} 条）</span>
          <span class="ns-log__count">{{ logEntries.length }} 条</span>
        </div>
        <ul v-if="logEntries.length" class="ns-log__list">
          <li v-for="(entry, index) in logEntries" :key="`${entry.ts}-${index}`" class="ns-log__row">
            <span class="ns-log__time">{{ formatDate(entry.ts, 'HH:mm:ss') }}</span>
            <el-tag size="small" :type="LOG_LEVEL_TAG[entry.level] ?? 'info'">{{ entry.level }}</el-tag>
            <span class="ns-log__event">{{ entry.event }}</span>
            <span v-if="logDataText(entry)" class="ns-log__data">{{ logDataText(entry) }}</span>
          </li>
        </ul>
        <p v-else class="ns-log__empty">
          还没有日志到达。把「日志级别」调到 info 或 debug 后再操作一次，
          事件就会出现在这里（主进程按级别节流推送）。
        </p>
      </div>
    </section>

    <!-- ── ffmpeg 能力 ───────────────────────────────────────────────── -->
    <section class="ns-diag__block" data-anchor="diagnostics.ffmpeg">
      <header class="ns-diag__head">
        <h3 class="ns-diag__title">ffmpeg 能力</h3>
        <el-tag size="small" :type="ffmpeg?.available ? 'success' : 'danger'">
          {{ ffmpeg?.available ? '可用' : '不可用' }}
        </el-tag>
        <el-button size="small" @click="emit('refresh')">重新探测</el-button>
      </header>

      <dl class="ns-kv">
        <div class="ns-kv__row"><dt>版本</dt><dd>{{ ffmpeg?.version || '—' }}</dd></div>
        <div class="ns-kv__row">
          <dt>路径</dt>
          <dd>
            <span>{{ ffmpeg?.path || '（未探测到，使用内置路径）' }}</span>
            <el-button v-if="ffmpeg?.path" size="small" link @click="reveal(ffmpeg?.path)">打开所在文件夹</el-button>
          </dd>
        </div>
        <div class="ns-kv__row"><dt>已探测滤镜</dt><dd>{{ formatInt(ffmpeg?.filters.length ?? 0) }} 个</dd></div>
        <div class="ns-kv__row"><dt>已探测编码器</dt><dd>{{ formatInt(ffmpeg?.encoders.length ?? 0) }} 个</dd></div>
      </dl>

      <template v-if="missingFilterImpact.length">
        <p class="ns-diag__warn">
          缺少 {{ missingFilterImpact.length }} 个关键滤镜：相关控件已在设置页与应用内**隐藏或禁用**，
          这是设计约定（docs/02 §5.1：探测到缺失就不要等用户点了才报错）。
        </p>
        <el-table :data="missingFilterImpact" size="small">
          <el-table-column prop="filter" label="缺失滤镜" width="180" />
          <el-table-column prop="feature" label="受影响功能" min-width="280" />
        </el-table>
      </template>
      <p v-else class="ns-diag__ok">关键滤镜齐全，混音与导出全功能可用。</p>

      <template v-if="missingEncoders.length">
        <p class="ns-diag__warn">
          缺少编码器：{{ missingEncoders.map(item => item.encoder).join('、') }}
          —— 对应导出格式会被禁用。
        </p>
      </template>
    </section>

    <!-- ── 数据库 ───────────────────────────────────────────────────── -->
    <section class="ns-diag__block" data-anchor="diagnostics.db">
      <header class="ns-diag__head">
        <h3 class="ns-diag__title">数据库</h3>
        <el-button size="small" :loading="statsBusy" @click="loadStats">刷新统计</el-button>
        <el-button size="small" :loading="integrityBusy" @click="runIntegrityCheck">完整性检查</el-button>
      </header>

      <dl class="ns-kv">
        <div class="ns-kv__row"><dt>库大小</dt><dd>{{ dbStats ? formatBytes(dbStats.sizeBytes) : '—' }}</dd></div>
        <div class="ns-kv__row"><dt>结构版本</dt><dd>{{ dbStats?.schemaVersion ?? '—' }}</dd></div>
        <div class="ns-kv__row">
          <dt>完整性检查</dt>
          <dd>
            <el-tag v-if="!integrity" size="small">未检查</el-tag>
            <el-tag v-else :type="integrity.ok ? 'success' : 'danger'" size="small">
              {{ integrity.ok ? '通过' : `发现 ${integrity.errors.length} 个问题` }}
            </el-tag>
            <ul v-if="integrity && !integrity.ok" class="ns-diag__errors">
              <li v-for="(message, index) in integrity.errors.slice(0, 10)" :key="index">{{ message }}</li>
            </ul>
          </dd>
        </div>
      </dl>

      <el-table v-if="topTables.length" :data="topTables" size="small" max-height="240">
        <el-table-column prop="name" label="表" min-width="200" />
        <el-table-column label="行数" width="140">
          <template #default="{ row }">{{ formatInt(row.rows) }}</template>
        </el-table-column>
      </el-table>
      <p v-else class="ns-diag__muted">还没有拿到表统计，点「刷新统计」重试。</p>
    </section>

    <!-- ── 版本信息与诊断包 ──────────────────────────────────────────── -->
    <section class="ns-diag__block" data-anchor="diagnostics.info">
      <header class="ns-diag__head">
        <h3 class="ns-diag__title">版本信息</h3>
      </header>

      <dl class="ns-kv">
        <div class="ns-kv__row"><dt>应用版本</dt><dd>{{ info?.version ?? '—' }}</dd></div>
        <div class="ns-kv__row"><dt>Electron / Node / Chrome</dt><dd>{{ info ? `${info.electron} / ${info.node} / ${info.chrome}` : '—' }}</dd></div>
        <div class="ns-kv__row"><dt>平台 / 架构</dt><dd>{{ info ? `${info.platform} ${info.arch}` : '—' }}</dd></div>
        <div class="ns-kv__row">
          <dt>运行形态</dt>
          <dd>
            {{ info?.isPackaged ? '打包版' : '开发模式' }}
            <el-tag v-if="info?.portable" size="small" effect="plain">便携版</el-tag>
          </dd>
        </div>
        <div class="ns-kv__row"><dt>用户数据目录</dt><dd>{{ props.paths?.userData ?? '—' }}</dd></div>
      </dl>

      <div class="ns-diag__export">
        <el-button type="primary" :loading="exportBusy" @click="exportDiagnostics">导出诊断包</el-button>
        <template v-if="reportPath">
          <span class="ns-diag__path">{{ reportPath }}</span>
          <el-button size="small" @click="reveal(reportPath)">打开所在文件夹</el-button>
        </template>
        <span v-else class="ns-diag__muted">诊断包包含脱敏配置、最近 3 天日志、崩溃清单与任务历史，不含作品正文与密钥。</span>
      </div>

      <div class="ns-diag__steps">
        <h4>报障三步（docs/22 §8）</h4>
        <ol>
          <li>记下提示里的错误编号（形如 <code>E400012</code>）；提示条上就有，也可以在日志流里找到。</li>
          <li>点上面的「导出诊断包」，把生成的 zip 文件准备好。</li>
          <li>把**编号 + 诊断包**一起发给支持；编号让支持人员直接定位到消息表条目，不必猜。</li>
        </ol>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ns-diag {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.ns-diag__block {
  padding: 12px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-diag__head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.ns-diag__title {
  flex: 1;
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-diag__control {
  width: 380px;
  max-width: 100%;
}
.ns-diag__warn {
  margin: 10px 0 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgb(230 162 60 / 12%);
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.7;
}
.ns-diag__ok {
  margin: 10px 0 0;
  color: var(--ns-success, #67c23a);
  font-size: 12px;
}
.ns-diag__muted {
  margin: 6px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-diag__errors {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
  line-height: 1.6;
}
.ns-diag__export {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}
.ns-diag__path {
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
.ns-diag__steps {
  margin-top: 14px;
  padding: 10px 12px;
  border-left: 3px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  background: rgb(64 158 255 / 7%);
}
.ns-diag__steps h4 {
  margin: 0 0 6px;
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.ns-diag__steps ol {
  margin: 0;
  padding-left: 20px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.8;
}
.ns-kv {
  margin: 8px 0 0;
}
.ns-kv__row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.7;
}
.ns-kv__row dt {
  flex: 0 0 170px;
  color: var(--ns-text-secondary, #909399);
}
.ns-kv__row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--ns-text-regular, #606266);
  word-break: break-all;
}
.ns-log {
  margin-top: 10px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 6px;
}
.ns-log__head {
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ns-border, #dcdfe6);
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-log__list {
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.ns-log__row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 10px;
  border-bottom: 1px solid var(--ns-fill, #ebeef5);
  font-size: 11px;
}
.ns-log__time {
  flex: 0 0 62px;
  color: var(--ns-text-secondary, #909399);
  font-family: ui-monospace, Consolas, monospace;
}
.ns-log__event {
  flex: 0 1 auto;
  color: var(--ns-text-primary, #303133);
  font-family: ui-monospace, Consolas, monospace;
}
.ns-log__data {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-family: ui-monospace, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-log__empty {
  margin: 0;
  padding: 14px 10px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
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
