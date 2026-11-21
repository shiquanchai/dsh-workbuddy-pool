#!/usr/bin/env node
/**
 * wb-proxy — WorkBuddy 反向代理（账号池版）
 *
 *   dsh (openai-completions)  ->  http://127.0.0.1:8787/v1  ->  https://copilot.tencent.com/v2/chat/completions
 *
 * 认证：账号池优先。
 *   1. 读 %DSH_HOME%/workbuddy-pool/pool.json（dsh-workbuddy-pool 插件写的账号池），
 *      在池内轮询，遇到 401/403/额度问题自动换下一个账号并冷却失败的账号；
 *   2. 池为空时退回旧行为：从 WorkBuddy 桌面端进程内存抓当前登录 token。
 *
 * 记账：每条用量记录带 account_id / session_id / model / credit，
 *       插件据此算"每个对话消耗了多少积分"。session_id 由 dsh 插件通过
 *       `llm-pi-ai/request-headers` 注入的 x-wb-session-id 头带来。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

function defaultPoolFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'workbuddy-pool', 'pool.json')
}

const CFG = {
  host: process.env.WB_PROXY_HOST || '127.0.0.1',
  port: Number(process.env.WB_PROXY_PORT || 8787),
  gateway: (process.env.WB_GATEWAY || 'https://copilot.tencent.com').replace(/\/+$/, ''),
  chatPath: process.env.WB_CHAT_PATH || '/v2/chat/completions',
  appVersion: process.env.WB_APP_VERSION || '5.11.3',
  defaultModel: process.env.WB_DEFAULT_MODEL || 'deep-model',
  tokenFile: process.env.WB_TOKEN_FILE || path.join(ROOT, 'tools', '.wb-token'),
  harvestScript: process.env.WB_HARVEST_SCRIPT || path.join(ROOT, '..', 'scripts', 'wb-token.ps1'),
  modelsFile: process.env.WB_MODELS_FILE || path.join(ROOT, 'wb-models.json'),
  logDir: process.env.WB_LOG_DIR || path.join(ROOT, 'logs'),
  inboundKey: process.env.WB_PROXY_KEY || '', // 留空 = 不校验入站 apiKey
  idleTimeoutMs: Number(process.env.WB_IDLE_TIMEOUT_MS || 300000),
  poolFile: process.env.WB_POOL_FILE || defaultPoolFile(),
  poolReloadMs: Number(process.env.WB_POOL_RELOAD_MS || 5000),
  accountCooldownMs: Number(process.env.WB_ACCOUNT_COOLDOWN_MS || 120000),
}

fs.mkdirSync(CFG.logDir, { recursive: true });
const USAGE_LOG = path.join(CFG.logDir, 'usage.jsonl');
const PROXY_LOG = path.join(CFG.logDir, 'proxy.log');

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  try { fs.appendFileSync(PROXY_LOG, line + '\n'); } catch {}
  if (process.env.WB_PROXY_QUIET !== '1') console.log(line);
};

/* ------------------------------------------------------------------ *
 * 模型目录
 * ------------------------------------------------------------------ */
const FALLBACK_MODELS = [
  { id: 'deep-model', name: 'Deep', credits: 'x1.00', maxOutputTokens: 48000, maxInputTokens: 300000, supportsToolCall: true },
  { id: 'balanced-model', name: 'Balanced', credits: 'x0.50', maxOutputTokens: 48000, maxInputTokens: 300000, supportsToolCall: true },
  { id: 'fast-model', name: 'Fast', credits: 'x0.15', maxOutputTokens: 48000, maxInputTokens: 300000, supportsToolCall: true },
];

function loadModels() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG.modelsFile, 'utf8'));
    if (Array.isArray(raw) && raw.length) return raw.filter((m) => m && typeof m.id === 'string');
  } catch (e) {
    log(`models file unavailable (${e.code || e.message}), using fallback`);
  }
  return FALLBACK_MODELS;
}
const MODELS = loadModels();
const MODEL_IDS = new Set(MODELS.map((m) => m.id));

function resolveModel(id) {
  if (!id) return CFG.defaultModel;
  if (MODEL_IDS.has(id)) return id;
  const lower = String(id).trim().toLowerCase();
  const byId = MODELS.find((m) => m.id.toLowerCase() === lower);
  if (byId) return byId.id;
  const byName = MODELS.find((m) => (m.name || '').toLowerCase() === lower);
  if (byName) return byName.id;
  log(`model "${id}" not in catalog -> default ${CFG.defaultModel}`);
  return CFG.defaultModel;
}

