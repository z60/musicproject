<!--
  Novel Studio · 「按说话人导入音频」向导
  ============================================================================
  设计依据：docs/12 录音域、docs/91 §5.2.49

  ## 为什么是四步向导，而不是一个「导入」按钮

  配音员的交付方式是「一个人一个文件、覆盖若干章」，文件名形如
  `2221-2240-石志坚-月光.mp3`。导入要做的事是把这个文件对应到一批画本行。

  真实样本里有三种**必须让人看一眼**的情况（自动处理一定出错）：
    ① CV 名与画本对不上（`春哥拿大顶` 被写成 `春哥那个哥`）
    ② 区间里有章节不在画本内（文件名 2127-2300，画本只有 2201-2300）
    ③ 同一行被多个文件覆盖（会产生多条 take 抢同一行）

  所以前三步只读、第四步才写库，且必须显式确认。

  ## 一个容易做错的地方：修正后必须重新预览

  人工把「多角色」指定成某个角色后，**命中行数会变**（变少）。
  如果在界面上直接改那个数字，用户看到的就会和实际导入不一致 ——
  正是本功能最要避免的「预览与导入漂移」。
  所以「应用修正并重新预览」是一个显式动作，行数永远由主进程重算。
-->
<template>
  <div class="import-wizard">
    <el-steps :active="activeStep" simple class="import-wizard__steps">
      <el-step title="选择" description="画本与音频文件夹" />
      <el-step title="扫描" description="解析文件名与章节" />
      <el-step title="预览" description="确认匹配结果" />
      <el-step title="完成" description="写入 takes" />
    </el-steps>

    <el-alert
      v-if="store.lastError"
      type="error"
      show-icon
      :closable="false"
      class="import-wizard__error"
      title="上一步没有成功"
    >
      <template #default>
        <pre class="import-wizard__error-body">{{ describeError(store.lastError) }}</pre>
      </template>
    </el-alert>

    <!-- ── ① 选择 ─────────────────────────────────────────────────────────── -->
    <section v-if="store.step === 'select' || store.step === 'scan'" class="import-wizard__panel">
      <el-form label-width="130px" label-position="left">
        <el-form-item label="音频文件夹">
          <el-input :model-value="store.audioDir ?? ''" readonly placeholder="选择配音员交付的文件夹">
            <template #append>
              <el-button :disabled="store.busy" @click="store.pickAudioDir()">浏览…</el-button>
            </template>
          </el-input>
          <div class="import-wizard__hint">
            命名形式（都认）：<code>起始章-结束章-角色-CV</code>、只写 CV 的 <code>起始章-结束章-CV</code>、
            单章的 <code>章节-角色-CV</code>；章节区间的分隔符 <code>-</code> 与 <code>~</code> 都行。
            <strong>不符合命名的文件会列在下面</strong>（不会导入，也不影响其它文件）。
          </div>
        </el-form-item>

        <el-form-item label="画本文件（可不选）">
          <el-input :model-value="store.canvasPath ?? ''" readonly placeholder="留空 = 用数据库里已导入的画本">
            <template #append>
              <el-button :disabled="store.busy" @click="store.pickCanvas()">浏览…</el-button>
            </template>
          </el-input>
          <div class="import-wizard__hint">
            <strong>不选即可</strong>：直接用数据库里已导入的画本（章节 / 角色 / CV）。
            只有想临时换一份画本文件时才需要浏览选择。
          </div>
        </el-form-item>

        <el-form-item label="包含子目录">
          <el-switch v-model="store.recursive" :disabled="store.busy" />
        </el-form-item>
      </el-form>

      <div class="import-wizard__actions">
        <el-button
          type="primary"
          :disabled="!store.canScan"
          :loading="store.busy"
          @click="runScan"
        >
          {{ store.busy ? store.busyLabel : '扫描' }}
        </el-button>
        <span v-if="!store.canScan" class="import-wizard__hint">先选好画本与音频文件夹</span>
      </div>

      <!-- 扫描结果摘要 -->
      <div v-if="store.canvasScan" class="import-wizard__scan-summary">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="画本章节">
            {{ store.canvasScan.chapters.length }} 章
            <span v-if="store.canvasScan.documentChapterRange">
              （{{ store.canvasScan.documentChapterRange.from }}–{{ store.canvasScan.documentChapterRange.to }}）
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="画本角色">{{ store.canvasScan.characters.length }}</el-descriptions-item>
          <el-descriptions-item label="画本 CV">{{ store.canvasScan.canvasCvs.length }}</el-descriptions-item>
          <el-descriptions-item label="候选音频">
            {{ store.candidates.length }} 个文件
            <span v-if="unparsedCandidates.length" class="import-wizard__hint">
              （{{ unparsedCandidates.length }} 个命名不合规）
            </span>
          </el-descriptions-item>
        </el-descriptions>

        <!--
          命名不合规的文件必须**列出来**：真机反馈「目录里 24 个文件、扫描只扫出 6 个」——
          以前它们被静默丢掉，用户只看到一个变小的数字（连少了几个都不知道）。
        -->
        <el-alert
          v-if="unparsedCandidates.length"
          type="warning"
          show-icon
          :closable="false"
          class="import-wizard__warn"
          :title="`有 ${unparsedCandidates.length} 个文件不符合命名约定（不会导入）`"
        >
          <ul class="import-wizard__warn-list">
            <li v-for="c in unparsedCandidates.slice(0, 8)" :key="c.filePath">
              {{ c.fileName }} — {{ c.parseError?.detail }}
            </li>
          </ul>
          <p v-if="unparsedCandidates.length > 8" class="import-wizard__hint">
            …还有 {{ unparsedCandidates.length - 8 }} 个（完整清单见日志 audioImport.filesScanned）
          </p>
        </el-alert>

        <el-alert
          v-if="store.canvasScan.warnings.length > 0"
          type="warning"
          show-icon
          :closable="false"
          class="import-wizard__warn"
          :title="`画本里有 ${store.canvasScan.warnings.length} 处结构不规范（已尽量解析）`"
        >
          <ul class="import-wizard__warn-list">
            <li v-for="(w, i) in store.canvasScan.warnings.slice(0, 5)" :key="i">
              第 {{ w.sourceLine + 1 }} 行：{{ w.detail }}
              <span v-if="w.sample" class="import-wizard__sample">— {{ w.sample }}</span>
            </li>
          </ul>
        </el-alert>

        <el-alert
          v-if="store.canvasScan.chapters.length === 0"
          type="error"
          show-icon
          :closable="false"
          title="画本与数据库对不上"
          description="画本里的章节在数据库里一个都没找到。请先在「书籍导入」里把这本书导进来，再回来按说话人导入音频。"
        />
      </div>

      <div v-if="store.canvasScan && store.candidates.length > 0" class="import-wizard__actions">
        <el-button type="primary" :loading="store.busy" @click="runPlan">
          {{ store.busy ? store.busyLabel : '生成预览' }}
        </el-button>
      </div>
    </section>

    <!-- ── ② 预览 ─────────────────────────────────────────────────────────── -->
    <section v-if="store.step === 'preview'" class="import-wizard__panel">
      <div v-if="store.summary" class="import-wizard__summary">
        <el-tag type="success" effect="plain">就绪 {{ store.summary.readyFiles }}</el-tag>
        <el-tag v-if="store.summary.needsReviewFiles" type="warning" effect="plain">
          需确认 {{ store.summary.needsReviewFiles }}
        </el-tag>
        <el-tag v-if="store.summary.unresolvedFiles" type="danger" effect="plain">
          无法判定 {{ store.summary.unresolvedFiles }}
        </el-tag>
        <el-tag v-if="store.summary.noLinesFiles" type="info" effect="plain">
          无对应行 {{ store.summary.noLinesFiles }}
        </el-tag>
        <el-tag v-if="store.summary.invalidFiles" type="info" effect="plain">
          命名不合规 {{ store.summary.invalidFiles }}
        </el-tag>
        <el-tag v-if="store.summary.overlappingFiles" type="warning" effect="plain">
          有重叠 {{ store.summary.overlappingFiles }}
        </el-tag>
        <span class="import-wizard__spacer" />
        <strong>计划导入 {{ store.summary.totalLines }} 行</strong>
      </div>

      <el-alert
        v-for="(w, i) in store.plan?.warnings ?? []"
        :key="i"
        type="warning"
        show-icon
        :closable="false"
        class="import-wizard__warn"
        :title="w"
      />

      <p v-if="store.summary?.overlappingFiles" class="import-wizard__hint">
        「有重叠」= 有 {{ store.summary.overlappingFiles }} 个文件的音频覆盖了**同一批画本行**（共
        {{ store.summary.duplicatedLineCount }} 行）。导入后这些行会各有**多条 take**，需要你挑选成品。
        处理方式：<strong>取消勾选其中一个文件</strong>；或用该行「处理」列的「指定说话人」把多角色文件
        缩小到某个角色（命中行数会随之变少）；两个文件确实都需要时，也可以都导入，再在行的 take 列表里选成品。
      </p>

      <el-table :data="store.files" size="small" border max-height="420" class="import-wizard__table">
        <el-table-column width="52">
          <template #header>导入</template>
          <template #default="{ row }">
            <el-checkbox
              :model-value="store.selectedFiles[row.fileName] === true"
              :disabled="!isImportable(row)"
              @update:model-value="(v) => toggleFile(row, v)"
            />
          </template>
        </el-table-column>

        <el-table-column prop="fileName" label="文件" min-width="230" show-overflow-tooltip />

        <el-table-column label="状态" width="122">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small" effect="plain">{{ statusLabel(row.status) }}</el-tag>
            <!-- 重叠：明确「与别的文件争了多少行」，否则用户只看到一个标签无从下手 -->
            <div v-if="row.overlappingLineCount > 0" class="import-wizard__hint">
              与其它文件重复 {{ row.overlappingLineCount }} 行
            </div>
          </template>
        </el-table-column>

        <el-table-column label="区间" width="118">
          <template #default="{ row }">
            <span v-if="row.range">{{ row.range.from }}–{{ row.range.to }}</span>
            <span v-else class="import-wizard__muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="命中" width="72" align="right">
          <template #default="{ row }">
            <strong>{{ row.lineCount }}</strong>
            <span class="import-wizard__muted"> 行</span>
          </template>
        </el-table-column>

        <el-table-column label="说话人判定" min-width="240">
          <template #default="{ row }">
            <div class="import-wizard__target">{{ row.targetExplanation ?? '—' }}</div>
            <div v-if="row.cvMatchedName" class="import-wizard__hint">
              画本 CV：{{ row.cvMatchedName }}
              <span v-if="row.cvMatchMethod !== 'exact'">
                （{{ matchMethodLabel(row.cvMatchMethod) }}，置信度 {{ row.cvConfidence }}）
              </span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="处理" width="140">
          <template #default="{ row }">
            <el-button
              v-if="needsFix(row)"
              size="small"
              type="primary"
              link
              @click="openFix(row)"
            >
              {{ needsRange(row) ? '指定区间与说话人' : '指定说话人' }}
            </el-button>
            <span v-else class="import-wizard__muted">—</span>
          </template>
        </el-table-column>

        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="import-wizard__detail">
              <div v-if="row.chaptersMissingInCanvas.length > 0" class="import-wizard__detail-line">
                <el-icon><WarningFilled /></el-icon>
                有 {{ row.chaptersMissingInCanvas.length }} 章不在画本范围内
                （{{ row.chaptersMissingInCanvas[0] }}–{{
                  row.chaptersMissingInCanvas[row.chaptersMissingInCanvas.length - 1]
                }}），这些章不会导入
              </div>
              <div v-if="row.notes.length > 0">
                <div v-for="(n, i) in row.notes" :key="i" class="import-wizard__detail-line">· {{ n }}</div>
              </div>
              <div v-if="row.samples.length > 0" class="import-wizard__detail-line">
                样例：
                <div v-for="(s, i) in row.samples" :key="i" class="import-wizard__sample">
                  第{{ s.chapterNo }}章 [{{ s.character }}] {{ s.text }}
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!--
        导入是**后台任务**：提交后立刻显示统一的任务进度卡（docs/04 §2.4 禁止自建进度 UI），
        用户可以关掉这个向导去干别的，任务中心仍在跑；完成后结果自动落到「完成」这一步。
      -->
      <TaskProgressCard
        v-if="store.applyTaskId"
        :task-id="store.applyTaskId"
        kind="audioImport.apply"
        title="导入配音音频"
        cancelable
        @cancel="cancelImport"
        @open="openTaskCenter"
      />

      <div class="import-wizard__actions">
        <el-button :disabled="store.busy || !!store.applyTaskId" @click="store.step = 'scan'">返回</el-button>
        <el-button :disabled="store.busy || !!store.applyTaskId" @click="runPlan">重新预览</el-button>
        <el-button
          type="primary"
          :disabled="!store.canImport || store.busy || !!store.applyTaskId"
          :loading="store.busy"
          @click="runApply"
        >
          {{ store.busy ? store.busyLabel : `导入选中的 ${selectedImportableCount} 个文件` }}
        </el-button>
      </div>
      <p v-if="store.applyTaskId" class="import-wizard__hint">
        已提交为后台任务：现在可以关掉这个窗口，进度与结果都在「任务中心」。
        导入会逐行切句（解码 → 逐帧能量 → VAD），比原来慢，但音与文本对得更准。
      </p>
    </section>

    <!-- ── ③ 完成 ─────────────────────────────────────────────────────────── -->
    <section v-if="store.step === 'done' && store.result" class="import-wizard__panel">
      <el-result
        :icon="store.result.createdTakes > 0 ? 'success' : 'warning'"
        :title="store.result.createdTakes > 0 ? '导入完成' : '没有写入任何 take'"
        :sub-title="resultSubtitle"
      >
        <template #extra>
          <div class="import-wizard__result">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="处理文件">{{ store.result.files }}</el-descriptions-item>
              <el-descriptions-item label="写入 take">{{ store.result.createdTakes }}</el-descriptions-item>
              <el-descriptions-item label="设为成品">{{ store.result.createdSegments }}</el-descriptions-item>
              <el-descriptions-item label="标记已录">{{ store.result.markedRecorded }} 行</el-descriptions-item>
            </el-descriptions>

            <div v-if="store.result.perFile.length > 0" class="import-wizard__result-files">
              <div class="import-wizard__result-title">逐文件结果</div>
              <el-table :data="store.result.perFile" size="small" border max-height="240">
                <el-table-column prop="fileName" label="文件" min-width="200" show-overflow-tooltip />
                <el-table-column prop="lineCount" label="匹配行" width="76" align="right" />
                <el-table-column prop="createdTakes" label="写入" width="68" align="right" />
                <el-table-column label="切句" width="120">
                  <template #default="{ row }">
                    <el-tooltip :content="splitHint(asFileResult(row))" placement="top" :disabled="!splitHint(asFileResult(row))">
                      <el-tag :type="splitTagType(asFileResult(row))" size="small" effect="plain">
                        {{ splitLabel(asFileResult(row)) }}
                      </el-tag>
                    </el-tooltip>
                  </template>
                </el-table-column>
                <el-table-column label="说明" min-width="150">
                  <template #default="{ row }">
                    <el-tooltip
                      v-if="row.error"
                      :content="reasonHint(row.error)"
                      placement="top"
                      :disabled="!reasonHint(row.error)"
                    >
                      <span class="import-wizard__muted">{{ reasonText(row.error) }}</span>
                    </el-tooltip>
                    <span v-else class="import-wizard__muted">—</span>
                  </template>
                </el-table-column>
              </el-table>

              <!--
                「切句质量」必须有一句人话解释。

                `createdTakes` 相同的两次导入，听感可能完全不同：
                「整段」意味着每一行听到的都是**同一整段音频**。
                只报数字的话，用户会以为都成功了。
              -->
              <el-alert
                v-if="splitNotice"
                class="import-wizard__split-notice"
                :type="splitNotice.type"
                :title="splitNotice.title"
                :description="splitNotice.description"
                show-icon
                :closable="false"
              />
            </div>
          </div>
          <!--
            「继续导入」保留音频文件夹（真机需求：「导入一批可以继续导入」）——
            同一批交付通常是同一个文件夹里的多个文件，重新挑一次目录纯属折腾。
            想彻底换目录时用旁边的「重新选择」。
          -->
          <el-button type="primary" @click="store.resetForAnotherBatch()">继续导入</el-button>
          <el-button @click="store.reset()">重新选择文件夹</el-button>
        </template>
      </el-result>
    </section>

    <!-- ── 指定说话人对话框 ───────────────────────────────────────────────── -->
    <el-dialog v-model="fixDialogVisible" :title="fixing && needsRange(fixing) ? '指定章节区间与说话人' : '指定说话人'" width="520px">
      <div v-if="fixing" class="import-wizard__fix">
        <div class="import-wizard__fix-file">{{ fixing.fileName }}</div>
        <div class="import-wizard__hint">
          <template v-if="needsRange(fixing)">
            <strong>这个文件名解析不出章节区间</strong>（例如命名不合规）。
            请补上它覆盖的章节范围，再指定角色或 CV —— 没有区间就不知道要导入哪些行。
          </template>
          <template v-else>
            自动判定失败是因为文件名里的 CV 与画本对不上。从画本的角色里选一个，或直接指定 CV。
          </template>
        </div>

        <el-form label-width="88px" label-position="left">
          <!--
            章节区间只在「文件名解析不出区间」时出现：真机需求「解析不出的可以自己选择
            哪个 CV 或者角色」—— 光选人还不够，必须能补区间。默认填画本范围。
          -->
          <el-form-item v-if="needsRange(fixing)" label="章节区间">
            <div class="import-wizard__range">
              <el-input-number v-model="fixFrom" :min="1" :max="999999" :controls="false" size="small" />
              <span class="import-wizard__muted">到</span>
              <el-input-number v-model="fixTo" :min="1" :max="999999" :controls="false" size="small" />
            </div>
          </el-form-item>
          <el-form-item label="按角色">
            <el-select
              v-model="fixCharacter"
              clearable
              filterable
              placeholder="选择角色"
              class="import-wizard__fix-select"
            >
              <el-option
                v-for="c in store.canvasScan?.characters ?? []"
                :key="c.id"
                :label="c.name"
                :value="c.name"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="按 CV">
            <el-select v-model="fixCv" clearable filterable placeholder="选择 CV" class="import-wizard__fix-select">
              <el-option v-for="cv in store.canvasScan?.canvasCvs ?? []" :key="cv" :label="cv" :value="cv" />
            </el-select>
          </el-form-item>

          <el-form-item label="按旁白">
            <el-switch v-model="fixNarration" />
            <span class="import-wizard__hint"> 这一段全部是旁白（按区间内的旁白行导入）</span>
          </el-form-item>
        </el-form>

        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="修改后需要重新预览"
          description="指定说话人会改变命中的行数。点「应用并重新预览」由主进程重算，避免界面数字与实际导入不一致。"
        />
      </div>

      <template #footer>
        <el-button @click="fixDialogVisible = false">取消</el-button>
        <el-button :disabled="store.busy" @click="clearFix">清除修正</el-button>
        <el-button type="primary" :loading="store.busy" @click="applyFix">应用并重新预览</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { WarningFilled } from '@element-plus/icons-vue'

