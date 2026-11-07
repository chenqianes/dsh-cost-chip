// 离线验证浏览器半边：假 ModuleLoader + 假 react，直接调用组件拿渲染树。
// 用法: node dev/probe-client.mjs
//
// PROBE_MISSING_CURRENT=1 时模拟「当年缺日历」，用来验证提示只在这时出现。
import { readFileSync } from 'node:fs'

/** 把 jsx/jsxs 求值成一棵普通对象树，便于断言文案。 */
function element(type, props, key) {
  return { type, props: props ?? {}, key: key ?? null }
}

const missingCurrent = process.env.PROBE_MISSING_CURRENT === '1'

const fixture = {
  ok: true,
  chip: 'today',
  session: {
    id: 'abc',
    cost: 1.378,
    calls: 111,
    miss: 1,
    hit: 2,
    out: 3,
    bucket: { miss: 0.6, hit: 0.08, out: 0.698 },
    models: [{ key: 'p:deepseek-flash', model: 'deepseek-flash', cost: 1.378, calls: 111 }],
    unpriced: [],
    today: {
      cost: 0.42,
      calls: 30,
      miss: 10,
      hit: 20,
      out: 30,
      bucket: { miss: 0.18, hit: 0.04, out: 0.2 },
      models: [
        { key: 'p:deepseek-flash', model: 'deepseek-flash', cost: 0.3, calls: 20 },
        { key: 'p:deepseek-v4-pro', model: 'deepseek-v4-pro', cost: 0.12, calls: 10 },
      ],
      unpriced: [],
    },
    before: {
      cost: 0.958,
      calls: 81,
      miss: 0,
      hit: 0,
      out: 0,
      bucket: { miss: 0, hit: 0, out: 0 },
      models: [],
      unpriced: [],
    },
  },
  workspace: { name: 'web-app' },
  today: {
    dayKey: '2026-10-19',
    cost: 7.63,
    calls: 499,
    miss: 1,
    hit: 2,
    out: 3,
    bucket: { miss: 3.11, hit: 0.52, out: 4 },
    models: [],
    unpriced: [],
    workspaces: [
      { name: 'data-pipeline', cost: 4.11, calls: 300 },
      { name: 'web-app', cost: 3.52, calls: 199 },
    ],
  },
  // 账户服务给的是高精度十进制字符串，界面上必须压到两位
  balance: { ok: true, currency: 'CNY', total: '73.7221026000000000' },
  pricing: {
    currency: 'CNY',
    peak: true,
    source: 'official',
    fetchedAt: 1792390000000,
    ageMs: 37 * 60000,
    effectiveAt: 1792390000000,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    holidaysOffPeak: true,
    holidays: {
      source: 'remote',
      at: 1792390000000,
      years: missingCurrent ? ['2025'] : ['2025', '2026'],
      missingYears: missingCurrent ? ['2026'] : ['2027'],
      missingCurrentYear: missingCurrent,
      days: missingCurrent ? 28 : 61,
    },
    ok: true,
    error: null,
    note: '法定节假日按空闲时段',
  },
}

/** 组件里 useState 的调用顺序：data / error / open。 */
const stateValues = [fixture, null, true]

const requireStub = (specifier) => {
  if (specifier === 'react') {
    let index = 0
    return {
      Fragment: 'Fragment',
      useState: () => [stateValues[index++], () => {}],
      useEffect: () => undefined,
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
    }
  }
  if (specifier === 'react/jsx-runtime') {
    return { jsx: element, jsxs: element, Fragment: 'Fragment' }
  }
  throw new Error('unexpected require ' + specifier)
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = { id: definition.id, exports: definition.factory(requireStub) }
    },
  },
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)

if (loaded === null) throw new Error('bundle never loaded')
const { exports } = loaded
if (typeof exports.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(exports.inject)) throw new Error('inject missing')

