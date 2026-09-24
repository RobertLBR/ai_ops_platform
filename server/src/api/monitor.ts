/**
 * 实时监控聚合端点（设计文档 1.3）。
 *
 * 唯一端点 GET /snapshot：一次往返返回「告警流水 + 诊断状态 + 数据源健康」。
 *
 * 成本边界（代码层保证，不靠约定）：
 *   - 只读 SQLite（listAlerts / listTasks），不写库、不调 Scheduler；
 *   - 数据源健康走 60s 模块级惰性 TTL 缓存 —— 无论多少 tab、多少用户，
 *     对 ES/Prometheus 的真实探测频率 ≤ 1 次/60s；探测失败不抛错，
 *     返回上次缓存 + stale: true；
 *   - 不经过 DiagnosisEngine.diagnose / LlmRouter，开监控永不产生 LLM 费用。
 */

import { Router } from 'express';
import { Database } from '../storage/database';
import { DiagnosisEngine } from '../core/diagnosis-engine';
import { logger } from '../utils/logger';

export interface MonitorContext {
  db: Database;
  engine: DiagnosisEngine;
}

const HEALTH_TTL_MS = 60000;

/** 数据源健康的惰性 TTL 缓存（模块级，全进程共享一份探测结果）。 */
let healthCache: { at: number; data: Record<string, unknown> } | null = null;

async function getDatasourceHealth(engine: DiagnosisEngine): Promise<{
  cachedAt: string;
  ttlSeconds: number;
  stale: boolean;
  data: Record<string, unknown> | null;
}> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) {
    return { cachedAt: new Date(healthCache.at).toISOString(), ttlSeconds: HEALTH_TTL_MS / 1000, stale: false, data: healthCache.data };
  }
  try {
    const data = await engine.datasourceHealth();
    healthCache = { at: now, data };
    return { cachedAt: new Date(now).toISOString(), ttlSeconds: HEALTH_TTL_MS / 1000, stale: false, data };
  } catch (e) {
    logger.warn('数据源健康探测失败，返回上次缓存', { error: (e as Error).message });
    if (healthCache) {
      return { cachedAt: new Date(healthCache.at).toISOString(), ttlSeconds: HEALTH_TTL_MS / 1000, stale: true, data: healthCache.data };
    }
    // 无旧缓存时如实返回空，不阻断快照其余部分
    return { cachedAt: new Date(now).toISOString(), ttlSeconds: HEALTH_TTL_MS / 1000, stale: true, data: null };
  }
}

export function createMonitorRouter(ctx: MonitorContext): Router {
  const router = Router();
  const { db, engine } = ctx;

  router.get('/snapshot', async (_req, res) => {
    // 最近 20 条告警
    const alerts = db.listAlerts(20);

    // 进行中的诊断全部 + 最近完成 5 条（轻字段，与 /diagnoses 列表同一裁剪逻辑）
    const { items } = db.listTasks(50, 0);
    const isFinal = (s: string) => s === 'done' || s === 'failed';
    const active = items.filter((t) => !isFinal(t.status));
    const recentDone = items.filter((t) => isFinal(t.status)).slice(0, 5);
    const activeDiagnoses = [...active, ...recentDone].map((t) => ({
      id: t.id,
      status: t.status,
      trigger: t.trigger,
      question: t.question.slice(0, 200),
      serviceName: t.serviceName,
      createdAt: t.createdAt,
      durationMs: t.durationMs,
      severity: t.conclusion?.severity ?? null,
      summary: t.conclusion?.summary ?? null,
      error: t.error,
    }));

    const datasourceHealth = await getDatasourceHealth(engine);

    res.json({
      serverTime: new Date().toISOString(),
      alerts,
      activeDiagnoses,
      datasourceHealth,
    });
  });

  return router;
}
