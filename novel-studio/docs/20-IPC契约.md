# 20 · IPC 契约

> 上游：`01-系统架构.md`（§5）、各功能域文档
> 配套：`21-数据字典与SQL.md`（存储类型）、`src/shared/ipc-contract.ts`（代码单一来源）

---

## 1. 契约原则

1. **单一来源**：所有通道名与载荷类型定义在 `src/shared/ipc-contract.ts`，主进程与渲染进程都从这里引用。禁止字符串散落各处。
2. **运行时校验**：每个 handler 入口用 Zod schema 校验载荷（防篡改、防类型漂移、给出清晰错误）。
3. **传输类型与领域类型分离**：IPC 传 DTO（扁平、可序列化），不传带方法的类实例。

> **注意**：`03-数据模型与存储.md` 里的 `CanvasLine` 等是**领域类型**（`src/shared/types.ts`，字段用 camelCase）。
> `21-数据字典与SQL.md` 里的表结构是**存储类型**（snake_case，SQLite 用 0/1 表示布尔，JSON 字段存字符串）。
> 两者的映射集中在 repository 的 `mappers.ts`。**本文的 DTO 一律用 camelCase，布尔用真布尔**。

4. **不传大对象**：列表分页；波形传降采样峰值数组；音频一律传路径（`ns-media://` 或相对路径），不传二进制。
5. **错误统一形状**（§5）。
6. **高频流走 MessagePort**（录音样本），控制指令走 `invoke`。

---

## 2. 三种模式

| 模式 | API | 用途 | 示例 |
|------|-----|------|------|
| 请求-响应 | `invoke` | 查询与命令 | `book:list`、`canvas:updateLine` |
| 单向高频 | `send`（渲染 → 主） | 可丢弃的高频数据 | `record:meter` |
| 事件流 | 主 → 渲染（`webContents.send`） | 进度、状态、日志 | `task:progress`、`record:status` |
| 零拷贝流 | `MessagePortMain` | 音频样本 | `record:attachPort` |

---

## 3. 通道命名规范

```
<域>:<动作>[.<子动作>]
```
- 域：`app` `book` `chapter` `canvas` `character` `voiceActor` `record` `device` `take` `alignment` `process` `preset` `music` `mix` `export` `package` `settings` `task` `log` `db` `ns-media`
- 动作：小驼峰动词（`list` `get` `create` `update` `delete` `batchUpdate` `generate` `validate` `render`）
- 事件：主 → 渲染用 `<域>:<名词>` + `:changed`/`:progress`/`:status`

---

## 4. 完整通道清单

### 4.1 应用与系统（`app`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `app:getInfo` | invoke | — | `{ version, electron, node, chrome, platform, arch, isPackaged, portable }` |
| `app:getPaths` | invoke | — | `{ userData, projectRoot, exportDir, cacheDir, logDir, modelDir, resourceDir }` |
| `app:openExternal` | invoke | `{ url }` | `{ ok }`（仅允许 http/https） |
| `app:showItemInFolder` | invoke | `{ path }` | `{ ok }` |
| `app:openFolderDialog` | invoke | `{ title?, defaultPath? }` | `{ path | null }` |
| `app:openFileDialog` | invoke | `{ title?, filters?[], multi? }` | `{ paths: string[] }` |
| `app:saveFileDialog` | invoke | `{ title?, defaultPath?, filters?[] }` | `{ path | null }` |
| `app:getCapabilities` | invoke | — | `{ ffmpeg: {...}, models: {...}, secureStorage: boolean, embedding: {...} }` |
| `app:quit` | invoke | `{ force?: boolean }` | `{ ok }` |
| `app:diagnostics` | invoke | — | `{ reportPath }`（导出诊断包） |