/* ------------------------------------------------------------------ *
 * JWT 工具
 * ------------------------------------------------------------------ */
function jwtPayload(token) {
  try {
    const p = token.split('.')[1];
    const s = p.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch { return null; }
}

function tokenOk(token, skewSec = 120) {
  if (!token || !token.startsWith('eyJ')) return false;
  const pl = jwtPayload(token);
  if (!pl || !pl.exp) return false;
  return pl.exp - Math.floor(Date.now() / 1000) > skewSec;
}

/* ------------------------------------------------------------------ *
 * 账号池：读插件写的 pool.json；池为空时退回桌面端 token 抓取
 * ------------------------------------------------------------------ */
class AccountPool {
  constructor() {
    this.accounts = [];
    this.legacy = { token: process.env.WB_TOKEN || '', exp: 0 };
    this.legacyExp = 0;
    this.cooldown = new Map();
    this.cursor = 0;
    this.harvesting = null;
    this.lastReadAt = 0;
    this.lastError = '';
    this.reload(true);
    if (this.legacy.token) this.legacyExp = jwtPayload(this.legacy.token)?.exp || 0;
    this.loadLegacyCache();
  }

  loadLegacyCache() {
    if (this.legacy.token) return;
    try {
      const t = fs.readFileSync(CFG.tokenFile, 'utf8').trim();
      if (tokenOk(t, 60)) {
        this.legacy.token = t;
        this.legacyExp = jwtPayload(t)?.exp || 0;
        log(`legacy token loaded from cache, exp=${new Date(this.legacyExp * 1000).toISOString()}`);
      }
    } catch {}
  }

  saveLegacyCache(token) {
    try { fs.writeFileSync(CFG.tokenFile, token, 'ascii'); } catch {}
  }

  /** 读账号池文件；force=false 时按 poolReloadMs 节流。 */
  reload(force = false) {
    if (!force && Date.now() - this.lastReadAt < CFG.poolReloadMs) return this.accounts;
    this.lastReadAt = Date.now();
    let pool;
    try {
      pool = JSON.parse(fs.readFileSync(CFG.poolFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.lastError = `pool read failed: ${e.message}`;
      this.accounts = [];
      return this.accounts;
    }
    const rows = Array.isArray(pool.accounts) ? pool.accounts : [];
    this.accounts = rows
      .filter((row) => row && typeof row.token === 'string' && row.enabled !== false)
      .map((row) => ({
        id: row.id,
        label: row.label || row.nickname || row.id,
        token: row.token,
        exp: jwtPayload(row.token)?.exp || Number(row.exp) || 0,
      }));
    this.activeAccountId = pool.activeAccountId || this.accounts[0]?.id || null;
    return this.accounts;
  }

  /** 冷却一个账号（401/403/额度不足时）。 */
  cool(accountId, ms = CFG.accountCooldownMs, reason = '') {
    if (!accountId) return;
    this.cooldown.set(accountId, Date.now() + ms);
    log(`account ${accountId} cooled for ${Math.round(ms / 1000)}s ${reason ? `(${reason})` : ''}`);
  }

  ready() {
    this.reload(false);
    const now = Date.now();
    const ready = this.accounts.filter((account) => {
      const until = this.cooldown.get(account.id) || 0;
      return until <= now && tokenOk(account.token);
    });
    // 主账号（activeAccountId）优先，其余按池内顺序轮询。
    if (this.activeAccountId) {
      ready.sort((a, b) => (b.id === this.activeAccountId ? 1 : 0) - (a.id === this.activeAccountId ? 1 : 0));
    }
    return ready;
  }

  /** 轮询取一个可用账号；池里没有可用账号时返回 legacy。 */
  pick() {
    const ready = this.ready();
    if (ready.length > 0) {
      const account = ready[this.cursor % ready.length];
      this.cursor = (this.cursor + 1) % Math.max(1, ready.length);
      return { id: account.id, label: account.label, token: account.token, source: 'pool' };
    }
    if (tokenOk(this.legacy.token, 0)) {
      const pl = jwtPayload(this.legacy.token) || {};
      return { id: 'legacy-desktop', label: pl.nickname || pl.preferred_username || '桌面端账号', token: this.legacy.token, source: 'legacy' };
    }
    return null;
  }

  /** 池里没有账号时，退回从桌面端抓 token（旧行为）。 */
  async ensureLegacy({ force = false } = {}) {
    if (!force && tokenOk(this.legacy.token)) return this.legacy.token;
    if (!this.harvesting) {
      this.harvesting = this.harvest().finally(() => { this.harvesting = null; });
    }
    const token = await this.harvesting;
    if (token) return token;
    if (tokenOk(this.legacy.token, 0)) return this.legacy.token;
    return '';
  }

  harvest() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') { log('harvest skipped: non-windows'); return resolve(''); }
      log('harvesting token from WorkBuddy process memory...');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CFG.harvestScript],
        { timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          const out = (stdout || '').trim();
          if (out.startsWith('eyJ') && tokenOk(out, 30)) {
            this.legacy.token = out;
            this.legacyExp = jwtPayload(out)?.exp || 0;
            this.saveLegacyCache(out);
            log(`token harvested, exp=${new Date(this.legacyExp * 1000).toISOString()}`);
            return resolve(out);
          }
          log(`harvest failed (${err?.message || 'empty'}): ${out.slice(0, 120) || '(no output)'}`);
          resolve('');
        },
      );
    });
  }

  /** 拿一个可以发请求的账号；池空时先尝试抓桌面端 token。 */
  async acquire({ exclude } = {}) {
    const skip = new Set(exclude || []);
    for (let i = 0; i < 4; i += 1) {
      const ready = this.ready().filter((account) => !skip.has(account.id));
      if (ready.length > 0) {
        const account = ready[this.cursor % ready.length];
        this.cursor = (this.cursor + 1) % Math.max(1, ready.length);
        return { id: account.id, label: account.label, token: account.token, source: 'pool' };
      }
      const token = await this.ensureLegacy({ force: i > 0 });
      if (token) {
        const pl = jwtPayload(token) || {};
        return { id: 'legacy-desktop', label: pl.nickname || pl.preferred_username || '桌面端账号', token, source: 'legacy' };
      }
      break;
    }
    return null;
  }

  status() {
    this.reload(true);
    const now = Date.now();
    return {
      poolFile: CFG.poolFile,
      accounts: this.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        exp: account.exp ? new Date(account.exp * 1000).toISOString() : null,
        valid: tokenOk(account.token, 0),
        cooledUntil: (this.cooldown.get(account.id) || 0) > now ? new Date(this.cooldown.get(account.id)).toISOString() : null,
      })),
      activeAccountId: this.activeAccountId || null,
      legacy: {
        valid: tokenOk(this.legacy.token, 0),
        exp: this.legacyExp ? new Date(this.legacyExp * 1000).toISOString() : null,
        nickname: jwtPayload(this.legacy.token)?.nickname || null,
        phone: jwtPayload(this.legacy.token)?.preferred_username || null,
      },
      lastError: this.lastError || null,
    };
  }
}
const pool = new AccountPool();

