/**
 * LLM 分级路由器。
 *
 * 设计要点：
 *   1. 统一走 OpenAI 兼容协议（DeepSeek / 通义千问 / 智谱 / 本地 vLLM+Ollama 均兼容），
 *      将来换模型只改配置，不改代码。
 *   2. 按任务档位路由：reasoning（根因推理）/ light（归一化清洗）/ report（复盘报告）。
 *   3. 强制 JSON 结构化输出：运维场景最危险的是模型把推测说得像已确认事实，
 *      所以输出 schema 固定包含 confirmed_facts / inferences / data_gaps。
 *   4. 内置重试与超时；token 用量回传，用于成本度量。
 */

import { createHash } from 'node:crypto';
import { AppConfig } from '../config/schema';
import { httpRequest, HttpError } from '../datasources/http';
import { logger } from '../utils/logger';

export type LlmTier = 'reasoning' | 'light' | 'report';

export interface LlmUsage {
  prompt: number;
  completion: number;
  total: number;
  model: string;
  provider: string;
  tier: LlmTier;
  cached: boolean;
}

export interface LlmResponse {
  content: string;
  usage: LlmUsage;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  // DeepSeek reasoner 会把推理过程放这里
  reasoning_content?: string;
}

/** 极简内存缓存：相同输入短期内复用，避免重复付费。 */
class ResponseCache {
  private readonly map = new Map<string, { at: number; value: LlmResponse }>();
  constructor(private readonly ttlMs: number) {}

  get(key: string): LlmResponse | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return { ...hit.value, usage: { ...hit.value.usage, cached: true } };
  }

  set(key: string, value: LlmResponse): void {
    // 控制缓存规模，防止长期运行内存膨胀
    if (this.map.size > 500) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, { at: Date.now(), value });
  }

  static hash(input: string): string {
    // 非加密用途，仅做缓存键；djb2 在长 prompt 上碰撞率不可控，改用 SHA-256
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }
}

export class LlmRouter {
  private readonly config: AppConfig;
  private readonly cache: ResponseCache;

  constructor(config: AppConfig) {
    this.config = config;
    this.cache = new ResponseCache((config.ai.limits.cacheTtlSeconds ?? 600) * 1000);
  }

  /** 检查路由配置是否可用（provider 存在且有 apiKey）。 */
  validate(): string[] {
    const problems: string[] = [];
    for (const tier of ['reasoning', 'light', 'report'] as LlmTier[]) {
      const route = this.config.ai.routing[tier];
      const provider = this.config.ai.providers[route.provider];
      if (!provider) {
        problems.push(`ai.routing.${tier} 指向未定义的 provider "${route.provider}"`);
      } else if (!provider.apiKey && !/127\.0\.0\.1|localhost/.test(provider.baseUrl)) {
        problems.push(`provider "${route.provider}" 未配置 apiKey（本地模型可留空）`);
      }
    }
    return problems;
  }

  /** 发起一次对话补全。 */
  async chat(
    tier: LlmTier,
    messages: ChatMessage[],
    opts: { json?: boolean; temperature?: number; maxTokens?: number } = {},
  ): Promise<LlmResponse> {
    const route = this.config.ai.routing[tier];
    const provider = this.config.ai.providers[route.provider];
    if (!provider) throw new Error(`未定义的 AI provider: ${route.provider}（检查 ai.routing.${tier}）`);
    if (!provider.apiKey && !/127\.0\.0\.1|localhost/.test(provider.baseUrl)) {
      throw new Error(`provider "${route.provider}" 缺少 apiKey，请设置对应环境变量`);
    }

    const cacheKey =
      tier +
      '|' +
      route.model +
      '|' +
      (opts.temperature ?? route.temperature) +
      '|' +
      // maxTokens 影响输出（太小会被截断），必须计入缓存键，避免命中被截断的旧结果
      (opts.maxTokens ?? route.maxTokens) +
      '|' +
      ResponseCache.hash(messages.map((m) => m.role + ':' + m.content).join('\n---\n'));

    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.debug('LLM 缓存命中', { tier, model: route.model });
      return cached;
    }

