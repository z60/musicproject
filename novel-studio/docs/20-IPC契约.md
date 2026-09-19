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

> **以下表格已与代码契约对齐**（`src/shared/ipc.ts` 的 `IpcContract` 是唯一权威）。
> 实现状态见表下说明 —— 本文档旧版列了 `snapshotList` / `snapshotRestore` / `importLines`
> 三个通道，它们**不在契约里**，属于设计期设想，处置见 docs/91。

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `canvas:generate` | invoke | `{ chapterId, options: CanvasGenerateOptions }` | `{ taskId }` |
| `canvas:getChapter` | invoke | `{ chapterId, offset?, limit?, filter? }` | `{ lines: CanvasLine[], total }` |
| `canvas:getLine` | invoke | `{ lineId }` | `CanvasLine` |
| `canvas:updateLine` | invoke | `{ lineId, patch, rev? }` | `CanvasLine` |
| `canvas:batchUpdate` | invoke | `{ lineIds?[], patch, filter? }` | `{ updated: number }` |
| `canvas:recomputeAttribution` | invoke | `{ chapterId, scope: 'low_confidence'\|'all'\|'selection', lineIds? }` | `{ taskId }` |
| `canvas:qualityCheck` | invoke | `{ chapterId }` | `QualityIssue[]` |
| `canvas:snapshotCreate` | invoke | `{ chapterId, label?, reason? }` | `{ snapshotId }` |
| `canvas:insertLines` | invoke | `{ chapterId, afterSeq, text, characterId? }` | `CanvasLine[]` |
| `canvas:deleteLine` | invoke | `{ lineId }` | `{ ok }` |
| `canvas:exportText` | invoke | `{ chapterId, format: 'txt'\|'csv'\|'json', outPath? }` | `{ path }` |
| `canvas:getGenerateReport` | invoke | `{ chapterId }` | `CanvasGenerateReport \| null` |

**实现状态（`handlers/canvas.ts`，当前）**

- 上表 **12 个通道全部已实现**。
- `canvas:getGenerateReport` 的报告落库在 `003_canvas_generate_reports.sql`
  （`canvas_generate_reports` 表，一章一行）；从未生成过时返回 `null`（契约允许）。
- `canvas:deleteLine` 是**软删除**（`deleted_at`）；渲染侧另有 `flags: ['deleted']`
  的一套标记，两者语义不同，别混用（docs/91 有登记）。
- `canvas:batchUpdate` **必须给 `lineIds`**：契约允许只给 `filter`，但 `filter` 里没有
  章节维度，照它做等于「按条件更新全库」。
- `canvas:progress` 是**事件**（主 → 渲染），不是 invoke 通道。

### 4.4 角色与配音员（`character` / `voiceActor`）

> 表格已与代码契约（`src/shared/ipc.ts`）对齐；本域 **14 个通道全部已实现**
> （`handlers/character.ts` + `features/book/canvas/character.service.ts`）。

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `character:list` | invoke | `{ bookId, includeArchived? }` | `Character[]` |
| `character:upsert` | invoke | `{ character: { id?, bookId, name, aliases?, gender?, …, sortOrder? } }` | `Character` |
| `character:merge` | invoke | `{ targetId, sourceIds: string[], keepAliases? }` | `{ movedLines, mergedAliases, conflicts }` |
| `character:archive` | invoke | `{ characterId, archived }` | `{ ok }` |
| `character:extract` | invoke | `{ bookId, chapterIds? }` | `CharacterCandidate[]` |
| `character:stats` | invoke | `{ characterId }` | `CharacterStats`（行数/字数/预估时长/已录时长） |
| `character:rebuildCentroid` | invoke | `{ bookId, characterIds? }` | `{ taskId }` |
| `voiceActor:list` | invoke | `{ projectId }` | `VoiceActor[]` |
| `voiceActor:upsert` | invoke | `{ actor: { id?, projectId, name, contact?, note?, profile? } }` | `VoiceActor` |
| `voiceActor:delete` | invoke | `{ actorId }` | `{ ok }` |
| `voiceActor:bind` | invoke | `{ characterId, actorId, isPrimary? }` | `{ ok }` |
| `voiceActor:unbind` | invoke | `{ characterId, actorId }` | `{ ok }` |
| `voiceActor:workload` | invoke | `{ bookId }` | `ActorWorkload[]` |
| `voiceActor:bindings` | invoke | `{ bookId }` | `Array<{ characterId, actorId, isPrimary }>` |

