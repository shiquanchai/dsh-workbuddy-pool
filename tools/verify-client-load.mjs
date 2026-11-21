#!/usr/bin/env node
/**
 * 用 $DSH_HOME/.credentials.yaml 里的 browser-session 密钥签一张 dsh web 的
 * 会话 cookie，然后拉首页 HTML，确认插件是否进了浏览器的启动图、client.js 是否可取。
 *
 *   node tools/verify-client-load.mjs [--url http://127.0.0.1:12465]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const credFile = path.join(home, '.credentials.yaml')
const url = (() => {
  const i = process.argv.indexOf('--url')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:12465'
})()

function readSecret() {
  const text = fs.readFileSync(credFile, 'utf8')
  const start = text.indexOf('client-connection/browser-session')
  const slice = start >= 0 ? text.slice(start, start + 400) : text
  const match = /secret:\s*([A-Za-z0-9_-]{40,})/.exec(slice)
  if (match === null) throw new Error('没在 .credentials.yaml 里找到 browser-session secret')
  return match[1]
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
const secret = Buffer.from(readSecret(), 'base64')
const target = new URL(url)
const authority = target.host
const cookieName = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
const issuedAt = Date.now()
const expiresAt = issuedAt + 30 * 24 * 3600 * 1000
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
const sig = b64u(createHmac('sha256', secret).update(body).digest())
const cookie = `${cookieName}=v1.${body}.${sig}`

const response = await fetch(new URL('/', target), { headers: { cookie, accept: 'text/html' } })
const html = await response.text()
console.log(`index: ${response.status} len=${html.length}`)
const bootMatch = /__DSH_BOOT__\s*=\s*(\{[\s\S]*?\});<\/script>/.exec(html)
if (bootMatch === null) {
  console.log(html.slice(0, 400))
  process.exit(1)
}
const boot = JSON.parse(bootMatch[1])
const ids = (boot.modules ?? []).map((row) => row[0])
console.log(`boot modules: ${ids.length}`)
const mine = ids.filter((id) => `${id}`.includes('workbuddy'))
console.log(`workbuddy in boot graph: ${mine.length > 0 ? mine.join(', ') : 'NO'}`)

const row = (boot.modules ?? []).find((entry) => `${entry[0]}`.includes('workbuddy'))
if (row !== undefined) {
  console.log(JSON.stringify(row))
  const rev = row[1]
  const combo = `/plugins/${row[0]}/client.js?rev=${rev}`
  const asset = await fetch(new URL(combo, target), { headers: { cookie } })
  const text = await asset.text()
  console.log(`client.js: ${asset.status} len=${text.length} hasModuleLoader=${text.includes('__ModuleLoader__')} hasSidebar=${text.includes('sidebar.panellist')}`)
}
if (!fs.existsSync(path.join(home, 'workbuddy-pool', 'pool.json'))) console.log('pool.json 还不存在')
