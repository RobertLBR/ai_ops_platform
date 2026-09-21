/**
 * 告警入站归一化。
 *
 * 三种来源统一成 InboundAlert：
 *   - Alertmanager webhook（标准格式，labels/annotations）
 *   - 飞书群机器人（文本卡片，需从内容里解析服务名）
 *   - 企微群机器人
 *
 * 为什么归一化：告警格式各异，但诊断流水线只认一种输入。
 * 服务名解析复用服务注册表的别名匹配（resolveService），
 * 这是应对"服务名/级别不统一"的同一套机制。
 */

import { AppConfig, resolveService } from '../config/schema';
import { InboundAlert } from '../core/types';
import { logger } from '../utils/logger';

let alertSeq = 0;
function genAlertId(): string {
  alertSeq = (alertSeq + 1) % 100000;
  return `al_${Date.now().toString(36)}_${alertSeq.toString(36)}`;
}

const SEVERITY_MAP: Record<string, InboundAlert['severity']> = {
  critical: 'critical',
  crit: 'critical',
  fatal: 'critical',
  p0: 'critical',
  error: 'warning',
  err: 'warning',
  warning: 'warning',
  warn: 'warning',
  p1: 'warning',
  p2: 'info',
  info: 'info',
  notice: 'info',
};

function normalizeSeverity(raw: unknown): InboundAlert['severity'] {
  const s = String(raw ?? '').toLowerCase().trim();
  return SEVERITY_MAP[s] ?? 'warning';
}

/** 从任意文本里尝试匹配已注册服务名。 */
function guessService(config: AppConfig, text: string): string | null {
  if (!text) return null;
  // 优先精确别名匹配
  const svc = resolveService(config, text);
  if (svc) return svc.canonicalName;
  // 退化为在文本里搜索服务名/别名
  const lower = text.toLowerCase();
  for (const s of config.services) {
    if (lower.includes(s.canonicalName.toLowerCase())) return s.canonicalName;
    for (const a of s.aliases) {
      if (a.length >= 3 && lower.includes(a.toLowerCase())) return s.canonicalName;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alertmanager
// ---------------------------------------------------------------------------

interface AlertmanagerPayload {
  status?: string;
  alerts?: {
    status?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    startsAt?: string;
    endsAt?: string;
  }[];
}

export function parseAlertmanager(config: AppConfig, payload: unknown): InboundAlert[] {
  const p = (payload ?? {}) as AlertmanagerPayload;
  const alerts = Array.isArray(p.alerts) ? p.alerts : [];
  const out: InboundAlert[] = [];

  for (const a of alerts) {
    const labels = a.labels ?? {};
    const annotations = a.annotations ?? {};

    // Alertmanager 常见的服务标识字段
    const serviceLabel =
      labels.service ?? labels.application ?? labels.app ?? labels.job ?? labels.container ?? '';
    const textForGuess = `${serviceLabel} ${labels.alertname ?? ''} ${annotations.summary ?? ''} ${annotations.description ?? ''}`;
    const service = resolveService(config, serviceLabel)?.canonicalName ?? guessService(config, textForGuess);

    const title = annotations.summary ?? labels.alertname ?? '未命名告警';
    const description = annotations.description ?? annotations.message ?? '';

    out.push({
      id: genAlertId(),
      source: 'alertmanager',
      severity: normalizeSeverity(labels.severity ?? labels.priority),
      status: (a.status ?? p.status ?? 'firing') === 'resolved' ? 'resolved' : 'firing',
      service,
      title: String(title),
      description: String(description),
      firedAt: a.startsAt ?? new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      raw: a,
    });
  }

  // 兼容单个告警对象（非数组）
  if (out.length === 0 && (p.status || (p as Record<string, unknown>).labels)) {
    const single = p as unknown as AlertmanagerPayload['alerts'] extends (infer U)[] | undefined ? U : never;
    const arr = parseAlertmanager(config, { alerts: [single] });
    return arr;
  }

  return out;
}

// ---------------------------------------------------------------------------
// 飞书群机器人（通常是转发到群里的文本/卡片，这里做宽松解析）
// ---------------------------------------------------------------------------

export function parseFeishu(config: AppConfig, payload: unknown): InboundAlert[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  // 飞书事件回调结构较多样，尽量宽松取文本
  let text = '';
  if (typeof p.text === 'string') text = p.text;
  else if (p.event && typeof (p.event as Record<string, unknown>).message === 'object') {
    const msg = (p.event as Record<string, Record<string, unknown>>).message ?? {};
    const content = msg.content;
    if (typeof content === 'string') text = content;
    else if (content && typeof content === 'object') text = JSON.stringify(content);
  } else if (p.msg_type && p.content) {
    text = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
  } else {
    text = JSON.stringify(p);
  }

  if (!text.trim()) return [];

  return [
    {
      id: genAlertId(),
      source: 'feishu',
      severity: guessSeverityFromText(text),
      status: 'firing',
      service: guessService(config, text),
      title: text.split('\n')[0].slice(0, 200),
      description: text.slice(0, 2000),
      firedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      raw: p,
    },
  ];
}

/** 从文本里猜严重级别（飞书转发告警常无结构化字段）。 */
function guessSeverityFromText(text: string): InboundAlert['severity'] {
  const lower = text.toLowerCase();
  if (/critical|fatal|p0|紧急|严重|宕机|down/.test(lower)) return 'critical';
  if (/warn|warning|p1|警告|异常|error|报错|超时|timeout/.test(lower)) return 'warning';
  return 'info';
}

// ---------------------------------------------------------------------------
// 企业微信群机器人
// ---------------------------------------------------------------------------

export function parseWecom(config: AppConfig, payload: unknown): InboundAlert[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  let text = '';
  const msgtype = String(p.msgtype ?? '');
  if (msgtype === 'text' && p.text && typeof p.text === 'object') {
    text = String((p.text as Record<string, unknown>).content ?? '');
  } else if (msgtype === 'markdown' && p.markdown && typeof p.markdown === 'object') {
    text = String((p.markdown as Record<string, unknown>).content ?? '');
  } else {
    text = JSON.stringify(p);
  }

  if (!text.trim()) return [];

  return [
    {
      id: genAlertId(),
      source: 'wecom',
      severity: guessSeverityFromText(text),
      status: 'firing',
      service: guessService(config, text),
      title: text.split('\n')[0].slice(0, 200),
      description: text.slice(0, 2000),
      firedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      raw: p,
    },
  ];
}

/** 统一入口：按来源类型分发。 */
export function parseInboundAlerts(
  config: AppConfig,
  source: 'alertmanager' | 'feishu' | 'wecom',
  payload: unknown,
): InboundAlert[] {
  try {
    switch (source) {
      case 'alertmanager':
        return parseAlertmanager(config, payload);
      case 'feishu':
        return parseFeishu(config, payload);
      case 'wecom':
        return parseWecom(config, payload);
      default:
        return [];
    }
  } catch (e) {
    logger.error('告警解析失败', { source, error: (e as Error).message });
    return [];
  }
}

/** 严重级别比较（用于 minSeverity 过滤）。 */
const SEV_ORDER: Record<InboundAlert['severity'], number> = { info: 1, warning: 2, critical: 3 };
export function severityAtLeast(actual: InboundAlert['severity'], min: InboundAlert['severity']): boolean {
  return SEV_ORDER[actual] >= SEV_ORDER[min];
}
