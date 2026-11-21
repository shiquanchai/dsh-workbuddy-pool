#!/usr/bin/env node
/**
 * 离线预览：用假 React 把详情页渲染成静态 HTML（带内联样式），
 * 方便在没有 dsh 的情况下先看版式。
 *
 *   node tools/preview.mjs            # 生成 preview.html
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

let hooks = []
let cursor = 0
const reset = () => { hooks = []; cursor = 0 }

const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    const merged = Object.assign({}, props || {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    const index = cursor++
    if (index >= hooks.length) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
  },
  useEffect() {},
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}

const loaded = []
const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
}
// eslint-disable-next-line no-new-func
new Function('window', 'require', 'document', source)({ __ModuleLoader__: { load: (r) => loaded.push(r) } }, requireShim, undefined)

const registrations = []
const ctx = { slots: { inject: (slot, factory) => { registrations.push({ slot, result: factory() }); return () => {} }, register: (options, component) => ({ options, component }) } }
loaded[0].factory(requireShim).apply(ctx)
const Page = registrations.find((row) => row.slot === 'main').result.component

const VOID = new Set(['br', 'hr', 'img', 'input', 'circle', 'rect', 'path', 'line', 'ellipse', 'polyline', 'polygon', 'use', 'stop'])
const camel = (name) => name.startsWith('data-') || name.startsWith('aria-') ? name : name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

function styleOf(style) {
  if (style === null || style === undefined || typeof style !== 'object') return ''
  return Object.entries(style).map(([key, value]) => `${camel(key)}:${value}`).join(';')
}

function toHtml(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node.type === 'function') {
    reset()
    return toHtml(node.type(node.props))
  }
  const attrs = []
  for (const [key, value] of Object.entries(node.props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'children' || key === 'ref' || key === 'key' || key.startsWith('on')) continue
    if (key === 'style') { attrs.push(`style="${styleOf(value)}"`); continue }
    if (key === 'className') { attrs.push(`class="${value}"`); continue }
    attrs.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
  }
  const open = `<${node.type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
  if (VOID.has(node.type)) return open
  return `${open}${(node.children || []).map(toHtml).join('')}</${node.type}>`
}

const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))
const weekDays = []
for (let i = 0; i < 7; i += 1) {
  const cursorDay = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i)
  if (dayKey(cursorDay) > dayKey(today)) break
  weekDays.push({ day: dayKey(cursorDay), gained: i === 1 ? 30 : i === 5 ? 100 : 0, checkin: i === 5 ? 100 : 0, spend: [3, 2, 4, 1, 0.5, 1.23, 0][i] || 0, requests: 2, prompt: 200, completion: 80 })
}

const data = {
  ok: true,
  generatedAt: new Date().toISOString(),
  today: dayKey(today),
  pool: {
    file: 'C:\\Users\\you\\.dsh\\workbuddy-pool\\pool.json',
    version: 1,
    activeAccountId: 'acc-1',
    hiddenSessions: [],
    accounts: [
      { id: 'acc-1', label: '风灵玉秀', nickname: '风灵玉秀', phoneMask: '150****9364', tokenValid: true, tokenLeftDays: 30, enabled: true, plan: '体验版', balanceTotal: 2080.29, balanceAt: new Date().toISOString(), balanceGroups: [{ name: '套餐基础积分', remain: 380.29 }, { name: '平台奖励积分', remain: 1700 }], checkin: { day: dayKey(today), credit: 100, streakDays: 2 }, checkinStatus: { streakDays: 2 }, todaySpend: 1.23, updatedAt: new Date(Date.now() - 29 * 60000).toISOString(), lastError: null },
      { id: 'acc-2', label: '大肥鱼', nickname: '大肥鱼青春版', phoneMask: '134****2985', tokenValid: true, tokenLeftDays: 29.9, enabled: false, plan: '体验版', balanceTotal: 2099.88, balanceAt: new Date().toISOString(), balanceGroups: [{ name: '套餐基础积分', remain: 500 }, { name: '平台奖励积分', remain: 1599.88 }], checkin: { day: dayKey(today), credit: 100, streakDays: 1 }, checkinStatus: { streakDays: 1 }, todaySpend: 0, updatedAt: new Date(Date.now() - 40 * 60000).toISOString(), lastError: null },
    ],
  },
  totals: { accounts: 2, enabled: 1, balance: 4180.17, todayGained: 200, todayCheckin: 200, todaySpend: 1.23, todayRequests: 4, allTimeSpend: 12.3 },
  daily: weekDays,
  history: weekDays,
  week: { start: weekDays[0]?.day || '', end: dayKey(today), gained: 130, spend: 11.73, requests: 14, days: weekDays },
  sessions: [
    { id: 'session-abc', attached: true, title: '设计 workBuddy 账号池与积分计费插件', cwd: 'D:\\projects\\demo', turns: 3, tokens: 50700000, spend: 1.23, requests: 4, prompt: 300, completion: 120, lastAt: new Date(Date.now() - 17 * 60000).toISOString(), firstAt: new Date(Date.now() - 3 * 3600000).toISOString(), models: { 'glm-5.3-flash': 4 } },
    { id: 'session-def', attached: true, title: '湖山电器实习报告撰写', cwd: 'E:\\湖山电器生产实习', turns: 6, tokens: 97400000, spend: 6.42, requests: 30, prompt: 18000, completion: 9000, lastAt: new Date(Date.now() - 9 * 3600000).toISOString(), firstAt: new Date(Date.now() - 26 * 3600000).toISOString(), models: { 'deepseek-v4.1-flash': 12 } },
    { id: 'unattributed:2026-11-20', attached: false, title: '未归因（2026-11-20）', cwd: '', turns: 0, tokens: 0, spend: 0.5, requests: 2, prompt: 100, completion: 50, lastAt: new Date(Date.now() - 20 * 3600000).toISOString(), firstAt: new Date(Date.now() - 21 * 3600000).toISOString(), models: {} },
  ],
  models: [],
  usage: { log: 'D:\\wb-proxy\\logs\\usage.jsonl', scanned: 42 },
  scheduler: { enabled: true, checkinAt: '00:05', snapshotMinutes: 30, autoHarvest: true, lastTickAt: new Date().toISOString() },
}

const body = toHtml(React.createElement(Page, { __testData: data }))
const styleMatch = /var STYLE_ID = 'wbk-style'\s*var CSS = (\[[\s\S]*?\]\.join\('\\n'\))/.exec(source)
let css = ''
if (styleMatch !== null) {
  // eslint-disable-next-line no-new-func
  css = new Function(`return ${styleMatch[1]}`)()
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WorkBuddy 账号池 · 版式预览</title>
<style>
:root{--dsw-alias-label-primary:#e8edf5;--dsw-alias-label-secondary:#9fb0c4;--dsw-alias-label-tertiary:#6f8298;--dsw-alias-bg-base:#11161d;--dsw-alias-bg-layer-1:rgba(255,255,255,.035);--dsw-alias-border-l1:rgba(255,255,255,.09);--dsw-alias-border-l2:rgba(255,255,255,.16);--dsw-alias-brand-primary:#4f8ef7;--dsw-alias-state-success-primary:#2f9e6e;--dsw-alias-state-warning-primary:#d97706;--dsw-alias-state-danger-primary:#e05c5c;--dsh-content-font-size-secondary:13px}
body{margin:0;background:#0d1117;color:#e8edf5;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.wbk-root{height:auto}
</style>
<style>${css}</style>
</head>
<body>${body}
<p style="max-width:1020px;margin:0 auto;padding:0 34px 40px 26px;color:#6f8298;font-size:11px">
静态预览（数据为示例）。真实页面在 dsh 里由同一份 client.js 渲染，颜色跟随 dsh 主题变量。
</p>
</body></html>`

const out = path.join(root, 'docs', 'preview.html')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log(`wrote ${out} (${html.length} bytes)`)