import type { AudioImportApplyResult, AudioImportFilePlan } from '@shared/types.ts'
import { MESSAGES, getMessage } from '@shared/messages.ts'
import { call } from '@/shared/lib/ipc.ts'
import { useTaskProgress } from '@/shared/lib/task-progress.ts'
import TaskProgressCard from '@/shared/ui/TaskProgressCard.vue'
import { useAudioImportStore } from '../stores/audio-import.store.ts'

const props = defineProps<{
  projectId: string
  bookId: string
}>()

const store = useAudioImportStore()
const router = useRouter()

const activeStep = computed(() => {
  switch (store.step) {
    case 'select':
      return 0
    case 'scan':
      return 1
    case 'preview':
      return 2
    default:
      return 3
  }
})

/** 命名不合规的候选：扫描**保留**它们只为了在这里列出来（「少的是哪几个」必须能看见） */
const unparsedCandidates = computed(() => store.candidates.filter((c) => c.parseError))

const selectedImportableCount = computed(
  () => store.files.filter((f) => isImportable(f) && store.selectedFiles[f.fileName] === true).length,
)

const resultSubtitle = computed(() => {
  const r = store.result
  if (!r) return ''
  if (r.createdTakes === 0) {
    return r.skipped.length > 0 ? `全部 ${r.skipped.length} 个文件都被跳过，原因见下表` : '没有匹配到任何行'
  }
  const parts = [`写入 ${r.createdTakes} 条 take，标记 ${r.markedRecorded} 行为已录`]
  if (r.skipped.length > 0) parts.push(`${r.skipped.length} 个文件被跳过`)
  return parts.join('；')
})

