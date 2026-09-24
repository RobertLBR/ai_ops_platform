/**
 * SSH 只读数据源。
 *
 * 安全边界（代码层强制，不靠约定）：
 *   1. 命令白名单：只有匹配 allowedCommandPrefixes 前缀的命令才允许执行。
 *   2. 危险模式黑名单：命中 blockedPatterns 即拒绝，优先级高于白名单。
 *   3. 拦截 shell 元字符（; && || | > < ` $() 等），杜绝命令注入与重定向。
 *   4. 输出字节上限 + 命令超时。
 *   5. 全量审计：每条命令、结果码、耗时都落审计日志。
 *
 * 所有 AI 生成的"建议命令"只展示不执行，不经过本模块。
 */

import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import { SshDatasource, AppConfig } from '../config/schema';
import { logger } from '../utils/logger';

export interface SshExecResult {
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
  durationMs: number;
  truncated: boolean;
}

export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

/** 文件读取类命令：其绝对路径参数必须落在允许的目录前缀内（防路径穿越读任意文件）。 */
const FILE_READ_COMMANDS = new Set(['cat', 'tail', 'head', 'less', 'more', 'wc', 'grep', 'file', 'stat', 'ls']);

/** docker 子命令中带值的旗标（校验容器名时跳过其值，如 --format '{{.State.Status}}'）。 */
const DOCKER_VALUE_FLAGS = new Set(['--format', '--since', '--until', '--tail', '--filter', '-f', '-n']);

/** POSIX 路径规范化：折叠重复斜杠、解析 '.' 与 '..'（不访问文件系统）。 */
function normalizePosixPath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

/** 从白名单条目推导允许的路径前缀（如 `cat /var/log` → `/var/log`）。 */
export function deriveAllowedPathPrefixes(allowPrefixes: string[]): string[] {
  const out = new Set<string>();
  for (const entry of allowPrefixes) {
    for (const token of entry.trim().split(/\s+/)) {
      if (token.startsWith('/') && !token.includes('..')) {
        out.add(normalizePosixPath(token));
      }
    }
  }
  return [...out];
}

/**
 * 命令安全校验器。独立成类，便于单元测试。
 */
export class CommandGuard {
  private readonly allowPrefixes: string[];
  private readonly blockPatterns: RegExp[];
  private readonly allowedPathPrefixes: string[];

  constructor(
    allowPrefixes: string[],
    blockedPatternStrings: string[],
    /** 允许读取的绝对路径前缀。不传则从白名单条目中的路径参数自动推导。 */
    allowedPathPrefixes?: string[],
  ) {
    this.allowPrefixes = allowPrefixes.map((p) => p.trim()).filter(Boolean);
    this.blockPatterns = [];
    for (const p of blockedPatternStrings) {
      try {
        this.blockPatterns.push(new RegExp(p));
      } catch (e) {
        logger.error('blockedPatterns 正则编译失败，已跳过', { pattern: p, error: (e as Error).message });
      }
    }
    this.allowedPathPrefixes = (allowedPathPrefixes ?? deriveAllowedPathPrefixes(this.allowPrefixes)).map(normalizePosixPath);
  }

  /** 校验绝对路径是否落在允许的前缀目录内（精确等于前缀或在其子路径下）。 */
  private isPathAllowed(p: string): boolean {
    const norm = normalizePosixPath(p);
    return this.allowedPathPrefixes.some((prefix) => norm === prefix || norm.startsWith(prefix.replace(/\/$/, '') + '/'));
  }

  /** 文件读取类命令的路径参数校验（防 `cat /var/log/../../etc/shadow`、`tail -n 50 /etc/shadow`）。 */
  private checkFileReadPaths(tokens: string[]): string | null {
    const cmdName = tokens[0].toLowerCase();
    if (!FILE_READ_COMMANDS.has(cmdName)) return null;
    const paths = tokens.slice(1).filter((t) => t.startsWith('/'));
    if (paths.length === 0) return null;
    if (this.allowedPathPrefixes.length === 0) {
      return `文件读取命令 ${cmdName} 带绝对路径参数，但未配置任何允许的路径前缀（安全默认拒绝）`;
    }
    for (const p of paths) {
      if (!this.isPathAllowed(p)) {
        return `路径 ${p} 不在允许的目录前缀内（${this.allowedPathPrefixes.join(', ')}），已拒绝`;
      }
    }
    return null;
  }

