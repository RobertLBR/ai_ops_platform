/**
 * 实时监控状态引擎（设计文档 1.4）。
 *
 * 行为要点：
 *   1. 开关持久化 localStorage['aiops_monitor_enabled']，缺省 OFF；
 *      写入时经 BroadcastChannel 广播，全 tab 同步。
 *   2. 领导者选举：BroadcastChannel('aiops-monitor')，tabId（crypto.randomUUID）
 *      字典序最小者为 leader；leader 每 10s 心跳；超过 15s 无心跳重新选举；
 *      leader 关闭时 beforeunload 发 resign 让继任者立即接管。
 *      —— 只有 leader 真正发请求，N 个 tab 不产生 N 倍轮询。
 *   3. 轮询（仅 leader）：setTimeout 递归 5s（不用 setInterval，避免请求重叠）；
 *      失败指数退避 5→10→20→40→60s 封顶，成功复位；快照经 channel 广播给 follower。
 *   4. 清理：useEffect return 清定时器 + AbortController 取消在途 + channel.close()；
 *      OFF 时无任何请求、无轮询/看门狗定时器、无心跳（只保留 message listener
 *      以同步其他 tab 的开关变化）。
 *   5. 401 冒泡现有 onUnauthorized（Token 弹窗），轮询按失败退避，token 更新后自动恢复。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MonitorSnapshot } from '../api/types';

const LS_KEY = 'aiops_monitor_enabled';
const CHANNEL_NAME = 'aiops-monitor';

const POLL_OK_MS = 5000;
const BACKOFF_MS = [10000, 20000, 40000, 60000]; // 失败后的退避序列（封顶 60s）
const HEARTBEAT_MS = 10000;
const LEADER_TIMEOUT_MS = 15000;
const WATCHDOG_MS = 1000;

type ChannelMsg =
  | { type: 'claim'; tabId: string }
  | { type: 'heartbeat'; tabId: string }
  | { type: 'resign'; tabId: string }
  | { type: 'enabled'; value: boolean }
  | { type: 'snapshot'; data: MonitorSnapshot };

export interface UseMonitorResult {
  /** 当前开关（leader 选举后全 tab 一致） */
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  snapshot: MonitorSnapshot | null;
  /** 最近一次快照到达时间（作为页面的 liveTick 版本号） */
  lastPolledAt: number | null;
  /** 连续失败中（退避期间为 true） */
  failing: boolean;
  /** 本 tab 是否为当前轮询 leader（展示用） */
  isLeader: boolean;
}

