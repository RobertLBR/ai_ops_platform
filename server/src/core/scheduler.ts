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
import { DiagnosisEngine } from '../core/diagnosis-engine';
import { LlmRouter } from '../ai/llm-router';
import { httpRequest } from '../datasources/http';
import { logger } from '../utils/logger';

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
          // 用诊断流水线跑一次；基线对比在 compress 内部完成，
          // 新模板会被打上 isNew 标记
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
              await this.pushAlertCard(
                `定时巡检发现异常：${svc.canonicalName}`,
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
        `最近 24 小时：诊断 ${last24h.length} 次，失败 ${failedTasks.length} 次，critical ${criticalTasks.length} 次。\n` +
        `累计节省人工 ${summary.speed?.savedHours ?? 0} 小时，结论有用率 ${summary.accuracy?.usefulRate ?? 'N/A'}%。`;
    }

    const text = `【AI 运维日报】${new Date().toISOString().slice(0, 10)}\n\n${narrative}`;

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
      detail: { taskCount24h: last24h.length, failedCount: failedTasks.length, pushed: !!url },
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
          { tag: 'note', elements: [{ tag: 'plain_text', content: `诊断任务 ${taskId}｜严重级别 ${severity}` }] },
        ],
      },
    };

    try {
      await httpRequest(url, { method: 'POST', body: payload, timeoutMs: 10000 });
    } catch (e) {
      logger.warn('推送告警卡片失败', { error: (e as Error).message });
    }
  }

  /** 推送飞书纯文本。 */
  private async pushFeishuText(url: string, text: string): Promise<void> {
    try {
      await httpRequest(url, {
        method: 'POST',
        body: { msg_type: 'text', content: { text } },
        timeoutMs: 10000,
      });
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