### 4.2 书籍与章节（`book` / `chapter`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `book:list` | invoke | `{ projectId? }` | `BookSummary[]` |
| `book:get` | invoke | `{ bookId }` | `BookDetail` |
| `book:update` | invoke | `{ bookId, patch }` | `BookDetail` |
| `book:delete` | invoke | `{ bookId, deleteAudio?: boolean }` | `{ ok }` |
| `book:importFile` | invoke | `{ filePath, options } ` | `{ taskId }` |
| `book:importText` | invoke | `{ text, title, options }` | `{ taskId }` |
| `book:importUrl` | invoke | `{ url, options }` | `{ taskId }` |
| `book:detectEncoding` | invoke | `{ filePath, sampleBytes? }` | `EncodingDetection` |
| `book:probeFile` | invoke | `{ filePath }` | `{ kind: 'txt'\|'pdf'\|'docx'\|'unknown', sizeBytes, hasTextLayer? }` |
| `book:previewSplit` | invoke | `{ text \| filePath, ruleSet, cleanOptions }` | `{ chapters: ChapterDraft[], cleanReport }` |
| `book:commitImport` | invoke | `{ drafts: ChapterDraft[], bookMeta, source }` | `{ bookId, chapterCount }` |
| `book:findDuplicate` | invoke | `{ contentHash }` | `{ exists, bookId? }` |
| `chapter:list` | invoke | `{ bookId, withStats?: boolean }` | `ChapterSummary[]` |
| `chapter:get` | invoke | `{ chapterId }` | `ChapterDetail` |
| `chapter:update` | invoke | `{ chapterId, patch }` | `ChapterDetail` |
| `chapter:reorder` | invoke | `{ bookId, orderedIds: string[] }` | `{ ok }` |
| `chapter:merge` | invoke | `{ chapterIds: string[], title }` | `ChapterDetail` |
| `chapter:split` | invoke | `{ chapterId, atOffsets: number[] }` | `ChapterSummary[]` |
| `chapter:delete` | invoke | `{ chapterId }` | `{ ok }` |
| `chapter:stats` | invoke | `{ chapterId }` | `{ charCount, lineCount, estimatedDurationMs, recordedMs, progress }` |
| `chapter:ruleSets` | invoke | — | `ChapterRuleSet[]` |
| `chapter:saveRuleSet` | invoke | `{ ruleSet }` | `ChapterRuleSet` |
| `chapter:deleteRuleSet` | invoke | `{ id }` | `{ ok }` |

### 4.3 画本（`canvas`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `canvas:generate` | invoke | `{ chapterId, options: { useEmbedding, useLlm, contextWindow, threshold, ruleSetId, overwriteHuman } }` | `{ taskId }` |
| `canvas:getChapter` | invoke | `{ chapterId, offset?, limit?, filter? }` | `{ lines: CanvasLineDto[], total, report? }` |
| `canvas:getLine` | invoke | `{ lineId }` | `CanvasLineDto` |
| `canvas:updateLine` | invoke | `{ lineId, patch, rev? }` | `CanvasLineDto` |
| `canvas:batchUpdate` | invoke | `{ lineIds: string[], patch, filter? }` | `{ updated: number }` |
| `canvas:recomputeAttribution` | invoke | `{ chapterId, scope: 'low_confidence'\|'all'\|'selection', lineIds? }` | `{ taskId }` |
| `canvas:qualityCheck` | invoke | `{ chapterId }` | `QualityIssue[]` |
| `canvas:snapshotCreate` | invoke | `{ chapterId, label? }` | `{ snapshotId }` |
| `canvas:snapshotList` | invoke | `{ chapterId }` | `CanvasSnapshot[]` |
| `canvas:snapshotRestore` | invoke | `{ snapshotId }` | `{ ok }` |
| `canvas:getGenerateReport` | invoke | `{ chapterId }` | `CanvasGenerateReport \| null` |
| `canvas:exportText` | invoke | `{ chapterId, format: 'txt'\|'csv'\|'json' }` | `{ path }` |
| `canvas:importLines` | invoke | `{ chapterId, lines: NewLineDto[] }` | `{ inserted }` |

### 4.4 角色与配音员（`character` / `voiceActor`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `character:list` | invoke | `{ bookId, includeArchived? }` | `CharacterDto[]` |
| `character:upsert` | invoke | `{ character }` | `CharacterDto` |
| `character:merge` | invoke | `{ targetId, sourceIds: string[], keepAliases: boolean }` | `{ movedLines, mergedAliases }` |
| `character:archive` | invoke | `{ characterId, archived }` | `{ ok }` |
| `character:extract` | invoke | `{ bookId, chapterIds? }` | `CharacterCandidate[]` |
| `character:stats` | invoke | `{ characterId }` | `{ lines, chars, estimatedDurationMs, recordedMs }` |
| `character:rebuildCentroid` | invoke | `{ bookId, characterIds? }` | `{ taskId }` |
| `voiceActor:list` | invoke | `{ projectId }` | `VoiceActorDto[]` |
| `voiceActor:upsert` | invoke | `{ actor }` | `VoiceActorDto` |
| `voiceActor:delete` | invoke | `{ actorId }` | `{ ok }` |
| `voiceActor:bind` | invoke | `{ characterId, actorId, isPrimary }` | `{ ok }` |
| `voiceActor:workload` | invoke | `{ bookId }` | `Array<{ actorId, name, lines, chars, estimatedDurationMs, progress }>` |

