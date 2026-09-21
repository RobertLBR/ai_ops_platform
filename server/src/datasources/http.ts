/**
 * 通用 HTTP 辅助：带超时、Basic Auth、错误包装。
 * 全部数据源只读，因此这里不提供任何写方法。
 */

export interface HttpOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  username?: string;
  password?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function basicAuthHeader(username?: string, password?: string): Record<string, string> {
  if (!username) return {};
  const token = Buffer.from(`${username}:${password ?? ''}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

/** 发起带超时的 HTTP 请求，返回解析后的 JSON（或原始文本）。 */
export async function httpRequest<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...basicAuthHeader(opts.username, opts.password),
      ...(opts.headers ?? {}),
    };
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      bodyText = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method: opts.method ?? (bodyText ? 'POST' : 'GET'),
      headers,
      body: bodyText,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} ${res.statusText} for ${url}`, res.status, text.slice(0, 2000));
    }

    // 尝试解析 JSON，失败则返回原文
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new HttpError(`请求超时（${opts.timeoutMs ?? 15000}ms）：${url}`);
    }
    throw new HttpError(`请求失败：${url} — ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 并发执行多个任务，单个失败不影响其它（返回结果或 Error）。 */
export async function allSettled<T>(tasks: Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(tasks);
}

/** 带超时的 Promise 包装。 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
