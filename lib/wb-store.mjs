/**
 * WorkBuddy 账号池：数据层。
 *
 * 这里只做四件事，全部无第三方依赖，便于脱离 dsh 直接用 node 跑：
 *   1. 账号池文件的读写（原子写，token / 余额 / 签到记录 / 余额快照）
 *   2. WorkBuddy 开放接口调用（账号列表、积分总览、签到状态、签到领取）
 *   3. 从 WorkBuddy 桌面端进程内存抓当前登录 token（导入账号 / 续期）
 *   4. 读取反代 usage.jsonl，按日 / 按会话 / 按模型聚合积分消耗
 *
 * 接口地址、字段名全部来自 WorkBuddy 5.11.3 客户端（app.asar）的实际调用点，
 * 并已用真实 token 验证过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const DEFAULT_GATEWAY = 'https://copilot.tencent.com'
export const POOL_VERSION = 1

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** 本地时区的 YYYY-MM-DD（账号按本地日期签到，不能用 UTC 切日）。 */
export function dayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function round2(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.round(v * 100) / 100
}

export function maskToken(token) {
  const t = typeof token === 'string' ? token : ''
  if (t.length < 24) return t ? '***' : ''
  return `${t.slice(0, 10)}…${t.slice(-6)}`
}

export function maskPhone(phone) {
  const p = typeof phone === 'string' ? phone : ''
  if (p.length < 7) return p
  return `${p.slice(0, 3)}****${p.slice(-4)}`
}

/* ------------------------------------------------------------------ *
 * JWT
 * ------------------------------------------------------------------ */
