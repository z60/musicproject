<!--
  书籍导入域 · 编码确认面板（docs/10 §4 编码嗅探 / §7.1 Step 2）
  ============================================================================
  设计依据：
    · docs/10 §4.1 —— 判定顺序（BOM → UTF-8 严格校验 → GB18030 试探 → Big5 → UTF-16），
      置信度 < 0.7 视为不确定，**必须让用户选**（needsUserChoice）
    · docs/10 §4.2 —— 中文场景必须把 GBK 升级为 GB18030（子集关系，用 GB18030 更安全），
      这一步必须在界面上解释清楚，否则用户会以为「我选了 GBK 却没生效」
    · docs/10 §7.1 —— Step 2 是「失败时在此等待用户处理」的一步：解析失败时停在这里，
      本组件要给出明确下一步（换编码重解析 / 手动指定编码）
    · docs/22 §6.2 —— 错误文案与提示统一走 error-bus（父视图负责），本组件只做说明；
      「编码不确定」对应的消息码是 ENCODING_UNCERTAIN，由 error-bus 兑现，界面这里只标注状态

  契约缺口（显式降级，不假装）：
    `book:previewSplit` 没有 encoding 入参，用户在选择框里改的编码不会改变主进程的解码结果。
    因此当「用户所选 ≠ 实际解析所用」时，界面必须明说「主进程仍按嗅探结果解码」。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { ENCODING_UPGRADE } from '@shared/constants.ts'
import type { EncodingDetection } from '@shared/types.ts'
import { formatPercent, formatScore, formatInt } from '@/shared/lib/format.ts'
import ConfidenceBadge from '@/shared/ui/ConfidenceBadge.vue'
import EmptyState from '@/shared/ui/EmptyState.vue'
import { fallbackEncodingCandidates } from '@/features/book/stores/import.store.ts'

const props = withDefaults(defineProps<{
  /** book:detectEncoding / book:probeFile 的嗅探结果（null = 还没探测过） */
  detection?: EncodingDetection | null
  /** 当前选中的编码（用户选择优先） */
  selectedEncoding?: string
  /** 主进程实际解析时使用的编码（来自 book:previewSplit 的 encoding） */
  parsedEncoding?: string
  /** store.needsUserEncodingChoice：needsUserChoice 或置信度 < 0.7 */
  needsUserChoice?: boolean
  /** store.encodingDiffersFromParsed：用户选择与解析结果不一致 */
  differsFromParsed?: boolean
  /** 检测中 / 解析中 */
  busy?: boolean
  /** 解析出来的章数（让人一眼看出编码是否正确：乱码时通常切不出章） */
  draftCount?: number
  /** 解析错误（store.previewError），文案由 store/error-bus 给出，本组件只展示 */
  previewErrorText?: string | null
  /**
   * 二进制容器格式（DOCX / PDF）：正文由解析库以 Unicode 提取，
   * **没有「文件编码」可选**，因此不显示候选编码表与「编码不确定」警告。
   */
  containerFormat?: boolean
}>(), {
  detection: null,
  selectedEncoding: '',
  parsedEncoding: '',
  needsUserChoice: false,
  differsFromParsed: false,
  busy: false,
  draftCount: 0,
  previewErrorText: null,
  containerFormat: false,
})

const emit = defineEmits<{
  /** 用户选定一种编码（父视图 → useImportFlow.onEncodingSelected） */
  select: [encoding: string]
  /** 重新嗅探（book:detectEncoding） */
  redetect: []
  /** 按当前设置重新解析（book:previewSplit） */
  reparse: []
}>()

/** 候选表格：主进程给出候选就用它，否则用 constants 的 ENCODING_CANDIDATES 兜底 */
const candidates = computed(() => {
  const fromProbe = props.detection?.candidates ?? []
  return fromProbe.length ? fromProbe : fallbackEncodingCandidates()
})

const detected = computed(() => props.detection?.encoding ?? '')
const confidence = computed(() => props.detection?.confidence ?? null)

