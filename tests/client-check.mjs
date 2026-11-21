#!/usr/bin/env node
/**
 * 浏览器半侧的离线体检：用假的 window.__ModuleLoader__ + 假 React 把
 * lib/client.js 装配起来，然后
 *   1. 验证 apply() 往 slots 注册了 main / sidebar.panellist；
 *   2. 用最小渲染器把最终版页面跑一遍（空池、有数据、四个弹窗），
 *      验证控件与图表真的出现在渲染树里。
 *
 *   node tests/client-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/* ---------------- 假 React ---------------- */
let hooks = []
let hookCursor = 0

function resetHooks() {
  hooks = []
  hookCursor = 0
}

const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    const merged = Object.assign({}, props || {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    const index = hookCursor++
    if (index >= hooks.length) hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }
    return [hooks[index], set]
  },
  useEffect() {},
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}

/* ---------------- 假模块加载器 ---------------- */
const loaded = []
const fakeWindow = {
  __ModuleLoader__: {
    load(registration) {
      loaded.push(registration)
    },
  },
}

const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
}

// eslint-disable-next-line no-new-func
const run = new Function('window', 'require', 'document', source)
run(fakeWindow, requireShim, undefined)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

check('通过 __ModuleLoader__ 注册了一个 bundle', loaded.length === 1, `id=${loaded[0]?.id}`)
check('bundle id 正确', loaded[0]?.id === 'dsh-workbuddy-pool')

const exported = loaded[0].factory(requireShim)
check('导出 apply', typeof exported.apply === 'function')
check('导出 inject 含 slots', Array.isArray(exported.inject) && exported.inject.includes('slots'))

/* ---------------- 假 slots ---------------- */
const registrations = []
const ctx = {
  slots: {
    inject(slot, factory) {
      registrations.push({ slot, result: factory() })
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
}

exported.apply(ctx)
check('注册了 2 个槽位', registrations.length === 2, registrations.map((row) => row.slot).join(','))

const mainReg = registrations.find((row) => row.slot === 'main')
const navReg = registrations.find((row) => row.slot === 'sidebar.panellist')
check('main 槽位 key 正确', mainReg?.result?.options?.key === 'workbuddy-pool', String(mainReg?.result?.options?.key))
check('侧栏按钮 id 与 main 一致', navReg?.result?.options?.id === 'workbuddy-pool')
check('侧栏按钮有文案', navReg?.result?.options?.label === 'WorkBuddy')

/* ---------------- 最小渲染器 ---------------- */
function render(node, depth = 0, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) render(child, depth, out)
    return out
  }
  if (typeof node.type === 'function') {
    resetHooks()
    const inner = node.type(node.props)
    render(inner, depth + 1, out)
    return out
  }
  for (const child of node.children) render(child, depth, out)
  return out
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    resetHooks()
    collect(node.type(node.props), predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) collect(child, predicate, out)
  return out
}

const Page = mainReg.result.component
const Icon = navReg.result.component
const textOf = (node) => render(node).join(' ')

/* 1. 空池态 */
const emptyText = textOf(React.createElement(Page, {}))
check('空池渲染出引导文案', emptyText.includes('账号池还是空的'))
check('空池渲染出导入入口', emptyText.includes('开始导入'))

