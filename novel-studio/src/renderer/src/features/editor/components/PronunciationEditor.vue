<!--
  画本编辑 · 发音提示编辑器（docs/11 §3、§5 多音字表）
  ============================================================================
  为什么必须有这个字段（docs/11 §3）：
    > `pronunciation` —— 多音字必错（重 / 行 / 还 / 长 / shuí-shéi）。
  而 docs/11 §5 明确：**不做自动替换**（会错得更离谱），只提示让人判断。
  因此这里做三件事：
    1. 扫描当前文本命中的多音字（POLYPHONE_HINTS，唯一来源），列出候选读音；
    2. 点一下即插入 `行(háng)` 形式的提示（人工判断，不是自动改文本）；
    3. 给出「提示串 + 文本」的对照预览，让用户确认导出任务包时配音员看到的是什么。

  紧凑形态（表格「提示」列）只显示一个图标；展开形态（抽屉）才是完整编辑器。
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { suggestPronunciations } from '../stores/canvas.store.ts'

const props = withDefaults(defineProps<{
  /** 行文本（用于扫描多音字） */
  text?: string
  /** 当前发音提示串（如 `行(háng) 重(chóng)`） */
  pronunciation?: string | null
  /** 只读 */
  readonly?: boolean
  /** 紧凑形态（表格单元格） */
  compact?: boolean
}>(), {
  text: '',
  pronunciation: null,
  readonly: false,
  compact: true,
})

const emit = defineEmits<{
  /** 发音提示变化；null = 清除 */
  change: [pronunciation: string | null]
  /** 请求打开抽屉继续编辑 */
  open: []
}>()

