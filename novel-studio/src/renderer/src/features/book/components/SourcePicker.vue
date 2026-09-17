<!--
  书籍导入域 · 来源选择（docs/10 §2 支持的导入源 / §7.1 Step 1）

  设计依据：
    · docs/10 §2  —— 五种入口：文件 / DOCX / PDF / 粘贴文本 / URL（本组件覆盖后三种形态）
    · docs/10 §7.1 —— Step 1「选择来源（文件 / 粘贴 / URL）」
    · docs/10 §8.5 —— 粘贴文本直通，超过 1 MB 要提示「解析可能需要一会」
    · docs/10 §8.4 —— URL 抓取的礼貌与限制（单页 5 MB / 总页数 50 / 站点拒绝时建议改粘贴）

  为什么拖拽要单独处理 Electron 的文件路径：
    浏览器里 File 对象没有磁盘路径，而本应用需要把「路径」交给主进程读（限流、魔数判定）。
    Electron 的 File 上带有 `path`（v32 起改为 webUtils.getPathForFile），
    因此这里优先取 path，取不到就明确提示「请用『选择文件』按钮」——
    绝不用 FileReader 把 200 MB 文本读进渲染进程（那正是 docs/10 §8.1 要避免的）。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { IMPORT_LIMITS } from '@shared/constants.ts'
import type { ImportFileProbe } from '@shared/types.ts'
import { formatBytes, formatCount, UNKNOWN } from '@/shared/lib/format.ts'

/** 与 sources/import.store.ts 的 SourceMode 一致（此处独立声明，避免组件依赖 store 类型推导） */
type PickMode = 'file' | 'paste' | 'url'

const props = withDefaults(defineProps<{
  mode: PickMode
  fileName?: string
  filePath?: string | null
  probe?: ImportFileProbe | null
  /** 超过 settings.import.maxFileSizeBytes（由父组件从设置读入） */
  fileTooLarge?: boolean
  maxFileSizeBytes?: number
  pasteText?: string
  url?: string
  /** 解析中/探测中：禁止重复触发 */
  busy?: boolean
}>(), {
  fileName: '',
  filePath: null,
  probe: null,
  fileTooLarge: false,
  maxFileSizeBytes: IMPORT_LIMITS.maxFileSizeBytes,
  pasteText: '',
  url: '',
  busy: false,
})

const emit = defineEmits<{
  'update:mode': [mode: PickMode]
  'update:pasteText': [text: string]
  'update:url': [url: string]
  /** 点击「选择文件」→ 父组件调 app:openFileDialog */
  'pick-file': []
  /** 拖拽落下的文件路径（父组件拿去 probeFile） */
  'file-dropped': [path: string]
}>()

/** 拖拽高亮 */
const dragging = ref(false)
/** 本地提示（拖拽里没有文件路径、剪贴板读取失败等）：这类说明不该进 error-bus */
const localNotice = ref('')

const probeKindLabel = computed(() => {
  const kind = props.probe?.kind
  if (!kind || kind === 'unknown') return '类型未知'
  return ({ txt: 'TXT 纯文本', docx: 'DOCX 文档', pdf: 'PDF 文档', paste: '粘贴文本', url: '网页' } as const)[kind]
})

const sizeText = computed(() => formatBytes(props.probe?.sizeBytes ?? null))
const limitText = computed(() => formatBytes(props.maxFileSizeBytes))

/** PDF 无文本层要在选择阶段就预警（docs/10 §8.3：不要等到解析完产出一本空书） */
const pdfNoTextLayer = computed(() => props.probe?.kind === 'pdf' && props.probe?.hasTextLayer === false)

const pasteCharCount = computed(() => props.pasteText.length)
const pasteIsLarge = computed(() => props.pasteText.length > 1_000_000)

