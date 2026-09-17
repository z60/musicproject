<!--
  Novel Studio · AI 服务设置（设置页「AI」分类的子面板）
  ============================================================================
  设计依据：
    · docs/04 §8.2 —— ai 分组：provider / baseUrl / model / timeoutMs / maxConcurrency /
      allowSendTextToCloud；敏感项不进分组（见 §9 安全存储）
    · docs/06 §4   —— Provider 抽象：mock / local / openai-compatible / dify 四类，
      云端 Provider 与本地 Provider 的语义差别必须在 UI 上说清
    · docs/04 §8.3 —— 影响面大的项（provider / model）不能静默热改，要给出后果
    · docs/22 §6.2 —— 消息只走 error-bus；§7 的 open_settings 语义：本组件接收
      highlightKeys，把 ?focus=<code> 落到具体设置项上
    · docs/04 §9   —— API Key 只经 setSecret 写入安全存储，**永不回显明文**

  三条纪律（写代码时不要破）：
    1. **密钥永不回显**：输入框 type=password，写入后立刻清空本地输入，只留「已保存」状态；
       想换密钥就直接输入新值覆盖，不存在「读出来看看」这种操作。
    2. **隐私开关显眼**：allowSendTextToCloud 打开后作品正文会离开本机，
       因此单独用醒目区块 + 明确后果文案，而不是混在表单里当一个普通开关。
    3. **失败不自编文案**：测试连接与写入失败的原因一律交给 error-bus（docs/22 §7），
       本组件只显示「成功 / 失败」与主进程返回的 message。
-->

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/app/store/settings.store.ts'
import { call } from '@/shared/lib/ipc.ts'
import { isAppError } from '@shared/errors.ts'
import { formatDate } from '@/shared/lib/format.ts'
import type { SaveStatus } from '@/shared/lib/editable-debounce.ts'
import type { AppSettings } from '@shared/types.ts'
import type { DeepPartial } from '@shared/ipc.ts'

/** 子面板向父级（SettingsView 底部的 AutoSaveIndicator）汇报保存状态 */
interface SaveState {
  status: SaveStatus
  error?: string | null
}

const props = withDefaults(defineProps<{
  /** 需要高亮的设置键（来自 ?focus=，docs/22 §7：「前往设置」要按 code 高亮相关项） */
  highlightKeys?: string[]
}>(), {
  highlightKeys: () => [],
})

const emit = defineEmits<{
  saveState: [state: SaveState]
}>()

const settings = useSettingsStore()

const ai = computed<AppSettings['ai'] | null>(() => settings.settings?.ai ?? null)
const secureStorage = computed(() => settings.capabilities?.secureStorage ?? true)
const isCloudProvider = computed(() =>
  ai.value?.provider === 'openai-compatible' || ai.value?.provider === 'dify')

/** 服务商清单（label 与 hint 是界面文案；失败提示不在这里写，走 messages 表） */
const PROVIDERS: Array<{
  value: AppSettings['ai']['provider']
  label: string
  hint: string
  cloud: boolean
}> = [
  {
    value: 'mock',
    label: '内置模拟（离线）',
    hint: '返回固定的结构化结果，完全不联网：用于界面联调与画本流程自测。',
    cloud: false,
  },
  {
    value: 'local',
    label: '本地模型服务（OpenAI 兼容端点）',
    hint: 'llama.cpp / Ollama 等本机端点；作品正文不出本机，速度取决于本机算力。',
    cloud: false,
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容 API（云端）',
    hint: '任何兼容 /v1/chat/completions 的服务。请求内容包含画本上下文，会离开本机。',
    cloud: true,
  },
  {
    value: 'dify',
    label: 'Dify 工作流（云端）',
    hint: '按工作流编排返回结果；参数在 Dify 侧配置，本地只给输入。',
    cloud: true,
  },
]

const selectedProvider = computed(() => PROVIDERS.find(p => p.value === ai.value?.provider) ?? null)

