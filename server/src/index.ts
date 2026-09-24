/**
 * 应用入口。
 *
 * 启动顺序（顺序有意义，不要随意调整）：
 *   1. 加载并校验配置 —— 配置错就立刻失败退出，不要带病启动
 *   2. 初始化数据库
 *   3. 构建脱敏器（合规闸口，必须在诊断引擎之前就绪）
 *   4. 构建 LLM 路由器并校验 provider 配置
 *   5. 构建诊断引擎
 *   6. 挂载 API + 静态前端
 *   7. 启动调度器
 *
 * 优雅退出：SIGTERM/SIGINT 时关闭 HTTP、停止调度器、关闭数据库，
 * 避免 Docker stop 时 WAL 未落盘导致数据损坏。
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config/schema';
import { Database } from './storage/database';
import { createRedactor } from './core/redaction';
import { LlmRouter } from './ai/llm-router';
import { DiagnosisEngine } from './core/diagnosis-engine';
import { Scheduler } from './core/scheduler';
import { createApiRouter } from './api/routes';
import { logger, setLogLevel } from './utils/logger';

const VERSION = '1.0.0';

function resolveWebRoot(configured: string): string {
  const candidates = [
    configured,
    path.resolve(process.cwd(), configured),
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../web/dist'),
    '/app/web/dist',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return '';
}

async function main(): Promise<void> {
  // --- 1. 配置 ---
  const explicitPath = process.argv.find((a) => a.startsWith('--config='))?.split('=')[1];
  let loaded;
  try {
    loaded = loadConfig(explicitPath);
  } catch (e) {
    // 此时 logger 级别还没设置，直接写 stderr
    process.stderr.write(`\n[启动失败] ${(e as Error).message}\n\n`);
    process.exit(1);
  }

  const { config, configPath, missingEnvVars, warnings } = loaded;
  setLogLevel(config.server.logLevel);

  // --- 1.5 安全启动闸：非回环地址监听 + 无 API Token = 任何人都能访问，直接拒绝启动 ---
  // 纯内网场景可显式设置 AIOPS_ALLOW_INSECURE_NO_AUTH=true 跳过（会打 warn）。
  const bindHost = config.server.host.trim().toLowerCase();
  const isLoopback = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
  if (!isLoopback && !config.server.apiToken) {
    if (process.env.AIOPS_ALLOW_INSECURE_NO_AUTH === 'true') {
      logger.warn('⚠ 监听非回环地址且未配置 apiToken，API 完全无鉴权（AIOPS_ALLOW_INSECURE_NO_AUTH=true 显式放行）。请确认仅在隔离内网使用。', {
        host: config.server.host,
        port: config.server.port,
      });
    } else {
      process.stderr.write(
        `\n[启动失败] server.host=${config.server.host} 为非回环地址，但 server.apiToken 为空，` +
          `API 将对任何可达者完全开放，已拒绝启动。\n` +
          `  处理方式（二选一）：\n` +
          `  1. 设置环境变量 AIOPS_API_TOKEN（配置中 apiToken: \${AIOPS_API_TOKEN}）；\n` +
          `  2. 仅本机使用：把 server.host 改为 127.0.0.1；\n` +
          `  3. 确认为隔离内网环境：显式设置 AIOPS_ALLOW_INSECURE_NO_AUTH=true。\n\n`,
      );
      process.exit(1);
    }
  }

  logger.info('配置已加载', {
    configPath,
    services: config.services.length,
    esSources: config.datasources.elasticsearch.filter((d) => d.enabled).length,
    promSources: config.datasources.prometheus.filter((d) => d.enabled).length,
    sshSources: config.datasources.ssh.filter((d) => d.enabled).length,
  });

  if (missingEnvVars.length) {
    logger.warn('以下环境变量未设置，已替换为空值', { vars: missingEnvVars });
  }
  for (const w of warnings) logger.warn('配置警告', { warning: w });

  // --- 2. 数据库 ---
  const db = new Database(config.database.path);
  // 回收上次进程异常退出遗留的非终态任务（否则永远显示"分析中"）
  db.markStaleTasksFailed();

  // --- 3. 脱敏器（合规闸口）---
  const redactor = createRedactor(
    config.ai.redaction.rules,
    config.ai.redaction.enabled,
    config.ai.redaction.audit,
  );
  if (config.ai.redaction.enabled) {
    logger.info('脱敏中间件就绪', { rules: redactor.ruleNames });
  }

  // --- 4. LLM 路由 ---
  const llm = new LlmRouter(config);
  const llmProblems = llm.validate();
  for (const p of llmProblems) logger.warn('AI 配置问题', { problem: p });
  if (llmProblems.some((p) => p.includes('未定义的 AI provider'))) {
    logger.error('AI provider 配置不完整，诊断功能将不可用（服务仍会启动以便配置检查）');
  }

  // --- 5. 诊断引擎 ---
  const engine = new DiagnosisEngine(config, db, llm, redactor);

  // --- 6. HTTP 服务 ---
  const app: Express = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // 请求日志（webhook 与诊断请求才记，静态资源不记，避免刷屏）
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/')) {
      logger.debug('API 请求', { method: req.method, path: req.path });
    }
    next();
  });

  const startedAt = Date.now();
  app.use('/api', createApiRouter({ config, configPath, db, engine, llm, redactor, startedAt, version: VERSION }));

  // 手动触发一次日报（运维调试用）
  const scheduler = new Scheduler(config, db, engine, llm);
  app.post('/api/scheduler/run-daily-report', async (_req: Request, res: Response) => {
    if (config.server.apiToken && _req.headers.authorization !== `Bearer ${config.server.apiToken}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const text = await scheduler.runDailyReport();
    res.json({ ok: true, report: text });
  });
  app.get('/api/scheduler/status', (_req: Request, res: Response) => {
    res.json(scheduler.status());
  });

  // --- 静态前端 + SPA fallback ---
  const webRoot = resolveWebRoot(config.server.webRoot);
  if (webRoot) {
    logger.info('已挂载前端静态资源', { webRoot });
    app.use(express.static(webRoot, { index: 'index.html', maxAge: '1h' }));
    // SPA fallback：非 /api 路径都回 index.html
    app.get(/^\/(?!api\/).*/, (req: Request, res: Response, next: NextFunction) => {
      const indexPath = path.join(webRoot, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });
  } else {
    logger.warn('未找到前端构建产物，仅提供 API。请执行 npm run build:web');
    app.get('/', (_req: Request, res: Response) => {
      res
        .status(200)
        .type('html')
        .send(
          `<html><head><meta charset="utf-8"><title>AI Ops Platform</title></head><body style="font-family:sans-serif;padding:40px">` +
            `<h2>AI 自动化运维系统 — API 已就绪</h2>` +
            `<p>前端构建产物未找到（期望目录：<code>${config.server.webRoot}</code>）。</p>` +
            `<p>请执行 <code>npm run build:web</code> 后重启，或直接使用 API：</p>` +
            `<ul>` +
            `<li><a href="/api/health">/api/health</a> — 健康检查</li>` +
            `<li><a href="/api/datasources/health">/api/datasources/health</a> — 数据源可达性</li>` +
            `<li><a href="/api/services">/api/services</a> — 服务注册表</li>` +
            `<li><a href="/api/diagnoses">/api/diagnoses</a> — 诊断任务列表</li>` +
            `<li><a href="/api/metrics/summary">/api/metrics/summary</a> — 成果度量</li>` +
            `</ul>` +
            `<p>版本 ${VERSION}｜配置文件 ${configPath}</p>` +
            `</body></html>`,
        );
    });
  }

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // 统一错误处理：不泄露堆栈到客户端
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('未捕获的 API 异常', { path: req.path, error: err.message, stack: err.stack?.slice(0, 500) });
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', message: '服务器内部错误，详见日志' });
  });

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info('服务已启动', {
      url: `http://${config.server.host}:${config.server.port}`,
      version: VERSION,
      webRoot: webRoot || '(未挂载)',
      redactionEnabled: redactor.isEnabled,
      schedulerEnabled: config.alerts.scheduler.enabled,
    });
    if (missingEnvVars.length) {
      logger.warn('提示：有环境变量未设置，相关功能可能不可用', { vars: missingEnvVars });
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      logger.error('端口已被占用', { port: config.server.port });
    } else {
      logger.error('HTTP 服务错误', { error: e.message });
    }
    process.exit(1);
  });

  // --- 7. 调度器 ---
  scheduler.start();

  // --- 优雅退出 ---
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('收到退出信号，开始优雅关闭', { signal });

    scheduler.stop();
    server.close(() => {
      db.close();
      logger.info('已优雅关闭');
      process.exit(0);
    });

    // 兜底：10 秒内没关完就强退
    setTimeout(() => {
      logger.warn('优雅关闭超时，强制退出');
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason: String(reason).slice(0, 500) });
  });
  process.on('uncaughtException', (e) => {
    logger.error('未捕获异常', { error: e.message, stack: e.stack?.slice(0, 800) });
  });
}

void main();
