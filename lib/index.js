/**
 * dsh-cost-chip —— host 半边。
 *
 * 只做三件事：从 dsh 自己的会话事件日志里汇总真实用量（本会话 / 今天）、
 * 从官方定价页同步单价、代查一次 DeepSeek 账户余额。浏览器半边只负责显示。
 *
 * 为什么读日志而不是在浏览器里记：会话事件日志是 dsh 的持久化真相，
 * `assistant/message` 事件同时带 provider 报回来的精确 `usage` 和
 * `data.message.source` 里的 `{provider, model}`。在浏览器里靠渲染探针记账，
 * 会漏掉后台会话、没滚到的历史和重启前的调用。
 *
 * 用函数形式的插件（`inject` + `apply`），不向任何服务表里塞名字：
 * `ctx.provide` 撞名是直接抛异常，会在 boot 阶段杀掉内核。
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { isPeakAt, parsePricingPage, priceOf, pricingAt } from './pricing.js'
import { loadHolidayCalendar } from './holidays.js'

export const name = 'dsh-cost-chip'
/** webServer 是本插件唯一依赖的服务：没有它就没有可挂的路由。 */
export const inject = ['webServer']

const ROUTE = '/api/dsh-cost-chip/summary'
/** 浏览器半挂载时打一次卡，用来确认「插件真的进了页面」，不依赖任何鉴权通道。 */
const HELLO_ROUTE = '/api/dsh-cost-chip/hello'
/** 探针文件：host 挂载、client 挂载各记一笔。 */
const STATE_FILE = 'dsh-cost-chip.state.json'
/** 价表时间线：每次同步到不一样的价表就追加一条。 */
const PRICING_FILE = 'dsh-cost-chip.pricing.json'
const PRICING_HISTORY_MAX = 24
const VERSION = '0.4.0'

/** 会话日志是追加式多帧 zstd：每次落盘追加一个独立帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 单文件超过这个大小就不读了：正常会话日志到不了，读下去只会卡住事件循环。 */
const MAX_LOG_BYTES = 256 * 1024 * 1024

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
/** 官方调价一年几次，12 小时一次的同步足够，也不至于把文档站打出流量。 */
const PRICING_TTL_MS = 12 * 60 * 60 * 1000
const PRICING_TIMEOUT_MS = 10000
/** 余额缓存：一次真查要打一次 DeepSeek API，别让每次轮询都打过去。 */
const BALANCE_TTL_MS = 60 * 1000
const CNY = 'CNY'

/**
 * 兜底价表：只在**从来没成功同步过**时顶上（首次启动就断网这种情况）。
 * 抄的是 2026-09-10 官方页。正常路径下用的是抓下来的那份。
 */
const BUILTIN_PRICING = {
  at: 0,
  currency: CNY,
  source: 'builtin',
  models: {
    'deepseek-flash': {
      hit: { off: 0.02, peak: 0.04 },
      miss: { off: 1, peak: 2 },
      out: { off: 4, peak: 8 },
    },
    'deepseek-v4-pro': {
      hit: { off: 0.15, peak: 0.3 },
      miss: { off: 4.5, peak: 9 },
      out: { off: 13.5, peak: 27 },
    },
  },
  peak: { days: [1, 2, 3, 4, 5], windows: [[9, 12], [14, 18]], holidaysOffPeak: true },
  aliases: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
  note: '内置价表',
}

const fileCache = new Map()
let indexCache = { at: 0, files: [] }
let balanceCache = { at: 0, value: null }
let pricingBook = null
let pricingSync = null
let pricingStatus = { ok: null, error: null, at: 0 }

function baseURL(env) {
  const raw = env.DSH_COST_CHIP_BASE_URL
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_BASE_URL
}

function pricingURL(env) {
  const raw = env.DSH_COST_CHIP_PRICING_URL
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_PRICING_URL
}

function dshHome(env) {
  const explicit = env.DSH_HOME
  return typeof explicit === 'string' && explicit.trim().length > 0 ? explicit.trim() : join(homedir(), '.dsh')
}

function sessionsRoot(env) {
  const explicit = env.DSH_COST_CHIP_SESSIONS_ROOT
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  return join(dshHome(env), 'sessions')
}

