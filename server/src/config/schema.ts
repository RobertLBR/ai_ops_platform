/**
 * 配置文件 Schema 定义与加载器。
 *
 * 设计要点：
 *  1. 单一 YAML 文件承载「主机信息 + AI 信息」，支持 Docker 挂载与环境变量指定路径。
 *  2. 敏感值（API Key、SSH 密码）用 ${ENV_NAME} 占位，加载时从环境变量插值，
 *     保证配置文件本身可以安全地纳入版本控制（config.yaml 已 gitignore，
 *     但即便误提交也不含明文密钥）。
 *  3. zod 严格校验 + 友好错误信息，配置写错时在启动阶段就失败，而不是运行时才炸。
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ServerSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  webRoot: z.string().default('web/dist'),
  apiToken: z.string().optional().default(''),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const DatabaseSchema = z.object({
  path: z.string().default('data/aiops.db'),
});

const StorageSchema = z
  .object({
    // 诊断任务（含日志模板/结论等大字段）的保留天数，超期由调度器每日清理
    retentionDays: z.coerce.number().int().positive().default(90),
  })
  .default({});

const AiProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional().default(''),
  timeoutMs: z.coerce.number().int().positive().default(120000),
});

const AiRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
  temperature: z.coerce.number().min(0).max(2).default(0.1),
  maxTokens: z.coerce.number().int().positive().default(4000),
});

const RedactionRuleSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  pattern: z.string(),
  replacement: z.string(),
  flags: z.string().default('g'),
});

const AiSchema = z.object({
  providers: z.record(AiProviderSchema).default({}),
  routing: z.object({
    reasoning: AiRouteSchema,
    light: AiRouteSchema,
    report: AiRouteSchema,
  }),
  limits: z
    .object({
      maxInputTokens: z.coerce.number().int().positive().default(60000),
      maxRetries: z.coerce.number().int().min(0).max(5).default(2),
      cacheTtlSeconds: z.coerce.number().int().min(0).default(600),
    })
    .default({}),
  redaction: z
    .object({
      enabled: z.boolean().default(true),
      audit: z.boolean().default(true),
      rules: z.array(RedactionRuleSchema).default([]),
    })
    .default({ enabled: true, audit: true, rules: [] }),
});

const EsDatasourceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
  timeoutMs: z.coerce.number().int().positive().default(15000),
  maxDocs: z.coerce.number().int().positive().default(20000),
  indices: z.array(z.string()).default(['*']),
});

const PromQuerySchema = z.object({
  name: z.string(),
  promql: z.string(),
});

const PrometheusDatasourceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
  timeoutMs: z.coerce.number().int().positive().default(15000),
  queries: z.array(PromQuerySchema).default([]),
});

const SshDatasourceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  host: z.string(),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  enabled: z.boolean().default(false),
  username: z.string().optional().default(''),
  password: z.string().optional().default(''),
  privateKeyPath: z.string().optional().default(''),
  passphrase: z.string().optional().default(''),
  timeoutMs: z.coerce.number().int().positive().default(10000),
  allowedCommands: z.array(z.string()).default([]),
});

const DatasourcesSchema = z.object({
  elasticsearch: z.array(EsDatasourceSchema).default([]),
  prometheus: z.array(PrometheusDatasourceSchema).default([]),
  ssh: z.array(SshDatasourceSchema).default([]),
});

const KnownIssueSchema = z.object({
  pattern: z.string(),
  category: z.string().optional().default(''),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
  cause: z.string().optional().default(''),
  sop: z.string().optional().default(''),
});

export const ServiceSchema = z.object({
  canonicalName: z.string(),
  displayName: z.string().optional().default(''),
  aliases: z.array(z.string()).default([]),
  tier: z.enum(['core', 'important', 'edge']).default('important'),
  datasourceId: z.string().optional().default(''),
  indexPatterns: z.array(z.string()).default([]),
  fieldMapping: z
    .object({
      timestamp: z.array(z.string()).default(['@timestamp']),
      level: z.array(z.string()).default(['level']),
      message: z.array(z.string()).default(['message']),
      traceId: z.array(z.string()).default([]),
      logger: z.array(z.string()).default([]),
    })
    .default({}),
  deployment: z
    .object({
      hostIds: z.array(z.string()).default([]),
      containerNames: z.array(z.string()).default([]),
      port: z.coerce.number().int().optional(),
      jenkinsJob: z.string().optional().default(''),
      registry: z.string().optional().default(''),
    })
    .default({}),
  stack: z.string().optional().default(''),
  dependsOn: z.array(z.string()).default([]),
  dependedBy: z.array(z.string()).default([]),
  prometheusLabels: z.record(z.string()).default({}),
  knownIssues: z.array(KnownIssueSchema).default([]),
});

const SecuritySchema = z
  .object({
    readonly: z
      .object({
        allowedCommandPrefixes: z.array(z.string()).default([]),
        blockedPatterns: z.array(z.string()).default([]),
        maxOutputBytes: z.coerce.number().int().positive().default(262144),
        commandTimeoutMs: z.coerce.number().int().positive().default(15000),
      })
      .default({}),
    audit: z
      .object({
        enabled: z.boolean().default(true),
        logSuggestedCommands: z.boolean().default(true),
      })
      .default({}),
  })
  .default({ readonly: {}, audit: {} });

const AlertsSchema = z
  .object({
    webhook: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().default('/api/webhook/alertmanager'),
        secret: z.string().optional().default(''),
        autoDiagnose: z.boolean().default(true),
        minSeverity: z.enum(['info', 'warning', 'critical']).default('warning'),
        dedupWindowSeconds: z.coerce.number().int().min(0).default(300),
      })
      .default({}),
    scheduler: z
      .object({
        enabled: z.boolean().default(false),
        scanIntervalMinutes: z.coerce.number().int().positive().default(60),
        dailyReportHour: z.coerce.number().int().min(0).max(23).default(8),
        dailyReportMinute: z.coerce.number().int().min(0).max(59).default(0),
        reportWebhookUrl: z.string().optional().default(''),
      })
      .default({}),
  })
  .default({ webhook: {}, scheduler: {} });

const DiagnosisSchema = z
  .object({
    windowBeforeMinutes: z.coerce.number().int().positive().default(15),
    windowAfterMinutes: z.coerce.number().int().positive().default(15),
    compression: z
      .object({
        enabled: z.boolean().default(true),
        similarityThreshold: z.coerce.number().min(0).max(1).default(0.5),
        maxTemplates: z.coerce.number().int().positive().default(30),
        samplesPerTemplate: z.coerce.number().int().positive().default(3),
        baselineDays: z.coerce.number().int().positive().default(7),
      })
      .default({}),
    levelFilter: z.array(z.string()).default(['ERROR', 'WARN', 'FATAL']),
    maxContextChars: z.coerce.number().int().positive().default(120000),
  })
  .default({});

const MetricsSchema = z
  .object({
    enabled: z.boolean().default(true),
    manualBaselineMinutes: z.coerce.number().positive().default(30),
    exposePrometheus: z.boolean().default(true),
  })
  .default({});

export const AppConfigSchema = z.object({
  server: ServerSchema.default({}),
  database: DatabaseSchema.default({}),
  storage: StorageSchema,
  ai: AiSchema,
  datasources: DatasourcesSchema.default({}),
  services: z.array(ServiceSchema).default([]),
  security: SecuritySchema,
  alerts: AlertsSchema,
  diagnosis: DiagnosisSchema,
  metrics: MetricsSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ServiceDef = z.infer<typeof ServiceSchema>;
export type EsDatasource = z.infer<typeof EsDatasourceSchema>;
export type PrometheusDatasource = z.infer<typeof PrometheusDatasourceSchema>;
export type SshDatasource = z.infer<typeof SshDatasourceSchema>;
export type RedactionRule = z.infer<typeof RedactionRuleSchema>;
export type KnownIssue = z.infer<typeof KnownIssueSchema>;

// ---------------------------------------------------------------------------
// 环境变量插值：把 ${NAME} 替换为 process.env.NAME
// ---------------------------------------------------------------------------

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 递归遍历对象，对字符串值做 ${ENV} 插值。
 *
 * 未设置的环境变量替换为空字符串（而不是保留字面量），
 * 这样 zod 的 optional().default('') 能正常兜底，
 * 避免把 "${DEEPSEEK_API_KEY}" 这种字面量当成真 key 发出去。
 */
function interpolateEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        missing.add(name);
        return '';
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, missing));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnv(v, missing);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

export interface LoadResult {
  config: AppConfig;
  configPath: string;
  missingEnvVars: string[];
  warnings: string[];
}

/** 按优先级寻找配置文件路径。 */
export function resolveConfigPath(explicit?: string): string {
  const candidates: string[] = [];

  if (explicit) candidates.push(explicit);
  if (process.env.AIOPS_CONFIG) candidates.push(process.env.AIOPS_CONFIG);

  const root = process.cwd();
  candidates.push(
    path.join(root, 'config.yaml'),
    path.join(root, 'config.local.yaml'),
    path.join(root, 'config', 'config.yaml'),
    // 容器内约定挂载点
    '/app/config/config.yaml',
  );

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    } catch {
      /* 忽略不可读路径，继续尝试下一个 */
    }
  }

  throw new Error(
    `未找到配置文件。已尝试：\n  ${candidates.join('\n  ')}\n` +
      `请复制 config.example.yaml 为 config.yaml 并填写，` +
      `或用环境变量 AIOPS_CONFIG=/path/to/config.yaml 指定。`,
  );
}

/** 加载并校验配置。校验失败会抛出带具体字段路径的错误。 */
export function loadConfig(explicitPath?: string): LoadResult {
  const configPath = resolveConfigPath(explicitPath);
  const raw = fs.readFileSync(configPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`配置文件 YAML 语法错误（${configPath}）：${(e as Error).message}`);
  }

  const missing = new Set<string>();
  const interpolated = interpolateEnv(parsed, missing) as Record<string, unknown>;

  const result = AppConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const lines = result.error.issues
      .slice(0, 20)
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`配置校验失败（${configPath}）：\n${lines.join('\n')}`);
  }

  const config = result.data;
  const warnings: string[] = [];

  // 引用了但文件里没定义的 provider
  for (const [tier, route] of Object.entries(config.ai.routing)) {
    if (!config.ai.providers[route.provider]) {
      warnings.push(`ai.routing.${tier} 指向未定义的 provider "${route.provider}"`);
    }
  }

  // 服务引用了不存在的数据源
  const esIds = new Set(config.datasources.elasticsearch.map((d) => d.id));
  const sshIds = new Set(config.datasources.ssh.map((d) => d.id));
  for (const svc of config.services) {
    if (svc.datasourceId && !esIds.has(svc.datasourceId)) {
      warnings.push(`服务 ${svc.canonicalName} 引用了不存在的 ES 数据源 "${svc.datasourceId}"`);
    }
    for (const h of svc.deployment.hostIds) {
      if (!sshIds.has(h)) {
        warnings.push(`服务 ${svc.canonicalName} 引用了不存在的 SSH 主机 "${h}"`);
      }
    }
  }

  // 服务重名检查
  const seen = new Map<string, number>();
  for (const svc of config.services) {
    seen.set(svc.canonicalName, (seen.get(svc.canonicalName) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) warnings.push(`服务 ${name} 在配置中重复定义了 ${count} 次`);
  }

  // 安全配置为空时给出警告（只读白名单为空 = SSH 完全不可用，属于安全默认）
  if (config.security.readonly.allowedCommandPrefixes.length === 0) {
    warnings.push('security.readonly.allowedCommandPrefixes 为空，SSH 诊断将被全部拒绝（安全默认）');
  }

  // 脱敏关闭时的合规警告
  if (!config.ai.redaction.enabled) {
    warnings.push('⚠ 数据脱敏已关闭（ai.redaction.enabled=false），日志原文将发送至大模型，请确认合规风险');
  }
  if (config.ai.redaction.enabled && config.ai.redaction.rules.length === 0) {
    warnings.push('脱敏已启用但未配置任何规则，等同于未脱敏');
  }

  // 生产安全提示
  if (!config.server.apiToken) {
    warnings.push('server.apiToken 为空，API 无鉴权。仅建议在隔离内网使用。');
  }

  return { config, configPath, missingEnvVars: [...missing].sort(), warnings };
}