**实现口径（实现与文档不一致时以这里为准）**

- `character:merge` 的 `conflicts` 是**非阻断的警告消息**（`string[]`）：别名冲突的那个别名
  不并入，其余照常合并、台词照常迁移。契约里没有 `ok` 字段，UI 把 `conflicts`
  当提示展示（`characters.store.mergeCharacters` 就是这么用的）。
- 合并的四个副作用缺一不可：迁移台词（并置 `decidedBy='human'`）、合并别名、
  **归档**源角色（禁止物理删除，docs/11 §4.6）、**迁移配音员绑定**（否则配音员会
  随源角色一起被归档到看不见的地方）。
- `character:upsert` 的 `id` 必须与 `bookId` 一致（拒绝把角色挪到别的书）；
  `name` 去空白后不能为空。
- `character:extract` 会**剔除已经存在的角色/别名**（点了也是 no-op），
  且单次最多读入 200 万字正文（超出截断并记 warn）。
- `character:stats.recordedMs` 目前恒为 `0`：录音域（takes/voice_segments）还没有写入路径，
  这里如实返回 0，而不是拿估算时长冒充（docs/91 有登记）。
- `voiceActor:delete` 是**物理删除**并连带解除绑定（表里没有软删除列）；
  画本行不受影响 —— 被台词引用的是**角色**，配音员不被内容引用。
- `voiceActor:workload` 的口径：只统计**台词行**（已归属到角色的行），
  一个角色绑多个配音员时每个配音员都算全额（备选也要能录），
  **0 负载的配音员也会出现在结果里**（他才是最该被分配的人）。

### 4.5 录音（`record` / `device` / `take` / `analysis`）

> 表格已与代码契约（`src/shared/ipc.ts`）对齐（`record:reslice` / `take:updateTrim` 这两个
> 早期草稿名**不在契约里**，已删；对轨域真正用的是 `record:optimizeTrim`）。
> **实现状态**：`analysis:*`（3）、`device:*`（3）、`take:*`（6）、`record:*`（12）
> **全部已实现**（`handlers/audio.ts` + `features/audio/*.service.ts`）。
> 本域已无占位通道，见 docs/91 §5.2.17–§5.2.20。

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `analysis:metrics` | invoke | `{ path? , segmentId? }`（**二选一必给**） | `AudioMetrics` |
| `analysis:peaks` | invoke | `{ path? , segmentId?, peaksPerSec, fromMs?, toMs? }` | `{ peaks: number[], channels, totalPeaks }` |
| `analysis:noiseProfile` | invoke | `{ segmentId, startMs, endMs }` | `{ rmsDb, suggestedNf }` |
| `device:list` | invoke | — | `{ devices: AudioDeviceInfo[], preferred }` |
| `device:savePreference` | invoke | `{ deviceId, label }` | `{ ok }` |
| `device:selfTestResult` | invoke | `{ result: DeviceSelfTestResult }` | `{ ok }` |

**实现口径（`analysis` / `device`）**

- `analysis:*` 当前只支持 **WAV**（录制与导出的中间产物都是 WAV，docs/05 §2）。
  其它格式明确抛 `INVALID_PAYLOAD`（`reason: 'unsupported-format'`），
  **不返回一堆 null 假装测过** —— 那会让「电平正常吗」这个问题永远得不到回答。
- `lufs` / `lra` / `truePeakDb` 需要 ffmpeg 的 `loudnorm` / `ebur128` 两遍法（docs/05 §8）；
  没接线时为 `null`（不是 0、不是拿峰值冒充）。