/**
 * 药丸上那个数字代表什么：`today`（本会话今日，默认）/ `total`（本会话累计）/
 * `all`（今日全部）。跨天的会话用累计数看不出今天花了多少，所以默认按今日。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @returns {'today' | 'total' | 'all'}
 */
function chipMode(env) {
  const raw = typeof env.DSH_COST_CHIP_CHIP === 'string' ? env.DSH_COST_CHIP_CHIP.trim().toLowerCase() : ''
  return raw === 'total' || raw === 'all' ? raw : 'today'
}

/** 本地零点：`today` 的边界。 */
function startOfToday(now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 解一段追加式 zstd 字节流里所有**完整**的帧。
 *
 * 逐帧解而不是整文件一把梭：`zstdDecompressSync` 只认第一帧。
 * 魔数可能在压缩数据里撞出来，所以解不出来就把边界往后挪一个魔数；
 * 解得开但不以换行收尾的是半个帧，留给下次重读。
 * @param {Buffer} buf 待解码字节
 * @returns {{text: string, end: number}} `text` 是完整帧解出的文本；`end` 是最后一个
 *   完整帧之后的字节偏移（相对 `buf`）。增量续读就从 `end` 接着解。
 */
function decodeFrames(buf) {
  const starts = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i >= 0; i = buf.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i)
  if (starts.length === 0) return { text: '', end: 0 }

  const parts = []
  let index = 0
  while (index < starts.length) {
    const start = starts[index]
    let text = null
    let next = index + 1
    for (; next <= starts.length; next += 1) {
      const end = next < starts.length ? starts[next] : buf.length
      let decoded
      try {
        decoded = zstdDecompressSync(buf.subarray(start, end))
      } catch {
        continue
      }
      const candidate = decoded.toString('utf8')
      if (!candidate.endsWith('\n')) break
      text = candidate
      break
    }
    if (text === null) break
    parts.push(text)
    index = next
  }
  return { text: parts.join(''), end: index < starts.length ? starts[index] : buf.length }
}

/**
 * 从日志文本里抽计费字段。
 *
 * 一条记录压成 `[time, "provider:model", inputMiss, cacheRead, output]`：
 * 一个月上万条，对象存字段名会把内存和文件都撑大。
 * @param {string} text JSONL 文本
 * @param {Array} out 追加到的数组
 */
function extractRecords(text, out) {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    // 绝大多数行是流式 chunk 流水，先按子串筛掉再 JSON.parse。
    if (!line.includes('"assistant/message"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || usage === null) continue
    const source = event.data?.message?.source
    const key = source?.provider && source?.model ? `${source.provider}:${source.model}` : 'unknown'
    out.push([
      Number(event.time) || 0,
      key,
      (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      usage.cacheReadTokens ?? 0,
      usage.outputTokens ?? 0,
    ])
  }
}

/**
 * 只读文件的一段字节。用句柄定位读，续读时不用把整个文件再搬一遍内存。
 * @param {string} path 文件路径
 * @param {number} offset 起始字节
 * @param {number} length 读取长度
 * @returns {Promise<Buffer>}
 */
async function readRange(path, offset, length) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return filled === length ? buffer : buffer.subarray(0, filled)
  } finally {
    await handle.close()
  }
}

/**
 * 读一个日志文件并解出记录，按 (size, mtime) 缓存。
 *
 * 会话日志是**追加**写的，所以文件变长时只解新追加的那一段：缓存里记着最后一个
 * 完整帧结束的偏移，下次从那里接着解。整文件重解一趟要 100-200 ms 同步 CPU
 * （2.45 MiB 的会话实测 160 ms），而轮询是常开的、弹层开着更密，这点开销恰好压在
 * 正在出字的 host 主线程上。
 * 被截断/重写（size 变小）、或续读起点对不上帧边界时，退回整文件重解。
 * @param {string} path 日志绝对路径
 * @returns {Promise<Array>} 记录数组
 */