// ── 状态展示 ───────────────────────────────────────────────────────────────
/**
 * 把「跳过原因」翻成用户看得懂的话。
 *
 * `applyImport` 把单文件失败的原因记成 `AppError.key`（语义键）。真机最容易撞上的
 * 就是 `AUDIO_IMPORT_SOURCE_NOT_WAV`（用户的 5 个样本全是 mp3）——
 * 直接把键贴到界面上就是一行大写英文，等于没提示。
 * 不是语义键的（「文件名无法解析：…」这类本来就是中文说明）原样显示。
 */
function reasonText(reason: unknown): string {
  if (typeof reason !== 'string' || reason.length === 0) return '—'
  if (Object.prototype.hasOwnProperty.call(MESSAGES, reason)) return getMessage(reason).title
  return reason
}

function reasonHint(reason: unknown): string {
  if (typeof reason !== 'string' || reason.length === 0) return ''
  if (!Object.prototype.hasOwnProperty.call(MESSAGES, reason)) return reason
  /**
   * 只取 `hint`（可行动的那句）。
   *
   * 这里拿不到主进程 `details` 里的参数，`detail` 的「{fileName}」会被插值成「-」，
   * 而文件名就在旁边那一列，再显示一遍「「-」实际是「-」」只会让人困惑。
   */
  const m = getMessage(reason)
  return m.hint ?? m.detail ?? ''
}

