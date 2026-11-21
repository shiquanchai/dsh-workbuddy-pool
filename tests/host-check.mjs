#!/usr/bin/env node
/**
 * 宿主半侧的离线体检：用一个假的 cordis ctx 把 lib/index.js 装起来，
 * 直接打它的 HTTP 接口，验证账号导入 / 签到 / 状态聚合。
 *
 *   node tests/host-check.mjs
 *
 * 只写临时目录，不动真实账号池；会用真实 token 调 WorkBuddy 官方接口。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tempDir = path.join(root, '.test-data')
fs.rmSync(tempDir, { recursive: true, force: true })
fs.mkdirSync(tempDir, { recursive: true })

// 造一份假的反代日志：两条会话 + 一条未归因，供「每日/会话」聚合用例断言。
const usageLog = path.join(tempDir, 'usage.jsonl')
const nowIso = new Date().toISOString()
const earlier = new Date(Date.now() - 3600000).toISOString()
const usageRows = [
  { ts: earlier, session_id: 'session-test-alpha', account_id: 'acc-test', model: 'glm-5.3-flash', status: 200, stream: false, prompt_tokens: 120, completion_tokens: 40, credit: 0.2 },
  { ts: nowIso, session_id: 'session-test-alpha', account_id: 'acc-test', model: 'glm-5.3-flash', status: 200, stream: true, prompt_tokens: 300, completion_tokens: 150, credit: 0.5 },
  { ts: nowIso, session_id: 'session-test-beta', account_id: 'acc-test', model: 'deepseek-v4.1-flash', status: 200, stream: false, prompt_tokens: 80, completion_tokens: 20, credit: 0.1 },
  { ts: nowIso, session_id: '', account_id: 'acc-test', model: 'hy4flash-free', status: 200, stream: false, prompt_tokens: 10, completion_tokens: 5, credit: 0 },
]
fs.writeFileSync(usageLog, usageRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

const { apply } = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

let handler = null
const disposers = []
const listeners = new Map()
const logs = []

const ctx = {
  logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line), debug: () => {} },
  effect(fn, label) {
    const dispose = fn()
    disposers.push({ label, dispose })
    return () => { if (typeof dispose === 'function') dispose() }
  },
  on(event, listener) {
    listeners.set(event, listener)
    return () => listeners.delete(event)
  },
  get() { return undefined },
  webServer: {
    register(route) {
      handler = route.handler
      return () => { handler = null }
    },
  },
}

apply(ctx, {
  dataDir: tempDir,
  autoHarvest: false,
  checkinAt: '23:59',
  snapshotMinutes: 30,
  usageLog,
})

if (handler === null) {
  console.error('FAIL: 没注册到 /workbuddy-pool 路由')
  process.exit(1)
}

function makeReq(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:12465', 'content-type': 'application/json' }
  return stream
}

function makeRes() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {} },
    write(chunk) { chunks.push(Buffer.from(chunk)) },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      this.body = Buffer.concat(chunks).toString('utf8')
      this.done?.()
    },
    on() {},
  }
}

async function call(method, url, body) {
  const req = makeReq(method, url, body)
  const res = makeRes()
  const done = new Promise((resolve) => { res.done = resolve })
  await handler(req, res)
  await done
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, text: res.body }
}

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

/* 1. 空池状态 */
const empty = await call('GET', '/workbuddy-pool/api/status')
check('空池 /status 200', empty.status === 200, `status=${empty.status}`)
check('空池 accounts 为空', empty.json?.pool?.accounts?.length === 0)

/* 2. 导入 token */
const tokenFile = 'E:\\dshwork\\work2\\tools\\.wb-token'
let imported = null
if (fs.existsSync(tokenFile)) {
  const token = fs.readFileSync(tokenFile, 'utf8').trim()
  imported = await call('POST', '/workbuddy-pool/api/accounts', { token, label: '体检账号' })
  check('导入 token 200', imported.status === 200, imported.json?.error || '')
  check('导入返回账号 id', typeof imported.json?.account?.id === 'string')
  check('导入后拿到余额', Number.isFinite(Number(imported.json?.account?.balanceTotal)), String(imported.json?.account?.balanceTotal))
} else {
  console.log('SKIP  没有现成 token 文件，跳过导入')
}

/* 3. 状态聚合 */
const status = await call('GET', '/workbuddy-pool/api/status')
check('/status 有账号', status.json?.pool?.accounts?.length === 1)
check('总额有值', Number.isFinite(Number(status.json?.totals?.balance)), String(status.json?.totals?.balance))
check('账号含签到状态', status.json?.pool?.accounts?.[0]?.checkin !== undefined)

