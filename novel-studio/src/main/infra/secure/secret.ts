/**
 * 基础设施 · 安全存储（safeStorage 适配）
 * ============================================================================
 * 设计依据：docs/04 §9「安全存储」
 *
 * ```ts
 * export function encryptSecret(plain: string): string {
 *   if (!safeStorage.isEncryptionAvailable()) throw new AppError('SECURE_UNAVAILABLE')
 *   return safeStorage.encryptString(plain).toString('base64')
 * }
 * export function decryptSecret(cipher: string): string {
 *   return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
 * }
 * ```
 *
 * | 情况 | 行为 |
 * |------|------|
 * | 系统不支持加密（部分 Linux） | 拒绝保存 Key，提示「当前系统不支持安全存储，请使用本地模型或 Mock Provider」 |
 * | 换机器/换了系统用户 | 解密失败 → **清除并提示重新输入**（不要崩溃） |
 * | Key 泄露风险 | 日志脱敏 + 诊断包不含 Key（见 04 §5.2） |
 *
 * 与 `infra/log` 的关系：**密钥明文永不进日志**。这里额外做了一层：
 * 任何错误详情里都不带 cipher/plain 内容，只带长度与来源标记。
 */

import { AppError } from '../../../shared/errors.ts'
import { loadElectron, type SafeStorageLike } from '../electron/index.ts'

export type { SafeStorageLike }

/** 密文前缀：用于区分「safeStorage 密文」与「历史明文」（迁移期识别用） */
export const SECRET_PREFIX = 'v1:'

/**
 * 解析可用的 safeStorage。
 * 拿不到（没有 electron / 平台不支持）时返回 null，由调用方决定是拒绝还是降级。
 */
export async function resolveSafeStorage(): Promise<SafeStorageLike | null> {
  try {
    const electron = await loadElectron()
    const safeStorage = electron.safeStorage
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return null
    return safeStorage
  } catch {
    // electron 不可用（纯 Node 测试环境）→ 视为「平台不支持安全存储」
    return null
  }
}

export interface SecretOptions {
  /** 解密失败时清除存储的钩子（docs/04 §9「清除并提示重新输入」） */
  onDecryptFailed?: (info: { reason: string }) => void
  /** 是否给密文加 `v1:` 前缀（默认 true，便于将来换算法时区分） */
  withPrefix?: boolean
}

/**
 * 加密密钥（返回 base64 字符串，可直接入库 `settings.value`，`is_secret = 1`）。
 *
 * @throws AppError('APP_SECURE_STORAGE_UNAVAILABLE') 平台不支持 / electron 不可用
 */
export function encryptSecret(plain: string, safeStorage: SafeStorageLike | null, opts?: SecretOptions): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new AppError('INVALID_PAYLOAD', { details: { field: 'secret', reason: 'empty' } })
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    // 见 docs/04 §9：系统不支持加密时**拒绝保存**，而不是退化成明文
    throw new AppError('APP_SECURE_STORAGE_UNAVAILABLE', {
      details: {
        reason: safeStorage ? 'isEncryptionAvailable=false' : 'safeStorage-missing',
        hint: '可改用本地模型或 Mock Provider，或在不保存密钥的情况下临时填写',
      },
    })
  }
  let buf: Buffer
  try {
    buf = safeStorage.encryptString(plain)
  } catch (e) {
    throw new AppError('APP_SECURE_STORAGE_UNAVAILABLE', {
      cause: e,
      details: { reason: 'encrypt-failed', plainLength: plain.length },
    })
  }
  const base64 = Buffer.from(buf).toString('base64')
  return (opts?.withPrefix ?? true) ? `${SECRET_PREFIX}${base64}` : base64
}

/**
 * 解密密钥。
 *
 * · 系统不支持 → `APP_SECURE_STORAGE_UNAVAILABLE`
 * · 换机器/换用户导致解密失败 → **调用 `onDecryptFailed` 清除存储**，再抛
 *   `APP_SECRET_DECRYPT_FAILED`（docs/04 §9：提示重新输入，不要崩溃）
 */
export function decryptSecret(cipher: string, safeStorage: SafeStorageLike | null, opts?: SecretOptions): string {
  if (typeof cipher !== 'string' || cipher.length === 0) {
    throw new AppError('APP_SECRET_DECRYPT_FAILED', { details: { reason: 'empty-cipher' } })
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    throw new AppError('APP_SECURE_STORAGE_UNAVAILABLE', {
      details: { reason: safeStorage ? 'isEncryptionAvailable=false' : 'safeStorage-missing' },
    })
  }

  const hadPrefix = cipher.startsWith(SECRET_PREFIX)
  const base64 = hadPrefix ? cipher.slice(SECRET_PREFIX.length) : cipher
  const buf = Buffer.from(base64, 'base64')
  if (buf.length === 0) {
    failDecrypt(opts, 'invalid-base64', cipher.length)
  }
  try {
    const plain = safeStorage.decryptString(buf)
    if (typeof plain !== 'string' || plain.length === 0) {
      failDecrypt(opts, 'empty-plaintext', cipher.length)
    }
    return plain
  } catch (e) {
    failDecrypt(opts, 'decrypt-threw', cipher.length, e)
  }
  // 不可达（failDecrypt 一定抛错），仅为类型完整
  throw new AppError('APP_SECRET_DECRYPT_FAILED', { details: { reason: 'unreachable' } })
}

function failDecrypt(opts: SecretOptions | undefined, reason: string, cipherLength: number, cause?: unknown): never {
  try {
    opts?.onDecryptFailed?.({ reason })
  } catch {
    // 清除动作本身失败不能掩盖原始错误（错误处理路径永不抛错）
  }
  throw new AppError('APP_SECRET_DECRYPT_FAILED', {
    cause,
    details: { reason, cipherLength, cleared: Boolean(opts?.onDecryptFailed) },
  })
}

/** 是否看起来是加密值（用于「已配置密钥」的 UI 判断；不看内容，只看形态） */
export function looksEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.length > 8 && (value.startsWith(SECRET_PREFIX) || /^[A-Za-z0-9+/=]+$/.test(value))
}

/** 给 UI 的掩码（docs/04 §5.2：API Key 永不回显，只显示是否已配置） */
export function maskSecret(configured: boolean): string {
  return configured ? '••••••••' : ''
}

/**
 * 端到端助手：自动解析 safeStorage（惰性、失败即降级为 null）。
 * 生产代码建议显式注入 safeStorage（启动时解析一次），避免每个调用点都走动态导入。
 */
export async function encryptSecretAuto(plain: string, opts?: SecretOptions): Promise<string> {
  return encryptSecret(plain, await resolveSafeStorage(), opts)
}

export async function decryptSecretAuto(cipher: string, opts?: SecretOptions): Promise<string> {
  return decryptSecret(cipher, await resolveSafeStorage(), opts)
}