// ── 密钥 ────────────────────────────────────────────────────────────────────
/** 密钥输入框（只进不出：写入后立即清空，永不回显） */
const apiKeyInput = ref('')
/** unknown = 本次会话未动过，无法确认系统里有没有；saved = 本次已写入；cleared = 本次已清除 */
const secretState = ref<'unknown' | 'saved' | 'cleared'>('unknown')
const secretBusy = ref(false)

// ── 测试连接 ────────────────────────────────────────────────────────────────
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string; latencyMs?: number } | null>(null)
const testedAt = ref<number | null>(null)

function isHl(key: string): boolean {
  return props.highlightKeys.includes(key)
}

/** 保存失败的正文一律取自 messages 表（AppError.resolved.title），没有则交给 error-bus 展示 */
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

/** 写入密钥：只经 store.setSecret（内部 settings:setSecret + 安全存储，docs/04 §9） */
async function saveSecret(): Promise<void> {
  const value = apiKeyInput.value.trim()
  if (!value) return
  secretBusy.value = true
  emit('saveState', { status: 'saving', error: null })
  try {
    const ok = await settings.setSecret('ai.apiKey', value)
    if (ok) {
      apiKeyInput.value = ''
      secretState.value = 'saved'
      emit('saveState', { status: 'saved', error: null })
    } else {
      // store.setSecret 内部走 callSafe：失败不会抛出，只留日志。
      // 因此这里只改本地状态，真正的失败原因请到「日志与诊断」查看（不要自编错误文案）。
      emit('saveState', { status: 'error', error: null })
    }
  } catch (error) {
    emit('saveState', { status: 'error', error: errorText(error) })
  } finally {
    secretBusy.value = false
  }
}

/** 清除已保存的密钥（写入空串，主进程负责删除安全存储条目） */
async function clearSecret(): Promise<void> {
  secretBusy.value = true
  emit('saveState', { status: 'saving', error: null })
  try {
    const ok = await settings.setSecret('ai.apiKey', '')
    secretState.value = ok ? 'cleared' : secretState.value
    apiKeyInput.value = ''
    emit('saveState', { status: ok ? 'saved' : 'error', error: null })
  } catch (error) {
    emit('saveState', { status: 'error', error: errorText(error) })
  } finally {
    secretBusy.value = false
  }
}

/**
 * 测试连接。
 * 注意：这里**不**走 settings store 的 testProvider —— 它内部用 callSafe（失败静默），
 * 而 docs/22 §7 要求失败原因必须经 error-bus 兑现给用户；因此直接用 call()，
 * 让 call() 的默认策略（report）把失败提示交出去，本组件只负责成功结果的展示。
 */
