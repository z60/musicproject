/**
 * Novel Studio · 逐字单调对齐（识别文本 ↔ 画本行）
 * ============================================================================
 * 真机需求：「需要音频转文字 记录每段文字的位置后分割」。
 * 上一层（`asr-align.ts`）拿到的是「每段识别文字的起止」，但**段 ↔ 行不是一对一**：
 *
 *   · 识别引擎常把**一行**切成两段（长句尤其明显）→ 只认一段就会丢掉半句音频；
 *   · 也常把**两行**并成一段（短句连读）→ 两行只能共用一段的时间。
 *
 * 只按「段」配对，这两种情况必有一边出错（真机症状：2221 章「如果是的话，这也太打脸了！」
 * 整段没有音频 —— 那一行的文本横跨两个识别段，而它只被配到了后一段）。
 * 本模块改成**按字**对齐：把识别结果摊成一条「字符 + 时刻」的流
 * （whisper 的 token 时间戳越细越好），与画本行拼成的字符流做**单调**比对，
 * 于是每行的首字/末字落在哪一毫秒是算出来的，而不是猜出来的。
 *
 * ## 算法：全局单调比对（Gotoh，仿射空位罚分，O(字数²) 的动态规划）
 *   先把两边都摊成字符流，再求「得分最高、顺序不变」的比对：
 *     命中 +3 ／ 两个不同的字碰上 -1 ／ **开一段空位** -6 ／ 空位再延长一个字 -1
 *
 *   命中与错配好理解；**仿射空位**（开空位贵、延长便宜）是关键的一笔：
 *   它让「一整行在音频里没念」表达成 **一段长空位**（花 -6-(L-1)），
 *   比「把它拆成两段短空位去蹭下一行的字」更划算。
 *   没有这一项时会出现「上一行偷走了下一行的字」——真机 2221 章 24 行里
 *   「石志坚继续道：」这种没念的行会把后面几行一起带偏。
 *
 *   真正被比对上的字带着自己的毫秒时刻，每行的首字/末字位置因此是**全局最优**的结果。
 *
 * 「顺序不变」是硬约束：它保证每行区间天然按顺序、不重叠 —— 正是导入切音频要的形态
 * （`asr-align.ts` 的三条不变量）。
 *
 * 为什么不用贪心：真机实测（2221 章旁白 24 行 / 749 个 token）贪心在
 * 「画本有、音频里没念」的那一行会把两边的游标一起推着走，之后整片错位 ——
 * 24 行里只有 13 行对得上。换成全局比对后错位会被「跳过」吸收。
 *
 * ## 为什么还要折繁体
 * whisper 的 `zh` 输出大量是**繁体**（真机实测：「承认失败」→「承認失敗」），
 * 而画本是简体。不折叠时平均相似度只有 0.53 —— 一半的差异其实只是字形不同。
 * 这里比对前先做一次繁→简折叠（表只收常见的**确定**对应）；缺字只是少一点宽容度。
 *
 * 本目录禁止引入任何第三方依赖。
 */

import { normalizeForCompare } from './text-match.ts'

/** 一段带时间的文本：whisper 的 token，或整段识别结果（token 更细） */
export interface TimedText {
  text: string
  startMs: number
  endMs: number
}

export interface CharAlignLineInput {
  lineId: string
  text: string
}

/** 一行的字级对齐结果 */
export interface CharAlignLineSpan {
  lineId: string
  /** 这一行第一个命中的字所在单位的下标（null = 一个字都没对上） */
  firstUnit: number | null
  /** 这一行最后一个命中的字所在单位的下标 */
  lastUnit: number | null
  /**
   * 该行区间的天然右界：**最后一个命中单位的下一个单位的起点**（null = 已是最后一个单位）。
   * 用它当边界，既不会切掉本行的尾音，也不会吃掉下一行的开头。
   */
  endHintMs: number | null
  /** 第一个/最后一个命中的字的时刻 */
  firstMs: number | null
  lastMs: number | null
  matchedChars: number
  totalChars: number
  /** 命中率 0~1（这一行有多少字在识别结果里找到了） */
  coverage: number
}