### 4.5 录音（`record` / `device` / `take`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `record:prepare` | invoke | `{ projectId, chapterId, mode, format: { sampleRate, bitDepth, channels }, deviceId? }` | `{ sessionId, warnings: string[] }` |
| `record:attachPort` | invoke | `{ sessionId }` | `{ port }`（MessagePort 转入 preload 后交给渲染） |
| `record:start` | invoke | `{ sessionId }` | `{ ok }` |
| `record:pause` | invoke | `{ sessionId }` | `{ ok }` |
| `record:resume` | invoke | `{ sessionId }` | `{ ok }` |
| `record:stop` | invoke | `{ sessionId, lineId?, trim?: { enabled, thresholdDb, paddingMs } }` | `{ session, take?, segment? }` |
| `record:abort` | invoke | `{ sessionId, keepFile?: boolean }` | `{ ok }` |
| `record:punchIn` | invoke | `{ lineId, srcInMs, srcOutMs, preRollMs, postRollMs }` | `{ sessionId }` |
| `record:mark` | send | `{ sessionId, kind: 'cut'\|'retake'\|'note', atMs }` | — |
| `record:meter` | send | `{ sessionId, rmsDb, peakDb, frames }` | — |
| `record:status` | event | — | `{ sessionId, state, framesWritten, durationMs, droppedFrames, diskFreeBytes }` |
| `record:slice` | invoke | `{ sessionId, vad: VadOptions }` | `{ slices: SliceDto[] }` |
| `record:reslice` | invoke | `{ sessionId, vad: VadOptions }` | `{ slices: SliceDto[] }` |
| `record:matchSlices` | invoke | `{ sessionId, chapterId, slices, useAsr? }` | `{ matches: SliceMatch[], unmatchedSlices, unrecordedLines }` |
| `record:acceptSlices` | invoke | `{ sessionId, accepted: SliceMatch[] }` | `{ createdTakes, createdSegments }` |
| `device:list` | invoke | — | `{ devices: AudioDeviceDto[], preferred: string \| null }` |
| `device:savePreference` | invoke | `{ deviceId, label, config }` | `{ ok }` |
| `device:selfTestResult` | invoke | `{ result }` | `{ ok }` |
| `take:listByLine` | invoke | `{ lineId }` | `TakeDto[]` |
| `take:listByChapter` | invoke | `{ chapterId }` | `TakeDto[]` |
| `take:setSelected` | invoke | `{ lineId, takeId }` | `{ segment: SegmentDto }` |
| `take:delete` | invoke | `{ takeId, hard?: boolean }` | `{ ok }` |
| `take:flag` | invoke | `{ takeId, flags: string[] }` | `TakeDto` |
| `take:updateTrim` | invoke | `{ takeId, trimmedInMs, trimmedOutMs }` | `TakeDto` |
| `take:combineParts` | invoke | `{ lineId, takeIds: string[] }` | `{ takeId }`（超长行分段合并） |

### 4.6 对轨（`alignment`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `alignment:listArrangements` | invoke | `{ chapterId }` | `ArrangementDto[]` |
| `alignment:create` | invoke | `{ chapterId, name, strategy }` | `ArrangementDto` |
| `alignment:duplicate` | invoke | `{ arrangementId, name }` | `ArrangementDto` |
| `alignment:delete` | invoke | `{ arrangementId }` | `{ ok }` |
| `alignment:setDefault` | invoke | `{ arrangementId }` | `{ ok }` |
| `alignment:get` | invoke | `{ arrangementId }` | `{ arrangement, items: ArrangementItemDto[] }` |
| `alignment:autoArrange` | invoke | `{ arrangementId, strategy, preserveLocked, defaultPauseMs }` | `{ items, totalDurationMs }` |
| `alignment:updateItem` | invoke | `{ itemId, patch }` | `ArrangementItemDto` |
| `alignment:batchUpdateItems` | invoke | `{ updates: Array<{ itemId, patch }> }` | `{ updated }` |
| `alignment:validate` | invoke | `{ arrangementId }` | `ArrangementValidation` |
| `alignment:resolveOverlap` | invoke | `{ arrangementId, itemIdA, itemIdB, strategy }` | `{ items }` |
| `alignment:resetTrack` / `alignment:resetAll` | invoke | `{ arrangementId, trackId? }` | `{ items }` |
| `alignment:autoMatchSegments` | invoke | `{ chapterId, useAsr? }` | `{ matches, unmatched }` |
| `alignment:bindSegment` | invoke | `{ lineId, segmentId, srcInMs?, srcOutMs? }` | `{ ok }` |
| `alignment:unbindSegment` | invoke | `{ lineId }` | `{ ok }` |
| `alignment:previewRender` | invoke | `{ arrangementId, mixProjectId, startMs, durationMs }` | `{ taskId }` |
| `alignment:forcedAlign` | invoke | `{ lineId \| segmentId }` | `AppError('NOT_IMPLEMENTED')` ← 1.0 占位 |