/* ------------------------------------------------------------------ *
 * 上游请求
 * ------------------------------------------------------------------ */
const uuid = () => crypto.randomUUID();

function upstreamHeaders(token, conversationId) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    'x-requested-with': 'XMLHttpRequest',
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': uuid(),
    'acp-connection-id': conversationId,
    'X-Conversation-Message-ID': uuid(),
    'X-Request-ID': uuid(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'x-codebuddy-request': '1',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '0.0.0',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'User-Agent': `WorkBuddy/${CFG.appVersion}`,
    traceparent: `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`,
  };
}

const PASS_KEYS = [
  'messages', 'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'stop',
  'presence_penalty', 'frequency_penalty', 'seed', 'tools', 'tool_choice', 'parallel_tool_calls',
  'response_format', 'reasoning_effort', 'stream_options', 'logprobs', 'top_logprobs', 'user',
  'thinking', 'enable_thinking',
];

function buildUpstreamBody(inbound) {
  // 上游只支持流式：一律 stream:true，客户端要非流式时由本代理聚合
  const body = { model: resolveModel(inbound.model), stream: true };
  for (const k of PASS_KEYS) {
    const v = inbound[k];
    if (v === undefined || v === null) continue;
    if (k === 'messages' && Array.isArray(v) && !v.length) continue;
    body[k] = v;
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw Object.assign(new Error('messages is required'), { status: 400 });
  }
  const model = MODELS.find((m) => m.id === body.model);
  if (model?.maxOutputTokens && (body.max_tokens || body.max_completion_tokens)) {
    const mt = body.max_tokens ?? body.max_completion_tokens;
    if (mt > model.maxOutputTokens) {
      if (body.max_tokens) body.max_tokens = model.maxOutputTokens;
      if (body.max_completion_tokens) body.max_completion_tokens = model.maxOutputTokens;
    }
  }
  return body;
}

