/**
 * 极简结构化日志器。
 * 不引第三方依赖，输出 JSON 行，便于自身被 Filebeat/Promtail 采集。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    logger: 'aiops',
    msg,
    ...(fields ?? {}),
  });

  // 用 stdout/stderr 分流，便于容器日志采集
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/** 过滤字段值中的敏感内容，避免把密钥打进日志。 */
const SENSITIVE_KEYS = /password|passwd|secret|token|apikey|api_key|authorization|privatekey|passphrase/i;

export function safeFields(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '<REDACTED>' : v;
  }
  return out;
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, safeFields(fields)),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, safeFields(fields)),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, safeFields(fields)),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, safeFields(fields)),
};
