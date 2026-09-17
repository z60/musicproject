<!--
  Novel Studio · 模型状态与嵌入/ASR 设置（设置页「AI」分类的下半部分）
  ============================================================================
  设计依据：
    · docs/02 §5.1 —— **能力探测**：启动时校验模型文件（存在性 + SHA-256），
      「探测到缺失就隐藏或禁用控件，而不是等用户点了才报错」
    · docs/02 §5.2 —— 模型清单、模型目录解析（开发读 resources/models，
      打包读 process.resourcesPath/models）
    · docs/04 §6   —— ONNX embedding 只允许 1 个会话、batch 自适应（默认 16），
      过大反而更慢且容易 OOM
    · docs/06 §6   —— embedding 维度以运行时为准，换模型必须按 model_id 隔离并全部重算
    · docs/22 §7   —— 模型缺失（MODEL_MISSING / CANVAS_EMBEDDING_UNAVAILABLE）会让
      向量判定降级为规则判定，这是**必须让用户看见**的降级，不能静默

  本组件做三件事：
    1. 逐条列出 ModelStatus（id / kind / exists / ok / size / SHA-256 校验 / message）；
    2. 给出与状态对应的修复指引（缺失 → 放到哪个目录；校验失败 → 重新获取文件）；
    3. 编辑 embedding / asr 分组设置，并说明降级后果。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { callSafe } from '@/shared/lib/ipc.ts'
import { isAppError } from '@shared/errors.ts'
import { formatBytes } from '@/shared/lib/format.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import type { AppCapabilities, AppSettings, ModelStatus } from '@shared/types.ts'
import type { DeepPartial } from '@shared/ipc.ts'

interface SaveState {
  status: SaveStatus
  error?: string | null
}

const props = withDefaults(defineProps<{
  /** app:getCapabilities 里的模型清单（由 SettingsView 从 settings store 传入） */
  models?: ModelStatus[]
  /** app:getCapabilities 里的 embedding 能力（维度以运行时为准，docs/06 §6） */
  embedding?: AppCapabilities['embedding'] | null
  /** 模型目录（来自 app:getPaths，修复指引里要显示它） */
  modelDir?: string
  /** 需要高亮的设置键（?focus=，docs/22 §7） */
  highlightKeys?: string[]
}>(), {
  models: () => [],
  embedding: null,
  modelDir: '',
  highlightKeys: () => [],
})

const emit = defineEmits<{
  saveState: [state: SaveState]
  /** 请求父级重新拉取能力探测（settings.refreshCapabilities()） */
  refresh: []
}>()

const settings = useSettingsStore()

const embeddingSettings = computed<AppSettings['embedding'] | null>(() => settings.settings?.embedding ?? null)
const asrSettings = computed<AppSettings['asr'] | null>(() => settings.settings?.asr ?? null)

/** 按 kind 分组的模型 id（下拉候选；允许手填其它 id） */
const embeddingIds = computed(() => props.models.filter(m => m.kind === 'embedding').map(m => m.id))
const asrIds = computed(() => props.models.filter(m => m.kind === 'whisper').map(m => m.id))

const missing = computed(() => props.models.filter(m => !m.exists))
const broken = computed(() => props.models.filter(m => m.exists && !m.ok))
const ready = computed(() => props.models.filter(m => m.ok))

/** 向量判定是否真的可用（决定画本生成会不会降级为规则判定） */
const vectorUsable = computed(() => props.embedding?.available === true && missing.value.length + broken.value.length === 0)

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
]

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

/** 状态标签：缺失 / 校验失败 / 就绪 */
function statusTag(model: ModelStatus): { text: string; type: 'danger' | 'warning' | 'success' } {
  if (!model.exists) return { text: '缺失', type: 'danger' }
  if (!model.ok) return { text: '校验失败', type: 'warning' }
  return { text: '就绪', type: 'success' }
}

/** 修复指引：把「怎么办」写清楚，而不是只说「缺了」 */
function repairHint(model: ModelStatus): string {
  if (!model.exists) {
    return `把该模型的文件放到模型目录下的对应子目录（当前目录：${props.modelDir || '（未探测到）'}），或改用自带模型的完整安装版。`
  }
  if (!model.ok) {
    return '文件内容与 models.json 登记的 SHA-256 不一致（多半是下载中断或版本不符），请重新获取该文件后点「重新探测」。'
  }
  return '文件校验通过，可直接使用。'
}