async function recordsOf(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    return []
  }
  if (info.size === 0 || info.size > MAX_LOG_BYTES) return []
  const cached = fileCache.get(path)
  if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.records

  // 追加式增长：只解新尾巴。续读起点必须落在帧边界上（以魔数开头），
  // 否则说明上一轮的边界判断不可信，走全量。
  if (cached !== undefined && info.size > cached.size && path.endsWith('.zstd')) {
    let appended = null
    try {
      appended = await readRange(path, cached.offset, info.size - cached.offset)
    } catch {
      appended = null
    }
    if (appended !== null && appended.length >= 4 && appended.subarray(0, 4).equals(ZSTD_MAGIC)) {
      const tail = decodeFrames(appended)
      if (tail.end > 0) {
        extractRecords(tail.text, cached.records)
        cached.offset += tail.end
      }
      cached.size = info.size
      cached.mtimeMs = info.mtimeMs
      return cached.records
    }
  }

  let buf
  try {
    buf = await readFile(path)
  } catch {
    return []
  }
  const records = []
  let offset = info.size
  let cwd = null
  if (path.endsWith('.zstd')) {
    const decoded = decodeFrames(buf)
    extractRecords(decoded.text, records)
    offset = decoded.end
    cwd = cwdFromLog(decoded.text)
  } else {
    // 非 zstd 的旧格式：整文件读。字节偏移切在多字节 UTF-8 中间会解出乱码，
    // 这类文件也不会再长了，不做增量。
    const text = buf.toString('utf8')
    extractRecords(text, records)
    cwd = cwdFromLog(text)
  }
  fileCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, offset, records, cwd })
  return records
}

/**
 * 从日志第一行（`{"type":"session",…,"cwd":"D:\\…"}`）取工作区路径。
 *
 * 目录名那套 `--D-work-~62A5~8868…--` 编码是有损的（分隔符和连字符撞在一起），
 * 所以认会话头里记的真实 cwd。
 * @param {string} text 解出来的日志文本
 * @returns {string | null}
 */
function cwdFromLog(text) {
  const newline = text.indexOf('\n')
  if (newline <= 0) return null
  try {
    const header = JSON.parse(text.slice(0, newline))
    return typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
  } catch {
    return null
  }
}

/**
 * 工作区显示名：取 cwd 的最后一段。取不到路径就退回目录键。
 * @param {string | null} cwd 工作区绝对路径
 * @param {string} fallback 目录键
 * @returns {string}
 */
function workspaceLabel(cwd, fallback) {
  if (typeof cwd === 'string' && cwd.length > 0) {
    const parts = cwd.split(/[\\/]+/).filter((part) => part.length > 0)
    if (parts.length > 0) return parts[parts.length - 1]
  }
  return fallback
}

/**
 * 枚举所有会话日志文件。两层目录：`<root>/<workspace>/<session-dir>/session*.jsonl[.zstd]`。
 * @param {string} root sessions 根目录
 * @returns {Promise<Array<{path: string, sessionId: string, mtimeMs: number, size: number}>>}
 */
async function listLogs(root) {
  if (Date.now() - indexCache.at < 5000) return indexCache.files
  /** sessionId → 该会话最新的那份日志（同目录可能留着旧格式的空壳）。 */
  const byNewest = new Map()
  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    let sessions
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(workspaceDir, session.name)
      let entries
      try {
        entries = await readdir(sessionDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!entry.name.startsWith('session.') || !entry.name.includes('.jsonl')) continue
        const path = join(sessionDir, entry.name)
        let info
        try {
          info = await stat(path)
        } catch {
          continue
        }
        // 一个会话目录里可能有多个版本的日志：格式升级后旧的 `session.v3.*` 会留在
        // 那里没人删，而它往往是空的。按「版本号 > mtime > 大小」只留最新的那份，
        // 否则按目录顺序取到旧壳子，整个会话就显示成 0。
        const version = Number(/^session\.v(\d+)\./.exec(entry.name)?.[1] ?? 0)
        const found = {
          path,
          sessionId: session.name.replace(/^session-/, ''),
          version,
          mtimeMs: info.mtimeMs,
          size: info.size,
          /** 工作区目录键，cwd 取不到时当显示名用。 */
          workspace: workspace.name,
        }
        const key = found.sessionId
        const previous = byNewest.get(key)
        if (previous === undefined || isNewerLog(found, previous)) byNewest.set(key, found)
      }
    }
  }
  const files = [...byNewest.values()]
  indexCache = { at: Date.now(), files }
  return files
}

/**
 * 两份同会话日志哪份更新：先比格式版本，再比写入时间，最后比大小。
 * @param {{version: number, mtimeMs: number, size: number}} candidate 候选
 * @param {{version: number, mtimeMs: number, size: number}} current 当前
 * @returns {boolean}
 */