export interface CharAlignResult {
  spans: CharAlignLineSpan[]
  /** 全行合计的命中率 0~1（判断「这次识别到底是不是这段画本」的总指标） */
  matchRatio: number
  /** 一个字都没被认领的单位下标（识别噪声，或画本里缺这句） */
  unmatchedUnits: number[]
  warnings: string[]
}

/**
 * 繁 → 简 折叠表（**只收对得上、且常见的字**）。
 *
 * 取舍：宁可少收，也不要收错 —— 一个错映射会把两个无关的字判成相同，
 * 这种错误在对齐里比「没折叠」更难发现。缺字时两边就是不同字符，与折叠前一致。
 * （有意不收的歧义字：乾/著/藉/傑 之外的 面 等 —— 它们在简繁两边同形。）
 */
const VARIANT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['這', '这'], ['對', '对'], ['當', '当'], ['眾', '众'], ['認', '认'], ['識', '识'],
  ['別', '别'], ['裡', '里'], ['個', '个'], ['們', '们'], ['來', '来'], ['說', '说'],
  ['話', '话'], ['時', '时'], ['間', '间'], ['見', '见'], ['過', '过'], ['還', '还'],
  ['進', '进'], ['遠', '远'], ['邊', '边'], ['頭', '头'], ['長', '长'], ['門', '门'],
  ['問', '问'], ['開', '开'], ['關', '关'], ['東', '东'], ['車', '车'], ['馬', '马'],
  ['點', '点'], ['熱', '热'], ['無', '无'], ['為', '为'], ['從', '从'], ['後', '后'],
  ['學', '学'], ['覺', '觉'], ['經', '经'], ['給', '给'], ['種', '种'], ['樣', '样'],
  ['麼', '么'], ['幾', '几'], ['動', '动'], ['務', '务'], ['員', '员'], ['現', '现'],
  ['場', '场'], ['產', '产'], ['業', '业'], ['會', '会'], ['議', '议'], ['記', '记'],
  ['讓', '让'], ['請', '请'], ['誰', '谁'], ['語', '语'], ['讀', '读'], ['寫', '写'],
  ['聽', '听'], ['買', '买'], ['賣', '卖'], ['貴', '贵'], ['費', '费'], ['資', '资'],
  ['質', '质'], ['賽', '赛'], ['轉', '转'], ['較', '较'], ['輕', '轻'], ['運', '运'],
  ['達', '达'], ['適', '适'], ['選', '选'], ['鄉', '乡'], ['醫', '医'], ['釋', '释'],
  ['銀', '银'], ['錢', '钱'], ['錯', '错'], ['鐘', '钟'], ['鐵', '铁'], ['銅', '铜'],
  ['鋼', '钢'], ['錄', '录'], ['鏡', '镜'], ['際', '际'], ['隊', '队'], ['險', '险'],
  ['隨', '随'], ['難', '难'], ['雲', '云'], ['電', '电'], ['靈', '灵'], ['靜', '静'],
  ['頂', '顶'], ['順', '顺'], ['預', '预'], ['領', '领'], ['題', '题'], ['顏', '颜'],
  ['願', '愿'], ['類', '类'], ['風', '风'], ['飛', '飞'], ['飯', '饭'], ['館', '馆'],
  ['驚', '惊'], ['體', '体'], ['髮', '发'], ['鬥', '斗'], ['鬧', '闹'], ['魚', '鱼'],
  ['麗', '丽'], ['黃', '黄'], ['齊', '齐'], ['龍', '龙'], ['龜', '龟'], ['萬', '万'],
  ['與', '与'], ['書', '书'], ['機', '机'], ['權', '权'], ['歡', '欢'], ['歲', '岁'],
  ['殺', '杀'], ['氣', '气'], ['漢', '汉'], ['濟', '济'], ['營', '营'], ['爾', '尔'],
  ['牆', '墙'], ['獨', '独'], ['獎', '奖'], ['環', '环'], ['畢', '毕'], ['異', '异'],
  ['盡', '尽'], ['監', '监'], ['盤', '盘'], ['確', '确'], ['礙', '碍'], ['禮', '礼'],
  ['禍', '祸'], ['積', '积'], ['稱', '称'], ['穩', '稳'], ['窮', '穷'], ['竊', '窃'],
  ['競', '竞'], ['節', '节'], ['範', '范'], ['築', '筑'], ['簡', '简'], ['簽', '签'],
  ['紀', '纪'], ['紙', '纸'], ['級', '级'], ['紛', '纷'], ['縣', '县'], ['總', '总'],
  ['織', '织'], ['繼', '继'], ['續', '续'], ['罷', '罢'], ['罰', '罚'], ['羅', '罗'],
  ['聖', '圣'], ['聞', '闻'], ['聯', '联'], ['聰', '聪'], ['聲', '声'], ['職', '职'],
  ['腳', '脚'], ['臉', '脸'], ['臨', '临'], ['舉', '举'], ['舊', '旧'], ['艱', '艰'],
  ['藝', '艺'], ['藥', '药'], ['蘇', '苏'], ['處', '处'], ['號', '号'], ['蟲', '虫'],
  ['衝', '冲'], ['補', '补'], ['裝', '装'], ['觀', '观'], ['規', '规'], ['覽', '览'],
  ['計', '计'], ['討', '讨'], ['訓', '训'], ['訊', '讯'], ['註', '注'], ['評', '评'],
  ['詞', '词'], ['試', '试'], ['詩', '诗'], ['詳', '详'], ['誌', '志'], ['誠', '诚'],
  ['誤', '误'], ['課', '课'], ['調', '调'], ['談', '谈'], ['論', '论'], ['諒', '谅'],
  ['諾', '诺'], ['謀', '谋'], ['講', '讲'], ['謝', '谢'], ['證', '证'], ['護', '护'],
  ['變', '变'], ['讚', '赞'], ['豐', '丰'], ['豬', '猪'], ['貝', '贝'], ['負', '负'],
  ['財', '财'], ['責', '责'], ['貨', '货'], ['貧', '贫'], ['貼', '贴'], ['貿', '贸'],
  ['賀', '贺'], ['貸', '贷'], ['賓', '宾'], ['賞', '赏'], ['賠', '赔'], ['賢', '贤'],
  ['賬', '账'], ['購', '购'], ['贈', '赠'], ['趕', '赶'], ['趙', '赵'], ['跡', '迹'],
  ['踐', '践'], ['軌', '轨'], ['軍', '军'], ['軟', '软'], ['載', '载'], ['輔', '辅'],
  ['輛', '辆'], ['輝', '辉'], ['輩', '辈'], ['輪', '轮'], ['輸', '输'], ['轟', '轰'],
  ['農', '农'], ['連', '连'], ['遲', '迟'], ['遺', '遗'], ['邏', '逻'], ['郵', '邮'],
  ['鄧', '邓'], ['鄭', '郑'], ['鄰', '邻'], ['醜', '丑'], ['釀', '酿'], ['針', '针'],
  ['釘', '钉'], ['鉛', '铅'], ['銷', '销'], ['鋒', '锋'], ['鋪', '铺'], ['錦', '锦'],
  ['鍋', '锅'], ['鍵', '键'], ['鎖', '锁'], ['鏈', '链'], ['鑄', '铸'], ['閉', '闭'],
  ['閒', '闲'], ['陽', '阳'], ['陰', '阴'], ['陣', '阵'], ['階', '阶'], ['隱', '隐'],
  ['雖', '虽'], ['雙', '双'], ['雜', '杂'], ['雞', '鸡'], ['離', '离'], ['霧', '雾'],
  ['項', '项'], ['須', '须'], ['頒', '颁'], ['頻', '频'], ['顆', '颗'], ['顧', '顾'],
  ['顯', '显'], ['飲', '饮'], ['飽', '饱'], ['飾', '饰'], ['餅', '饼'], ['養', '养'],
  ['駕', '驾'], ['駛', '驶'], ['騎', '骑'], ['驗', '验'], ['鮮', '鲜'], ['鳴', '鸣'],
  ['鴻', '鸿'], ['鵬', '鹏'], ['鷹', '鹰'], ['鹽', '盐'], ['麥', '麦'], ['黨', '党'],
  ['齒', '齿'], ['劍', '剑'], ['創', '创'], ['劇', '剧'], ['勝', '胜'], ['勞', '劳'],
  ['勢', '势'], ['勵', '励'], ['匯', '汇'], ['區', '区'], ['協', '协'], ['單', '单'],
  ['壓', '压'], ['壞', '坏'], ['夢', '梦'], ['奪', '夺'], ['媽', '妈'], ['孫', '孙'],
  ['寬', '宽'], ['寶', '宝'], ['導', '导'], ['屆', '届'], ['島', '岛'], ['帥', '帅'],
  ['師', '师'], ['帶', '带'], ['幫', '帮'], ['廢', '废'], ['廣', '广'], ['廳', '厅'],
  ['張', '张'], ['彈', '弹'], ['強', '强'], ['歸', '归'], ['徑', '径'], ['恆', '恒'],
  ['慶', '庆'], ['應', '应'], ['懷', '怀'], ['戲', '戏'], ['戶', '户'], ['執', '执'],
  ['擴', '扩'], ['據', '据'], ['擠', '挤'], ['擺', '摆'], ['斷', '断'], ['於', '于'],
  ['暢', '畅'], ['災', '灾'], ['煩', '烦'], ['爭', '争'], ['爺', '爷'], ['魯', '鲁'],
  ['亞', '亚'], ['僅', '仅'], ['僕', '仆'], ['傑', '杰'], ['內', '内'], ['兩', '两'],
  ['冊', '册'], ['凈', '净'], ['準', '准'], ['劃', '划'], ['則', '则'], ['剛', '刚'],
  ['勁', '劲'], ['賴', '赖'], ['餘', '余'], ['沒', '没'], ['鳥', '鸟'], ['頁', '页'],
  ['線', '线'], ['絕', '绝'], ['統', '统'], ['縮', '缩'], ['維', '维'], ['編', '编'],
  ['練', '练'], ['組', '组'], ['結', '结'], ['絲', '丝'], ['網', '网'], ['緊', '紧'],
  ['緣', '缘'], ['紅', '红'], ['純', '纯'], ['約', '约'], ['級', '级'], ['終', '终'],
  ['護', '护'], ['訂', '订'], ['許', '许'], ['訴', '诉'], ['設', '设'], ['訪', '访'],
  ['誕', '诞'], ['諷', '讽'], ['憶', '忆'], ['戀', '恋'], ['態', '态'], ['懇', '恳'],
  ['懼', '惧'], ['憂', '忧'], ['憤', '愤'], ['憐', '怜'], ['慣', '惯'], ['慘', '惨'],
  ['慮', '虑'], ['擁', '拥'], ['擔', '担'], ['掛', '挂'], ['揮', '挥'], ['損', '损'],
  ['換', '换'], ['揚', '扬'], ['掃', '扫'], ['搶', '抢'], ['撲', '扑'], ['擇', '择'],
  ['擊', '击'], ['淨', '净'], ['減', '减'], ['湊', '凑'], ['灣', '湾'], ['濕', '湿'],
  ['滿', '满'], ['漲', '涨'], ['漸', '渐'], ['潛', '潜'], ['滾', '滚'], ['濤', '涛'],
  ['瀉', '泻'], ['灘', '滩'], ['潤', '润'], ['澀', '涩'], ['濱', '滨'],
  ['敗', '败'], ['樂', '乐'], ['賺', '赚'], ['賤', '贱'], ['撿', '捡'], ['檢', '检'],
  ['瞞', '瞒'], ['矯', '矫'], ['碩', '硕'], ['禱', '祷'], ['竄', '窜'], ['筆', '笔'],
  ['筍', '笋'], ['篩', '筛'], ['籃', '篮'], ['糧', '粮'], ['粵', '粤'], ['紋', '纹'],
  ['納', '纳'], ['紗', '纱'], ['細', '细'], ['紡', '纺'], ['絞', '绞'], ['綁', '绑'],
  ['綠', '绿'], ['綱', '纲'], ['緒', '绪'], ['緩', '缓'], ['締', '缔'], ['績', '绩'],
  ['繞', '绕'], ['繡', '绣'], ['纏', '缠'], ['蘭', '兰'], ['蘿', '萝'], ['虧', '亏'],
  ['燦', '灿'], ['爛', '烂'], ['犧', '牺'], ['牽', '牵'], ['獄', '狱'], ['瘋', '疯'],
  ['癢', '痒'], ['瞇', '眯'], ['擾', '扰'], ['攏', '拢'], ['攬', '揽'], ['擬', '拟'],
  ['擋', '挡'], ['攜', '携'], ['攝', '摄'], ['攤', '摊'], ['攔', '拦'], ['撥', '拨'],
  ['撫', '抚'], ['撓', '挠'], ['擲', '掷'], ['躍', '跃'], ['爺', '爷'], ['爾', '尔'],
  ['牆', '墙'],
]

