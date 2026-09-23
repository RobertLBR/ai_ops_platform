/**
 * Elasticsearch 只读数据源。
 *
 * 安全边界：本模块只提供 search / count / mapping / indices 等**只读**能力，
 * 不提供任何写入、删除、索引管理方法。从代码层面保证「只读诊断」承诺。
 * 建议配置中使用 ES 只读账号，从权限层面二次保障。
 */

import { EsDatasource, ServiceDef } from '../config/schema';
import { NormalizedLog } from '../core/types';
import { httpRequest, HttpError } from './http';
import { logger } from '../utils/logger';

export interface EsQueryParams {
  /** 归一化服务定义（决定索引与字段映射） */
  service: ServiceDef;
  from: string; // ISO
  to: string; // ISO
  levels?: string[];
  /** 额外关键词（全文匹配） */
  keyword?: string;
  maxDocs?: number;
}

export interface EsSearchHit {
  _index: string;
  _source: Record<string, unknown>;
}

/** 从嵌套对象里按候选路径列表取第一个存在的值。 */
function pickField(source: Record<string, unknown>, candidates: string[]): unknown {
  for (const path of candidates) {
    // 支持 a.b.c 点路径
    const parts = path.split('.');
    let cur: unknown = source;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

/** 归一化日志级别：各种写法统一到大写标准级别。 */
function normalizeLevel(raw: unknown): string {
  const s = String(raw ?? '').toUpperCase().trim();
  if (['FATAL', 'CRITICAL'].includes(s)) return 'ERROR';
  if (s === 'ERR' || s === 'ERROR') return 'ERROR';
  if (s === 'WARN' || s === 'WARNING') return 'WARN';
  if (s === 'INFO' || s === 'INFORMATION') return 'INFO';
  if (s === 'DEBUG' || s === 'TRACE' || s === 'VERBOSE') return 'DEBUG';
  // 从 message 里兜底猜
  if (/exception|error|\bfatal\b/i.test(s)) return 'ERROR';
  return 'UNKNOWN';
}

export class ElasticsearchSource {
  readonly id: string;
  private readonly ds: EsDatasource;

  constructor(ds: EsDatasource) {
    this.ds = ds;
    this.id = ds.id;
  }

  private get base(): string {
    return this.ds.url.replace(/\/$/, '');
  }

  private get auth() {
    return { username: this.ds.username, password: this.ds.password };
  }

  /** 健康检查（只读）。 */
  async health(): Promise<{ ok: boolean; status?: string; error?: string }> {
    try {
      const r = await httpRequest<{ status: string }>(`${this.base}/_cluster/health`, {
        ...this.auth,
        timeoutMs: this.ds.timeoutMs,
      });
      return { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 解析服务对应的索引列表（服务注册表 indexPatterns 优先，否则用数据源默认）。 */
  private resolveIndices(service: ServiceDef): string {
    const patterns = service.indexPatterns?.length ? service.indexPatterns : this.ds.indices;
    return patterns.join(',');
  }

  /**
   * 查询日志。返回原始 hit（后续由归一化层处理）。
   * 强制 maxDocs 上限，防止打爆 ES 和内存。
   */
  async searchLogs(params: EsQueryParams): Promise<EsSearchHit[]> {
    const index = this.resolveIndices(params.service);
    const size = Math.min(params.maxDocs ?? this.ds.maxDocs, this.ds.maxDocs);
    const fm = params.service.fieldMapping;

    // 构造 bool 查询
    const must: unknown[] = [
      {
        range: {
          // 时间字段名不确定，用第一个候选；ES 通常 @timestamp
          [fm.timestamp[0] ?? '@timestamp']: { gte: params.from, lte: params.to },
        },
      },
    ];

    if (params.levels?.length) {
      // 级别字段可能有多种写法，用 multi_match 或 should
      const levelField = fm.level[0] ?? 'level';
      // ES 中 level 大小写不统一（有的存 'ERROR' 有的存 'error'），terms 是精确匹配，
      // 只发小写会在大写 level 的索引上静默查 0 条 —— 原始值与小写值一并带上（去重）
      const levelValues = [...new Set(params.levels.flatMap((l) => [l, l.toLowerCase()]))];
      must.push({ terms: { [levelField]: levelValues } });
    }

    if (params.keyword?.trim()) {
      must.push({ query_string: { query: params.keyword.trim() } });
    }

    const body = {
      size,
      sort: [{ [fm.timestamp[0] ?? '@timestamp']: { order: 'desc' } }],
      query: { bool: { must } },
      // 只取需要的字段，减少传输量
      _source: true,
    };

    const url = `${this.base}/${encodeURIComponent(index).replace(/%2C/g, ',')}/_search`;
    try {
      const r = await httpRequest<{ hits: { hits: { _index: string; _source: Record<string, unknown> }[] } }>(url, {
        method: 'POST',
        body,
        ...this.auth,
        timeoutMs: this.ds.timeoutMs,
      });
      return (r.hits?.hits ?? []).map((h) => ({ _index: h._index, _source: h._source ?? {} }));
    } catch (e) {
      // 级别 terms 查询常因字段是 text 类型失败，降级重试：去掉 level 过滤，改用全文匹配
      if (e instanceof HttpError && params.levels?.length) {
        logger.warn('ES level terms 查询失败，降级为无级别过滤重试', { id: this.id, error: e.message });
        return this.searchLogs({ ...params, levels: undefined });
      }
      throw e;
    }
  }

  /** 统计某时间段日志条数（探量、基线用）。 */
  async count(service: ServiceDef, from: string, to: string, level?: string): Promise<number> {
    const index = this.resolveIndices(service);
    const fm = service.fieldMapping;
    const must: unknown[] = [
      { range: { [fm.timestamp[0] ?? '@timestamp']: { gte: from, lte: to } } },
    ];
    if (level) {
      must.push({ term: { [fm.level[0] ?? 'level']: level.toLowerCase() } });
    }
    const url = `${this.base}/${index}/_count`;
    const r = await httpRequest<{ count: number }>(url, {
      method: 'POST',
      body: { query: { bool: { must } } },
      ...this.auth,
      timeoutMs: this.ds.timeoutMs,
    });
    return r.count ?? 0;
  }

  /** 获取索引 mapping（用于诊断字段结构、生成服务注册表初稿）。 */
  async getMapping(indexPattern: string): Promise<Record<string, unknown>> {
    const url = `${this.base}/${indexPattern}/_mapping`;
    return httpRequest<Record<string, unknown>>(url, { ...this.auth, timeoutMs: this.ds.timeoutMs });
  }

  /** 列出匹配的索引（探路用）。 */
  async listIndices(pattern = '*'): Promise<string[]> {
    const url = `${this.base}/_cat/indices/${pattern}?format=json`;
    const r = await httpRequest<{ index: string }[]>(url, { ...this.auth, timeoutMs: this.ds.timeoutMs });
    return Array.isArray(r) ? r.map((x) => x.index).filter(Boolean) : [];
  }
}

/**
 * 字段归一化层：把不同服务、不同字段命名的原始 ES 文档，
 * 按服务注册表的 fieldMapping 统一成 NormalizedLog。
 *
 * 这是应对「服务名/级别字段不统一」的核心组件 —— 没有它，
 * AI 拿到的就是一堆字段名各异的噪音。
 */
export function normalizeLog(hit: EsSearchHit, service: ServiceDef): NormalizedLog {
  const src = hit._source;
  const fm = service.fieldMapping;

  const tsRaw = pickField(src, fm.timestamp);
  const message = String(pickField(src, fm.message) ?? '');
  const levelRaw = pickField(src, fm.level);
  const traceId = pickField(src, fm.traceId ?? []);
  const loggerName = pickField(src, fm.logger ?? []);

  // 时间戳兜底
  let timestamp = tsRaw ? new Date(tsRaw as string | number).toISOString() : new Date().toISOString();
  if (timestamp === 'Invalid Date' || Number.isNaN(Date.parse(timestamp))) {
    timestamp = new Date().toISOString();
  }

  return {
    timestamp,
    level: normalizeLevel(levelRaw ?? message),
    message,
    service: service.canonicalName,
    traceId: traceId ? String(traceId) : undefined,
    logger: loggerName ? String(loggerName) : undefined,
    host: pickField(src, ['host.name', 'host', 'hostname', 'agent.hostname']) as string | undefined,
    index: hit._index,
  };
}