### 4.7 处理与素材（`process` / `preset` / `music` / `analysis`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `process:preview` | invoke | `{ segmentId, chain, durationMs? }` | `{ path }` |
| `process:apply` | invoke | `{ segmentId, presetId \| chain }` | `{ taskId }` |
| `process:batchApply` | invoke | `{ scope: 'segments'\|'character'\|'chapter'\|'book', ids, presetId \| chain }` | `{ taskId }` |
| `process:listApplied` | invoke | `{ segmentIds: string[] }` | `Array<{ segmentId, processedPath, presetHash, appliedAt }>` |
| `process:revert` | invoke | `{ segmentId }` | `{ ok }` |
| `preset:list` | invoke | `{ includeBuiltin? }` | `ProcessPresetDto[]` |
| `preset:create` / `preset:update` / `preset:delete` | invoke | `{ preset }` / `{ id, patch }` / `{ id }` | `ProcessPresetDto` / `{ ok }` |
| `preset:import` / `preset:export` | invoke | `{ path }` / `{ ids, path }` | `{ imported }` / `{ path }` |
| `music:import` | invoke | `{ files: string[], kind: 'bgm'\|'sfx' }` | `MusicAssetDto[]` |
| `music:list` | invoke | `{ projectId, kind? }` | `MusicAssetDto[]` |
| `music:probe` | invoke | `{ assetId }` | `{ durationMs, sampleRate, channels, peakDb, lufs }` |
| `music:delete` | invoke | `{ assetId }` | `{ ok }` |
| `analysis:noiseProfile` | invoke | `{ segmentId, startMs, endMs }` | `{ rmsDb, bands?: number[], suggestedNf }` |
| `analysis:metrics` | invoke | `{ path \| segmentId }` | `{ durationMs, peakDb, rmsDb, lufs, truePeakDb }` |
| `analysis:peaks` | invoke | `{ path, peaksPerSec, fromMs?, toMs? }` | `{ peaks: Int16Array, channelCount, totalPeaks }`（降采样后传输） |
| `ffmpeg:capabilities` | invoke | — | `{ version, filters: Record<string, string[]>, missing: string[] }` |

### 4.8 混音与导出（`mix` / `export`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `mix:listProjects` | invoke | `{ chapterId }` | `MixProjectDto[]` |
| `mix:get` | invoke | `{ mixProjectId }` | `MixProjectDto` |
| `mix:save` | invoke | `{ mixProject }` | `MixProjectDto` |
| `mix:create` / `mix:duplicate` / `mix:delete` | invoke | — | — |
| `mix:previewRender` | invoke | `{ mixProjectId, startMs, durationMs }` | `{ taskId }` |
| `mix:measureLoudness` | invoke | `{ path, target? }` | `{ inputI, inputTp, inputLra, targetOffset }` |
| `export:preCheck` | invoke | `{ bookId, chapterIds?, mixProjectId, params }` | `QcPreCheckResult` |
| `export:chapter` | invoke | `{ chapterIds, mixProjectId, params }` | `{ taskId }` |
| `export:book` | invoke | `{ bookId, mixProjectId, params, makeM4b }` | `{ taskId }` |
| `export:m4b` | invoke | `{ bookId, chapters: string[], params }` | `{ taskId }` |
| `export:pause` / `export:resume` | invoke | `{ taskId }` | `{ ok }` |
| `export:report` | invoke | `{ jobId \| taskId }` | `ExportReport` |
| `export:verify` | invoke | `{ jobId }` | `{ chapters: Array<{ path, measuredLufs, measuredTp }> }` |
| `export:progress` | event | — | 见 `task:progress` |
| `export:openFolder` | invoke | `{ jobId }` | `{ ok }` |

### 4.9 项目包与任务包（`package`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `package:exportProject` | invoke | `{ projectId, options }` | `{ taskId }` |
| `package:importProject` | invoke | `{ path, options }` | `{ taskId }` |
| `package:exportTask` | invoke | `{ bookId, actorId, options }` | `{ taskId }` |
| `package:mergeTask` | invoke | `{ projectId, path }` | `{ taskId }` |
| `package:inspect` | invoke | `{ path }` | `PackageManifest`（不解压全部，只读 manifest） |
| `package:listHistory` | invoke | `{ projectId }` | `PackageHistoryEntry[]` |

### 4.10 设置与任务（`settings` / `task` / `log` / `db`）

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `settings:get` | invoke | `{ keys?: string[] }` | `AppSettings`（敏感字段掩码） |
| `settings:set` | invoke | `{ patch }` | `{ changedKeys: string[] }` |
| `settings:setSecret` | invoke | `{ key, value }` | `{ ok }`（值经 safeStorage 加密） |
| `settings:testProvider` | invoke | `{ providerConfig }` | `{ ok, message, latencyMs? }` |
| `settings:reset` | invoke | `{ keys? }` | `{ ok }` |
| `settings:changed` | event | — | `{ changedKeys: string[] }` |
| `task:list` | invoke | `{ status?, kind?, limit? }` | `TaskDto[]` |
| `task:get` | invoke | `{ taskId }` | `TaskDto` |
| `task:cancel` | invoke | `{ taskId }` | `{ ok }` |
| `task:retry` | invoke | `{ taskId }` | `{ taskId }` |
| `task:clearFinished` | invoke | — | `{ cleared }` |
| `task:progress` | event | — | 见 §6.1 |
| `log:subscribe` | invoke | `{ level }` | `{ ok }` |
| `log:entry` | event | — | `{ ts, level, event, data }` |
| `log:exportDiagnostics` | invoke | — | `{ path }` |
| `db:backup` | invoke | — | `{ path }` |
| `db:listBackups` | invoke | — | `BackupEntry[]` |
| `db:restore` | invoke | `{ path }` | `{ ok }`（需重启应用） |
| `db:integrityCheck` | invoke | — | `{ ok, errors: string[] }` |
| `db:stats` | invoke | — | `{ sizeBytes, tables: Array<{ name, rows, sizeBytes }> , schemaVersion }` |

