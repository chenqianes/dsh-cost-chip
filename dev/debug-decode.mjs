// 复现 decodeFrames 在某个日志上的行为，定位「文件明明有内容却读到 0 条」。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
const buf = readFileSync(path)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const starts = []
for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i)
console.log('frames by magic:', starts.length, 'size', buf.length)

// A. 现有算法（逐帧、要求以换行收尾）
const parts = []
let index = 0
let stopped = null
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
    if (!candidate.endsWith('\n')) {
      stopped = { at: index, reason: 'no-trailing-newline', bytes: end - start, head: candidate.slice(0, 80) }
      break
    }
    text = candidate
    break
  }
  if (text === null) {
    if (stopped === null) stopped = { at: index, reason: 'all-boundaries-failed' }
    break
  }
  parts.push(text)
  index = next
}
const textA = parts.join('')
console.log('A consumed frames:', parts.length, 'chars', textA.length)
console.log('A stopped:', JSON.stringify(stopped))
console.log('A assistant/message:', (textA.match(/"assistant\/message"/g) ?? []).length)

// B. 暴力：每个魔数到下一个魔数独立解，忽略换行判断
let textB = ''
let failed = 0
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length
  try {
    textB += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
  } catch {
    failed += 1
  }
}
console.log('B chars', textB.length, 'failed frames', failed)
console.log('B assistant/message:', (textB.match(/"assistant\/message"/g) ?? []).length)
