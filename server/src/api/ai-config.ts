/**
 * AI 服务配置生成路由（设计文档第二部分）。
 *
 * 三个独立端点 + 两个谱系查询：
 *   POST /analyze    —— 唯一花钱的端点（light 档 LLM），限流 10 次/分钟
 *   POST /validate   —— 纯本地校验，免费，供前端编辑期实时调用
 *   POST /save       —— 重校验 + 备份 + 写回 config.yaml + 热生效 + 审计指针
 *   GET  /generations、/generations/:id —— 生成谱系查询（审计展示）
 *
 * 安全性质：
 *   - 全部端点走 authMiddleware（在 routes.ts 挂载处统一施加）
 *   - 日志样例与用户要求「先 redactor 再出网/落库」（与修复 F7 同模式）
 *   - save 不信任客户端：服务端重新完整校验 + create/update 冲突检查
 */

import { Router } from 'express';
import { AppConfig } from '../config/schema';
import { Database } from '../storage/database';
import { LlmRouter } from '../ai/llm-router';
import { Redactor } from '../core/redaction';
import { validateGeneratedService, diffObjects } from '../config/service-validator';
import { saveServiceToConfig } from '../config/writer';
import { buildServiceConfigPrompt, sanitizeGeneratedService } from '../ai/prompts';
import { AiConfigGeneration } from '../core/types';
import { logger } from '../utils/logger';

export interface AiConfigContext {
  config: AppConfig;
  configPath: string;
  db: Database;
  llm: LlmRouter;
  redactor: Redactor;
}

// ---------------------------------------------------------------------------
// 输入预处理
// ---------------------------------------------------------------------------

const MAX_SAMPLE_LINES = 50;
const MAX_SAMPLE_BYTES = 8192;
const ANALYZE_RATE_LIMIT = 10; // 次/分钟（进程内滑动窗口，防误点连击烧 token）

/** 进程内滑动窗口限流（单用户内网工具，不做跨用户配额）。 */
const analyzeHits: number[] = [];
function rateLimitAnalyze(): boolean {
  const now = Date.now();
  while (analyzeHits.length && now - analyzeHits[0] > 60000) analyzeHits.shift();
  if (analyzeHits.length >= ANALYZE_RATE_LIMIT) return false;
  analyzeHits.push(now);
  return true;
}

/** 连续重复行折叠为「×N」，返回折叠后的行数组。 */
function foldDuplicateLines(lines: string[]): string[] {
  const out: string[] = [];
  let prev = '';
  let count = 0;
  const flush = () => {
    if (count === 0) return;
    out.push(count > 1 ? `${prev}  【连续重复 ×${count}】` : prev);
  };
  for (const line of lines) {
    if (line === prev) {
      count++;
      continue;
    }
    flush();
    prev = line;
    count = 1;
  }
  flush();
  return out;
}

/** 日志样例截断：连续重复行折叠 → ≤50 行 → ≤8KB。返回截断结果与是否发生了截断。 */
function truncateSample(raw: string): { text: string; truncated: boolean } {
  let lines = foldDuplicateLines(raw.split('\n').map((l) => l.slice(0, 1000)));
  let truncated = false;
  if (lines.length > MAX_SAMPLE_LINES) {
    lines = lines.slice(0, MAX_SAMPLE_LINES);
    truncated = true;
  }
  let text = lines.join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_SAMPLE_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, MAX_SAMPLE_BYTES).toString('utf8');
    truncated = true;
  }
  if (truncated) text += '\n…（样例已截断：限 50 行 / 8KB）';
  return { text, truncated };
}