### 4.11 事件流清单（主 → 渲染）

| 事件 | 载荷 | 频率 |
|------|------|------|
| `task:progress` | `{ taskId, kind, progress, stage, etaMs, throughput }` | ≤ 10/s（节流） |
| `task:finished` | `{ taskId, status, result?, error? }` | 每次 |
| `record:status` | `{ sessionId, state, framesWritten, durationMs, droppedFrames, diskFreeBytes }` | 状态变更 + 1/s |
| `record:level` | `{ sessionId, rmsDb, peakDb, clipping }` | ≤ 20/s |
| `record:sliceProgress` | `{ sessionId, analyzedMs, totalMs }` | ≤ 5/s |
| `canvas:progress` | `{ chapterId, stage, processed, total }` | ≤ 5/s |
| `export:progress` | `{ taskId, currentChapter, totalChapters, stage, elapsedMs, etaMs, speed }` | ≤ 2/s |
| `settings:changed` | `{ changedKeys }` | 变更时 |
| `fs:changed` | `{ projectId, kind }` | 外部文件变化（可选） |
| `app:beforeQuit` | `{ reason: 'user'\|'os' }` | 关闭前（渲染可拦截） |
| `crash:recovered` | `{ sessions: number, totalMs: number }` | 启动时（如有） |
| `provider:circuitChanged` | `{ provider, state: 'open'\|'closed', untilTs }` | 变更时 |
| **`app:error`** | `SerializedAppError`（见 §5.1） | 主进程主动推送的错误 |
| **`main:interruptedTasks`** | `{ count: number }` | 启动时（如有被中断的任务） |

> `app:error` 是**主进程 → 用户**的错误通道：主进程侧未捕获异常、致命错误、后台任务失败等
> 不经请求-响应就能被用户知道的场景，一律走它。渲染进程在 `app/error-handler.ts` 中订阅并
> 交给 `error-bus` 统一兑现（文案/分级/去重/日志与其他错误完全一致）。
>
> **注意**：已经通过 `invoke` 的 `{ok:false}` 返回给调用方的错误**不要**再推 `app:error`，
> 否则用户会看到两次。详情见 `22-错误码与消息体系.md` §6.1。

---

## 5. 错误契约

> 本节定义错误的**数据结构**。编号派生规则、消息表、三级兜底与 UI 展示策略见
> **`22-错误码与消息体系.md`**（配套代码：`src/shared/messages.ts`、`src/shared/errors.ts`）。

### 5.1 统一形状

```ts
/** 语义键：稳定标识，代码里用；数字编号由其确定性派生（见 22 §2） */
type ErrorCode = keyof typeof MESSAGES

interface SerializedAppError {
  code: ErrorCode              // 语义键，如 'RECORD_DEVICE_LOST'
  numericCode: string          // 派生编号，如 'E200005'（日志与报障用）
  message: string              // = 消息表 title（已插值），便于日志 grep
  severity: 'info' | 'warning' | 'error' | 'fatal'
  action: 'retry' | 'open_settings' | 'open_folder' | 'reload' | 'contact_support' | 'dismiss' | 'none'
  retryable: boolean
  params: Record<string, string | number>       // 文案占位符的值
  details?: Record<string, unknown>             // 结构化上下文（进日志，永不进 UI）
  causeChain?: string[]                         // 原始错误摘要链（进日志，永不进 UI）
  stack?: string                                // 仅 error/fatal 且开发模式
}

/** IPC 统一响应：主进程 handler 永不 throw，一律返回它 */
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedAppError }
```

**为什么不是 `throw`**：`ipcMain.handle` 抛出的异常经 Electron 序列化后，自定义字段
（`code`、`retryable`、`severity`）会全部丢失，只剩一个 message 字符串。因此统一走
`{ok, error}` 结构，保证错误码与建议动作一路不丢。

**`message` 与 `title` 的关系**：`message` 就是消息表里插值后的 `title`，仅供日志 grep 与
开发期阅读。**UI 必须使用 `getMessage(code, params)` 得到的 `title/detail/hint`**，
不要直接把 `message` 塞进组件——否则 `detail`（原因）与 `hint`（怎么办）会丢失，
用户看到的提示会明显偏弱。

### 5.2 错误码清单

