/**
 * 脱敏中间件 —— 合规闸口。
 *
 * 所有送往大模型的文本必须先经过这里。设计原则：
 *   1. 规则完全由配置文件驱动，不同甲方项目可用不同规则集。
 *   2. 审计只记录「命中的规则名 + 次数」，绝不记录原值，
 *      这样审计日志本身也是安全的、可长期留存的。
 *   3. 保留技术上下文完整性：异常栈、时间戳、服务名、SQL 结构、HTTP 状态码一律不动。
 *   4. 规则编译失败不阻断启动，降级为跳过该规则并告警。
 */

import { RedactionRule } from '../config/schema';
import { logger } from '../utils/logger';

export interface RedactionAuditEntry {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  audit: RedactionAuditEntry[];
  totalRedacted: number;
}

interface CompiledRule {
  name: string;
  regex: RegExp;
  replacement: string;
}

/**
 * 归一化正则模式：把 PCRE/Java 风格的内联标志转成 JS 标志。
 *
 * JavaScript 的 RegExp **不支持** `(?i)` `(?m)` `(?s)` 这类内联标志，
 * 但运维同学习惯用 grep/Java/PCRE 语法写规则，配置文件里很容易出现。
 * 这里做一次转换，避免规则静默失效（编译抛错被跳过后，脱敏就有漏洞）。
 */
export function normalizePatternFlags(pattern: string, flags: string): { pattern: string; flags: string } {
  let p = pattern;
  let f = flags;

  // 提取开头的内联标志组，如 (?i) (?im) (?i-s)
  const inline = /^\(\?([a-z]*)(?:-([a-z]*))?\)/i.exec(p);
  if (inline) {
    const add = (inline[1] ?? '').toLowerCase();
    const sub = (inline[2] ?? '').toLowerCase();
    p = p.slice(inline[0].length);
    for (const c of add) if ('imsu'.includes(c) && !f.includes(c)) f += c;
    f = [...f].filter((c) => !sub.includes(c)).join('');
  }

  return { pattern: p, flags: [...new Set(f.split(''))].filter(Boolean).join('') };
}

/**
 * 编译后的脱敏器。编译一次、复用多次（正则编译有成本，
 * 诊断流水线一次会脱敏几十条文本）。
 */
export class Redactor {
  private readonly rules: CompiledRule[] = [];
  private readonly enabled: boolean;
  private readonly auditEnabled: boolean;

  constructor(rules: RedactionRule[], enabled = true, auditEnabled = true) {
    this.enabled = enabled;
    this.auditEnabled = auditEnabled;

    if (!enabled) {
      logger.warn('脱敏已禁用：日志原文将直接送往大模型');
      return;
    }

    for (const r of rules) {
      if (!r.enabled) continue;
      try {
        // flags 去重（'g' 重复会抛错）
        const flags = [...new Set(r.flags.split(''))].join('');
        const regex = new RegExp(r.pattern, flags.includes('g') ? flags : flags + 'g');
        this.rules.push({ name: r.name, regex, replacement: r.replacement });
      } catch (e) {
        // 单条规则写错不该让整个系统起不来
        logger.error('脱敏规则编译失败，已跳过', { rule: r.name, pattern: r.pattern, error: (e as Error).message });
      }
    }

    if (this.rules.length === 0) {
      logger.warn('脱敏已启用但无有效规则，等同于未脱敏');
    } else {
      logger.info('脱敏规则已加载', { count: this.rules.length, rules: this.rules.map((r) => r.name) });
    }
  }

  get ruleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  get isEnabled(): boolean {
    return this.enabled && this.rules.length > 0;
  }

  /** 脱敏单条文本。 */
  redact(text: string): RedactionResult {
    if (!text) return { text, audit: [], totalRedacted: 0 };
    if (!this.isEnabled) {
      return { text, audit: [], totalRedacted: 0 };
    }

    const auditMap = new Map<string, number>();
    let out = text;

    for (const rule of this.rules) {
      // 每次使用前重置 lastIndex（带 g 标志的正则有状态）
      rule.regex.lastIndex = 0;
      let count = 0;
      out = out.replace(rule.regex, (...args) => {
        count++;
        // replacement 里的 $1 $2 由 String.replace 原生处理
        return rule.replacement;
      });
      if (count > 0 && this.auditEnabled) {
        auditMap.set(rule.name, (auditMap.get(rule.name) ?? 0) + count);
      }
    }

    const audit: RedactionAuditEntry[] = [...auditMap.entries()].map(([rule, count]) => ({ rule, count }));
    return { text: out, audit, totalRedacted: audit.reduce((s, a) => s + a.count, 0) };
  }

  /** 批量脱敏，聚合审计信息。 */
  redactMany(texts: string[]): { texts: string[]; audit: RedactionAuditEntry[]; totalRedacted: number } {
    const auditMap = new Map<string, number>();
    let total = 0;
    const out = texts.map((t) => {
      const r = this.redact(t);
      total += r.totalRedacted;
      for (const a of r.audit) auditMap.set(a.rule, (auditMap.get(a.rule) ?? 0) + a.count);
      return r.text;
    });
    return {
      texts: out,
      audit: [...auditMap.entries()].map(([rule, count]) => ({ rule, count })),
      totalRedacted: total,
    };
  }

  /** 脱敏一个结构化对象（深度遍历所有字符串值）。 */
  redactObject<T>(value: T): { value: T; totalRedacted: number } {
    let total = 0;
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = this.redact(v);
        total += r.totalRedacted;
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
        return out;
      }
      return v;
    };
    return { value: walk(value) as T, totalRedacted: total };
  }
}

/**
 * 默认脱敏规则（配置文件未提供时的兜底）。
 * 与 config.example.yaml 中的规则保持一致。
 */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { name: 'phone', enabled: true, pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)', replacement: '<PHONE>', flags: 'g' },
  { name: 'id_card', enabled: true, pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)', replacement: '<ID_CARD>', flags: 'g' },
  {
    name: 'email',
    enabled: true,
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    replacement: '<EMAIL>',
    flags: 'g',
  },
  {
    name: 'credential',
    enabled: true,
    pattern: '(?i)(password|passwd|secret|token|api[_-]?key)(["\']?\\s*[:=]\\s*)\\S+',
    replacement: '$1$2<REDACTED>',
    flags: 'g',
  },
  { name: 'jwt', enabled: true, pattern: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}', replacement: '<JWT>', flags: 'g' },
];

export function createRedactor(
  rules: RedactionRule[] | undefined,
  enabled: boolean,
  audit: boolean,
): Redactor {
  const effective = rules && rules.length > 0 ? rules : DEFAULT_REDACTION_RULES;
  return new Redactor(effective, enabled, audit);
}
