/**
 * 定时扫描调度器（触发层第三种入口）。
 *
 * 职责：
 *   1. 周期性扫描 error 日志，发现"新出现的异常模板"就自动诊断。
 *   2. 每日生成结论式日报并推送（飞书群机器人）。
 *
 * 为什么不用 node-cron：一期只需要两种固定节奏（间隔 + 每日定点），
 * 自己实现约 60 行，少一个依赖，Docker 镜像更小，也不会引入时区坑。
 *
 * 注意：日报是"结论式"而非"罗列数字" —— 这是你现有 Prometheus 日报
 * 的痛点（数字太多看不出问题）。这里让大模型对度量结果做一句话总结。
 */

import { AppConfig } from '../config/schema';
import { Database } from '../storage/database';
import { DiagnosisEngine, CollectedEvidence } from '../core/diagnosis-engine';
import { LlmRouter } from '../ai/llm-router';
import { MetricSnapshot } from '../core/types';
import { httpRequest } from '../datasources/http';
import { logger } from '../utils/logger';

/**
 * 校验飞书 webhook 的业务返回码。
 *
 * 关键：飞书机器人「关键词不匹配」「签名错误」等情况返回的 HTTP 状态码仍是 200，
 * 只把错误放在响应体里（如 {"code":19024,"msg":"Key Words Not Found"}）。
 * 若不检查响应体，会把推送失败误报为成功。
 */
function assertFeishuOk(resp: unknown): void {
  if (!resp || typeof resp !== 'object') return;
  const r = resp as Record<string, unknown>;
  const raw = r.code ?? r.StatusCode;
  if (raw === undefined || raw === null) return; // 兼容不返回码的版本
  const code = Number(raw);
  if (Number.isNaN(code) || code === 0) return;
  const msg = String(r.msg ?? r.StatusMessage ?? 'unknown');
  throw new Error(`飞书返回业务错误 code=${code} msg=${msg}（19024 = 自定义关键词不匹配）`);
}

/**
 * 巡检前置闸的指标粗判 critical（保守启发式，宁可多诊不可漏诊）：
 *   - OOM/重启/崩溃类计数指标出现非零值；
 *   - 百分比类指标（cpu/memory/disk/jvm 使用率）达到 95% 以上。
 */
function hasCriticalMetric(metrics: MetricSnapshot[]): boolean {
  for (const m of metrics) {
    if (m.error) continue;
    const oomLike = /oom|restart|crash/i.test(m.name);
    for (const v of m.values) {
      if (oomLike && v.value > 0) return true;
      if (v.value >= 95) return true;
    }
  }
  return false;
}

/**
 * 巡检免费前置闸：取证 + 压缩（零 LLM 费用）后，全部满足以下条件才跳过诊断：
 *   1. 无 isNew 模板（基线期内从未出现的新模式）；
 *   2. 无频率突增（与 prompts.renderTemplates 同一口径：基线 > 0 且超过 3 倍）；
 *   3. 压缩后无 ERROR 级别模板；
 *   4. 指标无 critical。
 */
function shouldSkipLlm(ev: CollectedEvidence): boolean {
  const hasNew = ev.templates.some((t) => t.isNew);
  const hasSpike = ev.templates.some(
    (t) => t.baselineCount !== undefined && t.baselineCount !== null && t.baselineCount > 0 && t.count / t.baselineCount > 3,
  );
  const hasError = ev.templates.some((t) => t.levels.includes('ERROR'));
  return !hasNew && !hasSpike && !hasError && !hasCriticalMetric(ev.metrics);
}

