/**
 * Novel Studio · 错误消息表（唯一文案来源）
 * ============================================================================
 * 设计文档：docs/22-错误码与消息体系.md
 * 文档生成：scripts/gen-error-docs.ts  ->  docs/23-错误码一览.md
 *
 * ■ 双轨编号
 *   语义键（本文件的对象 key，如 RECORD_DEVICE_LOST）
 *     -> 数字编号（如 E200005）：段号 + 段内序号，5 位数字，由 SEGMENTS 声明顺序确定性派生。
 *   数字编号不手写，避免两套编号不一致。
 *
 * ■ 纪律（等同数据库迁移：发布即冻结）
 *   1. 新增条目只能【追加在所属段末尾】，禁止在段中间插入或删除。
 *      否则该段后续条目编号整体漂移，历史日志里的 E200005 会指向另一个错误。
 *   2. 需要下线某条时，保留定义并标记 deprecated: true，不要删行。
 *   3. 只有本文件包含用户可见文案。组件 / service / handler 中禁止硬编码提示语。
 *   4. 文案纪律：
 *      · 不出现 ffmpeg / SQLite / EACCES / IPC / undefined / 堆栈 / 绝对路径
 *      · 必须可行动（能重试就给 action:'retry'）
 *      · 说清"哪一步失败 + 为什么 + 怎么办"，不要写"操作失败"
 *   5. 占位符写「{name}」这种半角花括号，可用中文书名号包裹以保证排版；
 *      不要写成全角引号包裹的形式（会让静态校验与文档生成脚本漏判）。
 *   6. dev 字段写单行字符串，不要用字符串拼接（会让文档生成脚本抽不全）。
 *
 * ■ 段号分配
 *   1 GENERIC  通用（校验/权限/磁盘/未知兜底）
 *   2 RECORD   录音、设备、切片、片段、处理链
 *   3 BOOK     书籍导入与解析
 *   4 EXPORT   混音与导出
 *   5 CANVAS   画本、角色、任务包
 *   6 AI       Provider、模型、识别
 *   7 DATA     数据库、项目包、备份、文件系统
 *   8 TASK     任务队列
 *   9 APP      应用生命周期、窗口、更新
 *   0 INTERNAL 框架内部 / 未捕获异常兜底
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 严重度：决定 UI 展示形式（详见 docs/22 §7） */
export type Severity = 'info' | 'warning' | 'error' | 'fatal'

/**
 * 可执行动作：决定提示上的按钮。
 * 展示层不自行推断动作，一律读这里，保证同类错误在全应用行为一致。
 */
export type ErrorAction =
  | 'retry'            // 重试（需调用方注入 retryFn，否则不显示按钮）
  | 'open_settings'    // 前往设置（并高亮相关项）
  | 'open_folder'      // 在文件管理器中打开
  | 'reload'           // 重新加载
  | 'contact_support'  // 导出诊断包
  | 'dismiss'          // 只有"知道了"
  | 'none'             // 不显示按钮（信息型）

export interface ErrorMessage {
  /** 用户看到的标题，一句话，≤ 24 字，不带句号 */
  title: string
  /** 一句话说明原因/后果，≤ 60 字；原因未知时留空 */
  detail?: string
  /** 用户可执行的下一步（纯文案，动作由 action 决定） */
  hint?: string
  severity: Severity
  action: ErrorAction
  /** 默认 false。true = 网络抖动、忙、临时不可用等，UI 可给"重试"并自动退避 */
  retryable?: boolean
  /** 开发侧补充说明：只进日志与诊断包，永不进 UI */
  dev?: string
  /** 文案中使用的占位符名（用于校验与文档生成） */
  params?: readonly string[]
  /** 标记已废弃：保留定义以冻结编号，新代码不得使用 */
  deprecated?: boolean
}

// ============================================================================
// 消息表
// ============================================================================

/**
 * 段内顺序 = 数字编号顺序。只在段末追加。
 */
