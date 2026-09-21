#!/usr/bin/env node
/**
 * 连通性自检脚本（部署前/排障用）。
 *
 * 用途：在目标部署主机上运行，快速确认本系统能否访问到 config.yaml 里
 *       配置的 Elasticsearch / Prometheus / SSH 主机。避免上线后才发现
 *       "服务起来了但拉不到日志"。
 *
 * 用法：
 *   node scripts/probe-connectivity.mjs
 *   node scripts/probe-connectivity.mjs --config=/path/to/config.yaml
 *
 * 只做只读探测，不修改任何东西：
 *   - ES：GET /_cluster/health
 *   - Prometheus：GET /-/healthy
 *   - SSH：TCP 连接测试（只连端口，不登录、不执行命令）
 *
 * 退出码：全部通过=0，有任一失败=1（便于 CI / 部署脚本判断）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// 配置加载（与 server/src/config/schema.ts 的路径与插值规则保持一致）
// ---------------------------------------------------------------------------

function resolveConfigPath(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.AIOPS_CONFIG) candidates.push(process.env.AIOPS_CONFIG);
  const root = process.cwd();
  candidates.push(
    resolve(root, 'config.yaml'),
    resolve(root, 'config.local.yaml'),
    resolve(root, 'config/config.yaml'),
    '/app/config/config.yaml',
  );
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return resolve(c);
    } catch {
      /* ignore */
    }
  }
  throw new Error(`未找到配置文件。已尝试：\n  ${candidates.join('\n  ')}`);
}

/** 把字符串里的 ${ENV} 用 process.env 插值（未设置→空字符串） */
function interpolate(value, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) {
        missing.add(name);
        return '';
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, missing);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 探测实现
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(msg) {
  return `${GREEN}✓${RESET} ${msg}`;
}
function fail(msg) {
  return `${RED}✗${RESET} ${msg}`;
}
function skip(msg) {
  return `${YELLOW}–${RESET} ${msg}`;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function basicAuth(username, password) {
  if (!username) return {};
  return { Authorization: `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}` };
}

async function probeElasticsearch(ds, missing) {
  const label = `ES  [${ds.id}] ${ds.name ?? ''} ${ds.url}`.trim();
  if (!ds.url) return fail(`${label} — 未配置 url`);
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${ds.url.replace(/\/$/, '')}/_cluster/health`,
      { headers: { Accept: 'application/json', ...basicAuth(ds.username, ds.password) } },
      ds.timeoutMs ?? 10000,
    );
    const ms = Date.now() - started;
    if (!res.ok) return fail(`${label} — HTTP ${res.status} (${ms}ms)`);
    const body = await res.json();
    const color = body.status === 'green' ? GREEN : YELLOW;
    return ok(`${label} — 集群状态 ${color}${body.status}${RESET}，节点 ${body.number_of_nodes ?? '?'} (${ms}ms)`);
  } catch (e) {
    return fail(`${label} — ${e.name === 'AbortError' ? '超时' : e.message}`);
  }
}

async function probePrometheus(ds) {
  const label = `PROM [${ds.id}] ${ds.name ?? ''} ${ds.url}`.trim();
  if (!ds.url) return fail(`${label} — 未配置 url`);
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${ds.url.replace(/\/$/, '')}/-/healthy`,
      { headers: basicAuth(ds.username, ds.password) },
      ds.timeoutMs ?? 10000,
    );
    const ms = Date.now() - started;
    if (!res.ok) return fail(`${label} — HTTP ${res.status} (${ms}ms)`);
    return ok(`${label} — 健康 (${ms}ms)`);
  } catch (e) {
    return fail(`${label} — ${e.name === 'AbortError' ? '超时' : e.message}`);
  }
}

/** SSH 只做 TCP 端口连通性测试，不登录、不执行命令。 */
function probeSsh(ds) {
  const label = `SSH  [${ds.id}] ${ds.name ?? ''} ${ds.host}:${ds.port ?? 22}`.trim();
  const host = ds.host;
  const port = ds.port ?? 22;
  if (!host) return Promise.resolve(fail(`${label} — 未配置 host`));
  const timeoutMs = ds.timeoutMs ?? 10000;
  const started = Date.now();
  return new Promise((resolveP) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolveP(msg);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(ok(`${label} — 端口可达 (${Date.now() - started}ms)`)));
    sock.on('timeout', () => finish(fail(`${label} — 连接超时`)));
    sock.on('error', (e) => finish(fail(`${label} — ${e.message}`)));
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const explicit = process.argv.find((a) => a.startsWith('--config='))?.split('=')[1];
  let configPath;
  try {
    configPath = resolveConfigPath(explicit);
  } catch (e) {
    console.error(`\n[错误] ${e.message}\n`);
    process.exit(1);
  }

  const missing = new Set();
  const raw = interpolate(parseYaml(readFileSync(configPath, 'utf8')), missing);

  console.log('\n==========================================================');
  console.log(' AI Ops Platform — 连通性自检');
  console.log(` 配置文件: ${configPath}`);
  console.log('==========================================================\n');

  if (missing.size) {
    console.log(`${YELLOW}以下环境变量未设置（已替换为空值，相关认证可能失败）：${RESET}`);
    console.log(`${DIM}  ${[...missing].sort().join(', ')}${RESET}\n`);
  }

  const ds = raw.datasources ?? {};
  const esList = (ds.elasticsearch ?? []).filter((d) => d.enabled !== false);
  const promList = (ds.prometheus ?? []).filter((d) => d.enabled !== false);
  const sshList = (ds.ssh ?? []).filter((d) => d.enabled !== false);

  const results = [];

  if (esList.length) {
    console.log('--- Elasticsearch ---');
    for (const d of esList) results.push(await probeElasticsearch(d, missing));
  } else {
    console.log(skip('Elasticsearch — 无启用的数据源'));
  }

  if (promList.length) {
    console.log('--- Prometheus ---');
    for (const d of promList) results.push(await probePrometheus(d));
  } else {
    console.log(skip('Prometheus — 无启用的数据源'));
  }

  if (sshList.length) {
    console.log('--- SSH 主机（仅端口探测，不登录）---');
    for (const d of sshList) results.push(await probeSsh(d));
  } else {
    console.log(skip('SSH — 无启用的主机'));
  }

  // 打印汇总
  console.log('\n--- 结果汇总 ---');
  const lines = results.filter(Boolean);
  if (lines.length === 0) {
    console.log(skip('没有启用的数据源可探测（检查 config.yaml 的 enabled 字段）'));
  } else {
    for (const l of lines) console.log(l);
  }

  const failed = lines.filter((l) => l.includes(`${RED}✗`)).length;
  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}全部通过${RESET}（${lines.length} 项）\n`);
    process.exit(0);
  } else {
    console.log(`${RED}${failed} 项失败${RESET} / 共 ${lines.length} 项\n`);
    console.log(`${DIM}排查建议：确认目标主机地址/端口/认证、本机网络与防火墙策略。${RESET}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n[未捕获错误] ${e?.stack ?? e}\n`);
  process.exit(1);
});