const VARIANT_MAP: Map<string, string> = new Map(VARIANT_PAIRS.map((p) => [p[0], p[1]]))

/** 把繁体字折成简体（未知字原样保留） */
export function foldVariants(text: string): string {
  let out = ''
  for (const ch of String(text ?? '')) out += VARIANT_MAP.get(ch) ?? ch
  return out
}

/** 比对用的字符数组：去标点、折繁体、按**码点**切开（中文都是 BMP，但别假设） */
function alignChars(text: string): string[] {
  return Array.from(foldVariants(normalizeForCompare(text)))
}

/**
 * 识别结果摊平成「字符 + 时刻」的流。
 *
 * 单位内的字平均摊在 `[startMs, endMs]` 上（取每字的**中心**时刻）——
 * whisper 的 token 一般只有 1~3 个字，摊出来的误差远小于 VAD 的停顿猜测。
 */
function buildAsrStream(units: readonly TimedText[]): AsrStream {
  const chars: string[] = []
  const unitOf: number[] = []
  const timeMs: number[] = []
  const unitStart: number[] = []
  units.forEach((u, ui) => {
    const start = Number.isFinite(u.startMs) ? Math.max(0, u.startMs) : 0
    const end = Number.isFinite(u.endMs) ? Math.max(start, u.endMs) : start
    unitStart.push(start)
    const cs = alignChars(u.text)
    const n = cs.length
    for (let k = 0; k < n; k++) {
      chars.push(cs[k]!)
      unitOf.push(ui)
      timeMs.push(n > 0 ? start + (end - start) * ((k + 0.5) / n) : start)
    }
  })
  return { chars, unitOf, timeMs, unitStart }
}