export const MESSAGES = {
  // --- 1xxx 通用 -----------------------------------------------------------
  INVALID_PAYLOAD: {
    title: '请求参数有误',
    detail: '这个操作缺少必要的参数，可能是界面状态不同步。',
    hint: '请刷新页面后重试；若反复出现请导出诊断包。',
    severity: 'error', action: 'contact_support',
    dev: 'Zod 校验失败。检查 handler 的 schema 与渲染侧调用参数。',
  },
  NOT_FOUND: {
    title: '找不到对应的数据',
    detail: '它可能已被删除，或所在章节已被重新生成。',
    severity: 'warning', action: 'reload',
    dev: 'repository 返回 null。确认 id 是否已被级联删除。',
  },
  CONFLICT: {
    title: '数据已被修改',
    detail: '你正在编辑的内容在别处发生了变更。',
    hint: '已为你重新加载最新数据，请确认后再保存。',
    severity: 'warning', action: 'reload', retryable: true,
    dev: '乐观锁 rev 不匹配。检查是否有第二个窗口或任务在写同一行。',
  },
  PERMISSION_DENIED: {
    title: '没有访问权限',
    detail: '系统拒绝了本次文件访问。',
    hint: '请检查该文件夹的权限，或换一个位置后重试。',
    severity: 'error', action: 'open_folder',
    dev: 'EACCES / EPERM / EROFS。注意 Windows 上被杀软或「受控文件夹访问」拦截。',
  },
  DISK_FULL: {
    title: '磁盘空间不足',
    detail: '还需要约「{need}」才能继续。',
    hint: '请清理磁盘，或在设置中更改项目/导出目录。',
    severity: 'fatal', action: 'open_folder',
    params: ['need'],
    dev: 'ENOSPC / SQLITE_FULL。录音链路遇到此错误已先停止并保住已写数据，不要重试录音后再报错。',
  },
  FILE_NOT_FOUND: {
    title: '文件不存在',
    detail: '文件「{name}」可能已被移动、重命名或删除。',
    hint: '可重新选择文件，或重新定位到新位置。',
    severity: 'error', action: 'dismiss',
    params: ['name'],
    dev: 'ENOENT。音频场景应同时把对应 take/segment 标记 file_missing。',
  },
  FILE_BUSY: {
    title: '文件正被其他程序占用',
    detail: '另一个程序正在使用「{name}」。',
    hint: '请关闭可能打开该文件的播放器或编辑器后重试。',
    severity: 'warning', action: 'retry', retryable: true,
    params: ['name'],
    dev: 'EBUSY。常见于导出目标正被播放器播放。',
  },
  NOT_IMPLEMENTED: {
    title: '该功能尚未提供',
    detail: '「{feature}」将在后续版本中加入。',
    severity: 'info', action: 'dismiss',
    params: ['feature'],
    dev: '接口占位（如 AI 强制对齐）。见 docs/13-功能域-对轨.md §8。',
  },
  TASK_CANCELLED: {
    title: '操作已取消',
    severity: 'info', action: 'none',
    dev: 'AbortError。取消不是错误：不弹提示、写 info 级日志。error-bus 必须直接吞掉。',
  },
  UNSUPPORTED_FORMAT: {
    title: '不支持的格式',
    detail: '「{name}」的格式无法处理。',
    hint: '请确认文件类型，或先转换为受支持的格式。',
    severity: 'warning', action: 'dismiss',
    params: ['name'],
  },
  INTERNAL: {
    title: '发生了未预期的错误',
    detail: '错误编号：「{code}」',
    hint: '可先重试；若反复出现，请导出诊断包并附上错误编号反馈。',
    // action 必须是 retry：文案说了"可先重试"，提示上就必须真的给出重试按钮
    // （导出诊断包的入口在设置页与错误边界页，不抢占这里的首个动作）。
    severity: 'error', action: 'retry', retryable: true,
    params: ['code'],
    dev: '兜底码。真正的原始错误在日志的 causeChain 与 stack 中。出现此码说明某处缺少精确抛错，应补齐。',
  },

  // --- 2xxx 录音 / 设备 / 片段 / 处理链 ------------------------------------
  DEVICE_UNAVAILABLE: {
    title: '录音设备不可用',
    detail: '「{device}」可能被其他程序占用或已断开。',
    hint: '请关闭占用该设备的程序，或换一个输入设备后重试。',
    severity: 'error', action: 'retry', retryable: true,
    params: ['device'],
    dev: 'getUserMedia 抛 NotReadableError / NotFoundError。注意 Windows 上浏览器与 OBS 常抢占设备。',
  },
  DEVICE_PERMISSION: {
    title: '未获得麦克风权限',
    detail: '系统未允许本应用使用麦克风。',
    hint: '请在系统设置中允许麦克风访问，然后重新打开录音。',
    severity: 'error', action: 'open_settings',
    dev: 'NotAllowedError。macOS 需在「系统设置 -> 隐私与安全性 -> 麦克风」勾选；Windows 需在「隐私 -> 麦克风」开启。',
  },
  DEVICE_LOST: {
    title: '录音设备已断开',
    detail: '已录制「{duration}」的素材已完整保存。',
    hint: '请重新连接设备，然后从断点继续录制。',
    severity: 'fatal', action: 'retry',
    params: ['duration'],
    dev: 'devicechange / track.onended。必须先 finalize（补 WAV 头）再提示，顺序反了会丢素材。',
  },
  RECORD_WRITE_BACKPRESSURE: {
    title: '录音写入跟不上，已自动停止',
    detail: '已录制「{duration}」的素材已保存，未丢失。',
    hint: '请确认磁盘速度或可用空间后重新开始录音。',
    severity: 'fatal', action: 'open_folder',
    params: ['duration'],
    dev: '有界队列满。绝不静默丢帧：宁可停录也要保住数据。见 docs/04 §6。',
  },
  RECORD_NO_SIGNAL: {
    title: '没有检测到输入信号',
    detail: '已持续「{seconds}」秒没有采集到声音。',
    hint: '请检查麦克风是否静音、是否选错了输入设备。',
    severity: 'warning', action: 'open_settings',
    params: ['seconds'],
  },
  RECORD_TOO_SHORT: {
    title: '录音太短，已忽略',
    detail: '本次录音只有「{ms}」毫秒。',
    severity: 'info', action: 'dismiss',
    params: ['ms'],
    dev: '< 150 ms 视为误触。检查快捷键是否被误按。',
  },
  RECORD_CLIPPING: {
    title: '录音电平过高（削波）',
    detail: '该片段有「{count}」处过载，可能已经失真。',
    hint: '建议降低输入增益后重录这一行。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
    dev: '连续 >=3 个样本 |x| >= 0.99 计一次。写入 takes.flags 加 "clip"。',
  },
  RECORD_CAPTURE_UNAVAILABLE: {
    title: '采集器没能启动，无法录音',
    detail: '音频采集处理器（AudioWorklet）加载失败，本次录音不会产生任何素材。',
    hint: '请把这条提示连同日志一并反馈；若刚更新过应用，重启一次通常即可恢复。',
    severity: 'error', action: 'retry',
    params: [],
    dev:
      'addModule(blob:) 失败。最常见成因是渲染进程 CSP 的 script-src 不允许 blob: —— ' +
      '缺了它录音会「点了没反应、也没有声音」，而 Chromium 报的是 AbortError（看着像用户取消），' +
      '绝不能按取消静默吞掉。见 docs/91 §5.2.40。',
  },
  RECORD_SESSION_RECOVERED: {
    title: '已恢复上次未保存的录音',
    detail: '共「{count}」段，合计「{duration}」。',
    hint: '请试听确认内容完整后再继续。',
    severity: 'warning', action: 'dismiss',
    params: ['count', 'duration'],
    dev: '启动恢复流程产出。用 .meta.json 的 framesWritten 补 WAV 头；缺 meta 时按文件大小反推。',
  },
  RECORD_SESSION_UNRECOVERABLE: {
    title: '有一段录音无法修复',
    detail: '原始文件已保留，未删除任何数据。',
    hint: '如需抢救，请联系支持并附上诊断包中的文件清单。',
    severity: 'error', action: 'contact_support',
    dev: 'ffprobe 无法解析且头部自相矛盾。文件移入 .tmp/quarantine/ 保留 7 天。',
  },
  RECORD_MONITOR_FEEDBACK: {
    title: '检测到疑似啸叫',
    detail: '监听音量较高时麦克风可能拾取到扬声器输出。',
    hint: '建议佩戴耳机，或关闭麦克风直通。',
    severity: 'warning', action: 'open_settings',
  },
  VAD_NO_SPEECH_FOUND: {
    title: '没有识别出可用的录音片段',
    detail: '整段录音的音量都低于判定门限。',
    hint: '请检查输入增益，或在切片设置中降低门限后重新切片。',
    severity: 'warning', action: 'retry', retryable: true,
    dev: '原始会话保留，可调 VAD 参数重切。不要删除会话文件。',
  },
  TAKE_SRC_MISSING: {
    title: '片段对应的原始录音已丢失',
    detail: '无法定位到源文件。',
    hint: '可重新录制该行，或在片段列表中改选其它版本。',
    severity: 'error', action: 'dismiss',
    dev: 'takes.file_path 指向的文件不存在。segment 打 file_missing 标记。',
  },
  TAKE_NONE_SELECTED: {
    title: '这一行还没有选定成品',
    detail: '存在多个试录版本，需要选一个作为成品。',
    hint: '请在试录列表中试听并选择。',
    severity: 'warning', action: 'dismiss',
  },
  TRIM_FAILED: {
    title: '静音裁剪失败',
    detail: '该片段可能过短或格式异常。',
    hint: '已保留原始文件，可手动调整起止点。',
    severity: 'warning', action: 'dismiss',
  },
  PUNCHIN_OVERLAP_INVALID: {
    title: '补录区间不合法',
    detail: '补录的起点必须早于终点，且落在片段范围内。',
    severity: 'warning', action: 'dismiss',
    dev: '前端也做一次校验，但主进程必须再校验（IPC 可被直调）。',
  },
  PROCESS_CHAIN_EMPTY: {
    title: '处理链没有启用任何模块',
    detail: '将只做格式统一，不改变声音。',
    hint: '如需处理，请至少开启一个模块（如降噪或 EQ）。',
    severity: 'info', action: 'dismiss',
  },
  PROCESS_PRESET_INVALID: {
    title: '预设参数不合法',
    detail: '「{name}」中的某些参数超出允许范围。',
    hint: '已改用默认值，请检查后再应用。',
    severity: 'warning', action: 'dismiss',
    params: ['name'],
    dev: '导入外部预设 JSON 时最易发生。保留未知字段并给出警告，不要静默丢弃。',
  },
  PROCESS_ABORTED: {
    title: '处理已取消',
    detail: '已完成「{done}」个，未完成的未做改动。',
    severity: 'info', action: 'none',
    params: ['done'],
    dev: '已完成的产物保留（它们是有效结果），不回滚。',
  },
  DECLICK_FAILED: {
    title: '爆音修复失败',
    detail: '所选区间可能跨越了片段边界。',
    severity: 'warning', action: 'dismiss',
  },
  FILTER_UNSUPPORTED: {
    title: '当前音频组件不支持该处理项',
    detail: '「{filter}」在你的环境中不可用。',
    hint: '已自动跳过该项，其它处理不受影响。',
    severity: 'warning', action: 'dismiss',
    params: ['filter'],
    dev: '启动能力探测（ffmpeg -h filter=xxx）后据此隐藏控件。不要等用户点了才报错。',
  },

  // --- 3xxx 书籍导入 ------------------------------------------------------
  FILE_TOO_LARGE: {
    title: '文件过大，无法导入',
    detail: '该文件「{size}」，超过上限「{max}」。',
    hint: '可在「设置 -> 导入」中调整上限。',
    severity: 'warning', action: 'open_settings',
    params: ['size', 'max'],
    dev: '上限来自 settings.import.maxFileSizeBytes，默认 200 MB。',
  },
  ENCODING_UNCERTAIN: {
    title: '无法确定文本编码',
    detail: '已列出几个可能的编码及预览。',
    hint: '请在预览中确认哪一种显示正常。',
    severity: 'warning', action: 'dismiss',
    dev: '这不是错误，是引导进入编码选择步骤。不要当异常抛出阻断流程。',
  },
  ENCODING_DECODE_FAILED: {
    title: '文本解码失败',
    detail: '文件内容与常见编码都不匹配，可能已损坏。',
    hint: '可换一个来源的文件，或先用编辑器另存为 UTF-8 后重试。',
    severity: 'error', action: 'dismiss',
    dev: '常见于"UTF-8 被当 GBK 转过一次"的产物。无法自动恢复。',
  },
  PDF_NO_TEXT_LAYER: {
    title: '这个 PDF 无法提取文字',
    detail: '它看起来是扫描件，只有图片没有文字层。',
    hint: '本版本不支持 OCR。建议改用 TXT 版本，或先自行 OCR。',
    severity: 'error', action: 'dismiss',
    dev: 'textContent.items 为空或极少。明确拒绝，绝不产出一本空书。',
  },
  PDF_ENCRYPTED: {
    title: 'PDF 已加密',
    detail: '需要密码才能读取内容。',
    hint: '请先用其他工具解密后再导入。',
    severity: 'error', action: 'dismiss',
  },
  PDF_PARSE_LOW_QUALITY: {
    title: 'PDF 解析质量较低',
    detail: '提取出的文本有较多断行或乱码。',
    hint: '建议改用 TXT 版本，或在预览中人工检查分章结果。',
    severity: 'warning', action: 'dismiss',
    dev: '双栏排版、页眉页脚、连字符断词都会导致。检查可读性指标。',
  },
  DOCX_CORRUPT: {
    title: '文档结构异常',
    detail: '已尽力提取出「{paragraphs}」个段落。',
    hint: '请检查预览；若内容缺失严重，建议换一个副本重试。',
    severity: 'warning', action: 'dismiss',
    params: ['paragraphs'],
  },
  NO_CHAPTER_MATCHED: {
    title: '没有识别到章节标记',
    detail: '文本中找不到「第X章」这类标题。',
    hint: '请选择一种分章方式：按空行、按长度，或整篇作为一章。',
    severity: 'warning', action: 'dismiss',
    dev: '进入备选策略选择步骤，不要自动猜完就入库。',
  },
  CHAPTER_SPLIT_SUSPICIOUS: {
    title: '分章结果可能不正确',
    detail: '共切出「{count}」章，最多的章有「{chars}」字。',
    hint: '请检查分章规则与预览，确认后再导入。',
    severity: 'warning', action: 'dismiss',
    params: ['count', 'chars'],
    dev: '启发性告警：章数异常少或单章异常长时触发。',
  },
  FETCH_FAILED: {
    title: '网页抓取失败',
    detail: '「{reason}」',
    hint: '可稍后重试，或改用「粘贴文本」方式导入。',
    severity: 'warning', action: 'retry', retryable: true,
    params: ['reason'],
    dev: '超时、DNS、TLS、5xx 都归这里，具体原因放 reason。',
  },
  FETCH_BLOCKED: {
    title: '目标网站拒绝了访问',
    detail: '对方返回了「{status}」。',
    hint: '请改用「粘贴文本」方式导入，或降低请求频率后重试。',
    severity: 'warning', action: 'dismiss',
    params: ['status'],
    dev: '403 / 429。立即停止，不要继续重试以免加重封禁。',
  },
  FETCH_FORBIDDEN_TARGET: {
    title: '该地址不被允许访问',
    detail: '只能抓取公开的网页地址。',
    severity: 'error', action: 'dismiss',
    dev: 'SSRF 防护：拒绝 file://、内网、环回、链路本地地址。',
  },
  FETCH_TOO_MANY_PAGES: {
    title: '抓取页数超过上限',
    detail: '已抓取「{count}」页，达到上限「{max}」。',
    hint: '可先导入这批内容，然后再导入后续章节。',
    severity: 'warning', action: 'dismiss',
    params: ['count', 'max'],
  },
  DUPLICATE_BOOK: {
    title: '这本书已经导入过',
    detail: '已存在同名同内容的书籍。',
    hint: '可以打开已有书籍，或作为副本再导入一份。',
    severity: 'info', action: 'dismiss',
    dev: 'content_hash 命中。点「打开已有」用 books.id；点「副本」生成新 id。',
  },
  IMPORT_CLEAN_REMOVED_CONTENT: {
    title: '清洗移除了部分内容',
    detail: '共移除「{lines}」行（广告、页码等）。',
    hint: '可在清洗报告中查看并逐条恢复。',
    severity: 'info', action: 'dismiss',
    params: ['lines'],
    dev: '绝不静默删除用户的东西：必须提供"查看被删内容"。',
  },
  RULE_PATTERN_INVALID: {
    title: '分章规则的正则表达式有误',
    detail: '「{reason}」',
    hint: '请修改规则后重试。',
    severity: 'warning', action: 'dismiss',
    params: ['reason'],
  },
  RULE_PATTERN_UNSAFE: {
    title: '该规则过于复杂',
    detail: '这个表达式可能导致匹配卡死，已被拒绝。',
    hint: '请改用更简单的写法（避免嵌套量词）。',
    severity: 'warning', action: 'dismiss',
    dev: '灾难性回溯防护：(a+)+ 这类模式。匹配加 100 ms 超时。',
  },

  CHAPTER_HAS_CANVAS_LINES: {
    title: '这一章已经有画本了',
    detail: '合并或拆分会让这一章的画本行（以及它们的章内位置）失效。',
    hint: '请先在画本里处理这些行，或改用其它章节；这样不会影响你已经录好的内容。',
    severity: 'warning', action: 'dismiss',
    dev:
      '章节管理的合并/拆分不做画本行迁移：行级 seq 与 charStart/charEnd 在章节边界变化后' +
      '不再成立，而文档没有规定迁移规则。实现选择明确拒绝（INVALID_PAYLOAD + 本消息），' +
      '而不是发明一套「看起来合理」的搬运（那样会静默销毁用户的录音成果）。见 docs/91 §5.2.8。',
  },

  // --- 4xxx 混音与导出 ----------------------------------------------------
  EXPORT_QCPRECHECK_FAILED: {
    title: '导出前检查未通过',
    detail: '发现「{count}」个必须处理的问题。',
    hint: '请按清单处理后重试；也可选择忽略并继续导出。',
    severity: 'error', action: 'dismiss',
    params: ['count'],
    dev: '阻断项（缺录行、未分配说话人、整章静音）与警告项要分开列出。',
  },
  EXPORT_MISSING_LINES: {
    title: '有内容还没录音',
    detail: '共「{count}」行缺少录音。',
    hint: '可以先去补录，或只导出已录部分。',
    severity: 'error', action: 'dismiss',
    params: ['count'],
  },
  EXPORT_FFMPEG_FAILED: {
    title: '音频合成失败',
    detail: '第「{chapter}」章在「{stage}」阶段出错。',
    hint: '可先重试；若反复失败，请前往设置导出诊断包（内含完整命令与日志）。',
    severity: 'error', action: 'retry', retryable: true,
    params: ['chapter', 'stage'],
    dev: 'stderr 与完整命令行放 details，不要进 UI。可用「查看命令」在终端复现。',
  },
  EXPORT_LOUDNESS_OUT_OF_RANGE: {
    title: '成品的响度未达到目标',
    detail: '实测「{measured}」，目标「{target}」。',
    hint: '已尝试自动校正一次。可调整目标响度或检查素材音量。',
    severity: 'warning', action: 'retry',
    params: ['measured', 'target'],
    dev: '偏差 > 1.0 LU。短章（< 60 s）因门限统计不稳最容易出现。',
  },
  EXPORT_TRUE_PEAK_EXCEEDED: {
    title: '成品峰值超过上限',
    detail: '实测「{measured}」，上限「{limit}」。',
    hint: '建议降低目标响度后重新导出，以免播放时失真。',
    severity: 'warning', action: 'retry',
    params: ['measured', 'limit'],
  },
  EXPORT_SILENT_CHAPTER: {
    title: '检测到整章没有声音',
    detail: '第「{chapter}」章的输出几乎是静音。',
    hint: '请检查该章的对轨是否正确、片段是否丢失。',
    severity: 'error', action: 'dismiss',
    params: ['chapter'],
    dev: '整段 RMS < -60 dBFS，几乎必然是渲染失败而非素材安静。',
  },
  EXPORT_M4B_FAILED: {
    title: '有声书合并失败',
    detail: '「{reason}」',
    hint: '分章文件已正常生成，可单独使用；也可按卷拆分后重试合并。',
    severity: 'error', action: 'retry', retryable: true,
    params: ['reason'],
    dev: '常见原因：章数过多、单文件过长、章节时间轴不连续。',
  },
  EXPORT_M4B_TOO_MANY_CHAPTERS: {
    title: '章节数超过单个有声书文件的上限',
    detail: '共「{count}」章，建议每「{per}」章一个文件。',
    hint: '可按卷拆分后再合并。',
    severity: 'warning', action: 'dismiss',
    params: ['count', 'per'],
    dev: '> 200 章时部分播放器章节列表异常。见 docs/05 §9.2。',
  },
  EXPORT_FILE_LOCKED: {
    title: '输出文件被占用',
    detail: '「{name}」正在被其他程序使用。',
    hint: '请关闭正在播放或预览该文件的程序后重试。',
    severity: 'warning', action: 'retry', retryable: true,
    params: ['name'],
  },
  EXPORT_OUTPUT_NOT_WRITABLE: {
    title: '输出目录不可写',
    detail: '无法在「{dir}」中创建文件。',
    hint: '请换一个目录，或检查该目录的权限。',
    severity: 'error', action: 'open_settings',
    params: ['dir'],
  },
  EXPORT_INTERRUPTED: {
    title: '导出被中断',
    detail: '已完成「{done}」/「{total}」章。',
    hint: '重新导出时会自动跳过已完成的章节，无需从头再来。',
    severity: 'warning', action: 'retry', retryable: true,
    params: ['done', 'total'],
    dev: 'export_jobs 已记录，按 params_hash 判定 skip。',
  },
  MIX_ARRANGEMENT_EMPTY: {
    title: '这一章还没有可用的对轨结果',
    detail: '请先完成自动对轨或手工排布。',
    severity: 'error', action: 'dismiss',
  },
  MIX_NO_VOICE_TRACK: {
    title: '没有任何人声轨道可混合',
    detail: '当前混音方案里没有启用的人声轨。',
    hint: '请检查是否把所有轨道都静音了，或混音方案是否选错。',
    severity: 'error', action: 'dismiss',
  },
  MIX_DUCKING_SIDECHAIN_MISSING: {
    title: '自动闪避无法生效',
    detail: '缺少可用的人声侧链信号。',
    hint: '已按普通模式混合背景音乐。',
    severity: 'warning', action: 'dismiss',
    dev: 'Solo 时侧链源被静音会导致此问题。侧链源必须始终有效。',
  },
  MIX_TARGET_CONFLICT: {
    title: '响度与峰值目标冲突',
    detail: '按当前目标需要大幅压限，可能造成失真。',
    hint: '建议降低目标响度，或接受轻微失真继续。',
    severity: 'warning', action: 'open_settings',
  },
  EXPORT_METADATA_WRITE_FAILED: {
    title: '元数据或封面写入失败',
    detail: '音频文件本身已正常生成。',
    hint: '可检查封面图片格式（建议 JPEG / PNG），或关闭封面后重新导出。',
    severity: 'warning', action: 'dismiss',
  },
  EXPORT_PARTIAL_SUCCESS: {
    title: '导出完成，但有部分章节失败',
    detail: '成功「{ok}」章，失败「{failed}」章。',
    hint: '可在导出报告中查看失败原因并单独重试。',
    severity: 'warning', action: 'dismiss',
    params: ['ok', 'failed'],
    dev: '单个章节失败不得中断整本导出。',
  },
  EXPORT_M4B_VERIFY_FAILED: {
    title: '有声书章节信息校验未通过',
    detail: '播放器可能无法正确显示章节列表。',
    hint: '请重试合并；若仍失败请导出诊断包。',
    severity: 'warning', action: 'contact_support',
    dev: '用 ffprobe 复读章节数与时间轴连续性。START/END 必须无缝且为整数毫秒。',
  },

  // --- 5xxx 画本 / 角色 / 任务包 -------------------------------------------
  CANVAS_CHAPTER_EMPTY: {
    title: '这一章还没有内容',
    detail: '章节文本为空，无法生成画本。',
    hint: '请返回章节列表检查导入结果。',
    severity: 'warning', action: 'dismiss',
  },
  CANVAS_ALREADY_EDITED: {
    title: '这一章已有手工修改',
    detail: '共「{count}」行由人工确认过。',
    hint: '继续生成会保留人工结果，只覆盖其余部分。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
    dev: 'decided_by = human 的行永不自动覆盖。生成前自动打快照以便回滚。',
  },
  CANVAS_EMBEDDING_UNAVAILABLE: {
    title: '未启用语义判定，准确率会下降',
    detail: '本地语义模型不可用，已改用规则判定。',
    hint: '可在设置中检查模型是否放置正确；也可直接人工校对。',
    severity: 'warning', action: 'open_settings',
    dev: '模型缺失/校验失败/推理 OOM。生成报告里必须显式体现 embeddingUsed=false。',
  },
  CANVAS_LLM_UNAVAILABLE: {
    title: '智能复核不可用',
    detail: '部分存疑内容未能自动判定，已放入待确认列表。',
    hint: '可在设置中检查 AI 服务配置。',
    // 不声明 retryable：需先修配置，重试无意义。
    severity: 'info', action: 'open_settings',
  },
  CANVAS_GENERATE_PARTIAL: {
    title: '画本生成完成，但存在存疑内容',
    detail: '共「{total}」行，其中「{review}」行需要人工确认。',
    hint: '建议进入待确认列表逐条过一遍。',
    severity: 'info', action: 'dismiss',
    params: ['total', 'review'],
  },
  CANVAS_ATTRIBUTION_LOW_CONFIDENCE: {
    title: '部分台词的归属无法确定',
    detail: '共「{count}」行置信度较低。',
    hint: '已放入待确认列表，通常几分钟可以清理完。',
    severity: 'info', action: 'dismiss',
    params: ['count'],
  },
  CHARACTER_MERGE_CONFLICT: {
    title: '角色合并存在别名冲突',
    detail: '有「{count}」个别名同时属于两个角色。',
    hint: '请选择保留哪一个，或先改名再合并。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
    dev: '合并前必须展示「将影响 N 行」并给出别名冲突清单。',
  },
  CHARACTER_ARCHIVED: {
    title: '该角色已归档',
    detail: '归档后不再出现在新生成的画本中，但已有引用保留。',
    hint: '可在角色表中恢复。',
    severity: 'info', action: 'dismiss',
    dev: '角色禁止物理删除，只允许归档，否则会破坏既有引用。',
  },
  ATTRIBUTION_RECOMPUTE_REQUIRED: {
    title: '需要重新计算才能生效',
    detail: '更换语义模型后，原有判定结果不再适用。',
    hint: '预计需要「{eta}」，过程中可继续浏览但不建议同时编辑。',
    severity: 'warning', action: 'dismiss',
    params: ['eta'],
    dev: '向量空间不可比，必须全量重算。UI 要给出耗时预估，否则用户会误以为卡死。',
  },
  PACKAGE_EXPORT_FAILED: {
    title: '任务包导出失败',
    detail: '「{reason}」',
    hint: '请检查目标目录的可用空间与权限，然后再试一次。',
    // 不声明 retryable：需先处理目录问题，直接重试只会再次失败。
    severity: 'error', action: 'open_folder',
    params: ['reason'],
  },
  PACKAGE_INVALID: {
    title: '这个包无法读取',
    detail: '文件可能不完整或不是本应用的包。',
    hint: '请确认对方发送的包是否完整，或重新导出一次。',
    severity: 'error', action: 'dismiss',
    dev: '格式版本不匹配 / manifest 缺失 / zip 结构异常。',
  },
  PACKAGE_CHECKSUM_MISMATCH: {
    title: '包内文件校验不通过',
    detail: '有「{count}」个文件内容不一致，已跳过。',
    hint: '其余文件已正常导入，可用条目见回收报告。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
    dev: '逐文件 sha256 比对；不匹配则跳过并列报告，绝不整体失败。',
  },
  PACKAGE_VERSION_TOO_NEW: {
    title: '这个包来自更新版本的应用',
    detail: '包的格式版本为「{version}」，当前应用无法读取。',
    hint: '请升级应用后重试。',
    severity: 'error', action: 'reload',
    params: ['version'],
  },
  PACKAGE_MERGE_PARTIAL: {
    title: '回收完成，但有部分内容未归位',
    detail: '已归位「{ok}」行，缺漏「{missing}」行，无法识别「{unknown}」项。',
    hint: '可在回收报告中查看明细，并让对方补录缺失部分。',
    severity: 'warning', action: 'dismiss',
    params: ['ok', 'missing', 'unknown'],
  },
  PACKAGE_LINES_CHANGED: {
    title: '画本已变更，任务包内容不一致',
    detail: '与下发时有「{count}」处差异。',
    hint: '已按行归位，无法对应的部分放入待处理列表。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
    dev: 'lines_hash 不一致。提供"仅重发变更行"的增量导出。',
  },
  PACKAGE_TASK_READONLY: {
    title: '任务模式下画本为只读',
    detail: '为保证与导演侧一致，这里不能修改台词与角色。',
    hint: '如需反馈问题，请使用行上的「标记文本有问题」。',
    severity: 'info', action: 'dismiss',
  },
  VOICE_ACTOR_UNBOUND: {
    title: '还有角色没有分配配音员',
    detail: '共「{count}」个角色未绑定。',
    hint: '分配后即可导出任务包分工录制。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
  },

  // --- 6xxx AI / 模型 / 识别 ----------------------------------------------
  PROVIDER_UNAVAILABLE: {
    title: 'AI 服务暂时不可用',
    detail: '已自动降级为本地规则处理，功能仍可继续使用。',
    hint: '可在设置中检查服务地址与密钥。',
    // 不声明 retryable：这类失败多因配置或鉴权，未修配置前重试是噪音；
    // 主按钮给「前往设置」，修好后再继续操作即可。
    severity: 'info', action: 'open_settings',
    dev: '网络不可达/鉴权失败/5xx。降级必须留下可见提示，不要静默。',
  },
  PROVIDER_TIMEOUT: {
    title: 'AI 服务响应超时',
    detail: '已重试仍无响应，本次请求已跳过。',
    hint: '可稍后重试，或改用本地处理。',
    severity: 'warning', action: 'retry', retryable: true,
    dev: '连接 10 s / 首字节 60 s（流式空闲 30 s）。',
  },
  PROVIDER_CIRCUIT_OPEN: {
    title: 'AI 服务连续失败，已暂停调用',
    detail: '将在「{minutes}」分钟后自动恢复。',
    hint: '期间会使用本地处理方式。',
    severity: 'info', action: 'open_settings',
    params: ['minutes'],
    dev: '连续 5 次失败熔断 5 分钟。熔断状态必须在设置页可见（不要静默降级）。',
  },
  PROVIDER_CLOUD_DISABLED: {
    title: '已按隐私设置阻止外发',
    detail: '当前不允许把作品内容发送到外部服务。',
    hint: '如确认需要，可在设置的隐私选项中开启。',
    severity: 'info', action: 'open_settings',
    dev: 'allowSendTextToCloud=false 时由 Provider 层直接拒绝，不发任何网络请求。',
  },
  PROVIDER_ABORTED: {
    title: 'AI 请求已取消',
    severity: 'info', action: 'none',
  },
  MODEL_MISSING: {
    title: '缺少必需的功能模型',
    detail: '未找到「{model}」的模型文件。',
    hint: '请在设置中查看模型目录并放置对应的模型文件。',
    severity: 'error', action: 'open_settings',
    params: ['model'],
    dev: '资源路径解析：开发读 resources/models，打包读 process.resourcesPath/models。',
  },
  MODEL_CHECKSUM_MISMATCH: {
    title: '模型文件已损坏',
    detail: '「{model}」的内容与预期不符。',
    hint: '请重新拷贝一份完整的模型文件。',
    severity: 'error', action: 'open_folder',
    params: ['model'],
    dev: 'SHA-256 与 models.json 登记值不一致（多为下载中断）。',
  },
  MODEL_LOAD_FAILED: {
    title: '模型加载失败',
    detail: '「{model}」无法初始化。',
    hint: '可先重试；仍失败请前往设置导出诊断包。',
    severity: 'error', action: 'retry', retryable: true,
    params: ['model'],
    dev: 'ONNX 会话创建失败 / 输入张量名不匹配 / int64 类型错误（需 BigInt64Array）。',
  },
  MODEL_OOM: {
    title: '内存不足，处理已中断',
    detail: '已自动降低批处理大小后重试。',
    hint: '如仍失败，请关闭其他占用内存的程序。',
    severity: 'warning', action: 'retry', retryable: true,
    dev: 'batch 从 16 逐级降到 8/4/1。必须能优雅降级，不能崩。',
  },
  ATTRIBUTION_LOW_ACCURACY: {
    title: '本章的自动判定质量偏低',
    detail: '该章缺少明确的对话提示词，判定依据不足。',
    hint: '建议人工校对一遍本章。',
    severity: 'warning', action: 'dismiss',
    dev: '引导语极少或对话密度异常时触发，用于提示用户不要盲信自动结果。',
  },
  AI_INVALID_OUTPUT: {
    title: 'AI 返回内容格式异常',
    detail: '已自动修复「{attempts}」次仍未通过校验，本批已跳过。',
    hint: '不影响其他内容，可稍后重试。',
    severity: 'warning', action: 'retry', retryable: true,
    params: ['attempts'],
    dev: '三层防护：提示约束 -> 解析容错（去代码围栏/尾随逗号）-> Zod + ID 存在性校验。',
  },
  ASR_FAILED: {
    title: '语音识别失败',
    detail: '「{reason}」',
    severity: 'warning', action: 'retry', retryable: true,
    params: ['reason'],
  },
  TTS_FAILED: {
    title: '语音合成失败',
    severity: 'warning', action: 'retry', retryable: true,
  },
  AI_FORCED_ALIGN_UNAVAILABLE: {
    title: '智能对轨校验尚未提供',
    detail: '该功能将在后续版本中加入。',
    severity: 'info', action: 'dismiss',
    dev: '接口占位，见 docs/13 §8。',
  },
  PROVIDER_NETWORK_ERROR: {
    title: '网络连接中断',
    detail: '与 AI 服务的连接被中断，本次请求未完成。',
    hint: '请检查网络后重试，或改用本地处理方式。',
    severity: 'warning', action: 'retry', retryable: true,
    dev: 'ECONNRESET / EPIPE / socket hang up。这是网络故障而非用户取消，绝不能映射到 PROVIDER_ABORTED，否则会被 error-bus 当「取消」静默吞掉，用户永远不会知道请求失败了。',
  },

  // --- 7xxx 数据 / 项目包 / 文件系统 --------------------------------------
  DB_BUSY: {
    title: '数据繁忙，请稍后重试',
    detail: '有一个后台任务正在写入数据。',
    severity: 'warning', action: 'retry', retryable: true,
    dev: 'SQLITE_BUSY / SQLITE_LOCKED，busy_timeout 5 s 后报出。',
  },
  DB_CORRUPT: {
    title: '数据库已损坏',
    detail: '为避免继续损坏，写入已被暂停。',
    hint: '请立即从备份恢复，或导出诊断包反馈。',
    severity: 'fatal', action: 'contact_support',
    dev: 'integrity_check 失败或 SQLITE_CORRUPT。进入只读模式，禁止一切写入。',
  },
  DB_MIGRATION_FAILED: {
    title: '数据升级失败',
    detail: '升级到第「{version}」版时出错，已回滚到原状态。',
    hint: '请从备份恢复，或导出诊断包反馈。',
    severity: 'fatal', action: 'contact_support',
    params: ['version'],
    dev: '迁移在单事务内，失败即回滚；已自动做迁移前备份，引导用户恢复。',
  },
  DB_BACKUP_FAILED: {
    title: '数据库备份失败',
    detail: '「{reason}」',
    hint: '请检查备份目录的空间与权限，然后再试一次。',
    // 不声明 retryable：需先处理磁盘/权限问题。
    severity: 'warning', action: 'open_folder',
    params: ['reason'],
  },
  DB_RESTORE_FAILED: {
    title: '从备份恢复失败',
    detail: '备份文件可能不完整。',
    hint: '当前数据未被改动，可换一个备份文件重试。',
    severity: 'error', action: 'dismiss',
    dev: '恢复前必须先删除同名 -wal / -shm，否则会与旧 WAL 混合导致损坏。',
  },
  PROJECT_ID_CONFLICT: {
    title: '项目标识冲突',
    detail: '已存在相同的项目标识，导入时会自动重新映射。',
    severity: 'info', action: 'dismiss',
    dev: '内部 ID 默认保留（任务包回传依赖它），冲突时整体重映射并记录 id_map.json。',
  },
  PATH_ESCAPE_BLOCKED: {
    title: '路径访问被拒绝',
    detail: '请求的路径超出了项目目录范围。',
    severity: 'error', action: 'dismiss',
    dev: '防护命中。检查是否被注入或存在 bug 拼出了 .. 逃逸。',
  },
  TEMP_CLEANUP_PARTIAL: {
    title: '部分临时文件未能清理',
    detail: '有「{count}」个文件被占用。',
    hint: '它们会在下次启动时再次尝试清理。',
    severity: 'info', action: 'dismiss',
    params: ['count'],
  },
  AUDIO_FILE_MISSING: {
    title: '音频文件已丢失',
    detail: '找不到对应的录音文件，可能被移动或删除了。',
    hint: '可重新录制该行，或重新定位文件。',
    severity: 'error', action: 'dismiss',
    dev: '启动抽样校验命中。标记 file_missing，不要静默跳过。',
  },
  // ── 以下两条**追加在 7 段末尾**（编号纪律：只追加，绝不中间插入）──
  // 为什么必须存在：这两个键曾被使用却没登记，`getMessage` 会静默回退到 INTERNAL，
  // 于是「数据库为什么打不开」这个关键信息在日志里彻底消失，只剩一句
  // 「发生了未预期的错误」—— 排查成本极高（见 docs/91 §5.4）。
  DB_OPEN_FAILED: {
    title: '无法打开数据库',
    detail: '数据文件打不开，应用可能无法保存任何改动。',
    hint: '请导出诊断包反馈。若刚安装过依赖，请先运行 npm run rebuild 重建数据库驱动。',
    severity: 'fatal', action: 'contact_support',
    dev:
      '两类原因：(1) better-sqlite3 原生模块缺失或 ABI 不匹配 —— 未跑 electron-rebuild 时，' +
      'Node 版 .node 无法被 Electron 加载（报 NODE_MODULE_VERSION 不一致）；' +
      '(2) 数据库文件不可访问/损坏（权限、路径、磁盘）。details.reason 区分二者。',
  },
  DB_NOT_OPEN: {
    title: '数据库尚未打开',
    detail: '启动时数据库没有打开成功，因此这项操作暂时不可用。',
    hint: '重启应用；若仍失败，请从备份恢复或导出诊断包。',
    severity: 'error', action: 'dismiss',
    dev: '启动流程在 open-database 步骤失败（或进了只读模式）后，DbPort 的写类操作会走到这里。',
  },
  DB_SCHEMA_INCOMPLETE: {
    title: '数据表不完整',
    detail: '数据库里缺少「{table}」这张表，说明建表步骤没有完成。',
    hint: '请重启应用；若表依然缺失，说明安装不完整，请重新安装或导出诊断包反馈。',
    severity: 'fatal', action: 'contact_support',
    params: ['table'],
    dev:
      'SQLite 原始错误是 SQLITE_ERROR: no such table —— 注意它的 code 是 **SQLITE_ERROR**（通用错误），' +
      '而不是 SYSTEM_ERRNO_MAP 里能映射的 SQLITE_BUSY/CORRUPT/READONLY。' +
      '因此不显式包装就会被 wrapUnknown 兜底成 INTERNAL，UI 上只显示错误编号「-」，' +
      '用户完全看不出「表没建」这件事。' +
      '真实成因：迁移 SQL 未随产物提供（.sql 没被复制到 out 目录）→ 迁移整体失败 → 应用进只读模式，' +
      '而 createSettingsStore 自己建了 settings 表，于是库里恰好只有这一张表。',
  },

  // --- 8xxx 任务队列 ------------------------------------------------------
  TASK_FAILED: {
    title: '后台任务执行失败',
    detail: '任务「{name}」未能完成。',
    hint: '可重试；若反复失败请导出诊断包。',
    severity: 'error', action: 'retry', retryable: true,
    params: ['name'],
  },
  TASK_INTERRUPTED: {
    title: '有任务被意外中断',
    detail: '共「{count}」个任务未完成（应用上次异常退出）。',
    hint: '可以重试这些任务，已完成的成果不会重做。',
    severity: 'warning', action: 'retry',
    params: ['count'],
    dev: '启动时把 running/waiting 标记为 interrupted。',
  },
  TASK_QUEUE_FULL: {
    title: '等待中的任务过多',
    detail: '当前有「{count}」个任务在排队。',
    hint: '请等待已有任务完成后再提交。',
    severity: 'warning', action: 'dismiss',
    params: ['count'],
  },
  /**
   * 队列端口没有注入（启动期装配缺项 / 无库的降级路径）。
   *
   * 为什么单独一条而不是复用 `TASK_FAILED`：这类失败**不是任务失败**（任务根本没入队），
   * 用户的下一步动作也不同（重试没用，要看装配/启动日志）。
   * 之前 `canvas.tasks` / 导入域已经用这个 key 抛错，但它不在消息表里 →
   * 用户看到的是「内部错误」，把「环境问题」伪装成了「程序 bug」（docs/91 §5.2.20 记了这一条）。
   */
  TASK_QUEUE_UNAVAILABLE: {
    title: '后台任务队列不可用',
    detail: '当前无法提交后台任务，本次操作没有执行。',
    hint: '请重启应用；若持续出现，请导出诊断包（启动日志里会有装配失败的原因）。',
    severity: 'error', action: 'dismiss',
    dev: 'HandlerDeps 里没有 TaskQueue：多为启动期装配缺项，或运行在无库/测试的降级路径。',
  },
  TASK_NOT_FOUND: {
    title: '任务不存在或已结束',
    severity: 'info', action: 'dismiss',
  },

  // --- 9xxx 应用 / 窗口 / 更新 --------------------------------------------
  APP_SINGLE_INSTANCE: {
    title: '应用已在运行',
    detail: '已为你切换到正在运行的窗口。',
    severity: 'info', action: 'none',
    dev: 'second-instance 事件，聚焦已有窗口即可，不需要提示。',
  },
  APP_SECURE_STORAGE_UNAVAILABLE: {
    title: '系统不支持安全保存密钥',
    detail: '当前环境无法加密存储敏感信息。',
    hint: '可改用本地模型，或在不保存密钥的情况下临时填写。',
    severity: 'warning', action: 'dismiss',
    dev: 'safeStorage.isEncryptionAvailable() 为 false（部分 Linux）。',
  },
  APP_SECRET_DECRYPT_FAILED: {
    title: '保存的密钥无法读取',
    detail: '可能更换了系统账户或迁移了机器。',
    hint: '请重新填写一次密钥。',
    severity: 'warning', action: 'open_settings',
    dev: '解密失败时清除该值，不要崩溃。',
  },
  APP_CONFIG_INVALID: {
    title: '设置文件内容异常',
    detail: '无效的项已恢复为默认值。',
    hint: '请检查设置是否符合预期。',
    severity: 'warning', action: 'open_settings',
  },
  APP_UPDATE_AVAILABLE: {
    title: '发现新版本',
    detail: '版本「{version}」已可下载。',
    severity: 'info', action: 'dismiss',
    params: ['version'],
  },
  APP_BEFORE_QUIT_BLOCKED: {
    title: '有未完成的操作',
    detail: '正在录音或有任务在运行。',
    hint: '请先停止录音或等待任务完成，再次退出。',
    severity: 'warning', action: 'dismiss',
    dev: '录音中必须拦截窗口关闭，改为"先停止并保存，再关闭"。',
  },
  APP_DIAGNOSTICS_EXPORTED: {
    title: '诊断包已导出',
    detail: '已保存到「{dir}」。',
    hint: '内容不含作品正文与密钥，可放心发送给支持人员。',
    severity: 'info', action: 'open_folder',
    params: ['dir'],
  },

  // --- 0xxx 框架内部 / 兜底 ----------------------------------------------
  UI_RENDER_ERROR: {
    title: '页面显示出现异常',
    detail: '已切换到一个安全视图，你的数据没有受到影响。',
    hint: '可刷新页面恢复；若反复出现请导出诊断包。',
    severity: 'error', action: 'reload',
    dev: 'Vue app.config.errorHandler 或错误边界捕获。定位到具体组件（记录 component 名）。',
  },
  UI_UNHANDLED_PROMISE: {
    title: '有一个操作未正常完成',
    detail: '错误编号：「{code}」',
    hint: '可重试该操作；若反复出现请导出诊断包。',
    severity: 'warning', action: 'contact_support',
    params: ['code'],
    dev: 'window unhandledrejection。多数是漏 await 或忘记 try/catch 的 IPC 调用。',
  },
  MAIN_UNCAUGHT_EXCEPTION: {
    title: '程序遇到内部错误',
    detail: '错误编号：「{code}」',
    hint: '请导出诊断包并附上编号反馈；已保存的工作不会丢失。',
    severity: 'fatal', action: 'contact_support',
    params: ['code'],
    dev: 'process uncaughtException。先尝试优雅收尾（保存录音）再退出。',
  },
  MAIN_UNHANDLED_REJECTION: {
    title: '程序有一个后台操作异常',
    severity: 'warning', action: 'contact_support',
    dev: 'process unhandledRejection。通常是漏 catch 的异步链路。',
  },
} as const satisfies Record<string, ErrorMessage>