| 码 | 含义 | retryable | 用户提示建议 |
|----|------|-----------|--------------|
| `INVALID_PAYLOAD` | 参数校验失败 | false | 「请求参数错误」（开发问题） |
| `NOT_FOUND` | 记录/文件不存在 | false | 「找不到指定的数据」 |
| `CONFLICT` | 版本冲突（乐观锁） | true | 「数据已被修改，请重新加载」 |
| `PERMISSION_DENIED` | 文件/系统权限 | false | 指引到系统设置 |
| `DISK_FULL` | 磁盘空间不足 | true | 「磁盘空间不足，需释放 X MB」 |
| `FILE_TOO_LARGE` | 超过大小限制 | false | 「文件过大，上限 X MB」 |
| `ENCODING_UNCERTAIN` | 编码无法确定 | false | 进入编码选择步骤 |
| `PDF_NO_TEXT_LAYER` | 扫描版 PDF | false | 「需要 OCR，本版本不支持」 |
| `FETCH_FAILED` / `FETCH_BLOCKED` / `FETCH_FORBIDDEN_TARGET` | 抓取失败/被拒/SSRF | 部分 | 「抓取失败：<原因>」 |
| `NO_CHAPTER_MATCHED` | 分章无匹配 | false | 「请选择分章方式」 |
| `DEVICE_UNAVAILABLE` | 音频设备不可用 | true | 「设备被占用或已断开」 |
| `DEVICE_PERMISSION` | 麦克风权限被拒 | false | 指引到系统设置 |
| `RECORD_WRITE_BACKPRESSURE` | 写入跟不上 | true | 「已停止录音并保存素材」 |
| `RECORD_DEVICE_LOST` | 录制中设备拔出 | false | 「已保存已录素材」 |
| `FFMPEG_MISSING` | ffmpeg 不存在 | false | 「未找到 ffmpeg，请在设置中指定」 |
| `FFMPEG_FAILED` | ffmpeg 执行失败 | true | 附命令与 stderr 摘要 |
| `FFMPEG_FILTER_UNSUPPORTED` | 滤镜不支持 | false | 隐藏对应控件 |
| `MODEL_MISSING` | 模型文件缺失 | false | 「请放置模型文件」 |
| `MODEL_CHECKSUM_MISMATCH` | 模型校验失败 | false | 「模型文件损坏，请重新放置」 |
| `AI_PROVIDER_UNAVAILABLE` | Provider 不可达 | true | 「AI 功能暂不可用，已降级」 |
| `AI_CLOUD_DISABLED` | 云端被禁用 | false | 不提示（内部逻辑） |
| `AI_INVALID_OUTPUT` | 结构化输出校验失败 | true | 「AI 返回格式异常，已跳过」 |
| `SECURE_UNAVAILABLE` | 系统不支持安全存储 | false | 「无法安全保存密钥」 |
| `NOT_IMPLEMENTED` | 功能占位（如强制对齐） | false | 「该功能将在后续版本提供」 |
| `TASK_CANCELLED` | 任务被取消 | true | 不提示 |
| `INTERNAL` | 未预期错误 | false | 「发生未知错误，请导出诊断包」 |

> **上表为设计初稿的概览，不是权威来源。** 权威来源是 `src/shared/messages.ts`，
> 它含 121 条消息（含 `title/detail/hint/severity/action/params/dev` 全字段），
> 数字编号由该文件按段派生。上表与消息表的差异对照见 §5.2.1。

### 5.2.1 概念对照（初稿命名 → 消息表语义键）

设计初稿里用了若干更粗的码，落地时按「**能给出不同建议的才拆码**」原则做了细化。
两处命名不同，映射如下（实现时以右列为准）：

| 初稿码 | 消息表语义键 | 变化说明 |
|--------|--------------|----------|
| `FFMPEG_MISSING` | `MODEL_MISSING` | 音频组件与模型同属「随安装包内置的必需资源」，缺失走同一个码（`params.model` 填「音频处理组件」），提示与设置页引导一致 |
| `FFMPEG_FAILED` | `EXPORT_FFMPEG_FAILED` | 明确了「导出/合成」语境，并带 `chapter`/`stage` 参数 |
| `FFMPEG_FILTER_UNSUPPORTED` | `FILTER_UNSUPPORTED` | 去掉实现细节前缀（用户界面不该出现 ffmpeg） |
| `AI_PROVIDER_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` | 去掉冗余前缀 |
| `AI_CLOUD_DISABLED` | `PROVIDER_CLOUD_DISABLED` | 归入 Provider 段，便于按段查编号 |
| `SECURE_UNAVAILABLE` | `APP_SECURE_STORAGE_UNAVAILABLE` | 归入 APP 段；另补 `APP_SECRET_DECRYPT_FAILED` |
| `FILE_PERMISSION` | `PERMISSION_DENIED` | 与系统 `EACCES/EPERM/EROFS` 统一到一个码 |
| `DEVICE_UNAVAILABLE` | `DEVICE_UNAVAILABLE` | 不变 |
| `MODEL_MISSING` / `MODEL_CHECKSUM_MISMATCH` | 同名保留 | 两者的用户建议不同（重新放置 vs. 文件损坏），因此必须分开 |
| 其余 | 同名保留或细化 | 见 `messages.ts` |

