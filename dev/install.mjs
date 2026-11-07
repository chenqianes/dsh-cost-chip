// 把 dsh-cost-chip 接进一个 dsh profile —— 走 `dsh plugin add` 的同一条终态路径：
//
//   1. node_modules/dsh-cost-chip -> 本包目录（Windows junction，不跑 pnpm）
//   2. package.json: dependencies 里补一条 `link:` 依赖
//   3. package.json: dsh.profile.bundles 里加上本包 —— loader 据此挂载本包自带的
//      cordis.patch.yml（所以 profile 自己的 patch 层不需要再插一行，插了会撞 id）
//
// 用法:
//   node dev/install.mjs [profileDir]
//   node dev/install.mjs [profileDir] --remove
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const args = process.argv.slice(2)
const remove = args.includes('--remove')
const profileDir = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(homedir(), '.dsh', 'profiles', 'web'))

const PACKAGE = 'dsh-cost-chip'
const MANIFEST = join(profileDir, 'package.json')
const PATCH = join(profileDir, 'cordis.patch.yml')
const LINK = join(profileDir, 'node_modules', PACKAGE)
/**
 * 要建的 junction。桌面端和 `dsh web` 解析裸包名用的是不同的根：前者走
 * `profiles/node_modules` 这个共享根（`@deepseek-ai/*` 就装在那儿），后者走自己
 * profile 下的 node_modules。两处都放，装一次两边都能用。
 */
const SHARED_LINK = join(dirname(profileDir), 'node_modules', PACKAGE)
const LINKS = [...new Set([LINK, SHARED_LINK])]

/** 只备份一次：回退时拿到的是最初的原始文件。 */
function backup(path) {
  const target = `${path}.before-${PACKAGE}.bak`
  if (!existsSync(target)) writeFileSync(target, readFileSync(path))
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** 把 profile patch 层里可能残留的手工行清掉（老版本安装脚本插过）。 */
function stripManualRow(text) {
  if (!text.includes(`id: ${PACKAGE}`) && !text.includes(`name: ${PACKAGE}`)) return text
  const kept = []
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(PACKAGE)) {
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
  if (meaningful) return `${body}\n`
  const comments = body.split(/\r?\n/).filter((line) => line.trim().startsWith('#'))
  return `${comments.length > 0 ? `${comments.join('\n')}\n` : ''}[]\n`
}

if (!existsSync(MANIFEST)) {
  console.error(`不是 dsh profile 目录: ${profileDir}`)
  process.exit(1)
}

// profile 自己的 patch 层：两条路径二选一，这里始终清掉手工行。
backup(PATCH)
const patchBefore = readFileSync(PATCH, 'utf8')
const patchAfter = stripManualRow(patchBefore)
if (patchAfter !== patchBefore) writeFileSync(PATCH, patchAfter)

if (remove) {
  backup(MANIFEST)
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  if (manifest.dependencies !== undefined) delete manifest.dependencies[PACKAGE]
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE)
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const link of LINKS) {
    if (isSymlink(link) || existsSync(link)) rmSync(link, { recursive: true, force: true })
  }
  console.log('removed. 备份在 *.before-dsh-cost-chip.bak')
  process.exit(0)
}

// 1. junction —— 除了 profile 自己的 node_modules，还镜像到 profiles/ 那一层。
// 桌面端解析裸包名时走的是这个共享根（@deepseek-ai 就在那儿），两处都放才稳。
for (const link of LINKS) {
  mkdirSync(dirname(link), { recursive: true })
  if (isSymlink(link) || existsSync(link)) rmSync(link, { recursive: true, force: true })
  symlinkSync(packageDir, link, 'junction')
}

// 2 + 3. manifest
backup(MANIFEST)
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[PACKAGE] = `link:${packageDir}`
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
if (!bundles.includes(PACKAGE)) bundles.push(PACKAGE)
manifest.dsh.profile.bundles = bundles
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

console.log('profile     :', profileDir)
for (const link of LINKS) console.log('junction    :', link, '->', packageDir)
console.log('bundles     :', bundles.join(', '))
console.log('patch layer :', patchAfter !== patchBefore ? '(手工行已清理)' : '(无手工行)')
console.log('resolvable  :', LINKS.some((link) => existsSync(join(link, 'package.json'))))
