# =============================================================================
# AI Ops Platform — 多阶段构建
#
# Stage 1 (builder): 安装全量依赖 → 编译 server (tsc) + 构建 web (vite)
# Stage 2 (runtime): 只装生产依赖 + 拷贝编译产物，node:22-slim 最小运行环境
#
# 设计取舍：
#   - 数据库用 node:sqlite（Node 22 内置），无原生编译依赖，runtime 阶段
#     不需要 build-essential / python，镜像更小、更稳。
#   - ssh2 的可选原生加速模块（cpu-features）装不上也不影响功能，纯 JS 回退。
#   - 配置文件不打进镜像，运行时挂载到 /app/config/config.yaml。
#   - 数据库落在 /app/data，用 volume 持久化。
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

WORKDIR /app

# 先只拷贝依赖清单，利用 Docker 层缓存（源码改动不会触发重装依赖）
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# 安装全量依赖（含 devDependencies：typescript / vite / @types）
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# 拷贝全部源码
COPY tsconfig.json ./
COPY server/ ./server/
COPY web/ ./web/

# 编译后端 + 构建前端
RUN npm run build --workspace=server \
 && npm run build --workspace=web

# 裁剪：构建完成后只保留生产依赖，减小最终拷贝体积
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# 时区设为上海（日报/审计时间戳按本地时区）
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    AIOPS_CONFIG=/app/config/config.yaml

WORKDIR /app

# curl 供 healthcheck 使用；tzdata 保证时区正确
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# 从 builder 拷贝生产依赖与编译产物。
# 注意：npm workspaces 会把依赖 hoist 到根 node_modules，因此只需拷贝根 node_modules
#       （express/ssh2/yaml/zod 都在这里），不存在 server/node_modules，不要试图拷贝它。
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package.json ./package.json

# 配置样例（真实 config.yaml 运行时挂载，不在此 COPY）
COPY config.example.yaml ./config.example.yaml

# 数据与配置目录（data 持久化数据库，config 挂载配置文件）
RUN mkdir -p /app/data /app/config

# 非 root 运行，最小权限
RUN groupadd --system aiops && useradd --system --gid aiops aiops \
 && chown -R aiops:aiops /app
USER aiops

EXPOSE 3000

# 健康检查：探 /api/health（该端点不鉴权，专供容器探活）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# 数据卷：数据库与运行期数据
VOLUME ["/app/data"]

WORKDIR /app
CMD ["node", "server/dist/index.js"]