**初稿中未进消息表、且属正常现象的项**（不应当作错误弹给用户）：

| 项 | 处理 |
|----|------|
| `ENCODING_UNCERTAIN` | 保留为消息，但 `action: 'dismiss'`、`severity: 'warning'`——它是引导进入「选择编码」步骤，不是异常 |
| `NOT_IMPLEMENTED` | 保留但 `severity: 'info'`——「功能尚未提供」不是错误 |
| `TASK_CANCELLED` | 保留但 `severity: 'info'` 且 `action: 'none'`；**UI 必须直接吞掉不弹** |
| `DUPLICATE_BOOK` | 保留但 `severity: 'info'`，作为三选一对话框的说明文本 |

### 5.3 主进程包裹器

```ts
// ipc/registry.ts
export function handle<TReq, TRes>(
  channel: string,
  schema: ZodSchema<TReq>,
  fn: (req: TReq, event: IpcMainInvokeEvent) => Promise<TRes>
) {
  ipcMain.handle(channel, async (event, raw) => {
    try {
      const req = schema.parse(raw)
      return { ok: true, data: await fn(req, event) }
    } catch (e) {
      const err: IpcError = toIpcError(e)
      log.error(`ipc.${channel}.failed`, { code: err.code, message: err.message })
      return { ok: false, error: err }      // 不 throw（throw 会丢失结构）
    }
  })
}
```

**渲染侧封装**（`shared/lib/ipc.ts`）
```ts
const res = await window.api.invoke('canvas:getChapter', { chapterId })
if (!res.ok) {
  if (res.error.retryable) return showRetryableToast(res.error)
  throw new AppError(res.error)
}
return res.data
```
> 统一解包是由 `ipc.ts` 完成的，**组件里不写 `if (!res.ok)` 判断**，避免遗漏。

---

## 6. 载荷示例（关键几个）

### 6.1 `task:progress`

```jsonc
{
  "taskId": "01H...",
  "kind": "export.book",
  "progress": 0.42,
  "stage": "正在渲染第 51/120 章：第51章 药老现身",
  "etaMs": 1620000,
  "throughput": { "unit": "chapter", "perSecond": 0.031 }
}
```

### 6.2 `canvas:getChapter`

请求
```jsonc
{ "chapterId": "uuid", "offset": 0, "limit": 200, "filter": { "needsReview": true } }
```
响应
```jsonc
{
  "total": 482,
  "lines": [
    {
      "id": "uuid", "seq": 42, "speakerType": "character",
      "characterId": "uuid", "characterName": "萧炎",
      "text": "我萧炎，从来不会认输。", "sourceText": "「我萧炎，从来不会认输。」",
      "kind": "dialogue", "state": "recorded",
      "emotion": "愤怒", "emotionIntensity": 4, "speed": "fast",
      "pauseAfterMs": 600, "pronunciation": null, "note": "情绪爆发点",
      "confidence": 0.58, "decidedBy": "vector", "needsReview": 1,
      "candidates": [ { "characterId": "uuid", "name": "萧炎", "score": 0.58 },
                      { "characterId": "uuid", "name": "药老", "score": 0.54 } ],
      "flags": null, "takeCount": 2, "segmentId": "uuid", "rev": 7
    }
  ]
}
```

### 6.3 `record:stop`

请求
```jsonc
{ "sessionId": "uuid", "lineId": "uuid",
  "trim": { "enabled": true, "thresholdDb": -45, "paddingMs": 100 } }
```
响应
```jsonc
{
  "session": { "id": "uuid", "filePath": "recordings/uuid.wav", "durationMs": 12400,
               "sampleRate": 48000, "bitDepth": 32, "channels": 1, "droppedFrames": 0 },
  "take": { "id": "uuid", "filePath": "takes/uuid/uuid.wav", "durationMs": 3200,
            "trimmedInMs": 120, "trimmedOutMs": 3050, "peakDb": -3.1, "flags": null },
  "segment": { "id": "uuid", "lineId": "uuid", "takeId": "uuid",
               "filePath": "segments/uuid.wav", "durationMs": 2930 }
}
```

### 6.4 `alignment:get`

```jsonc
{
  "arrangement": { "id": "uuid", "chapterId": "uuid", "name": "标准版",
                   "isDefault": 1, "strategy": "serialize", "totalDurationMs": 742000 },
  "items": [
    { "id": "uuid", "segmentId": "uuid", "lineId": "uuid", "trackId": "narration",
      "timelineStartMs": 0, "srcInMs": 0, "srcOutMs": 4200,
      "fadeInMs": 5, "fadeOutMs": 5, "locked": 0, "orderInTrack": 0 }
  ]
}
```

### 6.5 `export:book` 请求