/* 4. 签到（当天已领过时应返回 already，并带出今天已领的积分） */
const checkin = await call('POST', '/workbuddy-pool/api/checkin', {})
check('签到接口 200', checkin.status === 200, JSON.stringify(checkin.json?.results?.[0] ?? null))
const checkinRow = (checkin.json?.results ?? [])[0] ?? {}
check('已签到时能给出今日已签积分', Number(checkinRow.todayCredit) > 0, `todayCredit=${checkinRow.todayCredit} status=${checkinRow.status}`)

/* 5. 用量聚合 */
const usage = await call('GET', '/workbuddy-pool/api/usage?days=14')
check('用量接口 200', usage.status === 200)
check('用量接口返回每日表', Array.isArray(usage.json?.days))

/* 5b. 状态：只给 7 天 + 本周序列 */
const status2 = await call('GET', '/workbuddy-pool/api/status')
check('daily 最多 7 天', Array.isArray(status2.json?.daily) && status2.json.daily.length <= 7, `len=${status2.json?.daily?.length}`)
check('带本周序列', Array.isArray(status2.json?.week?.days) && status2.json.week.days.length >= 1)

/* 5c. 会话统计：详情 / 删除 / 恢复 */
const firstSession = (status2.json?.sessions ?? [])[0]
if (firstSession !== undefined) {
  const detail = await call('GET', `/workbuddy-pool/api/sessions/${encodeURIComponent(firstSession.id)}`)
  check('会话详情 200', detail.status === 200, detail.json?.error || '')
  check('会话详情带四个统计量', detail.json?.session?.requests !== undefined && detail.json?.corpus?.prompt !== undefined)

  const hide = await call('POST', `/workbuddy-pool/api/sessions/${encodeURIComponent(firstSession.id)}/hide`)
  check('删除会话统计 200', hide.status === 200 && hide.json?.ok === true)
  const afterHide = await call('GET', '/workbuddy-pool/api/status')
  const stillThere = (afterHide.json?.sessions ?? []).some((row) => row.id === firstSession.id)
  check('删除后会话从统计里消失', stillThere === false)
  check('删除后状态里能看到隐藏列表', (afterHide.json?.pool?.hiddenSessions ?? []).includes(firstSession.id))

  const restore = await call('POST', '/workbuddy-pool/api/sessions/restore')
  check('恢复全部 200', restore.status === 200 && restore.json?.ok === true)
  const afterRestore = await call('GET', '/workbuddy-pool/api/status')
  check('恢复后会话回到统计里', (afterRestore.json?.sessions ?? []).some((row) => row.id === firstSession.id))
} else {
  console.log('SKIP  日志里没有会话记录，跳过会话统计三项')
}

/* 6. 请求头钩子 */
const headerListener = listeners.get('llm-pi-ai/request-headers')
let headerOk = false
if (typeof headerListener === 'function') {
  const headers = new Map()
  const fakeHeaders = { set: (key, value) => headers.set(key, value) }
  headerListener({ provider: 'workbuddy', model: 'glm-5.3-flash', sessionId: 'session-test', purpose: 'chat' }, fakeHeaders, () => fakeHeaders)
  headerOk = headers.get('x-wb-session-id') === 'session-test'
}
check('request-headers 钩子注入会话号', headerOk)

/* 7. ON/OFF 只影响积分消耗，不影响签到与刷新 */
const offId = status.json?.pool?.accounts?.[0]?.id
if (typeof offId === 'string') {
  const toggled = await call('POST', `/workbuddy-pool/api/accounts/${offId}/toggle`, { enabled: false })
  check('账号可以切 OFF', toggled.status === 200 && toggled.json?.enabled === false)
  const checkinOff = await call('POST', '/workbuddy-pool/api/checkin', {})
  check('OFF 账号仍然签到', (checkinOff.json?.results ?? []).some((row) => row.accountId === offId), JSON.stringify(checkinOff.json?.results?.[0] ?? null))
  const refreshOff = await call('POST', '/workbuddy-pool/api/refresh', {})
  check('OFF 账号仍然刷新余额', (refreshOff.json?.results ?? []).some((row) => row.accountId === offId))
  await call('POST', `/workbuddy-pool/api/accounts/${offId}/toggle`, { enabled: true })
}

/* 8. 删除账号 */
const id = status.json?.pool?.accounts?.[0]?.id
if (typeof id === 'string') {
  const removed = await call('DELETE', `/workbuddy-pool/api/accounts/${id}`)
  check('删除账号 200', removed.status === 200 && removed.json?.ok === true)
}

for (const { dispose, label } of disposers.reverse()) {
  try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：', failed.map((row) => row.name).join('，'))
  process.exit(1)
}
console.log(`日志：\n${logs.slice(-12).join('\n')}`)