export interface CharAlignOptions {
  /**
   * 动态规划的上限（单元格数）。超过它就不再建表，退回「贪心 + 回看」——
   * 这条路只在超大文件（上万字）上才会发生，精度略低但不会吃掉内存。
   */
  maxDpCells?: number
}

/** 比对得分：命中 / 错配 / 开一段空位 / 空位延长一个字 */
const SCORE_MATCH = 3
const SCORE_MISMATCH = -1
const GAP_OPEN = -6
const GAP_EXTEND = -1
/** 不可达（表里用加法传播，所以要是「很负」而不是 Infinity） */
const NEG = -1_000_000

/** 默认的 DP 上限（单元格数，1 字节/格 ≈ 18 MB）。真实规模（几十~几百行）远低于它 */
const DEFAULT_MAX_DP_CELLS = 18_000_000

interface AsrStream {
  chars: string[]
  unitOf: number[]
  timeMs: number[]
  unitStart: number[]
}

interface RawMatch {
  /** 画本行下标 */
  lineIndex: number
  /** 识别流里的字符下标（用来取时刻与单位） */
  asrIndex: number
}

/**
 * 全局单调比对（Gotoh：命中/错配 + **仿射空位**）。
 *
 * 三个状态各一行滚动数组（M = 上一个字是命中/错配，X = 跳过一个识别字，Y = 跳过一个画本字），
 * 方向只存 **1 字节/格**（三个转移的前驱状态各占 2 bit），所以内存 ≈ 单元格数。
 * 只产出「两边都认下来的字」，剩下的（空位/错配）由调用方按命中率判断。
 */
