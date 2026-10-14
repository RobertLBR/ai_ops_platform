/**
 * REST API 路由。
 *
 * 端点设计围绕工作台三个核心页面：
 *   - 故障列表 / 详情（诊断任务）
 *   - 提问入口（手动触发诊断）
 *   - 成果度量看板（谈判弹药）
 *
 * 安全：
 *   - 可选 Bearer Token 鉴权（server.apiToken）
 *   - webhook 可选共享密钥校验
 *   - 所有写操作仅限"反馈标记"与"案例沉淀"，不触碰任何生产系统
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppConfig, resolveService } from '../config/schema';
import { Database } from '../storage/database';
import { DiagnosisEngine } from '../core/diagnosis-engine';
import { Redactor } from '../core/redaction';
import { LlmRouter } from '../ai/llm-router';
import { parseInboundAlerts, severityAtLeast } from './alert-parser';
import { createMonitorRouter } from './monitor';
import { createAiConfigRouter } from './ai-config';
import { createAuthService, AuthService } from './auth';
import { InboundAlert } from '../core/types';
import { CommandGuard } from '../datasources/ssh';
import { logger } from '../utils/logger';

export interface ApiContext {
  config: AppConfig;
  /** 配置文件实际路径（AI 配置写回用） */
  configPath: string;
  db: Database;
  engine: DiagnosisEngine;
  llm: LlmRouter;
  /** 脱敏器（告警原文落库前的合规闸口） */
  redactor: Redactor;
  /** 进程启动时间，用于 uptime */
  startedAt: number;
  /** 构建版本信息 */
  version: string;
}

/**
 * API 鉴权中间件：Web 会话与 Bearer API Token 二者任一通过即可。
 *
 * 放行规则：
 *  1. /auth/login、/auth/status 为公开端点（登录前就要访问）；
 *  2. Authorization: Bearer <server.apiToken> —— 兼容原有 API Token / 脚本调用；
 *  3. Authorization: Bearer <会话令牌> —— Web 登录后签发；
 *  4. apiToken 与会话均未配置/无效 → 401。
 */
export function authMiddleware(config: AppConfig, auth?: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 公开端点：登录与登录状态探测
    if (req.path === '/auth/login' || req.path === '/auth/status') {
      next();
      return;
    }

    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    // 1) 静态 API Token（脚本/巡检调用兼容通道）
    if (config.server.apiToken && provided && provided === config.server.apiToken) {
      next();
      return;
    }

    // 2) Web 会话令牌
    if (auth && provided && auth.verifySession(provided)) {
      next();
      return;
    }

    // 3) 两者都不可用
    if (!config.server.apiToken && !auth) {
      // 完全未启用任何鉴权（内网自用兜底，理论上下游启动闸已拦截）
      next();
      return;
    }

    res.status(401).json({ error: 'unauthorized', message: '未登录或凭证无效' });
  };
}

/** webhook 共享密钥校验（时间戳 + HMAC 或直接明文比对，这里用简单明文头）。 */
function verifyWebhookSecret(config: AppConfig, req: Request): boolean {
  const secret = config.alerts.webhook.secret;
  if (!secret) return true; // 未配置则不校验（仅限内网）
  const provided = String(req.headers['x-webhook-secret'] ?? req.query.secret ?? '');
  return provided === secret;
}

