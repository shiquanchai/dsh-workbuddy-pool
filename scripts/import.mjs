#!/usr/bin/env node
/**
 * 命令行导入账号（页面上的「导入账号」等价物）。
 *
 *   node scripts/import.mjs --desktop                  # 抓桌面端进程里所有仍有效的账号，一次全导入
 *   node scripts/import.mjs --token-file <路径>         # 从文件读 token
 *   node scripts/import.mjs --token eyJ...             # 直接给 token
 *   node scripts/import.mjs --label 小号 --desktop      # 给这轮导入的账号加备注名
 *   node scripts/import.mjs --list                     # 只看账号池现状
 *   node scripts/import.mjs --checkin                  # 立刻给所有账号签一次
 *
 * 数据落在 %DSH_HOME%/workbuddy-pool/pool.json，反代与 dsh 插件共用这一份。
 */
import fs from 'node:fs'
import {
  claimCheckin,
  fetchCheckinStatus,
  fetchProfile,
  fetchSummary,
  harvestDesktopAccounts,
  publicPool,
  readPool,
  refreshAccount,
  resolveConfig,
  tokenState,
  upsertAccount,
  withPoolLock,
  writePool,
} from '../lib/wb-store.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const cfg = resolveConfig({
  dataDir: value('--data-dir'),
  gateway: value('--gateway'),
  harvestScript: value('--harvest-script'),
  harvestAllScript: value('--harvest-all-script'),
})

if (flag('--list')) {
  const pool = readPool(cfg)
  console.log(JSON.stringify(publicPool(cfg, pool), null, 2))
  process.exit(0)
}

if (flag('--rename')) {
  const id = value('--rename')
  const label = value('--label')
  if (typeof id !== 'string' || typeof label !== 'string' || label.trim() === '') {
    console.error('用法：--rename <账号id> --label <新备注名>')
    process.exit(1)
  }
  const result = await withPoolLock(cfg, async () => {
    const pool = readPool(cfg)
    const account = pool.accounts.find((row) => row.id === id)
    if (account === undefined) return null
    account.label = label.trim()
    account.updatedAt = new Date().toISOString()
    writePool(cfg, pool)
    return { ok: true, id: account.id, label: account.label }
  })
  if (result === null) {
    console.error(`账号不存在：${id}`)
    process.exit(1)
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

if (flag('--checkin')) {
  const results = await withPoolLock(cfg, async () => {
    const pool = readPool(cfg)
    const rows = []
    for (const account of pool.accounts) {
      const result = await claimCheckin(cfg, account).catch((error) => ({ status: 'failed', message: error.message }))
      await refreshAccount(cfg, pool, account, { withProfile: false })
      rows.push({ account: account.label || account.id, ...result })
    }
    writePool(cfg, pool)
    return rows
  })
  console.log(JSON.stringify(results, null, 2))
  process.exit(0)
}

if (flag('--refresh')) {
  const results = await withPoolLock(cfg, async () => {
    const pool = readPool(cfg)
    const rows = []
    for (const account of pool.accounts) {
      const result = await refreshAccount(cfg, pool, account, { withProfile: true })
      rows.push({
        account: account.label || account.id,
        ok: result.ok,
        error: result.ok ? null : result.error?.message,
        balance: account.balance?.total ?? null,
        checkin: account.checkin ?? null,
      })
    }
    writePool(cfg, pool)
    return rows
  })
  console.log(JSON.stringify(results, null, 2))
  process.exit(0)
}

/** 导入一个 token：抓档案 + 余额 + 签到状态，返回一行摘要。整个过程持有账号池文件锁。 */
async function importOne(rawToken, label, source) {
  return withPoolLock(cfg, async () => {
    const state = tokenState(rawToken)
    const pool = readPool(cfg)
    const { account, created } = upsertAccount(pool, { token: rawToken.trim(), label, source })
    const profile = await fetchProfile(cfg, account).catch((error) => ({ error: error.message }))
    if (profile.error === undefined) {
      account.uid = profile.uid || account.uid
      account.nickname = profile.nickname || account.nickname
      account.phone = profile.phoneNumber || account.phone
      account.plan = profile.editionType || account.plan
    }
    const summary = await fetchSummary(cfg, account).catch((error) => ({ error: error.message }))
    if (summary.error === undefined) {
      account.balance = { total: summary.total, at: new Date().toISOString(), plan: summary.plan, groups: summary.groups, packages: summary.packages }
    }
    const checkin = await fetchCheckinStatus(cfg, account).catch(() => null)
    if (checkin !== null) account.checkinStatus = { ...checkin, at: new Date().toISOString() }
    writePool(cfg, pool)
    return {
      action: created ? 'imported' : 'updated',
      id: account.id,
      label: account.label,
      phone: state.phone,
      tokenLeftDays: state.leftDays,
      balance: account.balance?.total ?? null,
      plan: account.balance?.plan ?? '',
      todayCheckedIn: checkin?.todayCheckedIn ?? null,
      streakDays: checkin?.streakDays ?? null,
      profileError: profile.error ?? null,
      poolFile: cfg.poolFile,
      accounts: pool.accounts.length,
    }
  })
}

if (flag('--desktop')) {
  const found = await harvestDesktopAccounts(cfg)
  const rows = []
  for (const row of found) {
    rows.push(await importOne(row.token, value('--label') || row.nickname || row.phone || undefined, 'desktop'))
  }
  console.log(JSON.stringify({ harvested: found.length, rows }, null, 2))
  process.exit(0)
}

let token = value('--token')
if (token === undefined && value('--token-file') !== undefined) {
  token = fs.readFileSync(value('--token-file'), 'utf8').trim()
}

if (typeof token !== 'string' || token.trim() === '') {
  console.error('没有可导入的 token：加 --desktop / --token-file <路径> / --token eyJ... 之一')
  process.exit(1)
}

console.log(JSON.stringify(await importOne(token, value('--label'), 'manual'), null, 2))
