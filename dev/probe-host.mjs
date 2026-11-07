// 离线验证 host 半边：假 ctx + 假 req/res，跑真实会话日志。
// 用法: node dev/probe-host.mjs [sessionId]
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const host = require('../lib/index.js')

let captured = null
const ctx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  get: () => undefined,
  webServer: {
    register: (spec) => {
      captured = spec
      return () => {}
    },
  },
}

host.apply(ctx)
if (captured === null) throw new Error('route not registered')

const sessionId = process.argv[2] ?? ''
const request = {
  url: `/api/dsh-cost-chip/summary${sessionId ? `?session=${sessionId}` : ''}`,
  headers: {},
  socket: { localPort: 0 },
}

const chunks = []
const response = {
  writeHead: (status) => {
    response.status = status
  },
  end: (body) => chunks.push(body),
}

await captured.handler(request, response)
const payload = JSON.parse(chunks.join(''))
console.log(JSON.stringify(payload, null, 1).slice(0, 4000))