export function createApiRouter(ctx: ApiContext): Router {
  const router = Router();
  const { config, db, engine, redactor } = ctx;

  // -------------------------------------------------------------------------
  // Web 登录鉴权服务（管理员账号存 SQLite，密码 scrypt 哈希）
  // -------------------------------------------------------------------------
  const auth = createAuthService(db);

  // -------------------------------------------------------------------------
  // 子路由（实时监控聚合 / AI 配置生成），全部带鉴权
  // -------------------------------------------------------------------------
  router.use('/monitor', authMiddleware(config, auth), createMonitorRouter({ db, engine }));
  router.use('/ai-config', authMiddleware(config, auth), createAiConfigRouter({
    config,
    configPath: ctx.configPath,
    db,
    llm: ctx.llm,
    redactor,
  }));

  // -------------------------------------------------------------------------
  // 登录 / 会话（login 与 status 本身公开，其余端点均鉴权）
  // -------------------------------------------------------------------------

  /** 登录：校验用户名密码，签发会话令牌（HMAC，7 天有效）。 */
  router.post('/auth/login', (req, res) => {
    const username = String(req.body?.username ?? '');
    const password = String(req.body?.password ?? '');
    if (!username || !password) {
      res.status(400).json({ error: 'bad_request', message: '用户名和密码不能为空' });
      return;
    }
    // 校验凭证并签发会话（scrypt 计算本身有耗时，auth 内部已做时序均衡）
    const result = auth.login(username, password);

    if (!result) {
      logger.warn('登录失败', { username: username.slice(0, 40), ip: req.ip });
      res.status(401).json({ error: 'unauthorized', message: '用户名或密码错误' });
      return;
    }
    logger.info('登录成功', { username: username.slice(0, 40), ip: req.ip });
    res.json({ ok: true, token: result.token, mustChangePassword: result.mustChangePassword });
  });

  /** 登录状态探测：会话是否有效 + 是否仍为默认密码（前端启动时调用）。 */
  router.get('/auth/status', (req, res) => {
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const valid = !!provided && auth.verifySession(provided);
    res.json({ authenticated: valid, mustChangePassword: valid ? auth.mustChangePassword() : false });
  });

  /** 修改密码（需登录）。成功后所有会话失效，需重新登录。 */
  router.post('/auth/change-password', authMiddleware(config, auth), (req, res) => {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'bad_request', message: '当前密码与新密码不能为空' });
      return;
    }
    const result = auth.changePassword(currentPassword, newPassword);
    if (!result.ok) {
      res.status(400).json({ error: 'bad_request', message: result.error });
      return;
    }
    db.insertAudit({
      id: `aud_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      actor: 'admin',
      action: 'auth.password_changed',
      target: 'admin',
      detail: {},
    });
    res.json({ ok: true, message: '密码已修改，请重新登录' });
  });

  // -------------------------------------------------------------------------
  // 健康与元信息（不鉴权，供容器 healthcheck 使用）
  // -------------------------------------------------------------------------

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: ctx.version,
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      time: new Date().toISOString(),
    });
  });

  /** 数据源可达性（带鉴权，避免暴露内网拓扑） */
  router.get('/datasources/health', authMiddleware(config, auth), async (_req, res) => {
    const ds = await engine.datasourceHealth();
    res.json({
      config: {
        elasticsearch: config.datasources.elasticsearch.map((d) => ({ id: d.id, name: d.name, url: d.url, enabled: d.enabled })),
        prometheus: config.datasources.prometheus.map((d) => ({ id: d.id, name: d.name, url: d.url, enabled: d.enabled })),
        ssh: config.datasources.ssh.map((d) => ({ id: d.id, name: d.name, host: d.host, enabled: d.enabled })),
        services: config.services.map((s) => ({ canonicalName: s.canonicalName, displayName: s.displayName, tier: s.tier })),
      },
      live: ds,
    });
  });

  // -------------------------------------------------------------------------
  // 诊断任务
  // -------------------------------------------------------------------------

  /** 列表（工作台首页 ProTable 数据源） */
  router.get('/diagnoses', authMiddleware(config, auth), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 20), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const status = req.query.status ? String(req.query.status) : undefined;
    const serviceName = req.query.service ? String(req.query.service) : undefined;

    const { items, total } = db.listTasks(limit, offset, { status, serviceName });

    // 列表不返回大字段，减少传输量
    const light = items.map((t) => ({
      id: t.id,
      status: t.status,
      trigger: t.trigger,
      question: t.question.slice(0, 200),
      serviceName: t.serviceName,
      timeFrom: t.timeFrom,
      timeTo: t.timeTo,
      createdAt: t.createdAt,
      durationMs: t.durationMs,
      severity: t.conclusion?.severity ?? null,
      summary: t.conclusion?.summary ?? null,
      error: t.error,
      hasFeedback: !!t.feedback,
      feedbackVerdict: t.feedback?.verdict ?? null,
    }));

    res.json({ total, limit, offset, items: light });
  });

  /** 详情（故障卡片页） */
  router.get('/diagnoses/:id', authMiddleware(config, auth), (req, res) => {
    const task = db.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'not_found', message: `诊断任务 ${req.params.id} 不存在` });
      return;
    }
    res.json(task);
  });

  /** 手动触发诊断（工作台提问入口） */
  router.post('/diagnoses', authMiddleware(config, auth), async (req, res) => {
    const question = String(req.body?.question ?? '').trim();
    if (!question) {
      res.status(400).json({ error: 'bad_request', message: 'question 不能为空' });
      return;
    }

    const serviceName = req.body?.serviceName ? String(req.body.serviceName) : undefined;
    const timeFrom = req.body?.timeFrom ? String(req.body.timeFrom) : undefined;
    const timeTo = req.body?.timeTo ? String(req.body.timeTo) : undefined;

    // 校验服务名（给了但不认识就明确报错，避免静默降级）
    if (serviceName) {
      const svc = resolveService(config, serviceName);
      if (!svc) {
        res.status(400).json({
          error: 'unknown_service',
          message: `服务 "${serviceName}" 不在注册表中`,
          knownServices: config.services.map((s) => s.canonicalName),
        });
        return;
      }
    }

    logger.info('收到手动诊断请求', { question: question.slice(0, 120), serviceName });

    const { task } = await engine.diagnose({
      question,
      trigger: 'manual',
      serviceName,
      timeFrom,
      timeTo,
    });

    res.status(task.status === 'failed' ? 200 : 201).json(task);
  });

  /** 人工反馈（准确率度量 + 知识库迭代输入） */
  router.post('/diagnoses/:id/feedback', authMiddleware(config, auth), (req, res) => {
    const task = db.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'not_found', message: '诊断任务不存在' });
      return;
    }
    const verdict = String(req.body?.verdict ?? '');
    if (!['correct', 'partial', 'wrong'].includes(verdict)) {
      res.status(400).json({ error: 'bad_request', message: 'verdict 必须是 correct | partial | wrong' });
      return;
    }
    const feedback = { verdict: verdict as 'correct' | 'partial' | 'wrong', comment: String(req.body?.comment ?? ''), at: new Date().toISOString() };
    db.updateTask(task.id, { feedback });

    db.insertAudit({
      id: `aud_${Date.now().toString(36)}`,
      at: feedback.at,
      actor: String(req.body?.actor ?? 'user'),
      action: 'diagnosis.feedback',
      target: task.id,
      detail: { verdict: feedback.verdict, comment: feedback.comment.slice(0, 500) },
    });

    res.json({ ok: true, id: task.id, feedback });
  });

  /** 把这次诊断沉淀为案例（二期知识库的输入） */
  router.post('/diagnoses/:id/promote-to-case', authMiddleware(config, auth), (req, res) => {
    const task = db.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'not_found', message: '诊断任务不存在' });
      return;
    }
    if (!task.conclusion) {
      res.status(400).json({ error: 'bad_request', message: '该任务无诊断结论，无法沉淀为案例' });
      return;
    }

    const id = `case_${Date.now().toString(36)}`;
    db.insertCase({
      id,
      serviceName: task.serviceName,
      title: String(req.body?.title ?? task.conclusion.summary.slice(0, 120)),
      symptoms: (task.logTemplates ?? []).slice(0, 5).map((t) => t.template).join('\n'),
      rootCause: task.conclusion.root_cause_candidates[0]?.target ?? task.conclusion.summary,
      resolution: String(req.body?.resolution ?? task.conclusion.checklist.join(' / ')),
      templateHashes: (task.logTemplates ?? []).slice(0, 10).map((t) => hashTemplateLocal(t.template)),
      validUntil: req.body?.validUntil ? String(req.body.validUntil) : null,
      owner: req.body?.owner ? String(req.body.owner) : null,
      sourceTaskId: task.id,
    });

    res.status(201).json({ ok: true, caseId: id });
  });

  // -------------------------------------------------------------------------
  // 服务注册表（前端展示 + 校验配置）
  // -------------------------------------------------------------------------

  router.get('/services', authMiddleware(config, auth), (_req, res) => {
    res.json({
      total: config.services.length,
      items: config.services.map((s) => ({
        canonicalName: s.canonicalName,
        displayName: s.displayName,
        aliases: s.aliases,
        tier: s.tier,
        stack: s.stack,
        datasourceId: s.datasourceId,
        indexPatterns: s.indexPatterns,
        dependsOn: s.dependsOn,
        dependedBy: s.dependedBy,
        deployment: s.deployment,
        knownIssueCount: s.knownIssues.length,
        knownIssues: s.knownIssues,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // 案例库
  // -------------------------------------------------------------------------

  router.get('/cases', authMiddleware(config, auth), (req, res) => {
    const serviceName = req.query.service ? String(req.query.service) : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const items = db.listCases(serviceName, limit);
    res.json({ total: items.length, items });
  });

  // -------------------------------------------------------------------------
  // 告警
  // -------------------------------------------------------------------------

  router.get('/alerts', authMiddleware(config, auth), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    res.json({ items: db.listAlerts(limit) });
  });

  /** Alertmanager / 飞书 / 企微 webhook 入口 */
  const webhookPath = config.alerts.webhook.path || '/api/webhook/alertmanager';
  const webhookLocalPath = webhookPath.replace(/^\/api/, '') || '/webhook/alertmanager';

  const handleWebhook = async (req: Request, res: Response): Promise<void> => {
    if (!config.alerts.webhook.enabled) {
      res.status(404).json({ error: 'disabled', message: 'webhook 未启用（alerts.webhook.enabled=false）' });
      return;
    }
    if (!verifyWebhookSecret(config, req)) {
      res.status(401).json({ error: 'unauthorized', message: 'webhook 密钥校验失败' });
      return;
    }

    // 来源判定：路径后缀或 header
    const urlPath = req.path || '';
    let source: 'alertmanager' | 'feishu' | 'wecom' = 'alertmanager';
    if (/feishu|lark/i.test(urlPath)) source = 'feishu';
    else if (/wecom|wework|qywx/i.test(urlPath)) source = 'wecom';

    const alerts: InboundAlert[] = parseInboundAlerts(config, source, req.body);
    if (alerts.length === 0) {
      res.status(400).json({ error: 'no_alerts_parsed', message: '未能从请求体解析出任何告警，请检查来源类型与格式' });
      return;
    }

    const accepted: { id: string; service: string | null; severity: string; diagnosed: boolean; deduped: boolean }[] = [];

    for (const alert of alerts) {
      // 降噪窗口：同服务近期已诊断则只记录不重复诊断
      const dedupWindow = config.alerts.webhook.dedupWindowSeconds;
      const isDup = dedupWindow > 0 && db.hasRecentAlert(alert.service, dedupWindow);

      let diagnosisId: string | null = null;
      let diagnosed = false;

      const shouldDiagnose =
        config.alerts.webhook.autoDiagnose &&
        !isDup &&
        alert.status === 'firing' &&
        severityAtLeast(alert.severity, config.alerts.webhook.minSeverity);

      // 告警原文落库前脱敏（合规闸口），只保留脱敏命中计数到审计
      const redactedRaw = redactor.redactObject(alert.raw ?? {});
      const safeAlert = { ...alert, raw: redactedRaw.value };
      if (redactedRaw.totalRedacted > 0) {
        db.insertAudit({
          id: `aud_${Date.now().toString(36)}`,
          at: new Date().toISOString(),
          actor: 'system',
          action: 'alert.redacted',
          target: alert.id,
          detail: { redacted: redactedRaw.totalRedacted },
        });
      }

      db.insertAlert({ ...safeAlert, diagnosisId, deduped: isDup });

      if (shouldDiagnose) {
        // 异步触发，不阻塞 webhook 响应（Alertmanager 有超时）
        void (async () => {
          try {
            const { task } = await engine.diagnose({
              question: `[${alert.severity}] ${alert.title}\n${alert.description}`.slice(0, 4000),
              trigger: 'alert',
              serviceName: alert.service ?? undefined,
              alertId: alert.id,
            });
            db.insertAlert({ ...safeAlert, diagnosisId: task.id, deduped: isDup });
          } catch (e) {
            logger.error('告警自动诊断失败', { alertId: alert.id, error: (e as Error).message });
          }
        })();
        diagnosed = true;
      }

      accepted.push({
        id: alert.id,
        service: alert.service,
        severity: alert.severity,
        diagnosed,
        deduped: isDup,
      });
    }

    logger.info('收到告警', { source, count: alerts.length, accepted });
    res.status(202).json({ ok: true, source, received: alerts.length, accepted });
  };

  router.post(webhookLocalPath, handleWebhook);
  // 额外提供显式来源路径，避免格式误判
  router.post('/webhook/feishu', handleWebhook);
  router.post('/webhook/wecom', handleWebhook);
  router.post('/webhook/alertmanager', handleWebhook);

  // -------------------------------------------------------------------------
  // 成果度量（谈判弹药）
  // -------------------------------------------------------------------------

  router.get('/metrics/summary', authMiddleware(config, auth), (_req, res) => {
    res.json(db.getMetricsSummary(config.metrics.manualBaselineMinutes));
  });

  /** Prometheus 文本格式端点，让本系统自身也被监控。 */
  if (config.metrics.exposePrometheus) {
    router.get('/metrics/prometheus', (_req, res) => {
      const s = db.getMetricsSummary(config.metrics.manualBaselineMinutes) as Record<string, any>;
      const lines: string[] = [
        '# HELP aiops_tasks_total 诊断任务总数',
        '# TYPE aiops_tasks_total counter',
        `aiops_tasks_total ${s.tasks?.total ?? 0}`,
        '# HELP aiops_tasks_done_total 完成的诊断任务数',
        '# TYPE aiops_tasks_done_total counter',
        `aiops_tasks_done_total ${s.tasks?.done ?? 0}`,
        '# HELP aiops_tasks_failed_total 失败的诊断任务数',
        '# TYPE aiops_tasks_failed_total counter',
        `aiops_tasks_failed_total ${s.tasks?.failed ?? 0}`,
        '# HELP aiops_diagnosis_duration_ms_avg 平均诊断耗时（毫秒）',
        '# TYPE aiops_diagnosis_duration_ms_avg gauge',
        `aiops_diagnosis_duration_ms_avg ${s.speed?.avgDurationMs ?? 0}`,
        '# HELP aiops_conclusion_useful_rate 结论有用率（百分比）',
        '# TYPE aiops_conclusion_useful_rate gauge',
        `aiops_conclusion_useful_rate ${s.accuracy?.usefulRate ?? 0}`,
        '# HELP aiops_saved_minutes_total 累计节省人工分钟数',
        '# TYPE aiops_saved_minutes_total counter',
        `aiops_saved_minutes_total ${s.speed?.savedMinutes ?? 0}`,
        '# HELP aiops_tokens_total 累计 token 消耗',
        '# TYPE aiops_tokens_total counter',
        `aiops_tokens_total ${s.cost?.totalTokens ?? 0}`,
        '# HELP aiops_alerts_total 收到告警总数',
        '# TYPE aiops_alerts_total counter',
        `aiops_alerts_total ${s.alerts?.total ?? 0}`,
        '# HELP aiops_alerts_deduped_total 被降噪的告警数',
        '# TYPE aiops_alerts_deduped_total counter',
        `aiops_alerts_deduped_total ${s.alerts?.deduped ?? 0}`,
        '# HELP aiops_uptime_seconds 进程运行时长',
        '# TYPE aiops_uptime_seconds gauge',
        `aiops_uptime_seconds ${Math.round((Date.now() - ctx.startedAt) / 1000)}`,
      ];
      res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
    });
  }

  // -------------------------------------------------------------------------
  // 审计日志（只读边界的证据）
  // -------------------------------------------------------------------------

  router.get('/audit', authMiddleware(config, auth), (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json({ items: db.listAudit(limit) });
  });

  // -------------------------------------------------------------------------
  // 安全自检：证明只读边界生效（演示/验收用）
  // -------------------------------------------------------------------------

  router.post('/security/check-command', authMiddleware(config, auth), (req, res) => {
    const command = String(req.body?.command ?? '');
    const hostId = req.body?.hostId ? String(req.body.hostId) : undefined;

    if (!command) {
      res.status(400).json({ error: 'bad_request', message: 'command 不能为空' });
      return;
    }

    // 用配置构造 guard 做纯校验，不建立任何连接
    const globalAllow = config.security.readonly.allowedCommandPrefixes;
    const host = hostId ? config.datasources.ssh.find((h) => h.id === hostId) : undefined;
    const effectiveAllow =
      host && host.allowedCommands.length
        ? host.allowedCommands.filter((c) => globalAllow.some((g) => c.startsWith(g) || g.startsWith(c)))
        : globalAllow;

    const guard = new CommandGuard(effectiveAllow, config.security.readonly.blockedPatterns);
    const reason = guard.check(command);

    res.json({
      command,
      allowed: reason === null,
      reason: reason ?? '通过白名单校验',
      checkedAgainst: { allowPrefixCount: effectiveAllow.length, blockPatternCount: config.security.readonly.blockedPatterns.length },
      note: '本接口只做校验，不执行任何命令。系统全程只读，AI 建议的命令需人工确认后自行执行。',
    });
  });

  return router;
}

/** 本地 hash（避免与 storage 循环依赖） */
function hashTemplateLocal(template: string): string {
  let h = 5381;
  for (let i = 0; i < template.length; i++) h = ((h << 5) + h + template.charCodeAt(i)) | 0;
  return h.toString(36);
}
