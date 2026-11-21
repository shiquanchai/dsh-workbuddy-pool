/**
 * dsh-workbuddy-pool — 浏览器半侧（最终版）。
 *
 * 契约：`{ name, inject: ['slots'], apply(ctx) }`，由 host 的
 * `dsh.client.platform = 'web'` + `exports['./client']` 提供，走
 * `window.__ModuleLoader__` 握手；`react` 由外壳的模块表提供，不在包里打包。
 *
 * 注册两个槽位：
 *   - `main`（keyed，key = workbuddy-pool）→ 详情页
 *   - `sidebar.panellist`（id 同上）→ 左侧栏 WorkBuddy 按钮
 *
 * 页面：KPI → 账号（开关 / 删除需确认 / 区块右侧刷新符号）
 *      → 每日积分（近 7 天分组柱形图，点柱子看当日明细）
 *      → 每个对话（会话卡 + 圆环，点圆环放大看四个统计量），两块都横向滚动。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-pool',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useMemo = React.useMemo
    var module = { exports: {} }

    var PAGE_ID = 'workbuddy-pool'
    var API = '/workbuddy-pool/api'

    /* ---------------------------------------------------------------- *
     * 样式
     * ---------------------------------------------------------------- */
    var STYLE_ID = 'wbk-style'
    var CSS = [
      '.wbk-root{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;overflow-x:hidden;color:var(--dsw-alias-label-primary,#1b1b1f);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}',
      '.wbk-inner{display:flex;flex-direction:column;gap:18px;width:100%;max-width:1020px;margin:0 auto;box-sizing:border-box;padding:calc(var(--dsh-frame-chrome-top,0px) + 20px) 34px 56px 26px}',
      '.wbk-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}',
      '.wbk-head-main{flex:1 1 260px;min-width:0}',
      '.wbk-title{margin:0;font-size:20px;font-weight:650;letter-spacing:-0.01em}',
      '.wbk-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px}',
      '.wbk-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;padding-right:6px}',
      '.wbk-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));background:transparent;color:inherit;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;white-space:nowrap;line-height:1.4}',
      '.wbk-btn:hover{border-color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.wbk-btn[data-size="sm"]{padding:2px 9px;font-size:11.5px;border-radius:7px}',
      '.wbk-btn[data-variant="primary"]{border-color:var(--dsw-alias-brand-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 16%,transparent);font-weight:650}',
      '.wbk-btn[data-variant="ghost"]{border-color:transparent;opacity:.72}',
      '.wbk-btn[data-variant="danger"]{color:var(--dsw-alias-state-danger-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#dc2626) 42%,transparent)}',
      '.wbk-btn[data-variant="danger"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#dc2626) 12%,transparent)}',
      '.wbk-btn[disabled]{opacity:.45;cursor:default}',
      /* 图4 那种刷新符号：圆角方块 + 环形箭头 */
      '.wbk-refresh{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary,#8aa0b8);cursor:pointer;padding:0}',
      '.wbk-refresh:hover{border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.wbk-refresh svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
      '.wbk-refresh[data-spin="1"] svg{animation:wbk-spin 1s linear infinite}',
      '@keyframes wbk-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '.wbk-note{margin:0;padding:8px 12px;border-radius:8px;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b45309) 12%,transparent);color:var(--dsw-alias-label-primary,#1b1b1f)}',
      '.wbk-note[data-kind="error"]{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#dc2626) 14%,transparent)}',
      '.wbk-note[data-kind="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 12%,transparent)}',
      '.wbk-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}',
      '.wbk-kpi{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05))}',
      '.wbk-kpi-label{font-size:11px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.wbk-kpi-value{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.wbk-kpi-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b);margin-top:3px}',
      '.wbk-section{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.wbk-section-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.wbk-section-title{font-size:13px;font-weight:650;white-space:nowrap}',
      '.wbk-section-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b);min-width:0}',
      '.wbk-section-tools{margin-left:auto;display:flex;gap:6px;align-items:center}',
      '.wbk-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}',
      '.wbk-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:10px}',
      '.wbk-card[data-off="1"]{opacity:.62}',
      '.wbk-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.wbk-name{font-weight:650;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbk-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}',
      '.wbk-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#15803d);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 45%,transparent)}',
      '.wbk-badge[data-tone="warn"]{color:var(--dsw-alias-state-warning-primary,#b45309);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b45309) 45%,transparent)}',
      '.wbk-badge[data-tone="bad"]{color:var(--dsw-alias-state-danger-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#dc2626) 45%,transparent)}',
      '.wbk-switch{width:38px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.36));background:rgba(127,127,127,.22);position:relative;cursor:pointer;padding:0;flex:none}',
      '.wbk-switch[data-on="1"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 62%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 70%,transparent)}',
      '.wbk-switch-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left .16s ease}',
      '.wbk-switch[data-on="1"] .wbk-switch-knob{left:19px}',
      '.wbk-switch-text{font-size:10.5px;font-weight:650;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.wbk-switch-text[data-on="1"]{color:var(--dsw-alias-state-success-primary,#15803d)}',
      '.wbk-balance{display:flex;align-items:baseline;gap:8px}',
      '.wbk-balance-value{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.wbk-balance-unit{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.wbk-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.wbk-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}',
      '.wbk-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);display:flex;gap:12px;flex-wrap:wrap}',
      '.wbk-meta b{font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1f);font-variant-numeric:tabular-nums}',
      '.wbk-card-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
      '.wbk-empty{border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:10px}',
      '.wbk-empty-title{font-weight:650;font-size:14px}',
      '.wbk-steps{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;display:flex;flex-direction:column;gap:4px}',
      /* 横向滚动 */
      '.wbk-hscroll{overflow-x:auto;overflow-y:hidden;padding:2px 2px 8px;scrollbar-width:thin;border-radius:10px}',
      '.wbk-hscroll::-webkit-scrollbar{height:8px}',
      '.wbk-hscroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.32);border-radius:4px}',
      '.wbk-hscroll::-webkit-scrollbar-track{background:transparent}',
      /* 图表 */
      '.wbk-chartwrap{min-width:820px}',
      '.wbk-chart{width:100%;height:auto;display:block}',
      '.wbk-chart text{fill:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:10px;font-family:inherit}',
      '.wbk-chart .wbk-axis{stroke:rgba(127,127,127,.2);stroke-width:1}',
      '.wbk-chart .wbk-bar{cursor:pointer}',
      '.wbk-chart .wbk-bar:hover rect{opacity:1}',
      '.wbk-chart .wbk-bar rect{opacity:.88;transition:opacity .12s ease}',
      '.wbk-legend{display:flex;gap:14px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);flex-wrap:wrap}',
      '.wbk-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}',
      /* 会话卡（参考 dsh-context 的卡片气质） */
      '.wbk-sessgrid{display:flex;gap:12px;min-width:min-content;padding:2px}',
      '.wbk-sesscard{flex:none;width:340px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));display:flex;flex-direction:column;gap:10px}',
      '.wbk-sess-top{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.wbk-sess-title{font-size:13px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}',
      '.wbk-sess-when{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b8b8b);white-space:nowrap}',
      '.wbk-sess-tags{display:flex;gap:6px;flex-wrap:wrap}',
      '.wbk-tag{font-size:10.5px;padding:1px 7px;border-radius:6px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary,#6b7280);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbk-sess-body{display:flex;gap:12px;align-items:center}',
      '.wbk-ring{border:none;background:transparent;padding:0;cursor:pointer;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center}',
      '.wbk-ring:hover{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 22%,transparent)}',
      '.wbk-ring svg{width:78px;height:78px}',
      '.wbk-ring text{fill:var(--dsw-alias-label-primary,#1b1b1f);font-size:14px;font-weight:650}',
      '.wbk-ring-sub{font-size:9.5px;fill:var(--dsw-alias-label-tertiary,#8b8b8b);font-weight:400}',
      '.wbk-sess-stats{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);min-width:0;flex:1 1 auto}',
      '.wbk-sess-stats div{display:flex;justify-content:space-between;gap:6px;min-width:0}',
      '.wbk-sess-stats b{color:var(--dsw-alias-label-primary,#1b1b1f);font-weight:600;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbk-sess-actions{display:flex;gap:6px;justify-content:flex-end}',
      '.wbk-dim{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11px}',
      /* 弹窗 */
      '.wbk-modal{position:fixed;inset:0;background:rgba(0,0,0,.52);display:flex;align-items:center;justify-content:center;z-index:1200;padding:28px}',
      '.wbk-modal-box{width:min(680px,100%);max-height:84vh;overflow:auto;border-radius:14px;padding:16px 18px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 48px rgba(0,0,0,.3)}',
      '.wbk-modal-box[data-wide="1"]{width:min(760px,100%)}',
      '.wbk-modal-head{display:flex;align-items:center;gap:10px}',
      '.wbk-modal-title{font-size:15px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wbk-modal-close{margin-left:auto;border:none;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;opacity:.6;padding:2px 4px}',
      '.wbk-modal-close:hover{opacity:1}',
      '.wbk-field{display:flex;flex-direction:column;gap:5px}',
      '.wbk-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.wbk-input,.wbk-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;padding:7px 9px;font-size:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:inherit;font-family:inherit}',
      '.wbk-textarea{min-height:92px;resize:vertical;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11.5px;word-break:break-all}',
      '.wbk-modal-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
      '.wbk-donuts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}',
      '.wbk-donut-wrap{display:flex;flex-direction:column;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:12px;padding:12px 8px}',
      '.wbk-donut{width:128px;height:128px}',
      '.wbk-donut text.wbk-donut-pct{fill:var(--dsw-alias-label-primary,#1b1b1f);font-size:20px;font-weight:650}',
      '.wbk-donut text.wbk-donut-name{fill:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:10px}',
      '.wbk-donut-label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.wbk-donut-value{font-size:13px;font-weight:650;font-variant-numeric:tabular-nums}',
      '.wbk-rows{display:flex;flex-direction:column;gap:6px;font-size:12px}',
      '.wbk-rowline{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));padding-bottom:4px}',
      '.wbk-rowline span:last-child{font-variant-numeric:tabular-nums;font-weight:600}',
      '.wbk-foot{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b);display:flex;flex-direction:column;gap:3px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));padding-top:10px}',
      '.wbk-code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;word-break:break-all}'
    ].join('\n')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ---------------------------------------------------------------- *
     * 格式化
     * ---------------------------------------------------------------- */
    function num(value, digits) {
      var v = Number(value)
      if (!Number.isFinite(v)) return '—'
      var fixed = v.toFixed(digits === undefined ? 2 : digits)
      return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
    }

    function credits(value) {
      if (value === null || value === undefined) return '—'
      return num(value, 2)
    }

    function tokens(value) {
      var v = Number(value) || 0
      if (v >= 100000000) return (v / 100000000).toFixed(2) + '亿'
      if (v >= 10000) return (v / 10000).toFixed(1) + '万'
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
      return String(v)
    }

    function when(iso) {
      if (!iso) return '—'
      var ts = Date.parse(iso)
      if (!Number.isFinite(ts)) return '—'
      var diff = Date.now() - ts
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      var d = new Date(ts)
      var pad = function (n) { return String(n).padStart(2, '0') }
      return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function dayLabel(day) {
      return String(day || '').slice(5)
    }

    var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    function weekday(day) {
      var ts = Date.parse(day + 'T00:00:00')
      if (!Number.isFinite(ts)) return ''
      return WEEKDAYS[new Date(ts).getDay()]
    }

    function baseName(dir) {
      if (typeof dir !== 'string' || dir === '') return ''
      var parts = dir.split(/[\\/]+/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : dir
    }

    /** 本地时区本周一（兼容旧宿主：没有 week 字段时前端自己算）。 */
    function weekFromRows(rows) {
      var list = Array.isArray(rows) ? rows : []
      var now = new Date()
      var pad = function (n) { return String(n).padStart(2, '0') }
      var todayKey = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      var start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
      var byDay = {}
      for (var i = 0; i < list.length; i += 1) byDay[list[i].day] = list[i]
      var days = []
      for (var index = 0; index < 7; index += 1) {
        var cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
        var key = cursor.getFullYear() + '-' + pad(cursor.getMonth() + 1) + '-' + pad(cursor.getDate())
        if (key > todayKey) break
        days.push(byDay[key] || { day: key, gained: 0, checkin: 0, spend: 0, requests: 0, prompt: 0, completion: 0 })
      }
      var gained = 0
      var spend = 0
      var requests = 0
      for (var j = 0; j < days.length; j += 1) {
        gained += Number(days[j].gained) || 0
        spend += Number(days[j].spend) || 0
        requests += Number(days[j].requests) || 0
      }
      return {
        start: days.length > 0 ? days[0].day : '',
        end: days.length > 0 ? days[days.length - 1].day : '',
        days: days,
        gained: gained,
        spend: spend,
        requests: requests
      }
    }

    /* ---------------------------------------------------------------- *
     * 请求
     * ---------------------------------------------------------------- */
    function request(path, options) {
      var init = options || {}
      return fetch(API + path, {
        method: init.method || 'GET',
        headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: 'no-store'
      }).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (payload) {
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || ('HTTP ' + response.status))
          }
          return payload
        })
      })
    }

    /* ---------------------------------------------------------------- *
     * 基础组件
     * ---------------------------------------------------------------- */
    function Btn(props) {
      return h('button', {
        type: 'button',
        className: 'wbk-btn',
        'data-variant': props.variant,
        'data-size': props.size,
        disabled: props.disabled ? true : undefined,
        title: props.title,
        onClick: props.onClick
      }, props.children)
    }

    function RefreshButton(props) {
      return h('button', {
        type: 'button',
        className: 'wbk-refresh',
        title: props.title || '刷新账号（档案 + 余额 + 签到状态）',
        'data-spin': props.spinning ? '1' : '0',
        disabled: props.disabled ? true : undefined,
        onClick: props.onClick
      }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M13.1 8a5.1 5.1 0 1 1-1.5-3.6' }),
        h('path', { d: 'M13.3 2.6v2.9h-2.9' })
      ))
    }

    function Switch(props) {
      var on = props.on === true
      return h('button', {
        type: 'button',
        className: 'wbk-switch',
        'data-on': on ? '1' : '0',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        title: on ? 'ON：使用该账号积分，点击关闭' : 'OFF：不使用该账号积分，请求改走其它 ON 的账号',
        onClick: props.onChange
      }, h('span', { className: 'wbk-switch-knob' }))
    }

    function Kpi(props) {
      return h('div', { className: 'wbk-kpi' },
        h('div', { className: 'wbk-kpi-label' }, props.label),
        h('div', { className: 'wbk-kpi-value' }, props.value),
        props.sub ? h('div', { className: 'wbk-kpi-sub' }, props.sub) : null
      )
    }

    function Section(props) {
      return h('section', { className: 'wbk-section' },
        h('div', { className: 'wbk-section-head' },
          h('div', { className: 'wbk-section-title' }, props.title),
          props.hint ? h('div', { className: 'wbk-section-hint' }, props.hint) : null,
          props.tools ? h('div', { className: 'wbk-section-tools' }, props.tools) : null
        ),
        props.children
      )
    }

    function Modal(props) {
      return h('div', {
        className: 'wbk-modal',
        onClick: function (event) { if (event.target === event.currentTarget) props.onClose() }
      },
        h('div', { className: 'wbk-modal-box', 'data-wide': props.wide ? '1' : '0' },
          h('div', { className: 'wbk-modal-head' },
            h('div', { className: 'wbk-modal-title', title: props.title }, props.title),
            h('button', { type: 'button', className: 'wbk-modal-close', onClick: props.onClose, 'aria-label': '关闭' }, '×')
          ),
          props.children
        )
      )
    }

    /** 滚轮上下 = 横向左右滑动。 */
    function bindWheel(node) {
      if (node === null || node === undefined || node.dataset === undefined) return
      if (node.dataset.wbk_wheel === '1') return
      node.dataset.wbk_wheel = '1'
      node.addEventListener('wheel', function (event) {
        if (event.deltaY === 0) return
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
        if (node.scrollWidth <= node.clientWidth) return
        node.scrollLeft += event.deltaY
        event.preventDefault()
      }, { passive: false })
    }

    /* ---------------------------------------------------------------- *
     * 图表
     * ---------------------------------------------------------------- */
    function niceMax(value) {
      var v = Math.max(1, Number(value) || 0)
      var pow = Math.pow(10, Math.floor(Math.log10(v)))
      var scaled = v / pow
      var step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
      return step * pow
    }

    /** 每日积分：分组柱形图（新增 / 消耗），点柱子看当日明细。 */
    function DailyBars(props) {
      var days = props.days || []
      var onPick = props.onPick
      var width = 860
      var height = 300
      var padLeft = 58
      var padRight = 20
      var padTop = 22
      var padBottom = 46
      var innerWidth = width - padLeft - padRight
      var innerHeight = height - padTop - padBottom
      var rawMax = 0
      for (var i = 0; i < days.length; i += 1) {
        rawMax = Math.max(rawMax, Number(days[i].gained) || 0, Number(days[i].spend) || 0)
      }
      var max = niceMax(rawMax)
      var yAt = function (value) { return padTop + innerHeight - (innerHeight * (Number(value) || 0)) / max }
      var slot = days.length > 0 ? innerWidth / days.length : innerWidth
      var barWidth = Math.max(10, Math.min(22, slot / 4))

      var grid = []
      for (var step = 0; step <= 4; step += 1) {
        var value = (max * step) / 4
        var y = yAt(value)
        grid.push(h('line', { key: 'g' + step, className: 'wbk-axis', x1: padLeft, y1: y, x2: width - padRight, y2: y }))
        grid.push(h('text', { key: 't' + step, x: padLeft - 8, y: y + 3, textAnchor: 'end' }, num(value, 0)))
      }

      var groups = days.map(function (row, index) {
        var center = padLeft + slot * index + slot / 2
        var gainedValue = Number(row.gained) || 0
        var spendValue = Number(row.spend) || 0
        var gainedHeight = Math.max(gainedValue > 0 ? 2 : 0, (innerHeight * gainedValue) / max)
        var spendHeight = Math.max(spendValue > 0 ? 2 : 0, (innerHeight * spendValue) / max)
        var baseY = padTop + innerHeight
        return h('g', {
          key: row.day,
          className: 'wbk-bar',
          onClick: function () { if (typeof onPick === 'function') onPick(row) }
        },
          h('rect', { x: center - barWidth - 2, y: baseY - gainedHeight, width: barWidth, height: gainedHeight, rx: 3, fill: '#2f9e6e' }),
          h('rect', { x: center + 2, y: baseY - spendHeight, width: barWidth, height: spendHeight, rx: 3, fill: '#d97706' }),
          h('text', { x: center - barWidth / 2 - 2, y: baseY - gainedHeight - 6, textAnchor: 'middle', style: { fontWeight: 600 } },
            gainedValue > 0 ? num(gainedValue, 0) : ''),
          h('text', { x: center + barWidth / 2 + 2, y: baseY - spendHeight - 6, textAnchor: 'middle', style: { fontWeight: 600 } },
            spendValue > 0 ? num(spendValue, 1) : ''),
          h('rect', { x: center - slot / 2 + 2, y: padTop, width: slot - 4, height: innerHeight, fill: 'transparent' }),
          h('text', { x: center, y: height - 20, textAnchor: 'middle' }, dayLabel(row.day)),
          h('text', { x: center, y: height - 7, textAnchor: 'middle', style: { fontSize: '9px' } }, weekday(row.day))
        )
      })

      return h('svg', { viewBox: '0 0 ' + width + ' ' + height, className: 'wbk-chart' },
        grid,
        groups
      )
    }

    /** 某个会话的大号环形图（明细弹窗用）。 */
    function BigDonut(props) {
      var value = Number(props.value) || 0
      var total = Number(props.total) || 0
      var ratio = total > 0 ? Math.min(1, value / total) : 0
      var radius = 44
      var circumference = 2 * Math.PI * radius
      return h('div', { className: 'wbk-donut-wrap' },
        h('svg', { viewBox: '0 0 128 128', className: 'wbk-donut' },
          h('circle', { cx: 64, cy: 64, r: radius, fill: 'none', stroke: 'rgba(127,127,127,.2)', strokeWidth: 12 }),
          h('circle', {
            cx: 64, cy: 64, r: radius, fill: 'none', stroke: props.color || '#2563eb', strokeWidth: 12,
            strokeDasharray: (circumference * ratio).toFixed(2) + ' ' + circumference.toFixed(2),
            strokeLinecap: 'round', transform: 'rotate(-90 64 64)'
          }),
          h('text', { x: 64, y: 62, textAnchor: 'middle', className: 'wbk-donut-pct' }, Math.round(ratio * 100) + '%'),
          h('text', { x: 64, y: 78, textAnchor: 'middle', className: 'wbk-donut-name' }, props.unit || '')
        ),
        h('div', { className: 'wbk-donut-label' }, props.label),
        h('div', { className: 'wbk-donut-value' }, props.valueText)
      )
    }

    /** 会话卡上的小圆环：点击放大看明细。 */
    function MiniRing(props) {
      var ratio = Number(props.ratio) || 0
      var radius = 30
      var circumference = 2 * Math.PI * radius
      return h('button', {
        type: 'button',
        className: 'wbk-ring',
        title: '点击查看这个会话的明细饼图',
        onClick: props.onClick
      },
        h('svg', { viewBox: '0 0 80 80' },
          h('circle', { cx: 40, cy: 40, r: radius, fill: 'none', stroke: 'rgba(127,127,127,.2)', strokeWidth: 8 }),
          h('circle', {
            cx: 40, cy: 40, r: radius, fill: 'none', stroke: props.color || '#2563eb', strokeWidth: 8,
            strokeDasharray: (circumference * ratio).toFixed(2) + ' ' + circumference.toFixed(2),
            strokeLinecap: 'round', transform: 'rotate(-90 40 40)'
          }),
          h('text', { x: 40, y: 42, textAnchor: 'middle' }, Math.round(ratio * 100) + '%'),
          h('text', { x: 40, y: 54, textAnchor: 'middle', className: 'wbk-ring-sub' }, props.caption || '')
        )
      )
    }

    /** 汇总「立即签到」的结果文案：新到账多少、今天合计多少（含此前自动签到的）。 */
    function checkinSummary(result) {
      var rows = (result && result.results) || []
      var newly = 0
      var claimed = 0
      var parts = []
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        var todayCredit = Number(row.todayCredit) || Number(row.credit) || 0
        if (row.status === 'claimed') {
          claimed += 1
          newly += todayCredit
        }
        if (todayCredit > 0) parts.push((row.label || row.accountId) + ' +' + num(todayCredit, 2))
        if (row.status === 'failed') parts.push((row.label || row.accountId) + ' 失败：' + (row.error || '未知错误'))
      }
      var total = 0
      for (var j = 0; j < rows.length; j += 1) total += Number(rows[j].todayCredit) || Number(rows[j].credit) || 0
      var breakdown = parts.length > 0 ? '（' + parts.join('、') + '）' : ''
      if (claimed > 0) {
        return '签到完成：新到账 +' + num(newly, 2) + ' 积分' + (total > newly ? '；今天合计 +' + num(total, 2) : '') + breakdown
      }
      if (total > 0) {
        return '今天已经签过了：今日已签 +' + num(total, 2) + ' 积分' + breakdown
      }
      return '今天已经签过了，没有新的签到积分可领'
    }

    /* ---------------------------------------------------------------- *
     * 弹窗：导入
     * ---------------------------------------------------------------- */
    function ImportDialog(props) {
      var tokenState = useState('')
      var token = tokenState[0]
      var setToken = tokenState[1]
      var labelState = useState('')
      var label = labelState[0]
      var setLabel = labelState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]

      var harvest = function () {
        setBusy('harvest')
        setError(null)
        request('/accounts/harvest', { method: 'POST', body: {} })
          .then(function (payload) {
            var rows = payload.imported || []
            var names = rows.map(function (row) { return row.label || row.phone || row.accountId })
            props.onDone('从桌面端导入 ' + rows.length + ' 个账号：' + names.join('、'))
          })
          .catch(function (reason) { setError(reason.message) })
          .then(function () { setBusy('') })
      }

      var submit = function () {
        if (token.trim() === '') { setError('先粘贴 token'); return }
        setBusy('token')
        setError(null)
        request('/accounts', { method: 'POST', body: { token: token.trim(), label: label.trim() || undefined } })
          .then(function (payload) {
            props.onDone((payload.created ? '已导入：' : '已更新：') + (payload.account && payload.account.label ? payload.account.label : '账号'))
          })
          .catch(function (reason) { setError(reason.message) })
          .then(function () { setBusy('') })
      }

      return h(Modal, { title: '导入 WorkBuddy 账号', onClose: props.onClose },
        h('p', { className: 'wbk-sub' }, '账号池只在本机保存 token，不经过任何第三方。一个账号只需要导入一次，之后每天自动签到。'),
        h('div', { className: 'wbk-empty' },
          h('div', { className: 'wbk-empty-title' }, '方式 A：从桌面端导入（推荐）'),
          h('ol', { className: 'wbk-steps' },
            h('li', null, '在 WorkBuddy 桌面端登录要导入的账号'),
            h('li', null, '回到这里点下面的按钮：插件会把桌面端内存里所有仍有效的账号一次全抓出来'),
            h('li', null, '多个账号就重复「桌面端切换登录 → 点一次导入」；已导入过的账号只会更新 token')
          ),
          h('div', { className: 'wbk-head-actions', style: { justifyContent: 'flex-start', marginLeft: 0 } },
            h(Btn, { variant: 'primary', disabled: busy !== '', onClick: harvest }, busy === 'harvest' ? '抓取中…' : '从桌面端导入当前登录账号')
          )
        ),
        h('div', { className: 'wbk-field' },
          h('label', null, '方式 B：直接粘贴 token（Bearer 后面的那串 eyJ…）'),
          h('textarea', {
            className: 'wbk-textarea',
            placeholder: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
            value: token,
            onChange: function (event) { setToken(event.target.value) }
          })
        ),
        h('div', { className: 'wbk-field' },
          h('label', null, '备注名（可空，默认用昵称）'),
          h('input', {
            className: 'wbk-input',
            value: label,
            placeholder: '例如：小号',
            onChange: function (event) { setLabel(event.target.value) }
          })
        ),
        error !== null ? h('p', { className: 'wbk-note', 'data-kind': 'error' }, error) : null,
        h('div', { className: 'wbk-modal-actions' },
          h(Btn, { variant: 'ghost', onClick: props.onClose }, '取消'),
          h(Btn, { variant: 'primary', disabled: busy !== '', onClick: submit }, busy === 'token' ? '导入中…' : '导入 Token')
        )
      )
    }

    /* ---------------------------------------------------------------- *
     * 弹窗：当日积分明细
     * ---------------------------------------------------------------- */
    function DayDialog(props) {
      var row = props.row
      var max = Math.max(Number(row.gained) || 0, Number(row.spend) || 0, 1)
      return h(Modal, { title: row.day + '（' + weekday(row.day) + '）积分明细', onClose: props.onClose },
        h('div', { className: 'wbk-legend' },
          h('span', null, h('i', { style: { background: '#2f9e6e' } }), '新增'),
          h('span', null, h('i', { style: { background: '#d97706' } }), '消耗')
        ),
        h(DailyBars, { days: [row], onPick: null }),
        h('div', { className: 'wbk-rows' },
          h('div', { className: 'wbk-rowline' }, h('span', null, '当日新增（含签到）'), h('span', null, '+' + num(row.gained, 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '其中签到'), h('span', null, '+' + num(row.checkin, 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '当日消耗'), h('span', null, '-' + num(row.spend, 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '净变化'), h('span', null, num((row.gained || 0) - (row.spend || 0), 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '请求数'), h('span', null, String(row.requests || 0))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '输入 / 输出 tokens'), h('span', null, tokens(row.prompt) + ' / ' + tokens(row.completion)))
        ),
        h('p', { className: 'wbk-sub' }, '新增 = 余额快照差值与签到记录取较大者；消耗 = 反代返回的 credit 精确累加（本日最大对比值 ' + num(max, 2) + '）。')
      )
    }

    /* ---------------------------------------------------------------- *
     * 弹窗：本周积分（折线）
     * ---------------------------------------------------------------- */
    function WeekDialog(props) {
      var week = props.week
      var W = 640
      var H = 230
      var padL = 52
      var padR = 18
      var padT = 18
      var padB = 42
      var days = week.days || []
      var max = niceMax(0)
      for (var i = 0; i < days.length; i += 1) {
        max = Math.max(max, niceMax(days[i].gained), niceMax(days[i].spend))
      }
      var xAt = function (index) {
        if (days.length <= 1) return padL + (W - padL - padR) / 2
        return padL + ((W - padL - padR) * index) / (days.length - 1)
      }
      var yAt = function (value) { return padT + (H - padT - padB) - ((H - padT - padB) * (Number(value) || 0)) / max }
      var line = function (key) {
        return days.map(function (row, index) {
          return (index === 0 ? 'M' : 'L') + xAt(index).toFixed(1) + ' ' + yAt(row[key]).toFixed(1)
        }).join(' ')
      }
      var grid = []
      for (var step = 0; step <= 4; step += 1) {
        var value = (max * step) / 4
        grid.push(h('line', { key: 'g' + step, className: 'wbk-axis', x1: padL, y1: yAt(value), x2: W - padR, y2: yAt(value) }))
        grid.push(h('text', { key: 't' + step, x: padL - 6, y: yAt(value) + 3, textAnchor: 'end' }, num(value, 0)))
      }
      return h(Modal, { title: '本周积分（' + week.start + ' ~ ' + week.end + '）', onClose: props.onClose },
        h('div', { className: 'wbk-legend' },
          h('span', null, h('i', { style: { background: '#2f9e6e' } }), '新增'),
          h('span', null, h('i', { style: { background: '#d97706' } }), '消耗')
        ),
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, className: 'wbk-chart' },
          grid,
          h('path', { d: line('gained'), fill: 'none', stroke: '#2f9e6e', strokeWidth: 2.2, strokeLinejoin: 'round' }),
          h('path', { d: line('spend'), fill: 'none', stroke: '#d97706', strokeWidth: 2.2, strokeLinejoin: 'round' }),
          days.map(function (row, index) {
            return h('g', { key: row.day },
              h('circle', { cx: xAt(index), cy: yAt(row.gained), r: 3, fill: '#2f9e6e' }),
              h('circle', { cx: xAt(index), cy: yAt(row.spend), r: 3, fill: '#d97706' }),
              h('text', { x: xAt(index), y: H - 18, textAnchor: 'middle' }, dayLabel(row.day))
            )
          })
        ),
        h('div', { className: 'wbk-rows' },
          h('div', { className: 'wbk-rowline' }, h('span', null, '本周新增合计'), h('span', null, '+' + num(week.gained, 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '本周消耗合计'), h('span', null, '-' + num(week.spend, 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '本周净变化'), h('span', null, num((week.gained || 0) - (week.spend || 0), 2))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '本周请求数'), h('span', null, String(week.requests || 0)))
        )
      )
    }

    /* ---------------------------------------------------------------- *
     * 弹窗：会话明细（四个放大饼图，不遮挡）
     * ---------------------------------------------------------------- */
    function SessionDialog(props) {
      var session = props.session
      var corpus = props.corpus
      return h(Modal, { title: '会话消耗明细', onClose: props.onClose, wide: true },
        h('div', { className: 'wbk-sess-top' },
          h('span', { className: 'wbk-sess-title', title: session.title || session.id }, session.title || '（无标题会话）'),
          h('span', { className: 'wbk-sess-when' }, when(session.lastAt))
        ),
        h('div', { className: 'wbk-sess-tags' },
          session.cwd ? h('span', { className: 'wbk-tag', title: session.cwd }, baseName(session.cwd)) : null,
          h('span', { className: 'wbk-tag' }, '轮次 ' + (session.turns || 0)),
          session.attached ? null : h('span', { className: 'wbk-tag' }, '未归因到 dsh 会话')
        ),
        h('div', { className: 'wbk-donuts' },
          h(BigDonut, {
            label: '请求数', unit: 'requests', color: '#2563eb',
            value: session.requests, total: corpus.requests,
            valueText: String(session.requests) + ' / ' + String(corpus.requests)
          }),
          h(BigDonut, {
            label: 'tokens', unit: 'tokens', color: '#7c3aed',
            value: (Number(session.prompt) || 0) + (Number(session.completion) || 0),
            total: (Number(corpus.prompt) || 0) + (Number(corpus.completion) || 0),
            valueText: tokens((Number(session.prompt) || 0) + (Number(session.completion) || 0))
          }),
          h(BigDonut, {
            label: '积分', unit: 'credits', color: '#d97706',
            value: session.spend, total: corpus.spend,
            valueText: num(session.spend, 2)
          }),
          h(BigDonut, {
            label: '最近', unit: 'recency', color: '#0891b2',
            value: 1, total: 1,
            valueText: when(session.lastAt)
          })
        ),
        h('p', { className: 'wbk-sub' }, '百分比 = 该会话占全部 ' + corpus.sessions + ' 个会话同一统计量的比例；「最近」展示最后一次请求时间。'),
        h('div', { className: 'wbk-rows' },
          h('div', { className: 'wbk-rowline' }, h('span', null, '输入 tokens'), h('span', null, tokens(session.prompt))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '输出 tokens'), h('span', null, tokens(session.completion))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '首次请求'), h('span', null, when(session.firstAt))),
          h('div', { className: 'wbk-rowline' }, h('span', null, '主要模型'), h('span', null,
            Object.keys(session.models || {}).slice(0, 3).join('、') || '—'))
        ),
        h('div', { className: 'wbk-modal-actions' },
          h(Btn, { variant: 'ghost', onClick: props.onClose }, '关闭')
        )
      )
    }

    /* ---------------------------------------------------------------- *
     * 弹窗：通用删除确认
     * ---------------------------------------------------------------- */
    function ConfirmDeleteDialog(props) {
      return h(Modal, { title: props.title, onClose: props.onClose },
        h('p', { className: 'wbk-note', 'data-kind': 'warning' }, props.question),
        h('p', { className: 'wbk-sub' }, props.detail),
        h('div', { className: 'wbk-modal-actions' },
          h(Btn, { variant: 'ghost', onClick: props.onClose }, '取消'),
          h(Btn, { variant: 'danger', disabled: props.busy === true, onClick: props.onConfirm }, props.busy === true ? '删除中…' : (props.confirmText || '确认删除'))
        )
      )
    }

    /* ---------------------------------------------------------------- *
     * 详情页
     * ---------------------------------------------------------------- */
    function PoolPage(props) {
      var seams = props === null || props === undefined ? {} : props
      var stateData = useState(seams.__testData === undefined ? null : seams.__testData)
      var data = stateData[0]
      var setData = stateData[1]
      var stateError = useState(null)
      var error = stateError[0]
      var setError = stateError[1]
      var stateNotice = useState(null)
      var notice = stateNotice[0]
      var setNotice = stateNotice[1]
      var stateBusy = useState('')
      var busy = stateBusy[0]
      var setBusy = stateBusy[1]
      var stateDialog = useState(seams.__testDialog === true)
      var dialog = stateDialog[0]
      var setDialog = stateDialog[1]
      var stateDay = useState(seams.__testDay === undefined ? null : seams.__testDay)
      var dayRow = stateDay[0]
      var setDayRow = stateDay[1]
      var stateWeek = useState(seams.__testWeek === true)
      var weekOpen = stateWeek[0]
      var setWeekOpen = stateWeek[1]
      var stateSession = useState(seams.__testSession === undefined ? null : seams.__testSession)
      var sessionSel = stateSession[0]
      var setSessionSel = stateSession[1]
      var stateConfirm = useState(seams.__testConfirm === undefined ? null : seams.__testConfirm)
      var confirmAccount = stateConfirm[0]
      var setConfirmAccount = stateConfirm[1]
      var stateConfirmSession = useState(seams.__testConfirmSession === undefined ? null : seams.__testConfirmSession)
      var confirmSession = stateConfirmSession[0]
      var setConfirmSession = stateConfirmSession[1]

      var load = useCallback(function () {
        return request('/status')
          .then(function (payload) { setData(payload); setError(null) })
          .catch(function (reason) { setError(reason.message) })
      }, [])

      useEffect(function () {
        ensureStyle()
        void load()
        var timer = setInterval(function () { void load() }, 15000)
        return function () { clearInterval(timer) }
      }, [load])

      var run = useCallback(function (key, thunk, doneText) {
        setBusy(key)
        setNotice(null)
        return thunk()
          .then(function (result) {
            setNotice(doneText(result))
            return load()
          })
          .catch(function (reason) { setError(reason.message) })
          .then(function () { setBusy('') })
      }, [load])

      var totals = data === null ? null : data.totals
      var accounts = data === null ? [] : data.pool.accounts
      var week = useMemo(function () {
        if (data === null) return null
        if (data.week !== undefined && data.week !== null) return data.week
        return weekFromRows(data.history !== undefined ? data.history : data.daily)
      }, [data])
      var days = week === null ? [] : week.days
      var sessions = useMemo(function () {
        if (data === null) return []
        return data.sessions.slice(0, 60)
      }, [data])
      var corpus = useMemo(function () {
        var sum = { requests: 0, spend: 0, prompt: 0, completion: 0, sessions: sessions.length }
        for (var i = 0; i < sessions.length; i += 1) {
          sum.requests += Number(sessions[i].requests) || 0
          sum.spend += Number(sessions[i].spend) || 0
          sum.prompt += Number(sessions[i].prompt) || 0
          sum.completion += Number(sessions[i].completion) || 0
        }
        return sum
      }, [sessions])
      var sessionRow = useMemo(function () {
        if (sessionSel === null) return null
        for (var i = 0; i < sessions.length; i += 1) if (sessions[i].id === sessionSel) return sessions[i]
        return typeof sessionSel === 'object' ? sessionSel : null
      }, [sessionSel, sessions])

      var head = h('div', { className: 'wbk-head' },
        h('div', { className: 'wbk-head-main' },
          h('h1', { className: 'wbk-title' }, 'WorkBuddy 账号池'),
          h('p', { className: 'wbk-sub' },
            data === null
              ? '加载中…'
              : ('共 ' + totals.accounts + ' 个账号（' + totals.enabled + ' 个 ON）· 今日 ' + when(data.generatedAt) + ' 更新 · 每日 ' + data.scheduler.checkinAt + ' 自动签到')
          )
        ),
        h('div', { className: 'wbk-head-actions' },
          h(Btn, {
            disabled: busy !== '',
            onClick: function () { void run('refresh', function () { return request('/refresh', { method: 'POST', body: {} }) }, function () { return '已刷新全部账号（余额 + 签到状态）' }) }
          }, busy === 'refresh' ? '刷新中…' : '刷新余额'),
          h(Btn, {
            disabled: busy !== '',
            title: '给所有账号签到领积分（ON/OFF 都会签）',
            onClick: function () {
              void run('checkin', function () { return request('/checkin', { method: 'POST', body: {} }) }, checkinSummary)
            }
          }, busy === 'checkin' ? '签到中…' : '立即签到'),
          h(Btn, { variant: 'primary', onClick: function () { setDialog(true) } }, '导入账号')
        )
      )

      var kpis = h('div', { className: 'wbk-kpis' },
        h(Kpi, { label: '总余额', value: totals === null ? '—' : credits(totals.balance), sub: totals === null ? '' : totals.enabled + ' 个账号参与消耗' }),
        h(Kpi, { label: '今日新增', value: totals === null ? '—' : ('+' + credits(totals.todayGained)), sub: totals === null ? '' : ('其中签到 +' + credits(totals.todayCheckin)) }),
        h(Kpi, { label: '今日消耗', value: totals === null ? '—' : credits(totals.todaySpend), sub: totals === null ? '' : (totals.todayRequests + ' 次模型请求') }),
        h(Kpi, { label: '本周净变化', value: week === null ? '—' : num((week.gained || 0) - (week.spend || 0), 2), sub: week === null ? '' : ('+ ' + credits(week.gained) + ' / - ' + credits(week.spend)) })
      )

      var accountCards = accounts.map(function (account) {
        var checkin = account.checkin || null
        var checkedToday = checkin !== null && checkin.day === data.today
        var on = account.enabled !== false
        var tokenTone = account.tokenValid ? (account.tokenLeftDays <= 3 ? 'warn' : 'ok') : 'bad'
        var groups = (account.balanceGroups || []).filter(function (group) { return (group.remain || 0) > 0 }).slice(0, 3)
        return h('div', { key: account.id, className: 'wbk-card', 'data-off': on ? '0' : '1' },
          h('div', { className: 'wbk-card-top' },
            h(Switch, {
              on: on,
              onChange: function () {
                void run('toggle:' + account.id, function () {
                  return request('/accounts/' + encodeURIComponent(account.id) + '/toggle', { method: 'POST', body: { enabled: !on } })
                }, function () { return (account.label || account.id) + (on ? ' 已切到 OFF（不再用它的积分）' : ' 已切到 ON（重新使用它的积分）') })
              }
            }),
            h('span', { className: 'wbk-switch-text', 'data-on': on ? '1' : '0' }, on ? 'ON' : 'OFF'),
            h('span', { className: 'wbk-name' }, account.label || account.nickname || account.id),
            h('span', { className: 'wbk-badge', 'data-tone': tokenTone }, account.tokenValid ? ('token 剩 ' + account.tokenLeftDays + ' 天') : 'token 已失效'),
            account.plan ? h('span', { className: 'wbk-badge' }, account.plan) : null
          ),
          h('div', { className: 'wbk-balance' },
            h('span', { className: 'wbk-balance-value' }, credits(account.balanceTotal)),
            h('span', { className: 'wbk-balance-unit' }, '积分余额')
          ),
          groups.length > 0 ? h('div', { className: 'wbk-chips' },
            groups.map(function (group, index) {
              return h('span', { key: index, className: 'wbk-chip' }, (group.name || group.kind) + ' ' + num(group.remain, 2))
            })
          ) : null,
          h('div', { className: 'wbk-meta' },
            h('span', null, '签到 ', h('b', { style: { color: checkedToday ? 'var(--dsw-alias-state-success-primary,#15803d)' : undefined } }, checkedToday ? ('已签 +' + num(checkin.credit, 2)) : '未签')),
            h('span', null, '连签 ', h('b', null, ((account.checkinStatus && account.checkinStatus.streakDays) || (checkin && checkin.streakDays) || 0) + ' 天')),
            h('span', null, '今日消耗 ', h('b', null, credits(account.todaySpend))),
            h('span', null, '余额更新 ', h('b', null, when(account.balanceAt)))
          ),
          h('div', { className: 'wbk-card-actions' },
            h(Btn, { variant: 'danger', size: 'sm', disabled: busy !== '', onClick: function () { setConfirmAccount(account) } }, '删除')
          ),
          account.lastError ? h('p', { className: 'wbk-sub' }, '最近错误：' + account.lastError.message + '（' + when(account.lastError.at) + '）') : null,
          h('div', { className: 'wbk-dim' }, 'token ' + (account.tokenValid ? '有效' : '失效') + ' · 更新于 ' + when(account.updatedAt) + ' · ' + (account.phoneMask || '无手机号'))
        )
      })

      var emptyState = h('div', { className: 'wbk-empty' },
        h('div', { className: 'wbk-empty-title' }, '账号池还是空的'),
        h('ol', { className: 'wbk-steps' },
          h('li', null, '在 WorkBuddy 桌面端登录要纳入账号池的账号'),
          h('li', null, '点右上角「导入账号」→「从桌面端导入当前登录账号」'),
          h('li', null, '第二个账号在桌面端切换登录后再导入一次；之后每天自动签到领积分')
        ),
        h('div', { className: 'wbk-head-actions', style: { justifyContent: 'flex-start', marginLeft: 0 } },
          h(Btn, { variant: 'primary', onClick: function () { setDialog(true) } }, '开始导入'))
      )

      var sessionCards = sessions.map(function (row) {
        var totalTokens = (Number(row.prompt) || 0) + (Number(row.completion) || 0)
        var ringRatio = corpus.spend > 0 ? (Number(row.spend) || 0) / corpus.spend : 0
        return h('div', { key: row.id, className: 'wbk-sesscard' },
          h('div', { className: 'wbk-sess-top' },
            h('span', { className: 'wbk-sess-title', title: row.title || row.id }, row.title || (row.attached ? '（无标题会话）' : row.id)),
            h('span', { className: 'wbk-sess-when' }, when(row.lastAt))
          ),
          h('div', { className: 'wbk-sess-tags' },
            h('span', { className: 'wbk-tag', title: row.cwd || '' }, row.cwd ? baseName(row.cwd) : (row.attached ? '无目录' : '未归因')),
            h('span', { className: 'wbk-tag' }, String(row.requests) + ' 请求'),
            h('span', { className: 'wbk-tag' }, tokens(totalTokens) + ' tokens')
          ),
          h('div', { className: 'wbk-sess-body' },
            h(MiniRing, {
              ratio: ringRatio,
              caption: num(row.spend, 1),
              color: '#2563eb',
              onClick: function () { setSessionSel(row) }
            }),
            h('div', { className: 'wbk-sess-stats' },
              h('div', null, h('span', null, '积分'), h('b', null, credits(row.spend))),
              h('div', null, h('span', null, 'tokens'), h('b', null, tokens(totalTokens))),
              h('div', null, h('span', null, '请求'), h('b', null, String(row.requests))),
              h('div', null, h('span', null, '最近'), h('b', null, when(row.lastAt)))
            )
          ),
          h('div', { className: 'wbk-sess-actions' },
            h(Btn, { size: 'sm', onClick: function () { setSessionSel(row) } }, '明细'),
            h(Btn, {
              size: 'sm',
              disabled: busy !== '',
              onClick: function () {
                void run('sess:' + row.id, function () {
                  return request('/sessions/' + encodeURIComponent(row.id) + '/refresh', { method: 'POST', body: {} })
                }, function () { return '已刷新该会话统计' })
              }
            }, '刷新'),
            h(Btn, {
              size: 'sm',
              variant: 'danger',
              disabled: busy !== '',
              title: '只删除这条统计记录，不影响对话本身',
              onClick: function () { setConfirmSession(row) }
            }, '删除')
          )
        )
      })

      return h('div', { className: 'wbk-root' },
        h('div', { className: 'wbk-inner' },
          head,
          error !== null ? h('p', { className: 'wbk-note', 'data-kind': 'error' }, '读取失败：' + error + '（宿主半侧若还没加载，重载插件后再看）') : null,
          notice !== null ? h('p', { className: 'wbk-note', 'data-kind': 'ok' }, notice) : null,
          totals !== null ? kpis : null,
          h(Section, {
            title: '账号',
            hint: '开关 ON = 使用该账号积分；OFF = 改走其它 ON 的账号。每天 ' + (data === null ? '' : data.scheduler.checkinAt) + ' 自动签到，token 快过期时自动从桌面端续期',
            tools: h(RefreshButton, {
              spinning: busy === 'refresh',
              disabled: busy !== '',
              onClick: function () { void run('refresh', function () { return request('/refresh', { method: 'POST', body: {} }) }, function () { return '已刷新全部账号' }) }
            })
          },
            accounts.length > 0 ? h('div', { className: 'wbk-cards' }, accountCards) : emptyState
          ),
          h(Section, {
            title: '每日积分（近 7 天）',
            hint: '每周一自动从新的一周重新统计；点柱子看当天明细',
            tools: h(Btn, { onClick: function () { setWeekOpen(true) }, disabled: week === null }, '本周积分')
          },
            days.length > 0
              ? h('div', null,
                  h('div', { className: 'wbk-legend' },
                    h('span', null, h('i', { style: { background: '#2f9e6e' } }), '新增积分'),
                    h('span', null, h('i', { style: { background: '#d97706' } }), '消耗积分')
                  ),
                  h('div', { className: 'wbk-hscroll' },
                    h('div', { className: 'wbk-chartwrap' },
                      h(DailyBars, { days: days, onPick: function (row) { setDayRow(row) } })
                    )
                  )
                )
              : h('p', { className: 'wbk-sub' }, '还没有足够的记录：等第一天的余额快照 / 签到产生后这里会出现柱形图。')
          ),
          h(Section, {
            title: '每个对话消耗',
            hint: '点圆环放大看明细；「删除」只删统计，不动对话本身'
          },
            sessions.length > 0
              ? h('div', { className: 'wbk-hscroll', ref: bindWheel },
                  h('div', { className: 'wbk-sessgrid' }, sessionCards)
                )
              : h('p', { className: 'wbk-sub' }, '还没有归因到会话的请求。')
          ),
          h('div', { className: 'wbk-foot' },
            h('span', null, '账号池文件：', h('span', { className: 'wbk-code' }, data === null ? '—' : data.pool.file)),
            h('span', null, '用量日志：', h('span', { className: 'wbk-code' }, data === null ? '—' : data.usage.log)),
            data !== null && Array.isArray(data.pool.hiddenSessions) && data.pool.hiddenSessions.length > 0
              ? h('span', null,
                  '已删除 ' + data.pool.hiddenSessions.length + ' 条会话统计（对话本身不受影响）· ',
                  h(Btn, {
                    size: 'sm',
                    disabled: busy !== '',
                    onClick: function () {
                      void run('restore', function () { return request('/sessions/restore', { method: 'POST', body: {} }) }, function () { return '已恢复全部被删除的会话统计' })
                    }
                  }, '恢复')
                )
              : null,
            h('span', null, '插件只读本机文件 + WorkBuddy 官方接口，token 不上传任何地方。')
          )
        ),
        dialog ? h(ImportDialog, {
          onClose: function () { setDialog(false) },
          onDone: function (text) { setDialog(false); setNotice(text); void load() }
        }) : null,
        dayRow !== null ? h(DayDialog, { row: dayRow, onClose: function () { setDayRow(null) } }) : null,
        weekOpen && week !== null ? h(WeekDialog, { week: week, onClose: function () { setWeekOpen(false) } }) : null,
        sessionRow !== null ? h(SessionDialog, { session: sessionRow, corpus: corpus, onClose: function () { setSessionSel(null) } }) : null,
        confirmAccount !== null ? h(ConfirmDeleteDialog, {
          title: '确认删除账号',
          question: '要删除「' + (confirmAccount.label || confirmAccount.nickname || confirmAccount.id) + '」吗？',
          detail: '删除后会移除它的 token、余额快照和签到记录，反代也不再使用它；需要时可以在「导入账号」里从桌面端重新抓取。',
          busy: busy === 'remove:' + confirmAccount.id,
          onClose: function () { setConfirmAccount(null) },
          onConfirm: function () {
            var target = confirmAccount
            void run('remove:' + target.id, function () {
              return fetch(API + '/accounts/' + encodeURIComponent(target.id), { method: 'DELETE' }).then(function (response) { return response.json() })
            }, function () { return '已删除 ' + (target.label || target.id) }).then(function () { setConfirmAccount(null) })
          }
        }) : null,
        confirmSession !== null ? h(ConfirmDeleteDialog, {
          title: '确认删除会话统计',
          question: '要删除「' + (confirmSession.title || confirmSession.id) + '」的统计记录吗？',
          detail: '只删除这条统计（请求数 / tokens / 积分），对话本身与历史消息都不受影响；删除后可在页脚点「恢复」找回来。',
          confirmText: '确认删除',
          busy: busy === 'hide:' + confirmSession.id,
          onClose: function () { setConfirmSession(null) },
          onConfirm: function () {
            var target = confirmSession
            void run('hide:' + target.id, function () {
              return request('/sessions/' + encodeURIComponent(target.id) + '/hide', { method: 'POST', body: {} })
            }, function () { return '已删除该会话的统计记录（对话本身保留）' }).then(function () { setConfirmSession(null) })
          }
        }) : null
      )
    }

    /* ---------------------------------------------------------------- *
     * 侧栏图标
     * ---------------------------------------------------------------- */
    function PoolIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round'
      },
        h('rect', { x: 1.6, y: 4.2, width: 12.8, height: 8.6, rx: 2.2 }),
        h('path', { d: 'M1.6 7.1h12.8' }),
        h('circle', { cx: 11.3, cy: 10.1, r: 1.1 })
      )
    }

    /* ---------------------------------------------------------------- *
     * 插件体
     * ---------------------------------------------------------------- */
    function apply(ctx) {
      ensureStyle()
      if (ctx === null || ctx === undefined || ctx.slots === undefined) return

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PAGE_ID }, PoolPage)
      })

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PAGE_ID,
          order: 13,
          label: 'WorkBuddy'
        }, PoolIcon)
      })
    }

    module.exports = {
      name: 'workbuddy-pool-client',
      inject: ['slots'],
      apply: apply,
      // 离线体检脚本用：验证「立即签到」的结果文案。
      __test: { checkinSummary: checkinSummary }
    }
    return module.exports
  }
})