/** GBK/GB2312 → GB18030 的升级提示（docs/10 §4.2） */
const upgradeHint = computed(() => {
  const encoding = detected.value
  const target = encoding ? ENCODING_UPGRADE[encoding] : undefined
  if (!target || target === encoding) return ''
  return `嗅探结果是 ${encoding}，已按 docs/10 §4.2 升级为 ${target} 解码：${encoding} 是 ${target} 的子集，用 ${target} 才能正确还原生僻字。`
})

/** BOM 长度 > 0 表示是 BOM 强判定，置信度天然可信 */
const bomText = computed(() => {
  const length = props.detection?.bomLength ?? 0
  return length > 0 ? `检测到 BOM（${length} 字节），判定为强证据` : '未检测到 BOM'
})

const previewOf = (preview: string): string => (preview ? preview.replace(/\s+/g, ' ').slice(0, 120) : '—')
</script>

<template>
  <section class="enc">
    <!-- 未探测：给出明确动线，而不是空白表格 -->
    <EmptyState
      v-if="!detection"
      title="还没有编码信息"
      description="文件来源需要先嗅探编码（BOM → UTF-8 严格校验 → GB18030 → Big5 → UTF-16）。"
      icon="🔤"
      size="small"
      action-text="开始检测编码"
      :hint="busy ? '正在检测…' : '粘贴文本来源没有字节可嗅探，会直接使用 UTF-8'"
      @action="emit('redetect')"
    />

    <template v-else>
      <header class="enc__head">
        <div class="enc__headline">
          <h3 class="enc__title">
            当前编码
            <code class="enc__code">{{ detected || '未知' }}</code>
          </h3>
          <p class="enc__sub">
            置信度
            <ConfidenceBadge :confidence="confidence" compact />
            <span class="enc__sub-text">{{ confidence === null ? '—' : formatPercent(confidence, 0) }} · {{ bomText }}</span>
          </p>
        </div>
        <div class="enc__head-actions">
          <button type="button" class="ns-btn" :disabled="busy" @click="emit('redetect')">重新检测</button>
          <button type="button" class="ns-btn ns-btn--primary" :disabled="busy" @click="emit('reparse')">
            {{ busy ? '处理中…' : '按当前设置重新解析' }}
          </button>
        </div>
      </header>

      <!-- 二进制容器：没有编码可选，说清楚而不是丢一张乱码候选表 -->
      <p v-if="containerFormat" class="enc__note">
        该格式（DOCX / PDF）是二进制容器，正文由解析库以 Unicode 提取并落库为 UTF-8，
        <strong>不需要</strong>选择文本编码。直接「下一步」即可。
      </p>

      <!-- 不确定：必须人工选择（docs/10 §4.1 第 6 条） -->
      <p v-if="needsUserChoice && !containerFormat" class="enc__warn">
        置信度偏低，无法可靠判定编码。请在下方候选表格里挑一份「读起来是正常中文」的预览，
        选中后点「按当前设置重新解析」确认结果。
      </p>

      <p v-if="upgradeHint" class="enc__note">{{ upgradeHint }}</p>

      <!-- 契约缺口：选择不等于生效，必须说清 -->
      <p v-if="differsFromParsed" class="enc__note enc__note--warn">
        你选择的编码是 <strong>{{ selectedEncoding }}</strong>，但主进程本次解析使用的是
        <strong>{{ parsedEncoding }}</strong>。<code>book:previewSplit</code> 没有 encoding 入参，
        因此「选择」只用于人工确认与后续任务通道导入，本次预览仍按嗅探结果解码。
      </p>

      <div v-if="previewErrorText" class="enc__error" role="alert">
        <span>本次解析未成功：{{ previewErrorText }}</span>
        <button type="button" class="ns-btn ns-btn--small" :disabled="busy" @click="emit('reparse')">重试解析</button>
      </div>

      <table v-if="!containerFormat" class="enc__table">
        <thead>
          <tr>
            <th class="enc__col-pick">选择</th>
            <th class="enc__col-name">编码</th>
            <th class="enc__col-score">评分</th>
            <th>解码预览（前 120 字）</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="candidate in candidates"
            :key="candidate.encoding"
            class="enc__row"
            :class="{ 'enc__row--active': candidate.encoding === selectedEncoding || candidate.encoding === parsedEncoding }"
          >
            <td>
              <input
                type="radio"
                name="ns-encoding"
                :value="candidate.encoding"
                :checked="candidate.encoding === selectedEncoding"
                :disabled="busy"
                @change="emit('select', candidate.encoding)"
              >
            </td>
            <td>
              <span class="enc__cand-name">{{ candidate.encoding }}</span>
              <span v-if="candidate.encoding === detected" class="enc__tag">嗅探结果</span>
              <span v-if="candidate.encoding === parsedEncoding" class="enc__tag enc__tag--parsed">本次解析所用</span>
            </td>
            <td class="enc__score">{{ formatScore(candidate.score) }}</td>
            <td class="enc__preview">{{ previewOf(candidate.preview) }}</td>
          </tr>
        </tbody>
      </table>

      <footer class="enc__foot">
        <span>切出章节：{{ formatInt(draftCount) }} 章</span>
        <span v-if="draftCount === 0" class="enc__foot-warn">切不出章节通常说明编码不对（乱码会破坏标题行的匹配）</span>
        <span v-else class="enc__foot-ok">章数正常说明编码基本正确</span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.enc {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.enc__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.enc__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ns-text-primary, #303133);
  font-size: 15px;
  font-weight: 600;
}
.enc__code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-primary, #409eff);
  font-size: 13px;
}
.enc__sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.enc__sub-text {
  color: var(--ns-text-secondary, #909399);
}
.enc__head-actions {
  display: flex;
  gap: 8px;
}
.enc__warn {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ns-warning, #e6a23c);
  border-radius: 4px;
  background: rgb(230 162 60 / 10%);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  line-height: 1.6;
}
.enc__note {
  margin: 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.6;
}
.enc__note--warn {
  padding: 8px 12px;
  border-left: 3px solid var(--ns-primary, #409eff);
  border-radius: 4px;
  background: var(--ns-fill-light, #f5f7fa);
}
.enc__error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--ns-danger, #f56c6c);
  border-radius: 6px;
  background: rgb(245 108 108 / 8%);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
}
.enc__table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--ns-border-light, #e4e7ed);
  border-radius: 6px;
  font-size: 13px;
}
.enc__table th,
.enc__table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--ns-border-light, #e4e7ed);
  text-align: left;
  vertical-align: top;
}
.enc__table th {
  background: var(--ns-fill-light, #f5f7fa);
  color: var(--ns-text-regular, #606266);
  font-weight: 500;
}
.enc__col-pick {
  width: 52px;
}
.enc__col-name {
  width: 190px;
}
.enc__col-score {
  width: 64px;
}
.enc__row--active {
  background: rgb(64 158 255 / 8%);
}
.enc__cand-name {
  color: var(--ns-text-primary, #303133);
  font-family: ui-monospace, monospace;
}
.enc__tag {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--ns-fill, #ebeef5);
  color: var(--ns-text-secondary, #909399);
  font-size: 11px;
}
.enc__tag--parsed {
  background: rgb(103 194 58 / 18%);
  color: var(--ns-success, #67c23a);
}
.enc__score {
  color: var(--ns-text-regular, #606266);
  font-variant-numeric: tabular-nums;
}
.enc__preview {
  color: var(--ns-text-regular, #606266);
  line-height: 1.6;
  word-break: break-all;
}
.enc__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
}
.enc__foot-warn {
  color: var(--ns-danger, #f56c6c);
}
.enc__foot-ok {
  color: var(--ns-success, #67c23a);
}
.ns-btn {
  padding: 6px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-radius: 4px;
  background: var(--ns-bg-elevated, #fff);
  color: var(--ns-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
}
.ns-btn--small {
  padding: 4px 10px;
  font-size: 12px;
}
.ns-btn--primary {
  border-color: var(--ns-primary, #409eff);
  background: var(--ns-primary, #409eff);
  color: #fff;
}
.ns-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
