/**
 * AI 生成的服务注册表条目的严格校验器。
 *
 * 三层校验，顺序执行（设计文档 2.3）：
 *   第 1 层：未知键白名单递归比对 —— 补齐 zod 静默剥离多余键的坑，
 *            错误信息带完整路径，可直接回喂给 AI 重试。
 *   第 2 层：ServiceSchema.safeParse —— 类型/枚举/结构合法性（复用现有 schema）。
 *   第 3 层：B1-B8 业务规则 —— 全部来自生产校准经验，与生成用 System Prompt 逐条对应。
 *
 * 不用 ServiceSchema.strict() 的原因：现有 schema 每个字段都带 .default()，
 * strict 与 default 在嵌套对象上组合行为反直觉，且错误信息不含中文业务语境。
 */

import { AppConfig, ServiceDef, ServiceSchema } from './schema';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// 封闭键白名单（恰好 12 个顶层键；多一个都是 error）
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
  'canonicalName', 'displayName', 'aliases', 'tier', 'datasourceId',
  'indexPatterns', 'fieldMapping', 'deployment', 'stack', 'dependsOn',
  'dependedBy', 'prometheusLabels', 'knownIssues',
]);
const FIELD_MAPPING_KEYS = new Set(['timestamp', 'level', 'message', 'traceId', 'logger']);
const DEPLOYMENT_KEYS = new Set(['hostIds', 'containerNames', 'port', 'jenkinsJob', 'registry']);
const KNOWN_ISSUE_KEYS = new Set(['pattern', 'category', 'severity', 'cause', 'sop']);

export interface ValidateContext {
  config: AppConfig;
  /** 从日志样例中提取的字段名集合（analyze 阶段提供；为空时 B1/B6 降级为 warning） */
  sampleFieldNames?: string[];
  /** 脱敏后的日志样例原文（供 B6 命中校验；为空时降级为 warning） */
  logSample?: string;
}

export interface ValidateResult {
  errors: string[];
  warnings: string[];
  /** 第 2 层 zod 通过后的完整 ServiceDef（默认值已填充）；未通过为 undefined */
  value?: ServiceDef;
}

// ---------------------------------------------------------------------------
// 第 1 层：未知键白名单递归比对
// ---------------------------------------------------------------------------

function checkUnknownKeys(raw: unknown, errors: string[]): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('生成的配置必须是一个 JSON 对象');
    return;
  }
  const walk = (obj: Record<string, unknown>, allowed: Set<string>, path: string, legalHint: string): void => {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        errors.push(`${path}${k} 不是合法键，合法键为：${legalHint}`);
      }
    }
  };
  const top = raw as Record<string, unknown>;
  walk(top, TOP_LEVEL_KEYS, '', TOP_LEVEL_KEYS.size + ' 个顶层键（canonicalName/displayName/aliases/tier/datasourceId/indexPatterns/fieldMapping/deployment/stack/dependsOn/dependedBy/prometheusLabels/knownIssues）');

  if (top.fieldMapping && typeof top.fieldMapping === 'object' && !Array.isArray(top.fieldMapping)) {
    walk(top.fieldMapping as Record<string, unknown>, FIELD_MAPPING_KEYS, 'fieldMapping.', [...FIELD_MAPPING_KEYS].join('/'));
  }
  if (top.deployment && typeof top.deployment === 'object' && !Array.isArray(top.deployment)) {
    walk(top.deployment as Record<string, unknown>, DEPLOYMENT_KEYS, 'deployment.', [...DEPLOYMENT_KEYS].join('/'));
  }
  if (Array.isArray(top.knownIssues)) {
    top.knownIssues.forEach((ki, i) => {
      if (ki && typeof ki === 'object' && !Array.isArray(ki)) {
        walk(ki as Record<string, unknown>, KNOWN_ISSUE_KEYS, `knownIssues[${i}].`, [...KNOWN_ISSUE_KEYS].join('/'));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 第 3 层：B1-B8 业务规则
// ---------------------------------------------------------------------------

const HAS_CJK = /[一-龥]/;
/** password/secret/token/apiKey 样式的键值对（出现在任何字符串值里都可疑） */
const SECRET_KV = /(password|passwd|secret|api[_-]?key|access[_-]?key|token)\s*[:=]\s*\S+/i;
/** 形似真实密钥的高熵串：长度 > 20、字母数字混合、无空格 */
const HIGH_ENTROPY_TOKEN = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9+/=_-]{21,}$/;

/** 递归 walk service 的所有字符串值（跳过 knownIssues[].pattern —— 正则本身合法地含奇怪字符）。 */
function walkStrings(value: unknown, path: string, visit: (s: string, path: string) => void): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(v, path ? `${path}.${k}` : k, visit);
    }
  }
}