/**
 * 发一次上游请求；401/403 时冷却当前账号并换下一个账号重试。
 * @returns {{res: Response, timer: NodeJS.Timeout, lease: {id: string, label: string, source: string}}}
 */
async function callUpstream({ body, conversationId, exclude = [] }) {
  const lease = await pool.acquire({ exclude });
  if (lease === null) {
    throw Object.assign(new Error('no_workbuddy_account'), { status: 503 });
  }
  const url = CFG.gateway + CFG.chatPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.idleTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(lease.token, conversationId),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw Object.assign(new Error(`upstream_network: ${e.message}`), { status: 502 });
  }
  if (res.status === 401 || res.status === 403) {
    clearTimeout(timer);
    try { await res.body?.cancel(); } catch {}
    if (lease.source === 'pool') {
      pool.cool(lease.id, CFG.accountCooldownMs, `HTTP ${res.status}`);
    } else {
      pool.legacy.token = '';
    }
    const next = [...exclude, lease.id];
    log(`upstream ${res.status} on ${lease.id}, retrying with another account (${next.length})`);
    if (next.length <= 6) return callUpstream({ body, conversationId, exclude: next });
  }
  if (res.status === 429) {
    clearTimeout(timer);
    if (lease.source === 'pool') pool.cool(lease.id, 30000, 'HTTP 429');
    try { await res.body?.cancel(); } catch {}
    const next = [...exclude, lease.id];
    if (next.length <= 3) return callUpstream({ body, conversationId, exclude: next });
  }
  return { res, timer, lease };
}

/* ------------------------------------------------------------------ *
 * 用量统计
 * ------------------------------------------------------------------ */
function recordUsage(entry) {
  try { fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + '\n'); } catch {}
}

function usageSummary() {
  const out = { total: { requests: 0, prompt_tokens: 0, completion_tokens: 0, credit: 0 }, today: null, last: null, byAccount: {} };
  let lines = [];
  try { lines = fs.readFileSync(USAGE_LOG, 'utf8').trim().split('\n'); } catch { return out; }
  const todayKey = new Date().toISOString().slice(0, 10);
  out.today = { requests: 0, prompt_tokens: 0, completion_tokens: 0, credit: 0 };
  for (const line of lines) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    out.total.requests++;
    out.total.prompt_tokens += e.prompt_tokens || 0;
    out.total.completion_tokens += e.completion_tokens || 0;
    out.total.credit += e.credit || 0;
    const key = e.account_id || 'unassigned';
    out.byAccount[key] = out.byAccount[key] || { requests: 0, credit: 0 };
    out.byAccount[key].requests++;
    out.byAccount[key].credit += e.credit || 0;
    if ((e.ts || '').slice(0, 10) === todayKey) {
      out.today.requests++;
      out.today.prompt_tokens += e.prompt_tokens || 0;
      out.today.completion_tokens += e.completion_tokens || 0;
      out.today.credit += e.credit || 0;
    }
    out.last = e;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 128 * 1024 * 1024) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* 把上游 SSE 聚合成一次性 chat.completion（上游不支持非流式） */
