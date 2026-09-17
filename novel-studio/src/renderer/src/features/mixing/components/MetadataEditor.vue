<!--
  Novel Studio · 导出元数据与封面（docs/15 §5.5 Step 5 / §5.1 元数据模板）
  ============================================================================
  设计依据：
    · docs/15 §5.1 —— 元数据模板：
        title={chapterTitle} artist={author} album={bookTitle}
        album_artist={narrator} track={chapterIndex}/{total} genre=Audiobook date={year}
      「写标签」是**写入音频容器**（MP3 的 ID3v2.3、M4A/M4B 的 MP4 ilst）；
      文件本身即使标签写失败也仍然可用（docs/15 §11：元数据写入失败只是警告）。
    · docs/11 §4.9 —— 文本编辑防抖 500 ms 落库 + 失败必须明确提示「改动仍在内存中」
      → 因此本组件的输入统一走 `useEditableField`，配合 `AutoSaveIndicator`。
    · docs/15 §11 —— 封面格式不支持时提示 JPEG/PNG 并忽略封面继续。

  为什么封面预览用 ns-media:// 而不是直接 <img src="C:\\...">：
    渲染进程不允许读任意本地文件（docs/01 §4.3 的协议校验是唯一安全边界）。
    项目内封面（book.coverPath 这类相对路径）能预览；用户在向导里新选的绝对路径
    只有主进程能读，因此这里只显示路径并给出说明。
-->

<script setup lang="ts">
import { computed, watch } from 'vue'
import type { ExportFormat, ExportMetadata } from '@shared/types.ts'
import { UNKNOWN } from '@/shared/lib/format.ts'
import { tryBuildMediaUrl } from '@/shared/lib/media-url.ts'
import { useEditableField } from '@/shared/lib/use-editable-field.ts'
import { useSessionStore } from '@/app/store/session.store.ts'
import AutoSaveIndicator from '@/shared/ui/AutoSaveIndicator.vue'

const props = withDefaults(defineProps<{
  /** 当前导出元数据（来自向导参数的 store） */
  metadata: ExportMetadata
  /** 是否把标签写进成品文件（settings.export.writeMetadata） */
  writeMetadata: boolean
  /** 书籍信息（「从书籍信息回填」按钮用） */
  book?: { title: string; author: string | null; narrator: string } | null
  /** 输出格式：决定提示「写入 ID3」还是「写入 MP4 标签」 */
  format: ExportFormat
  /** 参数还在加载时禁用输入 */
  disabled?: boolean
}>(), {
  book: null,
  disabled: false,
})

const emit = defineEmits<{
  'update:writeMetadata': [value: boolean]
  commit: [metadata: ExportMetadata]
  'pick-cover': []
  'clear-cover': []
  'fill-from-book': []
}>()

const session = useSessionStore()

/**
 * 元数据表单：防抖 500 ms 提交到向导 store。
 * 这里的「落库」是写进向导参数（并随导出参数一起过 IPC），不是写数据库，
 * 但语义一样：**改了必须看得见是否提交成功**（docs/11 §4.9）。
 */
const {
  value: draft,
  status: saveStatus,
  savedAt,
  lastError,
  flush,
  retry,
  reset: resetDraft,
} = useEditableField<ExportMetadata>(
  () => ({ ...props.metadata }),
  {
    write: async (value) => {
      emit('commit', { ...value })
      return value
    },
    delayMs: 500,
    failureDetail: '元数据未能提交到导出参数，你的修改仍在内存中。可点「重试」重新提交。',
  },
)

/** 外部替换（切书/恢复默认）时同步表单；值相同不重置，避免自己把自己打断 */
watch(() => props.metadata, (next) => {
  const incoming = next ?? {}
  if (JSON.stringify(incoming) === JSON.stringify(draft.value)) return
  // 用 composable 暴露的 reset()，而不是 draft.reset()：draft 是只读的 value ref，
  // 直接在上面调方法会报 TS2339「Property 'reset' does not exist on type 'Ref<...>'」。
  resetDraft({ ...incoming })
}, { deep: true })

const writeMetadataProxy = computed<boolean>({
  get: () => props.writeMetadata,
  set: (value) => emit('update:writeMetadata', value),
})

/** 标签说明：MP3 → ID3v2.3；M4A/M4B → MP4 ilst（docs/15 §5.1 的命令要点） */
const tagHint = computed(() => (props.format === 'mp3'
  ? '将写入 ID3v2.3 标签（含封面 attached_pic）；WAV 无法承载标签，选 WAV 时会被忽略。'
  : '将写入 MP4 标签（M4A/M4B 同容器）；播放器的章节列表来自单独的章节表。'))

const fieldRows = [
  { key: 'title', label: '标题', placeholder: '{chapterTitle}（按章替换）' },
  { key: 'artist', label: '艺术家 / 作者', placeholder: '作者名' },
  { key: 'album', label: '专辑 / 书名', placeholder: '书名' },
  { key: 'narrator', label: '朗读人', placeholder: '旁白配音员（album_artist）' },
  { key: 'genre', label: '流派', placeholder: 'Audiobook' },
  { key: 'date', label: '年份 / 日期', placeholder: '2024' },
] as const

