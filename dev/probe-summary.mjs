// 不重启 DSH 也能验 host 半边的输出：直接在进程内跑一次 collect()。
//
//   node dev/probe-summary.mjs [sessionId]
//
// 用假的 deepseekAccount 服务，顺便验「账户余额优先」那条路。
// 只读会话日志；价表新鲜时不会重抓（过期会抓一次官方页）。
import assert from 'node:assert/strict'
import { __test } from '../lib/index.js'

const { collect } = __test

const sessionId = process.argv[2] ?? ''

/** 假的账户服务：形状照 `deepseekAccount.getBalance` 的返回值。 */
const fakeAccount = {
  calls: 0,
  async getBalance(client) {
    this.calls += 1
    assert.equal(typeof client.version, 'string')
    assert.equal(typeof client.locale, 'string')
    assert.equal(typeof client.timezoneOffsetSeconds, 'number')
    return {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '42.50' }],
      bonusWallets: [],
    }
  },
}

const fakeCtx = {
  get(key) {
    return key === 'deepseekAccount' ? fakeAccount : undefined
  },
}

const url = new URL(`http://127.0.0.1/api/dsh-cost-chip/summary${sessionId.length > 0 ? `?session=${sessionId}` : ''}`)
const started = performance.now()
const payload = await collect(fakeCtx, url)
const elapsed = performance.now() - started

console.log(JSON.stringify(payload, null, 2))
console.log(`\n--- ${elapsed.toFixed(0)} ms · account.getBalance 调用 ${fakeAccount.calls} 次 ---`)

// 结构断言：新增字段必须真的在，且自洽
assert.equal(payload.ok, true)
assert.ok(payload.version.length > 0)
assert.ok(payload.today.bucket, 'today 应带成本构成')
assert.ok(Array.isArray(payload.today.models), 'today 应带按模型的拆分')
assert.ok(Array.isArray(payload.today.workspaces))
for (const workspace of payload.today.workspaces) {
  assert.ok(workspace.bucket, `${workspace.name} 应带成本构成`)
  assert.equal(
    Math.round((workspace.bucket.miss + workspace.bucket.hit + workspace.bucket.out) * 1e9),
    Math.round(workspace.cost * 1e9),
    `${workspace.name} 的桶金额之和应等于总额`,
  )
}
const bucketSum = payload.today.bucket.miss + payload.today.bucket.hit + payload.today.bucket.out
assert.equal(Math.round(bucketSum * 1e9), Math.round(payload.today.cost * 1e9), '今日桶金额之和应等于今日总额')

if (payload.session !== null) {
  assert.ok(payload.session.today.bucket, 'session.today 应带成本构成')
  assert.ok(payload.session.before.bucket, 'session.before 应带成本构成')
  const split = payload.session.today.cost + payload.session.before.cost
  assert.equal(Math.round(split * 1e9), Math.round(payload.session.cost * 1e9), '今日 + 之前 应等于会话累计')
  assert.ok(Array.isArray(payload.session.models))
}

assert.equal(payload.balance.source, 'account', '应走账户服务取余额')
assert.equal(payload.balance.total, '42.50')
assert.equal(payload.balance.ok, true)

assert.ok(payload.pricing.effectiveAt <= payload.pricing.fetchedAt, '生效时刻不该晚于确认时刻')

console.log('断言全部通过')
