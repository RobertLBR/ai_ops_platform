/**
 * 诊断流水线编排器 —— 系统心脏。
 *
 * 一期是纯固定流水线（不做自主 Agent）：
 *   ① 解析服务名 + 时间窗
 *   ② 并行只读取证（ES 日志 + Prometheus 指标）
 *   ③ 脱敏（合规闸口）
 *   ④ 压缩（模板提取 → 聚类去重 → 基线对比）
 *   ⑤ 注入架构知识
 *   ⑥ 大模型推理（结构化输出，事实/推断分离）
 *
 * 为什么不做 Agent：排障场景高度模式化（OOM/连接池耗尽/Nacos 拉取失败/
 * 下游超时/磁盘满），对已知模式固定流水线比 Agent 更准也更便宜 ——
 * 领域知识写进代码，而不是指望大模型每次自己想到。
 *
 * 为二期预留：所有数据源访问都抽象成独立方法，二期加 Agent 时
 * 复用同一批 tool，不用重写。
 */

import { AppConfig, ServiceDef, resolveService } from '../config/schema';
import { Database, hashTemplate } from '../storage/database';
import { ElasticsearchSource, normalizeLog } from '../datasources/elasticsearch';
import { PrometheusSource } from '../datasources/prometheus';
import { LlmRouter } from '../ai/llm-router';
import { Redactor } from '../core/redaction';
import { LogClusterer, applyBaseline, selectTopTemplates } from '../core/compression';
import { buildDiagnosisPrompt, sanitizeConclusion } from '../ai/prompts';
import { CommandGuard } from '../datasources/ssh';
import { DiagnosisTask, LogTemplate, MetricSnapshot, NormalizedLog } from '../core/types';
import { logger } from '../utils/logger';

export interface DiagnoseOptions {
  question: string;
  trigger: DiagnosisTask['trigger'];
  /** 显式指定服务名（跳过解析） */
  serviceName?: string;
  /** 显式指定时间窗（ISO） */
  timeFrom?: string;
  timeTo?: string;
  /** 告警原始对象，用于落审计 */
  alertId?: string;
}

export interface DiagnoseResult {
  task: DiagnosisTask;
}

/** 取证 + 脱敏 + 压缩的中间产物（巡检前置闸与完整诊断流水线共用）。 */
export interface CollectedEvidence {
  service: ServiceDef | null;
  timeFrom: string;
  timeTo: string;
  templates: LogTemplate[];
  metrics: MetricSnapshot[];
  rawLogCount: number;
  redactionAudit: { rule: string; count: number }[];
  logError: string | null;
  /** 时间窗内未取到任何日志与指标 */
  empty: boolean;
}