/** 语义键联合类型（代码里的自动补全来源） */
export type MessageKey = keyof typeof MESSAGES

/** 消息表类型（供脚本与测试遍历） */
export type MessageCatalog = Record<MessageKey, ErrorMessage>

/** 段名（'GENERIC' | 'RECORD' | ...） */
export type SegmentLabel = string

// ============================================================================
// 段号与数字编号派生
// ============================================================================

/** 段号：数字编号的第一位。语义键 -> 段的映射在此集中定义。 */
const SEGMENTS: ReadonlyArray<{ segment: number; label: string; keys: readonly MessageKey[] }> = [
  {
    segment: 1, label: 'GENERIC',
    keys: ['INVALID_PAYLOAD', 'NOT_FOUND', 'CONFLICT', 'PERMISSION_DENIED', 'DISK_FULL',
           'FILE_NOT_FOUND', 'FILE_BUSY', 'NOT_IMPLEMENTED', 'TASK_CANCELLED',
           'UNSUPPORTED_FORMAT', 'INTERNAL'],
  },
  {
    segment: 2, label: 'RECORD',
    keys: ['DEVICE_UNAVAILABLE', 'DEVICE_PERMISSION', 'DEVICE_LOST', 'RECORD_WRITE_BACKPRESSURE',
           'RECORD_NO_SIGNAL', 'RECORD_TOO_SHORT', 'RECORD_CLIPPING', 'RECORD_SESSION_RECOVERED',
           'RECORD_SESSION_UNRECOVERABLE', 'RECORD_MONITOR_FEEDBACK', 'VAD_NO_SPEECH_FOUND',
           'TAKE_SRC_MISSING', 'TAKE_NONE_SELECTED', 'TRIM_FAILED', 'PUNCHIN_OVERLAP_INVALID',
           'PROCESS_CHAIN_EMPTY', 'PROCESS_PRESET_INVALID', 'PROCESS_ABORTED', 'DECLICK_FAILED',
           // ⚠️ 新增消息**只能在段末追加**（否则历史错误编号会漂移，见本文件头部纪律）
           'FILTER_UNSUPPORTED', 'RECORD_CAPTURE_UNAVAILABLE'],
  },
  {
    segment: 3, label: 'BOOK',
    keys: ['FILE_TOO_LARGE', 'ENCODING_UNCERTAIN', 'ENCODING_DECODE_FAILED', 'PDF_NO_TEXT_LAYER',
           'PDF_ENCRYPTED', 'PDF_PARSE_LOW_QUALITY', 'DOCX_CORRUPT', 'NO_CHAPTER_MATCHED',
           'CHAPTER_SPLIT_SUSPICIOUS', 'FETCH_FAILED', 'FETCH_BLOCKED', 'FETCH_FORBIDDEN_TARGET',
           'FETCH_TOO_MANY_PAGES', 'DUPLICATE_BOOK', 'IMPORT_CLEAN_REMOVED_CONTENT',
           'RULE_PATTERN_INVALID', 'RULE_PATTERN_UNSAFE',
           // ⚠️ 新增消息**只能在段末追加**（否则历史错误编号会漂移，见本文件头部纪律）
           'CHAPTER_HAS_CANVAS_LINES'],
  },
  {
    segment: 4, label: 'EXPORT',
    keys: ['EXPORT_QCPRECHECK_FAILED', 'EXPORT_MISSING_LINES', 'EXPORT_FFMPEG_FAILED',
           'EXPORT_LOUDNESS_OUT_OF_RANGE', 'EXPORT_TRUE_PEAK_EXCEEDED', 'EXPORT_SILENT_CHAPTER',
           'EXPORT_M4B_FAILED', 'EXPORT_M4B_TOO_MANY_CHAPTERS', 'EXPORT_FILE_LOCKED',
           'EXPORT_OUTPUT_NOT_WRITABLE', 'EXPORT_INTERRUPTED', 'MIX_ARRANGEMENT_EMPTY',
           'MIX_NO_VOICE_TRACK', 'MIX_DUCKING_SIDECHAIN_MISSING', 'MIX_TARGET_CONFLICT',
           'EXPORT_METADATA_WRITE_FAILED', 'EXPORT_PARTIAL_SUCCESS', 'EXPORT_M4B_VERIFY_FAILED'],
  },
  {
    segment: 5, label: 'CANVAS',
    keys: ['CANVAS_CHAPTER_EMPTY', 'CANVAS_ALREADY_EDITED', 'CANVAS_EMBEDDING_UNAVAILABLE',
           'CANVAS_LLM_UNAVAILABLE', 'CANVAS_GENERATE_PARTIAL', 'CANVAS_ATTRIBUTION_LOW_CONFIDENCE',
           'CHARACTER_MERGE_CONFLICT', 'CHARACTER_ARCHIVED', 'ATTRIBUTION_RECOMPUTE_REQUIRED',
           'PACKAGE_EXPORT_FAILED', 'PACKAGE_INVALID', 'PACKAGE_CHECKSUM_MISMATCH',
           'PACKAGE_VERSION_TOO_NEW', 'PACKAGE_MERGE_PARTIAL', 'PACKAGE_LINES_CHANGED',
           'PACKAGE_TASK_READONLY', 'VOICE_ACTOR_UNBOUND'],
  },
  {
    segment: 6, label: 'AI',
    keys: ['PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_CIRCUIT_OPEN',
           'PROVIDER_CLOUD_DISABLED', 'PROVIDER_ABORTED', 'MODEL_MISSING',
           'MODEL_CHECKSUM_MISMATCH', 'MODEL_LOAD_FAILED', 'MODEL_OOM', 'ATTRIBUTION_LOW_ACCURACY',
           'AI_INVALID_OUTPUT', 'ASR_FAILED', 'TTS_FAILED', 'AI_FORCED_ALIGN_UNAVAILABLE',
           'PROVIDER_NETWORK_ERROR'],
  },
  {
    segment: 7, label: 'DATA',
    keys: ['DB_BUSY', 'DB_CORRUPT', 'DB_MIGRATION_FAILED', 'DB_BACKUP_FAILED', 'DB_RESTORE_FAILED',
           'PROJECT_ID_CONFLICT', 'PATH_ESCAPE_BLOCKED', 'TEMP_CLEANUP_PARTIAL', 'AUDIO_FILE_MISSING',
           'DB_OPEN_FAILED', 'DB_NOT_OPEN', 'DB_SCHEMA_INCOMPLETE'],
  },
  {
    segment: 8, label: 'TASK',
    // 追加在段末尾（docs/91 的纪律：发布后只能在末尾追加，否则历史日志里的编号会指向别的错误）
    keys: ['TASK_FAILED', 'TASK_INTERRUPTED', 'TASK_QUEUE_FULL', 'TASK_NOT_FOUND', 'TASK_QUEUE_UNAVAILABLE'],
  },
  {
    segment: 9, label: 'APP',
    keys: ['APP_SINGLE_INSTANCE', 'APP_SECURE_STORAGE_UNAVAILABLE', 'APP_SECRET_DECRYPT_FAILED',
           'APP_CONFIG_INVALID', 'APP_UPDATE_AVAILABLE', 'APP_BEFORE_QUIT_BLOCKED',
           'APP_DIAGNOSTICS_EXPORTED'],
  },
  {
    segment: 0, label: 'INTERNAL',
    keys: ['UI_RENDER_ERROR', 'UI_UNHANDLED_PROMISE', 'MAIN_UNCAUGHT_EXCEPTION',
           'MAIN_UNHANDLED_REJECTION'],
  },
] as const

