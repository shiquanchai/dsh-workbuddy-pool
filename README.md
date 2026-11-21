# dsh-workbuddy-pool

**DeepSeek Harness（dsh）的 WorkBuddy 账号池插件**：多个 WorkBuddy 账号放进一个池子，
每天自动签到领积分、定时刷新余额、按 dsh 会话归因积分消耗，左侧栏一个 **WorkBuddy**
按钮打开完整看板。

> A dsh plugin that pools multiple WorkBuddy accounts: daily auto check-in, credit balance
> snapshots, per-conversation credit attribution, and a sidebar dashboard. Chinese-first docs.

![版式预览](docs/preview.html)

---

## 这个插件能做什么

- **账号池**：从 WorkBuddy 桌面端一次抓取所有仍有效的登录态导入；支持再加、ON/OFF、删除（删除需确认）
- **每日自动签到**：本地时间 `00:05` 给所有账号领积分（ON/OFF 都会签），失败自动重试；「立即签到」当天已领时会告诉你今天一共领了多少
- **余额与积分构成**：套餐基础 / 套餐赠送 / 购买 / 平台奖励分别展示，token 剩余有效期可见
- **每日积分**：本周柱形图（新增 vs 消耗），点柱子看当天明细；「本周积分」折线图看趋势
- **每个对话消耗**：会话卡片 + 圆环，点开放大看四个统计量（请求数 / tokens / 积分 / 最近）；删除只删统计，不动对话，可一键恢复
- **横向滚动**：每日积分与会话卡都支持滚轮左右滑
- **跨进程安全**：插件、命令行、反代共写 `pool.json`，用文件锁 `pool.json.lock` 串行化，避免互相覆盖

## 架构

```
WorkBuddy 官方接口 (copilot.tencent.com)
        ▲                         ▲
        │ 账号池 pool.json        │ /v2/chat/completions
        │                         │
┌───────┴─────────┐   ┌──────────┴─────────┐   ┌──────────────────┐
│ dsh-workbuddy-  │   │ wb-proxy (:8787)   │   │ dsh Web GUI      │
│ pool（宿主半侧）│   │ 账号池轮询 + 记账   │   │ WorkBuddy 详情页 │
│ 签到/余额/聚合  │──▶│ logs/usage.jsonl   │◀──│ 侧栏按钮         │
└───────┬─────────┘   └────────────────────┘   └──────────────────┘
        │ 注入 x-wb-session-id
        └──────────▶ llm-pi-ai/request-headers（dsh 的模型出水口）
```

仓库里有两部分：

| 目录 | 内容 |
| --- | --- |
| 根目录 | dsh 插件本体（宿主半侧 `lib/index.js` + 浏览器半侧 `lib/client.js`） |
| `proxy/` | WorkBuddy → OpenAI 兼容反代，账号池轮询 + 用量记账（插件的数据来源） |

## 安装

前置：dsh `0.2.2-rc.x`（desktop / web profile 都行）、Node 20+；
「从桌面端导入」需要 Windows + WorkBuddy 桌面端已登录。

```powershell
git clone https://github.com/<you>/dsh-workbuddy-pool.git
cd dsh-workbuddy-pool

$node = "<dsh 自带的 node.exe>"   # 或系统 node
& $node scripts\install.mjs install --profile desktop
# 输出里会打印备份目录；重启 dsh 后左侧栏出现 WorkBuddy 按钮
```

`install.mjs` 做四件事：备份 profile 的 `package.json` / `cordis.patch.yml`；
写 `dependencies["dsh-workbuddy-pool"] = "link:<本目录>"`；把包名加进 `dsh.profile.bundles`；
在 `<profile>/node_modules` 建目录联接。卸载用 `install.mjs uninstall --profile desktop`。

反代单独跑：

```powershell
& $node proxy\wb-proxy.mjs
# 再把 dsh 的 llm-pi-ai 里 workbuddy 提供商 baseURL 指到 http://127.0.0.1:8787/v1
```

让插件读到反代的用量日志（profile 的 `cordis.patch.yml`，按 id 覆盖）：

```yaml
- id: workbuddy-pool
  config:
    usageLog: 'D:\path\to\proxy\logs\usage.jsonl'
```

不接反代也能用：账号、签到、余额都正常，只是「每个对话消耗」没有数据。

## 导入账号

三种方式，都按 uid / 手机号去重（重复导入只是更新 token）：

1. 页面右上角「导入账号」→「从桌面端导入当前登录账号」（会把内存里所有有效账号一次抓出来）
2. 命令行：`node scripts\import.mjs --desktop`（`--label 小号` 可加备注名）
3. 命令行贴 token：`node scripts\import.mjs --token eyJ... --label 小号`

多账号：在 WorkBuddy 桌面端切换登录 → 再点一次导入。其它常用命令：

```powershell
node scripts\import.mjs --list                       # 看账号池
node scripts\import.mjs --refresh                    # 刷新全部账号（余额 + 签到状态）
node scripts\import.mjs --checkin                    # 立刻签一次
node scripts\import.mjs --rename acc-xxxx --label X  # 改备注名
```