function isNewerLog(candidate, current) {
  if (candidate.version !== current.version) return candidate.version > current.version
  if (candidate.mtimeMs !== current.mtimeMs) return candidate.mtimeMs > current.mtimeMs
  return candidate.size > current.size
}

/**
 * 给一条记录计价：按**它自己发生时刻**生效的价表与峰谷判定。
 *
 * 返回三个计费桶各自的金额，不只是总和——「钱花在哪」比「花了多少」有用，
 * 而这三个桶的单价差 50 倍（缓存命中 / 未命中 / 输出）。
 * @param {Array} record `[time, key, miss, hit, out]`
 * @param {Array<object>} entries 价表时间线
 * @param {Set<string>} holidays 放假日期（本地日期）
 * @returns {{cost: number, miss: number, hit: number, out: number} | null} 价表对不上时 null
 */
function priceRecord(record, entries, holidays) {
  const [time, key, miss, hit, out] = record
  const page = pricingAt(entries, time)
  if (page === null) return null
  const model = key.slice(key.indexOf(':') + 1)
  const price = priceOf(model, page.models, page.aliases)
  if (price === undefined || price === null) return null
  const peak = !holidays.has(dayKey(time)) && isPeakAt(time, page.peak)
  const slot = peak ? 'peak' : 'off'
  const missCost = (miss * price.miss[slot]) / 1_000_000
  const hitCost = (hit * price.hit[slot]) / 1_000_000
  const outCost = (out * price.out[slot]) / 1_000_000
  return { cost: missCost + hitCost + outCost, miss: missCost, hit: hitCost, out: outCost }
}

/** 一次汇总的累加器。`models` 用 Map：按模型拆出来的开销是「为什么贵」的另一个答案。 */
function newTotals() {
  return {
    cost: 0,
    calls: 0,
    miss: 0,
    hit: 0,
    out: 0,
    /** 三个计费桶各自的金额。 */
    bucket: { miss: 0, hit: 0, out: 0 },
    /** `provider:model` → 该模型的开销。 */
    models: new Map(),
    /** 价表或别名对不上、没有计价的模型。 */
    unpriced: new Set(),
  }
}

/**
 * 把一条记录累加进 `totals`。计价结果由调用方给，同一条记录要进多个桶时
 * 只算一次价。
 * @param {object} totals 累加器
 * @param {Array} record `[time, key, miss, hit, out]`
 * @param {object | null} priced `priceRecord` 的结果
 */
function accumulate(totals, record, priced) {
  const [, key, miss, hit, out] = record
  totals.calls += 1
  totals.miss += miss
  totals.hit += hit
  totals.out += out
  if (priced === null) {
    totals.unpriced.add(key)
    return
  }
  totals.cost += priced.cost
  totals.bucket.miss += priced.miss
  totals.bucket.hit += priced.hit
  totals.bucket.out += priced.out
  const entry = totals.models.get(key) ?? { key, model: key.slice(key.indexOf(':') + 1), cost: 0, calls: 0 }
  entry.cost += priced.cost
  entry.calls += 1
  totals.models.set(key, entry)
}

/**
 * 把累加器折成可序列化的对象。
 * @param {object} totals 累加器
 * @returns {{cost: number, calls: number, miss: number, hit: number, out: number, bucket: object, models: Array, unpriced: string[]}}
 */
function finish(totals) {
  return {
    cost: totals.cost,
    calls: totals.calls,
    miss: totals.miss,
    hit: totals.hit,
    out: totals.out,
    bucket: totals.bucket,
    models: [...totals.models.values()].sort((left, right) => right.cost - left.cost),
    unpriced: [...totals.unpriced],
  }
}

/** 一份全零的汇总，形状和 `finish` 一致。 */
function emptyTotals() {
  return finish(newTotals())
}

/**
 * 一次遍历同时算出「累计 / 今日 / 今日之前」三份汇总。
 *
 * 跑三遍是纯浪费：同一个文件每轮轮询要被读三趟、计价三趟。这里只走一遍，
 * 每条记录计一次价，再往两个累加器里加（累计 + 今日或之前）。
 * @param {Array} records 记录数组
 * @param {Array<object>} entries 价表时间线
 * @param {Set<string>} holidays 放假日期
 * @param {number} floor 今日零点
 * @returns {{all: object, today: object, before: object}}
 */
