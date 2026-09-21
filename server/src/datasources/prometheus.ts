/**
 * Prometheus 只读数据源。
 *
 * 安全边界：只调用 /api/v1/query 与 /api/v1/query_range 两个只读端点，
 * 不使用任何 admin API（不 reload、不删 TSDB、不删 series）。
 */

import { PrometheusDatasource, ServiceDef } from '../config/schema';
import { MetricSnapshot } from '../core/types';
import { httpRequest } from './http';
import { logger } from '../utils/logger';

interface PromQueryResult {
  status: string;
  data: {
    resultType: 'vector' | 'matrix' | 'scalar' | 'string';
    result: {
      metric: Record<string, string>;
      value?: [number, string];
      values?: [number, string][];
    }[];
  };
}

export class PrometheusSource {
  readonly id: string;
  private readonly ds: PrometheusDatasource;

  constructor(ds: PrometheusDatasource) {
    this.ds = ds;
    this.id = ds.id;
  }

  private get base(): string {
    return this.ds.url.replace(/\/$/, '');
  }

  private get auth() {
    return { username: this.ds.username, password: this.ds.password };
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      await httpRequest(`${this.base}/-/healthy`, { ...this.auth, timeoutMs: this.ds.timeoutMs });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 执行单条即时查询。 */
  async query(promql: string, time?: string): Promise<MetricSnapshot> {
    const url = new URL(`${this.base}/api/v1/query`);
    url.searchParams.set('query', promql);
    if (time) url.searchParams.set('time', time);

    try {
      const r = await httpRequest<PromQueryResult>(url.toString(), {
        ...this.auth,
        timeoutMs: this.ds.timeoutMs,
      });

      if (r.status !== 'success') {
        return { name: '', promql, values: [], error: `Prometheus 返回 status=${r.status}` };
      }

      const values: { labels: Record<string, string>; value: number }[] = [];
      for (const item of r.data?.result ?? []) {
        if (item.value) {
          const n = Number(item.value[1]);
          if (Number.isFinite(n)) values.push({ labels: item.metric ?? {}, value: n });
        } else if (item.values?.length) {
          // matrix：取最后一个点
          const last = item.values[item.values.length - 1];
          const n = Number(last[1]);
          if (Number.isFinite(n)) values.push({ labels: item.metric ?? {}, value: n });
        }
      }
      return { name: '', promql, values };
    } catch (e) {
      logger.debug('Prometheus 查询失败', { id: this.id, error: (e as Error).message });
      return { name: '', promql, values: [], error: (e as Error).message };
    }
  }

  /** 区间查询（画曲线用）。 */
  async queryRange(
    promql: string,
    start: string,
    end: string,
    step = '60s',
  ): Promise<{ labels: Record<string, string>; points: [number, number][] }[]> {
    const url = new URL(`${this.base}/api/v1/query_range`);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(Math.floor(new Date(start).getTime() / 1000)));
    url.searchParams.set('end', String(Math.floor(new Date(end).getTime() / 1000)));
    url.searchParams.set('step', step);

    const r = await httpRequest<PromQueryResult>(url.toString(), { ...this.auth, timeoutMs: this.ds.timeoutMs });
    if (r.status !== 'success') return [];

    return (r.data?.result ?? []).map((item) => ({
      labels: item.metric ?? {},
      points: (item.values ?? [])
        .map((v) => [Number(v[0]), Number(v[1])] as [number, number])
        .filter(([, n]) => Number.isFinite(n)),
    }));
  }

  /**
   * 按服务注册表的查询模板批量采集指标。
   * 模板里的 {service} {instance} {container} 会被替换。
   */
  async collectForService(service: ServiceDef, at?: string): Promise<MetricSnapshot[]> {
    if (this.ds.queries.length === 0) return [];

    const container = service.deployment.containerNames[0] ?? service.canonicalName;
    const instance = service.prometheusLabels.instance ?? '.*';

    const subst = (promql: string): string =>
      promql
        .replace(/\{service\}/g, service.canonicalName)
        .replace(/\{container\}/g, container)
        .replace(/\{instance\}/g, instance);

    const results = await Promise.allSettled(
      this.ds.queries.map(async (q) => {
        const snap = await this.query(subst(q.promql), at);
        return { ...snap, name: q.name };
      }),
    );

    const out: MetricSnapshot[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.values.length > 0) {
        out.push(r.value);
      } else if (r.status === 'fulfilled' && r.value.error) {
        out.push({ ...r.value, name: r.value.name });
      }
    }
    return out;
  }
}