const urlValid = computed(() => /^https?:\/\//i.test(props.url.trim()))

function switchMode(next: PickMode): void {
  localNotice.value = ''
  emit('update:mode', next)
}

/** el-radio-group 的 model-value 是宽类型：在这里收窄，避免模板里写 TS 断言 */
function onModeChange(value: string | number | boolean | undefined): void {
  if (value === 'file' || value === 'paste' || value === 'url') switchMode(value)
}

/** 粘贴文本输入：el-input（textarea）的 update:model-value 载荷为 string */
function onPasteTextInput(value: string): void {
  emit('update:pasteText', String(value ?? ''))
}

/** 网址输入：el-input 的 update:model-value 载荷为 string */
function onUrlInput(value: string): void {
  emit('update:url', String(value ?? ''))
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const transfer = event.dataTransfer
  if (!transfer) return

  // 1) 拖进来的文件（优先）
  const file = transfer.files?.[0]
  if (file) {
    const path = (file as File & { path?: string }).path
    if (path) {
      emit('update:mode', 'file')
      emit('file-dropped', path)
      return
    }
    localNotice.value = `已拖入「${file.name}」，但当前环境拿不到它的磁盘路径。请点「选择文件」按钮选择它（不把文件读进界面，是为了 200 MB 大文件也能导入）。`
    return
  }

  // 2) 拖进来的文本/链接
  const text = transfer.getData('text/plain') || transfer.getData('text')
  if (text && text.trim()) {
    if (/^https?:\/\/\S+$/i.test(text.trim())) {
      emit('update:mode', 'url')
      emit('update:url', text.trim())
      localNotice.value = '已识别为网页地址，切换到 URL 来源'
    } else {
      emit('update:mode', 'paste')
      emit('update:pasteText', text)
      localNotice.value = `已把拖入的文本填入文本框（${formatCount(text.length)} 字）`
    }
    return
  }

  localNotice.value = '这次拖拽里没有可识别的内容：可以拖 .txt/.docx/.pdf 文件，或直接拖入一段文本。'
}

async function pasteFromClipboard(): Promise<void> {
  localNotice.value = ''
  try {
    const text = await globalThis.navigator?.clipboard?.readText?.()
    if (!text) {
      localNotice.value = '剪贴板里没有文本内容'
      return
    }
    emit('update:mode', 'paste')
    emit('update:pasteText', text)
    localNotice.value = `已从剪贴板读入 ${formatCount(text.length)} 字`
  } catch {
    // 剪贴板权限被拒是常见情况：给可执行的下一步，而不是一句「失败」
    localNotice.value = '读不到剪贴板（可能被系统权限拦截）：请手动选中正文后 Ctrl+C / Ctrl+V 粘贴到文本框。'
  }
}
</script>

<template>
  <section class="source-picker">
    <header class="source-picker__head">
      <h3 class="source-picker__title">第 1 步 · 选择来源</h3>
      <p class="source-picker__desc">
        支持 TXT / DOCX / PDF 文件、直接粘贴文本、以及网页地址（URL）。
        PDF 仅支持有文字层的版本，扫描件需要 OCR，本版本不支持。
      </p>
    </header>

    <el-radio-group
      class="source-picker__modes"
      :model-value="props.mode"
      :disabled="props.busy"
      @update:model-value="onModeChange"
    >
      <el-radio-button value="file">📄 文件</el-radio-button>
      <el-radio-button value="paste">📋 粘贴文本</el-radio-button>
      <el-radio-button value="url">🌐 网页地址</el-radio-button>
    </el-radio-group>

    <!-- ① 文件：拖拽区 + 文件信息 -->
    <div v-if="props.mode === 'file'" class="source-picker__panel">
      <div
        class="source-picker__drop"
        :class="{ 'is-dragging': dragging, 'has-file': !!props.filePath }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <template v-if="props.filePath">
          <div class="source-picker__file-row">
            <el-tag type="info" size="small">{{ probeKindLabel }}</el-tag>
            <strong class="source-picker__file-name" :title="props.filePath">{{ props.fileName }}</strong>
            <span class="source-picker__file-size">{{ sizeText }}</span>
          </div>
          <p class="source-picker__file-path" :title="props.filePath">{{ props.filePath }}</p>
        </template>
        <template v-else>
          <p class="source-picker__drop-main">把文件拖到这里，或</p>
          <el-button type="primary" :disabled="props.busy" @click="emit('pick-file')">选择文件…</el-button>
          <p class="source-picker__drop-hint">支持 .txt / .docx / .pdf｜单文件上限 {{ limitText }}（可在设置中调整）</p>
        </template>
      </div>

      <div class="source-picker__actions">
        <el-button :disabled="props.busy" @click="emit('pick-file')">重新选择</el-button>
        <span v-if="props.filePath" class="source-picker__meta">
          类型判定：扩展名 + 魔数双重校验（防止改扩展名）
        </span>
      </div>

      <el-alert
        v-if="props.fileTooLarge"
        type="warning"
        show-icon
        :closable="false"
        title="文件超过大小上限"
        :description="`该文件为 ${sizeText}，超过上限 ${limitText}。可到「设置 → 导入」调大上限，或先在外部把它切成多本。`"
      />
      <el-alert
        v-else-if="pdfNoTextLayer"
        type="warning"
        show-icon
        :closable="false"
        title="这个 PDF 可能没有文字层"
        description="探测结果显示它像是扫描件（只有图片）。继续导入会失败并提示改用 OCR 后的文本，建议现在换一个 TXT 版本。"
      />
    </div>

    <!-- ② 粘贴文本 -->
    <div v-else-if="props.mode === 'paste'" class="source-picker__panel">
      <div class="source-picker__paste-head">
        <span class="source-picker__meta">已输入 {{ formatCount(pasteCharCount) }} 字</span>
        <el-button size="small" :disabled="props.busy" @click="pasteFromClipboard">从剪贴板粘贴</el-button>
      </div>
      <el-input
        :model-value="props.pasteText"
        type="textarea"
        :rows="12"
        resize="vertical"
        placeholder="把小说正文粘贴到这里（Ctrl+V）。超过 1 MB 时解析会慢一些，期间可以取消。"
        @update:model-value="onPasteTextInput"
      />
      <el-alert
        v-if="pasteIsLarge"
        type="info"
        show-icon
        :closable="false"
        title="文本较大，解析可能需要一会"
        :description="`当前 ${formatCount(pasteCharCount)} 字。解析是后台任务，可以取消；取消时不会写入任何数据。`"
      />
    </div>

    <!-- ③ URL -->
    <div v-else class="source-picker__panel">
      <el-input
        :model-value="props.url"
        placeholder="https://example.com/book/123.html"
        :disabled="props.busy"
        clearable
        @update:model-value="onUrlInput"
      >
        <template #prepend>网址</template>
      </el-input>

      <p v-if="props.url && !urlValid" class="source-picker__invalid">
        请填写以 http:// 或 https:// 开头的公开网页地址（只接受公开站点）。
      </p>

      <ul class="source-picker__rules">
        <li>抓取遵循站点 robots.txt，请求间隔 {{ IMPORT_LIMITS.fetchDelayMs }} ms（可在设置调整）。</li>
        <li>单页上限 {{ formatBytes(IMPORT_LIMITS.maxUrlPageBytes) }}，最多跟随 {{ IMPORT_LIMITS.maxUrlPages }} 页。</li>
        <li>内网 / 环回地址会被拒绝（SSRF 防护）；遇到 403 / 429 会停止抓取。</li>
        <li>站点拒绝访问时请改用「粘贴文本」。</li>
        <li>
          URL 来源暂不支持解析预览
          <el-tooltip content="解析预览通道 book:previewSplit 只接受本地文件或文本载荷，没有 URL 入参" placement="top">
            <span class="source-picker__why">为什么？</span>
          </el-tooltip>
        </li>
      </ul>
    </div>

    <p v-if="localNotice" class="source-picker__notice">{{ localNotice }}</p>
    <p v-if="props.mode === 'file' && !props.probe" class="source-picker__meta">
      尚未探测文件：{{ UNKNOWN }}
    </p>
  </section>
</template>

<style scoped>
.source-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.source-picker__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.source-picker__title {
  margin: 0;
  font-size: 15px;
}
.source-picker__desc {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.6;
}
.source-picker__modes {
  align-self: flex-start;
}
.source-picker__panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.source-picker__drop {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  padding: 22px 16px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-subtle, #fafafa);
  text-align: center;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.source-picker__drop.is-dragging {
  border-color: var(--ns-primary, #409eff);
  background: rgb(64 158 255 / 8%);
}
.source-picker__drop.has-file {
  align-items: stretch;
}
.source-picker__drop-main {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
}
.source-picker__drop-hint {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.source-picker__file-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.source-picker__file-name {
  flex: 1;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-picker__file-size {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.source-picker__file-path {
  margin: 0;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-picker__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.source-picker__paste-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.source-picker__meta {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.source-picker__invalid {
  margin: 0;
  color: var(--ns-danger, #f56c6c);
  font-size: 12px;
}
.source-picker__rules {
  margin: 0;
  padding-left: 18px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.8;
}
.source-picker__why {
  color: var(--ns-primary, #409eff);
  cursor: help;
}
.source-picker__notice {
  margin: 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.6;
}
</style>
