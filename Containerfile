# =========================================================================== #
# SVS Viewer 容器镜像（双进程：Flask 管理端 + Node AI sidecar）
#
# pi 迁移 Step 6：多阶段构建。
#   - builder 阶段：用 node:22-bookworm-slim 编译 sidecar（pi 0.84.0），
#     产物 dist/ + 生产 node_modules 复制进运行阶段。
#   - 运行阶段：python:3.12-slim 基础镜像不变，额外 COPY node 二进制与
#     sidecar 产物；docker_entry.sh 同时起 gunicorn（:8000）与 node sidecar
#     （:8055，仅 127.0.0.1），sidecar 经 /internal/ai/* 回调 Flask 读图/落标注。
# =========================================================================== #

# --------------------------------------------------------------------------- #
# Stage 1: builder — 编译 sidecar TypeScript
# --------------------------------------------------------------------------- #
FROM docker.io/library/node:22-bookworm-slim AS builder

# 构建期 npm 源：缺省官方源（pi 包只在官方 registry），可用 ARG 覆盖。
ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /build

# 先 COPY 锁定文件再 ci，利用层缓存。
COPY sidecar/package.json sidecar/package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}"

# 再 COPY 源码并编译（tsc → dist/）。
COPY sidecar/tsconfig.json sidecar/tsconfig.build.json ./
COPY sidecar/src/ src/
COPY sidecar/scripts/ scripts/
RUN npm run build

# 裁剪掉 devDependencies，只留生产依赖，供运行阶段直接复用。
RUN npm prune --omit=dev

# --------------------------------------------------------------------------- #
# Stage 2: 运行镜像（python:3.12-slim + node 运行时）
# --------------------------------------------------------------------------- #
FROM docker.io/library/python:3.12-slim

WORKDIR /app

# node 官方二进制依赖 libstdc++/libgcc，debian slim 自带 libstdc++6；
# 显式安装一份以确保 sidecar 能启动（即使基础镜像日后精简也不受影响）。
# curl 不装：entrypoint 里用 node 一行做 /healthz 探活，不引入额外包。
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 从 builder 阶段取 node 运行时二进制（node:22 静态链接自带的 V8 依赖 libstdc++6，
# 上面已装）。
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

# sidecar 产物：dist（编译输出）+ node_modules（已 prune 为生产依赖）+ package.json
COPY --from=builder /build/dist /app/sidecar/dist
COPY --from=builder /build/node_modules /app/sidecar/node_modules
COPY --from=builder /build/package.json /app/sidecar/package.json

# Flask 应用源码（注意：旧 ai_agent.py / ai_session.py / ai_protocol.py 已在
# pi 迁移中删除，此处不再 COPY）。
COPY app.py share_server.py share_store.py slide_io.py slide_cache.py share_entry.sh ./
COPY docker_entry.sh ./
RUN chmod +x docker_entry.sh
COPY templates/ templates/
COPY static/ static/

ENV PORT=8000 \
    SHARE_PORT=38000 \
    UPLOAD_DIR=/data/uploads \
    SHARE_DATA_DIR=/data/share \
    AI_SIDECAR_PORT=8055 \
    AI_FLASK_URL=http://127.0.0.1:8000 \
    AI_SIDECAR_URL=http://127.0.0.1:8055

EXPOSE 8000

# 双进程：docker_entry.sh 先起 sidecar，等 /healthz 就绪后起 gunicorn；
# 任一进程退出则容器退出；收到 SIGTERM 先停 gunicorn 再停 sidecar。
CMD ["./docker_entry.sh"]
