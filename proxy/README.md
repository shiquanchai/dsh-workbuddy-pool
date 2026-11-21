# wb-proxy — WorkBuddy 反向代理（账号池版）

把 WorkBuddy 的 `/v2/chat/completions` 包成 OpenAI 兼容接口，给 dsh、modlens 之类只认
`openai-completions` 的客户端用；同时是「每个对话消耗多少积分」的唯一数据源。

```
dsh / 任意 OpenAI 客户端
        │  http://127.0.0.1:8787/v1/chat/completions
        ▼
   wb-proxy ──账号池轮询 + 401/403/429 冷却换号──▶ https://copilot.tencent.com
        │
        └─ logs/usage.jsonl：每条请求记 account_id / session_id / model / credit / tokens
```

## 认证：账号池优先，桌面端 token 兜底

1. 读 `%DSH_HOME%/workbuddy-pool/pool.json`（由 dsh-workbuddy-pool 插件维护），
   在池里轮询；某个账号 401/403 冷却 2 分钟，429 冷却 30 秒，自动换下一个。
2. 池为空时退回旧行为：从 WorkBuddy 桌面端进程内存里抓当前登录 token
   （Windows + PowerShell，脚本在 `../scripts/wb-token.ps1`）。

## 启动

```powershell
node proxy\wb-proxy.mjs
# 默认 http://127.0.0.1:8787/v1
```

dsh 里把它当 openai-completions 提供商（`cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        api: openai-completions
        baseURL: http://127.0.0.1:8787/v1
        apiKeyEnv: WORKBUDDY_PROXY_KEY      # 与 WB_PROXY_KEY 一致即可
        models:
          - id: deep-model
            name: Deep(x1.00)
          - id: fast-model
            name: Fast(x0.15)
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WB_PROXY_HOST` / `WB_PROXY_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `WB_PROXY_KEY` | 空 | 入站 apiKey；空 = 不校验 |
| `WB_POOL_FILE` | `%DSH_HOME%/workbuddy-pool/pool.json` | 账号池文件 |
| `WB_GATEWAY` | `https://copilot.tencent.com` | 上游网关 |
| `WB_LOG_DIR` | `proxy/logs` | 日志目录（`usage.jsonl`、`proxy.log`） |
| `WB_MODELS_FILE` | `proxy/wb-models.json` | 模型目录（决定请求模型转发到哪个上游模型） |
| `WB_HARVEST_SCRIPT` | `../scripts/wb-token.ps1` | 桌面端 token 抓取脚本 |
| `WB_ACCOUNT_COOLDOWN_MS` | `120000` | 401/403 冷却时长 |

## 管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 进程 + 账号池状态 |
| GET | `/v1/models` | 模型列表（OpenAI 格式） |
| POST | `/v1/chat/completions` | 对话（流式 / 非流式都支持） |
| GET | `/v1/wb/pool` | 池里每个账号的有效性、冷却时间 |
| GET | `/v1/wb/token` | 下一次会用到哪个账号 |
| GET | `/v1/wb/usage` | 日志汇总（总/今日/按账号） |
| POST | `/v1/wb/token/refresh` | 强制重读账号池 |

## 记账约定

* `session_id`：客户端请求头 `x-wb-session-id`。dsh-workbuddy-pool 插件的
  `llm-pi-ai/request-headers` 钩子会自动带上 dsh 会话号，所以「每个对话消耗」能精确归因。
* `credit`：上游返回的积分消耗，原样记录；插件把它按日/按会话聚合。
* 上游只支持流式，非流式请求由代理聚合后再返回。
