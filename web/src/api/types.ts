/**
 * 前端类型定义 —— 与后端 server/src/core/types.ts 保持同步。
 * 不直接 import 后端类型，避免跨 workspace 的构建依赖。
 */

export type DiagnosisStatus = 'pending' | 'collecting' | 'analyzing' | 'done' | 'failed';
export type DiagnosisTrigger = 'manual' | 'alert' | 'schedule';
export type Severity = 'info' | 'warning' | 'critical' | 'unknown';

export interface LogTemplate {
  id: string;
  template: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: string[];
  levels: string[];
  knownIssue?: {
    category: string;
    severity: string;
    cause: string;
    sop: string;
  };
  baselineCount?: number | null;
  isNew?: boolean;
}

export interface MetricSnapshot {
  name: string;
  promql: string;
  values: { labels: Record<string, string>; value: number }[];
  error?: string;
}

export interface DiagnosisConclusion {
  summary: string;
  severity: Severity;
  confirmed_facts: string[];
  inferences: string[];
  root_cause_candidates: {
    rank: number;
    target: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: string;
  }[];
  checklist: string[];
  suggested_commands: string[];
  data_gaps: string[];
}

export interface DiagnosisTask {
  id: string;
  status: DiagnosisStatus;
  trigger: DiagnosisTrigger;
  question: string;
  serviceName: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  error: string | null;
  logTemplates: LogTemplate[] | null;
  metrics: MetricSnapshot[] | null;
  conclusion: DiagnosisConclusion | null;
  redactionAudit: { rule: string; count: number }[] | null;
  tokensUsed: { prompt: number; completion: number; model: string } | null;
  feedback: { verdict: 'correct' | 'partial' | 'wrong'; comment: string; at: string } | null;
}

/** 列表接口返回的精简任务对象 */
export interface DiagnosisListItem {
  id: string;
  status: DiagnosisStatus;
  trigger: DiagnosisTrigger;
  question: string;
  serviceName: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  createdAt: string;
  durationMs: number | null;
  severity: Severity | null;
  summary: string | null;
  error: string | null;
  hasFeedback: boolean;
  feedbackVerdict: 'correct' | 'partial' | 'wrong' | null;
}

export interface InboundAlert {
  id: string;
  source: 'alertmanager' | 'feishu' | 'wecom' | 'manual';
  severity: Severity;
  status: 'firing' | 'resolved';
  service: string | null;
  title: string;
  description: string;
  firedAt: string;
  receivedAt: string;
  diagnosisId?: string | null;
  deduped?: boolean;
}

export interface ServiceInfo {
  canonicalName: string;
  displayName: string;
  aliases: string[];
  tier: 'core' | 'important' | 'edge';
  stack: string;
  datasourceId: string;
  indexPatterns: string[];
  dependsOn: string[];
  dependedBy: string[];
  deployment: {
    hostIds: string[];
    containerNames: string[];
    port?: number;
    jenkinsJob: string;
    registry: string;
  };
  knownIssueCount: number;
  knownIssues: { pattern: string; category: string; severity: string; cause: string; sop: string }[];
}

export interface MetricsSummary {
  tasks: { total: number; done: number; failed: number; pending: number };
  accuracy: {
    feedbackCount: number;
    correct: number;
    partial: number;
    wrong: number;
    usefulRate: number | null;
    correctRate: number | null;
  };
  speed: {
    avgDurationMs: number | null;
    avgDurationMinutes: number | null;
    manualBaselineMinutes: number;
    savedMinutes: number | null;
    savedHours: number | null;
  };
  cost: { promptTokens: number; completionTokens: number; totalTokens: number };
  alerts: { total: number; deduped: number; noiseReductionRate: number | null };
  knowledge: { caseCount: number };
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

export interface SchedulerStatus {
  enabled: boolean;
  scanIntervalMinutes: number;
  dailyReportAt: string;
  lastScanAt: string | null;
  lastReportAt: string | null;
  currentlyRunning: boolean;
  reportWebhookConfigured: boolean;
}

// ---------------------------------------------------------------------------
// 实时监控快照（GET /api/monitor/snapshot）
// ---------------------------------------------------------------------------

export interface MonitorDiagnosisItem {
  id: string;
  status: DiagnosisStatus;
  trigger: DiagnosisTrigger;
  question: string;
  serviceName: string | null;
  createdAt: string;
  durationMs: number | null;
  severity: Severity | null;
  summary: string | null;
  error: string | null;
}

export interface MonitorSnapshot {
  serverTime: string;
  alerts: InboundAlert[];
  activeDiagnoses: MonitorDiagnosisItem[];
  datasourceHealth: {
    cachedAt: string;
    ttlSeconds: number;
    stale: boolean;
    data: Record<string, unknown> | null;
  };
}

// ---------------------------------------------------------------------------
// AI 配置生成（/api/ai-config/*）
// ---------------------------------------------------------------------------

export interface AiValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface AiAnalyzeResponse {
  generationId: string;
  draft: Record<string, unknown>;
  explanations: string[];
  errors: string[];
  warnings: string[];
  usage: { prompt: number; completion: number; model: string };
}

export interface AiSaveResponse {
  ok: boolean;
  restartRequired: boolean;
  backupPath: string;
  warnings: string[];
}

export interface AiGenerationListItem {
  id: string;
  createdAt: string;
  actor: string;
  serviceName: string;
  status: 'draft' | 'saved' | 'discarded';
  model: string | null;
  logSamplePreview: string;
  userPrompt: string;
  validation: { errors: string[]; warnings: string[] } | null;
  tokensUsed: { prompt: number; completion: number } | null;
  hasDraft: boolean;
  hasDiff: boolean;
  hasFinal: boolean;
}

export interface AiGenerationDetail {
  id: string;
  createdAt: string;
  actor: string;
  serviceName: string;
  status: 'draft' | 'saved' | 'discarded';
  logSample: string;
  userPrompt: string;
  model: string | null;
  aiRawOutput: string | null;
  draftJson: unknown;
  userEditsDiff: { path: string; from: unknown; to: unknown }[] | null;
  finalJson: unknown;
  validation: { errors: string[]; warnings: string[] } | null;
  tokensUsed: { prompt: number; completion: number } | null;
}