/** 语义键 -> 段内序号 */
const INDEX_BY_KEY: Map<MessageKey, number> = (() => {
  const m = new Map<MessageKey, number>()
  for (const seg of SEGMENTS) {
    seg.keys.forEach((k, i) => {
      if (m.has(k)) throw new Error(`[messages] 语义键重复登记于多个段：${k}`)
      m.set(k, i)
    })
  }
  return m
})()

/** 段元信息（供文档生成脚本使用）：段号、段名、该段键顺序 */
export interface SegmentInfo {
  segment: number
  label: string
  keys: readonly MessageKey[]
}

/** 只读的段定义，供 scripts/gen-error-docs.ts 与测试遍历 */
export const SEGMENT_INFO: readonly SegmentInfo[] = SEGMENTS

/** 语义键 -> 段号 */
const SEGMENT_BY_KEY: Map<MessageKey, number> = (() => {
  const m = new Map<MessageKey, number>()
  for (const seg of SEGMENTS) for (const k of seg.keys) m.set(k, seg.segment)
  return m
})()

/** 启动自检：SEGMENTS 必须与 MESSAGES 完全一致（漏登记 / 多登记都会在这里炸出来） */
export function assertCatalogIntegrity(): void {
  const declared = new Set<MessageKey>()
  for (const seg of SEGMENTS) for (const k of seg.keys) declared.add(k)

  const actual = new Set(Object.keys(MESSAGES) as MessageKey[])

  const missing = [...actual].filter(k => !declared.has(k))
  const extra = [...declared].filter(k => !actual.has(k))

  if (missing.length || extra.length) {
    throw new Error(
      `[messages] SEGMENTS 与 MESSAGES 不一致。\n` +
      `  未登记段号的消息（请加入对应段的末尾）：${missing.join(', ') || '无'}\n` +
      `  段号表里存在但消息表没有的键（请删除或补定义）：${extra.join(', ') || '无'}`
    )
  }
}

