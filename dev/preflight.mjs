// 重启前的预检：尽量用 dsh 自己的校验器读一遍本包，别让一个畸形 manifest
// 把下次启动搞挂。
//
// 用法: node dev/preflight.mjs [profileDir]
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const profileDir = resolve(process.argv[2] ?? join(homedir(), '.dsh', 'profiles', 'web'))
const PACKAGE = 'dsh-cost-chip'

const problems = []
const ok = (label, value) => console.log(`  ok   ${label}${value === undefined ? '' : `: ${value}`}`)
const bad = (label, value) => {
  problems.push(`${label}${value === undefined ? '' : `: ${value}`}`)
  console.log(`  FAIL ${label}${value === undefined ? '' : `: ${value}`}`)
}

// ---- 1. manifest -----------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
if (manifest.name === PACKAGE) ok('package name', manifest.name)
else bad('package name', manifest.name)

if (manifest.type === 'module') ok('type', 'module')
else bad('type', manifest.type)

const clientExport = manifest.exports?.['./client']?.default
if (clientExport === './lib/client.js') ok('exports["./client"]', clientExport)
else bad('exports["./client"]', String(clientExport))

if (existsSync(join(packageDir, clientExport ?? ''))) ok('client bundle exists')
else bad('client bundle exists')

const clientSource = readFileSync(join(packageDir, clientExport ?? 'lib/client.js'), 'utf8')
const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(clientSource)
if (idMatch !== null && idMatch[1] === PACKAGE) ok('client bundle id', idMatch[1])
else bad('client bundle id', idMatch === null ? 'not found' : idMatch[1])

// dsh 自己的校验器（host 半会用它读 dsh.client）。读不到就退回手写检查。
let parseDshClient = null
let importError = null
const modulesEntry = join(dirname(packageDir), '.dsh-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js')
if (existsSync(modulesEntry)) {
  try {
    const imported = await import(new URL(`file://${modulesEntry.replaceAll('\\', '/')}`))
    parseDshClient = imported.parseDshClient ?? null
  } catch (error) {
    importError = String(error?.message ?? error)
  }
}
if (typeof parseDshClient === 'function') {
  try {
    const decl = parseDshClient(PACKAGE, manifest.dsh?.client)
    if (decl !== undefined && decl.platform === 'web') ok('dsh.client (真实校验器)', JSON.stringify(decl))
    else bad('dsh.client (真实校验器)', JSON.stringify(decl))
  } catch (error) {
    bad('dsh.client (真实校验器)', error.message)
  }
} else {
  const decl = manifest.dsh?.client
  console.log(`  note 真实校验器不可用: ${importError ?? 'not found'}`)
  if (typeof decl?.platform === 'string') ok('dsh.client (手写校验)', JSON.stringify(decl))
  else bad('dsh.client', JSON.stringify(decl))
}

const bundlePatch = manifest.dsh?.bundle?.patch
if (typeof bundlePatch === 'string' && existsSync(join(packageDir, bundlePatch))) ok('dsh.bundle.patch', bundlePatch)
else bad('dsh.bundle.patch', String(bundlePatch))

// ---- 2. host 半边可加载 ----------------------------------------------------
try {
  const host = await import(new URL(`file://${join(packageDir, 'lib', 'index.js').replaceAll('\\', '/')}`))
  if (host.name === PACKAGE && typeof host.apply === 'function' && Array.isArray(host.inject)) {
    ok('host 导出', `${host.name} inject=[${host.inject.join(',')}]`)
  } else {
    bad('host 导出')
  }
} catch (error) {
  bad('host 导出', error.message)
}

// ---- 3. profile 侧 --------------------------------------------------------
const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []
if (bundles.includes(PACKAGE)) ok('bundles 包含本包')
else bad('bundles 包含本包', bundles.join(','))

const dep = profileManifest.dependencies?.[PACKAGE]
if (typeof dep === 'string' && dep.startsWith('link:')) ok('dependencies', dep)
else bad('dependencies', String(dep))

const link = join(profileDir, 'node_modules', PACKAGE)
const sharedLink = join(dirname(profileDir), 'node_modules', PACKAGE)
const resolvable = [link, sharedLink].filter((candidate) => existsSync(join(candidate, 'package.json')))
if (resolvable.length > 0) ok('node_modules 可解析', resolvable.length === 2 ? 'profile + 共享根' : resolvable[0])
else bad('node_modules 可解析')

for (const candidate of resolvable) {
  if (lstatSync(candidate).isSymbolicLink()) ok('junction 指向', `${candidate} -> ${resolve(dirname(candidate), readlinkSync(candidate))}`)
}

// ---- 4. patch 层不重复 -----------------------------------------------------
const patchText = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
if (patchText.includes(PACKAGE)) bad('profile patch 层重复挂载', '同 id 会撞车，应删掉')
else ok('profile patch 层无重复')

console.log('')
if (problems.length === 0) {
  console.log('preflight OK —— 可以重启')
} else {
  console.log(`preflight 有 ${problems.length} 个问题：`)
  for (const problem of problems) console.log('  -', problem)
  process.exitCode = 1
}