    const maxRetries = this.config.ai.limits.maxRetries ?? 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model: route.model,
          messages,
          temperature: opts.temperature ?? route.temperature,
          max_tokens: opts.maxTokens ?? route.maxTokens,
        };
        if (opts.json) {
          body.response_format = { type: 'json_object' };
        }

        const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
        const res = await httpRequest<OpenAiChatResponse>(url, {
          method: 'POST',
          body,
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeoutMs: provider.timeoutMs,
        });

        const content = res.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) {
          throw new Error('模型返回空内容');
        }

        const usage: LlmUsage = {
          prompt: res.usage?.prompt_tokens ?? 0,
          completion: res.usage?.completion_tokens ?? 0,
          total: res.usage?.total_tokens ?? 0,
          model: res.model ?? route.model,
          provider: route.provider,
          tier,
          cached: false,
        };

        const out: LlmResponse = { content, usage };
        this.cache.set(cacheKey, out);

        logger.info('LLM 调用完成', {
          tier,
          model: usage.model,
          promptTokens: usage.prompt,
          completionTokens: usage.completion,
        });
        return out;
      } catch (e) {
        lastError = e as Error;
        const status = e instanceof HttpError ? e.status : undefined;
        // 4xx（除 429）不重试：配置或请求本身有问题
        if (status && status >= 400 && status < 500 && status !== 429) {
          logger.error('LLM 调用失败（不重试）', { tier, status, error: lastError.message });
          throw lastError;
        }
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          logger.warn('LLM 调用失败，准备重试', { tier, attempt: attempt + 1, delayMs: delay, error: lastError.message });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error('LLM 调用失败');
  }

  /**
   * 要求模型返回 JSON 并解析。解析失败时做一次"修复重试"（让模型自己修正 JSON）。
   * 修复重试会把输入中的日志样本砍半（降低输入 token、减少再次被截断的概率），
   * 并把 maxTokens 放大 1.5 倍（配置无更上层的 provider 上限，1.5 倍即封顶）。
   */
  async chatJson<T>(tier: LlmTier, messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<{ data: T; usage: LlmUsage }> {
    const res = await this.chat(tier, messages, { ...opts, json: true });
    const parsed = tryParseJson<T>(res.content);
    if (parsed.ok) return { data: parsed.value as T, usage: res.usage };

    // 修复重试：把模型自己的输出连同错误信息发回去；样本砍半 + maxTokens ×1.5
    logger.warn('LLM 返回非法 JSON，尝试修复（样本减半、maxTokens ×1.5）', { tier, error: parsed.error });
    const baseMaxTokens = opts?.maxTokens ?? this.config.ai.routing[tier].maxTokens;
    const retryMaxTokens = Math.round(baseMaxTokens * 1.5);
    const fixMessages: ChatMessage[] = [
      ...halveSampleLines(messages),
      { role: 'assistant', content: res.content.slice(0, 8000) },
      {
        role: 'user',
        content:
          '你上一条回复不是合法 JSON，解析失败：' +
          parsed.error +
          '\n请只输出修正后的合法 JSON，不要包含 markdown 代码块标记、注释或任何额外文本。',
      },
    ];
    const res2 = await this.chat(tier, fixMessages, { ...opts, maxTokens: retryMaxTokens, json: true });
    const parsed2 = tryParseJson<T>(res2.content);
    if (parsed2.ok) {
      return {
        data: parsed2.value as T,
        usage: {
          prompt: res.usage.prompt + res2.usage.prompt,
          completion: res.usage.completion + res2.usage.completion,
          total: res.usage.total + res2.usage.total,
          model: res2.usage.model,
          provider: res2.usage.provider,
          tier,
          cached: false,
        },
      };
    }
    throw new Error('LLM 两次均未返回合法 JSON：' + parsed2.error);
  }
}

/** 修复重试时压缩输入：把 user 消息中的「样本:」行砍掉一半（保留前半），降低输入 token。 */
function halveSampleLines(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user') return m;
    const lines = m.content.split('\n');
    const sampleIdx = lines.map((l, i) => (/^\s*样本[:：]/.test(l) ? i : -1)).filter((i) => i >= 0);
    if (sampleIdx.length <= 1) return m;
    const drop = new Set(sampleIdx.slice(Math.ceil(sampleIdx.length / 2)));
    return { ...m, content: lines.filter((_l, i) => !drop.has(i)).join('\n') };
  });
}

/** 容错 JSON 解析：剥掉 markdown 围栏、截取第一个 { 到最后一个 }。 */
export function tryParseJson<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  const t = text.trim();
  // 去掉 ```json ... ``` 围栏
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const candidate = fenced ? fenced[1].trim() : t;

  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch (e1) {
    // 截取最外层花括号
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) as T };
      } catch (e2) {
        return { ok: false, error: (e2 as Error).message };
      }
    }
    return { ok: false, error: (e1 as Error).message };
  }
}