function summarizeSplit(records, entries, holidays, floor) {
  const all = newTotals()
  const today = newTotals()
  const before = newTotals()
  for (const record of records) {
    const priced = priceRecord(record, entries, holidays)
    accumulate(all, record, priced)
    accumulate(record[0] >= floor ? today : before, record, priced)
  }
  return { all: finish(all), today: finish(today), before: finish(before) }
}

/**
 * 读价表时间线。文件坏了就当从来没有过，退回兜底表。
 *
 * 老缓存只有 `at`（生效时刻），没有 `checkedAt`（上次确认时刻）：读进来时补成
 * `at`，语义上等于「按生效时刻那会儿看到过」，下一次同步会把它刷新。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @returns {Array<object>}
 */
function readPricingBook(env) {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome(env), PRICING_FILE), 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const usable = entries
      .filter((entry) => entry !== null && typeof entry === 'object' && Number.isFinite(entry.at) && entry.models !== undefined)
      .sort((a, b) => a.at - b.at)
    if (usable.length === 0) return [BUILTIN_PRICING]
    for (const entry of usable) if (!Number.isFinite(entry.checkedAt)) entry.checkedAt = entry.at
    return usable
  } catch {
    return [BUILTIN_PRICING]
  }
}

/**
 * 把时间线写回磁盘。写失败只丢「下次启动的快速路径」，不影响本次。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @param {Array<object>} entries 价表时间线
 */
function writePricingBook(env, entries) {
  try {
    writeFileSync(join(dshHome(env), PRICING_FILE), `${JSON.stringify({ version: 1, entries }, null, 1)}\n`)
  } catch {
    // 只读 home / 杀软占用：本次进程内的价表仍然可用。
  }
}

/** 两份价表的「价格内容」是否一致（忽略抓取时刻）。 */
function samePrices(left, right) {
  return JSON.stringify(left.models) === JSON.stringify(right.models)
    && JSON.stringify(left.peak) === JSON.stringify(right.peak)
    && JSON.stringify(left.aliases) === JSON.stringify(right.aliases)
}

/**
 * 把一次同步结果并进时间线。
 *
 * 价格内容变了就追加一条新条目（带 `at` 生效时刻）；没变就只刷新 `checkedAt`
 * 确认时刻。**`at` 写定之后不再改**——把它推成 now 会让夹在调价时刻与 now 之间的
 * 历史调用落回上一份价表，金额被静默重算。
 * @param {Array<object>} synced 已有时间线（只含真实同步过的条目）
 * @param {object} page 本次解析出的价表
 * @param {number} now 本次确认时刻
 * @param {number} effectiveFrom 手工校准的生效时刻（<=0 表示不校准）
 * @returns {Array<object>} 新的时间线
 */
function mergePricingEntry(synced, page, now, effectiveFrom) {
  const previous = synced[synced.length - 1]
  const at = Number.isFinite(effectiveFrom) && effectiveFrom > 0 && effectiveFrom <= page.at ? effectiveFrom : page.at
  if (previous === undefined || !samePrices(previous, page)) {
    return [...synced, { ...page, at, checkedAt: now }].slice(-PRICING_HISTORY_MAX)
  }
  // 价没变：只刷新「上次确认时刻」。
  return [...synced.slice(0, -1), { ...previous, checkedAt: now }]
}

/**
 * 同步官方价表：TTL 内直接用缓存；到期则抓一次页面，变了就追加到时间线。
 *
 * 失败**绝不**把价表换成兜底值——那等于悄悄换了一套计价口径，比显示一份
 * 「3 天没同步」的旧价危险得多。失败只记状态，继续用手上最后一份真实价。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @param {boolean} force 忽略 TTL 强制同步
 * @returns {Promise<Array<object>>}
 */
