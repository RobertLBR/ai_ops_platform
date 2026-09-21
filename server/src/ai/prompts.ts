/**
 * Prompt 构建器。
 *
 * 两条铁律：
 *   1. 事实与推断强制分离。运维场景最危险的不是模型不会答，
 *      而是它把推测说得像已确认的事实 —— 你会照着错的结论去重启服务。
 *   2. 要求模型主动声明 data_gaps（查不到什么）。
 *      让 AI 说"我不知道"比让它硬猜有价值得多。
 *
 * 上下文组织原则：只喂压缩后的模板 + 代表样本 + 架构知识，绝不喂原始日志海洋。
 */

import { AppConfig, ServiceDef } from '../config/schema';
import { DiagnosisConclusion, LogTemplate, MetricSnapshot } from '../core/types';

const SYSTEM_PROMPT = `你是一名资深运维专家（SRE），负责分析生产环境的日志与监控指标，定位故障根因。

你必须严格遵守以下规则：

1. 【事实与推断分离】这是最高优先级要求。
   - confirmed_facts：只能写日志/指标中**直接可验证**的内容，必须能对应到具体证据（时间点、数值、异常类名）。
   - inferences：你的推理和假设。每条推断都要说明依据和不确定性。
   - 绝对禁止把推断写进 confirmed_facts。宁可 confirmed_facts 少写，也不能混入猜测。

2. 【主动声明盲区】data_gaps 必须填写你无法获取但对定位很重要的信息。
   例如：拿不到数据库侧慢查询日志、没有链路追踪、看不到 JVM 启动参数等。
   诚实说明盲区，比编造完整结论更有价值。

3. 【根因候选要给排序和置信度】root_cause_candidates 按可能性排序，
   每条给出 confidence(high/medium/low) 和 evidence(支撑该判断的具体证据)。
   如果证据不足以判断，confidence 必须给 low。

4. 【时序优先】判断根因时，"谁先发生"比"谁报错最多"更重要。
   报错最吵的服务往往是受害者而不是元凶。请依据 firstSeen 时间排序分析因果。

5. 【只读边界】suggested_commands 里只允许写**只读诊断命令**
   （如 docker logs / docker stats / ss -s / cat 配置 / 查询 SQL 执行计划）。
   绝对不要写重启、kill、删除、修改配置类的命令。
   这些命令只是给人看的建议，系统不会自动执行。

6. 【利用架构知识】上下文中会给出该服务的依赖关系与已知问题 SOP。
   如果日志匹配某个已知问题模式，请在 checklist 中引用对应 SOP 步骤。

7. 【不要编造】如果上下文信息不足以定位根因，直接在 summary 里说明
   "现有信息不足以确定根因"，并在 data_gaps 里列出还需要什么。
   不要为了让答案看起来完整而编造细节。

输出必须是合法 JSON，不要包含 markdown 代码块标记。`;

export const CONCLUSION_SCHEMA_HINT = `{
  "summary": "一句话结论（不超过 100 字）",
  "severity": "info | warning | critical | unknown",
  "confirmed_facts": ["带时间点/数值/异常类名的可验证事实"],
  "inferences": ["推断，需说明依据和不确定性"],
  "root_cause_candidates": [
    { "rank": 1, "target": "疑似根因对象", "confidence": "high|medium|low", "evidence": "支撑证据" }
  ],
  "checklist": ["建议人工检查项，按优先级排序"],
  "suggested_commands": ["只读诊断命令"],
  "data_gaps": ["缺失但对定位重要的信息"]
}`;

/** 把服务架构知识渲染成紧凑文本（控制 token）。 */
export function renderArchKnowledge(service: ServiceDef | null, config: AppConfig): string {
  if (!service) {
    const names = config.services.slice(0, 20).map((s) => s.canonicalName).join(', ');
    return `未能识别具体服务。已注册服务列表：${names || '(空)'}`;
  }

  const lines: string[] = [];
  lines.push(`服务: ${service.canonicalName}${service.displayName ? ` (${service.displayName})` : ''}`);
  lines.push(`重要性: ${service.tier}`);
  if (service.stack) lines.push(`技术栈: ${service.stack}`);

  const d = service.deployment;
  if (d.containerNames?.length) lines.push(`容器: ${d.containerNames.join(', ')}`);
  if (d.hostIds?.length) lines.push(`部署主机: ${d.hostIds.join(', ')}`);
  if (d.port) lines.push(`端口: ${d.port}`);
  if (d.jenkinsJob) lines.push(`Jenkins 任务: ${d.jenkinsJob}`);

  if (service.dependsOn.length) lines.push(`依赖(下游): ${service.dependsOn.join(', ')}`);
  if (service.dependedBy.length) lines.push(`被依赖(上游调用方): ${service.dependedBy.join(', ')}`);

  if (service.knownIssues.length) {
    lines.push('');
    lines.push('已知问题与处置 SOP:');
    for (const ki of service.knownIssues.slice(0, 8)) {
      lines.push(`- [${ki.severity}] ${ki.category}｜匹配模式: ${ki.pattern}`);
      if (ki.cause) lines.push(`  原因: ${ki.cause}`);
      if (ki.sop) lines.push(`  SOP: ${ki.sop.replace(/\n\s*/g, ' / ').slice(0, 400)}`);
    }
  }

  return lines.join('\n');
}