/** 从日志样例中提取字段名集合：JSON 行递归取键（含点路径），辅以 key= / "key": 正则。 */
export function extractFieldNames(sample: string): string[] {
  const fields = new Set<string>();

  const walkJson = (v: unknown, prefix: string, depth: number): void => {
    if (depth > 3 || !v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      fields.add(path);
      if (val && typeof val === 'object') walkJson(val, path, depth + 1);
    }
  };

  for (const line of sample.split('\n')) {
    const t = line.trim();
    // 整行 JSON
    if (t.startsWith('{')) {
      try {
        walkJson(JSON.parse(t), '', 0);
        continue;
      } catch {
        // 行内嵌 JSON 片段：找第一个 { 尝试解析
        const start = t.indexOf('{');
        try {
          walkJson(JSON.parse(t.slice(start)), '', 0);
        } catch {
          /* 非 JSON 行，走正则兜底 */
        }
      }
    }
    // logfmt / 文本兜底：key=、"key":、key:
    const re = /"?([A-Za-z_@][\w.@]{0,60})"?\s*[:=]\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      fields.add(m[1]);
    }
  }

  return [...fields].sort().slice(0, 200);
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function createAiConfigRouter(ctx: AiConfigContext): Router {
  const router = Router();
  const { config, db, llm, redactor } = ctx;

  /** POST /analyze —— 调 LLM 生成服务配置草稿（唯一花钱的端点）。 */
  router.post('/analyze', async (req, res) => {
    if (!rateLimitAnalyze()) {
      res.status(429).json({ error: 'rate_limited', message: `analyze 限流：每分钟最多 ${ANALYZE_RATE_LIMIT} 次，请稍后再试` });
      return;
    }

    const userPromptRaw = String(req.body?.userPrompt ?? '').trim();
    const logSampleRaw = String(req.body?.logSample ?? '').trim();
    const serviceHint = req.body?.serviceHint ? String(req.body.serviceHint).trim() : undefined;
    const actor = String(req.body?.actor ?? 'user');

    if (!userPromptRaw) {
      res.status(400).json({ error: 'bad_request', message: 'userPrompt（用户要求）不能为空' });
      return;
    }
    if (!logSampleRaw) {
      res.status(400).json({ error: 'bad_request', message: 'logSample（日志样例）不能为空：字段映射必须依据真实样例生成，不允许凭空猜测' });
      return;
    }

    try {
      // ① 输入截断（行数/字节/连续重复行折叠）
      const { text: sampleTruncated } = truncateSample(logSampleRaw);

      // ② 先脱敏再出网/落库（合规闸口）
      const sampleRedact = redactor.redact(sampleTruncated);
      const promptRedact = redactor.redact(userPromptRaw.slice(0, 2000));
      const totalRedacted = sampleRedact.totalRedacted + promptRedact.totalRedacted;
      if (totalRedacted > 0) {
        logger.info('AI 配置生成输入已脱敏', { redacted: totalRedacted });
      }

      // ③ 提取样例字段名（供 prompt 与 B1/B6 校验）
      const fieldNames = extractFieldNames(sampleRedact.text);

      // ④ 构建 prompt + 调 light 档 LLM
      const { system, user } = buildServiceConfigPrompt({
        logSample: sampleRedact.text,
        userPrompt: promptRedact.text,
        serviceHint,
        fieldNames,
        existingServices: config.services.map((s) => s.canonicalName),
        datasources: config.datasources.elasticsearch
          .filter((d) => d.enabled)
          .map((d) => ({ id: d.id, indices: d.indices })),
        config,
      });

      const { data, usage } = await llm.chatJson<unknown>('light', [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { maxTokens: 2000 });

      // ⑤ 结构清洗 → ⑥ 三层校验
      const { service, explanations } = sanitizeGeneratedService(data);
      const result = validateGeneratedService(service, {
        config,
        sampleFieldNames: fieldNames,
        logSample: sampleRedact.text,
      });

      // ⑦ 落 generation（draft）
      const id = genId('aicfg');
      const generation: AiConfigGeneration = {
        id,
        createdAt: new Date().toISOString(),
        actor,
        serviceName: String(service.canonicalName ?? serviceHint ?? '(unknown)'),
        status: 'draft',
        logSample: sampleRedact.text,
        userPrompt: promptRedact.text,
        model: usage.model,
        aiRawOutput: JSON.stringify(data).slice(0, 16000),
        draftJson: service,
        userEditsDiff: null,
        finalJson: null,
        validation: { errors: result.errors, warnings: result.warnings },
        tokensUsed: { prompt: usage.prompt, completion: usage.completion },
      };
      db.insertGeneration(generation);

      logger.info('AI 服务配置草稿已生成', {
        generationId: id,
        service: generation.serviceName,
        errors: result.errors.length,
        warnings: result.warnings.length,
        tokens: usage.total,
      });

      res.json({
        generationId: id,
        draft: service,
        explanations,
        errors: result.errors,
        warnings: result.warnings,
        usage: { prompt: usage.prompt, completion: usage.completion, model: usage.model },
      });
    } catch (e) {
      logger.error('AI 配置生成失败', { error: (e as Error).message });
      res.status(502).json({ error: 'llm_failed', message: `AI 生成失败：${(e as Error).message}` });
    }
  });

  /** POST /validate —— 纯本地校验（免费），供前端编辑期实时调用。 */
  router.post('/validate', (req, res) => {
    const service = req.body?.service;
    if (!service || typeof service !== 'object') {
      res.status(400).json({ error: 'bad_request', message: 'service 必须是一个 JSON 对象' });
      return;
    }
    // 无样例上下文：B1/B6 自动降级为 warning
    const result = validateGeneratedService(service, { config });
    res.json({ ok: result.errors.length === 0, errors: result.errors, warnings: result.warnings });
  });

  /** POST /save —— 重校验 + 备份 + 写回 config.yaml + 热生效 + 审计指针。 */
  router.post('/save', (req, res) => {
    const service = req.body?.service;
    const mode = String(req.body?.mode ?? '');
    const generationId = req.body?.generationId ? String(req.body.generationId) : null;
    const actor = String(req.body?.actor ?? 'user');

    if (!service || typeof service !== 'object') {
      res.status(400).json({ error: 'bad_request', message: 'service 必须是一个 JSON 对象' });
      return;
    }
    if (mode !== 'create' && mode !== 'update') {
      res.status(400).json({ error: 'bad_request', message: 'mode 必须是 create | update' });
      return;
    }

    // ① 服务端重新完整校验（不信任客户端）
    const result = validateGeneratedService(service, { config });
    if (result.errors.length > 0 || !result.value) {
      res.status(400).json({ error: 'validation_failed', message: '配置未通过服务端校验，已拒绝保存', errors: result.errors, warnings: result.warnings });
      return;
    }
    const value = result.value;

    // ② canonicalName 冲突检查
    const exists = config.services.some((s) => s.canonicalName === value.canonicalName);
    if (mode === 'create' && exists) {
      res.status(409).json({ error: 'conflict', message: `服务 "${value.canonicalName}" 已存在，新增被拒绝（如需覆盖请用 update 模式）` });
      return;
    }
    if (mode === 'update' && !exists) {
      res.status(404).json({ error: 'not_found', message: `服务 "${value.canonicalName}" 不存在，更新被拒绝（如需新增请用 create 模式）` });
      return;
    }

    // ③ datasourceId 必须属于已启用 ES 源（B7 已覆盖，这里再挡一道——热生效的前提）
    const ds = config.datasources.elasticsearch.find((d) => d.id === value.datasourceId && d.enabled);
    if (!ds) {
      res.status(400).json({ error: 'bad_datasource', message: `datasourceId "${value.datasourceId}" 不属于任何已启用的 ES 数据源，无法热生效，已拒绝保存` });
      return;
    }

    // ④⑤⑥ 备份 + 写回 + 热生效（先写文件成功再改内存，由 writer 保证顺序）
    let saved;
    try {
      saved = saveServiceToConfig(ctx.configPath, config, value, mode);
    } catch (e) {
      logger.error('配置写回失败', { service: value.canonicalName, error: (e as Error).message });
      res.status(500).json({ error: 'write_failed', message: `写回 config.yaml 失败：${(e as Error).message}（内存配置未变更，文件未被替换）` });
      return;
    }

    // ⑦ generation 落 final_json / user_edits_diff / saved
    if (generationId) {
      const gen = db.getGeneration(generationId);
      if (gen) {
        const diff = gen.draftJson ? diffObjects(gen.draftJson, value) : null;
        db.updateGeneration(generationId, {
          status: 'saved',
          finalJson: value,
          userEditsDiff: diff,
          validation: { errors: result.errors, warnings: result.warnings },
        });
      } else {
        logger.warn('save 引用的 generationId 不存在，仅保存配置', { generationId });
      }
    }

    // 审计指针（证据链：audit → generationId → 完整谱系）+ 配置变更记录
    const nowIso = new Date().toISOString();
    db.insertAudit({
      id: `aud_${Date.now().toString(36)}`,
      at: nowIso,
      actor,
      action: 'ai_config.saved',
      target: value.canonicalName,
      detail: { generationId },
    });
    db.insertAudit({
      id: `aud_${Date.now().toString(36)}_w`,
      at: nowIso,
      actor,
      action: 'config.service.saved',
      target: value.canonicalName,
      detail: { mode, backupPath: saved.backupPath, warnings: result.warnings.length },
    });

    logger.info('服务配置已保存并热生效', { service: value.canonicalName, mode, actor, generationId });

    res.json({ ok: true, restartRequired: saved.restartRequired, backupPath: saved.backupPath, warnings: result.warnings });
  });

  /** GET /generations —— 生成谱系查询（列表裁剪大字段）。 */
  router.get('/generations', (req, res) => {
    const serviceName = req.query.service ? String(req.query.service) : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const items = db.listGenerations(serviceName, limit).map((g) => ({
      id: g.id,
      createdAt: g.createdAt,
      actor: g.actor,
      serviceName: g.serviceName,
      status: g.status,
      model: g.model,
      logSamplePreview: g.logSample.slice(0, 200),
      userPrompt: g.userPrompt.slice(0, 300),
      validation: g.validation,
      tokensUsed: g.tokensUsed,
      hasDraft: g.draftJson !== null,
      hasDiff: g.userEditsDiff !== null,
      hasFinal: g.finalJson !== null,
    }));
    res.json({ total: items.length, items });
  });

  /** GET /generations/:id —— 单条生成记录全文（含样例/原始输出/diff）。 */
  router.get('/generations/:id', (req, res) => {
    const g = db.getGeneration(req.params.id);
    if (!g) {
      res.status(404).json({ error: 'not_found', message: `生成记录 ${req.params.id} 不存在` });
      return;
    }
    res.json(g);
  });

  return router;
}