// ── 切句质量 ───────────────────────────────────────────────────────────────

type FileResult = AudioImportApplyResult['perFile'][number]

/** 表格里那一列短标签 */
function splitLabel(row: FileResult): string {
  switch (row.splitMethod) {
    case 'vad':
      return `按语音 ${row.sliceCount} 段`
    case 'whole-timeline':
      return '按比例切'
    case 'empty':
      return '空音频'
    default:
      return '整段'
  }
}

function splitTagType(row: FileResult): 'success' | 'warning' | 'danger' | 'info' {
  switch (row.splitMethod) {
    case 'vad':
      // 一片一行最理想；片数明显多于行数说明可能有漏检/连读
      return row.needsReview === 0 ? 'success' : 'warning'
    case 'whole-timeline':
      return 'warning'
    case 'empty':
      return 'danger'
    default:
      return 'info'
  }
}

function splitHint(row: FileResult): string {
  switch (row.splitMethod) {
    case 'asr':
      // 音频转文字 → 文本强制对齐：每行区间来自**识别到的那句话**的位置，最准
      return `按识别文本对齐（${row.sliceCount} 段识别文本 → ${row.lineCount} 行）`
    case 'vad':
      return `检测到 ${row.sliceCount} 段语音，按语音边界切给 ${row.lineCount} 行`
    case 'whole-timeline':
      return '没检测到明显的停顿，按每行文本长度按比例切分 —— 边界不一定落在句子之间'
    case 'empty':
      return '解出来是空的（0 个采样），没有导入任何内容'
    default:
      return '没有解码能力（或解码失败），每一行都指向整段音频'
  }
}

