// 单元/回归测试：增量解码、计价、价表时间线。
//
//   node dev/test-core.mjs [一份真实会话日志]
//
// 不传日志就用 $DSH_HOME/sessions 里最大的那份。测试只往临时目录写文件，
// 不碰会话日志本身。
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { __test } from '../lib/index.js'

const { decodeFrames, recordsOf, fileCache, mergePricingEntry, priceRecord, newTotals, accumulate, finish } = __test

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const scratch = mkdtempSync(join(tmpdir(), 'dsh-cost-chip-test-'))
const tests = []
const test = (name, body) => tests.push({ name, body })

// ---------------------------------------------------------------------------
// 1. 增量续读：offset 落在帧边界，只解新追加的部分
// ---------------------------------------------------------------------------
test('synthetic: 续读只解新追加的帧，offset 落在帧边界', async () => {
  const frameOne = zstdCompressSync(Buffer.from('{"type":"session","cwd":"D:\\\\x"}\n'))
  const frameTwo = zstdCompressSync(Buffer.from(
    '{"type":"assistant/message","time":1,"data":{"usage":{"inputTokens":1,"cacheReadTokens":2,"outputTokens":3},'
    + '"message":{"source":{"provider":"p","model":"m"}}}}\n',
  ))
  assert.ok(frameOne.subarray(0, 4).equals(MAGIC), 'frame 应以 zstd 魔数开头')
  const path = join(scratch, 'synthetic.v4.jsonl.zstd')
  writeFileSync(path, frameOne)
  fileCache.delete(path)

  const first = await recordsOf(path)
  assert.equal(first.length, 0, '第一帧是会话头，没有计费记录')
  assert.equal(fileCache.get(path).offset, frameOne.length, 'offset 应正好停在第一帧结束处')

  appendFileSync(path, frameTwo)
  const second = await recordsOf(path)
  assert.equal(second.length, 1, '追加第二帧后应解析出 1 条记录')
  assert.deepEqual(second[0].slice(1), ['p:m', 1, 2, 3])
  assert.equal(fileCache.get(path).offset, frameOne.length + frameTwo.length)
})