function alignByDp(lineChars: string[], asrChars: string[], maxCells: number): RawMatch[] {
  const m = asrChars.length
  const n = lineChars.length
  if (m === 0 || n === 0) return []
  if ((m + 1) * (n + 1) > maxCells) return alignByGreedy(lineChars, asrChars)

  const width = n + 1
  /** 每格：bit0-1 = M 的前驱状态，bit2-3 = X 的前驱，bit4-5 = Y 的前驱 */
  const dir = new Uint8Array((m + 1) * width)

  let mPrev = new Int32Array(width)
  let xPrev = new Int32Array(width)
  let yPrev = new Int32Array(width)
  let mCur = new Int32Array(width)
  let xCur = new Int32Array(width)
  let yCur = new Int32Array(width)

  // 第 0 行：只有「一路跳过画本的字」可达
  mPrev[0] = 0
  xPrev[0] = NEG
  yPrev[0] = NEG
  for (let j = 1; j <= n; j++) {
    mPrev[j] = NEG
    xPrev[j] = NEG
    yPrev[j] = GAP_OPEN + (j - 1) * GAP_EXTEND
  }

  for (let i = 1; i <= m; i++) {
    mCur[0] = NEG
    // 第 0 列：只有「一路跳过识别的字」可达
    xCur[0] = GAP_OPEN + (i - 1) * GAP_EXTEND
    yCur[0] = NEG
    const ai = asrChars[i - 1]!
    for (let j = 1; j <= n; j++) {
      // ── M：上一个字两边各前进一个 ─────────────────────────────────────
      let bestM = mPrev[j - 1]!
      let sm = 0
      if (xPrev[j - 1]! > bestM) {
        bestM = xPrev[j - 1]!
        sm = 1
      }
      if (yPrev[j - 1]! > bestM) {
        bestM = yPrev[j - 1]!
        sm = 2
      }
      mCur[j] = bestM + (ai === lineChars[j - 1]! ? SCORE_MATCH : SCORE_MISMATCH)

      // ── X：跳过识别流里的这个字 ───────────────────────────────────────
      let bestX = mPrev[j]! + GAP_OPEN
      let sx = 0
      const xExtend = xPrev[j]! + GAP_EXTEND
      if (xExtend > bestX) {
        bestX = xExtend
        sx = 1
      }
      const xFromY = yPrev[j]! + GAP_OPEN
      if (xFromY > bestX) {
        bestX = xFromY
        sx = 2
      }
      xCur[j] = bestX

      // ── Y：跳过画本行里的这个字 ───────────────────────────────────────
      // ★ 这里存的是**前驱状态编号**（0=M／1=X／2=Y），不是「第几个候选」：
      //   「延长空位」的前驱是 Y(2)，「从 X 切过来」的前驱才是 X(1) ——
      //   写反了分数照样对，但回溯会走出一条错的路径（真机表现：整行明明对上了却报 0 命中）。
      let bestY = mCur[j - 1]! + GAP_OPEN
      let sy = 0
      const yExtend = yCur[j - 1]! + GAP_EXTEND
      if (yExtend > bestY) {
        bestY = yExtend
        sy = 2
      }
      const yFromX = xCur[j - 1]! + GAP_OPEN
      if (yFromX > bestY) {
        bestY = yFromX
        sy = 1
      }
      yCur[j] = bestY

      dir[i * width + j] = sm | (sx << 2) | (sy << 4)
    }
    let tmp = mPrev
    mPrev = mCur
    mCur = tmp
    tmp = xPrev
    xPrev = xCur
    xCur = tmp
    tmp = yPrev
    yPrev = yCur
    yCur = tmp
  }

  // 回溯：从得分最高的终态往回走，只记「两边都认下来的字」
  const matches: RawMatch[] = []
  let state = 0
  if (xPrev[n]! > mPrev[n]!) state = 1
  if (yPrev[n]! > (state === 1 ? xPrev[n]! : mPrev[n]!)) state = 2
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i === 0) {
      j--
      state = 2
      continue
    }
    if (j === 0) {
      i--
      state = 1
      continue
    }
    const d = dir[i * width + j]!
    if (state === 0) {
      if (asrChars[i - 1] === lineChars[j - 1]) matches.push({ lineIndex: j - 1, asrIndex: i - 1 })
      state = d & 3
      i--
      j--
    } else if (state === 1) {
      state = (d >> 2) & 3
      i--
    } else {
      state = (d >> 4) & 3
      j--
    }
  }
  matches.reverse()
  return matches
}