async function aggregateCompletion(upstream, modelLabel) {
  const decoder = new TextDecoder();
  let buf = '';
  const msg = { role: 'assistant', content: '' };
  let reasoning = '';
  const toolCalls = [];
  let finishReason = null;
  let usage = {};
  let id = null;
  let created = Math.floor(Date.now() / 1000);

  const eat = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.id) id = obj.id;
    if (obj.created) created = obj.created;
    if (obj.usage && typeof obj.usage === 'object') usage = { ...usage, ...obj.usage };
    const ch = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (!ch) return;
    const d = ch.delta || {};
    if (typeof d.content === 'string') msg.content += d.content;
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = typeof tc.index === 'number' ? tc.index : toolCalls.length;
        if (!toolCalls[i]) toolCalls[i] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    if (ch.finish_reason) finishReason = ch.finish_reason;
  };

  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) eat(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith('data:')) eat(buf.trim().slice(5).trim());

  const real = toolCalls.filter(Boolean);
  if (reasoning) msg.reasoning_content = reasoning;
  if (real.length) msg.tool_calls = real;
  if (!msg.content) msg.content = '';
  return {
    id: id || `chatcmpl-${uuid()}`,
    object: 'chat.completion',
    created,
    model: modelLabel,
    choices: [{ index: 0, message: msg, finish_reason: finishReason || (real.length ? 'tool_calls' : 'stop') }],
    usage,
  };
}