export function jwtPayload(token) {
  if (typeof token !== 'string' || token.split('.').length < 2) return null
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** token 的粗粒度状态：是否像 WorkBuddy JWT、何时过期、剩余多少天。 */
export function tokenState(token) {
  const payload = jwtPayload(token)
  if (payload === null) return { valid: false, exp: 0, leftDays: 0, phone: '', nickname: '', sub: '' }
  const exp = Number(payload.exp) || 0
  const leftSeconds = exp - Math.floor(Date.now() / 1000)
  const isWorkbuddy = `${payload.iss || ''}`.includes('workbuddy')
  return {
    valid: isWorkbuddy && leftSeconds > 0,
    exp,
    leftDays: Math.max(0, Math.round((leftSeconds / 86400) * 10) / 10),
    phone: typeof payload.preferred_username === 'string' ? payload.preferred_username : '',
    nickname: typeof payload.nickname === 'string' ? payload.nickname : '',
    sub: typeof payload.sub === 'string' ? payload.sub : '',
  }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
export function resolveConfig(config = {}) {
  const home = config.home || dshHome()
  const dataDir = config.dataDir || path.join(home, 'workbuddy-pool')
  const checkinAt = typeof config.checkinAt === 'string' && /^\d{1,2}:\d{2}$/.test(config.checkinAt)
    ? config.checkinAt
    : '00:05'
  const [hour, minute] = checkinAt.split(':').map((v) => Number(v))
  return {
    home,
    dataDir,
    poolFile: config.poolFile || path.join(dataDir, 'pool.json'),
    logFile: config.logFile || path.join(dataDir, 'pool.log'),
    // 默认读本插件数据目录里的 usage.jsonl；接了 wb-proxy 时把它指向代理的日志
    // （例如 WB_USAGE_LOG=D:\wb-proxy\logs\usage.jsonl）。
    usageLog: config.usageLog || process.env.WB_USAGE_LOG || path.join(dataDir, 'usage.jsonl'),
    gateway: (config.gateway || process.env.WB_GATEWAY || DEFAULT_GATEWAY).replace(/\/+$/, ''),
    requestTimeoutMs: Number(config.requestTimeoutMs) || 20000,
    enabled: config.enabled !== false,
    checkinAt,
    checkinHour: Number.isFinite(hour) ? hour : 0,
    checkinMinute: Number.isFinite(minute) ? minute : 5,
    snapshotMinutes: Math.max(5, Number(config.snapshotMinutes) || 30),
    autoHarvest: config.autoHarvest !== false,
    harvestMinTokenDays: Number(config.harvestMinTokenDays) || 3,
    harvestScript: config.harvestScript || path.join(PKG_ROOT, 'scripts', 'wb-token.ps1'),
    harvestAllScript: config.harvestAllScript || path.join(PKG_ROOT, 'scripts', 'wb-tokens-all.ps1'),
    powershell: config.powershell || 'powershell.exe',
  }
}

/* ------------------------------------------------------------------ *
 * 账号池文件
 * ------------------------------------------------------------------ */
function emptyPool() {
  return {
    version: POOL_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    accounts: [],
    checkins: [],
    snapshots: [],
    /** 被用户「删除统计」的会话 key（session id 或 unattributed:日期），只影响统计，不动会话本身。 */
    hiddenSessions: {},
    scheduler: {
      lastTickAt: null,
      lastCheckinRunAt: null,
      lastSnapshotAt: null,
      lastError: null,
    },
  }
}

export function readPool(cfg) {
  let text
  try {
    text = fs.readFileSync(cfg.poolFile, 'utf8')
  } catch {
    return emptyPool()
  }
  try {
    const parsed = JSON.parse(text)
    const pool = { ...emptyPool(), ...parsed }
    if (!Array.isArray(pool.accounts)) pool.accounts = []
    if (!Array.isArray(pool.checkins)) pool.checkins = []
    if (!Array.isArray(pool.snapshots)) pool.snapshots = []
    if (typeof pool.hiddenSessions !== 'object' || pool.hiddenSessions === null || Array.isArray(pool.hiddenSessions)) pool.hiddenSessions = {}
    if (typeof pool.scheduler !== 'object' || pool.scheduler === null) pool.scheduler = emptyPool().scheduler
    return pool
  } catch {
    return emptyPool()
  }
}

export function writePool(cfg, pool) {
  pool.updatedAt = nowIso()
  fs.mkdirSync(path.dirname(cfg.poolFile), { recursive: true })
  const tmp = `${cfg.poolFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(pool, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, cfg.poolFile)
  return pool
}

/**
 * 跨进程的账号池文件锁：插件（dsh 宿主）、命令行、反代都会改同一份 pool.json，
 * 没有锁时后写的一方会用旧副本覆盖前一方（改备注名被回滚就是这么来的）。
 * 用 O_EXCL 建锁文件实现，超时视为陈旧锁直接清掉。
 */
export async function withPoolLock(cfg, task) {
  const lockPath = `${cfg.poolFile}.lock`
  fs.mkdirSync(path.dirname(cfg.poolFile), { recursive: true })
  const deadline = Date.now() + 20000
  let fd = null
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const stat = fs.statSync(lockPath)
        stale = Date.now() - stat.mtimeMs > 30000
      } catch {
        stale = true
      }
      if (stale) {
        try { fs.unlinkSync(lockPath) } catch { /* 别人刚删掉 */ }
        continue
      }
      if (Date.now() > deadline) {
        try { fs.unlinkSync(lockPath) } catch { /* ignore */ }
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 45))
    }
  }
  try {
    return await task()
  } finally {
    try { fs.closeSync(fd) } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath) } catch { /* ignore */ }
  }
}

export function appendLog(cfg, line) {
  try {
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true })
    fs.appendFileSync(cfg.logFile, `[${nowIso()}] ${line}\n`, 'utf8')
  } catch {
    /* 日志永不影响主流程 */
  }
}

/** 对外展示用：脱敏后的账号池。 */
export function publicPool(cfg, pool) {
  return {
    file: cfg.poolFile,
    dataDir: cfg.dataDir,
    activeAccountId: pool.activeAccountId ?? pool.accounts[0]?.id ?? null,
    accounts: pool.accounts.map((account) => {
      const state = tokenState(account.token)
      return {
        ...account,
        token: undefined,
        tokenMask: maskToken(account.token),
        tokenExp: state.exp ? new Date(state.exp * 1000).toISOString() : null,
        tokenLeftDays: state.leftDays,
        tokenValid: state.valid,
        phoneMask: maskPhone(account.phone),
        balanceTotal: account.balance?.total ?? null,
        balanceAt: account.balance?.at ?? null,
        balanceGroups: account.balance?.groups ?? [],
        plan: account.plan || account.balance?.plan || '',
      }
    }),
  }
}

/* ------------------------------------------------------------------ *
 * 账号增删改
 * ------------------------------------------------------------------ */
export function upsertAccount(pool, { token, label, source = 'manual' }) {
  const trimmed = typeof token === 'string' ? token.trim().replace(/^Bearer\s+/i, '') : ''
  const state = tokenState(trimmed)
  if (state.sub === '' && state.phone === '') {
    throw Object.assign(new Error('不是有效的 WorkBuddy token（JWT 解析失败）'), { status: 400 })
  }
  const identity = state.sub || state.phone
  const existing = pool.accounts.find((account) => {
    const other = tokenState(account.token)
    return (other.sub && other.sub === state.sub) || (other.phone && other.phone === state.phone)
  })
  const at = nowIso()
  if (existing) {
    existing.token = trimmed
    existing.exp = state.exp
    existing.uid = existing.uid || state.sub
    existing.phone = state.phone || existing.phone
    existing.nickname = existing.nickname || state.nickname
    // 已有账号的备注名优先保留，改名走 --rename / 页面重命名。
    existing.label = existing.label || label || state.nickname || identity
    existing.source = source
    existing.updatedAt = at
    existing.enabled = existing.enabled !== false
    return { account: existing, created: false }
  }
  const account = {
    id: `acc-${crypto.randomUUID().slice(0, 8)}`,
    label: label || state.nickname || identity,
    nickname: state.nickname,
    phone: state.phone,
    uid: state.sub,
    token: trimmed,
    exp: state.exp,
    source,
    enabled: true,
    addedAt: at,
    updatedAt: at,
    plan: '',
    balance: null,
    checkin: null,
    lastError: null,
  }
  pool.accounts.push(account)
  if (pool.accounts.length === 1) pool.activeAccountId = account.id
  return { account, created: true }
}

export function removeAccount(pool, id) {
  const index = pool.accounts.findIndex((account) => account.id === id)
  if (index < 0) return false
  pool.accounts.splice(index, 1)
  if (pool.activeAccountId === id) pool.activeAccountId = pool.accounts[0]?.id ?? null
  pool.checkins = pool.checkins.filter((row) => row.accountId !== id)
  pool.snapshots = pool.snapshots.filter((row) => row.accountId !== id)
  return true
}

/* ------------------------------------------------------------------ *
 * 余额快照
 * ------------------------------------------------------------------ */
export function recordSnapshot(pool, account, total, at = nowIso()) {
  const value = Number(total)
  if (!Number.isFinite(value)) return null
  const previous = [...pool.snapshots].reverse().find((row) => row.accountId === account.id)
  const snapshot = {
    accountId: account.id,
    at,
    day: dayKey(new Date(at)),
    total: round2(value),
    baseline: previous === undefined,
  }
  pool.snapshots.push(snapshot)
  if (pool.snapshots.length > 4000) pool.snapshots = pool.snapshots.slice(-3000)
  if (previous !== undefined && !previous.baseline) {
    const delta = round2(value - previous.total)
    snapshot.delta = delta
  }
  return snapshot
}

/* ------------------------------------------------------------------ *
 * 上游接口
 * ------------------------------------------------------------------ */
export class WbError extends Error {
  constructor(message, { code = 0, status = 0 } = {}) {
    super(message)
    this.name = 'WbError'
    this.code = code
    this.status = status
  }
}

function upstreamHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.11.3',
    'X-Product': 'SaaS',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'WorkBuddy/5.11.3',
  }
}

export async function wbRequest(cfg, account, { path: apiPath, method = 'POST', body, extraHeaders }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.requestTimeoutMs)
  let res
  try {
    res = await fetch(cfg.gateway + apiPath, {
      method,
      headers: { ...upstreamHeaders(account.token), ...(extraHeaders || {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    throw new WbError(`网络错误：${error.message}`, { status: 0 })
  }
  clearTimeout(timer)
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    throw new WbError(`token 失效（HTTP ${res.status}）`, { status: res.status })
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new WbError(`HTTP ${res.status}：${text.slice(0, 180) || '(空响应)'}`, { status: res.status })
  }
  if (json.code !== 0) {
    throw new WbError(`${json.msg || `接口返回 code=${json.code}`}`, { code: json.code, status: res.status })
  }
  return json.data ?? {}
}

/** 账号档案：GET /console/accounts。 */
export async function fetchProfile(cfg, account) {
  const data = await wbRequest(cfg, account, { path: '/console/accounts', method: 'GET' })
  const list = Array.isArray(data.accounts) ? data.accounts : []
  if (list.length === 0) throw new WbError('该 token 下没有账号信息')
  const state = tokenState(account.token)
  const mine = list.find((row) => row.uid && (row.uid === state.sub || row.uid === account.uid))
  const row = mine || list[0]
  return {
    uid: row.uid || state.sub,
    uin: row.uin,
    nickname: row.nickname || state.nickname,
    phoneNumber: row.phoneNumber || row.phone_number || state.phone,
    email: row.email,
    type: row.type,
    editionType: row.editionType || row.edition_type,
    enterpriseId: row.enterpriseId ?? row.enterprise_id,
    enterpriseName: row.enterpriseName ?? row.enterprise_name,
    isPro: Boolean(row.isPro ?? row.is_pro),
    expireAt: row.expireAt ?? row.expire_at,
    packageCode: row.PackageCode ?? row.package_code,
  }
}

/** 积分总览：POST /billing/meter/get-user-resource-summary。 */
export async function fetchSummary(cfg, account) {
  const data = await wbRequest(cfg, account, { path: '/billing/meter/get-user-resource-summary', body: {} })
  const groups = Array.isArray(data.CreditGroups)
    ? data.CreditGroups.map((row) => ({
      kind: row.Kind || '',
      name: row.Name || '',
      total: round2(row.CycleTotalCapacity),
      remain: round2(row.CycleRemainCapacity),
      used: round2(row.CycleUsedCapacity),
      unit: row.CapacityUnit || 'credits',
      count: Number(row.TotalCount) || 0,
    }))
    : []
  const packages = Array.isArray(data.Packages) ? data.Packages.length : 0
  const total = Number.isFinite(Number(data.TotalCredits))
    ? round2(data.TotalCredits)
    : round2(groups.reduce((sum, group) => sum + group.remain, 0))
  return {
    total,
    plan: data.SubscriptionPackageName || '',
    isPaidUser: Boolean(data.IsPaidUser),
    groups,
    packages,
    raw: undefined,
  }
}

/** 签到活动状态：POST /billing/meter/checkin-activity-status。 */
export async function fetchCheckinStatus(cfg, account) {
  const data = await wbRequest(cfg, account, { path: '/billing/meter/checkin-activity-status', body: {} })
  return {
    active: Boolean(data.active),
    todayCheckedIn: Boolean(data.today_checked_in),
    streakDays: Number(data.streak_days) || 0,
    dailyCredit: round2(data.daily_credit),
    todayCredit: round2(data.today_credit),
    checkinDates: Array.isArray(data.checkin_dates) ? data.checkin_dates : [],
    totalCredits: round2(data.total_credits),
    activityName: data.activity_name || '',
    claimButtonText: data.claim_button_text || '',
  }
}

/** 上游把"今天已领过"放在不同 code 上，也可能只给一句中文；两种都算已签。 */
export function isAlreadyClaimed(error) {
  if (error === null || error === undefined) return false
  const code = Number(error.code) || 0
  const message = `${error.message || ''}`
  return code === 1001 || /已签|已领|已经签|already/i.test(message)
}

/** 签到领取：POST /billing/meter/daily-checkin。 */
export async function claimCheckin(cfg, account) {
  try {
    const data = await wbRequest(cfg, account, { path: '/billing/meter/daily-checkin', body: {} })
    return {
      status: 'claimed',
      credit: round2(data.credit),
      streakDays: Number(data.streak_days) || 0,
      isStreakDay: Boolean(data.is_streak_day),
      message: '签到成功',
    }
  } catch (error) {
    if (isAlreadyClaimed(error)) {
      return { status: 'already', credit: 0, streakDays: 0, isStreakDay: false, message: error.message || '今天已经签过' }
    }
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * 桌面端 token 抓取
 * ------------------------------------------------------------------ */

/**
 * 抓 WorkBuddy 进程内存里 **所有** 仍有效的账号 token（按 sub 去重）。
 * 桌面端先后登录过多个账号时，一次就能把能看到的账号全拿到。
 * @returns {Promise<Array<{token: string, sub: string, phone: string, nickname: string, exp: number}>>}
 */
export function harvestDesktopAccounts(cfg) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new WbError('只有 Windows 支持从桌面端抓取 token'))
      return
    }
    if (!fs.existsSync(cfg.harvestAllScript)) {
      reject(new WbError(`抓取脚本不存在：${cfg.harvestAllScript}`))
      return
    }
    execFile(
      cfg.powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cfg.harvestAllScript],
      { timeout: 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = `${stdout || ''}`.trim()
        if (out === '' || out === '[]') {
          reject(new WbError(`抓取失败：WorkBuddy 桌面端没在运行，或内存里没有有效登录态${error?.message ? `（${error.message}）` : ''}`))
          return
        }
        let rows
        try {
          rows = JSON.parse(out)
        } catch {
          reject(new WbError(`抓取脚本输出无法解析：${out.slice(0, 160) || `${stderr || ''}`.trim()}`))
          return
        }
        const list = (Array.isArray(rows) ? rows : [rows])
          .filter((row) => row && typeof row.token === 'string' && row.token.startsWith('eyJ'))
          .map((row) => ({
            token: row.token,
            sub: row.sub || '',
            phone: row.phone || '',
            nickname: row.nickname || '',
            exp: Number(row.exp) || 0,
          }))
        if (list.length === 0) {
          reject(new WbError('抓取失败：没有仍然有效的 WorkBuddy 登录态'))
          return
        }
        resolve(list)
      },
    )
  })
}

/** 只要一个 token（兼容旧调用）：取剩余有效期最长的那个。 */
export async function harvestDesktopToken(cfg) {
  const accounts = await harvestDesktopAccounts(cfg)
  const best = accounts.sort((a, b) => b.exp - a.exp)[0]
  return best.token
}

/* ------------------------------------------------------------------ *
 * 账号刷新（档案 + 余额 + 快照）
 * ------------------------------------------------------------------ */
export async function refreshAccount(cfg, pool, account, { withProfile = true } = {}) {
  const at = nowIso()
  try {
    if (withProfile) {
      const state = tokenState(account.token)
      const profile = await fetchProfile(cfg, account)
      account.uid = profile.uid || account.uid
      account.nickname = profile.nickname || account.nickname
      // 接口返回的手机号是打码的，JWT 里的 preferred_username 才是全号。
      account.phone = state.phone || profile.phoneNumber || account.phone
      account.plan = profile.editionType || account.plan
      account.isPro = profile.isPro
      account.enterpriseId = profile.enterpriseId || null
      account.label = account.label || profile.nickname || profile.phoneNumber || account.id
    }
    const summary = await fetchSummary(cfg, account)
    account.balance = { total: summary.total, at, plan: summary.plan, groups: summary.groups, packages: summary.packages }
    const snapshot = recordSnapshot(pool, account, summary.total, at)
    account.lastError = null
    account.lastRefreshAt = at
    const checkin = await fetchCheckinStatus(cfg, account).catch(() => null)
    if (checkin) {
      account.checkinStatus = { ...checkin, at }
      const today = dayKey()
      if (checkin.todayCheckedIn) {
        const credit = round2(checkin.todayCredit || 0)
        const stale = account.checkin === null || account.checkin === undefined
          || account.checkin.day !== today
          || (Number(account.checkin.credit) || 0) === 0
        if (stale) {
          account.checkin = {
            day: today,
            credit,
            at,
            status: 'claimed',
            streakDays: checkin.streakDays,
            estimated: credit === 0,
          }
        }
      }
      // 签到流水按 (账号, 日期) 对齐账号自身的签到记录，缺就补上。
      if (account.checkin !== null && account.checkin !== undefined && account.checkin.day === today) {
        const credit = Number(account.checkin.credit) || 0
        const row = pool.checkins.find((item) => item.accountId === account.id && item.day === today)
        if (row !== undefined) {
          row.credit = credit
          row.streakDays = account.checkin.streakDays
        } else if (credit > 0) {
          pool.checkins.push({
            accountId: account.id,
            day: today,
            credit,
            at: account.checkin.at || at,
            status: account.checkin.status || 'claimed',
            streakDays: account.checkin.streakDays,
          })
          if (pool.checkins.length > 500) pool.checkins = pool.checkins.slice(-400)
        }
      }
    }
    return { ok: true, account, summary, snapshot }
  } catch (error) {
    account.lastError = { at, message: error.message, code: error.code || 0 }
    return { ok: false, account, error }
  }
}

/** 签到一个账号，并记录到池里（checkins 表保留最近 500 条）。 */
export async function checkinAccount(cfg, pool, account) {
  const at = nowIso()
  const day = dayKey()
  try {
    const result = await claimCheckin(cfg, account)
    const previous = account.checkin !== null && account.checkin !== undefined && account.checkin.day === day
      ? account.checkin
      : null
    // 「今天已签过」时上游不给 credit，保留当天已知的签到积分，别把 +100 覆盖成 0。
    const credit = result.status === 'claimed'
      ? round2(result.credit)
      : round2(Math.max(Number(result.credit) || 0, Number(previous?.credit) || 0))
    account.checkin = {
      day,
      credit,
      at,
      status: result.status,
      streakDays: Number(result.streakDays) || Number(previous?.streakDays) || 0,
      isStreakDay: Boolean(result.isStreakDay),
      estimated: credit === 0,
    }
    account.lastError = null
    if (result.status === 'claimed' && credit > 0) {
      const row = pool.checkins.find((item) => item.accountId === account.id && item.day === day)
      if (row !== undefined) {
        row.credit = credit
        row.streakDays = account.checkin.streakDays
      } else {
        pool.checkins.push({ accountId: account.id, day, credit, at, status: result.status, streakDays: account.checkin.streakDays })
        if (pool.checkins.length > 500) pool.checkins = pool.checkins.slice(-400)
      }
    }
    return { ok: true, accountId: account.id, ...result, credit, todayCredit: credit }
  } catch (error) {
    account.lastError = { at, message: error.message, code: error.code || 0 }
    return { ok: false, accountId: account.id, error: error.message, status: 'failed' }
  }
}

/* ------------------------------------------------------------------ *
 * 用量聚合
 * ------------------------------------------------------------------ */
function readJsonLines(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows
}

/**
 * 汇总反代用量日志。
 * @param {string} file usage.jsonl 路径
 * @param {{days?: number, hidden?: Set<string>|string[]}} options hidden = 被用户删掉统计的会话 key
 */
export function aggregateUsage(file, options = {}) {
  const days = Math.max(1, Number(options.days) || 30)
  const cutoff = Date.now() - days * 86400000
  const hidden = options.hidden instanceof Set ? options.hidden : new Set(options.hidden || [])
  const byDay = new Map()
  const bySession = new Map()
  const byModel = new Map()
  const byAccount = new Map()
  let scanned = 0

  for (const row of readJsonLines(file)) {
    const ts = Date.parse(row.ts || '')
    if (!Number.isFinite(ts) || ts < cutoff) continue
    if (row.status !== undefined && Number(row.status) !== 200) continue
    const sessionRaw = typeof row.session_id === 'string' && row.session_id.length > 0 ? row.session_id : ''
    const sessionKeyProbe = sessionRaw || `unattributed:${row.day || dayKey(new Date(ts))}`
    if (hidden.has(sessionKeyProbe)) continue
    scanned += 1
    const credit = round2(row.credit || 0)
    const prompt = Number(row.prompt_tokens) || 0
    const completion = Number(row.completion_tokens) || 0

    const day = row.day || dayKey(new Date(ts))
    const dayBucket = byDay.get(day) || { day, spend: 0, requests: 0, prompt: 0, completion: 0 }
    dayBucket.spend = round2(dayBucket.spend + credit)
    dayBucket.requests += 1
    dayBucket.prompt += prompt
    dayBucket.completion += completion
    byDay.set(day, dayBucket)

    const sessionId = sessionRaw
    const sessionKey = sessionKeyProbe
    const sessionBucket = bySession.get(sessionKey) || {
      id: sessionKey, attached: sessionId !== '', spend: 0, requests: 0, prompt: 0, completion: 0, first: ts, last: ts, models: {},
    }
    sessionBucket.spend = round2(sessionBucket.spend + credit)
    sessionBucket.requests += 1
    sessionBucket.prompt += prompt
    sessionBucket.completion += completion
    sessionBucket.first = Math.min(sessionBucket.first, ts)
    sessionBucket.last = Math.max(sessionBucket.last, ts)
    if (row.model) sessionBucket.models[row.model] = (sessionBucket.models[row.model] || 0) + 1
    bySession.set(sessionKey, sessionBucket)

    const model = row.model || 'unknown'
    const modelBucket = byModel.get(model) || { model, spend: 0, requests: 0, prompt: 0, completion: 0 }
    modelBucket.spend = round2(modelBucket.spend + credit)
    modelBucket.requests += 1
    modelBucket.prompt += prompt
    modelBucket.completion += completion
    byModel.set(model, modelBucket)

    const accountId = row.account_id || 'unassigned'
    const accountBucket = byAccount.get(accountId) || { accountId, spend: 0, requests: 0 }
    accountBucket.spend = round2(accountBucket.spend + credit)
    accountBucket.requests += 1
    byAccount.set(accountId, accountBucket)
  }

  return {
    scanned,
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    sessions: [...bySession.values()].sort((a, b) => b.last - a.last),
    models: [...byModel.values()].sort((a, b) => b.spend - a.spend),
    accounts: [...byAccount.values()].sort((a, b) => b.spend - a.spend),
  }
}

/**
 * dsh 会话索引：标题 / 工作目录 / 轮数 / token 总量。
 * 数据来自 dsh 的会话投影缓存，只读，坏文件跳过。
 */
export function sessionIndex(cfg, cache) {
  const dir = path.join(cfg.home, 'storages', 'session_projcache', 'sessions')
  const index = new Map()
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith('session-') && name.endsWith('.json'))
  } catch {
    return index
  }
  for (const name of names) {
    const id = name.replace(/\.json$/, '')
    const file = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    const cached = cache.get(file)
    if (cached !== undefined && cached.stamp === stamp) {
      index.set(id, cached.value)
      continue
    }
    let value = { id, title: '', cwd: '', turns: 0, tokens: 0, updatedAt: stat.mtimeMs }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const rows = parsed?.record?.rows ?? {}
      const valueOf = (key) => rows[key]?.val
      const title = valueOf('title')
      const stats = valueOf('sessionStats') ?? {}
      const usage = valueOf('tokenUsage') ?? {}
      const totals = usage.totals ?? {}
      value = {
        id,
        title: typeof title === 'string' ? title : '',
        cwd: typeof parsed?.record?.identity?.cwd === 'string' ? parsed.record.identity.cwd : '',
        turns: Number(stats.turns) || 0,
        tokens: (Number(totals.uncachedInputTokens) || 0) + (Number(totals.outputTokens) || 0) + (Number(totals.cacheReadTokens) || 0),
        updatedAt: stat.mtimeMs,
      }
    } catch {
      /* 投影还没写全，用兜底值 */
    }
    cache.set(file, { stamp, value })
    index.set(id, value)
  }
  return index
}

/** 余额快照 → 每日增减。 */
export function dailyFromSnapshots(pool) {
  const rows = [...pool.snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const byDay = new Map()
  const lastTotal = new Map()
  for (const row of rows) {
    const day = row.day || dayKey(new Date(row.at))
    const bucket = byDay.get(day) || { day, gained: 0, dropped: 0, checkin: 0 }
    const previous = lastTotal.get(row.accountId)
    if (Number.isFinite(previous) && !row.baseline) {
      const delta = round2(row.total - previous)
      if (delta > 0) bucket.gained = round2(bucket.gained + delta)
      else if (delta < 0) bucket.dropped = round2(bucket.dropped - delta)
    }
    lastTotal.set(row.accountId, row.total)
    byDay.set(day, bucket)
  }
  for (const row of pool.checkins) {
    const bucket = byDay.get(row.day) || { day: row.day, gained: 0, dropped: 0, checkin: 0 }
    bucket.checkin = round2(bucket.checkin + (Number(row.credit) || 0))
    byDay.set(row.day, bucket)
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** 本地时区本周一（周一为一周起点）。 */
export function startOfWeek(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - offset)
  return d
}

/**
 * 本周（周一到今天）的每日序列，缺失的日期补 0。
 * @param {Array<object>} dailyRows dailyTable 的输出
 */
export function weekSeries(dailyRows, date = new Date()) {
  const start = startOfWeek(date)
  const today = dayKey(date)
  const map = new Map(dailyRows.map((row) => [row.day, row]))
  const out = []
  for (let index = 0; index < 7; index += 1) {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const key = dayKey(cursor)
    if (key > today) break
    out.push(map.get(key) || { day: key, gained: 0, checkin: 0, spend: 0, requests: 0, prompt: 0, completion: 0 })
  }
  return {
    start: dayKey(start),
    end: today,
    days: out,
    gained: round2(out.reduce((sum, row) => sum + (row.gained || 0), 0)),
    spend: round2(out.reduce((sum, row) => sum + (row.spend || 0), 0)),
    requests: out.reduce((sum, row) => sum + (row.requests || 0), 0),
  }
}

/** 依据快照与用量，拼出最近 N 天的每日表。 */
export function dailyTable(pool, usage, days = 14) {
  const snapshotDays = new Map(dailyFromSnapshots(pool).map((row) => [row.day, row]))
  const usageDays = new Map(usage.days.map((row) => [row.day, row]))
  const keys = new Set([...snapshotDays.keys(), ...usageDays.keys()])
  const sorted = [...keys].sort()
  const keep = sorted.slice(-days)
  return keep.map((day) => {
    const snap = snapshotDays.get(day) || { gained: 0, dropped: 0, checkin: 0 }
    const use = usageDays.get(day) || { spend: 0, requests: 0, prompt: 0, completion: 0 }
    return {
      day,
      // 余额快照的增量和签到记录可能描述同一笔发放：取较大者，避免重复计数。
      gained: round2(Math.max(snap.gained, snap.checkin)),
      checkin: snap.checkin,
      spend: use.spend,
      requests: use.requests,
      prompt: use.prompt,
      completion: use.completion,
    }
  })
}