/**
 * 派生数字编号：段号 + 段内序号（4 位），共 5 位 -> 'E20005'
 *
 * 注意：编号由声明顺序决定。新增消息只能追加在段末，否则历史编号会漂移。
 */
export function resolveCode(key: MessageKey): string {
  const seg = SEGMENT_BY_KEY.get(key)
  const idx = INDEX_BY_KEY.get(key)
  if (seg === undefined || idx === undefined) {
    // 未知键：不抛错（避免错误处理本身出错），返回兜底编号
    return 'E000000'
  }
  return `E${seg}${String(idx).padStart(4, '0')}`
}

/** 段标签（日志与文档用） */
export function segmentLabel(key: MessageKey): string {
  const seg = SEGMENT_BY_KEY.get(key)
  return SEGMENTS.find(s => s.segment === seg)?.label ?? 'UNKNOWN'
}

// ============================================================================
// 取消息与插值
// ============================================================================

const PLACEHOLDER = /\{(\w+)\}/g

export type MessageParams = Record<string, string | number>

/** 安全插值：缺参数时退化为「-」而非把 {name} 原样漏给用户 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template.replace(PLACEHOLDER, '-')
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = params[name]
    return v === undefined || v === null || v === '' ? '-' : String(v)
  })
}

export interface ResolvedMessage {
  key: MessageKey
  code: string           // 'E200005'
  segment: string        // 'RECORD'
  title: string
  detail?: string
  hint?: string
  severity: Severity
  action: ErrorAction
  retryable: boolean
  /** 供日志与诊断包使用，永不进 UI */
  dev?: string
}