/** 短哈希展示：只显示前 12 位（完整值在诊断包里） */
function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 12)}…` : '—'
}

async function openModelFolder(model: ModelStatus): Promise<void> {
  if (!model.filePath) return
  await callSafe('app:showItemInFolder', { path: model.filePath })
}
</script>

<template>
  <div class="ns-models">
    <!-- ── 模型清单 ──────────────────────────────────────────────────── -->
    <section class="ns-models__block" data-anchor="ai.models">
      <header class="ns-models__head">
        <h3 class="ns-models__title">模型文件状态</h3>
        <span class="ns-models__counts">
          就绪 {{ ready.length }} · 缺失 {{ missing.length }} · 校验失败 {{ broken.length }}
        </span>
        <el-button size="small" @click="emit('refresh')">重新探测</el-button>
      </header>

      <p class="ns-models__note" :class="{ 'is-bad': !vectorUsable }">
        <template v-if="vectorUsable">
          语义模型可用（{{ props.embedding?.modelId }}，维度 {{ props.embedding?.dim }}）：
          画本生成会使用向量判定（decidedBy = vector）。
        </template>
        <template v-else>
          语义模型不可用：画本生成会**降级为规则判定**（decidedBy = rule），
          生成报告里的 embeddingUsed = false。降级不是错误，但同名角色增多时准确率会明显下降，
          建议先修好模型再批量生成。
        </template>
      </p>

      <el-table v-if="props.models.length" :data="props.models" size="small" class="ns-models__table">
        <el-table-column prop="id" label="模型" min-width="160" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.kind === 'whisper' ? '语音识别' : '语义向量' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTag(row).type">{{ statusTag(row).text }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="100">
          <template #default="{ row }">
            {{ row.exists ? formatBytes(row.sizeBytes) : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="SHA-256" min-width="200">
          <template #default="{ row }">
            <div class="ns-models__hash">
              <span>期望 {{ shortHash(row.expectedSha256) }}</span>
              <span :class="{ 'is-bad': row.exists && !row.ok }">实际 {{ shortHash(row.actualSha256) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="修复指引" min-width="260">
          <template #default="{ row }">
            <span class="ns-models__fix">{{ repairHint(row) }}</span>
            <p v-if="row.message" class="ns-models__message">探测信息：{{ row.message }}</p>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link @click="openModelFolder(row)">打开所在文件夹</el-button>
          </template>
        </el-table-column>
      </el-table>

      <p v-else class="ns-models__note">
        尚未拿到模型清单（app:getCapabilities 未返回 models）；点「重新探测」重试，
        若仍然为空，请到「日志与诊断」查看诊断包中的记录。
      </p>
    </section>

    <!-- ── 嵌入设置 ──────────────────────────────────────────────────── -->
    <section v-if="embeddingSettings" class="ns-models__block">
      <h3 class="ns-models__title">语义向量（embedding）</h3>
      <el-form label-width="180px" label-position="left">
        <el-form-item
          label="模型"
          :class="{ 'ns-field--hl': isHl('embedding.modelId') }"
          data-anchor="embedding.modelId"
        >
          <el-select
            v-model="embeddingSettings.modelId"
            class="ns-models__control"
            filterable
            allow-create
            default-first-option
            @change="save({ embedding: { modelId: embeddingSettings.modelId } })"
          >
            <el-option v-for="id in embeddingIds" :key="id" :label="id" :value="id" />
          </el-select>
          <p class="ns-field__hint">
            换模型会让已完成行的向量失效，必须按 model_id 隔离并重算说话人判定（docs/06 §6）：
            重算耗时随章节数增长，建议在空闲时段做。
          </p>
        </el-form-item>

        <el-form-item
          label="批大小"
          :class="{ 'ns-field--hl': isHl('embedding.batchSize') }"
          data-anchor="embedding.batchSize"
        >
          <el-input-number
            v-model="embeddingSettings.batchSize"
            :min="1"
            :max="64"
            controls-position="right"
            @change="save({ embedding: { batchSize: embeddingSettings.batchSize } })"
          />
          <span class="ns-field__unit">建议 8~32（默认 16）；内存不足时依次降到 8 / 4 / 1</span>
        </el-form-item>

        <el-form-item
          label="线程数"
          :class="{ 'ns-field--hl': isHl('embedding.threads') }"
          data-anchor="embedding.threads"
        >
          <el-input-number
            v-model="embeddingSettings.threads"
            :min="1"
            :max="32"
            controls-position="right"
            @change="save({ embedding: { threads: embeddingSettings.threads } })"
          />
          <span class="ns-field__unit">建议 留出 1 个核给界面（核数 - 1）；0 表示自动</span>
        </el-form-item>
      </el-form>
    </section>

    <!-- ── 语音识别设置 ──────────────────────────────────────────────── -->
    <section v-if="asrSettings" class="ns-models__block">
      <h3 class="ns-models__title">语音识别（ASR）</h3>
      <el-form label-width="180px" label-position="left">
        <el-form-item
          label="模型"
          :class="{ 'ns-field--hl': isHl('asr.modelId') }"
          data-anchor="asr.modelId"
        >
          <el-select
            v-model="asrSettings.modelId"
            class="ns-models__control"
            filterable
            allow-create
            default-first-option
            @change="save({ asr: { modelId: asrSettings.modelId } })"
          >
            <el-option v-for="id in asrIds" :key="id" :label="id" :value="id" />
          </el-select>
          <p class="ns-field__hint">
            ASR 只用于「连续录制切片匹配」与「强制对齐」等辅助场景；缺失时这些功能不可用，
            但手工对轨与导出不受影响。模型缺失时的降级必须可见，不允许静默。
          </p>
        </el-form-item>

        <el-form-item
          label="识别语言"
          :class="{ 'ns-field--hl': isHl('asr.language') }"
          data-anchor="asr.language"
        >
          <el-select
            v-model="asrSettings.language"
            class="ns-models__control ns-models__control--sm"
            @change="save({ asr: { language: asrSettings.language } })"
          >
            <el-option v-for="item in LANGUAGE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <p class="ns-field__hint">中文小说固定选「中文」比自动检测更稳（短句的自动检测常判错）。</p>
        </el-form-item>

        <el-form-item
          label="线程数"
          :class="{ 'ns-field--hl': isHl('asr.threads') }"
          data-anchor="asr.threads"
        >
          <el-input-number
            v-model="asrSettings.threads"
            :min="1"
            :max="32"
            controls-position="right"
            @change="save({ asr: { threads: asrSettings.threads } })"
          />
          <span class="ns-field__unit">识别常驻内存数百 MB，并发固定为 1（docs/04 §6）</span>
        </el-form-item>

        <el-form-item
          label="自动翻译"
          :class="{ 'ns-field--hl': isHl('asr.translate') }"
          data-anchor="asr.translate"
        >
          <el-switch
            v-model="asrSettings.translate"
            @change="save({ asr: { translate: asrSettings.translate } })"
          />
          <span class="ns-field__unit">开启后识别结果会附带译文（仅用于对照，不写进画本）</span>
        </el-form-item>
      </el-form>
    </section>
  </div>
</template>

<style scoped>
.ns-models {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.ns-models__block {
  padding: 12px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-models__head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.ns-models__title {
  flex: 1;
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-models__counts {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-models__note {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--ns-bg-subtle, #fafafa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
.ns-models__note.is-bad {
  background: rgb(230 162 60 / 12%);
  color: var(--ns-warning, #e6a23c);
}
.ns-models__table {
  margin-top: 10px;
}
.ns-models__hash {
  display: flex;
  flex-direction: column;
  color: var(--ns-text-secondary, #909399);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}
.ns-models__hash .is-bad {
  color: var(--ns-danger, #f56c6c);
}
.ns-models__fix {
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.ns-models__message {
  margin: 4px 0 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.ns-models__control {
  width: 340px;
  max-width: 100%;
}
.ns-models__control--sm {
  width: 180px;
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