  /** docker logs/inspect 的容器名校验：必须是合法容器名，不得含路径分隔符。 */
  private checkDockerArgs(tokens: string[]): string | null {
    if (tokens[0].toLowerCase() !== 'docker' || tokens.length < 2) return null;
    const sub = tokens[1].toLowerCase();
    if (sub !== 'logs' && sub !== 'inspect') return null;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) {
        // --format=value 形式自包含；--format value 形式跳过下一个旗标值
        if (!t.includes('=') && DOCKER_VALUE_FLAGS.has(t)) i++;
        continue;
      }
      if (!/^[a-zA-Z0-9_.-]+$/.test(t)) {
        return `docker ${sub} 的容器名非法（仅允许 [a-zA-Z0-9_.-]，不得含路径分隔符）：${t}`;
      }
    }
    return null;
  }

  /** 校验命令，返回拒绝原因（null 表示通过）。 */
  check(command: string): string | null {
    const cmd = command.trim();
    if (!cmd) return '空命令';

    // 1. shell 元字符（注入与重定向）—— 最优先拦截
    const meta = /(;|&&|\|\||>|<|`|\$\(|\n)/;
    if (meta.test(cmd)) {
      return `命令含 shell 元字符（; && || > < \` $() 或换行），已拒绝：${cmd}`;
    }
    // 单管道允许（docker logs x | tail 这类只读组合），但需每段都在白名单
    // 为安全起见：一期直接禁止管道，只允许单命令
    if (cmd.includes('|')) {
      return `命令含管道符，一期只允许单条命令：${cmd}`;
    }

    // 2. 路径穿越：任何参数含 '..' 直接拒绝（在黑名单与白名单之前，最高优先级的路径防护）
    const tokens = cmd.split(/\s+/);
    if (tokens.some((t) => t.includes('..'))) {
      return `命令参数含 '..'（疑似路径穿越），已拒绝：${cmd}`;
    }

    // 3. 危险模式黑名单
    for (const re of this.blockPatterns) {
      re.lastIndex = 0;
      if (re.test(cmd)) {
        return `命令命中危险模式（${re.source}），已拒绝：${cmd}`;
      }
    }

    // 4. 白名单前缀
    if (this.allowPrefixes.length === 0) {
      return '未配置任何 allowedCommandPrefixes，安全默认拒绝所有命令';
    }
    const lowered = cmd.toLowerCase();
    const ok = this.allowPrefixes.some((p) => {
      const lp = p.toLowerCase();
      // 允许前缀后以：整串精确相等、空格（独立参数）、tab，或路径分隔符 '/' 接续。
      // 末尾 '/' 用于「目录型白名单」如 `cat /var/log` 放行 `cat /var/log/app/error.log`；
      // 真实路径边界仍由第 5 步 checkFileReadPaths 兜底（必须落在 allowedPathPrefixes 内）。
      return lowered === lp || lowered.startsWith(lp + ' ') || lowered.startsWith(lp + '\t') || lowered.startsWith(lp + '/');
    });
    if (!ok) {
      return `命令不在白名单内，已拒绝：${cmd}`;
    }

    // 5. 文件读取类命令：绝对路径参数必须落在允许的目录前缀内
    const pathReason = this.checkFileReadPaths(tokens);
    if (pathReason) return pathReason;

    // 6. docker logs/inspect：容器名必须为合法标识符，杜绝路径分隔符
    const dockerReason = this.checkDockerArgs(tokens);
    if (dockerReason) return dockerReason;

    return null; // 通过
  }
}

export class SshSource {
  readonly id: string;
  private readonly ds: SshDatasource;
  private readonly guard: CommandGuard;
  private readonly maxOutputBytes: number;
  private readonly commandTimeoutMs: number;

