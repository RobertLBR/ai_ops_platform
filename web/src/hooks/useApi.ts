/**
 * 共享数据加载 hook。
 *
 * 统一处理 loading / error / 401 三态，避免每个页面重复写。
 * 401 会向上冒泡到 App，触发 Token 设置弹窗。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** 供 mutation 后主动刷新 */
  setData: (v: T) => void;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  onUnauthorized?: () => void,
): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 用 ref 持有最新的 fetcher 与回调，避免它们变化导致无限重取
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcherRef
      .current()
      .then((v) => {
        if (!cancelled) {
          setData(v);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as ApiError;
        if (err.status === 401) unauthRef.current?.();
        setError(err.message || String(e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, reload, setData };
}

/** 提交类操作的 hook（表单、反馈等）。 */
export function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  onUnauthorized?: () => void,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;

  const run = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const r = await fnRef.current(...args);
      setLoading(false);
      return r;
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) unauthRef.current?.();
      setError(err.message || String(e));
      setLoading(false);
      return null;
    }
  }, []);

  return { run, loading, error, setError };
}

/** 严重级别 → antd 颜色 */
export function severityColor(severity: string | null | undefined): string {
  switch (severity) {
    case 'critical':
      return 'red';
    case 'warning':
      return 'orange';
    case 'info':
      return 'blue';
    default:
      return 'default';
  }
}

/** 诊断状态 → 中文 + 颜色 */
export function statusMeta(status: string): { text: string; color: string } {
  switch (status) {
    case 'done':
      return { text: '已完成', color: 'green' };
    case 'failed':
      return { text: '失败', color: 'red' };
    case 'collecting':
      return { text: '取证中', color: 'processing' };
    case 'analyzing':
      return { text: '分析中', color: 'processing' };
    case 'pending':
      return { text: '排队中', color: 'default' };
    default:
      return { text: status, color: 'default' };
  }
}

export function triggerText(trigger: string): string {
  switch (trigger) {
    case 'manual':
      return '手动提问';
    case 'alert':
      return '告警触发';
    case 'schedule':
      return '定时巡检';
    default:
      return trigger;
  }
}

/** 毫秒 → 人类可读耗时 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

/** token 数 → 可读 */
export function formatTokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}
