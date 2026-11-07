/**
 * 中国法定节假日：官方定价页只说「不含中国法定节假日」，具体哪天放假是国务院
 * 每年发一次通知。这里不内置一套写死的判断逻辑，而是：
 *
 *   1. 内置一份**快照**（`holidays-data.js`），断网、接口挂了也能用；
 *   2. 运行时按年从镜像接口刷新，成功就落到缓存文件，7 天内不重复抓；
 *   3. 手工 `DSH_COST_CHIP_HOLIDAYS` 永远叠加在上面，覆盖任何来源。
 *
 * 只关心「放假」的日子：调休上班的周六按官方口径本来就是周末（非高峰），
 * 不需要额外处理。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import BUNDLED from './holidays-data.js'

/** 节假日缓存文件：和价表缓存放一起。 */
const CACHE_FILE = 'dsh-cost-chip.holidays.json'
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 8000

/** 进程内缓存：一分钟内重复请求不重读文件、不重抓网。 */
let memo = null

function defaultURL(year) {
  return `https://timor.tech/api/holiday/year/${year}`
}

/**
 * 把镜像接口的一年数据折成「放假日期」数组。
 * @param {any} json 接口返回
 * @returns {string[] | null} `YYYY-MM-DD` 数组；结构不认识时 null
 */
export function parseHolidayYear(json) {
  const table = json?.holiday
  if (table === null || typeof table !== 'object') return null
  const days = []
  for (const entry of Object.values(table)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.holiday !== true) continue
    const date = typeof entry.date === 'string' ? entry.date : null
    if (date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) days.push(date)
  }
  return [...new Set(days)].sort()
}

/**
 * 读缓存文件。坏了就当没有。
 * @param {string} file 缓存路径
 * @returns {{at: number, years: Record<string, string[]>} | null}
 */
function readCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (!Number.isFinite(parsed.at) || parsed.years === null || typeof parsed.years !== 'object') return null
    const years = {}
    for (const [year, days] of Object.entries(parsed.years)) {
      if (Array.isArray(days)) years[year] = days.filter((day) => typeof day === 'string')
    }
    return { at: parsed.at, years }
  } catch {
    return null
  }
}

function writeCache(file, value) {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`)
  } catch {
    // 只读 home：本次进程内仍然可用。
  }
}

/**
 * 抓一年的放假安排。
 * @param {string} url 接口地址（含年份）
 * @returns {Promise<string[] | null>} 放假日期；失败 null
 */
async function fetchYear(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-cost-chip' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    return parseHolidayYear(await response.json())
  } catch {
    return null
  }
}

/**
 * 载入节假日日历：内置快照 + 缓存 + 刷新 + 手工覆盖。
 *
 * 刷新失败**不会**清空任何东西：手上有缓存就用缓存，然后叠加内置快照。
 * 两样都没有的年份会记在 `missingYears` 里，界面据此提示「某年未覆盖」。
 * @param {NodeJS.ProcessEnv} env 进程环境
 * @param {number} now 当前时刻
 * @param {string} home dsh home 目录
 * @returns {Promise<{offDays: Set<string>, source: string, at: number | null, years: string[], missingYears: string[]}>}
 */
export async function loadHolidayCalendar(env, now, home) {
  // 每次请求都读文件、可能还会抓网太浪费：进程内缓存一分钟，够覆盖一轮轮询。
  if (memo !== null && now - memo.at < 60_000) return memo.value
  const file = join(home, CACHE_FILE)
  const cached = readCache(file)
  const fresh = cached !== null && now - cached.at < TTL_MS
  const years = { ...BUNDLED }
  let source = 'bundled'
  let at = null

  if (cached !== null) {
    for (const [year, days] of Object.entries(cached.years)) {
      if (days.length > 0) years[year] = days
    }
    source = fresh ? 'cache' : 'bundled'
    at = cached.at
  }

  const currentYear = new Date(now).getFullYear()
  const wanted = [currentYear, currentYear + 1]
  const stale = wanted.filter((year) => !(year in (cached?.years ?? {})) || !fresh)
  if (stale.length > 0) {
    const template = env.DSH_COST_CHIP_HOLIDAYS_URL
    const fetched = {}
    let any = false
    for (const year of stale) {
      const url = typeof template === 'string' && template.length > 0
        ? template.replace('{year}', String(year))
        : defaultURL(year)
      const days = await fetchYear(url)
      if (days === null) continue
      // 空数组 = 那一年还没公布（比如 2027 在 10 月），不算失败但也没东西可用。
      fetched[year] = days
      if (days.length > 0) {
        years[year] = days
        any = true
      }
    }
    if (any) {
      const next = { at: now, years: { ...(cached?.years ?? {}), ...fetched } }
      writeCache(file, next)
      source = 'remote'
      at = now
    }
  }

  const offDays = new Set()
  for (const days of Object.values(years)) for (const day of days) offDays.add(day)

  // 手工指定永远最后叠加，优先级最高。
  const manual = env.DSH_COST_CHIP_HOLIDAYS
  if (typeof manual === 'string' && manual.trim().length > 0) {
    for (const day of manual.split(',').map((item) => item.trim()).filter((item) => item.length > 0)) {
      offDays.add(day)
      if (!(String(new Date(now).getFullYear()) in years)) years[String(new Date(now).getFullYear())] = []
      source = 'manual'
    }
  }

  const covered = Object.keys(years).filter((year) => (years[year] ?? []).length > 0).sort()
  const missingYears = wanted.filter((year) => !covered.includes(String(year))).map(String)
  const value = { offDays, source, at, years: covered, missingYears }
  memo = { at: now, value }
  return value
}
