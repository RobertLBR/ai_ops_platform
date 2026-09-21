# 🤖 AI Ops Platform — AI 自动化运维系统

> **只读诊断型 AIOps 平台**：把「ES 日志 + Prometheus 指标 + 架构知识」喂给大模型，
> 自动给出**可追溯的根因分析**，而不是又一个需要人盯着看的监控大屏。

[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 📖 这是什么

半夜被电话叫醒，登录服务器、翻日志、看监控、猜原因——这套动作，AI 可以替你走完前 80%，
并且**留痕、可追溯、不碰生产**。

本系统做的是一件事：**当故障发生时，自动把"证据"整理好，给出根因排序和处置清单。**

它的设计哲学与"万能 AI 运维 Agent"相反——**它不做任何自动修复**。这是刻意的：

| 传统 AIOps Agent | 本系统 |
|---|---|
| 自动执行修复命令 | ❌ 全程只读，绝不执行 |
| 黑盒决策 | ✅ 事实与推断分离，结论可追溯 |
| 原始日志直接喂模型 | ✅ 先脱敏 + 压缩 1~2 个数量级 |
| 需长期调教才可用 | ✅ 配置化，第一天就能跑 |

**核心定位：给一个懂业务上下文、几秒钟出结论的"老运维助手"，而不是一个会自己动手的机器人。**

---

## ✨ 核心特性

### 🔒 只读安全边界（代码级强制）

- **不自动修复**：诊断流水线只做「取证 → 脱敏 → 压缩 → 模型分析 → 出结论」，没有修复动作
- **SSH 命令白名单**：只允许 `docker ps` / `tail` / `df` 等只读命令，命中 `rm`/`kill`/`restart` 等危险模式直接拒绝
- **拦截 shell 元字符**：`;` `&&` `|` `>` `` ` `` `$()` 全部禁止，杜绝命令注入
- **AI 建议的命令只展示、不执行**，需人工确认后自行操作
- **全量审计**：每次诊断、每次模型调用都留痕（只记类型与次数，不记原值）

### 🛡️ 数据脱敏闸口（合规前置）

所有送入大模型的文本**必须先过脱敏层**。内置手机号、身份证、邮箱、银行卡、JWT、
密码/Token 等规则，均可用正则自定义。审计只记录「命中规则类型 + 次数」，绝不记录原值。

### 🗜️ 日志压缩（成本关键）

用 Drain 风格算法做**模板提取 → 聚类 → 基线对比**，把上千行原始日志压成几十个模板
再送模型。token 消耗降低 1~2 个数量级——这是"能用得起"与"用不起"的分界线。

### 🧭 事实与推断分离

模型输出强制结构化：

```json
{
  "confirmed_facts": ["日志中存在 X", "指标 Y 突增"],
  "inferences": ["推测是 Z 导致"],
  "root_cause_candidates": [{"rank": 1, "target": "...", "confidence": "high", "evidence": "..."}],
  "checklist": ["需要人工确认的事项"],
  "suggested_commands": ["建议在目标机执行的只读命令"],
  "data_gaps": ["还缺哪些信息"]
}
```

**事实是事实，推断是推断，绝不混在一起糊弄人。**

### 📊 成果度量（从第一天起积累）

内置「省了多少工时 / 结论有用率 / 告警降噪率」三个可量化指标，
数据从上线第一天开始积累——**汇报和谈判时不用临时编**。

---

## 🏗️ 架构

```
                    ┌─────────────────────────────────────────┐
                    │           Web 运维工作台 (React)          │
                    │  成果看板 · 发起诊断 · 诊断记录 · 服务注册表  │
                    │  告警流水 · 审计日志                        │
                    └───────────────────┬─────────────────────┘
                                        │ REST /api
┌───────────────┐          ┌────────────▼────────────┐
│  触发层         │          │      Express API         │
│  · 手动提问     │  ──────▶ │  · Bearer Token 鉴权      │
│  · 告警 Webhook │          │  · 路由 / 静态托管        │
│  · 定时巡检     │          └────────────┬────────────┘
└───────────────┘                       │
                    ┌───────────────────▼──────────────────────┐
                    │          诊断流水线 (固定管道)              │
                    │                                          │
                    │  ① 解析服务 & 时间窗  ← 服务注册表(架构知识) │
                    │       │                                  │
                    │  ② 并行只读取证  ┌──────────────┐          │
                    │       │         │ ES 日志源     │          │
                    │       │         │ Prometheus   │ 只读      │
                    │       │         │ SSH(白名单)   │          │
                    │       │         └──────────────┘          │
                    │       ▼                                  │
                    │  ③ 脱敏闸口 (合规前置)                     │
                    │       ▼                                  │
                    │  ④ 压缩: 模板提取→聚类→基线对比             │
                    │       ▼                                  │
                    │  ⑤ 注入知识(已知问题+SOP+相似案例)          │
                    │       ▼                                  │
                    │  ⑥ LLM 推理 → 结构化结论                   │
                    └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │   存储层 (SQLite / node:sqlite 内置)        │
                    │   诊断任务 · 模板基线 · 案例库 · 审计日志     │
                    └──────────────────────────────────────────┘
```

### 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Node.js 22 + TypeScript + Express | 单语言全栈，一人可维护 |
| 前端 | React 18 + antd 5 + Vite | 配置驱动表格，改动成本低 |
| 存储 | `node:sqlite`（Node 22 内置） | **零原生依赖**，镜像干净、构建稳 |
| 数据源 | 原生 `fetch` / `ssh2` | 不引重量级 SDK，减少攻击面 |
| AI | OpenAI 兼容协议 | DeepSeek / 通义千问 / 本地 vLLM 均可 |
| 部署 | Docker 多阶段构建 | 单镜像，配置挂载 |

> **为什么用 `node:sqlite` 而不是 PostgreSQL？**
> 内网单机自用工具，数据量小（每天几十次诊断）。内置 SQLite 免去一个容器、
> 免去原生编译依赖（`better-sqlite3` 要 node-gyp），让镜像构建在无法出网的
> 服务器上也能顺利完成。若未来多实例部署，再迁移到 PG 即可（存储层已隔离）。

---

## 📁 目录结构

```
ai_ops_platform/
├── server/                      # 后端
│   └── src/
│       ├── index.ts             # 入口：启动顺序 + 优雅退出
│       ├── config/schema.ts     # 配置 zod 校验 + ${ENV} 插值
│       ├── core/
│       │   ├── types.ts             # 共享类型
│       │   ├── redaction.ts         # 脱敏中间件（合规闸口）
│       │   ├── compression.ts       # Drain 模板提取与聚类
│       │   ├── diagnosis-engine.ts  # 诊断流水线主流程
│       │   └── scheduler.ts         # 定时巡检 + 日报
│       ├── ai/
│       │   ├── llm-router.ts        # 分级模型路由 + 响应缓存
│       │   └── prompts.ts           # 提示词与结论结构化
│       ├── datasources/
│       │   ├── http.ts              # fetch 封装（超时/认证）
│       │   ├── elasticsearch.ts     # ES 只读查询
│       │   ├── prometheus.ts        # PromQL 查询
│       │   └── ssh.ts               # SSH 只读执行 + 命令白名单
│       ├── api/
│       │   ├── routes.ts            # REST 路由
│       │   └── alert-parser.ts      # 多源告警解析
│       ├── storage/database.ts      # SQLite 存储层
│       └── utils/logger.ts          # 结构化日志（敏感字段自动脱敏）
├── web/                         # 前端
│   └── src/
│       ├── App.tsx                  # 布局 + 导航
│       ├── api/{client,types}.ts    # API 客户端与类型
│       ├── hooks/useApi.ts          # 统一 loading/error/401 处理
│       └── pages/                   # 六个页面
├── scripts/probe-connectivity.mjs   # 部署前连通性自检
├── docs/knowledge-base.md           # 服务注册表编写指南
├── config.example.yaml              # 配置样例（复制为 config.yaml）
├── .env.example                     # 环境变量样例（复制为 .env）
├── Dockerfile                       # 多阶段构建
└── docker-compose.yml               # 一键部署
```

---

## 🚀 快速开始

### 前置要求

- **Node.js ≥ 22.5.0**（`node:sqlite` 需要；用 `node -v` 确认）
- 可访问的 Elasticsearch / Prometheus（可选，用于真实诊断）
- 一个大模型 API Key（DeepSeek / 通义千问 / 自建均可）

### 方式一：本地开发

```bash
# 1. 安装依赖（npm workspaces，一次装好前后端）
npm install

# 2. 准备配置
cp config.example.yaml config.yaml     # 填入你的 ES / Prometheus / 服务注册表
cp .env.example .env                   # 填入 API Key 等密钥

# 3. 自检：确认能否访问到配置里的数据源
npm run probe

# 4. 同时起前后端（后端 3000，前端 5173，已配代理）
npm run dev            # 终端 A：后端
npm run dev:web        # 终端 B：前端 → 打开 http://127.0.0.1:5173
```

### 方式二：本地构建后单端口运行

```bash
npm run build          # 编译后端 + 构建前端
npm start              # 后端托管前端，打开 http://127.0.0.1:3000
```

### 方式三：Docker 部署（推荐用于 Linux 服务器）⭐

```bash
# 1. 准备配置与密钥
cp config.example.yaml config.yaml
cp .env.example .env                   # 填入真实密钥

# 2. 构建并启动
docker compose up -d --build

# 3. 查看状态
docker compose ps
docker compose logs -f ai-ops

# 4. 访问
#    http://<服务器IP>:3000
```

### 方式四：手工构建镜像并推送到私有仓库

```bash
# 构建
docker build -t ai-ops-platform:1.0.0 .

# 打标签并推送到你的私有仓库
docker tag ai-ops-platform:1.0.0 192.168.10.192:5000/ai-ops-platform:1.0.0
docker push 192.168.10.192:5000/ai-ops-platform:1.0.0

# 在目标服务器上拉取运行
docker run -d --name ai-ops \
  -p 3000:3000 \
  -v /data/ai_ops_platform/config.yaml:/app/config/config.yaml:ro \
  -v /data/ai_ops_platform/data:/app/data \
  --env-file /data/ai_ops_platform/.env \
  --restart unless-stopped \
  192.168.10.192:5000/ai-ops-platform:1.0.0
```

> **离线环境提示**：若服务器无法访问 Docker Hub，请在有网机器上构建后
> `docker save` 成 tar 包，传到目标机 `docker load` 导入。

---

## ⚙️ 配置说明

配置文件查找顺序（`server/src/config/schema.ts`）：

1. 命令行参数 `--config=/path/to/config.yaml`
2. 环境变量 `AIOPS_CONFIG`
3. `./config.yaml` → `./config.local.yaml` → `./config/config.yaml`
4. 容器内约定路径 `/app/config/config.yaml`

### config.yaml 结构总览

| 段落 | 作用 | 必填 |
|---|---|---|
| `server` | 监听地址、端口、前端目录、API Token、日志级别 | ✅ |
| `database` | SQLite 文件路径 | ✅ |
| `ai` | 模型 provider、分级路由、成本上限、**脱敏规则** | ✅（诊断需） |
| `datasources` | ES / Prometheus / SSH 三种数据源 | ✅（诊断需） |
| `services` | **服务注册表**：别名、索引、依赖、已知问题 | ✅（准确率关键） |
| `security` | 只读命令白名单、危险模式黑名单、审计 | ✅ |
| `alerts` | Webhook 接入、降噪窗口、定时巡检 | 可选 |
| `diagnosis` | 取证时间窗、压缩参数、级别过滤 | 可选 |
| `metrics` | 人工基线耗时、是否暴露 Prometheus 指标 | 可选 |

### 环境变量插值

`config.yaml` 中所有 `${ENV_NAME}` 在加载时从环境变量插值。**密钥一律走环境变量，不要写进文件**：

```yaml
ai:
  providers:
    deepseek:
      apiKey: ${DEEPSEEK_API_KEY}    # ← 从 .env 读取
```

未设置的环境变量会被替换为空字符串，启动日志会列出警告清单。

### 最小可用配置示例

```yaml
server:
  host: 0.0.0.0
  port: 3000
  webRoot: web/dist
  apiToken: ${AIOPS_API_TOKEN}
  logLevel: info

database:
  path: data/aiops.db

ai:
  providers:
    deepseek:
      baseUrl: https://api.deepseek.com/v1
      apiKey: ${DEEPSEEK_API_KEY}
      timeoutMs: 120000
  routing:
    reasoning: { provider: deepseek, model: deepseek-chat, temperature: 0.1, maxTokens: 4000 }
    light:     { provider: deepseek, model: deepseek-chat, temperature: 0.0, maxTokens: 1000 }
    report:    { provider: deepseek, model: deepseek-chat, temperature: 0.2, maxTokens: 6000 }
  limits: { maxInputTokens: 60000, maxRetries: 2, cacheTtlSeconds: 600 }
  redaction:
    enabled: true
    audit: true
    rules:
      - name: phone
        enabled: true
        pattern: '(?<!\d)1[3-9]\d{9}(?!\d)'
        replacement: '<PHONE>'

datasources:
  elasticsearch:
    - id: prod-es
      name: 生产 ES
      url: http://172.18.136.79:9797
      enabled: true
      username: ${ES_PROD_USERNAME}
      password: ${ES_PROD_PASSWORD}
      timeoutMs: 15000
      maxDocs: 20000
      indices: ['migo-application-log-prod-*']
  prometheus: []
  ssh: []

services:
  - canonicalName: logistics-service
    displayName: 物流服务
    aliases: [logistics, migo-logistics]
    tier: core
    datasourceId: prod-es
    indexPatterns: ['migo-application-log-prod-*']
    stack: Spring Boot 3.x + Nacos + Docker
    dependsOn: [supply-service, nacos]
    dependedBy: [api-gateway]
    deployment: { hostIds: [dev-host], containerNames: [logistics-service], port: 8080 }
    knownIssues: []

security:
  readonly:
    allowedCommandPrefixes: [docker ps, docker logs, tail -n, df, free, ps, uptime, cat /var/log]
    blockedPatterns: ['(?i)\brm\b', '(?i)\bkill\b', '(?i)\brestart\b', '&&', ';', '\|\|']
    maxOutputBytes: 262144
    commandTimeoutMs: 15000
  audit: { enabled: true, logSuggestedCommands: true }
```

> 📘 **服务注册表怎么填**？见 [`docs/knowledge-base.md`](docs/knowledge-base.md)——
> 这直接决定诊断准不准，强烈建议先读。

---

## 🔌 API 文档

默认前缀 `/api`。若配置了 `server.apiToken`，除 `/health` 外均需
`Authorization: Bearer <token>` 请求头（或 `?token=` 参数）。

### 健康与元信息

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/health` | 健康检查（容器探活用） | ❌ |
| GET | `/api/datasources/health` | 数据源配置 + 实时连通性 | ✅ |
| GET | `/api/scheduler/status` | 调度器状态 | ❌ |

### 诊断

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/diagnoses` | 诊断列表（`limit` `offset` `status` `service`） | ✅ |
| GET | `/api/diagnoses/:id` | 诊断详情（含模板/指标/结论/审计） | ✅ |
| POST | `/api/diagnoses` | **发起诊断**（同步返回，约 15~60s） | ✅ |
| POST | `/api/diagnoses/:id/feedback` | 人工反馈（`verdict`+`comment`） | ✅ |
| POST | `/api/diagnoses/:id/promote-to-case` | 沉淀为案例 | ✅ |

发起诊断请求体：

```json
{
  "question": "物流服务昨天下午开始大量报 HikariPool 连接不可用",
  "serviceName": "logistics-service",
  "timeFrom": "2026-09-20T14:00:00Z",
  "timeTo": "2026-09-20T15:00:00Z"
}
```

### 注册表 / 案例 / 告警 / 度量 / 审计

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/services` | 服务注册表 | ✅ |
| GET | `/api/cases` | 案例库（`service` `limit`） | ✅ |
| GET | `/api/alerts` | 告警流水（`limit`） | ✅ |
| GET | `/api/metrics/summary` | 成果度量汇总 | ✅ |
| GET | `/api/metrics/prometheus` | Prometheus 指标端点 | ❌ |
| GET | `/api/audit` | 审计日志（`limit`） | ✅ |

### 告警接入（Webhook）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/webhook/alertmanager` | Alertmanager 格式 |
| POST | `/api/webhook/feishu` | 飞书机器人格式 |
| POST | `/api/webhook/wecom` | 企微机器人格式 |

配置了 `alerts.webhook.secret` 后，请求需带 `X-Webhook-Secret: <secret>` 头或 `?secret=` 参数。

**Alertmanager 接入示例**（注意 `webhook_configs` 无法自定义任意 header，用 query 传密钥）：

```yaml
receivers:
  - name: 'ai-ops'
    webhook_configs:
      - url: 'http://<host>:3000/api/webhook/alertmanager?secret=<your-secret>'
        send_resolved: true
```

### 安全自检

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/security/check-command` | 校验命令是否会被只读白名单放行（**不执行**） |

```bash
curl -X POST http://localhost:3000/api/security/check-command \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /"}'
# → {"allowed":false,"reason":"命令不在白名单内，已拒绝：rm -rf /", ...}
```

---

## 🖥️ Web 工作台

| 页面 | 作用 |
|---|---|
| 📊 **成果看板** | 节省工时 / 结论有用率 / 告警降噪率——汇报与谈判弹药 |
| 💬 **发起诊断** | 提问 + 选服务 + 时间窗，实时进度 |
| 📋 **诊断记录** | 历史诊断列表，可筛选、可跳转详情 |
| 🔍 **诊断详情** | 事实/推断分离展示，只读命令区，反馈与案例沉淀 |
| 🗂️ **服务注册表** | 注册服务、依赖关系、已知问题 + 数据源连通性 |
| 🚨 **告警流水** | 入站告警，已关联诊断可一键跳转 |
| 🔐 **审计日志** | 只读边界证据，含动作类型图例 |

---

## 🔐 安全说明

### 只读边界如何保证

| 层面 | 措施 |
|---|---|
| **数据源** | ES 只查询；Prometheus 只 query；SSH 只执行白名单内只读命令 |
| **命令校验** | 白名单前缀 + 危险模式黑名单 + shell 元字符拦截（三重） |
| **AI 输出** | 建议命令仅展示，代码中不存在"执行模型输出"的路径 |
| **修复动作** | 诊断流水线中**没有**任何写操作 |

> 自检方式：`POST /api/security/check-command` 传入任意命令，
> 观察是否被拦截，即可验证边界生效。

### 数据出网合规

```
原始日志 ──▶ ① 脱敏(正则规则) ──▶ ② 压缩(模板化) ──▶ ③ 送模型
               ↓ 审计                     ↓ 降量 1~2 个数量级
          只记类型与次数
```

- 脱敏在**压缩之前**执行，保证模板里也不含敏感信息
- 审计记录**只有规则名与命中次数**，不含原值
- 如需更严格，可把 `ip_address` 规则改为 `enabled: true`（内网 IP 也脱敏）

### 建议

- 生产环境**务必设置** `server.apiToken`
- ES 使用**只读账号**，不要给写权限
- SSH 优先用**密钥**，且该密钥只授权只读命令
- 镜像以 **非 root 用户** 运行（Dockerfile 已内置 `aiops` 用户）

---

## 🛠️ 常见问题

<details>
<summary><b>启动报「未找到配置文件」</b></summary>

按顺序检查：`--config=` 参数 → `AIOPS_CONFIG` 环境变量 → 当前目录 `config.yaml` →
`/app/config/config.yaml`（容器）。用 `npm run probe` 可直接定位实际读取的路径。
</details>

<details>
<summary><b>诊断返回「取证为空」</b></summary>

三种可能：① 时间窗内确实没日志（放宽 `timeFrom/timeTo`）；
② 服务名没识别出来（检查 `services[].aliases` 是否覆盖了你的叫法）；
③ ES 索引模式不对（检查 `indexPatterns` 能否匹配到真实索引）。
</details>

<details>
<summary><b>诊断结论很泛、不够具体</b></summary>

多半是服务注册表填得太浅。`knownIssues` 里的历史故障模式和 SOP 越丰富，
AI 越能给出具体结论。参见 [`docs/knowledge-base.md`](docs/knowledge-base.md)。
</details>

<details>
<summary><b>Docker 构建时 npm install 失败</b></summary>

检查 `package-lock.json` 是否与 `package.json` 同步（用 `npm ci` 需要严格一致）。
Dockerfile 已做 `npm ci || npm install` 兜底。离线环境请先在有网机器构建好镜像。
</details>

<details>
<summary><b>token 费用会不会失控？</b></summary>

三层防护：① 日志压缩降低 1~2 个数量级；② `ai.limits.maxInputTokens` 硬上限；
③ `cacheTtlSeconds` 缓存相同输入的结论。另外可在 provider 侧设置用量上限。
</details>

<details>
<summary><b>能对接其他大模型吗？</b></summary>

可以。任何兼容 OpenAI 协议的服务（通义千问 / 智谱 / 本地 vLLM / Ollama）都能接，
只需在 `ai.providers` 里加一个 provider 并改 `routing`。
</details>

---

## 🗺️ 路线图

- [x] **v1.0**：固定诊断流水线 + 只读边界 + 脱敏 + 成果度量（当前版本）
- [ ] **v1.x**：更多数据源（K8s events、MySQL 慢查询）、诊断结论导出报告、告警降噪规则可配置化
- [ ] **v2.0**：**Agent 化**——在只读工具集内自主决定取证路径（工具接口已预留）
- [ ] **v2.x**：跨服务链路追踪、案例库自动向量检索

> v1 刻意不做 Agent，是为了先把**可靠性**和**安全边界**打扎实。
> 只有工具接口、审计、脱敏都稳定了，Agent 才值得上。

---

## 🤝 贡献

1. Fork 并创建特性分支
2. 提交前跑 `npm run build` 确保编译通过
3. 提交 PR 并说明动机与测试方式

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  <b>只诊断，不修复。让每一次故障都留下可复用的经验。</b>
</p>