数据都在 `%DSH_HOME%/workbuddy-pool/`（默认 `C:\Users\<you>\.dsh\workbuddy-pool\`）：

| 文件 | 内容 |
| --- | --- |
| `pool.json` | 账号、token、余额快照、签到记录、被删统计的会话 |
| `pool.json.lock` | 跨进程文件锁 |
| `pool.log` | 签到 / 刷新 / 报错流水 |

## 页面

| 区块 | 内容 |
| --- | --- |
| 顶部 | 刷新余额 / 立即签到 / 导入账号；账号数、更新时刻、自动签到时刻 |
| KPI | 总余额、今日新增（含签到）、今日消耗、本周净变化 |
| 账号 | ON/OFF 开关（只决定是否用它的积分，不影响签到与刷新）、余额、积分构成、签到/连签/今日消耗、删除 |
| 每日积分（近 7 天） | 分组柱形图，点柱子看当日明细；「本周积分」折线图 |
| 每个对话消耗 | 会话卡片 + 圆环，点圆环看四个放大饼图；刷新 / 删除（需确认） |

版式静态预览：<https://shiquanchai.github.io/dsh-workbuddy-pool/>（源码是 `docs/index.html` + `docs/preview.html`，`node tools\preview.mjs` 可重新生成）。

## 接口

宿主半侧挂在 `/workbuddy-pool` 前缀，只监听本机 loopback：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workbuddy-pool/api/status` | 页面主数据 |
| GET | `/workbuddy-pool/api/usage?days=14` | 每日 / 会话 / 模型聚合 |
| POST | `/workbuddy-pool/api/checkin` | 全部账号签到（`{accountId}` 可只签一个） |
| POST | `/workbuddy-pool/api/accounts` | 导入 token `{token,label}` |
| POST | `/workbuddy-pool/api/accounts/harvest` | 从桌面端导入所有可见账号 |
| POST | `/workbuddy-pool/api/accounts/:id/toggle` | `{enabled}`，ON/OFF 是否参与消耗 |
| POST | `/workbuddy-pool/api/accounts/:id/refresh` | 单账号刷新 |
| DELETE | `/workbuddy-pool/api/accounts/:id` | 删除账号 |
| POST | `/workbuddy-pool/api/refresh` | 全部刷新 |
| GET/POST | `/workbuddy-pool/api/sessions/:id` | 会话详情 / 刷新 |
| POST | `/workbuddy-pool/api/sessions/:id/hide` | 删该会话的统计（不动对话） |
| POST | `/workbuddy-pool/api/sessions/restore` | 恢复所有被删统计 |
| GET | `/workbuddy-pool/api/export` | 脱敏账号池 |

## 配置项

`cordis.patch.yml` 里给的是默认值，可在 profile 按 id 覆盖：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 定时器总开关 |
| `checkinAt` | `"00:05"` | 每天几点自动签到（本地时间） |
| `snapshotMinutes` | `30` | 余额快照间隔（算「每日新增」用） |
| `autoHarvest` | `true` | token 快过期时从桌面端自动续期 |
| `harvestMinTokenDays` | `3` | 剩余不足几天算「快过期」 |
| `usageLog` | `%DSH_HOME%/workbuddy-pool/usage.jsonl` | 反代用量日志路径 |
| `gateway` | `https://copilot.tencent.com` | 官方接口网关 |

## 用到的 WorkBuddy 接口

路径与字段取自 WorkBuddy 5.11.3 客户端（`app.asar` 的 `main/account.js`），并用真实 token 验证过：

| 接口 | 用途 |
| --- | --- |
| `GET /console/accounts` | 账号档案（uid / 昵称 / 手机号 / 套餐） |
| `POST /billing/meter/get-user-resource-summary` | 积分总览（`TotalCredits` + `CreditGroups`） |
| `POST /billing/meter/checkin-activity-status` | 签到状态（`today_checked_in` / `streak_days` / `today_credit`） |
| `POST /billing/meter/daily-checkin` | 签到领取（`credit` / `streak_days`） |

## 自检

```powershell
node tests\host-check.mjs     # 宿主半侧：假 ctx + 真接口，26 项
node tests\client-check.mjs   # 浏览器半侧：假 React 跑渲染 + 文案，45 项
```

两个脚本都在临时目录里跑，不碰真实账号池；`host-check` 会导入一次 token（用你本机现成的
`.wb-token` 时会调真实接口）。

## 已知限制

1. **token 有效期约 30 天**：只有该账号正登录在 WorkBuddy 桌面端时才能自动续期，否则要在页面重新导入。
2. **历史请求不归因**：`session_id` 是插件加载后注入的，之前的旧记录显示为「未归因（日期）」。
3. **「每日新增」是估算**：取「余额快照差值」与「签到记录」中的较大者；「每日消耗」是反代返回的 `credit` 精确累加。
4. **反代是数据前提**：没有 `wb-proxy` 就没有 `account_id` / `session_id` / `credit` 记录。
5. 接口返回的手机号是打码的（`150****9364`），插件用 JWT 里的号码自己再打一次码展示。

## 目录

```
lib/index.js        宿主半侧：HTTP 接口、定时签到、会话号注入、文件锁
lib/client.js       浏览器半侧：侧栏按钮 + 详情页（React，无构建步骤）
lib/wb-store.mjs    账号池存储 + WorkBuddy 接口 + 用量聚合（无依赖，可单独跑）
scripts/            安装器、导入 CLI、桌面端 token 抓取（PowerShell）
tests/              离线自检（假 ctx / 假 React）
tools/              版式预览、客户端加载验证
proxy/              WorkBuddy → OpenAI 兼容反代
docs/preview.html   版式静态预览
```

## 反馈

- 遇到 bug 或想加功能：[提 Issue](https://github.com/shiquanchai/dsh-workbuddy-pool/issues)
- 用法讨论、配置分享：[Discussions](https://github.com/shiquanchai/dsh-workbuddy-pool/discussions)

## License

[MIT](LICENSE)