  constructor(ds: SshDatasource, config: AppConfig) {
    this.ds = ds;
    this.id = ds.id;
    // 全局白名单 ∩ 主机级白名单（主机级为空则只用全局）
    const globalAllow = config.security.readonly.allowedCommandPrefixes;
    const hostAllow = ds.allowedCommands.length ? ds.allowedCommands : globalAllow;
    // 取交集：主机白名单里的命令必须也在全局白名单里（若全局非空）
    const effectiveAllow =
      globalAllow.length > 0 && ds.allowedCommands.length > 0
        ? ds.allowedCommands.filter((c) => globalAllow.some((g) => c.startsWith(g) || g.startsWith(c)))
        : hostAllow;

    this.guard = new CommandGuard(effectiveAllow, config.security.readonly.blockedPatterns);
    this.maxOutputBytes = config.security.readonly.maxOutputBytes;
    this.commandTimeoutMs = config.security.readonly.commandTimeoutMs;
  }

  private buildConnectConfig(): ConnectConfig {
    const cfg: ConnectConfig = {
      host: this.ds.host,
      port: this.ds.port,
      username: this.ds.username,
      readyTimeout: this.ds.timeoutMs,
      // 只读诊断，禁用 agent 转发等
      agent: undefined,
    };
    if (this.ds.privateKeyPath) {
      try {
        cfg.privateKey = fs.readFileSync(this.ds.privateKeyPath);
        if (this.ds.passphrase) cfg.passphrase = this.ds.passphrase;
      } catch (e) {
        logger.warn('SSH 私钥读取失败，将回退密码认证', { id: this.id, path: this.ds.privateKeyPath, error: (e as Error).message });
        if (this.ds.password) cfg.password = this.ds.password;
      }
    } else if (this.ds.password) {
      cfg.password = this.ds.password;
    }
    return cfg;
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const conn = new Client();
      const timer = setTimeout(() => {
        conn.end();
        resolve({ ok: false, error: '连接超时' });
      }, this.ds.timeoutMs);

      conn
        .on('ready', () => {
          clearTimeout(timer);
          conn.end();
          resolve({ ok: true });
        })
        .on('error', (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: e.message });
        })
        .connect(this.buildConnectConfig());
    });
  }

  /**
   * 执行单条只读命令。命令先过安全校验，不通过直接抛 CommandRejectedError（不会建立连接）。
   */
  async exec(command: string): Promise<SshExecResult> {
    const reason = this.guard.check(command);
    if (reason) {
      logger.warn('SSH 命令被安全策略拒绝', { id: this.id, reason });
      throw new CommandRejectedError(reason);
    }

    const started = Date.now();
    return new Promise<SshExecResult>((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.end();
        } catch {
          /* ignore */
        }
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`SSH 命令超时（${this.commandTimeoutMs}ms）：${command}`)));
      }, this.commandTimeoutMs + this.ds.timeoutMs);

      conn
        .on('ready', () => {
          conn.exec(command, { pty: false }, (err, stream) => {
            if (err) {
              finish(() => reject(err));
              return;
            }
            let stdout = '';
            let stderr = '';
            let truncated = false;
            let outBytes = 0;

            stream.on('data', (d: Buffer) => {
              outBytes += d.length;
              if (outBytes <= this.maxOutputBytes) stdout += d.toString('utf8');
              else truncated = true;
            });
            stream.stderr.on('data', (d: Buffer) => {
              outBytes += d.length;
              if (outBytes <= this.maxOutputBytes) stderr += d.toString('utf8');
              else truncated = true;
            });
            stream.on('close', (code: number | null, signal?: string) => {
              finish(() =>
                resolve({
                  command,
                  stdout: stdout.slice(0, this.maxOutputBytes),
                  stderr: stderr.slice(0, this.maxOutputBytes),
                  code,
                  signal,
                  durationMs: Date.now() - started,
                  truncated,
                }),
              );
            });
          });
        })
        .on('error', (e) => {
          finish(() => reject(new Error(`SSH 连接失败（${this.ds.host}）：${e.message}`)));
        })
        .connect(this.buildConnectConfig());
    });
  }
}

/** 统一的 tool 接口 —— 为二期 Agent 兜底预留（同一批工具可被流水线或 Agent 复用）。 */
export interface ReadOnlyTool {
  name: string;
  description: string;
}
