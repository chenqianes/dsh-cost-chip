/**
 * 官方定价页解析。
 *
 * 页面是 Docusaurus 静态站，价格表在服务端就渲染成 `<table>` 了，所以不需要
 * 跑浏览器，纯正则/单元格解析就够。结构（2026-10 抓到的样子）：
 *
 *   模型 | deepseek-flash | deepseek-v4-pro
 *   价格 | 百万tokens输入（缓存命中） | 空闲时段 | 0.02元 | 0.15元
 *        |                        | 高峰时段 | 0.04元 | 0.30元
 *        | 百万tokens输入（缓存未命中） | 空闲时段 | 1元   | 4.5元
 *        ...
 *
 * 两个刻意的设计：
 * - **峰价逐模型读**，不假设「峰价 = 空闲 × 2」。页面上本来就是两张独立的数，
 *   曾经统一 2 倍只是当时恰好如此。
 * - **解析失败就整份丢弃**，由调用方回退到上一份真实价表。宁可显示「3 天没同步」
 *   也不猜。
 */

const PRICE_CELL = /^\s*([\d.]+)\s*元\s*$/
const MODEL_FOOTNOTE = /\s*\(\d+\)\s*$/

/**
 * 把 HTML 表格拆成 `[row][cell]` 的纯文本矩阵。
 * @param {string} table `<table>…</table>` 片段
 * @returns {string[][]}
 */
function tableRows(table) {
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  return rows.map((row) => {
    const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []
    return cells.map((cell) =>
      cell
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim(),
    )
  })
}

/** `deepseek-flash(1)` → `deepseek-flash`。 */
function modelName(cell) {
  return cell.replace(MODEL_FOOTNOTE, '').trim()
}

/**
 * 定价表里「每百万 token 的价格」那一块。
 * @param {string[][]} rows 表格矩阵
 * @returns {{models: string[], prices: Map<string, object>} | null}
 */
function parsePriceRows(rows) {
  const header = rows[0]
  if (header === undefined || header[0] !== '模型') return null
  const models = header.slice(1).map(modelName).filter((name) => name.length > 0)
  if (models.length === 0) return null

  const prices = new Map(models.map((name) => [name, {}]))
  let metric = null
  for (const row of rows) {
    const text = row.join(' ')
    // 「价格」这一行才进入计费区：前面的「功能」「上下文长度」也带数字，别误读。
    if (text.includes('缓存命中')) metric = 'hit'
    else if (text.includes('缓存未命中')) metric = 'miss'
    else if (/百万\s*tokens\s*输出|百万token输出/.test(text)) metric = 'out'
    if (metric === null) continue

    const peak = text.includes('高峰')
    const off = text.includes('空闲')
    if (!peak && !off) continue

    const values = row.map((cell) => PRICE_CELL.exec(cell)).filter((match) => match !== null).map((match) => Number(match[1]))
    if (values.length !== models.length) continue

    models.forEach((name, index) => {
      const entry = prices.get(name)
      entry[metric] = entry[metric] ?? {}
      entry[metric][peak ? 'peak' : 'off'] = values[index]
    })
  }

  for (const [, entry] of prices) {
    for (const key of ['hit', 'miss', 'out']) {
      const slot = entry[key]
      if (slot === undefined || typeof slot.off !== 'number') return null
      // 页面偶尔只给空闲价（脚注说「高峰是空闲的一半」）。这种情况按半价推。
      if (typeof slot.peak !== 'number') slot.peak = slot.off
    }
  }
  return { models, prices }
}

/**
 * 从页脚解析高峰时段与「节假日除外」的口径。
 * @param {string} text 页面纯文本
 * @returns {{days: number[], windows: number[][], holidaysOffPeak: boolean} | null}
 */
function parsePeakSchedule(text) {
  const daysMatch = /北京时间(?:周|星期)([一二三四五六日天])至(?:周|星期)([一二三四五六日天])/.exec(text)
  const windows = []
  const windowPattern = /(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/g
  let match
  while ((match = windowPattern.exec(text)) !== null) {
    const from = Number(match[1]) + Number(match[2]) / 60
    const to = Number(match[3]) + Number(match[4]) / 60
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) windows.push([from, to])
  }
  if (windows.length === 0) return null

  const CN_DAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
  const days = []
  if (daysMatch !== null) {
    const from = CN_DAY[daysMatch[1]]
    const to = CN_DAY[daysMatch[2]]
    for (let day = from; day <= to; day += 1) days.push(day)
  }
  if (days.length === 0) days.push(1, 2, 3, 4, 5)

  // 「不含中国法定节假日」= 节假日全天算空闲；没这句话就按字面（工作日高峰）。
  const holidaysOffPeak = /不含[^。]{0,6}法定节假日|法定节假日[^。]{0,6}(?:除外|不计高峰|按空闲)/.test(text)
  return { days, windows, holidaysOffPeak }
}