/** 逗号 / 空格分隔都接受（用户从别处粘贴过来时格式很杂） */
function splitTokens(value: string | null): string[] {
  if (!value) return []
  return value
    .split(/[\s,，;；、|]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

const tokens = ref<string[]>(splitTokens(props.pronunciation))
const draft = ref<string>(props.pronunciation ?? '')

/** 外部值变化（切换行）时同步本地编辑态 */
function syncFromProps(): void {
  tokens.value = splitTokens(props.pronunciation)
  draft.value = props.pronunciation ?? ''
}

// 切换行（或撤销/重做改了这个字段）时，把编辑框同步成库里的值
watch(() => props.pronunciation, () => syncFromProps())

/** 命中的多音字（含建议写法），最多 8 条 */
const suggestions = computed(() => suggestPronunciations(props.text, 8))

function commit(next: string | null): void {
  if (props.readonly) return
  draft.value = next ?? ''
  tokens.value = splitTokens(next)
  emit('change', next && next.trim() ? next.trim() : null)
}

/** 点候选读音：把 `行(háng)` 追加进提示串（同字已有提示则替换） */
function applySuggestion(char: string, reading: string): void {
  const nextToken = `${char}(${reading})`
  const rest = tokens.value.filter(token => !token.startsWith(`${char}(`))
  commit([...rest, nextToken].join(' '))
}

function removeToken(token: string): void {
  commit(tokens.value.filter(item => item !== token).join(' ') || null)
}

/** 手动输入提交（回车或失焦） */
function commitDraft(): void {
  commit(draft.value)
}

/** 发音提示输入框（el-input）：载荷为 string，只改本地草稿，回车/失焦才提交 */
function onDraftInput(value: string): void {
  draft.value = value
}

/** 预览：把提示串以行内注音形式叠在文本上（仅展示，不改 data） */
const preview = computed(() => {
  const map = new Map<string, string>()
  for (const token of tokens.value) {
    const match = /^(.)\((.*)\)$/.exec(token)
    if (match && match[1] && match[2]) map.set(match[1], match[2])
  }
  if (!map.size) return props.text
  return [...(props.text ?? '')].map(ch => (map.has(ch) ? `${ch}(${map.get(ch)})` : ch)).join('')
})

/** 未处理的多音字（有命中但没给提示） */
const uncovered = computed(() =>
  suggestions.value.filter(item => !tokens.value.some(token => token.startsWith(`${item.char}(`))))

function onOpen(): void {
  emit('open')
}
</script>

<template>
  <div class="ns-pron" :class="{ 'ns-pron--compact': compact, 'is-readonly': readonly }">
    <template v-if="compact">
      <el-popover
        trigger="click"
        placement="bottom-start"
        :width="320"
        @show="onOpen"
      >
        <template #reference>
          <span
            class="ns-pron__icon"
            :class="{ 'is-set': !!pronunciation, 'is-missing': !pronunciation && suggestions.length > 0 }"
            :title="pronunciation ? `发音提示：${pronunciation}` : (suggestions.length ? `命中多音字 ${suggestions.length} 个，建议给发音提示` : '无多音字风险')"
          >
            {{ pronunciation ? '音' : (suggestions.length ? '音!' : '音') }}
          </span>
        </template>

        <div class="ns-pron__panel">
          <p class="ns-pron__title">多音字提示</p>

          <div v-if="suggestions.length" class="ns-pron__suggest-list">
            <div v-for="item in suggestions" :key="item.char" class="ns-pron__suggest">
              <span class="ns-pron__char">{{ item.char }}</span>
              <span class="ns-pron__hint">{{ item.hint }}</span>
              <span class="ns-pron__readings">
                <button
                  v-for="reading in item.readings"
                  :key="reading"
                  type="button"
                  class="ns-pron__reading"
                  @click="applySuggestion(item.char, reading)"
                >
                  {{ reading }}
                </button>
              </span>
            </div>
          </div>
          <p v-else class="ns-pron__empty">这段文本没有命中内置多音字表。</p>

          <p v-if="pronunciation" class="ns-pron__current">当前提示：{{ pronunciation }}</p>
          <el-button v-if="pronunciation" size="small" text @click="commit(null)">清除提示</el-button>
        </div>
      </el-popover>
    </template>

    <template v-else>
      <div class="ns-pron__editor">
        <el-input
          :model-value="draft"
          :disabled="readonly"
          size="small"
          placeholder="如：行(háng) 重(chóng)"
          clearable
          @update:model-value="onDraftInput"
          @change="commitDraft"
          @blur="commitDraft"
        />
        <el-button size="small" :disabled="readonly" @click="commit(draft)">应用</el-button>
        <el-button v-if="pronunciation" size="small" text :disabled="readonly" @click="commit(null)">清除</el-button>
      </div>

      <div v-if="tokens.length" class="ns-pron__tokens">
        <el-tag
          v-for="token in tokens"
          :key="token"
          size="small"
          closable
          :disable-transitions="true"
          @close="removeToken(token)"
        >
          {{ token }}
        </el-tag>
      </div>

      <div class="ns-pron__suggest-block">
        <p class="ns-pron__title">
          命中多音字 {{ suggestions.length }} 个
          <span v-if="uncovered.length" class="ns-pron__warn">（其中 {{ uncovered.length }} 个还没给提示）</span>
        </p>
        <div v-if="suggestions.length" class="ns-pron__suggest-list">
          <div v-for="item in suggestions" :key="item.char" class="ns-pron__suggest">
            <span class="ns-pron__char">{{ item.char }}</span>
            <span class="ns-pron__hint">{{ item.hint }}</span>
            <span class="ns-pron__readings">
              <button
                v-for="reading in item.readings"
                :key="reading"
                type="button"
                class="ns-pron__reading"
                :disabled="readonly"
                @click="applySuggestion(item.char, reading)"
              >
                {{ reading }}
              </button>
            </span>
          </div>
        </div>
        <p v-else class="ns-pron__empty">这段文本没有命中内置多音字表。</p>
        <p class="ns-pron__note">
          提示只是给配音员看的标注，「不会」改动要录的文本（docs/11 §5：自动替换会错得更离谱）。
        </p>
      </div>

      <div class="ns-pron__preview">
        <span class="ns-pron__preview-label">预览</span>
        <span class="ns-pron__preview-text">{{ preview }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ns-pron {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.ns-pron--compact .ns-pron__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-placeholder, #c0c4cc);
  font-size: 11px;
  cursor: pointer;
}
.ns-pron--compact .ns-pron__icon.is-set {
  background: rgb(103 194 58 / 15%);
  color: var(--ns-success, #67c23a);
}
.ns-pron--compact .ns-pron__icon.is-missing {
  background: rgb(230 162 60 / 18%);
  color: var(--ns-warning, #e6a23c);
}
.ns-pron__panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ns-pron__title {
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 12px;
  font-weight: 600;
}
.ns-pron__warn {
  color: var(--ns-warning, #e6a23c);
  font-weight: 400;
}
.ns-pron__suggest-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow: auto;
}
.ns-pron__suggest {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.ns-pron__char {
  min-width: 18px;
  text-align: center;
  font-weight: 600;
}
.ns-pron__hint {
  flex: 1;
  overflow: hidden;
  color: var(--ns-text-secondary, #909399);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-pron__readings {
  display: inline-flex;
  gap: 4px;
}
.ns-pron__reading {
  padding: 1px 6px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 3px;
  background: #fff;
  font-size: 11px;
  cursor: pointer;
}
.ns-pron__reading:hover:not(:disabled) {
  border-color: var(--ns-primary, #409eff);
  color: var(--ns-primary, #409eff);
}
.ns-pron__empty,
.ns-pron__note,
.ns-pron__current {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
  line-height: 1.6;
}
.ns-pron__editor {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ns-pron__tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.ns-pron__suggest-block {
  margin-top: 8px;
}
.ns-pron__preview {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  font-size: 12px;
  line-height: 1.7;
}
.ns-pron__preview-label {
  flex: 0 0 auto;
  color: var(--ns-text-secondary, #909399);
}
.ns-pron__preview-text {
  word-break: break-word;
}
</style>