/** 项目内封面可以预览；向导里新选的绝对路径只有主进程能读 */
const coverPreview = computed(() => tryBuildMediaUrl(session.projectId, props.metadata.coverPath ?? null))
const coverName = computed(() => {
  const path = props.metadata.coverPath
  if (!path) return UNKNOWN
  return path.split(/[\\/]+/).pop() ?? path
})

function onFieldInput(key: (typeof fieldRows)[number]['key'], value: string): void {
  draft.value = { ...draft.value, [key]: value } as ExportMetadata
}

/** 模板里不能写泛型/断言表达式，包一层取值函数（模板表达式保持「只读 + 简单调用」） */
function fieldValue(key: (typeof fieldRows)[number]['key']): string {
  return (draft.value[key] as string | undefined) ?? ''
}

/** 生成某个字段的 input 处理器（el-input 的 update:model-value 只给值） */
function onFieldInputOf(key: (typeof fieldRows)[number]['key']): (value: string) => void {
  return (value: string) => { onFieldInput(key, value) }
}

const errorText = computed(() => {
  if (saveStatus.value !== 'error') return null
  const error = lastError.value as { message?: string } | null
  return error?.message ?? null
})

/** 失焦立即冲刷（用户填完最后一项就点「下一步」，不该等防抖） */
function onBlur(): void {
  void flush()
}

defineExpose({ flush, retry })
</script>

<template>
  <section class="ns-meta">
    <header class="ns-meta__head">
      <div>
        <h3 class="ns-meta__title">元数据与封面</h3>
        <p class="ns-meta__desc">
          这些字段会写进每个成品的标签里，播放器与手机端显示的曲目名、作者、封面都来自这里。
          支持占位符（与文件命名同一套）：<code>{chapterTitle}</code> <code>{bookTitle}</code> <code>{author}</code>。
        </p>
      </div>
      <div class="ns-meta__head-actions">
        <el-button size="small" :disabled="props.disabled || !props.book" @click="emit('fill-from-book')">
          从书籍信息回填
        </el-button>
      </div>
    </header>

    <div class="ns-meta__switch">
      <el-switch v-model="writeMetadataProxy" :disabled="props.disabled" active-text="写入元数据标签" />
      <span class="ns-meta__switch-hint">{{ tagHint }}</span>
    </div>

    <el-form label-width="112px" label-position="left" :disabled="props.disabled || !writeMetadataProxy">
      <el-form-item v-for="row in fieldRows" :key="row.key" :label="row.label">
        <el-input
          :model-value="fieldValue(row.key)"
          :placeholder="row.placeholder"
          clearable
          @update:model-value="onFieldInputOf(row.key)"
          @blur="onBlur"
        />
      </el-form-item>

      <el-form-item label="封面">
        <div class="ns-meta__cover">
          <img v-if="coverPreview" class="ns-meta__cover-img" :src="coverPreview" alt="封面预览">
          <div v-else class="ns-meta__cover-empty" aria-hidden="true">无预览</div>
          <div class="ns-meta__cover-body">
            <p class="ns-meta__cover-name" :title="props.metadata.coverPath ?? ''">{{ coverName }}</p>
            <p class="ns-meta__cover-hint">
              仅支持 JPEG / PNG。格式不支持时导出会继续，只是不带封面（docs/15 §11）。
              所选绝对路径的图片由主进程读取，向导里只显示路径。
            </p>
            <div class="ns-meta__cover-actions">
              <el-button size="small" @click="emit('pick-cover')">选择封面…</el-button>
              <el-button size="small" :disabled="!props.metadata.coverPath" @click="emit('clear-cover')">移除</el-button>
            </div>
          </div>
        </div>
      </el-form-item>
    </el-form>

    <footer class="ns-meta__foot">
      <AutoSaveIndicator
        :status="saveStatus"
        :saved-at="savedAt"
        :error-text="errorText"
        @retry="retry"
      />
      <span v-if="!writeMetadataProxy" class="ns-meta__off">
        已关闭标签写入：成品只有音频，不含作者/封面信息。
      </span>
    </footer>
  </section>
</template>

<style scoped>
.ns-meta {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 8px;
  background: var(--ns-bg-elevated, #fff);
}
.ns-meta__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ns-meta__title {
  margin: 0 0 4px;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
}
.ns-meta__desc {
  max-width: 720px;
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.7;
}
.ns-meta__desc code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  font-size: 11px;
}
.ns-meta__switch {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ns-meta__switch-hint {
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
}
.ns-meta__cover {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.ns-meta__cover-img {
  width: 96px;
  height: 96px;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 6px;
  object-fit: cover;
}
.ns-meta__cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: 96px;
  border: 1px dashed var(--ns-border, #dcdfe6);
  border-radius: 6px;
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 12px;
}
.ns-meta__cover-body {
  flex: 1;
  min-width: 0;
}
.ns-meta__cover-name {
  margin: 0 0 4px;
  overflow: hidden;
  color: var(--ns-text-regular, #606266);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-meta__cover-hint {
  margin: 0 0 8px;
  color: var(--ns-text-secondary, #909399);
  font-size: 12px;
  line-height: 1.6;
}
.ns-meta__cover-actions {
  display: flex;
  gap: 8px;
}
.ns-meta__foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ns-meta__off {
  color: var(--ns-warning, #e6a23c);
  font-size: 12px;
}
</style>