```jsonc
{
  "bookId": "uuid",
  "mixProjectId": "uuid",
  "chapterIds": null,                    // null = 全部
  "makeM4b": true,
  "params": {
    "format": "mp3",
    "mp3Bitrate": 192,
    "sampleRate": 44100,
    "targetLufs": -16,
    "truePeakDb": -1,
    "lra": 11,
    "headSilenceMs": 500,
    "tailSilenceMs": 1500,
    "outputDir": "D:/exports",
    "fileNameTemplate": "{bookTitle}/{chapterIndex:03}_{chapterTitle}",
    "metadata": { "artist": "天蚕土豆", "album": "斗破苍穹", "narrator": "旁白A",
                  "genre": "Audiobook", "coverPath": "C:/cover.jpg" },
    "overwrite": "skip" | "overwrite" | "rename",
    "splitM4bEvery": 200                  // 每 N 章一卷；0 = 不拆分
  }
}
```

---

## 7. 事件与状态同步约定

| 原则 | 说明 |
|------|------|
| 主进程权威 | 状态机（录音、任务）以主进程为准；渲染进程只镜像，不自行推进 |
| 事件幂等 | 事件可能重复到达（重连、窗口重建）；渲染进程按 `taskId + progress` 单调性去重 |
| 窗口重建 | 渲染进程崩溃重建后，必须能通过 `task:list` + `record:status` 恢复当前状态 |
| 节流 | 高频事件（电平 ≤ 20/s、进度 ≤ 10/s）在主进程侧节流，不依赖渲染进程 |
| 不丢终态 | `task:finished` 必须送达；若发送时窗口不存在，落库，窗口就绪后补发 |

---

## 8. preload 暴露面

```ts
// src/main/preload.ts
contextBridge.exposeInMainWorld('api', {
  invoke: <C extends Channel>(channel: C, payload: ReqOf<C>) =>
    ipcRenderer.invoke(channel, payload) as Promise<ResOf<C>>,
  send: (channel: SendChannel, payload: unknown) => ipcRenderer.send(channel, payload),
  on: (event: EventChannel, cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.off(event, listener)     // 返回取消订阅函数
  },
  // MessagePort 通道（录音音频）
  attachRecordPort: (port: MessagePort) => ipcRenderer.postMessage('record:port', null, [port]),
  // 少量便捷方法（避免渲染进程拼路径）
  mediaUrl: (projectId: string, relPath: string) =>
    `ns-media://${encodeURIComponent(projectId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`
})
```

**约束**
1. **白名单校验**：`invoke`/`send`/`on` 内部校验 channel 是否在契约表内，未注册的直接抛错（防止渲染进程被注入后调用任意通道）。
2. **不暴露 `ipcRenderer` 本体**，不暴露 `require`、`process`、`fs`。
3. **不暴露原始 `MessagePort` 之外的能力**（只 `postMessage` 转移端口）。
4. `on` 必须返回取消订阅函数，否则组件卸载后会内存泄漏并重复响应。

---

## 9. 类型定义骨架（`src/shared/ipc-contract.ts`）

```ts
export const IPC = {
  'app:getInfo':         { req: z.void(), res: z.object({ ... }) },
  'book:importFile':     { req: z.object({ filePath: z.string(), options: ImportOptions }), res: z.object({ taskId: z.string() }) },
  'canvas:updateLine':   { req: z.object({ lineId: z.string(), patch: CanvasLinePatch, rev: z.number().optional() }), res: CanvasLineDtoSchema },
  // ... 全部通道
} as const

export type Channel = keyof typeof IPC
export type ReqOf<C extends Channel> = z.infer<(typeof IPC)[C]['req']>
export type ResOf<C extends Channel> = z.infer<(typeof IPC)[C]['res']>
```

**收益**：主进程 handler 与渲染进程调用两侧都有编译期类型检查；Zod schema 同时用于运行时校验与文档生成（可从这份定义自动导出本文档的表）。

---

## 10. 测试要点

| 测试 | 说明 |
|------|------|
| 契约完整性 | 遍历 `IPC` 表，验证每个通道都有 handler 注册（编译期 + 运行时各一次） |
| 未注册通道 | 调用未注册通道 → 抛错而非静默 |
| 参数校验 | 每个通道用非法载荷调用（缺字段/类型错/超长）→ 返回 `INVALID_PAYLOAD`，不崩 |
| 错误序列化 | 各类 AppError 经 IPC 后形状完整（code/message/retryable/details 保留） |
| 事件订阅泄漏 | 组件卸载后 `on` 返回的取消函数被调用，验证监听器数量归零 |
| 节流 | 高频事件（电平/进度）在 1 秒内到达次数不超过约定上限 |
| 窗口重建 | 模拟渲染进程崩溃重建，验证状态能恢复 |
| 类型漂移 | 修改 `ipc-contract.ts` 后，主/渲染两侧编译必须同时失败（防止只改一边） |
