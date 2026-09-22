# ⚙️ 配置与接口参考

> 本文是 [README](../README.md) 的配套详细文档，覆盖 `config.yaml` 全部配置段、
> 环境变量、接口一览、安全配置与常见坑。
>
> 📌 文中主机地址、索引名、服务名均为**示意占位符**，请替换为你的真实环境信息。
> 真实配置请放 `config.yaml`（已被 `.gitignore` 排除，不会入库）。

---

## 目录

- [配置文件查找顺序](#配置文件查找顺序)
- [配置段总览](#配置段总览)
- [环境变量插值](#环境变量插值)
- [server — 服务自身](#server--服务自身)
- [database — 存储](#database--存储)
- [ai — 模型与脱敏](#ai--模型与脱敏)
- [datasources — 数据源](#datasources--数据源)
- [services — 服务注册表](#services--服务注册表)
- [security — 安全配置](#security--安全配置)
- [alerts — 告警接入与推送](#alerts--告警接入与推送)
- [diagnosis — 诊断流水线参数](#diagnosis--诊断流水线参数)
- [metrics — 成果度量](#metrics--成果度量)
- [完整配置示例](#完整配置示例)
- [常见配置坑](#常见配置坑)
- [接口一览](#接口一览)
- [常见问题](#常见问题)

---

## 配置文件查找顺序

按以下顺序查找，命中即用：

1. 命令行参数 `--config=/path/to/config.yaml`
2. 环境变量 `AIOPS_CONFIG`
3. `./config.yaml` → `./config.local.yaml` → `./config/config.yaml`
4. 容器内约定路径 `/app/config/config.yaml`

> 定位不到配置时，跑 `npm run probe` 会打印实际读取的路径。

---

## 配置段总览

| 段落 | 作用 | 必填 |
|---|---|---|
| `server` | 监听地址、端口、前端目录、API Token、日志级别 | ✅ |
| `database` | SQLite 文件路径 | ✅ |
| `ai` | 模型 provider、分级路由、成本上限、**脱敏规则** | ✅（诊断需） |
| `datasources` | ES / Prometheus / SSH 三种只读数据源 | ✅（诊断需） |
| `services` | **服务注册表**：别名、索引、依赖、已知问题 | ✅（准确率关键） |
| `security` | 只读命令白名单、危险模式黑名单、审计 | ✅ |
| `alerts` | 入站 Webhook、出站推送、定时巡检 | 可选 |
| `diagnosis` | 取证时间窗、压缩参数、级别过滤 | 可选 |
| `metrics` | 人工基线耗时、是否暴露指标端点 | 可选 |

---

## 环境变量插值

`config.yaml` 中所有 `${ENV_NAME}` 在加载时从环境变量插值。**密钥一律走环境变量，不要写进文件**：

```yaml
ai:
  providers:
    main:
      apiKey: ${LLM_API_KEY}    # ← 从 .env 读取
```

未设置的环境变量会被替换为空字符串，启动日志会列出完整警告清单。

`.env.example` 已列出全部可用变量：

| 变量 | 用途 |
|---|---|
| `AIOPS_API_TOKEN` | Web 工作台 / API 访问令牌（强烈建议设置） |
| `AIOPS_WEBHOOK_SECRET` | 入站 Webhook 共享密钥 |
| `LLM_API_KEY` 等 | 各模型 provider 的 API Key |
| `ES_PROD_USERNAME` / `ES_PROD_PASSWORD` | 日志源账号（建议只读） |
| `ES_DEV_USERNAME` / `ES_DEV_PASSWORD` | 开发/测试日志源账号 |
| `PROM_USERNAME` / `PROM_PASSWORD` | 指标源账号（无认证则留空） |
| `SSH_*_USER` / `SSH_*_PASSWORD` / `SSH_*_KEY_PATH` | SSH 主机凭据（推荐密钥） |
| `FEISHU_BOT_WEBHOOK` | 出站推送地址（群机器人） |

---

## server — 服务自身

```yaml
server:
  host: 0.0.0.0            # 容器内监听 0.0.0.0；裸机部署可改 127.0.0.1
  port: 3000
  webRoot: web/dist        # 前端构建产物目录，相对项目根
  apiToken: ${AIOPS_API_TOKEN}   # 留空 = 不鉴权（仅限隔离内网）
  logLevel: info           # debug | info | warn | error
```

- `apiToken` 留空时启动日志会给出警告。**对外暴露务必设置。**
- 设置后，除 `/api/health` 外所有接口需 `Authorization: Bearer <token>`（或 `?token=`）。

---

## database — 存储

```yaml
database:
  path: data/aiops.db      # Docker 部署建议指向挂载卷，如 /app/data/aiops.db
```

使用 Node 22 内置 `node:sqlite`，**零原生依赖**。存储诊断任务、模板基线、案例库、审计日志。

> `data` 目录不存在时会自动创建。容器内该目录属主是非 root 的 `aiops` 用户，
> 挂载宿主机目录前请先 `chown`，或直接用命名卷。

---

## ai — 模型与脱敏

### providers — 模型提供方

所有 provider 走 **OpenAI 兼容协议**（公有云网关 / 自建推理服务 / 本地部署均可）：

```yaml
ai:
  providers:
    main:
      baseUrl: https://<llm-endpoint>/v1    # 只填到 /v1，程序自动拼 /chat/completions
      apiKey: ${LLM_API_KEY}
      timeoutMs: 120000
```

### routing — 分级路由（控成本的关键）

不同任务用不同档位的模型，兼顾成本与能力：

```yaml
  routing:
    reasoning:   # 主力：根因推理，要求长上下文 + 中文技术日志理解力
      provider: main
      model: <model-name>
      temperature: 0.1
      maxTokens: 8000          # ⚠️ 用推理模型务必给足，见「常见配置坑」
    light:       # 轻量档：日志归一化、字段清洗等机械任务，用便宜模型
      provider: main
      model: <model-name>
      temperature: 0.0
      maxTokens: 2000
    report:      # 强模型档：写复盘报告 / 对外总结
      provider: main
      model: <model-name>
      temperature: 0.2
      maxTokens: 6000
```

### limits — 成本控制

```yaml
  limits:
    maxInputTokens: 60000     # 超过则进一步截断采样，防止费用失控
    maxRetries: 2
    cacheTtlSeconds: 600      # 相同输入的诊断结论缓存时长
```

### redaction — 数据脱敏（合规闸口）

所有送入大模型的文本**必须先过这一层**。内置规则如下，可自行增删：

```yaml
  redaction:
    enabled: true
    audit: true               # 只记规则类型与命中次数，绝不记原值
    rules:
      - { name: phone,      enabled: true,  pattern: '(?<!\d)1[3-9]\d{9}(?!\d)',    replacement: '<PHONE>' }
      - { name: id_card,    enabled: true,  pattern: '(?<!\d)\d{17}[\dXx](?!\d)',   replacement: '<ID_CARD>' }
      - { name: email,      enabled: true,  pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', replacement: '<EMAIL>' }
      - { name: bank_card,  enabled: true,  pattern: '(?<!\d)\d{16,19}(?!\d)',      replacement: '<BANK_CARD>' }
      - { name: credential, enabled: true,  pattern: '(?i)(password|passwd|secret|token|api[_-]?key)(["'']?\s*[:=]\s*)\S+', replacement: '$1$2<REDACTED>' }
      - { name: jwt,        enabled: true,  pattern: 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}', replacement: '<JWT>' }
      # 内网 IP 通常可保留（有助于定位）；若合规要求严格，改为 true
      - { name: ip_address, enabled: false, pattern: '(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])', replacement: '<IP>' }
    # 业务定制规则示例（按真实格式修改）
    # - { name: order_no, enabled: true, pattern: 'SO\d{16}', replacement: '<ORDER_ID>' }
```

> ⚠️ `bank_card` 的 `\d{16,19}` 会把日志里的长数字 ID 一并吃掉。过度脱敏不危险，
> 但会损失定位信息 —— 建议按真实业务号段收紧，例如加前缀约束。

---

## datasources — 数据源

三种数据源**均为只读**。

### elasticsearch

```yaml
datasources:
  elasticsearch:
    - id: prod-es
      name: 生产日志源
      url: http://es.prod.internal:9200
      enabled: true
      username: ${ES_PROD_USERNAME}     # 建议只读账号；留空 = 匿名
      password: ${ES_PROD_PASSWORD}
      timeoutMs: 15000
      maxDocs: 20000                    # 单次查询硬上限，防止打爆 ES 和内存
      indices:                          # 数据源级默认索引（服务可覆盖）
        - app-log-prod-*
```

### prometheus

```yaml
  prometheus:
    - id: prod-prom
      name: Prometheus
      url: http://prometheus.internal:9090
      enabled: true
      username: ${PROM_USERNAME}
      password: ${PROM_PASSWORD}
      queries:                          # 诊断时自动查询的 PromQL 模板
        - name: cpu_usage               # {service} {instance} {container} 会被替换
          promql: '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle",instance=~"{instance}"}[5m])) * 100)'
        - name: memory_usage
          promql: '(1 - node_memory_MemAvailable_bytes{instance=~"{instance}"}/node_memory_MemTotal_bytes{instance=~"{instance}"}) * 100'
        - name: container_oom
          promql: 'increase(container_oom_events_total{name=~"{container}"}[15m])'
        - name: jvm_heap
          promql: 'jvm_memory_used_bytes{area="heap",application="{service}"} / jvm_memory_max_bytes{area="heap",application="{service}"} * 100'
```

### ssh（严格只读）

```yaml
  ssh:
    - id: app-host-01
      name: 应用主机 01
      host: app-host-01.internal
      port: 22
      enabled: true
      username: ${SSH_HOST_USER}
      # 二选一：password 或 privateKeyPath。推荐密钥。
      privateKeyPath: ${SSH_HOST_KEY_PATH}
      passphrase: ${SSH_HOST_KEY_PASSPHRASE}
      timeoutMs: 10000
      allowedCommands:                  # 叠加全局白名单，取交集
        - docker ps
        - docker logs
        - df
        - free
        - uptime
```

---

## services — 服务注册表

**这是诊断准确率的关键**：它告诉 AI 服务名规范、上下游依赖、部署位置、
日志字段怎么映射、已知故障怎么处理。

```yaml
services:
  - canonicalName: order-service         # 规范名（唯一键，AI 输出的名字）
    displayName: 订单服务                 # 展示名
    aliases: [order, order-svc]           # 别名（把同事的口头叫法都列上）
    tier: core                            # core | important | edge
    datasourceId: prod-es                 # 日志从哪个 ES 数据源查
    indexPatterns: [app-log-prod-*]       # 覆盖数据源级 indices
    fieldMapping:                         # 不同框架字段名不一致时在此归一化
      timestamp: ['@timestamp', 'timestamp', 'time']
      level: ['level', 'log.level', 'fields.level']
      message: ['message', 'msg']
      traceId: ['traceId', 'trace_id']
      logger: ['logger_name', 'logger', 'class']
    deployment:
      hostIds: [app-host-01]              # 引用 datasources.ssh[].id
      containerNames: [order-service]
      port: 8080
      jenkinsJob: order-service-deploy
      registry: registry.internal:5000
    stack: Spring Boot 3.x + Nacos + Docker
    dependsOn: [payment-service, nacos]   # 我依赖谁（上游）
    dependedBy: [api-gateway]             # 谁依赖我（下游）
    prometheusLabels:                     # 指标查询用的标签
      application: order-service
      instance: 'app-host-01.internal:.*'
    knownIssues:                          # 历史故障模式 + SOP，越丰富越准
      - pattern: 'HikariPool.*Connection is not available'
        category: 连接池耗尽
        severity: high                    # critical | high | medium | low
        cause: 数据库连接池耗尽，通常由慢 SQL 或流量突增引起
        sop: |
          1. 检查慢查询日志，确认是否有全表扫描
          2. 查看当前 maxPoolSize 与活跃连接数
          3. 必要时临时扩大连接池（需变更审批）
```

### knownIssues 的匹配机制

- 用 **标准 JS 正则**（`new RegExp(pattern, 'i')`）匹配「Drain 模板 + 样本」拼接串，
  不是 PCRE —— `(?i)` 这类写法不可用，改用 flags。
- 模板里的变量已被掩码成 `<*>`，**别写依赖具体变量值的模式**，用稳定的关键词片段。
- 命中后模板会获得高优先级，随提示词一起送给模型，模型会引用其中的 SOP 作答。
- 改动前建议本地用 `new RegExp(p, 'i')` 编译验证一遍。

> 📗 完整编写方法见 **[服务注册表编写指南](knowledge-base.md)**。

---

## security — 安全配置

**只读边界的代码层实现，不靠约定。**

```yaml
security:
  readonly:
    # 白名单：只有匹配前缀的命令才允许执行
    allowedCommandPrefixes:
      - docker ps
      - docker logs
      - docker inspect
      - df
      - free
      - uptime
      - ss -
      - journalctl
      - tail -n
      - cat /var/log
      - systemctl status
      - kubectl get

    # 危险模式：命中即拒绝（优先级高于白名单）
    blockedPatterns:
      - '(?i)\brm\b'
      - '(?i)\bkill\b'
      - '(?i)\brestart\b'
      - '(?i)\bdrop\b'
      - '(?i)\bchmod\b'
      - '(?i)\bsudo\b'
      - '[>|]'          # 任何输出重定向
      - '&&'            # 命令链
      - '\|\|'
      - ';'
      - '`'
      - '\$\('

    maxOutputBytes: 262144      # 单条 SSH 命令最长输出
    commandTimeoutMs: 15000     # SSH 命令超时

  audit:
    enabled: true
    logSuggestedCommands: true  # 记录 AI 建议的命令但不执行
```

### 只读边界如何保证

| 层面 | 措施 |
|---|---|
| 数据源 | ES 只查询；Prometheus 只 query；SSH 只执行白名单内只读命令 |
| 命令校验 | 白名单前缀 + 危险模式黑名单 + shell 元字符拦截（三重） |
| AI 输出 | 建议命令仅展示；代码中不存在"执行模型输出"的路径 |
| 修复动作 | 诊断流水线中**没有**任何写操作 |

### 数据出网合规

```
原始日志 ──▶ ① 脱敏(正则规则) ──▶ ② 压缩(模板化) ──▶ ③ 送模型
               ↓ 审计                     ↓ 降量 1~2 个数量级
          只记类型与次数
```

- 脱敏在**压缩之前**执行，保证模板里也不含敏感信息
- 审计记录**只有规则名与命中次数**，不含原值

### 部署建议

- 对外暴露时**务必设置** `server.apiToken`
- ES 使用**只读账号**，不要给写权限
- SSH 优先用**密钥**，且该密钥只授权只读命令
- 镜像以**非 root 用户**运行（Dockerfile 已内置 `aiops` 用户）
- 密钥走环境变量或密钥管理服务，不要写进 `config.yaml` 后入库

---

## alerts — 告警接入与推送

### webhook — 入站告警

```yaml
alerts:
  webhook:
    enabled: true
    path: /api/webhook/alertmanager
    secret: ${AIOPS_WEBHOOK_SECRET}   # 留空则不校验（仅限内网）
    autoDiagnose: true                # 收到告警后自动触发诊断
    minSeverity: warning              # info | warning | critical，低于此级别只记录
    dedupWindowSeconds: 300           # 告警降噪：同服务 N 秒内只诊断一次
```

**Alertmanager 接入示例**（`webhook_configs` 无法自定义任意 header，改用 query 传密钥）：

```yaml
receivers:
  - name: 'ai-ops'
    webhook_configs:
      - url: 'http://<server-host>:3000/api/webhook/alertmanager?secret=<your-secret>'
        send_resolved: true
```

### scheduler — 定时巡检与出站推送

```yaml
  scheduler:
    enabled: false                    # 见下方成本提示
    scanIntervalMinutes: 60           # 每 N 分钟扫一次，发现新异常模板则汇总
    dailyReportHour: 8                # 每日结论式日报时间（服务器本地时区）
    dailyReportMinute: 0
    reportWebhookUrl: ${FEISHU_BOT_WEBHOOK}   # 群机器人推送地址
```

> ⚠️ **成本提示**：`enabled: true` 后，每轮会对**所有非 edge 服务**各跑一次完整诊断。
> 例如 9 个服务 × 24 小时 = 216 次/天。开启前请先估算 token 成本。

> ⚠️ **飞书自定义机器人的「自定义关键词」校验**：若机器人启用了关键词校验，
> 推送消息**必须包含关键词**，否则飞书会以 `code=19024 Key Words Not Found` 拒收。
> 注意此时 **HTTP 状态码仍是 200** —— 只看状态码会把失败当成功。
> 本项目的推送文案已内置「告警」字样以通过校验，修改文案时请勿删除。

---

## diagnosis — 诊断流水线参数

```yaml
diagnosis:
  windowBeforeMinutes: 15      # 取证时间窗：告警点前后各 N 分钟
  windowAfterMinutes: 15
  compression:
    enabled: true              # 是否启用 Drain 风格模板提取
    similarityThreshold: 0.5   # 模板相似度阈值（0-1，越大越严格）
    maxTemplates: 30           # 送入大模型的模板数上限（影响成本与输出长度）
    samplesPerTemplate: 3      # 每个模板保留的样本数
    baselineDays: 7            # 基线对比统计的历史天数
  levelFilter: [ERROR, WARN, FATAL]   # 只输出这些级别；无独立 level 字段时必须留空 []
  maxContextChars: 120000      # 单次诊断最多送入大模型的字符数
```

---

## metrics — 成果度量

```yaml
metrics:
  enabled: true
  manualBaselineMinutes: 30    # 人工排障基线耗时，用于计算 MTTR 降幅（按真实经验填）
  exposePrometheus: true       # 暴露 /api/metrics/prometheus，让本系统也被监控
```

---

## 完整配置示例

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
    main:
      baseUrl: https://<llm-endpoint>/v1
      apiKey: ${LLM_API_KEY}
      timeoutMs: 120000
  routing:
    reasoning: { provider: main, model: <model-name>, temperature: 0.1, maxTokens: 8000 }
    light:     { provider: main, model: <model-name>, temperature: 0.0, maxTokens: 2000 }
    report:    { provider: main, model: <model-name>, temperature: 0.2, maxTokens: 6000 }
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
      name: 生产日志源
      url: http://es.prod.internal:9200
      enabled: true
      username: ${ES_PROD_USERNAME}
      password: ${ES_PROD_PASSWORD}
      timeoutMs: 15000
      maxDocs: 20000
      indices: ['app-log-prod-*']
  prometheus: []
  ssh: []

services:
  - canonicalName: order-service
    displayName: 订单服务
    aliases: [order, order-svc]
    tier: core
    datasourceId: prod-es
    indexPatterns: ['app-log-prod-*']
    fieldMapping:
      timestamp: ['@timestamp', 'timestamp', 'time']
      level: ['level', 'log.level', 'fields.level']
      message: ['message', 'msg']
      traceId: ['traceId', 'trace_id']
      logger: ['logger_name', 'logger', 'class']
    stack: Spring Boot 3.x + Nacos + Docker
    dependsOn: [payment-service, nacos]
    dependedBy: [api-gateway]
    deployment: { hostIds: [app-host-01], containerNames: [order-service], port: 8080 }
    knownIssues: []

security:
  readonly:
    allowedCommandPrefixes: [docker ps, docker logs, tail -n, df, free, ps, uptime, cat /var/log]
    blockedPatterns: ['(?i)\brm\b', '(?i)\bkill\b', '(?i)\brestart\b', '&&', ';', '\|\|']
    maxOutputBytes: 262144
    commandTimeoutMs: 15000
  audit: { enabled: true, logSuggestedCommands: true }
```

---

## 常见配置坑

### 1. 日志没有独立的 level 字段 → `levelFilter` 必须留空

不少框架把日志级别写在 `message` 文本里（如 `[ERROR] ...`），索引里并没有 `level` 字段。
此时若 `levelFilter: [ERROR, WARN, FATAL]`，程序会按 level 字段做 terms 查询，
**字段不存在就一条日志都捞不到**，表现为"诊断取证为空"。

```yaml
diagnosis:
  levelFilter: []      # 无独立 level 字段时留空；级别由 message 文本兜底解析
```

### 2. 推理模型的 `maxTokens` 要给足

推理模型（reasoner 类）的**思考过程也计入 completion tokens**。
`maxTokens` 给小了，正文 JSON 还没写完就被截断，报错形如：

```
LLM 未返回合法 JSON：Unterminated string in JSON at position 6280
```

建议 `routing.reasoning.maxTokens ≥ 8000`；若仍然截断，可同时下调
`diagnosis.compression.maxTemplates` 以缩短输出。

### 3. `indices` 与 `indexPatterns` 是两处

数据源级 `datasources.elasticsearch[].indices` 是默认值，
服务级 `services[].indexPatterns` 会**覆盖**它。改索引时两处都要看，
否则容易出现"某个服务查了别的服务的索引"。

### 4. 索引模式别写太宽

`'*dev*'` / `'*test*'` 这类模式会匹配到无关索引
（如 `.monitoring-*`、`metricbeat-*`），把噪音带进压缩与推理。
建议用带业务前缀的精确模式，如 `app-log-dev-*`。

### 5. 改了 `datasources.ssh[].id` 要同步改引用

`services[].deployment.hostIds` 引用的是 SSH 数据源的 `id`。
改 id 而漏改引用，会导致服务找不到主机、Prometheus 标签也一起失效
（`prometheusLabels.instance` 常写成该主机的地址正则）。

---

## 接口一览

默认前缀 `/api`。若配置了 `server.apiToken`，除 `/health` 外均需
`Authorization: Bearer <token>`（或 `?token=`）。

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
| POST | `/api/diagnoses/:id/feedback` | 人工反馈（`verdict` + `comment`） | ✅ |
| POST | `/api/diagnoses/:id/promote-to-case` | 沉淀为案例 | ✅ |

发起诊断：

```bash
curl -X POST http://<server-host>:3000/api/diagnoses \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "订单服务昨天下午开始大量报连接池不可用",
    "serviceName": "order-service",
    "timeFrom": "2026-01-01T14:00:00Z",
    "timeTo":   "2026-01-01T15:00:00Z"
  }'
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

### 安全自检

```bash
curl -X POST http://<server-host>:3000/api/security/check-command \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf /"}'
# → {"allowed":false,"reason":"命令不在白名单内，已拒绝：rm -rf /", ...}
```

---

## 常见问题

<details>
<summary><b>启动报「未找到配置文件」</b></summary>

按顺序检查：`--config=` 参数 → `AIOPS_CONFIG` 环境变量 → 当前目录 `config.yaml` →
`/app/config/config.yaml`（容器）。用 `npm run probe` 可直接定位实际读取的路径。
</details>

<details>
<summary><b>诊断返回「取证为空」</b></summary>

三种可能：① 时间窗内确实没日志（放宽 `timeFrom/timeTo`）；
② 服务名没识别出来（检查 `services[].aliases` 是否覆盖了你的叫法）；
③ 索引模式不对（检查 `indexPatterns` 能否匹配到真实索引）。
另见 [常见配置坑 #1](#1-日志没有独立的-level-字段--levelfilter-必须留空)。
</details>

<details>
<summary><b>诊断结论很泛、不够具体</b></summary>

多半是服务注册表填得太浅。`knownIssues` 里的历史故障模式和 SOP 越丰富，
AI 越能给出具体结论。参见 [服务注册表编写指南](knowledge-base.md)。
</details>

<details>
<summary><b>Docker 构建时 npm install 失败</b></summary>

检查 `package-lock.json` 是否与 `package.json` 同步（`npm ci` 要求严格一致）。
Dockerfile 已做 `npm ci || npm install` 兜底。离线环境请先在有网机器构建好镜像。

> 另注：runtime 阶段**不要**尝试 `COPY <workspace>/node_modules`。
> npm workspaces 会把依赖 hoist 到根 `node_modules`，子包目录下并不存在该目录。
</details>

<details>
<summary><b>token 费用会不会失控？</b></summary>

三层防护：① 日志压缩降低 1~2 个数量级；② `ai.limits.maxInputTokens` 硬上限；
③ `cacheTtlSeconds` 缓存相同输入。另外可在 provider 侧设置用量上限。

> 注意定时巡检的成本：`alerts.scheduler.scanIntervalMinutes` × 非 edge 服务数
> 就是每日诊断次数，开启前先估算。
</details>

<details>
<summary><b>能对接其他大模型吗？</b></summary>

可以。任何兼容 OpenAI 协议的服务都能接 —— 公有云网关、自建推理服务、本地部署均可。
只需在 `ai.providers` 里加一个 provider 并调整 `routing`。
</details>

<details>
<summary><b>推送失败但没有报错，日志还显示"已推送"</b></summary>

多半是群机器人的「自定义关键词」校验把消息拒了。这类失败 **HTTP 状态码仍是 200**，
错误只在响应体 `code` 字段（`19024` = 关键词不匹配）。
程序已校验响应体并输出告警日志；若仍遇到，检查推送文案是否含配置的关键词。
</details>