// ---------------------------------------------------------------------------
// 服务注册表查询辅助
// ---------------------------------------------------------------------------

/** 按别名/规范名/模糊匹配解析服务名，返回注册表中的规范定义。 */
export function resolveService(config: AppConfig, input: string): ServiceDef | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;

  // 精确匹配规范名
  for (const s of config.services) {
    if (s.canonicalName.toLowerCase() === q) return s;
  }
  // 精确匹配别名
  for (const s of config.services) {
    if (s.aliases.some((a) => a.toLowerCase() === q)) return s;
  }
  // 包含匹配（规范名或别名）
  for (const s of config.services) {
    if (s.canonicalName.toLowerCase().includes(q)) return s;
    if (s.aliases.some((a) => a.toLowerCase().includes(q))) return s;
  }
  // 反向包含：输入里含有服务名（例如告警文本 "order-service is down"）
  for (const s of config.services) {
    if (q.includes(s.canonicalName.toLowerCase())) return s;
    for (const a of s.aliases) {
      if (a.length >= 4 && q.includes(a.toLowerCase())) return s;
    }
  }
  return null;
}

export function getEsDatasource(config: AppConfig, id: string): EsDatasource | undefined {
  return config.datasources.elasticsearch.find((d) => d.id === id && d.enabled);
}

export function getSshDatasource(config: AppConfig, id: string): SshDatasource | undefined {
  return config.datasources.ssh.find((d) => d.id === id && d.enabled);
}

export function getPrometheusDatasources(config: AppConfig): PrometheusDatasource[] {
  return config.datasources.prometheus.filter((d) => d.enabled);
}