async function syncPricing(env, force = false) {
  if (pricingBook === null) pricingBook = readPricingBook(env)
  const latest = pricingBook[pricingBook.length - 1]
  // TTL 看「上次确认时刻」`checkedAt`，不看「生效时刻」`at`。
  const confirmed = latest === undefined ? 0 : Number.isFinite(latest.checkedAt) ? latest.checkedAt : latest.at
  const fresh = confirmed > 0 && Date.now() - confirmed < PRICING_TTL_MS
  if (fresh && !force) return pricingBook
  if (pricingSync !== null) return pricingSync

  pricingSync = (async () => {
    let html
    try {
      const response = await fetch(pricingURL(env), {
        headers: { accept: 'text/html', 'user-agent': 'dsh-cost-chip' },
        signal: AbortSignal.timeout(PRICING_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      html = await response.text()
    } catch (error) {
      pricingStatus = { ok: false, error: String(error?.message ?? error), at: Date.now() }
      return pricingBook
    }
    const page = parsePricingPage(html, Date.now())
    if (page === null) {
      pricingStatus = { ok: false, error: '定价页结构不认识', at: Date.now() }
      return pricingBook
    }
    // 时间线里只放**真实同步过**的价表；内置兜底表永远不参与比较，否则第一次
    // 同步成功时会因为「数值恰好和兜底一样」而被当成没变化，连备注和别名都不更新。
    const synced = pricingBook.filter((entry) => entry.at > 0)
    pricingBook = mergePricingEntry(synced, page, Date.now(), Number(env.DSH_COST_CHIP_PRICING_EFFECTIVE_FROM))
    writePricingBook(env, pricingBook)
    pricingStatus = { ok: true, error: null, at: Date.now() }
    return pricingBook
  })().finally(() => {
    pricingSync = null
  })
  return pricingSync
}

/**
 * 取 API key：优先 credentials 服务（认 env / file / keychain 各种来源），
 * 其次进程环境变量，最后退回 `~/.dsh/.credentials.yaml` 里明文写的那个。
 * @param {object} ctx cordis 上下文
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @returns {Promise<string | null>}
 */
async function apiKeyOf(ctx, env) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve('DEEPSEEK_API_KEY')
      const value = hit?.value
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 凭据服务读不到就继续往下试，余额不是主功能，不该因此失败。
    }
  }
  const fromEnv = env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  try {
    const text = await readFile(join(dshHome(env), '.credentials.yaml'), 'utf8')
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text)
    return match === null ? null : match[1]
  } catch {
    return null
  }
}

/**
 * 取 DSH 自己已登录账户的余额。
 *
 * 设置页的账户面板走的就是这个服务，所以「登录了但没配 API key」的机器也能出数；
 * 比自己去打 `/user/balance` 覆盖的人更多，也不用把 key 从凭据文件里抠出来。
 * 服务不存在（未登录/精简部署）或取不到时返回 null，交给 key 那条路。
 * @param {object} ctx cordis 上下文
 * @returns {Promise<object | null>}
 */
