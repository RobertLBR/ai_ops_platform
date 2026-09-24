/**
 * API 客户端。
 *
 * Token 存 localStorage，页面加载时读取。若接口返回 401，
 * 弹出输入框让用户填 token（内网自用工具，不做完整登录页）。
 */

import type {
  AiAnalyzeResponse,
  AiGenerationDetail,
  AiGenerationListItem,
  AiSaveResponse,
  AiValidateResult,
  AuditEntry,
  DiagnosisListItem,
  DiagnosisTask,
  InboundAlert,
  MetricsSummary,
  MonitorSnapshot,
  SchedulerStatus,
  ServiceInfo,
} from './types';

const TOKEN_KEY = 'aiops_api_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch (e) {
    throw new ApiError(`网络请求失败：${(e as Error).message}（后端是否已启动？）`);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : '') ||
      `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// 端点封装
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<{ status: string; version: string; uptimeSeconds: number; time: string }>('/health'),

  datasourceHealth: () =>
    request<{
      config: {
        elasticsearch: { id: string; name?: string; url: string; enabled: boolean }[];
        prometheus: { id: string; name?: string; url: string; enabled: boolean }[];
        ssh: { id: string; name?: string; host: string; enabled: boolean }[];
        services: { canonicalName: string; displayName: string; tier: string }[];
      };
      live: Record<string, unknown>;
    }>('/datasources/health'),

  listDiagnoses: (params: { limit?: number; offset?: number; status?: string; service?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    if (params.status) q.set('status', params.status);
    if (params.service) q.set('service', params.service);
    const qs = q.toString();
    return request<{ total: number; limit: number; offset: number; items: DiagnosisListItem[] }>(
      `/diagnoses${qs ? `?${qs}` : ''}`,
    );
  },

  getDiagnosis: (id: string) => request<DiagnosisTask>(`/diagnoses/${encodeURIComponent(id)}`),

  /** 触发诊断。同步等待结果（后端一次诊断约 15-60 秒）。 */
  createDiagnosis: (body: { question: string; serviceName?: string; timeFrom?: string; timeTo?: string }) =>
    request<DiagnosisTask>('/diagnoses', { method: 'POST', body: JSON.stringify(body) }),

  submitFeedback: (id: string, verdict: 'correct' | 'partial' | 'wrong', comment: string) =>
    request<{ ok: boolean }>(`/diagnoses/${encodeURIComponent(id)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ verdict, comment }),
    }),

  promoteToCase: (id: string, body: { title?: string; resolution?: string; owner?: string; validUntil?: string }) =>
    request<{ ok: boolean; caseId: string }>(`/diagnoses/${encodeURIComponent(id)}/promote-to-case`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listServices: () => request<{ total: number; items: ServiceInfo[] }>('/services'),

  listCases: (service?: string, limit = 50) => {
    const q = new URLSearchParams();
    if (service) q.set('service', service);
    q.set('limit', String(limit));
    return request<{ total: number; items: Record<string, unknown>[] }>(`/cases?${q.toString()}`);
  },

  listAlerts: (limit = 50) => request<{ items: InboundAlert[] }>(`/alerts?limit=${limit}`),

  metricsSummary: () => request<MetricsSummary>('/metrics/summary'),

  listAudit: (limit = 100) => request<{ items: AuditEntry[] }>(`/audit?limit=${limit}`),

  schedulerStatus: () => request<SchedulerStatus>('/scheduler/status'),

  /** 安全自检：校验某条命令会不会被只读白名单放行（不执行） */
  checkCommand: (command: string, hostId?: string) =>
    request<{ command: string; allowed: boolean; reason: string; note: string }>('/security/check-command', {
      method: 'POST',
      body: JSON.stringify({ command, hostId }),
    }),

  // -------------------------------------------------------------------------
  // 实时监控（OFF 时不应产生任何调用）
  // -------------------------------------------------------------------------

  monitorSnapshot: (signal?: AbortSignal) => request<MonitorSnapshot>('/monitor/snapshot', { signal }),

  // -------------------------------------------------------------------------
  // AI 服务配置生成
  // -------------------------------------------------------------------------

  aiConfigAnalyze: (body: { logSample: string; userPrompt: string; serviceHint?: string; actor?: string }) =>
    request<AiAnalyzeResponse>('/ai-config/analyze', { method: 'POST', body: JSON.stringify(body) }),

  aiConfigValidate: (service: Record<string, unknown>) =>
    request<AiValidateResult>('/ai-config/validate', { method: 'POST', body: JSON.stringify({ service }) }),

  aiConfigSave: (body: { generationId?: string; service: Record<string, unknown>; mode: 'create' | 'update'; actor?: string }) =>
    request<AiSaveResponse>('/ai-config/save', { method: 'POST', body: JSON.stringify(body) }),

  listAiGenerations: (service?: string, limit = 50) => {
    const q = new URLSearchParams();
    if (service) q.set('service', service);
    q.set('limit', String(limit));
    return request<{ total: number; items: AiGenerationListItem[] }>(`/ai-config/generations?${q.toString()}`);
  },

  getAiGeneration: (id: string) => request<AiGenerationDetail>(`/ai-config/generations/${encodeURIComponent(id)}`),
};