/**
 * 顶部那条提示。
 *
 * 只在**不是一个理想结果**时出现 —— 全都精确切分还弹一条提示，
 * 用户会学会无视它（与错误提示同样的道理）。
 */
const splitNotice = computed(() => {
  const r = store.result
  if (!r) return null
  const files = r.perFile.filter((f) => f.createdTakes > 0 || f.splitMethod === 'empty')
  if (files.length === 0) return null

  const whole = files.filter((f) => f.splitMethod === 'whole-timeline')
  const none = files.filter((f) => f.splitMethod === 'none')
  const emptyCount = files.filter((f) => f.splitMethod === 'empty').length

  if (emptyCount > 0) {
    return {
      type: 'error' as const,
      title: `有 ${emptyCount} 个文件解出来是空的`,
      description: '这些文件没有导入任何内容。请确认文件本身能正常播放，或重新导出后再试。',
    }
  }
  if (none.length > 0) {
    return {
      type: 'error' as const,
      title: `有 ${none.length} 个文件没能切成每行一段`,
      description:
        '它们的每一行都指向**整段音频** —— 试听时会听到同一整段。' +
        '常见原因是这段音频解不开，请查看日志里的 audioImport.decodeFailed。',
    }
  }
  /**
   * 走了「按停顿估计」（VAD）而不是「按识别文本对齐」（ASR）时提示一句：
   * 真机反馈「2201 章还是有问题」，根因就是这一档 —— 识别引擎没装时只能靠停顿猜。
   */
  const vadOnly = files.filter((f) => f.splitMethod === 'vad').length
  const asrCount = files.filter((f) => f.splitMethod === 'asr').length
  if (asrCount === 0 && vadOnly > 0 && whole.length === 0) {
    return {
      type: 'info' as const,
      title: `这批音频是按停顿估计切分的（${vadOnly} 个文件）`,
      description:
        '连续朗读时停顿可能落在句子中间，边界只能估计。' +
        '要用「音频转文字 → 按识别文本对齐」需要 whisper 引擎与模型：' +
        '把 whisper-cli 放进 resources/bin、ggml 模型放进 resources/models/whisper/，' +
        '或在设置里填 asr.binaryPath / asr.modelPath —— 装好后重新导入即可，速度会明显变慢但边界准确得多。',
    }
  }
  if (whole.length > 0) {
    return {
      type: 'warning' as const,
      title: `有 ${whole.length} 个文件是按比例切分的`,
      description:
        '这些音频里没有检测到明显的停顿，边界是**按每行文本长度按比例**算出来的，' +
        '不一定落在句子之间。导入后建议先试听这几行再继续。',
    }
  }
  const review = files.reduce((s, f) => s + f.needsReview, 0)
  if (review > 0) {
    return {
      type: 'warning' as const,
      title: `有 ${review} 行的切句边界把握不大`,
      description:
        '这些行的音频已导入并设为成品，但建议试听确认后再继续录制其它内容。' +
        '其中少数行的区间可能**整段落在静音上**（说明这段音频里的语音没能被检测到，' +
        '通常是因为连着念、没有停顿）—— 那几行需要重新切或手工指定区间。',
    }
  }
  return null
})