/* 2. 有数据态 */
const today = '2026-11-21'
const canned = {
  ok: true,
  generatedAt: new Date().toISOString(),
  today,
  pool: {
    file: 'C:\\Users\\you\\.dsh\\workbuddy-pool\\pool.json',
    version: 1,
    activeAccountId: 'acc-1',
    hiddenSessions: [],
    accounts: [
      {
        id: 'acc-1', label: '风灵玉秀', nickname: '风灵玉秀', phoneMask: '150****9364',
        tokenValid: true, tokenLeftDays: 30, enabled: true, plan: '体验版',
        balanceTotal: 2080.29, balanceAt: new Date().toISOString(),
        balanceGroups: [{ kind: 'plan_base', name: '套餐基础积分', remain: 380.29 }, { kind: 'benefit', name: '平台奖励积分', remain: 1700 }],
        checkin: { day: today, credit: 100, streakDays: 2, status: 'claimed' },
        checkinStatus: { streakDays: 2, todayCheckedIn: true },
        todaySpend: 1.23, updatedAt: new Date().toISOString(), lastError: null,
      },
      {
        id: 'acc-2', label: '大肥鱼', nickname: '大肥鱼青春版', phoneMask: '134****2985',
        tokenValid: true, tokenLeftDays: 29.9, enabled: false, plan: '体验版',
        balanceTotal: 2099.88, balanceAt: new Date().toISOString(),
        balanceGroups: [{ kind: 'plan_base', name: '套餐基础积分', remain: 500 }],
        checkin: { day: today, credit: 100, streakDays: 1, status: 'claimed' },
        checkinStatus: { streakDays: 1, todayCheckedIn: true },
        todaySpend: 0, updatedAt: new Date().toISOString(), lastError: null,
      },
    ],
  },
  totals: { accounts: 2, enabled: 1, balance: 4180.17, todayGained: 200, todayCheckin: 200, todaySpend: 1.23, todayRequests: 4, allTimeSpend: 12.3 },
  daily: [
    { day: '2026-11-20', gained: 0, checkin: 0, spend: 0.5, requests: 2, prompt: 100, completion: 50 },
    { day: today, gained: 200, checkin: 200, spend: 1.23, requests: 4, prompt: 300, completion: 120 },
  ],
  history: [],
  week: {
    start: '2026-11-16', end: today, gained: 242, spend: 11.73, requests: 11,
    days: [
      { day: '2026-11-16', gained: 12, spend: 3, requests: 1 },
      { day: '2026-11-17', gained: 0, spend: 2, requests: 1 },
      { day: '2026-11-18', gained: 30, spend: 4, requests: 2 },
      { day: '2026-11-19', gained: 0, spend: 1, requests: 1 },
      { day: '2026-11-20', gained: 0, spend: 0.5, requests: 2 },
      { day: today, gained: 200, spend: 1.23, requests: 4 },
    ],
  },
  sessions: [
    {
      id: 'session-abc', attached: true, title: '设计 workBuddy 账号池与积分计费插件', cwd: 'D:\\projects\\demo', turns: 3,
      tokens: 50700000, spend: 1.23, requests: 4, prompt: 300, completion: 120,
      lastAt: new Date(Date.now() - 17 * 60000).toISOString(), firstAt: new Date(Date.now() - 3600000).toISOString(),
      models: { 'glm-5.3-flash': 4 },
    },
    {
      id: 'unattributed:2026-11-20', attached: false, title: '未归因（2026-11-20）', cwd: '', turns: 0, tokens: 0,
      spend: 0.5, requests: 2, prompt: 100, completion: 50,
      lastAt: new Date().toISOString(), firstAt: new Date().toISOString(), models: {},
    },
  ],
  models: [],
  usage: { log: 'D:\\wb-proxy\\logs\\usage.jsonl', scanned: 12 },
  scheduler: { enabled: true, checkinAt: '00:05', snapshotMinutes: 30, autoHarvest: true, lastTickAt: new Date().toISOString() },
}

const pageTree = React.createElement(Page, { __testData: canned })
const fullText = textOf(pageTree)
check('有数据：渲染总余额', fullText.includes('总余额') && fullText.includes('2080.29'))
check('有数据：渲染两个账号', fullText.includes('风灵玉秀') && fullText.includes('大肥鱼'))
check('有数据：渲染签到状态', fullText.includes('已签'))
check('有数据：每日积分区块', fullText.includes('每日积分（近 7 天）'))
check('有数据：柱形图图例', fullText.includes('新增积分') && fullText.includes('消耗积分'))
check('有数据：有本周积分入口', fullText.includes('本周积分'))
check('有数据：会话卡渲染标题', fullText.includes('设计 workBuddy 账号池与积分计费插件'))

const switches = collect(pageTree, (node) => node.props && node.props.role === 'switch')
check('账号开关渲染了 2 个', switches.length === 2, `count=${switches.length}`)
check('第一个账号开关是 ON', switches[0]?.props?.['aria-checked'] === 'true')
check('第二个账号开关是 OFF', switches[1]?.props?.['aria-checked'] === 'false')

const rings = collect(pageTree, (node) => node.props && node.props.className === 'wbk-ring')
check('每个会话卡一个圆环', rings.length === 2, `count=${rings.length}`)

const refreshBtns = collect(pageTree, (node) => node.props && node.props.className === 'wbk-refresh')
check('账号栏右侧有刷新符号', refreshBtns.length === 1, `count=${refreshBtns.length}`)

const charts = collect(pageTree, (node) => node.type === 'svg' && node.props.className === 'wbk-chart')
check('每日积分渲染了柱形图 svg', charts.length >= 1, `count=${charts.length}`)

const scrollers = collect(pageTree, (node) => node.props && node.props.className === 'wbk-hscroll')
check('两处横向滚动容器', scrollers.length === 2, `count=${scrollers.length}`)

const buttons = collect(pageTree, (node) => node.type === 'button')
const buttonText = buttons.map((node) => textOf(node)).join('|')
check('右上角三个按钮', ['刷新余额', '立即签到', '导入账号'].every((label) => buttonText.includes(label)), buttonText.slice(0, 80))

