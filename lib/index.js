/**
 * dsh-workbuddy-pool — 宿主半侧（node）。
 *
 * 提供三样东西：
 *   1. `/workbuddy-pool/api/*` 的 HTTP 接口，浏览器半侧的页面只读这里；
 *   2. 定时器：每天自动签到领积分、定时刷新余额快照、token 快过期时从桌面端续期；
 *   3. `llm-pi-ai/request-headers` 钩子：给 WorkBuddy 请求打上 dsh 会话号，
 *      这样反代的用量日志就能精确归到"每个对话消耗了多少积分"。
 */
import {
  POOL_VERSION,
  aggregateUsage,
  appendLog,
  checkinAccount,
  claimCheckin,
  dailyTable,
  dayKey,
  fetchCheckinStatus,
  harvestDesktopAccounts,
  nowIso,
  publicPool,
  readPool,
  refreshAccount,
  removeAccount,
  resolveConfig,
  round2,
  sessionIndex,
  upsertAccount,
  weekSeries,
  withPoolLock,
  writePool,
} from './wb-store.mjs'

export const name = 'workbuddy-pool'
export const inject = ['webServer']

const API_PREFIX = '/workbuddy-pool'

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const log = (line) => {
    appendLog(cfg, line)
    try {
      ctx.logger?.info?.(`workbuddy-pool: ${line}`)
    } catch {
      /* 日志失败不影响流程 */
    }
  }
  const sessionCache = new Map()
  /**
   * 所有写账号池的操作串行化：进程内排队 + 跨进程文件锁。
   * 插件、命令行、反代共用同一份 pool.json，没有文件锁时后写的一方会用旧副本覆盖前一方。
   */
  const withLock = (task) => withPoolLock(cfg, task)
  /** 今日签到尝试次数（accountId → {day, count}），失败按 tick 重试但不超过 18 次。 */
  const attempts = new Map()
  let lastTickAtIso = null
  let lastSnapshotAt = 0
  let lastTokenCheckAt = 0
  let timer = null
  let disposed = false

  /* ---------------- 视图 ---------------- */

  function hiddenSet(pool) {
    return new Set(Object.keys(pool.hiddenSessions || {}))
  }

  function buildStatus(options = {}) {
    const pool = readPool(cfg)
    const hidden = hiddenSet(pool)
    const usage = aggregateUsage(cfg.usageLog, { days: 30, hidden })
    const index = sessionIndex(cfg, sessionCache)
    const daily = dailyTable(pool, usage, Number(options.days) || 14)
    const today = dayKey()
    const todayRow = daily.find((row) => row.day === today) || { day: today, gained: 0, checkin: 0, spend: 0, requests: 0 }
    const spendByAccount = new Map(usage.accounts.map((row) => [row.accountId, row]))
    const accounts = publicPool(cfg, pool).accounts.map((account) => {
      const spend = spendByAccount.get(account.id) || { spend: 0, requests: 0 }
      return {
        ...account,
        checkin: account.checkin || null,
        checkinStatus: account.checkinStatus || null,
        todaySpend: spend.spend,
        todayRequests: spend.requests,
      }
    })
    const sessions = usage.sessions.map((row) => {
      const meta = row.attached ? index.get(row.id) : undefined
      return {
        id: row.id,
        attached: row.attached,
        title: meta?.title || (row.attached ? '' : `未归因（${row.id.replace('unattributed:', '')}）`),
        cwd: meta?.cwd || '',
        turns: meta?.turns || 0,
        tokens: meta?.tokens || 0,
        spend: row.spend,
        requests: row.requests,
        prompt: row.prompt,
        completion: row.completion,
        lastAt: new Date(row.last).toISOString(),
        firstAt: new Date(row.first).toISOString(),
        models: row.models,
      }
    })
    const totals = {
      accounts: accounts.length,
      enabled: accounts.filter((account) => account.enabled !== false).length,
      balance: round2(accounts.reduce((sum, account) => sum + (account.balanceTotal || 0), 0)),
      todayGained: todayRow.gained,
      todayCheckin: todayRow.checkin,
      todaySpend: todayRow.spend,
      todayRequests: todayRow.requests,
      allTimeSpend: round2(usage.days.reduce((sum, row) => sum + row.spend, 0)),
    }
    const week = weekSeries(daily)
    return {
      ok: true,
      generatedAt: nowIso(),
      today,
      pool: {
        file: cfg.poolFile,
        version: pool.version || POOL_VERSION,
        activeAccountId: pool.activeAccountId ?? accounts[0]?.id ?? null,
        accounts,
        hiddenSessions: Object.keys(pool.hiddenSessions || {}),
      },
      totals,
      // 每日清单按「本周」推进：周一到今天，最多 7 天，跨周自动从新一周重新开始。
      daily: week.days,
      history: daily,
      week,
      sessions,
      models: usage.models.slice(0, 20),
      usage: {
        log: cfg.usageLog,
        scanned: usage.scanned,
      },
      scheduler: {
        enabled: cfg.enabled,
        checkinAt: cfg.checkinAt,
        snapshotMinutes: cfg.snapshotMinutes,
        autoHarvest: cfg.autoHarvest,
        ...pool.scheduler,
        // 内存里的最后一次 tick 优先（pool.scheduler 里那份是历史遗留字段）
        lastTickAt: lastTickAtIso,
      },
    }
  }

  /* ---------------- 动作 ---------------- */

  async function doRefreshAll({ withProfile = false } = {}) {
    return withLock(async () => {
      const pool = readPool(cfg)
      const results = []
      // 余额/签到与 ON/OFF 无关：OFF 只表示不拿它去消耗积分，刷新照做。
      for (const account of pool.accounts) {
        const result = await refreshAccount(cfg, pool, account, { withProfile })
        results.push({ accountId: account.id, ok: result.ok, error: result.ok ? null : result.error?.message })
      }
      pool.scheduler.lastSnapshotAt = nowIso()
      writePool(cfg, pool)
      lastSnapshotAt = Date.now()
      return results
    })
  }

  async function doCheckin(accountId) {
    return withLock(async () => {
      const pool = readPool(cfg)
      // ON/OFF 只影响积分消耗，不影响签到：OFF 的账号也照常签到领积分。
      const targets = pool.accounts.filter((account) => accountId === undefined || account.id === accountId)
      const results = []
      for (const account of targets) {
        const result = await checkinAccount(cfg, pool, account)
        results.push({ accountId: account.id, label: account.label, ...result })
        const refreshed = await refreshAccount(cfg, pool, account, { withProfile: false })
        if (!refreshed.ok && result.ok) {
          log(`签到后刷新余额失败（${account.label}）：${refreshed.error?.message}`)
        }
        attempts.set(account.id, { day: dayKey(), count: (attempts.get(account.id)?.count || 0) + 1 })
      }
      pool.scheduler.lastCheckinRunAt = nowIso()
      writePool(cfg, pool)
      log(`手动签到：${results.map((row) => `${row.label || row.accountId}=${row.status}${row.credit ? `+${row.credit}` : ''}`).join('，') || '没有可签到账号'}`)
      return results
    })
  }

  async function importToken(token, label, source = 'manual') {
    return withLock(async () => {
      const pool = readPool(cfg)
      const { account, created } = upsertAccount(pool, { token, label, source })
      const refreshed = await refreshAccount(cfg, pool, account, { withProfile: true })
      writePool(cfg, pool)
      log(`${created ? '导入' : '更新'}账号 ${account.label}（${account.id}）${refreshed.ok ? '' : `，刷新失败：${refreshed.error?.message}`}`)
      return { account: publicPool(cfg, pool).accounts.find((row) => row.id === account.id), created, refreshed: refreshed.ok }
    })
  }

  /** 从桌面端进程内存里把能看到的账号一次性全部导入（按 sub/手机号去重）。 */
  async function importFromDesktop(label) {
    const found = await harvestDesktopAccounts(cfg)
    const imported = []
    for (const row of found) {
      const result = await importToken(row.token, label || row.nickname || row.phone || undefined, 'desktop')
      imported.push({
        accountId: result.account?.id,
        label: result.account?.label,
        phone: result.account?.phone,
        created: result.created,
      })
    }
    log(`从桌面端导入 ${imported.length} 个账号：${imported.map((row) => `${row.label}${row.created ? '' : '（更新）'}`).join('、')}`)
    return { count: imported.length, imported }
  }

  /* ---------------- 定时 ---------------- */

  function minutesNow() {
    const now = new Date()
    return now.getHours() * 60 + now.getMinutes()
  }

  async function tick() {
    if (disposed || !cfg.enabled) return
    lastTickAtIso = nowIso()
    const pool = readPool(cfg)
    if (pool.accounts.length === 0) return
    const today = dayKey()
    const due = minutesNow() >= cfg.checkinHour * 60 + cfg.checkinMinute
    const pending = pool.accounts.filter((account) => {
      // ON/OFF 不参与签到判断：OFF 只是不拿它消耗积分。
      if (account.checkin?.day === today) return false
      const attempt = attempts.get(account.id)
      if (attempt !== undefined && attempt.day === today && attempt.count >= 18) return false
      return due
    })
    if (pending.length > 0) {
      await withLock(async () => {
        const current = readPool(cfg)
        for (const account of current.accounts) {
          if (!pending.some((row) => row.id === account.id)) continue
          const result = await checkinAccount(cfg, current, account)
          await refreshAccount(cfg, current, account, { withProfile: false })
          const attempt = attempts.get(account.id)
          attempts.set(account.id, {
            day: today,
            count: (attempt?.day === today ? attempt.count : 0) + 1,
          })
          log(`自动签到 ${account.label}：${result.ok ? `${result.status}${result.credit ? ` +${result.credit}` : ''}` : `失败 ${result.error}`}`)
        }
        current.scheduler.lastCheckinRunAt = nowIso()
        writePool(cfg, current)
      }).catch((error) => log(`自动签到异常：${error.message}`))
    }

    if (Date.now() - lastSnapshotAt >= cfg.snapshotMinutes * 60000) {
      await doRefreshAll({ withProfile: false }).catch((error) => log(`余额刷新异常：${error.message}`))
    }

    if (cfg.autoHarvest && Date.now() - lastTokenCheckAt >= 6 * 3600 * 1000) {
      lastTokenCheckAt = Date.now()
      const state = readPool(cfg)
      const expiring = state.accounts.filter((account) => {
        if (account.source !== 'desktop') return false
        const exp = Number(account.exp) || 0
        const leftDays = (exp - Math.floor(Date.now() / 1000)) / 86400
        return leftDays <= cfg.harvestMinTokenDays
      })
      if (expiring.length > 0) {
        try {
          const result = await importFromDesktop(undefined)
          log(`token 临近过期，已从桌面端重新抓取 ${result.count} 个账号`)
        } catch (error) {
          log(`token 续期失败：${error.message}`)
        }
      }
    }
  }

  async function boot() {
    if (disposed) return
    log(`启动：数据目录 ${cfg.dataDir}，用量日志 ${cfg.usageLog}`)
    let pool = readPool(cfg)
    if (pool.accounts.length === 0 && cfg.autoHarvest) {
      try {
        const result = await importFromDesktop(undefined)
        log(`首次启动：已从 WorkBuddy 桌面端导入 ${result.count} 个账号`)
        pool = readPool(cfg)
      } catch (error) {
        log(`首次启动导入失败（可在页面点“导入账号”手动导入）：${error.message}`)
      }
    }
    if (pool.accounts.length > 0) {
      await doRefreshAll({ withProfile: false }).catch((error) => log(`启动刷新异常：${error.message}`))
    }
    await tick().catch((error) => log(`启动 tick 异常：${error.message}`))
  }

  /* ---------------- 路由 ---------------- */

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
    const method = req.method || 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' })
      res.end()
      return
    }

    try {
      if (method === 'GET' && (path === '/api/status' || path === '/status')) {
        return sendJson(res, 200, buildStatus({ days: Number(url.searchParams.get('days')) || 14 }))
      }

      if (method === 'GET' && (path === '/api/usage' || path === '/usage')) {
        const days = Number(url.searchParams.get('days')) || 14
        const pool = readPool(cfg)
        const hidden = hiddenSet(pool)
        const usage = aggregateUsage(cfg.usageLog, { days: 30, hidden })
        const index = sessionIndex(cfg, sessionCache)
        return sendJson(res, 200, {
          ok: true,
          generatedAt: nowIso(),
          days: dailyTable(pool, usage, days),
          sessions: usage.sessions.map((row) => ({
            id: row.id,
            title: row.attached ? (index.get(row.id)?.title || '') : `未归因（${row.id.replace('unattributed:', '')}）`,
            spend: row.spend,
            requests: row.requests,
            prompt: row.prompt,
            completion: row.completion,
            lastAt: new Date(row.last).toISOString(),
          })),
          models: usage.models,
        })
      }

      /* -------- 会话统计：详情 / 删除统计 / 刷新 -------- */
      if (method === 'POST' && (path === '/api/sessions/restore' || path === '/sessions/restore')) {
        // 误删的统计一次性全部恢复（只影响隐藏列表，不动日志文件）。
        await withLock(async () => {
          const pool = readPool(cfg)
          pool.hiddenSessions = {}
          writePool(cfg, pool)
        })
        log('已恢复全部被删除的会话统计')
        return sendJson(res, 200, { ok: true, restored: true })
      }

      const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(hide|refresh))?$/.exec(path)
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1])
        const action = sessionMatch[2] || ''
        const pool = readPool(cfg)
        const hidden = hiddenSet(pool)

        if (method === 'POST' && action === 'hide') {
          pool.hiddenSessions = pool.hiddenSessions || {}
          pool.hiddenSessions[sessionId] = { at: nowIso() }
          writePool(cfg, pool)
          log(`删除会话统计：${sessionId}（对话本身不受影响）`)
          return sendJson(res, 200, { ok: true, hidden: sessionId })
        }

        if (method === 'GET' || (method === 'POST' && action === 'refresh')) {
          // 刷新就是重新读一遍日志（不做缓存），所以两种方法同一个实现。
          const usage = aggregateUsage(cfg.usageLog, { days: 30, hidden })
          const index = sessionIndex(cfg, sessionCache)
          const row = usage.sessions.find((item) => item.id === sessionId)
          if (row === undefined) {
            return sendJson(res, 404, { ok: false, error: '这个会话没有可展示的用量记录' })
          }
          const meta = row.attached ? index.get(row.id) : undefined
          return sendJson(res, 200, {
            ok: true,
            session: {
              id: row.id,
              attached: row.attached,
              title: meta?.title || (row.attached ? '' : `未归因（${row.id.replace('unattributed:', '')}）`),
              cwd: meta?.cwd || '',
              turns: meta?.turns || 0,
              tokens: meta?.tokens || 0,
              spend: row.spend,
              requests: row.requests,
              prompt: row.prompt,
              completion: row.completion,
              firstAt: new Date(row.first).toISOString(),
              lastAt: new Date(row.last).toISOString(),
              models: row.models,
            },
            corpus: {
              requests: usage.sessions.reduce((sum, item) => sum + item.requests, 0),
              spend: round2(usage.sessions.reduce((sum, item) => sum + item.spend, 0)),
              prompt: usage.sessions.reduce((sum, item) => sum + item.prompt, 0),
              completion: usage.sessions.reduce((sum, item) => sum + item.completion, 0),
              sessions: usage.sessions.length,
            },
          })
        }
      }

      if (method === 'GET' && (path === '/api/export' || path === '/export')) {
        const pool = readPool(cfg)
        return sendJson(res, 200, { ok: true, ...publicPool(cfg, pool) })
      }

      if (method === 'GET' && (path === '/api/accounts' || path === '/accounts')) {
        const pool = readPool(cfg)
        return sendJson(res, 200, { ok: true, ...publicPool(cfg, pool) })
      }

      if (method === 'POST' && (path === '/api/checkin' || path === '/checkin')) {
        const body = await readJsonBody(req)
        const results = await doCheckin(typeof body.accountId === 'string' ? body.accountId : undefined)
        return sendJson(res, 200, { ok: true, results })
      }

      if (method === 'POST' && (path === '/api/checkin/status' || path === '/checkin/status')) {
        const body = await readJsonBody(req)
        const pool = readPool(cfg)
        const account = pool.accounts.find((row) => row.id === body.accountId) || pool.accounts[0]
        if (account === undefined) return sendJson(res, 404, { ok: false, error: '账号池为空' })
        const status = await fetchCheckinStatus(cfg, account)
        return sendJson(res, 200, { ok: true, accountId: account.id, status })
      }

      if (method === 'POST' && (path === '/api/accounts' || path === '/accounts')) {
        const body = await readJsonBody(req)
        if (typeof body.token !== 'string' || body.token.trim() === '') {
          return sendJson(res, 400, { ok: false, error: '缺少 token' })
        }
        const result = await importToken(body.token, typeof body.label === 'string' ? body.label : undefined, 'manual')
        return sendJson(res, 200, { ok: true, ...result })
      }

      if (method === 'POST' && (path === '/api/accounts/harvest' || path === '/accounts/harvest')) {
        const body = await readJsonBody(req)
        const result = await importFromDesktop(typeof body.label === 'string' ? body.label : undefined)
        return sendJson(res, 200, { ok: true, ...result })
      }

      const accountMatch = /^\/api\/accounts\/([^/]+)(?:\/(refresh|toggle|checkin))?$/.exec(path)
      if (accountMatch) {
        const id = decodeURIComponent(accountMatch[1])
        const action = accountMatch[2] || ''
        if (method === 'DELETE' && action === '') {
          const removed = await withLock(async () => {
            const pool = readPool(cfg)
            const ok = removeAccount(pool, id)
            writePool(cfg, pool)
            return ok
          })
          return sendJson(res, removed ? 200 : 404, { ok: removed, removed: id })
        }
        if (method === 'POST' && action === 'refresh') {
          const result = await withLock(async () => {
            const pool = readPool(cfg)
            const account = pool.accounts.find((row) => row.id === id)
            if (account === undefined) return null
            const refreshed = await refreshAccount(cfg, pool, account, { withProfile: true })
            writePool(cfg, pool)
            return { ok: refreshed.ok, error: refreshed.ok ? null : refreshed.error?.message }
          })
          if (result === null) return sendJson(res, 404, { ok: false, error: '账号不存在' })
          return sendJson(res, 200, { ok: true, ...result })
        }
        if (method === 'POST' && action === 'checkin') {
          const results = await doCheckin(id)
          return sendJson(res, 200, { ok: true, results })
        }
        if (method === 'POST' && action === 'toggle') {
          const body = await readJsonBody(req)
          const result = await withLock(async () => {
            const pool = readPool(cfg)
            const account = pool.accounts.find((row) => row.id === id)
            if (account === undefined) return null
            account.enabled = body.enabled === undefined ? account.enabled === false : Boolean(body.enabled)
            writePool(cfg, pool)
            return { id: account.id, enabled: account.enabled }
          })
          if (result === null) return sendJson(res, 404, { ok: false, error: '账号不存在' })
          return sendJson(res, 200, { ok: true, ...result })
        }
      }

      if (method === 'POST' && (path === '/api/refresh' || path === '/refresh')) {
        const results = await doRefreshAll({ withProfile: true })
        return sendJson(res, 200, { ok: true, results })
      }

      if (method === 'POST' && (path === '/api/scheduler' || path === '/scheduler')) {
        const body = await readJsonBody(req)
        if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled
        return sendJson(res, 200, { ok: true, enabled: cfg.enabled })
      }

      return sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${path}` })
    } catch (error) {
      log(`接口异常 ${method} ${path}：${error.message}`)
      return sendJson(res, error.status || 500, { ok: false, error: error.message })
    }
  }

  /* ---------------- 装配 ---------------- */

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle })
    return () => {
      disposed = true
      if (timer !== null) clearInterval(timer)
      dispose()
    }
  }, 'workbuddy-pool: api routes + timer')

  // WorkBuddy 请求带上 dsh 会话号，反代据此把积分消耗归到具体对话。
  ctx.effect(() => {
    const listener = (request, headers, next) => {
      try {
        if (request !== null && typeof request === 'object' && request.provider === 'workbuddy') {
          if (typeof request.sessionId === 'string' && request.sessionId.length > 0) {
            headers.set('x-wb-session-id', request.sessionId)
          }
          if (typeof request.purpose === 'string' && request.purpose.length > 0) {
            headers.set('x-wb-session-purpose', request.purpose)
          }
        }
      } catch {
        /* 打标失败不能影响推理 */
      }
      return next()
    }
    const off = ctx.on('llm-pi-ai/request-headers', listener)
    return typeof off === 'function' ? off : undefined
  }, 'workbuddy-pool: session attribution header')

  timer = setInterval(() => {
    void tick().catch((error) => log(`定时任务异常：${error.message}`))
  }, 60000)
  if (typeof timer.unref === 'function') timer.unref()

  setTimeout(() => {
    void boot().catch((error) => log(`启动流程异常：${error.message}`))
  }, 1500)

  log(`已加载：接口 ${API_PREFIX}/api/status，每日签到 ${cfg.checkinAt}`)
}

/* 命令行签到时复用 */
export { claimCheckin }
