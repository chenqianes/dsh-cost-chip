// 用真实抓下来的定价页验证解析器。
// 用法: node dev/probe-pricing.mjs [fixtureFile]
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPeakAt, parsePricingPage, priceOf, pricingAt } from '../lib/pricing.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(process.argv[2] ?? join(here, 'fixtures', 'pricing.html'))
const html = readFileSync(fixture, 'utf8')

const at = Date.UTC(2026, 9, 19, 2, 0, 0)
const page = parsePricingPage(html, at)
if (page === null) throw new Error('parse failed')

console.log('models:', Object.keys(page.models).join(', '))
for (const [name, price] of Object.entries(page.models)) {
  console.log(
    `  ${name}: hit ${price.hit.off}/${price.hit.peak}  miss ${price.miss.off}/${price.miss.peak}  out ${price.out.off}/${price.out.peak}`,
  )
}
console.log('peak:', JSON.stringify(page.peak))
console.log('aliases:', JSON.stringify(page.aliases))
console.log('note:', page.note)

const problems = []
const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`)
  if (!ok) problems.push(`${label} expected ${JSON.stringify(wanted)}`)
}

expect('flash 命中价', page.models['deepseek-flash']?.hit, { off: 0.02, peak: 0.04 })
expect('flash 未命中价', page.models['deepseek-flash']?.miss, { off: 1, peak: 2 })
expect('flash 输出价', page.models['deepseek-flash']?.out, { off: 4, peak: 8 })
expect('pro 命中价', page.models['deepseek-v4-pro']?.hit, { off: 0.15, peak: 0.3 })
expect('pro 输出价', page.models['deepseek-v4-pro']?.out, { off: 13.5, peak: 27 })
expect('高峰日', page.peak.days, [1, 2, 3, 4, 5])
expect('高峰时段', page.peak.windows, [[9, 12], [14, 18]])
expect('节假日算空闲', page.peak.holidaysOffPeak, true)

// 北京时间 2026-10-19（周一）10:00 = UTC 02:00
expect('周一 10:00 是高峰', isPeakAt(Date.UTC(2026, 9, 19, 2, 0), page.peak), true)
expect('周一 12:30 不是高峰', isPeakAt(Date.UTC(2026, 9, 19, 4, 30), page.peak), false)
expect('周一 14:30 是高峰', isPeakAt(Date.UTC(2026, 9, 19, 6, 30), page.peak), true)
expect('周六 10:00 不是高峰', isPeakAt(Date.UTC(2026, 9, 17, 2, 0), page.peak), false)

expect('旧名按 flash 计价', priceOf('deepseek-v4-flash-vision-exp', page.models, page.aliases)?.miss, { off: 1, peak: 2 })
expect('未知模型不计价', priceOf('totally-unknown-model', page.models, page.aliases), null)

const timeline = [{ at: 100, models: { a: 1 } }, { at: 200, models: { a: 2 } }]
expect('时刻选价（早）', pricingAt(timeline, 150)?.models?.a, 1)
expect('时刻选价（晚）', pricingAt(timeline, 250)?.models?.a, 2)
expect('早于首条', pricingAt(timeline, 50)?.models?.a, 1)

console.log('')
if (problems.length === 0) console.log('pricing parse OK')
else {
  console.log('problems:', problems)
  process.exitCode = 1
}