let registration = null
const ctx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  locale: { register: () => () => {} },
  slots: {
    inject: (_name, fn) => {
      fn()
      return () => {}
    },
    register: (spec, component) => {
      registration = { spec, component }
      return () => {}
    },
  },
}
exports.apply(ctx)
if (registration === null) throw new Error('no slot registration')
console.log('bundle:', loaded.id)
console.log('slot:', registration.spec.name, '| id:', registration.spec.id, '| order:', registration.spec.order)

const dict = {
  session: '本会话',
  sessionToday: '今日',
  sessionBefore: '之前',
  today: '今日全部',
  others: '其他 {n} 个工作区',
  balance: '余额',
  calls: '{n} 次调用',
  note: '官方价表',
  noteBuiltin: '内置价表（从未同步成功）',
  noteStale: '价表同步失败，沿用上次的价',
  priceAgo: '{n}前同步',
  minutes: '{n} 分钟',
  hours: '{n} 小时',
  days: '{n} 天',
  holidayCaveat: '缺 {years} 年放假安排，该年节假日按高峰计',
  peak: '峰',
  offpeak: '谷',
  idleSlot: '空闲时段',
  breakdown: '成本构成 · {scope}',
  scopeToday: '本会话今日',
  scopeTotal: '本会话累计',
  scopeAll: '今日全部',
  bucketMiss: '缓存未命中',
  bucketHit: '缓存命中',
  bucketOut: '输出',
  tokens: '{n} tokens',
  moreModels: '其他 {n} 个模型',
  unavailable: '暂不可用',
  noKey: '未配置 API Key',
  tip: '...',
}
const t = (key) => dict[key] ?? key

const tree = registration.component({ t, sessionId: 'abc' })

/** 收集所有文本节点。 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (typeof node === 'object') texts(node.props?.children, out)
  return out
}

/** 收集所有元素的 props，便于断言 title / 悬停。 */
function props(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) props(child, out)
    return out
  }
  out.push(node.props)
  props(node.props?.children, out)
  return out
}

const collected = texts(tree)
console.log('texts:', JSON.stringify(collected))
const expected = [
  // 药丸 + 三块汇总
  '¥0.42', '¥1.38', '¥7.63', '¥73.72',
  '¥0.42 · 30 次调用', '¥0.96 · 81 次调用',
  '本会话', '今日', '之前', '今日全部', '余额',
  'data-pipeline', '· web-app', '¥4.11', '¥3.52',
  '官方价表 · 37 分钟前同步',
  // 成本构成（chip 模式 = today，所以口径是本会话今日）
  '成本构成 · 本会话今日',
  '输出', '¥0.20 · 48%',
  '缓存未命中', '¥0.18 · 43%',
  '缓存命中', '¥0.04 · 9%',
  // 多模型时才列模型行，且去掉 deepseek- 前缀
  'flash', '¥0.30', 'v4-pro', '¥0.12',
]
if (missingCurrent) expected.push('缺 2026 年放假安排')
else if (collected.some((text) => text.includes('年放假安排'))) {
  throw new Error('未来年份缺日历不该提示')
}
for (const want of expected) {
  if (!collected.some((text) => text.includes(want))) {
    throw new Error('missing text: ' + want)
  }
}

// token 数只在悬停里出现，不该占一行
const titles = props(tree).map((item) => item.title).filter((value) => typeof value === 'string')
if (!titles.some((title) => title.includes('tokens'))) throw new Error('bucket 行应带 token 悬停')
if (collected.some((text) => text.includes('tokens'))) throw new Error('token 数不该显示成文本')

// 账户服务的高精度余额串不能原样漏到界面上
if (collected.some((text) => text.includes('73.7221026'))) throw new Error('余额应压到两位小数')

// 三个计费桶的占比必须和成 100（各自四舍五入会和成 101 或 99）
const shares = collected
  .map((text) => /· (\d+)%$/.exec(text))
  .filter((match) => match !== null)
  .map((match) => Number(match[1]))
if (shares.length !== 3) throw new Error(`应有 3 个占比，实际 ${shares.length}`)
const shareSum = shares.reduce((sum, value) => sum + value, 0)
if (shareSum !== 100) throw new Error(`占比之和应为 100，实际 ${shareSum}（${shares.join('+')}）`)

console.log('OK')