function statusLabel(status: AudioImportFilePlan['status']): string {
  switch (status) {
    case 'ready':
      return '就绪'
    case 'needs-review':
      return '需确认'
    case 'unresolved-speaker':
      return '无法判定'
    case 'no-lines':
      return '无对应行'
    case 'invalid-name':
      return '命名不合规'
    case 'duplicate-lines':
      return '有重叠'
    default:
      return status
  }
}

function statusType(status: AudioImportFilePlan['status']): 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'ready':
      return 'success'
    case 'needs-review':
    case 'duplicate-lines':
      return 'warning'
    case 'unresolved-speaker':
      return 'danger'
    default:
      return 'info'
  }
}

function matchMethodLabel(method: string): string {
  switch (method) {
    case 'prefix':
      return '缩写补全'
    case 'contains':
      return '包含匹配'
    case 'exact':
      return '精确匹配'
    default:
      return '未匹配'
  }
}

/**
 * `el-table` 的插槽把 `row` 标注为宽松类型（`DefaultRow`），
 * 而模板表达式是按 JS 解析的、拿不到泛型推断。
 * 所以助手函数收宽松入参，内部收窄成契约类型 —— 这比在模板里到处断言干净。
 */
function asPlan(row: unknown): AudioImportFilePlan {
  return row as AudioImportFilePlan
}

