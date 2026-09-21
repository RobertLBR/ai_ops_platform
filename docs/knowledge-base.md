# 架构知识库编写指南（services 段）

> 本文解决一个问题：**怎么把"你脑子里的架构知识"喂给 AI，让它诊断得准**。

## 为什么这张表决定诊断质量

AI 拿到一条错误日志，本身并不知道"logistics-service 是什么、它跑在哪、
它挂了会影响谁、这个报错历史上怎么修的"。这些信息全靠 `config.yaml` 的
`services` 段提供。这张表填得越全，AI 越像"熟悉你系统的老运维"；
填得草率，AI 就只能给通用、空泛的结论。

一句话：**日志是证据，服务注册表是地图。没有地图，证据再全也定不了位。**

## 字段逐项说明

以 `logistics-service` 为例：

```yaml
services:
  - canonicalName: logistics-service     # 规范名（唯一键，AI 输出的名字）
    displayName: 物流服务                 # 展示名
    aliases: [logistics, migo-logistics] # 别名（关键！见下）
    tier: core                            # core | important | edge
    datasourceId: prod-es                 # 日志从哪个 ES 数据源查
    indexPatterns: [migo-application-log-prod-*]
    fieldMapping: { ... }                 # 日志字段映射
    deployment: { ... }                   # 部署位置
    stack: Spring Boot 3.x + Nacos + Docker
    dependsOn: [supply-service, nacos]    # 上游依赖
    dependedBy: [api-gateway]             # 下游调用方
    prometheusLabels: { ... }             # 指标标签
    knownIssues: [ ... ]                  # 已知故障与 SOP
```

### canonicalName / displayName / aliases

**aliases 是最容易被低估的字段。** 人的提问是口语化的："物流那个服务又报错了"、
"supply 挂了"。系统靠 aliases 把这些说法映射到规范名。

建议把以下来源的所有叫法都塞进 aliases：

- Jenkins job 名里的服务名
- Docker 容器名
- Nacos 注册的服务名
- 日志里的 logger/application 名
- 同事平时的口头简称

### datasourceId / indexPatterns

`datasourceId` 指向 `datasources.elasticsearch[].id`。多环境（prod/dev）时，
同一服务可以配多条记录或用不同 datasourceId 区分。

`indexPatterns` 支持通配符。**建议精确到能唯一区分该服务的索引**，
避免把别人的日志也捞进来造成干扰。

### fieldMapping

不同框架的日志字段名不一致（Spring Boot 用 `level`，某些用 `log.level`，
K8s 用 `fields.level`）。这里列出候选字段名，系统按顺序探测第一个存在的。

如果你的日志是 JSON 格式，务必确认 timestamp/level/message 三个字段映射正确，
否则时间过滤和级别过滤会失效。

### dependsOn / dependedBy

这是**链路定位**的关键。当 `api-gateway` 报超时，AI 可以顺着 `dependsOn`
往下查 `logistics-service`，而不是只看网关自己的日志。

填法：本服务的**上游**（我依赖谁）填 `dependsOn`，**下游**（谁依赖我）填 `dependedBy`。
中间件（nacos/mysql/redis）也算依赖，值得列上——很多"服务假死"其实是中间件问题。

### knownIssues

把你**踩过的坑**沉淀成"模式 → 原因 → SOP"。系统会先用正则匹配日志模板，
命中已知问题就直接给出原因和处置步骤，不命中才交给大模型推理。

```yaml
knownIssues:
  - pattern: 'HikariPool.*Connection is not available'   # 正则，匹配日志内容
    category: 连接池耗尽
    severity: high                                        # critical|high|medium|low
    cause: 数据库连接池耗尽，通常由慢 SQL 或流量突增引起
    sop: |
      1. 检查慢查询日志，确认是否有全表扫描
      2. 查看 HikariCP 当前 maxPoolSize 与活跃连接数
      3. ...
```

**pattern 写正则，不是子串。** 注意转义（`.` 要写 `\.`）。命中越准，
AI 的成本越低、结论越可靠。

## 怎么快速生成初稿

不要手工从零写。把你已有的这些文件丢给 AI（Claude / GPT / 本平台的对话界面）：

- `docker-compose.yml` / `Jenkinsfile` → 提取部署位置、容器名、端口
- Nacos 的服务列表截图 → 提取服务名、依赖关系
- 历史故障工单 / 复盘文档 → 提取 knownIssues
- 现有日志样例 → 提取 fieldMapping

让 AI 按上面的结构生成 YAML 初稿，**再人工校对**。校对重点：
aliases 是否覆盖了真实叫法、dependsOn 方向是否正确、pattern 正则是否转义。

## 常见错误

| 错误 | 后果 |
|------|------|
| aliases 太少 | 用户口语化提问识别不出服务，退化成全服务粗查 |
| indexPatterns 太宽（如 `*`） | 捞进无关日志，模板被污染，结论发散 |
| fieldMapping 错 | 时间/级别过滤失效，取到一堆 INFO 日志 |
| dependsOn 方向搞反 | 链路定位往错误方向走 |
| pattern 未转义 | 正则匹配异常，已知问题命中率低 |
| knownIssues 里的 SOP 写"自行判断" | 等于没写，SOP 要具体到命令/检查项 |

## 与脱敏的关系

注意：`config.yaml` 是**本地配置，不会上传**。但日志内容会经脱敏后送大模型。
如果你在 `knownIssues.cause` / `sop` 里写了敏感信息（如真实密码、甲方名称），
这些会**原样进入 prompt**。请在编写时自行规避，或把这些内容放进环境变量插值。
