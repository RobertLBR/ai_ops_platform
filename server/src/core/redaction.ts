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
/**
 * 手动展开替换串中的 `$` 引用。
 *
 * 必须手动做：`String.replace(regex, fn)` 的**函数式**替换不会自动展开 `$1`，
 * 它会把 `$1` 当字面量返回。而我们需要函数式替换来统计命中次数（审计用）。
 * 所以这里复刻 String.replace 的 `$` 语义。
 *
 * 支持：`$$`(字面$) `$&`(整个匹配) `$`` `(前缀) `$'`(后缀) `$1`-`$99`(捕获组) `$<name>`(命名组)
 */
function expandReplacement(
  template: string,
  match: string,
  args: unknown[],
  offset: number,
  whole: string,
): string {
  // args 布局：[match, ...captureGroups, offset, wholeString, (namedGroups?)]
  const last = args[args.length - 1];
  const hasNamed = !!last && typeof last === 'object';
  const groupsEnd = hasNamed ? args.length - 3 : args.length - 2;
  // 捕获组从索引 1 开始（索引 0 是整个匹配）
  const groups = args.slice(1, groupsEnd) as (string | undefined)[];
  const named = hasNamed ? last : undefined;
  let out = '';

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== '$') {
      out += ch;
      continue;
    }
    const next = template[i + 1];

    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&') {
      out += match;
      i++;
    } else if (next === '`') {
      out += whole.slice(0, offset);
      i++;
    } else if (next === "'") {
      out += whole.slice(offset + match.length);
      i++;
    } else if (next === '<' && named && typeof named === 'object') {
      const close = template.indexOf('>', i + 2);
      if (close > 0) {
        const name = template.slice(i + 2, close);
        const val = (named as Record<string, string | undefined>)[name];
        out += val ?? '';
        i = close;
      } else {
        out += '$';
      }
    } else if (next && next >= '1' && next <= '9') {
      // 贪婪匹配两位数组号（$10 优先于 $1 + '0'）
      let idx = parseInt(next, 10);
      let consumed = 1;
      const two = template.slice(i + 1, i + 3);
      if (/^\d\d$/.test(two)) {
        const idx2 = parseInt(two, 10);
        if (idx2 >= 1 && idx2 <= groups.length) {
          idx = idx2;
          consumed = 2;
        }
      }
      if (idx >= 1 && idx <= groups.length) {
        out += groups[idx - 1] ?? '';
        i += consumed;
      } else {
        out += '$'; // 不存在的组号，保留字面 $
      }
    } else {
      out += '$';
    }
  }
  return out;
}

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
        // 归一化：把 PCRE/Java 风格内联标志 (?i) 转成 JS 标志；并保证带 g
        const norm = normalizePatternFlags(r.pattern, r.flags ?? 'g');
        const flags = norm.flags.includes('g') ? norm.flags : norm.flags + 'g';
        const regex = new RegExp(norm.pattern, flags);
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
      // 固定源串：replace 回调执行期间 out 尚未被重新赋值，显式捕获更安全
      const source = out;
      // 函数式替换：便于计数；$ 组引用由 expandReplacement 手动展开
      out = source.replace(rule.regex, (...args: unknown[]) => {
        count++;
        const match = String(args[0] ?? '');
        const last = args[args.length - 1];
        const hasNamed = !!last && typeof last === 'object';
        // args 布局：[match, ...groups, offset, whole, (named?)]
        const offset = Number(hasNamed ? args[args.length - 3] : args[args.length - 2]);
        return expandReplacement(rule.replacement, match, args, offset, source);
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
