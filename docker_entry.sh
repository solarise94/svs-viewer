#!/bin/sh
# =========================================================================== #
# 容器入口：同进程起 Flask 管理端（gunicorn）+ Node AI sidecar。
#
# 进程拓扑：
#   - sidecar（node /app/sidecar/dist/index.js）：仅监听 127.0.0.1:8055，
#     通过 /internal/ai/* 回调 Flask（127.0.0.1:8000）读图/落标注/取变更。
#   - gunicorn（app:app）：监听 0.0.0.0:8000，对外服务管理端，并把
#     /api/ai/* 代理到 sidecar。
#
# 启动顺序：先起 sidecar，轮询 /healthz 直到就绪（最多 30s），再起 gunicorn。
# 进程管理：
#   - 任一子进程退出 → 容器退出（exit code 取首个退出进程的码）。
#   - SIGTERM/SIGINT：先停 gunicorn（优雅 drain），再停 sidecar，最后退出。
# 不依赖 bash 的 wait -n（python:3.12-slim 默认 sh 是 dash，不支持 -n），
# 用 kill -0 轮询监控子进程，纯 POSIX sh 可移植。
# =========================================================================== #
set -u

SIDECAR_BIN="${SIDECAR_BIN:-/app/sidecar/dist/index.js}"
SIDECAR_URL="${AI_SIDECAR_URL:-http://127.0.0.1:8055}"
# gunicorn 启动参数与原 CMD 一致（-w 2 --threads 8）。
GUNICORN_WORKERS="${GUNICORN_WORKERS:-2}"
GUNICORN_THREADS="${GUNICORN_THREADS:-8}"

# 运行态子进程 PID。
SIDECAR_PID=""
GUNICORN_PID=""

# 退出码：首个退出的子进程码，缺省 0。
EXIT_CODE=0
# 标记：是否已在收尾（避免 cleanup 与监控循环重复 kill）。
SHUTTING_DOWN=0

# --------------------------------------------------------------------------- #
# 信号处理：先停 gunicorn，再停 sidecar。
# gunicorn 收 SIGTERM 会优雅 drain（处理完在途请求再退出）；sidecar 直接 SIGTERM。
# --------------------------------------------------------------------------- #
cleanup() {
    # 重置 trap，避免重入。
    trap '' TERM INT
    SHUTTING_DOWN=1
    echo "[entry] received signal, stopping gunicorn then sidecar" >&2
    if [ -n "$GUNICORN_PID" ]; then
        kill -TERM "$GUNICORN_PID" 2>/dev/null
    fi
    if [ -n "$SIDECAR_PID" ]; then
        kill -TERM "$SIDECAR_PID" 2>/dev/null
    fi
    wait "$GUNICORN_PID" 2>/dev/null
    wait "$SIDECAR_PID" 2>/dev/null
    exit "$EXIT_CODE"
}
trap cleanup TERM INT

# --------------------------------------------------------------------------- #
# 1) 起 sidecar（后台）
# --------------------------------------------------------------------------- #
echo "[entry] starting AI sidecar ($SIDECAR_BIN)" >&2
node "$SIDECAR_BIN" &
SIDECAR_PID=$!

# --------------------------------------------------------------------------- #
# 2) 等 sidecar /healthz 就绪（最多 30s）
# 用 node 一行做 HTTP 探活（容器内已有 node，无需额外装 curl）。
# --------------------------------------------------------------------------- #
HEALTHZ_URL="${SIDECAR_URL%/}/healthz"
READY=0
i=0
while [ "$i" -lt 60 ]; do
    # node 退出码 0 表示 /healthz 返回 200。
    if node -e '
        const http = require("http");
        const url = new URL(process.env.SVS_HEALTHZ_URL);
        const req = http.get(
            { hostname: url.hostname, port: url.port, path: url.pathname, timeout: 1000 },
            (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }
        );
        req.on("error", () => process.exit(1));
        req.on("timeout", () => { req.destroy(); process.exit(1); });
    ' SVS_HEALTHZ_URL="$HEALTHZ_URL" 2>/dev/null; then
        READY=1
        break
    fi
    # sidecar 进程已提前退出 → 不再等待。
    if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
        echo "[entry] sidecar exited before /healthz became ready" >&2
        wait "$SIDECAR_PID"
        EXIT_CODE=$?
        exit "$EXIT_CODE"
    fi
    sleep 0.5
    i=$((i + 1))
done

if [ "$READY" -ne 1 ]; then
    echo "[entry] sidecar /healthz not ready within 30s, aborting" >&2
    kill -TERM "$SIDECAR_PID" 2>/dev/null
    wait "$SIDECAR_PID" 2>/dev/null
    exit 1
fi

echo "[entry] sidecar ready, starting gunicorn" >&2

# --------------------------------------------------------------------------- #
# 3) 起 gunicorn（后台与 sidecar 并行）
# --------------------------------------------------------------------------- #
gunicorn app:app \
    -b 0.0.0.0:8000 \
    -w "$GUNICORN_WORKERS" \
    --threads "$GUNICORN_THREADS" \
    --access-logfile - --error-logfile - &
GUNICORN_PID=$!

# --------------------------------------------------------------------------- #
# 4) 监控：任一子进程退出则容器退出。
# 用 kill -0 轮询（dash 不支持 wait -n）；每 0.5s 检查一次。首个退出的子进程
# 的码（wait 取回）作为容器退出码。
# --------------------------------------------------------------------------- #
while [ "$SHUTTING_DOWN" -eq 0 ]; do
    if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
        echo "[entry] sidecar exited, shutting down" >&2
        wait "$SIDECAR_PID"
        EXIT_CODE=$?
        break
    fi
    if ! kill -0 "$GUNICORN_PID" 2>/dev/null; then
        echo "[entry] gunicorn exited, shutting down" >&2
        wait "$GUNICORN_PID"
        EXIT_CODE=$?
        break
    fi
    sleep 0.5
done

# 收尾：把仍在运行的另一个进程停掉，避免孤儿。trap 已在 cleanup 里处理信号路径；
# 这里是正常退出路径（子进程先退），直接 kill + wait。
if [ "$SHUTTING_DOWN" -eq 0 ]; then
    trap '' TERM INT
    kill -TERM "$GUNICORN_PID" 2>/dev/null
    kill -TERM "$SIDECAR_PID" 2>/dev/null
    wait "$GUNICORN_PID" 2>/dev/null
    wait "$SIDECAR_PID" 2>/dev/null
fi
exit "$EXIT_CODE"
