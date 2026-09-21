/**
 * 跨模块共享类型定义。
 */

// ---------------------------------------------------------------------------
// 归一化日志行（字段归一化层的输出）
// ---------------------------------------------------------------------------
export interface NormalizedLog {
  /** ISO 时间戳 */
  timestamp: string;
  /** 归一化日志级别：ERROR | WARN | INFO | DEBUG | UNKNOWN */
  level: string;
  /** 日志正文 */
  message: string;
  /** 服务规范名（来自服务注册表） */
  service: string;
  traceId?: string;
  logger?: string;
  host?: string;
  /** 原始 ES 文档索引 */
  index?: string;
}

// ---------------------------------------------------------------------------
// 日志模板（压缩层输出）
// ---------------------------------------------------------------------------
export interface LogTemplate {
  id: string;
  /** 模板文本，变量部分为 <*> */
  template: string;
  /** 窗口内命中次数 */
  count: number;
  /** 首次/末次出现时间 */
  firstSeen: string;
  lastSeen: string;
  /** 代表性样本（原文，已脱敏） */
  samples: string[];
  /** 涉及的日志级别 */
  levels: string[];
  /** 是否命中服务注册表中的已知问题 */
  knownIssue?: {
    category: string;
    severity: string;
    cause: string;
    sop: string;
  };
  /** 基线对比：过去 N 天同时段平均次数（无基线数据时为 null） */
  baselineCount?: number | null;
  /** 是否新模板（基线期内从未出现） */
  isNew?: boolean;
}

// ---------------------------------------------------------------------------
// 指标快照
// ---------------------------------------------------------------------------
export interface MetricSnapshot {
  name: string;
  promql: string;
  /** 瞬时值列表（instance -> value） */
  values: { labels: Record<string, string>; value: number }[];
  error?: string;
}

// ---------------------------------------------------------------------------
// AI 诊断结论（结构化输出，事实与推断强制分离）
// ---------------------------------------------------------------------------
export interface DiagnosisConclusion {
  summary: string;
  severity: 'info' | 'warning' | 'critical' | 'unknown';
  confirmed_facts: string[];
  inferences: string[];
  root_cause_candidates: {
    rank: number;
    target: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: string;
  }[];
  checklist: string[];
  /** 只读命令，展示不执行，需人工确认 */
  suggested_commands: string[];
  /** AI 主动声明查不到的信息 —— 比硬猜有价值 */
  data_gaps: string[];
}

// ---------------------------------------------------------------------------
// 诊断任务
// ---------------------------------------------------------------------------
export type DiagnosisStatus = 'pending' | 'collecting' | 'analyzing' | 'done' | 'failed';
export type DiagnosisTrigger = 'manual' | 'alert' | 'schedule';

export interface DiagnosisTask {
  id: string;
  status: DiagnosisStatus;
  trigger: DiagnosisTrigger;
  /** 用户输入或告警原文 */
  question: string;
  /** 解析出的服务规范名（可能为空） */
  serviceName: string | null;
  /** 取证时间窗 */
  timeFrom: string | null;
  timeTo: string | null;
  createdAt: string;
  updatedAt: string;
  /** 耗时（ms），完成后填充 —— 成果度量核心字段 */
  durationMs: number | null;
  error: string | null;

  // 中间产物（JSON 序列化存储）
  logTemplates: LogTemplate[] | null;
  metrics: MetricSnapshot[] | null;
  conclusion: DiagnosisConclusion | null;
  /** 脱敏审计（只记类型与次数） */
  redactionAudit: { rule: string; count: number }[] | null;
  /** token 消耗 —— 成本度量 */
  tokensUsed: { prompt: number; completion: number; model: string } | null;
  /** 人工反馈：采纳情况 —— 准确率度量与知识库迭代输入 */
  feedback: { verdict: 'correct' | 'partial' | 'wrong'; comment: string; at: string } | null;
}

// ---------------------------------------------------------------------------
// 告警（webhook 入站归一化后）
// ---------------------------------------------------------------------------
export interface InboundAlert {
  id: string;
  source: 'alertmanager' | 'feishu' | 'wecom' | 'manual';
  severity: 'info' | 'warning' | 'critical';
  status: 'firing' | 'resolved';
  service: string | null;
  title: string;
  description: string;
  firedAt: string;
  receivedAt: string;
  raw: unknown;
  /** 关联的诊断任务 id（autoDiagnose 时） */
  diagnosisId?: string | null;
  /** 是否被降噪窗口吞掉 */
  deduped?: boolean;
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}