- `analysis:peaks` 的 `peaks` 是 **[-1, 1] 归一化幅度**、每桶两个点（min/max），
  与渲染侧 `waveform-transform` 的口径一致。
- `analysis:noiseProfile` 的 `suggestedNf` = 区间 RMS + 6 dB（高于底噪才不会被当成语音）；
  数字静音的 RMS 夹到 `SILENCE_FLOOR_DB`（-100 dBFS）—— 否则 `-Infinity` 经 JSON 会变成 `null`。
- `device:list` 返回的是**主进程知道的那部分**（偏好 + label 快照）：
  设备枚举只能在渲染进程做（未授权时拿不到 label，docs/12 §11），由渲染侧合并。
  偏好落 `settings.audio.defaultInputDeviceId`，快照落 `settings.audio.deviceLabels`。


| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `record:prepare` | invoke | `{ projectId, chapterId, mode, format: { sampleRate, bitDepth, channels }, deviceId? }` | `{ sessionId, warnings: string[] }` |
| `record:attachPort` | invoke | `{ sessionId }` | `{ ok }`（MessagePort 由 preload 经 `record:port` 转移，不在返回值里） |
| `record:start` | invoke | `{ sessionId }` | `{ ok }` |
| `record:pause` | invoke | `{ sessionId }` | `{ ok }` |
| `record:resume` | invoke | `{ sessionId }` | `{ ok }` |
| `record:stop` | invoke | `{ sessionId, lineId?, trim?: { enabled, thresholdDb, paddingMs } }` | `{ session, take?, segment? }` |
| `record:abort` | invoke | `{ sessionId, keepFile?: boolean }` | `{ ok }` |
| `record:punchIn` | invoke | `{ lineId, srcInMs, srcOutMs, preRollMs, postRollMs }` | `{ sessionId }` |
| `record:mark` | send | `{ sessionId, kind: 'cut'\|'retake'\|'note', atMs }` | — |
| `record:meter` | send | `{ sessionId, rmsDb, peakDb, frames }` | — |
| `record:status` | event | — | `{ sessionId, state, framesWritten, durationMs, droppedFrames, diskFreeBytes }` |
| `record:slice` | invoke | `{ sessionId, vad: VadOptions }` | `{ slices: VadSlice[] }` |
| `record:matchSlices` | invoke | `{ sessionId, chapterId, slices: VadSlice[], useAsr? }` | `{ matches: SliceMatch[], unmatchedSlices: number[], unrecordedLines: Id[] }` |
| `record:acceptSlices` | invoke | `{ sessionId, accepted: SliceMatch[] }` | `{ createdTakes, createdSegments }` |
| `record:optimizeTrim` | invoke | `{ takeId, options: TrimOptions }` | `{ trimmedInMs, trimmedOutMs }` |
| `take:listByLine` | invoke | `{ lineId }` | `Take[]` |
| `take:listByChapter` | invoke | `{ chapterId }` | `Take[]` |
| `take:setSelected` | invoke | `{ lineId, takeId }` | `VoiceSegment` |
| `take:delete` | invoke | `{ takeId, hard?: boolean }` | `{ ok }` |
| `take:flag` | invoke | `{ takeId, flags: string[] }` | `Take` |
| `take:combineParts` | invoke | `{ lineId, takeIds: Id[] }` | `{ takeId }`（超长行分段合并） |

**实现口径（`take`）**

- 命名空间以契约为准：take 域**只有 6 个通道**。改裁剪点属于 `record:optimizeTrim`
  （改的是 take 的 `trimmedInMs/trimmedOutMs`），不存在 `take:updateTrim`。
- `take:listByLine` / `take:listByChapter` **默认不返回软删除的 take**；`take:delete` 默认
  **软删除**（置 `deleted_at`、清 `is_selected`、磁盘文件保留），只有 `hard: true` 才先删行再删文件。
  **没有恢复通道** —— 软删除的 take 目前只能靠 SQL 捞回，UI 不要承诺「可还原」。