/** 同上，用于「逐文件结果」那张表（`row` 同样是 `DefaultRow`） */
function asFileResult(row: unknown): FileResult {
  return row as FileResult
}

/** 只有这几种状态的文件可以被导入 */
function isImportable(row: unknown): boolean {
  const s = asPlan(row).status
  return s === 'ready' || s === 'needs-review' || s === 'duplicate-lines'
}

/**
 * 需要人工处理的：自动判定没能给出可信结果，**或者文件名根本解析不出区间**。
 *
 * `invalid-name` 也必须有入口（真机需求：「以后解析不出的可以在处理里自己选择哪个 CV 或者角色」）——
 * 以前这种行只能干看着，连个地方都没有。
 */
function needsFix(row: unknown): boolean {
  const s = asPlan(row).status
  return s === 'needs-review' || s === 'unresolved-speaker' || s === 'invalid-name'
}

/** 文件名解析不出区间 → 对话框里必须让用户补区间（没有区间就选不出行） */
function needsRange(row: unknown): boolean {
  return asPlan(row).range === null
}

function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { title?: string; detail?: string; hint?: string; code?: string }
    return [o.code, o.title, o.detail, o.hint].filter(Boolean).join(' / ')
  }
  return String(e)
}

// ── 动作 ───────────────────────────────────────────────────────────────────
async function runScan(): Promise<void> {
  await store.scan({ projectId: props.projectId, bookId: props.bookId })
}

async function runPlan(): Promise<void> {
  await store.refreshPlan({ projectId: props.projectId, bookId: props.bookId })
}

/**
 * 导入任务的订阅：`finished` 一到位就把结果/失败交给 store（不再轮询）。
 *
 * 为什么订阅而不是 `await`：任务在**主进程**跑，向导关掉也照样跑完；
 * 组件卸载时 `useTaskProgress` 会自动解绑，任务本身不受影响。
 */
const applyProgress = useTaskProgress(computed(() => store.applyTaskId))
/**
 * `immediate: true` 是必须的：**组件可能在任务已经结束之后才挂载**
 * （用户关掉向导、任务在后台跑完、再打开向导）。非 immediate 的 watch 不会
 * 对「已经 finished 的状态」触发，于是 `applyTaskId` 永远留着 ——
 * 表现就是「导入一批之后按钮一直灰着，无法继续导入」（真机反馈）。
 */