export class Scheduler {
  private scanTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastScanAt: string | null = null;
  private lastReportAt: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly engine: DiagnosisEngine,
    private readonly llm: LlmRouter,
  ) {}

  start(): void {
    const s = this.config.alerts.scheduler;
    if (!s.enabled) {
      logger.info('定时调度未启用（alerts.scheduler.enabled=false）');
      return;
    }

    // --- 周期扫描 ---
    const intervalMs = s.scanIntervalMinutes * 60000;
    this.scanTimer = setInterval(() => {
      void this.runScan().catch((e) => logger.error('定时扫描异常', { error: (e as Error).message }));
    }, intervalMs);
    // 首次延迟 1 分钟，避开启动期的数据源连接
    setTimeout(() => {
      void this.runScan().catch((e) => logger.error('首次定时扫描异常', { error: (e as Error).message }));
    }, 60000);

    // --- 每日日报 ---
    this.scheduleDaily(s.dailyReportHour, s.dailyReportMinute);

    logger.info('定时调度已启动', {
      scanIntervalMinutes: s.scanIntervalMinutes,
      dailyReportAt: `${String(s.dailyReportHour).padStart(2, '0')}:${String(s.dailyReportMinute).padStart(2, '0')}`,
    });
  }

  /** 计算到下一次定点的毫秒数（跨天自动处理）。 */
  private scheduleDaily(hour: number, minute: number): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    logger.debug('日报已排程', { nextRun: next.toISOString(), delayMs: delay });

    this.dailyTimer = setTimeout(() => {
      // 数据生命周期：每日随日报节奏清理过期诊断任务（含大字段）
      try {
        this.db.purgeOldTasks(this.config.storage.retentionDays);
      } catch (e) {
        logger.warn('过期诊断任务清理失败', { error: (e as Error).message });
      }
      void this.runDailyReport().catch((e) => logger.error('日报生成异常', { error: (e as Error).message }));
      // 执行后重新排下一天
      this.scheduleDaily(hour, minute);
    }, delay);
  }

  // -------------------------------------------------------------------------
  // 周期扫描
  // -------------------------------------------------------------------------

  /** 扫描各服务近期 error 日志，发现新模板则自动诊断。 */
  async runScan(): Promise<{ scanned: number; triggered: number }> {
    if (this.running) {
      logger.debug('上一轮扫描尚未结束，跳过本轮');
      return { scanned: 0, triggered: 0 };
    }
    this.running = true;
    this.lastScanAt = new Date().toISOString();

    let scanned = 0;
    let triggered = 0;

    try {
      const services = this.config.services.filter((s) => s.tier !== 'edge');
      logger.info('开始定时扫描', { serviceCount: services.length });

      for (const svc of services) {
        scanned++;
        try {
          // 免费前置闸：先只跑「取证 + 脱敏 + 压缩」（零 LLM 费用），
          // 基线对比在 compress 内部完成，新模板会被打上 isNew 标记。
          // 无任何异常迹象时跳过 LLM 诊断，避免每个周期对每个服务无条件付费。
          const ev = await this.engine.collectAndCompress(svc);

          if (ev.empty) {
            logger.debug('巡检取证为空，跳过', { service: svc.canonicalName });
            continue;
          }

          if (shouldSkipLlm(ev)) {
            // 回写基线：正常频率也要持续累积，否则基线永远停留在出故障的日子
            this.engine.recordBaseline(svc.canonicalName, ev.templates);
            // 落审计，日报中可区分"跳过"与"诊断"（action: scan.skipped_no_anomaly）
            this.db.insertAudit({
              id: `aud_${Date.now().toString(36)}_${scanned}`,
              at: new Date().toISOString(),
              actor: 'scheduler',
              action: 'scan.skipped_no_anomaly',
              target: svc.canonicalName,
              detail: {
                templateCount: ev.templates.length,
                rawLogCount: ev.rawLogCount,
                timeFrom: ev.timeFrom,
                timeTo: ev.timeTo,
              },
            });
            logger.debug('巡检无异常迹象，跳过 LLM 诊断', { service: svc.canonicalName, templateCount: ev.templates.length });
            continue;
          }

          const { task } = await this.engine.diagnose({
            question: `[定时扫描] ${svc.canonicalName} 近 ${this.config.diagnosis.windowBeforeMinutes} 分钟异常日志巡检`,
            trigger: 'schedule',
            serviceName: svc.canonicalName,
          });

          if (task.status === 'done' && task.conclusion) {
            const newPatterns = (task.logTemplates ?? []).filter((t) => t.isNew).length;
            // 只有发现新模式或判定为 critical/warning 才推送，避免噪音
            if (newPatterns > 0 || task.conclusion.severity === 'critical' || task.conclusion.severity === 'warning') {
              triggered++;
              // 标题必须含「告警」：飞书自定义机器人若启用了「自定义关键词」校验，
              // 消息中不含关键词会被直接拒收（错误码 19024）。改动文案时请保留。
              await this.pushAlertCard(
                `【告警】定时巡检发现异常：${svc.canonicalName}`,
                task.conclusion.summary,
                task.id,
                task.conclusion.severity,
              );
            }
          }
        } catch (e) {
          logger.warn('扫描单个服务失败', { service: svc.canonicalName, error: (e as Error).message });
        }
      }

      logger.info('定时扫描完成', { scanned, triggered });
      return { scanned, triggered };
    } finally {
      this.running = false;
    }
  }

  // -------------------------------------------------------------------------
  // 每日日报
  // -------------------------------------------------------------------------

  /** 生成结论式日报（而非罗列数字）。 */
  async runDailyReport(): Promise<string> {
    this.lastReportAt = new Date().toISOString();
    const summary = this.db.getMetricsSummary(this.config.metrics.manualBaselineMinutes) as Record<string, any>;

    // 最近 24 小时的诊断结果
    const recent = this.db.listTasks(30, 0);
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const last24h = recent.items.filter((t) => t.createdAt >= dayAgo);

    const failedTasks = last24h.filter((t) => t.status === 'failed');
    const criticalTasks = last24h.filter((t) => t.conclusion?.severity === 'critical');
    const wrongConclusions = last24h.filter((t) => t.feedback?.verdict === 'wrong');
    // 巡检前置闸跳过的次数（无异常未耗 token），与正式诊断任务区分开
    const skippedScans = this.db
      .listAudit(500)
      .filter((a) => a.at >= dayAgo && a.action === 'scan.skipped_no_anomaly').length;

    let narrative = '';
    // 用轻量档模型做一句话总结（低频任务，不值得用主力模型）
    try {
      const { data } = await this.llm.chatJson<{ report: string; highlights: string[]; concerns: string[] }>('report', [
        {
          role: 'system',
          content:
            '你是运维团队的技术负责人，需要写一份简洁的每日运维日报给团队和上级。' +
            '要求：结论先行，用数据说话，不要罗列所有数字，只讲值得关注的。' +
            '如果一切正常就明确说"无异常"，不要为了显得有内容而编造问题。' +
            '输出 JSON: {"report": "不超过200字的日报正文", "highlights": ["值得关注的点"], "concerns": ["需要跟进的风险"]}',
        },
        {
          role: 'user',
          content: [
            `统计周期：最近 24 小时（${dayAgo} ~ ${this.lastReportAt}）`,
            '',
            `诊断任务：共 ${last24h.length} 次，失败 ${failedTasks.length} 次`,
            `其中判定为 critical：${criticalTasks.length} 次`,
            `人工标记结论错误：${wrongConclusions.length} 次`,
            `定时巡检跳过（无异常迹象，未消耗 token）：${skippedScans} 次`,
            '',
            `累计指标：`,
            `- 累计诊断 ${summary.tasks?.total ?? 0} 次，完成 ${summary.tasks?.done ?? 0} 次`,
            `- 平均诊断耗时 ${summary.speed?.avgDurationMinutes ?? 'N/A'} 分钟（人工基线 ${summary.speed?.manualBaselineMinutes} 分钟）`,
            `- 累计节省人工 ${summary.speed?.savedHours ?? 0} 小时`,
            `- 结论有用率 ${summary.accuracy?.usefulRate ?? 'N/A'}%（样本 ${summary.accuracy?.feedbackCount ?? 0} 条）`,
            `- 告警 ${summary.alerts?.total ?? 0} 条，降噪 ${summary.alerts?.deduped ?? 0} 条`,
            `- token 消耗 ${summary.cost?.totalTokens ?? 0}`,
            `- 沉淀案例 ${summary.knowledge?.caseCount ?? 0} 条`,
            '',
            `最近诊断记录（最多 10 条）：`,
            ...last24h.slice(0, 10).map(
              (t) =>
                `- [${t.status}] ${t.serviceName ?? '未知服务'} | ${t.conclusion?.severity ?? '-'} | ${t.conclusion?.summary ?? t.error ?? ''}`.slice(0, 200),
            ),
          ].join('\n'),
        },
      ]);
      const d = data as { report?: string; highlights?: string[]; concerns?: string[] };
      narrative = [
        d.report ?? '',
        d.highlights?.length ? `\n值得关注：\n${d.highlights.map((h) => `- ${h}`).join('\n')}` : '',
        d.concerns?.length ? `\n需跟进风险：\n${d.concerns.map((c) => `- ${c}`).join('\n')}` : '',
      ].join('');
    } catch (e) {
      logger.warn('日报叙述生成失败，降级为纯数据日报', { error: (e as Error).message });
      narrative =
        `最近 24 小时：诊断 ${last24h.length} 次，失败 ${failedTasks.length} 次，critical ${criticalTasks.length} 次，巡检无异常跳过 ${skippedScans} 次。\n` +
        `累计节省人工 ${summary.speed?.savedHours ?? 0} 小时，结论有用率 ${summary.accuracy?.usefulRate ?? 'N/A'}%。`;
    }

    // 标题含「告警」：飞书自定义机器人的「自定义关键词」校验要求消息含关键词，否则拒收
    const text = `【AI 运维告警日报】${new Date().toISOString().slice(0, 10)}\n\n${narrative}`;

    // 推送
    const url = this.config.alerts.scheduler.reportWebhookUrl;
    if (url) {
      await this.pushFeishuText(url, text);
    } else {
      logger.info('未配置日报推送地址，仅记录', { report: text.slice(0, 300) });
    }

    this.db.insertAudit({
      id: `aud_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      actor: 'scheduler',
      action: 'daily_report.sent',
      target: '',
      detail: { taskCount24h: last24h.length, failedCount: failedTasks.length, skippedScans, pushed: !!url },
    });

    return text;
  }

  // -------------------------------------------------------------------------
  // 推送
  // -------------------------------------------------------------------------

  /** 推送飞书富文本卡片。 */
  private async pushAlertCard(title: string, summary: string, taskId: string, severity: string): Promise<void> {
    const url = this.config.alerts.scheduler.reportWebhookUrl;
    if (!url) {
      logger.debug('未配置推送地址，跳过卡片推送', { taskId });
      return;
    }

    const colorMap: Record<string, string> = { critical: 'red', warning: 'orange', info: 'blue', unknown: 'grey' };
    const payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: colorMap[severity] ?? 'grey',
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: summary } },
          { tag: 'note', elements: [{ tag: 'plain_text', content: `告警级别 ${severity}｜诊断任务 ${taskId}` }] },
        ],
      },
    };

    try {
      const resp = await httpRequest(url, { method: 'POST', body: payload, timeoutMs: 10000 });
      assertFeishuOk(resp);
      logger.info('告警卡片已推送', { taskId, severity, title });
    } catch (e) {
      logger.warn('推送告警卡片失败', { error: (e as Error).message, title });
    }
  }

  /** 推送飞书纯文本。 */
  private async pushFeishuText(url: string, text: string): Promise<void> {
    try {
      const resp = await httpRequest(url, {
        method: 'POST',
        body: { msg_type: 'text', content: { text } },
        timeoutMs: 10000,
      });
      assertFeishuOk(resp);
      logger.info('日报已推送');
    } catch (e) {
      logger.warn('日报推送失败', { error: (e as Error).message });
    }
  }

  /** 供 /api/scheduler/status 查询。 */
  status(): Record<string, unknown> {
    const s = this.config.alerts.scheduler;
    return {
      enabled: s.enabled,
      scanIntervalMinutes: s.scanIntervalMinutes,
      dailyReportAt: `${String(s.dailyReportHour).padStart(2, '0')}:${String(s.dailyReportMinute).padStart(2, '0')}`,
      lastScanAt: this.lastScanAt,
      lastReportAt: this.lastReportAt,
      currentlyRunning: this.running,
      reportWebhookConfigured: !!s.reportWebhookUrl,
    };
  }

  stop(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
    this.scanTimer = null;
    this.dailyTimer = null;
    logger.info('定时调度已停止');
  }
}