/** 渲染压缩后的日志模板（这是喂给模型的核心证据）。 */
export function renderTemplates(templates: LogTemplate[], maxChars: number): string {
  const lines: string[] = [];
  for (const t of templates) {
    const flags: string[] = [];
    if (t.isNew) flags.push('全新模式');
    if (t.knownIssue) flags.push(`已知问题:${t.knownIssue.category}`);
    if (t.baselineCount !== undefined && t.baselineCount !== null && t.baselineCount > 0) {
      const ratio = t.count / t.baselineCount;
      if (ratio > 3) flags.push(`频率突增${ratio.toFixed(1)}倍(基线${t.baselineCount})`);
    }

    lines.push(
      `[${t.levels.join('/')}] 出现${t.count}次 ${t.firstSeen.slice(11, 19)}~${t.lastSeen.slice(11, 19)}` +
        (flags.length ? ` ⚑${flags.join(',')}` : ''),
    );
    lines.push(`  模板: ${t.template.slice(0, 500)}`);
    for (const s of t.samples.slice(0, 2)) {
      lines.push(`  样本: ${s.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    if (t.knownIssue?.sop) {
      lines.push(`  处置SOP: ${t.knownIssue.sop.replace(/\n\s*/g, ' / ').slice(0, 300)}`);
    }
    lines.push('');
  }

  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n...(已截断，共 ${templates.length} 个模板)`;
  }
  return out;
}

/** 渲染指标快照。 */
export function renderMetrics(metrics: MetricSnapshot[]): string {
  if (!metrics.length) return '(未采集到指标数据)';
  const lines: string[] = [];
  for (const m of metrics) {
    if (m.error) {
      lines.push(`${m.name}: 查询失败 - ${m.error.slice(0, 120)}`);
      continue;
    }
    const vs = m.values
      .slice(0, 8)
      .map((v) => {
        const label = Object.entries(v.labels)
          .filter(([k]) => ['instance', 'name', 'device', 'mountpoint', 'application'].includes(k))
          .map(([k, val]) => `${k}=${val}`)
          .join(',');
        return `${label || '-'}: ${formatNum(v.value)}`;
      })
      .join(' | ');
    lines.push(`${m.name}: ${vs}`);
  }
  return lines.join('\n');
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export interface BuildPromptInput {
  question: string;
  service: ServiceDef | null;
  templates: LogTemplate[];
  metrics: MetricSnapshot[];
  config: AppConfig;
  timeFrom: string;
  timeTo: string;
  /** 相似历史案例（二期启用） */
  similarCases?: { title: string; rootCause: string; resolution: string }[];
}

/** 构建诊断 prompt。 */
export function buildDiagnosisPrompt(input: BuildPromptInput): { system: string; user: string } {
  const { question, service, templates, metrics, config, timeFrom, timeTo } = input;

  const maxChars = Math.min(config.diagnosis.maxContextChars, 100000);

  const parts: string[] = [];
  parts.push(`# 诊断请求`);
  parts.push(`用户输入/告警内容: ${question.slice(0, 2000)}`);
  parts.push(`取证时间窗: ${timeFrom} ~ ${timeTo}`);
  parts.push('');
  parts.push(`# 服务架构知识`);
  parts.push(renderArchKnowledge(service, config));
  parts.push('');
  parts.push(`# 日志证据（已做模板提取与聚类去重）`);
  parts.push(`共 ${templates.length} 个模板（由原始日志压缩而来），按关注度排序:`);
  parts.push(renderTemplates(templates, maxChars));
  parts.push('');
  parts.push(`# 监控指标`);
  parts.push(renderMetrics(metrics));

  if (input.similarCases?.length) {
    parts.push('');
    parts.push(`# 相似历史案例（供参考，注意版本与环境可能不同）`);
    for (const c of input.similarCases.slice(0, 3)) {
      parts.push(`- ${c.title}｜根因: ${c.rootCause}｜处置: ${c.resolution.slice(0, 200)}`);
    }
  }

  parts.push('');
  parts.push(`# 输出要求`);
  parts.push(`严格按以下 JSON schema 输出，不要有任何额外文本:`);
  parts.push(CONCLUSION_SCHEMA_HINT);

  return { system: SYSTEM_PROMPT, user: parts.join('\n') };
}

/** 校验模型返回的结论结构，补齐缺失字段（防止前端渲染崩溃）。 */
export function sanitizeConclusion(raw: unknown): DiagnosisConclusion {
  const o = (raw ?? {}) as Record<string, unknown>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : [];

  const candidates = Array.isArray(o.root_cause_candidates)
    ? o.root_cause_candidates.map((c, i) => {
        const cc = (c ?? {}) as Record<string, unknown>;
        const conf = String(cc.confidence ?? 'low').toLowerCase();
        return {
          rank: Number(cc.rank ?? i + 1),
          target: String(cc.target ?? '未指明'),
          confidence: (['high', 'medium', 'low'].includes(conf) ? conf : 'low') as 'high' | 'medium' | 'low',
          evidence: String(cc.evidence ?? ''),
        };
      })
    : [];

  const sev = String(o.severity ?? 'unknown').toLowerCase();

  return {
    summary: String(o.summary ?? '(模型未返回结论摘要)'),
    severity: (['info', 'warning', 'critical', 'unknown'].includes(sev) ? sev : 'unknown') as DiagnosisConclusion['severity'],
    confirmed_facts: strArr(o.confirmed_facts),
    inferences: strArr(o.inferences),
    root_cause_candidates: candidates,
    checklist: strArr(o.checklist),
    suggested_commands: strArr(o.suggested_commands),
    data_gaps: strArr(o.data_gaps),
  };
}