export function useMonitor(onUnauthorized?: () => void): UseMonitorResult {
  const [enabled, setEnabledState] = useState<boolean>(() => localStorage.getItem(LS_KEY) === '1');
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [failing, setFailing] = useState(false);
  const [isLeader, setIsLeader] = useState(false);

  const tabIdRef = useRef<string>(crypto.randomUUID());
  const channelRef = useRef<BroadcastChannel | null>(null);
  /** 近 15s 内在频道里说过话的 tabId（claim/heartbeat），选举候选集 */
  const speakersRef = useRef<Map<string, number>>(new Map());
  const leaderRef = useRef<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef(false);
  const failCountRef = useRef(0);

  // 全部可变状态走 ref：挂载 effect 的首帧闭包可永久安全工作
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const unauthRef = useRef(onUnauthorized);
  unauthRef.current = onUnauthorized;

  const post = (msg: ChannelMsg): void => {
    try {
      channelRef.current?.postMessage(msg);
    } catch {
      /* channel 已关闭等场景忽略 */
    }
  };

  // -------------------------------------------------------------------------
  // 轮询（仅 leader 调用）
  // -------------------------------------------------------------------------

  const scheduleNext = (delay: number): void => {
    if (!pollingRef.current) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      void pollOnce();
    }, delay);
  };

  const pollOnce = async (): Promise<void> => {
    if (!pollingRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const snap = await api.monitorSnapshot(ctrl.signal);
      if (!pollingRef.current || ctrl.signal.aborted) return;
      failCountRef.current = 0;
      setFailing(false);
      setSnapshot(snap);
      setLastPolledAt(Date.now());
      // 本 tab 与 follower 统一经频道消息入口更新（follower 在 onmessage 里 setState）
      post({ type: 'snapshot', data: snap });
      scheduleNext(POLL_OK_MS);
    } catch (e) {
      if (!pollingRef.current || ctrl.signal.aborted) return;
      const err = e as ApiError;
      if (err.status === 401) unauthRef.current?.();
      failCountRef.current += 1;
      setFailing(true);
      scheduleNext(BACKOFF_MS[Math.min(failCountRef.current - 1, BACKOFF_MS.length - 1)]);
    }
  };

  const startPolling = (): void => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    failCountRef.current = 0;
    void pollOnce(); // 成为 leader 立即取一帧，不等 5s
  };

  const stopPolling = (): void => {
    pollingRef.current = false;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const startHeartbeat = (): void => {
    if (heartbeatTimerRef.current) return;
    heartbeatTimerRef.current = setInterval(() => {
      post({ type: 'heartbeat', tabId: tabIdRef.current });
    }, HEARTBEAT_MS);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  // -------------------------------------------------------------------------
  // 选举：近 15s 说过话的 tab + 自己，tabId 字典序最小者为 leader
  // -------------------------------------------------------------------------

  const electAndApply = (): void => {
    const now = Date.now();
    for (const [id, at] of speakersRef.current) {
      if (now - at > LEADER_TIMEOUT_MS) speakersRef.current.delete(id);
    }
    const candidates = [tabIdRef.current, ...speakersRef.current.keys()].sort();
    const leader = candidates[0];
    const changed = leaderRef.current !== leader;
    leaderRef.current = leader;
    setIsLeader(leader === tabIdRef.current);

    if (!changed && pollingRef.current === (leader === tabIdRef.current && enabledRef.current)) {
      return; // 状态已一致，避免重复启停
    }
    if (enabledRef.current && leader === tabIdRef.current) {
      startPolling();
      startHeartbeat();
    } else {
      stopPolling();
      stopHeartbeat();
    }
  };

  // -------------------------------------------------------------------------
  // 频道生命周期（仅挂载/卸载一次）
  // -------------------------------------------------------------------------

  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      ch = null;
    }
    channelRef.current = ch;

    if (!ch) {
      // 浏览器不支持 BroadcastChannel：退化为本 tab 独立轮询（不 dedup）
      leaderRef.current = tabIdRef.current;
      setIsLeader(true);
      electAndApply();
      return () => {
        stopPolling();
        stopHeartbeat();
      };
    }

    const onMsg = (ev: MessageEvent<ChannelMsg>): void => {
      const msg = ev.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'claim':
        case 'heartbeat':
          speakersRef.current.set(msg.tabId, Date.now());
          electAndApply();
          break;
        case 'resign':
          speakersRef.current.delete(msg.tabId);
          electAndApply();
          break;
        case 'enabled':
          localStorage.setItem(LS_KEY, msg.value ? '1' : '0');
          setEnabledState(msg.value);
          break;
        case 'snapshot':
          setSnapshot(msg.data);
          setLastPolledAt(Date.now());
          setFailing(false);
          break;
      }
    };
    ch.addEventListener('message', onMsg);

    // 加入即宣告：触发既有 tab 重新选举（新 tab tabId 更小则接管）
    post({ type: 'claim', tabId: tabIdRef.current });
    electAndApply();

    const onUnload = (): void => post({ type: 'resign', tabId: tabIdRef.current });
    window.addEventListener('beforeunload', onUnload);

    return () => {
      window.removeEventListener('beforeunload', onUnload);
      ch.removeEventListener('message', onMsg);
      post({ type: 'resign', tabId: tabIdRef.current });
      stopPolling();
      stopHeartbeat();
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      ch.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // 开关变化：ON 启动看门狗 + 按当前选举结果启停轮询；OFF 停一切（只留 listener）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) {
      stopPolling();
      stopHeartbeat();
      setFailing(false);
      return;
    }
    electAndApply();
    watchdogTimerRef.current = setInterval(() => {
      // leader 超时（>15s 无心跳）会被剪除并触发重选，继任者立即接管
      const before = leaderRef.current;
      electAndApply();
      void before;
    }, WATCHDOG_MS);
    return () => {
      if (watchdogTimerRef.current) {
        clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const setEnabled = useCallback((v: boolean) => {
    localStorage.setItem(LS_KEY, v ? '1' : '0');
    setEnabledState(v);
    post({ type: 'enabled', value: v });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { enabled, setEnabled, snapshot, lastPolledAt, failing, isLeader };
}