const cards = collect(pageTree, (node) => node.props && node.props.className === 'wbk-card')
const cardButtonTexts = cards
  .flatMap((card) => collect(card, (node) => node.type === 'button').map((node) => textOf(node).trim()))
  .filter((text) => text !== '')
check('账号卡上只有删除按钮', cardButtonTexts.length === 2 && cardButtonTexts.every((text) => text === '删除'), cardButtonTexts.join(','))

check('会话卡片各有一个刷新', buttons.filter((node) => textOf(node).trim() === '刷新').length === 2)
check('账号卡有删除按钮', buttons.filter((node) => textOf(node).trim() === '删除').length >= 2)

/* 3. 当日明细弹窗（柱形图） */
const dayText = textOf(React.createElement(Page, { __testData: canned, __testDay: canned.week.days[5] }))
check('当日明细弹窗出现', dayText.includes('积分明细') && dayText.includes('当日新增（含签到）'))
check('当日明细有新增/消耗', dayText.includes('+200') && dayText.includes('-1.23'))

/* 4. 本周弹窗（折线） */
const weekText = textOf(React.createElement(Page, { __testData: canned, __testWeek: true }))
check('本周弹窗出现', weekText.includes('本周积分（2026-11-16'))
check('本周弹窗有合计', weekText.includes('本周新增合计'))

/* 5. 会话明细弹窗（四个饼图） */
const sessionText = textOf(React.createElement(Page, { __testData: canned, __testSession: canned.sessions[0] }))
check('会话明细弹窗出现', sessionText.includes('会话消耗明细'))
check('会话明细四个统计量', ['请求数', 'tokens', '积分', '最近'].every((label) => sessionText.includes(label)))
check('会话明细有占比百分比', /%/.test(sessionText))

/* 6. 删除确认弹窗 */
const confirmText = textOf(React.createElement(Page, { __testData: canned, __testConfirm: canned.pool.accounts[1] }))
check('删除账号先弹确认框', confirmText.includes('确认删除账号') && confirmText.includes('大肥鱼'))
check('确认框有取消与确认', confirmText.includes('取消') && confirmText.includes('确认删除'))

const sessionConfirmText = textOf(React.createElement(Page, { __testData: canned, __testConfirmSession: canned.sessions[0] }))
check('删除会话统计先弹确认框', sessionConfirmText.includes('确认删除会话统计') && sessionConfirmText.includes('对话本身与历史消息都不受影响'))
check('会话确认框有取消与确认', sessionConfirmText.includes('取消') && sessionConfirmText.includes('确认删除'))

/* 7. 侧栏图标是 svg */
const icon = Icon({ size: 16, active: false })
check('侧栏图标返回 svg', icon && icon.type === 'svg', String(icon?.type))

/* 8. 「立即签到」的结果文案：自动签到后再点要显示今天已领多少 */
const summarize = exported.__test?.checkinSummary
if (typeof summarize === 'function') {
  const alreadyText = summarize({
    results: [
      { accountId: 'a', label: '风灵玉秀', status: 'already', credit: 0, todayCredit: 100 },
      { accountId: 'b', label: '大肥鱼', status: 'already', credit: 0, todayCredit: 100 },
    ],
  })
  check('已签到时说明今天已签多少', alreadyText.includes('今天已经签过了') && alreadyText.includes('+200'), alreadyText)
  check('已签到时带分账号明细', alreadyText.includes('风灵玉秀 +100') && alreadyText.includes('大肥鱼 +100'), alreadyText)

  const freshText = summarize({
    results: [{ accountId: 'a', label: '风灵玉秀', status: 'claimed', credit: 100, todayCredit: 100 }],
  })
  check('新到账时说明新到账多少', freshText.includes('新到账 +100'), freshText)

  const mixedText = summarize({
    results: [
      { accountId: 'a', label: '风灵玉秀', status: 'claimed', credit: 100, todayCredit: 100 },
      { accountId: 'b', label: '大肥鱼', status: 'already', credit: 0, todayCredit: 100 },
    ],
  })
  check('混合时同时给新到账与今天合计', mixedText.includes('新到账 +100') && mixedText.includes('今天合计 +200'), mixedText)

  const noneText = summarize({ results: [{ accountId: 'a', label: '风灵玉秀', status: 'already', credit: 0, todayCredit: 0 }] })
  check('确实没积分时也有说明', noneText.includes('没有新的签到积分'), noneText)
} else {
  check('导出 checkinSummary 供体检', false)
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：', failed.map((row) => row.name).join('，'))
  process.exit(1)
}