async function balanceFromAccount(ctx) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || account === null || typeof account.getBalance !== 'function') return null
  let details
  try {
    details = await account.getBalance({
      version: VERSION,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
  } catch {
    return null
  }
  if (details === null || details === undefined || details.status !== 'ready') return null
  const wallets = Array.isArray(details.value) ? details.value : []
  const wallet = wallets.find((item) => String(item?.currency ?? '').toUpperCase() === CNY) ?? wallets[0]
  if (wallet === undefined) return null
  return {
    ok: true,
    source: 'account',
    currency: String(wallet.currency ?? CNY).toUpperCase(),
    total: String(wallet.balance ?? '0'),
    // 平台账户只给一个可用余额，没有「赠送/充值」的拆分。
    granted: null,
    toppedUp: null,
    available: true,
    at: Date.now(),
  }
}

/**
 * 查 DeepSeek 余额，带 60 秒缓存。
 * @param {object} ctx cordis 上下文
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @returns {Promise<object>} 余额结果（失败也是结果，不抛）
 */
async function queryBalance(ctx, env) {
  if (Date.now() - balanceCache.at < BALANCE_TTL_MS && balanceCache.value !== null) return balanceCache.value
  const fromAccount = await balanceFromAccount(ctx)
  if (fromAccount !== null) {
    balanceCache = { at: Date.now(), value: fromAccount }
    return fromAccount
  }
  const key = await apiKeyOf(ctx, env)
  if (key === null) {
    return { ok: false, code: 'no-api-key', message: '未找到 DEEPSEEK_API_KEY（也没登录账户）' }
  }
  let response
  try {
    response = await fetch(`${baseURL(env).replace(/\/+$/, '')}/user/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
  } catch (error) {
    return { ok: false, code: 'network', message: String(error?.message ?? error) }
  }
  if (!response.ok) {
    return { ok: false, code: `http-${response.status}`, message: `余额接口返回 ${response.status}` }
  }
  let json
  try {
    json = await response.json()
  } catch {
    return { ok: false, code: 'bad-json', message: '余额接口返回的不是 JSON' }
  }
  const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
  const info = infos.find((item) => String(item?.currency ?? '').toUpperCase() === CNY) ?? infos[0]
  if (info === undefined) {
    return { ok: false, code: 'no-balance-info', message: '余额接口没有返回币种信息' }
  }
  const value = {
    ok: true,
    source: 'key',
    currency: String(info.currency ?? CNY).toUpperCase(),
    total: String(info.total_balance ?? '0'),
    granted: String(info.granted_balance ?? '0'),
    toppedUp: String(info.topped_up_balance ?? '0'),
    available: json?.is_available !== false,
    at: Date.now(),
  }
  balanceCache = { at: Date.now(), value }
  return value
}

/**
 * 探针文件路径。放在 dsh home 下，用 `dsh-cost-chip.state.json` 这个名字，
 * 不和别的插件抢。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @returns {string}
 */
function statePath(env) {
  return join(dshHome(env), STATE_FILE)
}

/**
 * 读探针文件；坏了就当空的，绝不抛。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @returns {object}
 */
function readState(env) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(env), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 合并写入探针文件。探针失败不影响任何功能，所以吞掉异常。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @param {object} patch 要合并进去的字段
 */
function writeState(env, patch) {
  try {
    writeFileSync(statePath(env), `${JSON.stringify({ ...readState(env), ...patch }, null, 1)}\n`)
  } catch {
    // 只读 home、杀软占用之类都只是失去探针，功能本身不受影响。
  }
}

/** 只接受本机同源请求：跨源页面既拿不到响应体，也刷不动上游。 */
function originAllowed(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  const port = request.socket?.localPort
  return url.host === `127.0.0.1:${port}` || url.host === `localhost:${port}`
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 汇总一次：本会话 + 今天 + 余额 + 价表状态。
 * @param {object} ctx cordis 上下文
 * @param {URL} url 请求 URL
 * @returns {Promise<object>} 响应负载
 */
async function collect(ctx, url) {
  const env = process.env
  const now = Date.now()
  const entries = await syncPricing(env, url.searchParams.get('refresh') === '1')
  const calendar = await loadHolidayCalendar(env, now, dshHome(env))
  const holidays = calendar.offDays
  const root = sessionsRoot(env)
  const files = await listLogs(root)

  const sessionId = url.searchParams.get('session') ?? ''
  const wanted = sessionId.replace(/^session-/, '')
  const todayFloor = startOfToday(now)

  let session = null
  /** 当前会话对应的日志文件，后面用来取它所属的工作区。 */
  let sessionFile = null
  if (wanted.length > 0) {
    const file = files.find((item) => item.sessionId === wanted)
    if (file !== undefined) {
      sessionFile = file
      // 本会话拆成「今天」与「今天之前」：会话可能跨了好几天，一个总数看不出
      // 今天到底烧了多少。一趟遍历出三份，加起来等于总数。
      const split = summarizeSplit(await recordsOf(file.path), entries, holidays, todayFloor)
      session = { id: wanted, ...split.all, today: split.today, before: split.before }
    } else {
      session = { id: wanted, ...emptyTotals(), today: emptyTotals(), before: emptyTotals() }
    }
  }

  // 今天：只读今天动过的文件（mtime 落在今天）。会话跨天时，当天追加过就一定会更新 mtime。
  const todays = files.filter((item) => item.mtimeMs >= todayFloor)
  const todayTotals = newTotals()
  /** 工作区显示名 → 今日累计。一条记录只计一次价，同时进「今日」和「该工作区」。 */
  const byWorkspace = new Map()
  for (const file of todays) {
    const records = await recordsOf(file.path)
    if (records.length === 0) continue
    const name = workspaceLabel(fileCache.get(file.path)?.cwd ?? null, file.workspace ?? '未知工作区')
    const bucket = byWorkspace.get(name) ?? { name, totals: newTotals() }
    byWorkspace.set(name, bucket)
    for (const record of records) {
      if (record[0] < todayFloor) continue
      const priced = priceRecord(record, entries, holidays)
      accumulate(todayTotals, record, priced)
      accumulate(bucket.totals, record, priced)
    }
  }

  const balance = await queryBalance(ctx, env)
  const latest = entries[entries.length - 1] ?? BUILTIN_PRICING
  const reported = latest.at === 0 ? 0 : Number.isFinite(latest.checkedAt) ? latest.checkedAt : latest.at
  return {
    ok: true,
    now,
    version: VERSION,
    chip: chipMode(env),
    session,
    workspace: sessionFile === null ? null : {
      name: workspaceLabel(fileCache.get(sessionFile.path)?.cwd ?? null, sessionFile.workspace ?? '未知工作区'),
    },
    today: {
      dayKey: dayKey(now),
      ...finish(todayTotals),
      workspaces: [...byWorkspace.values()]
        .map((item) => {
          const totals = finish(item.totals)
          return {
            name: item.name,
            cost: totals.cost,
            calls: totals.calls,
            miss: totals.miss,
            hit: totals.hit,
            out: totals.out,
            bucket: totals.bucket,
          }
        })
        .filter((item) => item.calls > 0)
        .sort((a, b) => b.cost - a.cost),
    },
    balance,
    pricing: {
      currency: latest.currency ?? CNY,
      peak: !holidays.has(dayKey(now)) && isPeakAt(now, latest.peak),
      source: latest.at === 0 ? 'builtin' : 'official',
      // 「多久前确认过这份价」和「这份价从什么时候生效」是两回事：
      // 界面上的「N 分钟前同步」要用前者。
      fetchedAt: reported,
      ageMs: reported === 0 ? null : Math.max(0, now - reported),
      effectiveAt: latest.at,
      models: Object.keys(latest.models),
      holidaysOffPeak: latest.peak.holidaysOffPeak === true,
      holidays: {
        source: calendar.source,
        at: calendar.at,
        years: calendar.years,
        missingYears: calendar.missingYears,
        // 未来年份没公布是常态（明年放假通知一般 11-12 月才出），不值得提示；
        // 只有**当年**缺日历才说明真的算不准。
        missingCurrentYear: calendar.missingYears.includes(String(new Date(now).getFullYear())),
        days: holidays.size,
      },
      ok: pricingStatus.ok,
      error: pricingStatus.error,
      note: latest.note ?? null,
    },
  }
}

/**
 * 挂载：两条 GET 路由，其余什么都不做。
 * @param {object} ctx cordis 上下文
 */export function apply(ctx) {
  // host 挂载落地的一笔：重启后不用密码、不用进页面就能确认插件真的加载了。
  writeState(process.env, {
    hostAt: Date.now(),
    pid: process.pid,
    version: VERSION,
    route: ROUTE,
    hello: HELLO_ROUTE,
  })

  // 后台先同步一次价表，不阻塞启动。
  void syncPricing(process.env)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: HELLO_ROUTE,
        handler: (request, response) => {
          if (!originAllowed(request)) {
            send(response, 403, { ok: false, error: { code: 'origin', message: '跨源请求被拒绝' } })
            return
          }
          const url = new URL(request.url ?? HELLO_ROUTE, 'http://127.0.0.1')
          const diag = url.searchParams.get('diag')
          writeState(process.env, {
            clientAt: Date.now(),
            clientVersion: url.searchParams.get('v') ?? null,
            clientSession: url.searchParams.get('session') ?? null,
            ...(diag !== null && diag.length > 0 ? { clientDiag: diag.slice(0, 2000) } : {}),
          })
          send(response, 200, { ok: true, version: VERSION })
        },
      }),
    `dsh-cost-chip: ${HELLO_ROUTE}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (request, response) => {
          if (!originAllowed(request)) {
            send(response, 403, { ok: false, error: { code: 'origin', message: '跨源请求被拒绝' } })
            return
          }
          try {
            send(response, 200, await collect(ctx, new URL(request.url ?? ROUTE, 'http://127.0.0.1')))
          } catch (error) {
            send(response, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
          }
        },
      }),
    `dsh-cost-chip: ${ROUTE}`,
  )
}

/**
 * 只给 `dev/` 下的测试用：把纯函数露出来，好在真实日志上验增量解码与计价。
 * Cordis 只认 `name` / `inject` / `apply`（以及可选的 `Config`），多导出一个
 * 对象不影响挂载。
 */
export const __test = {
  decodeFrames,
  extractRecords,
  priceRecord,
  newTotals,
  accumulate,
  finish,
  mergePricingEntry,
  recordsOf,
  readRange,
  fileCache,
  collect,
  VERSION,
}
