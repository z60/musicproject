/**
 * 基础设施 · 文件系统出口
 * ============================================================================
 * 见 docs/04 §3。**唯一的路径拼接入口**：其它模块不要自己 join 项目路径。
 */

export {
  assertInsideRoot,
  cleanFileName,
  dedupeFileName,
  DEFAULT_MAX_FILENAME_BYTES,
  expandTemplate,
  formatDate,
  isAbsoluteLike,
  isProtectedPath,
  isSafeId,
  isUserAssetPath,
  normalizeRelPath,
  projectDir,
  resolveProjectPath,
  resolveResourcePath,
  resourceRoot,
  sanitizeFileName,
  TEMPLATE_VARS,
  toRelativePath,
  truncateUtf8,
  USER_ASSET_DIRS,
  type ExpandTemplateOptions,
  type ResourceRootOptions,
  type TemplateVar,
  type TemplateVars,
} from './paths.ts'

export {
  atomicWriteFile,
  nodeFsPort,
  safeRemove,
  sha256Hex,
  tempFileNameFor,
  withTempDir,
  type AtomicWriteOptions,
  type FileHandlePort,
  type FsPort,
  type SafeRemoveOptions,
} from './atomic.ts'

export {
  cacheKey,
  fileFingerprint,
  paramsHash,
  sha256Buffer,
  sha256File,
  stableStringify,
} from './hash.ts'

export {
  assertFreeSpace,
  bytesPerSecondOf,
  checkFreeSpace,
  ensureDir,
  estimateRecordingBytes,
  WAV_HEADER_BYTES,
  type DiskFormat,
  type FreeSpaceResult,
} from './disk.ts'
