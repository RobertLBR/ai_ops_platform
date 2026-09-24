/**
 * SQLite 持久化层（node:sqlite，零原生依赖）。
 *
 * 存四类数据：
 *   1. 诊断任务（含中间产物与结论）
 *   2. 告警记录
 *   3. 成果度量（谈判弹药 —— 从第一天起内建，不能事后补）
 *   4. 审计日志（只读边界的证据）
 *
 * 为什么选 node:sqlite：Node 22.5+ 内置，无需编译原生模块，
 * Docker 镜像可以做到极简且跨架构（amd64/arm64）构建都不会挂。
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { DiagnosisTask, InboundAlert, AuditEntry, AiConfigGeneration } from '../core/types';
import { logger } from '../utils/logger';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS diagnosis_tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  question TEXT NOT NULL,
  service_name TEXT,
  time_from TEXT,
  time_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  log_templates TEXT,
  metrics TEXT,
  conclusion TEXT,
  redaction_audit TEXT,
  tokens_used TEXT,
  feedback TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_created ON diagnosis_tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON diagnosis_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_service ON diagnosis_tasks(service_name);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  service TEXT,
  title TEXT NOT NULL,
  description TEXT,
  fired_at TEXT,
  received_at TEXT NOT NULL,
  raw TEXT,
  diagnosis_id TEXT,
  deduped INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alerts_received ON alerts(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_service ON alerts(service);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

-- 日志模板基线：统计"正常频率"，用于识别新模板与频率突增
CREATE TABLE IF NOT EXISTS template_baseline (
  service_name TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_name, template_hash, day)
);

-- 故障案例库（二期：越用越准）
CREATE TABLE IF NOT EXISTS fault_cases (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  service_name TEXT,
  title TEXT NOT NULL,
  symptoms TEXT,
  root_cause TEXT,
  resolution TEXT,
  template_hashes TEXT,
  valid_until TEXT,
  owner TEXT,
  source_task_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_cases_service ON fault_cases(service_name);

-- AI 配置生成记录（「这个配置为什么会变成这样」的完整证据链）
CREATE TABLE IF NOT EXISTS ai_config_generations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL,
  log_sample TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  model TEXT,
  ai_raw_output TEXT,
  draft_json TEXT,
  user_edits_diff TEXT,
  final_json TEXT,
  validation TEXT,
  tokens_used TEXT
);

CREATE INDEX IF NOT EXISTS idx_aiconfig_service ON ai_config_generations(service_name);
CREATE INDEX IF NOT EXISTS idx_aiconfig_created ON ai_config_generations(created_at DESC);
`;

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info('已创建数据目录', { dir });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    logger.info('数据库已就绪', { path: dbPath });
  }

  // -------------------------------------------------------------------------
  // 诊断任务
  // -------------------------------------------------------------------------

  insertTask(t: DiagnosisTask): void {
    this.db
      .prepare(
        `INSERT INTO diagnosis_tasks
         (id, status, trigger, question, service_name, time_from, time_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.status, t.trigger, t.question, t.serviceName, t.timeFrom, t.timeTo, t.createdAt, t.updatedAt);
  }

  updateTask(
    id: string,
    patch: Partial<Pick<DiagnosisTask,
      'status' | 'serviceName' | 'timeFrom' | 'timeTo' | 'durationMs' | 'error' |
      'logTemplates' | 'metrics' | 'conclusion' | 'redactionAudit' | 'tokensUsed' | 'feedback'
    >>,
  ): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const json = new Set(['logTemplates', 'metrics', 'conclusion', 'redactionAudit', 'tokensUsed', 'feedback']);

    const colMap: Record<string, string> = {
      status: 'status',
      serviceName: 'service_name',
      timeFrom: 'time_from',
      timeTo: 'time_to',
      durationMs: 'duration_ms',
      error: 'error',
      logTemplates: 'log_templates',
      metrics: 'metrics',
      conclusion: 'conclusion',
      redactionAudit: 'redaction_audit',
      tokensUsed: 'tokens_used',
      feedback: 'feedback',
    };

    for (const [k, v] of Object.entries(patch)) {
      const col = colMap[k];
      if (!col) continue;
      cols.push(`${col} = ?`);
      vals.push(json.has(k) && v !== null && v !== undefined ? JSON.stringify(v) : (v as string | number | null));
    }
    if (cols.length === 0) return;

    cols.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);

    this.db.prepare(`UPDATE diagnosis_tasks SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  }

  private rowToTask(row: Record<string, unknown>): DiagnosisTask {
    const parse = <T>(v: unknown): T | null => {
      if (v === null || v === undefined || v === '') return null;
      try {
        return JSON.parse(String(v)) as T;
      } catch {
        return null;
      }
    };
    return {
      id: String(row.id),
      status: row.status as DiagnosisTask['status'],
      trigger: row.trigger as DiagnosisTask['trigger'],
      question: String(row.question ?? ''),
      serviceName: (row.service_name as string) ?? null,
      timeFrom: (row.time_from as string) ?? null,
      timeTo: (row.time_to as string) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      durationMs: (row.duration_ms as number) ?? null,
      error: (row.error as string) ?? null,
      logTemplates: parse(row.log_templates),
      metrics: parse(row.metrics),
      conclusion: parse(row.conclusion),
      redactionAudit: parse(row.redaction_audit),
      tokensUsed: parse(row.tokens_used),
      feedback: parse(row.feedback),
    };
  }

  getTask(id: string): DiagnosisTask | null {
    const row = this.db.prepare('SELECT * FROM diagnosis_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(limit = 50, offset = 0, filter?: { status?: string; serviceName?: string }): { items: DiagnosisTask[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter?.serviceName) {
      where.push('service_name = ?');
      args.push(filter.serviceName);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (this.db.prepare(`SELECT COUNT(*) c FROM diagnosis_tasks ${whereSql}`).get(...(args as never[])) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM diagnosis_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...(args as never[]), limit, offset) as Record<string, unknown>[];

    return { items: rows.map((r) => this.rowToTask(r)), total };
  }

  // -------------------------------------------------------------------------
  // 告警
  // -------------------------------------------------------------------------

  insertAlert(a: InboundAlert): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO alerts
         (id, source, severity, status, service, title, description, fired_at, received_at, raw, diagnosis_id, deduped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.source, a.severity, a.status, a.service, a.title, a.description ?? '',
        a.firedAt, a.receivedAt, JSON.stringify(a.raw ?? {}), a.diagnosisId ?? null, a.deduped ? 1 : 0,
      );
  }

  listAlerts(limit = 50): InboundAlert[] {
    const rows = this.db
      .prepare('SELECT * FROM alerts ORDER BY received_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      source: r.source as InboundAlert['source'],
      severity: r.severity as InboundAlert['severity'],
      status: r.status as InboundAlert['status'],
      service: (r.service as string) ?? null,
      title: String(r.title ?? ''),
      description: String(r.description ?? ''),
      firedAt: String(r.fired_at ?? ''),
      receivedAt: String(r.received_at),
      raw: (() => { try { return JSON.parse(String(r.raw ?? '{}')); } catch { return {}; } })(),
      diagnosisId: (r.diagnosis_id as string) ?? null,
      deduped: Number(r.deduped) === 1,
    }));
  }

  /** 降噪窗口：查最近 N 秒内是否已有同服务的告警 */
  hasRecentAlert(service: string | null, withinSeconds: number): boolean {
    if (!service || withinSeconds <= 0) return false;
    const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
    const row = this.db
      .prepare('SELECT COUNT(*) c FROM alerts WHERE service = ? AND received_at > ? AND deduped = 0')
      .get(service, since) as { c: number };
    return (row?.c ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // 审计
  // -------------------------------------------------------------------------

  insertAudit(e: AuditEntry): void {
    this.db
      .prepare('INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.id, e.at, e.actor, e.action, e.target, JSON.stringify(e.detail ?? {}));
  }

  listAudit(limit = 100): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      target: String(r.target ?? ''),
      detail: (() => { try { return JSON.parse(String(r.detail ?? '{}')); } catch { return {}; } })(),
    }));
  }

  // -------------------------------------------------------------------------
  // 模板基线
  // -------------------------------------------------------------------------

  upsertBaseline(serviceName: string, templateHash: string, day: string, count: number): void {
    this.db
      .prepare(
        `INSERT INTO template_baseline (service_name, template_hash, day, count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(service_name, template_hash, day) DO UPDATE SET count = count + excluded.count`,
      )
      .run(serviceName, templateHash, day, count);
  }

  /** 取过去 N 天的模板平均出现次数，作为基线。 */
  getBaseline(serviceName: string, days: number): Map<string, number> {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT template_hash, AVG(count) avg_count, COUNT(DISTINCT day) day_count
         FROM template_baseline
         WHERE service_name = ? AND day >= ? AND day < ?
         GROUP BY template_hash`,
      )
      .all(serviceName, since, new Date().toISOString().slice(0, 10)) as { template_hash: string; avg_count: number; day_count: number }[];

    const out = new Map<string, number>();
    for (const r of rows) {
      // 至少 2 天数据才算可信基线
      if ((r.day_count ?? 0) >= 2) out.set(r.template_hash, Math.round(r.avg_count));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 成果度量（谈判弹药）
  // -------------------------------------------------------------------------

  /** 汇总核心指标：这些数字就是"为什么值 2.65 万/月"的证据。 */
  getMetricsSummary(manualBaselineMinutes: number): Record<string, unknown> {
    const one = <T>(sql: string, ...args: unknown[]): T =>
      this.db.prepare(sql).get(...(args as never[])) as T;

    const total = one<{ c: number }>('SELECT COUNT(*) c FROM diagnosis_tasks').c ?? 0;
    const done = one<{ c: number }>("SELECT COUNT(*) c FROM diagnosis_tasks WHERE status = 'done'").c ?? 0;
    const failed = one<{ c: number }>("SELECT COUNT(*) c FROM diagnosis_tasks WHERE status = 'failed'").c ?? 0;

    const fb = one<{ correct: number; partial: number; wrong: number }>(`
      SELECT
        SUM(CASE WHEN json_extract(feedback,'$.verdict') = 'correct' THEN 1 ELSE 0 END) correct,
        SUM(CASE WHEN json_extract(feedback,'$.verdict') = 'partial'  THEN 1 ELSE 0 END) partial,
        SUM(CASE WHEN json_extract(feedback,'$.verdict') = 'wrong'    THEN 1 ELSE 0 END) wrong
      FROM diagnosis_tasks WHERE feedback IS NOT NULL AND feedback != ''
    `);

    const avgDuration = one<{ avg_ms: number }>(
      'SELECT AVG(duration_ms) avg_ms FROM diagnosis_tasks WHERE duration_ms IS NOT NULL AND duration_ms > 0',
    ).avg_ms;

    const tokens = one<{ prompt: number; completion: number }>(`
      SELECT
        SUM(COALESCE(json_extract(tokens_used,'$.prompt'),0)) prompt,
        SUM(COALESCE(json_extract(tokens_used,'$.completion'),0)) completion
      FROM diagnosis_tasks WHERE tokens_used IS NOT NULL AND tokens_used != ''
    `);

    const alertTotal = one<{ c: number }>('SELECT COUNT(*) c FROM alerts').c ?? 0;
    const alertDeduped = one<{ c: number }>('SELECT COUNT(*) c FROM alerts WHERE deduped = 1').c ?? 0;
    const caseCount = one<{ c: number }>('SELECT COUNT(*) c FROM fault_cases').c ?? 0;

    const correct = fb.correct ?? 0;
    const partial = fb.partial ?? 0;
    const wrong = fb.wrong ?? 0;
    const fbTotal = correct + partial + wrong;

    const avgMinutes = avgDuration ? avgDuration / 60000 : null;
    // 节省工时 = 处理次数 × (人工基线 - AI 实际耗时)
    const savedMinutes = avgMinutes !== null ? Math.max(0, (manualBaselineMinutes - avgMinutes) * done) : null;

    return {
      tasks: { total, done, failed, pending: total - done - failed },
      accuracy: {
        feedbackCount: fbTotal,
        correct,
        partial,
        wrong,
        // 完全正确 + 部分正确都算"有用"，这是更公允的口径
        usefulRate: fbTotal > 0 ? Number((((correct + partial) / fbTotal) * 100).toFixed(1)) : null,
        correctRate: fbTotal > 0 ? Number(((correct / fbTotal) * 100).toFixed(1)) : null,
      },
      speed: {
        avgDurationMs: avgDuration ? Math.round(avgDuration) : null,
        avgDurationMinutes: avgMinutes !== null ? Number(avgMinutes.toFixed(2)) : null,
        manualBaselineMinutes,
        savedMinutes: savedMinutes !== null ? Math.round(savedMinutes) : null,
        savedHours: savedMinutes !== null ? Number((savedMinutes / 60).toFixed(1)) : null,
      },
      cost: {
        promptTokens: tokens.prompt ?? 0,
        completionTokens: tokens.completion ?? 0,
        totalTokens: (tokens.prompt ?? 0) + (tokens.completion ?? 0),
      },
      alerts: { total: alertTotal, deduped: alertDeduped, noiseReductionRate: alertTotal > 0 ? Number(((alertDeduped / alertTotal) * 100).toFixed(1)) : null },
      knowledge: { caseCount },
    };
  }

  // -------------------------------------------------------------------------
  // 案例库（二期）
  // -------------------------------------------------------------------------

  insertCase(c: {
    id: string; serviceName: string | null; title: string; symptoms: string;
    rootCause: string; resolution: string; templateHashes: string[];
    validUntil?: string | null; owner?: string | null; sourceTaskId?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO fault_cases
         (id, created_at, service_name, title, symptoms, root_cause, resolution, template_hashes, valid_until, owner, source_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id, new Date().toISOString(), c.serviceName, c.title, c.symptoms,
        c.rootCause, c.resolution, JSON.stringify(c.templateHashes ?? []),
        c.validUntil ?? null, c.owner ?? null, c.sourceTaskId ?? null,
      );
  }

  listCases(serviceName?: string, limit = 50): Record<string, unknown>[] {
    const rows = serviceName
      ? (this.db.prepare('SELECT * FROM fault_cases WHERE service_name = ? ORDER BY created_at DESC LIMIT ?').all(serviceName, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM fault_cases ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows;
  }

  /** 简易相似案例检索：按模板 hash 交集打分（二期可升级为向量检索）。 */
  findSimilarCases(templateHashes: string[], serviceName?: string, limit = 3): Record<string, unknown>[] {
    if (!templateHashes.length) return [];
    const all = this.listCases(serviceName, 200);
    const target = new Set(templateHashes);
    const scored = all
      .map((c) => {
        let hashes: string[] = [];
        try {
          hashes = JSON.parse(String(c.template_hashes ?? '[]')) as string[];
        } catch { /* ignore */ }
        const overlap = hashes.filter((h) => target.has(h)).length;
        return { c, score: overlap };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s) => ({ ...s.c, _score: s.score }));
  }

  // -------------------------------------------------------------------------
  // AI 配置生成记录
  // -------------------------------------------------------------------------

  insertGeneration(g: AiConfigGeneration): void {
    this.db
      .prepare(
        `INSERT INTO ai_config_generations
         (id, created_at, actor, service_name, status, log_sample, user_prompt, model,
          ai_raw_output, draft_json, user_edits_diff, final_json, validation, tokens_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id, g.createdAt, g.actor, g.serviceName, g.status, g.logSample, g.userPrompt,
        g.model, g.aiRawOutput,
        g.draftJson !== null ? JSON.stringify(g.draftJson) : null,
        g.userEditsDiff !== null ? JSON.stringify(g.userEditsDiff) : null,
        g.finalJson !== null ? JSON.stringify(g.finalJson) : null,
        g.validation !== null ? JSON.stringify(g.validation) : null,
        g.tokensUsed !== null ? JSON.stringify(g.tokensUsed) : null,
      );
  }

  updateGeneration(
    id: string,
    patch: Partial<Pick<AiConfigGeneration, 'status' | 'draftJson' | 'userEditsDiff' | 'finalJson' | 'validation'>>,
  ): void {
    const colMap: Record<string, string> = {
      status: 'status',
      draftJson: 'draft_json',
      userEditsDiff: 'user_edits_diff',
      finalJson: 'final_json',
      validation: 'validation',
    };
    const json = new Set(['draftJson', 'userEditsDiff', 'finalJson', 'validation']);
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = colMap[k];
      if (!col) continue;
      cols.push(`${col} = ?`);
      vals.push(json.has(k) ? (v !== null && v !== undefined ? JSON.stringify(v) : null) : (v as string));
    }
    if (cols.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE ai_config_generations SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  }

  private rowToGeneration(row: Record<string, unknown>): AiConfigGeneration {
    const parse = <T>(v: unknown): T | null => {
      if (v === null || v === undefined || v === '') return null;
      try {
        return JSON.parse(String(v)) as T;
      } catch {
        return null;
      }
    };
    return {
      id: String(row.id),
      createdAt: String(row.created_at),
      actor: String(row.actor ?? ''),
      serviceName: String(row.service_name ?? ''),
      status: row.status as AiConfigGeneration['status'],
      logSample: String(row.log_sample ?? ''),
      userPrompt: String(row.user_prompt ?? ''),
      model: (row.model as string) ?? null,
      aiRawOutput: (row.ai_raw_output as string) ?? null,
      draftJson: parse(row.draft_json),
      userEditsDiff: parse(row.user_edits_diff),
      finalJson: parse(row.final_json),
      validation: parse(row.validation),
      tokensUsed: parse(row.tokens_used),
    };
  }

  getGeneration(id: string): AiConfigGeneration | null {
    const row = this.db.prepare('SELECT * FROM ai_config_generations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToGeneration(row) : null;
  }

  listGenerations(serviceName?: string, limit = 50): AiConfigGeneration[] {
    const rows = serviceName
      ? (this.db
          .prepare('SELECT * FROM ai_config_generations WHERE service_name = ? ORDER BY created_at DESC LIMIT ?')
          .all(serviceName, limit) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM ai_config_generations ORDER BY created_at DESC LIMIT ?')
          .all(limit) as Record<string, unknown>[]);
    return rows.map((r) => this.rowToGeneration(r));
  }

  // -------------------------------------------------------------------------
  // 数据生命周期（保留期清理 + 僵尸任务回收）
  // -------------------------------------------------------------------------

  /**
   * 删除 created_at 早于 N 天前的诊断任务（log_templates/metrics/conclusion 等大字段
   * 与任务同行存储，随行一并删除）。返回删除行数。
   */
  purgeOldTasks(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const r = this.db.prepare('DELETE FROM diagnosis_tasks WHERE created_at < ?').run(cutoff);
    const deleted = Number(r.changes ?? 0);
    if (deleted > 0) {
      logger.info('已清理过期诊断任务', { retentionDays, deleted });
    }
    return deleted;
  }

  /**
   * 进程重启后回收僵尸任务：上次进程退出时仍处于非终态（pending/collecting/analyzing）
   * 的任务永远不会再被推进，批量标记为 failed。返回受影响行数。
   */
  markStaleTasksFailed(): number {
    const r = this.db
      .prepare(
        `UPDATE diagnosis_tasks
         SET status = 'failed', error = '进程重启中断', updated_at = ?
         WHERE status IN ('pending', 'collecting', 'analyzing')`,
      )
      .run(new Date().toISOString());
    const marked = Number(r.changes ?? 0);
    if (marked > 0) {
      logger.warn('发现上次进程中断遗留的僵尸任务，已标记为失败', { count: marked });
    }
    return marked;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** 模板内容 → 稳定 hash（用于基线与案例关联）。 */
export function hashTemplate(template: string): string {
  let h = 5381;
  for (let i = 0; i < template.length; i++) h = ((h << 5) + h + template.charCodeAt(i)) | 0;
  return h.toString(36);
}