watch(
  () => applyProgress.state.value,
  (state) => {
    if (!state?.finished) return
    if (!store.applyTaskId) return
    store.acceptTaskResult({ status: state.status, result: state.result })
  },
  { immediate: true },
)

function cancelImport(taskId: string): void {
  void call('task:cancel', { taskId })
}

function openTaskCenter(taskId: string): void {
  // 与其它域一致：跳任务中心并带上 taskId（那边按 id 高亮）
  void router.push({ path: '/tasks', query: { taskId } })
}

async function runApply(): Promise<void> {
  await store.apply({ projectId: props.projectId, bookId: props.bookId })
}

function toggleFile(row: unknown, v: string | number | boolean | undefined): void {
  const f = asPlan(row)
  store.selectedFiles = { ...store.selectedFiles, [f.fileName]: v === true }
}

// ── 指定说话人对话框 ───────────────────────────────────────────────────────
const fixDialogVisible = ref(false)
const fixing = ref<AudioImportFilePlan | null>(null)
const fixCharacter = ref<string | null>(null)
const fixCv = ref<string | null>(null)
const fixNarration = ref(false)
/** 手工章节区间（只在文件名解析不出区间时用得上） */
const fixFrom = ref<number | null>(null)
const fixTo = ref<number | null>(null)

function openFix(row: unknown): void {
  const f = asPlan(row)
  fixing.value = f
  const ov = store.overrideOf(f.filePath)
  fixCharacter.value = ov?.character ?? null
  fixCv.value = ov?.cv ?? null
  fixNarration.value = ov?.narration === true
  // 区间：人工填过的优先；否则用文件名里的；再否则**默认填画本的章节范围**
  // （用户多数情况下要的就是「整个画本」，手填两端最省事）。
  const canvasRange = store.summary?.canvasChapterRange ?? null
  fixFrom.value = ov?.fromChapter ?? f.range?.from ?? canvasRange?.from ?? null
  fixTo.value = ov?.toChapter ?? f.range?.to ?? canvasRange?.to ?? null
  fixDialogVisible.value = true
}

function clearFix(): void {
  if (fixing.value) store.setOverride(fixing.value.filePath, null)
  fixCharacter.value = null
  fixCv.value = null
  fixNarration.value = false
  const canvasRange = store.summary?.canvasChapterRange ?? null
  fixFrom.value = fixing.value?.range?.from ?? canvasRange?.from ?? null
  fixTo.value = fixing.value?.range?.to ?? canvasRange?.to ?? null
}

async function applyFix(): Promise<void> {
  if (!fixing.value) return
  store.setOverride(fixing.value.filePath, {
    character: fixCharacter.value,
    cv: fixCv.value,
    narration: fixNarration.value,
    // 只有「文件名给不出区间」时才需要人工区间（其余情况以文件名里的为准）
    ...(needsRange(fixing.value) ? { fromChapter: fixFrom.value, toChapter: fixTo.value } : {}),
  })
  fixDialogVisible.value = false
  // 必须重新预览（见文件头说明）
  await runPlan()
}
</script>

<style scoped>
.import-wizard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.import-wizard__steps {
  margin-bottom: 4px;
}

.import-wizard__panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.import-wizard__hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.import-wizard__muted {
  color: var(--el-text-color-placeholder);
}

.import-wizard__split-notice {
  margin-top: 10px;
}

.import-wizard__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.import-wizard__scan-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.import-wizard__warn-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.import-wizard__summary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.import-wizard__spacer {
  flex: 1;
}

.import-wizard__table {
  width: 100%;
}

.import-wizard__target {
  font-size: 13px;
}

.import-wizard__detail {
  padding: 8px 12px;
  color: var(--el-text-color-regular);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.import-wizard__detail-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.import-wizard__sample {
  color: var(--el-text-color-secondary);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-wizard__error-body {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}

.import-wizard__result {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 14px;
  text-align: left;
}

.import-wizard__result-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.import-wizard__fix {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.import-wizard__fix-file {
  font-weight: 600;
  word-break: break-all;
}

.import-wizard__fix-select {
  width: 100%;
}

.import-wizard__range {
  display: flex;
  align-items: center;
  gap: 8px;
}

.import-wizard__error {
  margin-bottom: 4px;
}
</style>
