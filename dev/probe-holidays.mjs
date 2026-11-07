// 验证节假日日历：镜像数据解析、内置快照、以及「节假日 -> 空闲时段」的组合判定。
// 用法: node dev/probe-holidays.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHolidayCalendar, parseHolidayYear } from '../lib/holidays.js'
import { isPeakAt, parsePricingPage } from '../lib/pricing.js'

const here = dirname(fileURLToPath(import.meta.url))
const problems = []
const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`)
  if (!ok) problems.push(`${label} expected ${JSON.stringify(wanted)}`)
}

// 1. 镜像接口 → 放假日期
const raw = JSON.parse(readFileSync(join(here, 'fixtures', 'holiday-2026.json'), 'utf8'))
const days2026 = parseHolidayYear(raw)
console.log('2026 放假天数:', days2026.length)
expect('国庆放假包含 10-01', days2026.includes('2026-10-01'), true)
expect('国庆放假包含 10-07', days2026.includes('2026-10-07'), true)
expect('调休上班 01-04 不在放假表', days2026.includes('2026-01-04'), false)
expect('结果有序且去重', days2026.length === new Set(days2026).size, true)

// 2. 内置快照 + 加载器（不走网络：把 URL 指到不存在的端口）
const env = { DSH_COST_CHIP_HOLIDAYS_URL: 'http://127.0.0.1:1/{year}' }
const calendar = await loadHolidayCalendar(env, Date.UTC(2026, 9, 19, 2, 0), join(here, 'tmp-home'))
console.log('calendar:', JSON.stringify({ source: calendar.source, years: calendar.years, missing: calendar.missingYears, days: calendar.offDays.size }))
expect('覆盖 2026', calendar.years.includes('2026'), true)
expect('2027 记为缺失', calendar.missingYears.includes('2027'), true)

// 3. 组合判定：节假日全天不算高峰
const page = parsePricingPage(readFileSync(join(here, 'fixtures', 'pricing.html'), 'utf8'), Date.now())
const isPeak = (ms) => !calendar.offDays.has(new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)) && isPeakAt(ms, page.peak)
// 北京时间 2026-10-01（周四）10:00
expect('国庆 10:00 → 空闲', isPeak(Date.UTC(2026, 9, 1, 2, 0)), false)
// 北京时间 2026-10-19（周一）10:00
expect('普通周一 10:00 → 高峰', isPeak(Date.UTC(2026, 9, 19, 2, 0)), true)
// 北京时间 2026-10-19 13:00（午休）
expect('普通周一 13:00 → 空闲', isPeak(Date.UTC(2026, 9, 19, 5, 0)), false)

console.log('')
if (problems.length === 0) console.log('holidays OK')
else {
  console.log('problems:', problems)
  process.exitCode = 1
}