/**
 * 取出一条可直接渲染的消息（已完成插值）。
 * 未登记的键不会抛错——错误处理路径本身必须永不失败。
 */
export function getMessage(key: string, params?: MessageParams): ResolvedMessage {
  const known = (key in MESSAGES) as boolean
  if (!known) {
    return {
      key: 'INTERNAL',
      code: resolveCode('INTERNAL'),
      segment: 'INTERNAL',
      title: MESSAGES.INTERNAL.title,
      detail: interpolate(MESSAGES.INTERNAL.detail, { code: resolveCode('INTERNAL') }),
      hint: MESSAGES.INTERNAL.hint,
      severity: MESSAGES.INTERNAL.severity,
      action: MESSAGES.INTERNAL.action,
      retryable: true,
      dev: `未登记的语义键 "${key}"，已回退到 INTERNAL。请在 messages.ts 中补定义。`,
    }
  }

  const k = key as MessageKey
  const msg: ErrorMessage = MESSAGES[k]
  return {
    key: k,
    code: resolveCode(k),
    segment: segmentLabel(k),
    title: interpolate(msg.title, params),
    ...(msg.detail ? { detail: interpolate(msg.detail, params) } : {}),
    ...(msg.hint ? { hint: interpolate(msg.hint, params) } : {}),
    severity: msg.severity,
    action: msg.action,
    retryable: msg.retryable ?? false,
    ...(msg.dev ? { dev: msg.dev } : {}),
  }
}