function checkBusinessRules(svc: ServiceDef, ctx: ValidateContext, errors: string[], warnings: string[]): void {
  const { config } = ctx;
  const sampleFields = new Set(ctx.sampleFieldNames ?? []);
  const hasSampleFields = sampleFields.size > 0;
  const hasSample = !!ctx.logSample;

  // --- B7：命名与数据源（先做，后续规则依赖 datasource 存在）---
  if (!/^[a-z][a-z0-9-]*$/.test(svc.canonicalName)) {
    errors.push(`canonicalName "${svc.canonicalName}" 不符合 ^[a-z][a-z0-9-]*$（小写字母开头，仅小写字母/数字/中划线）`);
  }
  const ds = config.datasources.elasticsearch.find((d) => d.id === svc.datasourceId);
  if (!svc.datasourceId) {
    errors.push('datasourceId 不能为空（datasourceId 只能从已启用的 ES 数据源中选择）');
  } else if (!ds) {
    errors.push(`datasourceId "${svc.datasourceId}" 在 config.datasources.elasticsearch 中不存在`);
  } else if (!ds.enabled) {
    errors.push(`datasourceId "${svc.datasourceId}" 指向的 ES 数据源未启用（enabled=false），热生效后诊断将查不到日志`);
  }

  // --- B1：fieldMapping 第 1 候选必须真实存在于样例字段集 ---
  // timestamp[0] 与 level[0] 是唯一参与 ES 查询的候选（见 ElasticsearchSource）
  for (const [field, label] of [['timestamp', '时间字段'], ['level', '级别字段']] as const) {
    const first = svc.fieldMapping[field][0];
    if (!first) {
      errors.push(`fieldMapping.${field} 至少需要一个候选字段名（第 1 个候选是唯一参与 ES 查询的${label}）`);
      continue;
    }
    if (hasSampleFields) {
      if (!sampleFields.has(first)) {
        errors.push(`fieldMapping.${field}[0] "${first}" 在日志样例的字段集中不存在（它是唯一参与 ES 查询的候选，必须是样例中真实存在的字段）`);
      }
    } else {
      warnings.push(`未提供日志样例字段集，无法核验 fieldMapping.${field}[0] "${first}" 是否真实存在（请人工确认）`);
    }
  }

  // --- B2：aliases 必须含中文名（resolveService 不匹配 displayName）---
  const hasChineseAlias = svc.aliases.some((a) => HAS_CJK.test(a));
  if (!hasChineseAlias) {
    errors.push('aliases 必须包含服务中文名（resolveService 只用 canonicalName/aliases 匹配，不匹配 displayName，缺中文别名会导致中文提问识别不到该服务）');
  }
  if (svc.displayName && HAS_CJK.test(svc.displayName) && !svc.aliases.includes(svc.displayName)) {
    errors.push(`displayName "${svc.displayName}" 是中文，aliases 必须包含 displayName 本身`);
  }

  // --- B3：indexPatterns 与数据源默认索引是覆盖关系 ---
  if (ds && svc.indexPatterns.length > 0) {
    const overlap = svc.indexPatterns.some((p) => ds.indices.includes(p));
    if (!overlap) {
      warnings.push(
        `indexPatterns（${svc.indexPatterns.join(', ')}）与数据源 ${ds.id} 的默认 indices（${ds.indices.join(', ')}）无交集；` +
          `indexPatterns 是覆盖关系不是合并，该服务可能查不到任何日志`,
      );
    }
  }

  // --- B4：本环境实测约束 ---
  // 历史实现曾把 levelFilter 非空作为「保存闸」（error），但 config.example.yaml 与 schema 默认值
  // 均为非空（['ERROR','WARN','FATAL']），导致 AI 配置生成在自带示例配置下「开箱即废」。
  // diagnosis.levelFilter 是「诊断」全局配置，与单条服务注册表无直接因果，故降级为 warning：
  // 仅提示本环境 level 字段可能不可过滤（依赖 fieldMapping.level 时知悉限制），不阻断保存。
  if (config.diagnosis.levelFilter.length > 0) {
    warnings.push(
      `本环境 diagnosis.levelFilter 非空（${config.diagnosis.levelFilter.join('/')}），实测 level 字段可能不可过滤；` +
        `若服务依赖 fieldMapping.level 做级别过滤请知悉该限制（已降级为 warning，不影响保存）`,
    );
  }
  if (ds && ds.maxDocs > 10000) {
    warnings.push(`数据源 ${ds.id} 的 maxDocs=${ds.maxDocs} 超过 10000，单次诊断拉取量偏大，建议调低`);
  }
  const instance = svc.prometheusLabels?.instance;
  if (typeof instance === 'string' && instance.includes('\\')) {
    errors.push('prometheusLabels.instance 不允许包含反斜杠（PromQL label matcher 中转义行为实测不可靠）');
  }

  // --- B5：禁止生成敏感值 ---
  walkStrings(svc, '', (s, path) => {
    if (path.includes('pattern')) return; // knownIssues[].pattern 是正则，豁免
    if (SECRET_KV.test(s)) {
      errors.push(`${path} 的值疑似包含密钥/口令（password/secret/token/apiKey 样式），禁止写入服务配置`);
      return;
    }
    for (const token of s.split(/\s+/)) {
      if (HIGH_ENTROPY_TOKEN.test(token)) {
        errors.push(`${path} 的值含形似真实密钥的高熵字符串（长度>20 的字母数字混合串），禁止写入服务配置`);
        return;
      }
    }
  });

  // --- B6：knownIssues.pattern 必须可编译，且能在样例中命中 ---
  svc.knownIssues.forEach((ki, i) => {
    let re: RegExp | null = null;
    try {
      re = new RegExp(ki.pattern, 'i');
    } catch {
      warnings.push(`knownIssues[${i}].pattern "${ki.pattern.slice(0, 80)}" 不是合法正则，无法编译`);
      return;
    }
    if (hasSample) {
      if (!re.test(ctx.logSample!)) {
        warnings.push(`knownIssues[${i}].pattern 在日志样例中命中 0 次，该已知问题可能是臆造的（请人工确认或补充样例）`);
      }
    } else {
      warnings.push(`未提供日志样例，无法核验 knownIssues[${i}].pattern 的命中率（请人工确认）`);
    }
  });

  // --- B8：dependsOn/dependedBy 前向引用 ---
  const known = new Set(config.services.map((s) => s.canonicalName));
  for (const [field, refs] of [['dependsOn', svc.dependsOn], ['dependedBy', svc.dependedBy]] as const) {
    for (const r of refs) {
      if (r !== svc.canonicalName && !known.has(r)) {
        warnings.push(`${field} 引用的服务 "${r}" 不在注册表中（允许前向引用，但该服务注册前依赖分析不生效）`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 校验 AI 生成（或用户编辑后）的服务配置。
 * errors 非空即不可保存；warnings 如实展示但不阻断。
 */
export function validateGeneratedService(raw: unknown, ctx: ValidateContext): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 第 1 层：未知键白名单
  checkUnknownKeys(raw, errors);
  if (errors.length > 0) return { errors, warnings };

  // 第 2 层：zod 结构校验（复用现有 ServiceSchema，默认值在此填充）
  const parsed = ServiceSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      const path = issue.path.join('.') || '(root)';
      errors.push(`${path}: ${issue.message}`);
    }
    return { errors, warnings };
  }

  // 第 3 层：业务规则
  try {
    checkBusinessRules(parsed.data, ctx, errors, warnings);
  } catch (e) {
    // 校验器自身异常不该阻断主流程，降级为 warning
    logger.warn('业务规则校验异常，已跳过', { error: (e as Error).message });
    warnings.push(`业务规则校验执行异常（${(e as Error).message}），请人工复核配置`);
  }

  return { errors, warnings, value: parsed.data };
}

// ---------------------------------------------------------------------------
// diff 计算（save 时对比 AI 草稿与用户最终稿）
// ---------------------------------------------------------------------------

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

/** 逐字段 walk 两个对象，产出 [{path, from, to}]；超过 maxEntries 截断并追加一条说明。 */
export function diffObjects(a: unknown, b: unknown, maxEntries = 50): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (out.length >= maxEntries) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const bothObj =
      x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y);
    if (bothObj) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) {
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    out.push({ path: path || '(root)', from: x ?? null, to: y ?? null });
  };
  walk(a, b, '');
  if (out.length >= maxEntries) {
    out.push({ path: '(truncated)', from: null, to: `diff 超过 ${maxEntries} 条，已截断` });
  }
  return out;
}
