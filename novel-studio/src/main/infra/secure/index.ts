/**
 * 基础设施 · 安全存储出口
 * ============================================================================
 * 见 docs/04 §9。
 */

export {
  SECRET_PREFIX,
  decryptSecret,
  decryptSecretAuto,
  encryptSecret,
  encryptSecretAuto,
  looksEncrypted,
  maskSecret,
  resolveSafeStorage,
  type SafeStorageLike,
  type SecretOptions,
} from './secret.ts'
