// 在 profile 的 patch 层插/删一行（用于试热挂载），并与 bundle 列表互斥。
// 用法: node dev/patch-row.mjs <profileDir> [--remove]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PACKAGE = 'dsh-cost-chip'
const args = process.argv.slice(2)
const remove = args.includes('--remove')
const profileDir = resolve(args.find((arg) => !arg.startsWith('--')) ?? '.')
const PATCH = join(profileDir, 'cordis.patch.yml')
const MANIFEST = join(profileDir, 'package.json')

if (!existsSync(PATCH)) {
  console.error('no patch file:', PATCH)
  process.exit(1)
}

const before = readFileSync(PATCH, 'utf8')
if (remove) {
  const kept = []
  let dropNext = false
  for (const line of before.split(/\r?\n/)) {
    if (line.includes(`id: ${PACKAGE}`)) continue
    if (line.includes(`name: ${PACKAGE}`)) {
      dropNext = true
      if (kept.length > 0 && kept[kept.length - 1].trim() === '- insert:') kept.pop()
      continue
    }
    kept.push(line)
  }
  const body = kept.join('\n').replace(/\s*$/, '')
  const meaningful = body.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed !== '[]'
  })
  const text = meaningful
    ? `${body}\n`
    : `${body.split(/\r?\n/).filter((line) => line.trim().startsWith('#')).join('\n')}\n[]\n`
  writeFileSync(PATCH, text)
  console.log('patch row removed')
} else {
  if (before.includes(`id: ${PACKAGE}`)) {
    console.log('patch row already present')
  } else {
    const block = `- insert:\n    - id: ${PACKAGE}\n      name: ${PACKAGE}\n`
    const body = before.replace(/\s*$/, '')
    const meaningful = body.split(/\r?\n/).some((line) => {
      const trimmed = line.trim()
      return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed !== '[]'
    })
    let text
    if (meaningful) {
      text = `${body}\n${block}`
    } else {
      const comments = body.split(/\r?\n/).filter((line) => line.trim().startsWith('#'))
      text = `${comments.length > 0 ? `${comments.join('\n')}\n` : ''}${block}`
    }
    writeFileSync(PATCH, text)
    console.log('patch row inserted')
  }
}

// 两套挂载方式互斥：patch 行在时，bundle 列表里不能同时有它。
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = remove ? [...bundles] : bundles.filter((name) => name !== PACKAGE)
  if (remove && !next.includes(PACKAGE)) next.push(PACKAGE)
  if (JSON.stringify(next) !== JSON.stringify(bundles)) {
    manifest.dsh.profile.bundles = next
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log('bundles:', next.join(', '))
  }
}