// ============================================================================
// 供测试与文档生成使用
// ============================================================================

/** 全部错误码（按编号排序）。快照测试用它防止编号漂移。 */
export function listAllCodes(): Array<{ key: MessageKey; code: string; segment: string; severity: Severity }> {
  return (Object.keys(MESSAGES) as MessageKey[])
    .map(key => ({ key, code: resolveCode(key), segment: segmentLabel(key), severity: MESSAGES[key].severity }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** 校验所有消息的占位符声明与文案一致（单测与文档生成脚本用） */
export function validatePlaceholders(): string[] {
  const problems: string[] = []
  for (const [key, msg] of Object.entries(MESSAGES) as Array<[MessageKey, ErrorMessage]>) {
    const used = new Set<string>()
    for (const field of [msg.title, msg.detail, msg.hint]) {
      if (!field) continue
      for (const m of field.matchAll(PLACEHOLDER)) used.add(m[1])
    }
    const declared = new Set(msg.params ?? [])
    for (const u of used) {
      if (!declared.has(u)) problems.push(`${key}: 文案使用了 {${u}} 但 params 未声明`)
    }
    for (const d of declared) {
      if (!used.has(d)) problems.push(`${key}: params 声明了 ${d} 但文案未使用`)
    }
  }
  return problems
}