- `take:setSelected` 是**唯一**会把音频写进 `voice_segments` 的入口：
  复制 take 文件到 `segments/{segmentId}.wav` → 实测峰值/RMS → 按 `line_id` upsert
  （保留原 `id`/`createdAt`，把 `processed_path`/`preset_hash` 置空 —— 换了源文件，旧的处理结果失效）。
  跨行选错 take 直接 `INVALID_PAYLOAD`，不做「顺手改行归属」这种猜测。
- `take:combineParts` 按 **`partIndex` 排序**拼接（用户勾选顺序不算数，docs/12 §3.3），
  要求至少 2 个不同 `partIndex`；采样率/位深/声道不一致时拒绝（`format-mismatch`）——
  隐式重采样会让「合并完怎么变声了」无从解释。合并结果保留全部原件。
- take 文件路径一律以**项目根相对路径**（分隔符统一 `/`）入库，避免同一文件
  `a\b.wav` 与 `a/b.wav` 被当成两份缓存（docs/91 §5.2.16）。

### 4.6 对轨（`alignment`）

> **实现状态**：19 个通道**全部已接线**（`handlers/alignment.ts` +
> `features/audio/alignment.service.ts` + `repositories/arrangement.repo{,.sqlite}.ts`）。
> 其中 **18 个是真实功能**；`alignment:forcedAlign` 的**能力未实现**（本仓库没有强制对齐
> 引擎），它不返回 `taskId` 而是抛 `AI_FORCED_ALIGN_UNAVAILABLE` —— 见下面的说明与 docs/91 §5.2.21。

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
| `alignment:autoMatchSegments` | invoke | `{ chapterId, useAsr? }` | `{ matches, unmatchedSegments, unrecordedLines }` |
| `alignment:bindSegment` | invoke | `{ lineId, segmentId, srcInMs?, srcOutMs? }` | `{ ok }` |
| `alignment:unbindSegment` | invoke | `{ lineId }` | `{ ok }` |
| `alignment:issueKindLabels` | invoke | — | `Record<AlignIssueKind, string>`（文案唯一来源） |
| `alignment:previewRender` | invoke | `{ arrangementId, mixProjectId, startMs, durationMs }` | `{ taskId }`（`audio.render`，并发键 `ffmpeg`） |
| `alignment:forcedAlign` | invoke | `{ lineId \| segmentId }` | 抛 `AI_FORCED_ALIGN_UNAVAILABLE`（**能力未实现**，见下） |

**实现口径（`alignment`）**

- **每章至多一个默认方案**：`is_default` 上没有唯一约束，`setDefault` 在一个事务里先清零同章其它方案；
  删掉默认方案时**自动**把最早创建的那份设为默认（否则该章会「没有默认」，导出找不到方案）。
- **`version` 只在整体重排时 +1**（`autoArrange` / 重置）。单条拖动不改它 ——
  version 是导出 `paramsHash` 的成分，每次拖动都 +1 会让导出缓存永久失效。
- **几何计算全在 `src/shared/arrange/**`**：主进程只做「读库 → 调纯函数 → 写库」。
  渲染侧的时间线拖拽用同一份实现，否则会出现「拖的时候在哪、松手后在哪」不一致。
- `alignment:autoMatchSegments` 只处理**孤儿片段**（当前绑定的行已不在本章：章节被合并/拆分/删行之后
  最常见），返回三者：`matches` / `unmatchedSegments` / `unrecordedLines`。
  `useAsr: true` 会被接受但结果是时长对齐（日志记 `alignment.asrUnavailable`），**不伪造识别结果**。
- `alignment:bindSegment` 拒绝跨章绑定（`INVALID_PAYLOAD`）与「目标行已有片段」（`CONFLICT`）；
  绑定成功后**清掉该行的过期时间线条目**，否则渲染仍按旧绑定播放。
- `alignment:unbindSegment` **删除 `voice_segments` 行**：schema 里没有「未绑定的片段」
  （`line_id NOT NULL UNIQUE`），解绑就是删行；音频文件保留在磁盘上，但这条记录**不可恢复**。
