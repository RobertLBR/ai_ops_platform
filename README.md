# 🤖 AI Ops Platform — AI 自动化运维诊断平台

> 把「日志 + 指标 + 架构知识」喂给大模型，自动给出**可追溯的根因分析**，
> 而不是又一个需要人盯着看的监控大屏。

[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 📖 这是什么

半夜被电话叫醒，登录服务器、翻日志、看监控、猜原因——这套动作，AI 可以替你走完前 80%，
并且**留痕、可追溯、不碰生产**。

本系统只做一件事：**故障发生时，自动把"证据"整理好，给出根因排序和处置清单。**

它的设计哲学与"万能 AI 运维 Agent"相反——**它不做任何自动修复**，这是刻意的：

| 传统 AIOps Agent | 本系统 |
|---|---|
| 自动执行修复命令 | ❌ 全程只读，绝不执行 |
| 黑盒决策 | ✅ 事实与推断分离，结论可追溯 |
| 原始日志直接喂模型 | ✅ 先脱敏 + 压缩 1~2 个数量级 |
| 需长期调教才可用 | ✅ 配置化，第一天就能跑 |

**定位：一个懂业务上下文、几秒钟出结论的"老运维助手"，而不是会自己动手的机器人。**

---

## ✨ 核心特性

- 🔒 **只读安全边界**：不自动修复；SSH 命令白名单 + 危险模式黑名单 + shell 元字符拦截（三重校验）；AI 建议的命令只展示、不执行
- 🛡️ **数据脱敏闸口**：所有送出网的内容先过脱敏层，规则可自定义；审计只记命中类型与次数，不记原值
- 🗜️ **日志压缩**：Drain 风格「模板提取 → 聚类 → 基线对比」，把上千行日志压成几十个模板，token 降 1~2 个数量级
- 🧭 **事实与推断分离**：模型输出强制结构化，`confirmed_facts` / `inferences` / `data_gaps` 各归各位
- 🧠 **知识沉淀闭环**：真实排障结论沉淀为 `knownIssues`，下次同类日志正则命中并注入 SOP，**越用越准**
- 📊 **成果度量**：内建「省了多少工时 / 结论有用率 / 告警降噪率」，从第一天起积累

---

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────────────┐
│                  触发层                                       │
│      手动提问  │  告警 Webhook  │  定时巡检                    │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                   诊断流水线（固定管道）                        │
│                                                              │
│  ① 解析服务 & 时间窗   ← 服务注册表（架构知识层）               │
│  ② 并行只读取证        ← ES 日志 / Prometheus / SSH(白名单)     │
│  ③ 脱敏闸口            ← 合规前置，压缩之前执行                 │
│  ④ 压缩                ← 模板提取 → 聚类 → 基线对比             │
│  ⑤ 注入知识            ← 已知问题 SOP + 相似案例               │
│  ⑥ LLM 推理            → 结构化结论（事实/推断分离）            │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│         Web 工作台（React）  ＋  存储层（内置 SQLite）          │
│  成果看板·发起诊断·诊断记录·服务注册表·告警流水·审计日志         │
└──────────────────────────────────────────────────────────────┘
```

**技术栈**：Node.js 22 + TypeScript + Express ／ React 18 + antd 5 + Vite ／
`node:sqlite`（零原生依赖）／ OpenAI 兼容协议 ／ Docker 多阶段构建

---

## 🚀 快速开始

### 前置要求

- **Node.js ≥ 22.5.0**（`node:sqlite` 需要，用 `node -v` 确认）
- 可访问的 Elasticsearch / Prometheus（可选，用于真实诊断）
- 一个大模型 API Key，或一个自建的 OpenAI 兼容服务

### 方式一：Docker Compose 部署（推荐）⭐

```bash
git clone <your-repo-url> && cd ai_ops_platform
cp config.example.yaml config.yaml     # 填入你的日志源 / 指标源 / 服务注册表
cp .env.example .env                   # 填入 API Key 等密钥

docker compose up -d --build
docker compose ps                      # 查看状态
docker compose logs -f ai-ops          # 跟踪日志
```

访问 `http://<server-host>:3000` 即可。配置说明见
📘 **[详细配置文档](docs/configuration.md)**。

### 方式二：本地开发

```bash
npm install                            # 一次装好前后端（npm workspaces）
cp config.example.yaml config.yaml
cp .env.example .env

npm run probe                          # 部署前自检：能否连上配置里的数据源
npm run dev                            # 终端 A：后端（默认 3000）
npm run dev:web                        # 终端 B：前端（默认 5173）
```

### 方式三：构建镜像并推送到私有仓库

```bash
docker build -t ai-ops-platform:1.0.0 .
docker tag ai-ops-platform:1.0.0 <your-registry>:5000/ai-ops-platform:1.0.0
docker push <your-registry>:5000/ai-ops-platform:1.0.0

# 目标服务器上运行
docker run -d --name ai-ops -p 3000:3000 \
  -v /opt/ai-ops-platform/config.yaml:/app/config/config.yaml:ro \
  -v ai-ops-data:/app/data \
  --env-file /opt/ai-ops-platform/.env \
  --restart unless-stopped \
  <your-registry>:5000/ai-ops-platform:1.0.0
```

> `-v ai-ops-data:/app/data` 用**命名卷**是有意的：镜像内 `/app/data` 属主是非 root 的
> `aiops` 用户，命名卷会自动继承属主；挂宿主机目录需先 `chown`，否则 SQLite 无法写入。
>
> 无法访问 Docker Hub 时，可在有网机器 `docker save` 成 tar 包，传到目标机 `docker load`。

### 验证安装

```bash
curl http://<server-host>:3000/api/health          # → {"status":"ok",...}
curl http://<server-host>:3000/api/datasources/health   # 数据源连通性
node scripts/probe-connectivity.mjs                # 只读探测各数据源端口
```

---

## 🖥️ Web 工作台

| 页面 | 作用 |
|---|---|
| 📊 成果看板 | 节省工时 / 结论有用率 / 告警降噪率 |
| 💬 发起诊断 | 提问 + 选服务 + 时间窗，实时进度 |
| 📋 诊断记录 | 历史诊断列表，可筛选、可跳转详情 |
| 🔍 诊断详情 | 事实/推断分离展示，只读命令区，反馈与案例沉淀 |
| 🗂️ 服务注册表 | 注册服务、依赖关系、已知问题 + 数据源连通性 |
| 🚨 告警流水 | 入站告警，已关联诊断可一键跳转 |
| 🔐 审计日志 | 只读边界证据，含动作类型图例 |

---

## 🔐 安全边界（一句话版）

**全程只读，不做任何自动修复。** 数据源只查不写；SSH 只跑白名单内只读命令；
AI 建议的命令仅展示，代码中不存在"执行模型输出"的路径；每次诊断与模型调用都留痕。

自检方式：`POST /api/security/check-command` 传入任意命令，观察是否被拦截即可验证边界生效。

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| 📘 [详细配置](docs/configuration.md) | `config.yaml` 逐段说明、环境变量、接口一览、常见配置坑 |
| 📗 [服务注册表编写指南](docs/knowledge-base.md) | 决定诊断准不准的那张表怎么填 |
| 📈 [项目进度](docs/progress.md) | 一期完成情况、验证记录、已知问题与二期规划 |
| 📄 [安全说明](docs/configuration.md#security--安全配置) | 只读白名单、脱敏规则、部署建议 |

---

## 🗺️ 路线图

- [x] **v1.0**：固定诊断流水线 + 只读边界 + 脱敏 + 成果度量
- [ ] **v1.x**：更多数据源、结论导出报告、JSON 重试自适应降规模
- [ ] **v2.0**：Agent 化——在只读工具集内自主决定取证路径（接口已预留）

> v1 刻意不做 Agent，是为了先把**可靠性**和**安全边界**打扎实。

---

## 🤝 贡献

1. Fork 并创建特性分支
2. 提交前跑 `npm run build` 确保编译通过
3. 提交 PR 并说明动机与测试方式

涉及只读边界或脱敏规则的改动，请在 PR 中说明安全影响。

## 📄 许可证

[MIT](LICENSE)

---

<p align="center">
  <b>只诊断，不修复。让每一次故障都留下可复用的经验。</b>
</p>