/**
 * 贪心 + 回看（超大输入时的退路）。
 *
 * 规则：相同 → 命中；不同 → 在小窗口里找「重新对齐」的位置（谁近跳谁）；
 * 窗口里都找不到 → 各让一步。比 DP 快得多，但**遇到「画本有、音频没念」的行会错位**。
 */
function alignByGreedy(lineChars: string[], asrChars: string[], maxSkip = 12): RawMatch[] {
  const matches: RawMatch[] = []
  let i = 0
  let j = 0
  while (i < lineChars.length && j < asrChars.length) {
    if (lineChars[i] === asrChars[j]) {
      matches.push({ lineIndex: i, asrIndex: j })
      i++
      j++
      continue
    }
    let skipLine = -1
    for (let d = 1; d <= maxSkip && i + d < lineChars.length; d++) {
      if (lineChars[i + d] === asrChars[j]) {
        skipLine = d
        break
      }
    }
    let skipAsr = -1
    for (let d = 1; d <= maxSkip && j + d < asrChars.length; d++) {
      if (lineChars[i] === asrChars[j + d]) {
        skipAsr = d
        break
      }
    }
    if (skipLine >= 0 && (skipAsr < 0 || skipLine <= skipAsr)) i += skipLine
    else if (skipAsr >= 0) j += skipAsr
    else {
      i++
      j++
    }
  }
  return matches
}