- `alignment:previewRender` 只渲染**人声总线**（`cache/tmp/preview-*.wav`）：
  BGM / 音效 / 闪避 / 母带响度属于混音域（`mix:*`，尚未实现）。`mixProjectId` 会被接受并记 warn，
  不假装支持。
- `alignment:forcedAlign` 需要强制对齐引擎（ASR 时间戳或 HMM 对齐），**本仓库没有实现**，
  也不存在可注入的 provider。返回一个「注定失败的任务」比直接说明能力缺失更糟，所以它抛
  `AI_FORCED_ALIGN_UNAVAILABLE`（消息表里已有的键）并给出替代方案提示。

### 4.7 处理与素材（`process` / `preset` / `music` / `analysis`）

> **实现状态**：`process:*`（5）、`preset:*`（6）、`music:*`（4）、`analysis:*`（3）、
> `ffmpeg:capabilities`（1）**全部已实现**（`handlers/processing.ts` / `handlers/music.ts` +
> `features/audio/{process,preset,music,analysis}.service.ts`，ffmpeg 执行器在 `infra/media/ffmpeg-runner.ts`）。
> **真实执行 ffmpeg 需要机器上装了 ffmpeg**（启动期探测；未装时 `process:preview` 明确报
> 「未找到 ffmpeg」，非 WAV 素材探测则报 `ffmpeg-not-found`，都不静默失败）。

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `process:preview` | invoke | `{ segmentId, chain, durationMs? }` | `{ path }`（项目内相对路径，落 `cache/tmp/`） |
| `process:apply` | invoke | `{ segmentId, presetId \| chain }` | `{ taskId }`（`audio.process`，并发键 `ffmpeg`） |
| `process:batchApply` | invoke | `{ scope: 'segment'\|'character'\|'chapter'\|'book', ids, presetId \| chain }` | `{ taskId }` |
| `process:listApplied` | invoke | `{ segmentIds: string[] }` | `Array<{ segmentId, processedPath, presetHash }>` |
| `process:revert` | invoke | `{ segmentId }` | `{ ok }`（只解绑，**不删**派生文件） |
| `preset:list` | invoke | `{ projectId? }` | `ProcessPreset[]`（全局 + 该项目；含内置） |
| `preset:create` / `preset:update` / `preset:delete` | invoke | `{ preset }` / `{ id, patch }` / `{ id }` | `ProcessPreset` / `ProcessPreset` / `{ ok }` |
| `preset:import` / `preset:export` | invoke | `{ path }` / `{ ids, path }` | `{ imported, warnings }` / `{ path }` |
| `music:import` | invoke | `{ projectId, files: string[], kind: 'bgm'\|'sfx' }` | `MusicAsset[]` |
| `music:list` | invoke | `{ projectId, kind? }` | `MusicAsset[]` |
| `music:probe` | invoke | `{ assetId }` | `AudioMetrics` |
| `music:delete` | invoke | `{ assetId }` | `{ ok }` |
| `analysis:noiseProfile` | invoke | `{ segmentId, startMs, endMs }` | `{ rmsDb, suggestedNf }` |
| `analysis:metrics` | invoke | `{ path \| segmentId }` | `AudioMetrics` |
| `analysis:peaks` | invoke | `{ path \| segmentId, peaksPerSec, fromMs?, toMs? }` | `{ peaks: number[], channels, totalPeaks }`（[-1,1] 归一化） |
| `ffmpeg:capabilities` | invoke | — | `AppCapabilities['ffmpeg']` |

- `music:import` **复制**源文件到 `music/{kind}/{id}.{ext}`（docs/14 §8 的「托管」）：
  引用用户原路径的话，一整理素材目录所有 BGM 轨就全哑了。支持
  `mp3/wav/m4a/aac/flac/ogg/opus`，其余扩展名明确拒绝（不猜）。
  导入时尽力测量元数据：**WAV 不经过 ffmpeg**（少一个伪依赖），非 WAV 用 ffmpeg 解码成
  48k 单声道临时 WAV 再测量（口径与 `analysis:*` 一致）；测量失败**不影响导入成功**
  （文件已托管，指标留空，日志记 `music.metadataFailed`）。