// ---------------------------------------------------------------------------
// 2. 半帧不该被吞掉，补齐后要能读出来
// ---------------------------------------------------------------------------
test('synthetic: 半帧不解，补齐后自动接上', async () => {
  const frame = zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: 'assistant/message',
    time: 7,
    data: { usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 0 }, message: { source: { provider: 'p', model: 'm' } } },
  })}\n`))
  const path = join(scratch, 'torn.v4.jsonl.zstd')
  writeFileSync(path, frame.subarray(0, frame.length - 5))
  fileCache.delete(path)
  assert.equal((await recordsOf(path)).length, 0, '缺一块的帧读不出来')

  writeFileSync(path, frame)
  const whole = await recordsOf(path)
  assert.equal(whole.length, 1, '补齐后应读出 1 条')
  assert.equal(fileCache.get(path).offset, frame.length)
})

// ---------------------------------------------------------------------------
// 2b. 文件被截断/重写：不能留着上一轮的记录
// ---------------------------------------------------------------------------
test('synthetic: 文件变短时退回全量，旧记录不残留', async () => {
  const line = (time) => zstdCompressSync(Buffer.from(`${JSON.stringify({
    type: 'assistant/message',
    time,
    data: { usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 }, message: { source: { provider: 'p', model: 'm' } } },
  })}\n`))
  const one = line(1)
  const two = line(2)
  const path = join(scratch, 'shrink.v4.jsonl.zstd')
  writeFileSync(path, Buffer.concat([one, two]))
  fileCache.delete(path)
  assert.equal((await recordsOf(path)).length, 2)

  writeFileSync(path, one)
  const after = await recordsOf(path)
  assert.equal(after.length, 1, '截断后只剩 1 条')
  assert.deepEqual(after[0], [1, 'p:m', 1, 0, 0])
})

// ---------------------------------------------------------------------------
// 3. 真实日志：任意字节边界地长回去，记录必须始终是最终结果的前缀
// ---------------------------------------------------------------------------
test('real log: 任意字节增长不产生重复/错乱记录', async () => {
  const source = process.argv[2] ?? biggestLog()
  // CI 上没有 $DSH_HOME，跳过这条；合成的用例仍然覆盖同一套解码路径。
  if (source === null) return 'skip'
  const buffer = readFileSync(source)
  const path = join(scratch, 'real.v4.jsonl.zstd')

  writeFileSync(path, buffer)
  fileCache.delete(path)
  const reference = await recordsOf(path)
  assert.ok(reference.length > 0, `${source} 里应有计费记录`)

  const chunk = 256 * 1024
  let steps = 0
  fileCache.delete(path)
  writeFileSync(path, buffer.subarray(0, 0))
  for (let end = chunk; end < buffer.length; end += chunk) {
    writeFileSync(path, buffer.subarray(0, end))
    const partial = await recordsOf(path)
    assert.ok(partial.length <= reference.length, '中间态不该比最终结果多')
    for (let index = 0; index < partial.length; index += 1) {
      assert.deepEqual(partial[index], reference[index], `第 ${index} 条记录在 ${end} 字节处就不一致`)
    }
    steps += 1
  }
  writeFileSync(path, buffer)
  assert.deepEqual(await recordsOf(path), reference, '长到完整文件后应与一次性解码完全一致')
  console.log(`     ${source.split(/[\\/]/).at(-1)} · ${(buffer.length / 1048576).toFixed(2)} MiB · ${reference.length} 条 · ${steps} 个中间态`)
})

// ---------------------------------------------------------------------------
// 4. 计价：三个桶的金额之和等于总额，且与手算一致
// ---------------------------------------------------------------------------
test('pricing: 桶金额之和 == 总额，且与手算一致', () => {
  const peak = { days: [1, 2, 3, 4, 5], windows: [[9, 12], [14, 18]], holidaysOffPeak: true }
  const page = {
    at: 0,
    currency: 'CNY',
    models: { flash: { hit: { off: 0.02, peak: 0.04 }, miss: { off: 1, peak: 2 }, out: { off: 4, peak: 8 } } },
    peak,
    aliases: { 'deepseek-flash': 'flash' },
  }
  // 2026-11-04T02:00Z = 北京时间周三 10:00，落在高峰窗口
  const peakTime = Date.UTC(2026, 10, 4, 2, 0, 0)
  const record = [peakTime, 'p:flash', 1_000_000, 2_000_000, 500_000]
  const priced = priceRecord(record, [page], new Set())
  assert.equal(priced.miss, 2, '1M 未命中 @ 高峰 2 元')
  assert.equal(priced.hit, 0.08, '2M 命中 @ 高峰 0.04 元')
  assert.equal(priced.out, 4, '0.5M 输出 @ 高峰 8 元')
  assert.equal(priced.cost, 6.08)

  const totals = newTotals()
  accumulate(totals, record, priced)
  const done = finish(totals)
  assert.equal(done.cost, 6.08)
  assert.equal(done.bucket.miss + done.bucket.hit + done.bucket.out, done.cost)
  assert.deepEqual(done.models.map((entry) => entry.model), ['flash'])

  const holiday = priceRecord([peakTime, 'p:flash', 1_000_000, 0, 0], [page], new Set(['2026-11-04']))
  assert.equal(holiday.miss, 1, '节假日全天按空闲价 1 元')
})

// ---------------------------------------------------------------------------
// 5. 价表时间线：确认同步不能推动生效时刻（调价前历史会被静默重算的回归）
// ---------------------------------------------------------------------------
test('pricing timeline: 确认同步不改写 at，历史金额不变', () => {
  const before = { at: 1000, checkedAt: 1000, currency: 'CNY', models: { flash: { hit: { off: 1 }, miss: { off: 1 }, out: { off: 1 } } }, peak: {}, aliases: {} }
  const afterPage = { at: 7000, currency: 'CNY', models: { flash: { hit: { off: 2 }, miss: { off: 2 }, out: { off: 2 } } }, peak: {}, aliases: {} }

  let timeline = mergePricingEntry([before], { ...before }, 2000, 0)
  assert.equal(timeline.length, 1, '价没变不该新增条目')
  assert.equal(timeline[0].at, 1000, 'at 是生效时刻，不能动')
  assert.equal(timeline[0].checkedAt, 2000, 'checkedAt 才是确认时刻')

  timeline = mergePricingEntry(timeline, afterPage, 7000, 0)
  assert.equal(timeline.length, 2)
  assert.equal(timeline[1].at, 7000)

  timeline = mergePricingEntry(timeline, afterPage, 9000, 0)
  assert.equal(timeline.length, 2, '价没变不该新增条目')
  assert.equal(timeline[1].at, 7000, '确认同步不能把生效时刻往后推')
  assert.equal(timeline[1].checkedAt, 9000)

  const at7500 = timeline.filter((entry) => entry.at <= 7500).at(-1)
  assert.equal(at7500.at, 7000, '7500 的历史调用必须落在调价后的价表上')
  assert.equal(at7500.models.flash.miss.off, 2)
})

// ---------------------------------------------------------------------------
// 6. 解码器边界
// ---------------------------------------------------------------------------
test('decodeFrames: 完整帧给出 end，半帧让 end 停住', () => {
  const one = zstdCompressSync(Buffer.from('a\n'))
  const two = zstdCompressSync(Buffer.from('b\n'))

  const whole = decodeFrames(Buffer.concat([one, two]))
  assert.equal(whole.text, 'a\nb\n')
  assert.equal(whole.end, one.length + two.length)

  const torn = decodeFrames(Buffer.concat([one, two.subarray(0, two.length - 2)]))
  assert.equal(torn.text, 'a\n')
  assert.equal(torn.end, one.length, '半帧的起点就是下次续读的位置')

  assert.deepEqual(decodeFrames(Buffer.alloc(0)), { text: '', end: 0 })
})

function biggestLog() {
  const root = join(homedir(), '.dsh', 'sessions')
  let best = null
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    for (const session of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(root, workspace.name, session.name)
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.startsWith('session.') || !file.name.includes('.jsonl')) continue
        const path = join(dir, file.name)
        const size = statSync(path).size
        if (best === null || size > best.size) best = { path, size }
      }
    }
  }
  return best === null ? null : best.path
}

let failed = 0
let skipped = 0
for (const { name, body } of tests) {
  try {
    const outcome = await body()
    if (outcome === 'skip') {
      skipped += 1
      console.log(`skip ${name}`)
      continue
    }
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n${error?.stack ?? error}`)
  }
}
rmSync(scratch, { recursive: true, force: true })
const summary = `${tests.length - failed - skipped}/${tests.length} passed`
console.log(`\n${summary}${skipped > 0 ? ` (${skipped} skipped)` : ''}`)
process.exit(failed === 0 ? 0 : 1)