/** 空结果（没有识别结果 / 没有行） */
function emptyResult(spans: CharAlignLineSpan[], warnings: string[]): CharAlignResult {
  return { spans, matchRatio: 0, unmatchedUnits: [], warnings }
}

/**
 * 把识别结果（单位：token 或段）与画本行做**单调逐字**对齐。
 *
 * 不抛错：输入为空时返回空白结果（调用方据此退回 VAD）。
 */
export function alignCharsMonotone(
  units: readonly TimedText[],
  lines: readonly CharAlignLineInput[],
  opts: CharAlignOptions = {},
): CharAlignResult {
  const warnings: string[] = []

  const spans: CharAlignLineSpan[] = lines.map((l) => ({
    lineId: l.lineId,
    firstUnit: null,
    lastUnit: null,
    endHintMs: null,
    firstMs: null,
    lastMs: null,
    matchedChars: 0,
    totalChars: alignChars(l.text).length,
    coverage: 0,
  }))

  if (units.length === 0 || lines.length === 0) return emptyResult(spans, warnings)

  const asr = buildAsrStream(units)
  const lineChars: string[] = []
  const lineOf: number[] = []
  lines.forEach((l, li) => {
    for (const c of alignChars(l.text)) {
      lineChars.push(c)
      lineOf.push(li)
    }
  })

  const raw = alignByDp(lineChars, asr.chars, opts.maxDpCells ?? DEFAULT_MAX_DP_CELLS)
  const unitClaimed = new Set<number>()
  for (const match of raw) {
    const span = spans[lineOf[match.lineIndex]!]!
    span.matchedChars++
    const unit = asr.unitOf[match.asrIndex]!
    if (span.firstUnit === null) span.firstUnit = unit
    span.lastUnit = unit
    const t = asr.timeMs[match.asrIndex]!
    if (span.firstMs === null || t < span.firstMs) span.firstMs = t
    if (span.lastMs === null || t > span.lastMs) span.lastMs = t
    unitClaimed.add(unit)
  }

  /** 每行的右界 = 最后一个命中单位的下一个单位的起点（没有就交给音频末尾） */
  for (const span of spans) {
    span.coverage = span.totalChars > 0 ? span.matchedChars / span.totalChars : 0
    if (span.lastUnit === null) continue
    span.endHintMs = span.lastUnit + 1 < units.length ? asr.unitStart[span.lastUnit + 1]! : null
  }

  const totalChars = spans.reduce((sum, s) => sum + s.totalChars, 0)
  const matchedChars = spans.reduce((sum, s) => sum + s.matchedChars, 0)
  const matchRatio = totalChars === 0 ? 0 : matchedChars / totalChars
  if (matchRatio > 0 && matchRatio < 0.35) {
    warnings.push(
      '识别文本只有 ' + (matchRatio * 100).toFixed(0) + '% 的字能在画本里对上 —— 识别质量偏低，导入后请抽查',
    )
  }

  const unmatchedUnits: number[] = []
  for (let u = 0; u < units.length; u++) if (!unitClaimed.has(u)) unmatchedUnits.push(u)

  return { spans, matchRatio, unmatchedUnits, warnings }
}