- `music:probe` 只认 WAV 或「ffmpeg 能解码」的文件；没装 ffmpeg 时明确报
  `EXPORT_FFMPEG_FAILED(reason=ffmpeg-not-found)`。`truePeakDb`/`lufs`/`lra` 为 `null`
  （真实峰值与响度需要 ffmpeg 的 ebur128 两遍法，docs/05 §8）——不拿峰值冒充。
- `music:delete` **先删文件再删行**；被混音轨引用时**拒绝删除**并列出引用的轨道
  （`mix_tracks` 与 `mix_projects.tracks` 两处都查，因为两种存储同时存在）。
- 契约里**没有** `music:update`：素材的「重命名 / 标签 / 备注 / 授权说明」目前只在渲染侧
  会话内编辑（`MusicLibraryPanel.vue` 有说明），主进程不提供偷偷写库的入口。

**实现口径（`process` / `preset`）**

- **内置预设同时存在于两处**（`002_seed.sql` 的 `builtin = 1` 行 + `shared/constants.ts` 的
  `BUILTIN_PRESETS`）。`preset:list` **以库为准**、常量只补「库里缺失的那条」——
  直接拼接会让每个内置预设出现两次（本项目被测试当场抓过）。
- `presetHash = fnv1a64(canonicalChain(chain))[:12]`，决定
  `processed/{segmentId}.{presetHash}.wav` 的文件名与「跳过重复处理」的判据。
  `canonicalChain` 用**显式键序**（不是 `JSON.stringify`）：从库里读回来的链键序可能不同，
  指纹必须只取决于参数内容。
- 处理**永远基于原始成品**（`voice_segments.file_path`），不基于上一次的处理结果 ——
  否则「换预设」会变成「在已处理的音频上再处理一遍」（降噪/限幅叠加），
  而且 `revert` 之后回不到干净状态（docs/03 §6 非破坏）。
- 批量执行在任务队列里（`audio.process`，并发键 `ffmpeg`）：**失败隔离**
  （一个片段失败不中断整批，报告里有失败原因与可复制的完整命令）、**幂等**
  （`processed_path` 与 `preset_hash` 都一致就跳过）、**取消保留已完成结果**。


### 4.8 混音与导出（`mix` / `export`）

> **实现状态**：`mix:*`（7）与 `export:*`（8）**全部已实现**（`handlers/mix.ts` / `handlers/export.ts` +
> `features/audio/{mix,export}.service.ts` / `export.tasks.ts` + `repositories/*.repo{,.sqlite}.ts`）。
> **渲染边界**：导出目前只混**人声总线**；混音方案里配了 BGM/音效轨时会**明确拒绝**
> （`NOT_IMPLEMENTED(reason=music-tracks-not-mixed-yet)`）而不是静默丢掉音乐，见 docs/91 §5.2.25。
> **响度测量需要 ffmpeg 的 `loudnorm`**：未装时 `mix:measureLoudness` 与 `export:verify`
> 都明确报 `EXPORT_FFMPEG_FAILED(reason=ffmpeg-not-found)`，解析不出结果也明确报错，
> **不返回 0 或拿峰值冒充**。