async function testConnection(): Promise<void> {
  const current = ai.value
  if (!current) return
  testing.value = true
  testResult.value = null
  try {
    const result = await call('settings:testProvider', {
      provider: {
        ...current,
        ...(apiKeyInput.value.trim() ? { apiKey: apiKeyInput.value.trim() } : {}),
      },
    })
    testResult.value = result as { ok: boolean; message: string; latencyMs?: number }
    testedAt.value = Date.now()
  } catch {
    testResult.value = null
    testedAt.value = Date.now()
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="ns-provider">
    <!-- 未加载完设置时只占位，不做「假表单」（docs/11 §4.9：不能让用户以为存上了） -->
    <p v-if="!ai" class="ns-provider__empty">正在读取设置…</p>

    <el-form v-else label-width="180px" label-position="left" class="ns-provider__form">
      <el-form-item
        label="AI 服务商"
        :class="{ 'ns-field--hl': isHl('ai.provider') }"
        data-anchor="ai.provider"
      >
        <el-select
          v-model="ai.provider"
          class="ns-provider__control"
          @change="save({ ai: { provider: ai.provider } })"
        >
          <el-option
            v-for="item in PROVIDERS"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        <p v-if="selectedProvider" class="ns-field__hint">
          {{ selectedProvider.hint }}
          <el-tag :type="selectedProvider.cloud ? 'warning' : 'success'" size="small" effect="plain">
            {{ selectedProvider.cloud ? '云端' : '本地' }}
          </el-tag>
        </p>
        <p class="ns-field__hint">
          切换服务商后已生成的内容不受影响，但**下次**画本判定/复核会走新服务商（docs/04 §8.3）。
        </p>
      </el-form-item>

      <el-form-item
        label="服务地址"
        :class="{ 'ns-field--hl': isHl('ai.baseUrl') }"
        data-anchor="ai.baseUrl"
      >
        <el-input
          v-model="ai.baseUrl"
          class="ns-provider__control"
          placeholder="http://127.0.0.1:11434/v1"
          @change="save({ ai: { baseUrl: ai.baseUrl } })"
        />
        <p class="ns-field__hint">
          只接受 http/https 的根地址（不含 /chat/completions）；留空表示用服务商默认地址。
        </p>
      </el-form-item>

      <el-form-item
        label="模型名"
        :class="{ 'ns-field--hl': isHl('ai.model') }"
        data-anchor="ai.model"
      >
        <el-input
          v-model="ai.model"
          class="ns-provider__control"
          placeholder="qwen2.5:7b-instruct / gpt-4o-mini"
          @change="save({ ai: { model: ai.model } })"
        />
        <p class="ns-field__hint">
          必须与服务端已加载的模型名完全一致；换模型后同一段文本的判定结果可能变化。
        </p>
      </el-form-item>

      <el-form-item
        label="请求超时"
        :class="{ 'ns-field--hl': isHl('ai.timeoutMs') }"
        data-anchor="ai.timeoutMs"
      >
        <el-input-number
          v-model="ai.timeoutMs"
          :min="1000"
          :max="600000"
          :step="1000"
          controls-position="right"
          @change="save({ ai: { timeoutMs: ai.timeoutMs } })"
        />
        <span class="ns-field__unit">毫秒（默认 60000；本地小模型可放大到 300000）</span>
      </el-form-item>

      <el-form-item
        label="最大并发"
        :class="{ 'ns-field--hl': isHl('ai.maxConcurrency') }"
        data-anchor="ai.maxConcurrency"
      >
        <el-input-number
          v-model="ai.maxConcurrency"
          :min="1"
          :max="16"
          controls-position="right"
          @change="save({ ai: { maxConcurrency: ai.maxConcurrency } })"
        />
        <span class="ns-field__unit">建议 2~4；云端服务商按套餐限流，调高会更容易触发 429</span>
      </el-form-item>

      <!-- ── 隐私开关：显著区块，不能混在表单里 ─────────────────────────── -->
      <div
        class="ns-privacy"
        :class="{ 'is-on': ai.allowSendTextToCloud, 'ns-field--hl': isHl('ai.allowSendTextToCloud') }"
        data-anchor="ai.allowSendTextToCloud"
      >
        <div class="ns-privacy__row">
          <el-switch
            v-model="ai.allowSendTextToCloud"
            @change="save({ ai: { allowSendTextToCloud: ai.allowSendTextToCloud } })"
          />
          <strong class="ns-privacy__title">
            {{ ai.allowSendTextToCloud ? '已允许把作品正文发送到外部服务' : '禁止把作品正文发送到外部服务（默认）' }}
          </strong>
          <el-tag :type="ai.allowSendTextToCloud ? 'danger' : 'success'" size="small">
            {{ ai.allowSendTextToCloud ? '已放开' : '仅本机' }}
          </el-tag>
        </div>
        <p class="ns-privacy__text">
          开启后：「生成画本」的上下文片段、存疑句子的复核请求会发往上面配置的服务地址，
          内容是**小说正文**。关闭时 Provider 层直接拒绝外发，不发任何网络请求（docs/06 §7）。
        </p>
        <p class="ns-privacy__text">
          <template v-if="isCloudProvider">
            当前服务商是云端 Provider（{{ selectedProvider?.label }}），本开关决定它能不能真的发出去。
          </template>
          <template v-else>
            当前是本地/模拟 Provider，本开关不会产生实际外发；切到云端服务商前请再确认一次这里的状态。
          </template>
        </p>
      </div>

      <!-- ── API Key：永不回显 ─────────────────────────────────────────── -->
      <el-form-item
        label="API Key"
        :class="{ 'ns-field--hl': isHl('ai.apiKey') }"
        data-anchor="ai.apiKey"
      >
        <div class="ns-provider__secret">
          <el-input
            v-model="apiKeyInput"
            type="password"
            show-password
            autocomplete="off"
            placeholder="粘贴密钥后点「保存密钥」；不回显已保存的值"
            class="ns-provider__secret-input"
          />
          <el-button :loading="secretBusy" :disabled="!apiKeyInput.trim()" @click="saveSecret">
            保存密钥
          </el-button>
          <el-button :disabled="secretBusy" @click="clearSecret">清除密钥</el-button>
        </div>

        <p class="ns-field__hint">
          <el-tag v-if="secretState === 'saved'" type="success" size="small" effect="plain">本次已保存</el-tag>
          <el-tag v-else-if="secretState === 'cleared'" type="info" size="small" effect="plain">本次已清除</el-tag>
          <el-tag v-else type="info" size="small" effect="plain">未修改</el-tag>
          密钥保存在系统安全存储中（加密后落库），界面与日志都**不会**出现明文；
          需要更换时直接输入新密钥覆盖即可。
        </p>
        <p v-if="!secureStorage" class="ns-field__hint ns-field__hint--warn">
          当前系统不支持安全存储（app:getCapabilities.secureStorage = false），密钥无法加密保存，
          请改用本地模型服务，或先修好系统凭据服务。
        </p>
      </el-form-item>

      <el-form-item label="连接自检">
        <div class="ns-provider__test">
          <el-button type="primary" plain :loading="testing" @click="testConnection">
            测试连接
          </el-button>
          <span v-if="testedAt" class="ns-field__unit">上次测试：{{ formatDate(testedAt, 'HH:mm:ss') }}</span>

          <template v-if="testResult">
            <el-tag :type="testResult.ok ? 'success' : 'warning'" size="small">
              {{ testResult.ok ? '连接成功' : '连接失败' }}
            </el-tag>
            <span class="ns-field__unit">
              {{ testResult.message }}
              <template v-if="testResult.latencyMs !== undefined">· 往返 {{ testResult.latencyMs }} ms</template>
            </span>
          </template>
        </div>
        <p class="ns-field__hint">
          测试会按当前地址与模型发一次最小请求（不发送作品正文，只发一句固定的自我介绍）；
          失败的具体原因由提示条给出（docs/22 §7），这里不重复一遍文案。
        </p>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.ns-provider__empty {
  margin: 0;
  color: var(--ns-text-secondary, #909399);
  font-size: 13px;
}
.ns-provider__control {
  width: 420px;
  max-width: 100%;
}
.ns-provider__secret {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.ns-provider__secret-input {
  width: 320px;
  max-width: 100%;
}
.ns-provider__test {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
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
.ns-field__hint--warn {
  color: var(--ns-warning, #e6a23c);
}
.ns-field--hl :deep(.el-form-item__label),
.ns-field--hl .ns-privacy__title {
  color: var(--ns-primary, #409eff);
}
.ns-field--hl {
  border-radius: 6px;
  outline: 2px solid rgb(64 158 255 / 45%);
  outline-offset: 2px;
  background: rgb(64 158 255 / 6%);
}
.ns-privacy {
  margin: 4px 0 18px;
  padding: 12px 14px;
  border: 1px solid var(--ns-border, #dcdfe6);
  border-left-width: 4px;
  border-radius: 6px;
  background: var(--ns-bg-subtle, #fafafa);
}
.ns-privacy.is-on {
  border-color: var(--ns-danger, #f56c6c);
  background: rgb(245 108 108 / 7%);
}
.ns-privacy__row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.ns-privacy__title {
  color: var(--ns-text-primary, #303133);
  font-size: 14px;
}
.ns-privacy__text {
  margin: 8px 0 0;
  color: var(--ns-text-regular, #606266);
  font-size: 12px;
  line-height: 1.7;
}
</style>