/**
 * 解析「旧模型名 … 按 X 价计费」这类别名规则。
 *
 * 页面上的目标写的是简称（「按 Flash 价格计费」），价表里的键是全名
 * （`deepseek-flash`），所以要把简称对回键上。
 * @param {string} text 页面纯文本
 * @param {string[]} modelKeys 价表里的模型键
 * @returns {Record<string, string>} 旧名 → 计费模型名
 */
function parseAliases(text, modelKeys) {
  const aliases = {}
  const resolve = (target) => {
    const lower = target.toLowerCase()
    if (modelKeys.includes(lower)) return lower
    const prefixed = `deepseek-${lower}`
    if (modelKeys.includes(prefixed)) return prefixed
    const suffixed = modelKeys.filter((key) => key.endsWith(`-${lower}`) || key === lower)
    return suffixed.length === 1 ? suffixed[0] : null
  }
  const pattern = /旧模型名\s*([^。]{0,120}?)仍可调用/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const names = (match[1].match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    const target = /按\s*([A-Za-z][A-Za-z0-9-]*)\s*价格计费/.exec(text.slice(match.index, match.index + 300))?.[1]
    if (target === undefined) continue
    const key = resolve(target)
    if (key === null) continue
    for (const name of names) if (!modelKeys.includes(name)) aliases[name] = key
  }
  return aliases
}

/**
 * 解析整张定价页。
 * @param {string} html 页面 HTML
 * @param {number} now 抓取时刻
 * @returns {{at: number, currency: string, models: Record<string, object>, peak: object, aliases: Record<string, string>, note: string} | null}
 */
export function parsePricingPage(html, now) {
  if (typeof html !== 'string' || html.length === 0) return null
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')

  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
  for (const table of tables) {
    const parsed = parsePriceRows(tableRows(table))
    if (parsed === null) continue
    const models = {}
    for (const [name, entry] of parsed.prices) models[name] = entry
    const peak = parsePeakSchedule(text)
    if (peak === null) return null
    return {
      at: now,
      currency: 'CNY',
      models,
      peak,
      aliases: parseAliases(text, Object.keys(models)),
      note: peak.holidaysOffPeak ? '法定节假日按空闲时段' : '仅按工作日时段判定',
    }
  }
  return null
}

/**
 * 把价格表折算成某一时刻的一条记录该用的单价。
 *
 * 别名（旧模型名）与「同一家族的唯一候选」都在这里兜：官方改名比调价勤，
 * 名字对不上就整条不计费会让数字凭空消失，比按同家族计价更糟。
 * @param {string} model 日志里的模型名
 * @param {Record<string, object>} models 价表
 * @param {Record<string, string>} aliases 别名表
 * @returns {object | null}
 */
export function priceOf(model, models, aliases) {
  if (typeof model !== 'string' || model.length === 0) return null
  const direct = models[model]
  if (direct !== undefined) return direct
  const alias = aliases[model]
  if (alias !== undefined && models[alias] !== undefined) return models[alias]

  // 家族兜底：名字里唯一命中的那个关键词（flash / pro / v4 …）。
  const tokens = model.split(/[-_.]/).filter((token) => token.length >= 3 && token !== 'deepseek')
  const candidates = Object.keys(models).filter((key) => tokens.some((token) => key.includes(token)))
  return candidates.length === 1 ? models[candidates[0]] : null
}

/**
 * 某一时刻是否落在高峰时段。
 * @param {number} ms 时间戳
 * @param {{days: number[], windows: number[][]}} schedule 时段规则（北京时间）
 * @returns {boolean}
 */
export function isPeakAt(ms, schedule) {
  const shifted = new Date(ms + 8 * 3600 * 1000)
  const day = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay()
  if (!schedule.days.includes(day)) return false
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60
  return schedule.windows.some(([from, to]) => hour >= from && hour < to)
}

/**
 * 时间线上为某一时刻选价表：最后一条 `at <= t` 的记录；比最早的还早就用最早的一条。
 * @param {Array<object>} entries 按 at 升序的价格表时间线
 * @param {number} ms 时间戳
 * @returns {object | null}
 */
export function pricingAt(entries, ms) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  let chosen = entries[0]
  for (const entry of entries) {
    if (entry.at <= ms) chosen = entry
    else break
  }
  return chosen
}