| 通道 | 模式 | 请求 | 响应 |
|------|------|------|------|
| `mix:listProjects` | invoke | `{ chapterId }` | `MixProject[]`（默认方案在前） |
| `mix:get` | invoke | `{ mixProjectId }` | `MixProject` |
| `mix:save` | invoke | `{ mixProject }`（**整份**） | `MixProject`（`version` +1） |
| `mix:create` | invoke | `{ chapterId, arrangementId, name }` | `MixProject`（自带一条人声轨） |
| `mix:duplicate` | invoke | `{ mixProjectId, name }` | `MixProject`（轨道重新生成 id） |
| `mix:delete` | invoke | `{ mixProjectId }` | `{ ok }` |
| `mix:measureLoudness` | invoke | `{ path \| segmentId, targetLufs? }` | `LoudnessMeasurement` |
| `export:preCheck` | invoke | `{ bookId, chapterIds?, mixProjectId, params }` | `QcPreCheckResult`（blockers / warnings / stats） |
| `export:chapter` | invoke | `{ chapterIds, mixProjectId, params }` | `{ taskId }`（`export.chapter`，并发键 `ffmpeg`） |
| `export:book` | invoke | `{ bookId, mixProjectId, params, makeM4b }` | `{ taskId }`（`export.book`） |
| `export:m4b` | invoke | `{ bookId, chapterIds, params }` | `{ taskId }`（`export.book` + `m4bOnly`） |
| `export:report` | invoke | `{ jobId }` | `ExportReport`（批量行 + 章节行组装） |
| `export:verify` | invoke | `{ jobId }` | `{ chapters: Array<{ path, measuredLufs, measuredTp }> }` |
| `export:openFolder` | invoke | `{ jobId }` | `{ ok }`（在文件管理器中定位产物） |
| `export:vbrPresets` | invoke | — | `Array<{ label, value }>`（`-q:a` 档位 0~9，值不是码率） |

**实现口径（`mix` / `export`）**

- **整份 JSON 存**（`mix_projects.tracks` / `master` / `title_reading`）：契约的 `mix:save`
  传的就是整份方案（渲染侧防抖 500ms 后提交），拆表只会多出「diff → 增删改」三组 SQL。
- 保存时**逐条校验引用**，因为这些错误都只会在渲染时才爆：对轨方案必须属于同一章、
  音乐/音效轨引用的素材必须存在且属于同一项目、轨道 id 不能重复、`presetId` 必须存在。
- 两条不能被整份提交改写的字段：`isDefault`（只能通过「设为默认」改，否则一次防抖保存
  就能把默认方案改没）与 `createdAt`。
- `mix:delete` 删默认方案后**自动**把最早创建的那份设为默认，并清掉 `mix_tracks`
  里可能残留的行（否则 `music:delete` 的引用检查会读到幽灵行）。

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

**两条容易被写错、且错了不报错的语义**（实现见 `handlers/canvas.ts`）：

- **省略 `limit` = 返回全部**（不分页）。待确认队列就是这么调用的
  （`{ filter: { needsReview: true } }`，不带 limit/offset）；若默认截断，
  超过该行数的章节会静默丢行。
- **`total` 是筛选后的条数**，不是本章全部行数。渲染侧用 `collected >= total`
  判断翻页结束 —— 给错会多翻一页空页或提前停止。

响应（**实际返回契约里的 `CanvasLine[]`**，见 `src/shared/types.ts`）
```jsonc
{
  "total": 482,
  "lines": [
    {
      "id": "uuid", "chapterId": "uuid", "bookId": "uuid", "seq": 42,
      "speakerType": "character", "characterId": "uuid",
      "kind": "dialogue", "text": "我萧炎，从来不会认输。", "sourceText": "「我萧炎，从来不会认输。」",
      "charStart": 1180, "charEnd": 1191,
      "emotion": "愤怒", "emotionIntensity": 4, "speed": "fast",
      "gainDb": null, "pauseAfterMs": 600, "pauseInline": null,
      "pronunciation": null, "note": "情绪爆发点", "state": "recorded",
      "confidence": 0.58, "decidedBy": "vector", "needsReview": true,
      "candidates": [ { "characterId": "uuid", "name": "萧炎", "score": 0.58 },
                      { "characterId": "uuid", "name": "药老", "score": 0.54 } ],
      "flags": [], "isTitle": false, "rev": 7,
      "createdAt": 1710000000000, "updatedAt": 1710000001000
    }
  ]
}
```

> 本文档旧版画出的是 `CanvasLineDto`（带 `characterName` / `takeCount` / `segmentId`）。
> 这些**不在契约类型里**：角色名由渲染侧用角色表自行拼接，`takeCount`/`segmentId`
> 属于录音域。契约以 `CanvasLine` 为准（docs/91 记了这条差异，避免下游再按旧 DTO 编码）。

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