async function handleChat(req, res) {
  const started = Date.now();
  let inbound;
  try {
    inbound = JSON.parse((await readBody(req)) || '{}');
  } catch (e) {
    return sendJson(res, 400, { error: { message: 'invalid json body', type: 'invalid_request_error' } });
  }

  let body;
  try {
    body = buildUpstreamBody(inbound);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
  }

  const conversationId = req.headers['x-wb-conversation-id'] || uuid();
  const sessionId = typeof req.headers['x-wb-session-id'] === 'string' ? req.headers['x-wb-session-id'] : '';
  const purpose = typeof req.headers['x-wb-session-purpose'] === 'string' ? req.headers['x-wb-session-purpose'] : '';
  const wantStream = inbound.stream !== false; // 客户端意图（上游恒为流式）
  const modelLabel = body.model;

  let upstream, timer, lease;
  try {
    ({ res: upstream, timer, lease } = await callUpstream({ body, conversationId }));
  } catch (e) {
    log(`chat error model=${body.model} ${e.message}`);
    return sendJson(res, e.status || 502, { error: { message: e.message, type: 'upstream_error' } });
  }

  const ctype = upstream.headers.get('content-type') || '';
  const baseUsage = {
    ts: new Date().toISOString(),
    session_id: sessionId || null,
    purpose: purpose || null,
    account_id: lease.id,
    account_label: lease.label,
    model: modelLabel,
  };

  if (!upstream.ok) {
    clearTimeout(timer);
    const text = await upstream.text().catch(() => '');
    log(`chat upstream ${upstream.status} model=${modelLabel} account=${lease.id} :: ${text.slice(0, 300)}`);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify({
      error: {
        message: text || `upstream ${upstream.status}`,
        type: upstream.status === 429 ? 'rate_limit_error' : 'upstream_error',
        code: upstream.status,
      },
    }));
    recordUsage({ ...baseUsage, status: upstream.status, stream: wantStream, duration_ms: Date.now() - started });
    return;
  }

  /* -------- 非流式：聚合上游 SSE -------- */
  if (!wantStream || !ctype.includes('event-stream')) {
    let json = null;
    try {
      json = ctype.includes('event-stream') ? await aggregateCompletion(upstream, modelLabel) : JSON.parse(await upstream.text());
    } catch (e) {
      clearTimeout(timer);
      log(`aggregate failed: ${e.message}`);
      return sendJson(res, 502, { error: { message: `aggregate_failed: ${e.message}`, type: 'upstream_error' } });
    }
    clearTimeout(timer);
    const u = json.usage || {};
    recordUsage({
      ...baseUsage, status: 200, stream: false,
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      credit: u.credit ?? 0, quota: u.quota ?? null,
      duration_ms: Date.now() - started,
    });
    log(`chat ok(non-stream) model=${modelLabel} account=${lease.id} session=${sessionId || '-'} in=${u.prompt_tokens ?? 0} out=${u.completion_tokens ?? 0} credit=${u.credit ?? 0} ${Date.now() - started}ms`);
    return sendJson(res, 200, json);
  }

  /* -------- 流式 -------- */
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...cors,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const usage = { prompt_tokens: 0, completion_tokens: 0, credit: 0, quota: null };
  let sawDone = false;
  let buf = '';
  const decoder = new TextDecoder();

  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return line ? null : null;
    const payload = line.slice(5).trim();
    if (!payload) return null;
    if (payload === '[DONE]') return '[DONE]';
    let obj;
    try { obj = JSON.parse(payload); } catch { return `data: ${payload}`; }
    if (obj.usage && typeof obj.usage === 'object') {
      usage.prompt_tokens = obj.usage.prompt_tokens ?? usage.prompt_tokens;
      usage.completion_tokens = obj.usage.completion_tokens ?? usage.completion_tokens;
      usage.credit = obj.usage.credit ?? usage.credit;
      usage.quota = obj.usage.quota ?? usage.quota;
    }
    if (obj.model) obj.model = modelLabel;
    return `data: ${JSON.stringify(obj)}`;
  };

  try {
    for await (const chunk of upstream.body) {
      clearTimeout(timer);
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const out = consumeLine(line);
        if (out === '[DONE]') { sawDone = true; res.write('data: [DONE]\n\n'); continue; }
        if (out) res.write(out + '\n\n');
        else if (line === '') res.write('\n');
      }
      if (res.writableNeedDrain) await new Promise((r) => res.once('drain', r));
    }
    if (buf.trim()) {
      const out = consumeLine(buf.trim());
      if (out) res.write((out === '[DONE]' ? 'data: [DONE]' : out) + '\n\n');
    }
  } catch (e) {
    log(`stream aborted: ${e.message}`);
  } finally {
    clearTimeout(timer);
    if (!sawDone) { try { res.write('data: [DONE]\n\n'); } catch {} }
    res.end();
    recordUsage({
      ...baseUsage, status: 200, stream: true,
      prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
      credit: usage.credit, quota: usage.quota, duration_ms: Date.now() - started,
    });
    log(`chat ok model=${modelLabel} account=${lease.id} session=${sessionId || '-'} in=${usage.prompt_tokens} out=${usage.completion_tokens} credit=${usage.credit} ${Date.now() - started}ms`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // 入站鉴权（可选）
  if (CFG.inboundKey) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const key = auth || req.headers['x-api-key'] || '';
    if (key !== CFG.inboundKey) {
      return sendJson(res, 401, { error: { message: 'invalid proxy api key', type: 'authentication_error' } });
    }
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: 'workbuddy',
          name: m.name,
          credits: m.credits,
          max_input_tokens: m.maxInputTokens,
          max_output_tokens: m.maxOutputTokens,
          supports_tool_call: m.supportsToolCall,
        })),
      });
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models/' || url.pathname.startsWith('/v1/models/'))) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const m = MODELS.find((x) => x.id === id);
      if (!m) return sendJson(res, 404, { error: { message: 'model not found', type: 'invalid_request_error' } });
      return sendJson(res, 200, { id: m.id, object: 'model', created: 0, owned_by: 'workbuddy', name: m.name, credits: m.credits });
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      return await handleChat(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, gateway: CFG.gateway, models: MODELS.length, pool: pool.status() });
    }

    if (req.method === 'GET' && url.pathname === '/v1/wb/pool') {
      return sendJson(res, 200, pool.status());
    }

    if (req.method === 'GET' && url.pathname === '/v1/wb/token') {
      const lease = pool.pick();
      return sendJson(res, lease ? 200 : 503, {
        ...pool.status(),
        picked: lease ? { id: lease.id, label: lease.label, source: lease.source } : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/wb/usage') {
      return sendJson(res, 200, usageSummary());
    }

    if (req.method === 'POST' && url.pathname === '/v1/wb/token/refresh') {
      pool.reload(true);
      const lease = await pool.acquire().catch(() => null);
      return sendJson(res, lease ? 200 : 503, pool.status());
    }

    sendJson(res, 404, { error: { message: `no route ${req.method} ${url.pathname}`, type: 'invalid_request_error' } });
  } catch (e) {
    log(`unhandled: ${e.stack || e.message}`);
    sendJson(res, 500, { error: { message: e.message, type: 'proxy_error' } });
  }
});

server.keepAliveTimeout = 120000;
server.requestTimeout = 0;
server.listen(CFG.port, CFG.host, () => {
  log(`wb-proxy listening on http://${CFG.host}:${CFG.port}/v1  (gateway=${CFG.gateway}, models=${MODELS.length}, pool=${CFG.poolFile})`);
  pool.acquire().then(
    (lease) => log(`auth ready: account=${lease ? `${lease.id}(${lease.source})` : 'none'} pool=${pool.status().accounts.length}`),
    (e) => log(`auth pending: ${e.message}`),
  );
});

process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.stack || e}`));
