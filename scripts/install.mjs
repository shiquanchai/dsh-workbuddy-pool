#!/usr/bin/env node
/**
 * 把一个本地插件目录接进 dsh profile（与 dsh-video-skin 的 profile-link 同一路线）：
 *   1. 备份 profile 的 package.json / cordis.patch.yml
 *   2. package.json 写 dependencies[<name>] = "link:<插件目录>"
 *   3. 把 <name> 追加进 dsh.profile.bundles（成为 bundle 层，而不是往 cordis.patch.yml 插行）
 *   4. 在 <profile>/node_modules/<name> 建目录联接（junction）
 *
 * 用法：
 *   node scripts/install.mjs status   [--profile desktop] [--home <DSH_HOME>]
 *   node scripts/install.mjs install  [--profile desktop] [--home <DSH_HOME>]
 *   node scripts/install.mjs uninstall[--profile desktop] [--home <DSH_HOME>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const packageName = manifest.name

function parseArgs(argv) {
  const args = { action: 'status', profile: 'desktop', home: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--profile') args.profile = argv[(index += 1)] ?? ''
    else if (token === '--home') args.home = argv[(index += 1)] ?? ''
    else args.action = token
  }
  return args
}

function resolveHome(override) {
  if (override !== '') return path.resolve(override)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, json) {
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

function backup(profileDir) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = path.join(profileDir, `.dsh-workbuddy-pool-backup-${stamp}`)
  fs.mkdirSync(target, { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    const source = path.join(profileDir, name)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, name))
  }
  return target
}

function linkState(linkPath) {
  try {
    const stat = fs.lstatSync(linkPath)
    if (stat.isSymbolicLink()) return { exists: true, kind: 'link', target: fs.readlinkSync(linkPath) }
    if (stat.isDirectory()) return { exists: true, kind: 'directory' }
    return { exists: true, kind: 'other' }
  } catch {
    return { exists: false, kind: 'missing' }
  }
}

function makeJunction(linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkPath, packageRoot], { stdio: 'pipe' })
  } else {
    fs.symlinkSync(packageRoot, linkPath, 'dir')
  }
}

function removeJunction(linkPath) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'rmdir', linkPath], { stdio: 'pipe' })
  } else {
    fs.unlinkSync(linkPath)
  }
}

const args = parseArgs(process.argv.slice(2))
const home = resolveHome(args.home)
const profileDir = path.join(home, 'profiles', args.profile)
const profileJson = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', packageName)

if (!fs.existsSync(profileJson)) {
  console.error(`没有这个 profile：${profileDir}`)
  process.exit(1)
}

const profile = readJson(profileJson)
const linked = linkState(linkPath)
const declared = profile.dependencies?.[packageName]
const bundled = Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes(packageName)

if (args.action === 'status') {
  console.log(JSON.stringify({
    packageRoot,
    profileDir,
    link: linked,
    dependency: declared ?? null,
    bundle: bundled,
    ready: linked.exists && typeof declared === 'string' && bundled,
  }, null, 2))
  process.exit(0)
}

if (args.action === 'install') {
  if (linked.exists && linked.kind !== 'link') {
    console.error(`node_modules 里已经有一个真实目录 ${linkPath}，先手动移开再安装`)
    process.exit(1)
  }
  const backupDir = backup(profileDir)
  profile.dependencies = profile.dependencies ?? {}
  profile.dependencies[packageName] = `link:${packageRoot.replace(/\\/g, '/')}`
  profile.dsh = profile.dsh ?? {}
  profile.dsh.profile = profile.dsh.profile ?? {}
  profile.dsh.profile.bundles = Array.isArray(profile.dsh.profile.bundles) ? profile.dsh.profile.bundles : []
  if (!profile.dsh.profile.bundles.includes(packageName)) profile.dsh.profile.bundles.push(packageName)
  writeJson(profileJson, profile)
  if (!linked.exists) makeJunction(linkPath)
  console.log(`已接入 ${packageName}`)
  console.log(`  profile   : ${profileDir}`)
  console.log(`  依赖声明  : link:${packageRoot}`)
  console.log(`  bundle 层 : 已加入 dsh.profile.bundles`)
  console.log(`  node_modules: ${linkPath}`)
  console.log(`  备份      : ${backupDir}`)
  console.log('重启 dsh 后左侧栏出现 WorkBuddy 按钮。')
  process.exit(0)
}

if (args.action === 'uninstall') {
  const backupDir = backup(profileDir)
  if (profile.dependencies?.[packageName]) delete profile.dependencies[packageName]
  if (Array.isArray(profile.dsh?.profile?.bundles)) {
    profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== packageName)
  }
  writeJson(profileJson, profile)
  if (linkState(linkPath).exists) removeJunction(linkPath)
  console.log(`已移除 ${packageName}（备份：${backupDir}）`)
  process.exit(0)
}

console.error(`未知动作：${args.action}`)
process.exit(1)