let seq = 0;
function genId(prefix: string): string {
  seq = (seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 合并两组脱敏审计计数（按规则名累加）。 */
function mergeAudit(
  a: { rule: string; count: number }[],
  b: { rule: string; count: number }[],
): { rule: string; count: number }[] {
  const map = new Map<string, number>();
  for (const e of [...a, ...b]) map.set(e.rule, (map.get(e.rule) ?? 0) + e.count);
  return [...map.entries()].map(([rule, count]) => ({ rule, count }));
}

export class DiagnosisEngine {
  private readonly config: AppConfig;
  private readonly db: Database;
  private readonly llm: LlmRouter;
  private readonly redactor: Redactor;
  private readonly esSources = new Map<string, ElasticsearchSource>();
  private readonly promSources: PrometheusSource[] = [];
  /** AI 建议命令的只读白名单校验器（与 SSH 执行侧共用同一份 security 配置） */
  private readonly commandGuard: CommandGuard;

  constructor(config: AppConfig, db: Database, llm: LlmRouter, redactor: Redactor) {
    this.config = config;
    this.db = db;
    this.llm = llm;
    this.redactor = redactor;
    this.commandGuard = new CommandGuard(
      config.security.readonly.allowedCommandPrefixes,
      config.security.readonly.blockedPatterns,
    );

    for (const ds of config.datasources.elasticsearch) {
      if (ds.enabled) this.esSources.set(ds.id, new ElasticsearchSource(ds));
    }
    for (const ds of config.datasources.prometheus) {
      if (ds.enabled) this.promSources.push(new PrometheusSource(ds));
    }

    logger.info('诊断引擎已初始化', {
      esSources: [...this.esSources.keys()],
      promSources: this.promSources.length,
      services: config.services.length,
    });
  }

  /** 健康状态：供 /api/health 展示数据源可达性。 */
  async datasourceHealth(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { elasticsearch: {}, prometheus: {} };
    const es = out.elasticsearch as Record<string, unknown>;
    const prom = out.prometheus as Record<string, unknown>;

    await Promise.all([
      ...[...this.esSources.entries()].map(async ([id, src]) => {
        es[id] = await src.health();
      }),
      ...this.promSources.map(async (src) => {
        prom[src.id] = await src.health();
      }),
    ]);
    return out;
  }

  /**
   * 执行一次完整诊断。这是主入口。
   * 任何一步失败都会把任务标为 failed 并记录原因，不抛出到调用方（避免 API 500）。
   */
  async diagnose(opts: DiagnoseOptions): Promise<DiagnoseResult> {
    const startedAt = Date.now();
    const nowIso = new Date().toISOString();

    // 提问内容落库前先脱敏（合规闸口），审计计数随后并入任务级 redactionAudit
    const qRedact = this.redactor.redact(opts.question);

    const task: DiagnosisTask = {
      id: genId('diag'),
      status: 'pending',
      trigger: opts.trigger,
      question: qRedact.text,
      serviceName: null,
      timeFrom: null,
      timeTo: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      durationMs: null,
      error: null,
      logTemplates: null,
      metrics: null,
      conclusion: null,
      redactionAudit: null,
      tokensUsed: null,
      feedback: null,
    };
    this.db.insertTask(task);

    try {
      // --- ① 解析服务与时间窗 ---
      const service = opts.serviceName
        ? resolveService(this.config, opts.serviceName)
        : resolveService(this.config, opts.question);

      if (service) {
        task.serviceName = service.canonicalName;
      } else {
        logger.warn('未能从输入解析出注册服务，将做全服务粗查', { question: opts.question.slice(0, 120) });
      }

      const { from, to } = this.resolveTimeWindow(opts.timeFrom, opts.timeTo);
      task.timeFrom = from;
      task.timeTo = to;

      this.db.updateTask(task.id, { status: 'collecting', serviceName: task.serviceName, timeFrom: from, timeTo: to });
      task.status = 'collecting';

      this.audit('diagnosis.start', {
        taskId: task.id,
        trigger: opts.trigger,
        service: task.serviceName,
        alertId: opts.alertId ?? null,
      });

      // --- ②③④ 取证 → 脱敏 → 压缩（与巡检前置闸共用的中间步骤）---
      const ev = await this.collectAndCompress(service, from, to);

      if (ev.empty) {
        throw new Error(
          `取证为空：时间窗 ${from} ~ ${to} 内未查到任何日志或指标。` +
            (ev.logError ? ` ES 错误：${ev.logError}` : '') +
            (service ? '' : ' 另外未能识别服务名，请检查 config.yaml 的 services 配置与别名。'),
        );
      }

      this.db.updateTask(task.id, { status: 'analyzing' });
      task.status = 'analyzing';

      const templates = ev.templates;
      const metrics = ev.metrics;
      const rawLogCount = ev.rawLogCount;
      // 合并日志脱敏与提问脱敏的审计计数
      const redactedAudit = mergeAudit(ev.redactionAudit, qRedact.audit);

      // --- ⑤⑥ 注入知识 + 大模型推理 ---
      const similarCases = this.db
        .findSimilarCases(templates.map((t) => hashTemplate(t.template)).slice(0, 20), service?.canonicalName)
        .map((c) => ({
          title: String(c.title ?? ''),
          rootCause: String(c.root_cause ?? ''),
          resolution: String(c.resolution ?? ''),
        }));

      const { system, user } = buildDiagnosisPrompt({
        question: qRedact.text,
        service,
        templates,
        metrics,
        config: this.config,
        timeFrom: from,
        timeTo: to,
        similarCases,
      });

      const { data, usage } = await this.llm.chatJson<unknown>('reasoning', [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);

      // 每次模型调用留痕（合规证据）。只记 token 与字符数，绝不记录 prompt 内容。
      this.audit('llm.call', {
        taskId: task.id,
        tier: 'reasoning',
        model: usage.model,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        // 送入字符数（非内容）：证明日志压缩层确实压低了送入量
        promptChars: system.length + user.length,
      });

      const conclusion = sanitizeConclusion(data);

      // --- 建议命令过只读白名单校验：保留展示，但逐条标注 allowed 结果 ---
      const commandChecks = conclusion.suggested_commands.map((cmd) => {
        const reason = this.commandGuard.check(cmd);
        return { command: cmd, allowed: reason === null, reason };
      });
      conclusion.suggested_commands_guard = commandChecks;
      conclusion.suggested_commands = commandChecks.map((c) =>
        c.allowed ? c.command : `${c.command}    # ⚠ 未通过只读白名单校验，禁止执行`,
      );
      const blockedCommands = commandChecks.filter((c) => !c.allowed);
      if (blockedCommands.length) {
        logger.warn('AI 建议命令未通过只读白名单校验，已标注禁止执行', {
          taskId: task.id,
          blocked: blockedCommands.map((c) => c.command.slice(0, 120)),
        });
      }

      // --- 落库（含成果度量字段）---
      const durationMs = Date.now() - startedAt;
      this.db.updateTask(task.id, {
        status: 'done',
        durationMs,
        logTemplates: templates,
        metrics,
        conclusion,
        redactionAudit: redactedAudit,
        tokensUsed: { prompt: usage.prompt, completion: usage.completion, model: usage.model },
      });

      Object.assign(task, {
        status: 'done' as const,
        durationMs,
        logTemplates: templates,
        metrics,
        conclusion,
        redactionAudit: redactedAudit,
        tokensUsed: { prompt: usage.prompt, completion: usage.completion, model: usage.model },
      });

      // 回写基线（供后续识别新模板与频率突增）
      this.recordBaseline(service?.canonicalName ?? '_unknown', templates);

      this.audit('diagnosis.done', {
        taskId: task.id,
        durationMs,
        templateCount: templates.length,
        rawLogCount,
        totalTokens: usage.total,
        redacted: redactedAudit.reduce((s, a) => s + a.count, 0),
        severity: conclusion.severity,
      });

      logger.info('诊断完成', {
        taskId: task.id,
        service: task.serviceName,
        durationMs,
        rawLogCount,
        templateCount: templates.length,
        tokens: usage.total,
      });

      return { task };
    } catch (e) {
      const err = (e as Error).message || String(e);
      const durationMs = Date.now() - startedAt;
      this.db.updateTask(task.id, { status: 'failed', error: err, durationMs });
      task.status = 'failed';
      task.error = err;
      task.durationMs = durationMs;

      this.audit('diagnosis.failed', { taskId: task.id, error: err.slice(0, 500) });
      logger.error('诊断失败', { taskId: task.id, error: err });

      return { task };
    }
  }

  /**
   * 取证 + 脱敏 + 压缩的中间步骤。
   *
   * 从 diagnose() 中抽取复用：定时巡检的前置闸用它做"免费"异常初筛，
   * 满足跳过条件时不再进入 LLM 推理（省 token）；完整诊断流水线
   * 走同一入口，行为与原先一致。
   */
  async collectAndCompress(service: ServiceDef | null, timeFrom?: string, timeTo?: string): Promise<CollectedEvidence> {
    const { from, to } = this.resolveTimeWindow(timeFrom, timeTo);

    // --- ② 并行只读取证 ---
    const [logs, logError, metrics] = await this.collectEvidence(service, from, to);
    if (logError) {
      logger.warn('日志取证部分失败', { error: logError });
    }

    const empty = logs.length === 0 && metrics.length === 0;

    // --- ③ 脱敏（合规闸口，必须在压缩与送入模型之前）---
    const redacted = this.redactLogs(logs);

    // --- ④ 压缩 ---
    const { templates, rawLogCount } = this.compress(redacted.logs, service, redacted.audit);

    return {
      service,
      timeFrom: from,
      timeTo: to,
      templates,
      metrics,
      rawLogCount,
      redactionAudit: redacted.audit,
      logError,
      empty,
    };
  }

  // -------------------------------------------------------------------------
  // ② 取证
  // -------------------------------------------------------------------------

  private resolveTimeWindow(explicitFrom?: string, explicitTo?: string): { from: string; to: string } {
    if (explicitFrom && explicitTo) {
      return { from: new Date(explicitFrom).toISOString(), to: new Date(explicitTo).toISOString() };
    }
    // 默认：现在往前推 windowBefore + windowAfter
    const before = this.config.diagnosis.windowBeforeMinutes;
    const after = this.config.diagnosis.windowAfterMinutes;
    const now = Date.now();
    return {
      from: new Date(now - before * 60000).toISOString(),
      to: new Date(now + after * 60000).toISOString(),
    };
  }

  private async collectEvidence(
    service: ServiceDef | null,
    from: string,
    to: string,
  ): Promise<[NormalizedLog[], string | null, MetricSnapshot[]]> {
    const levels = this.config.diagnosis.levelFilter;

    // 服务未识别时，退化为查所有已启用 ES 源的所有索引
    const targets: { src: ElasticsearchSource; svc: ServiceDef }[] = [];
    if (service) {
      const srcId = service.datasourceId || this.config.datasources.elasticsearch.find((d) => d.enabled)?.id;
      const src = srcId ? this.esSources.get(srcId) : undefined;
      if (src) targets.push({ src, svc: service });
    } else {
      const fallbackSvc = this.config.services[0];
      if (fallbackSvc) {
        for (const [id, src] of this.esSources) {
          void id;
          targets.push({ src, svc: fallbackSvc });
        }
      }
    }

    let logs: NormalizedLog[] = [];
    let logError: string | null = null;

    const logResults = await Promise.allSettled(
      targets.map(async ({ src, svc }) => {
        const hits = await src.searchLogs({ service: svc, from, to, levels, maxDocs: undefined });
        return hits.map((h) => normalizeLog(h, svc));
      }),
    );

    for (const r of logResults) {
      if (r.status === 'fulfilled') logs = logs.concat(r.value);
      else logError = (logError ? logError + '; ' : '') + (r.reason as Error).message;
    }

    // 指标（服务已识别时才查，避免无意义的 .* 匹配）
    let metrics: MetricSnapshot[] = [];
    if (service && this.promSources.length) {
      const promResults = await Promise.allSettled(
        this.promSources.map((p) => p.collectForService(service, to)),
      );
      for (const r of promResults) {
        if (r.status === 'fulfilled') metrics = metrics.concat(r.value);
      }
    }

    // 按时间升序（因果分析需要时序）
    logs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

    return [logs, logError, metrics];
  }

  // -------------------------------------------------------------------------
  // ③ 脱敏
  // -------------------------------------------------------------------------

  private redactLogs(logs: NormalizedLog[]): { logs: NormalizedLog[]; audit: { rule: string; count: number }[] } {
    if (!this.redactor.isEnabled || logs.length === 0) {
      return { logs, audit: [] };
    }

    const auditMap = new Map<string, number>();
    let total = 0;
    const out = logs.map((l) => {
      const r = this.redactor.redact(l.message);
      total += r.totalRedacted;
      for (const a of r.audit) auditMap.set(a.rule, (auditMap.get(a.rule) ?? 0) + a.count);
      return { ...l, message: r.text };
    });

    const audit = [...auditMap.entries()].map(([rule, count]) => ({ rule, count }));
    if (total > 0) {
      logger.info('脱敏完成', { logCount: logs.length, redacted: total, rules: audit.map((a) => `${a.rule}:${a.count}`) });
    }
    return { logs: out, audit };
  }

  // -------------------------------------------------------------------------
  // ④ 压缩
  // -------------------------------------------------------------------------

  private compress(
    logs: NormalizedLog[],
    service: ServiceDef | null,
    _audit: { rule: string; count: number }[],
  ): { templates: LogTemplate[]; rawLogCount: number } {
    const cfg = this.config.diagnosis.compression;

    if (!cfg.enabled) {
      // 不做模板提取：直接按消息去重（日志量小时的最简路径）
      const seen = new Map<string, LogTemplate>();
      for (const l of logs) {
        const key = l.message.slice(0, 300);
        const existing = seen.get(key);
        if (existing) {
          existing.count++;
          if (l.timestamp > existing.lastSeen) existing.lastSeen = l.timestamp;
        } else {
          seen.set(key, {
            id: `raw_${seen.size}`,
            template: key,
            count: 1,
            firstSeen: l.timestamp,
            lastSeen: l.timestamp,
            samples: [key],
            levels: [l.level],
          });
        }
      }
      const arr = [...seen.values()].sort((a, b) => b.count - a.count);
      return { templates: selectTopTemplates(arr, cfg.maxTemplates), rawLogCount: logs.length };
    }

    const clusterer = new LogClusterer(cfg.similarityThreshold, cfg.samplesPerTemplate);
    clusterer.addMany(logs);

    let templates = clusterer.exportTemplates(service?.knownIssues ?? []);

    // 基线对比：识别"全新模式"与"频率突增"
    const serviceName = service?.canonicalName ?? '_unknown';
    const baseline = this.db.getBaseline(serviceName, cfg.baselineDays);
    const hashed = new Map<string, string>();
    for (const t of templates) hashed.set(hashTemplate(t.template), t.template);
    const baselineByTemplate = new Map<string, number>();
    for (const [hash, tpl] of hashed) {
      const b = baseline.get(hash);
      if (b !== undefined) baselineByTemplate.set(tpl, b);
    }
    templates = applyBaseline(templates, baselineByTemplate.size ? baselineByTemplate : null);

    templates = selectTopTemplates(templates, cfg.maxTemplates);

    logger.info('日志压缩完成', {
      rawLogCount: logs.length,
      templateCount: clusterer.templateCount,
      selectedCount: templates.length,
      newPatterns: templates.filter((t) => t.isNew).length,
    });

    return { templates, rawLogCount: logs.length };
  }

  /** 回写模板频率基线（公开：巡检跳过 LLM 时也要持续累积"正常频率"基线）。 */
  recordBaseline(serviceName: string, templates: LogTemplate[]): void {
    const day = new Date().toISOString().slice(0, 10);
    for (const t of templates) {
      this.db.upsertBaseline(serviceName, hashTemplate(t.template), day, t.count);
    }
  }

  // -------------------------------------------------------------------------
  // 审计
  // -------------------------------------------------------------------------

  private audit(action: string, detail: Record<string, unknown>): void {
    if (!this.config.security.audit.enabled) return;
    this.db.insertAudit({
      id: genId('aud'),
      at: new Date().toISOString(),
      actor: 'system',
      action,
      target: String(detail.taskId ?? ''),
      detail,
    });
  }
}
