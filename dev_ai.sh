#!/bin/sh
# =========================================================================== #
# 本地一键开发：同时起 AI sidecar（Node）+ Flask 管理端（Python）。
#
# 用法（在仓库根目录）：
#   ./dev_ai.sh            # 默认：sidecar :8055 + Flask :8000
#   ./dev_ai.sh --rebuild  # 强制重新 tsc 编译 sidecar
#
# 前置：
#   - 已运行过 `cd sidecar && npm install --registry=https://registry.npmjs.org`
#     （pi 包只在官方 registry；首次或换锁文件后重跑）。
#   - 已在仓库根 `pip install -r requirements.txt`（建议在 venv 内）。
#
# 行为：
#   1. 在 sidecar/ 下 tsc 编译（dist/），除非已存在且未指定 --rebuild。
#   2. 后台起 sidecar（node sidecar/dist/index.js）。
#   3. 前台起 Flask（python3 app.py，threaded）。
#   Ctrl-C 同时停掉两个进程。
#
# env（与容器入口一致）：
#   AI_SIDECAR_PORT  sidecar 端口（缺省 8055）
#   AI_FLASK_URL     sidecar 回调 Flask 的基础 URL（缺省 http://127.0.0.1:8000）
#   AI_SIDECAR_URL   Flask 代理到 sidecar 的 URL（缺省 http://127.0.0.1:8055）
#   PORT             Flask 监听端口（缺省 8000）
#   SHARE_DATA_DIR   会话/配置数据目录（沿用 app.py 默认）
# =========================================================================== #
set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SIDECAR_DIR="$REPO_ROOT/sidecar"
FORCE_REBUILD=0
for arg in "$@"; do
    case "$arg" in
        --rebuild|-r) FORCE_REBUILD=1 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *)
            echo "dev_ai.sh: unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

# --------------------------------------------------------------------------- #
# 编译 sidecar（tsc → dist/）
# --------------------------------------------------------------------------- #
if [ "$FORCE_REBUILD" -eq 1 ] || [ ! -f "$SIDECAR_DIR/dist/index.js" ]; then
    echo "[dev_ai] building sidecar (tsc)..."
    (cd "$SIDECAR_DIR" && npm run build) || {
        echo "[dev_ai] sidecar build failed; run 'cd sidecar && npm install --registry=https://registry.npmjs.org' first" >&2
        exit 1
    }
fi

# --------------------------------------------------------------------------- #
# 后台起 sidecar
# --------------------------------------------------------------------------- #
SIDECAR_PID=""
cleanup() {
    trap '' TERM INT
    echo ""
    echo "[dev_ai] stopping sidecar (PID=${SIDECAR_PID:-?})..."
    if [ -n "$SIDECAR_PID" ]; then
        kill -TERM "$SIDECAR_PID" 2>/dev/null
        wait "$SIDECAR_PID" 2>/dev/null
    fi
    exit 0
}
trap cleanup TERM INT

echo "[dev_ai] starting sidecar: node $SIDECAR_DIR/dist/index.js"
node "$SIDECAR_DIR/dist/index.js" &
SIDECAR_PID=$!

# --------------------------------------------------------------------------- #
# 等 sidecar /healthz 就绪（最多 ~15s），再起 Flask
# --------------------------------------------------------------------------- #
SIDECAR_PORT="${AI_SIDECAR_PORT:-8055}"
i=0
READY=0
while [ "$i" -lt 30 ]; do
    if node -e '
        const http = require("http");
        const req = http.get(
            { hostname: "127.0.0.1", port: Number(process.env.SVS_HP), path: "/healthz", timeout: 1000 },
            (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }
        );
        req.on("error", () => process.exit(1));
        req.on("timeout", () => { req.destroy(); process.exit(1); });
    ' SVS_HP="$SIDECAR_PORT" 2>/dev/null; then
        READY=1
        break
    fi
    if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
        echo "[dev_ai] sidecar exited before /healthz became ready" >&2
        wait "$SIDECAR_PID"
        exit 1
    fi
    sleep 0.5
    i=$((i + 1))
done

if [ "$READY" -ne 1 ]; then
    echo "[dev_ai] sidecar not ready on :$SIDECAR_PORT after 15s; aborting" >&2
    kill -TERM "$SIDECAR_PID" 2>/dev/null
    wait "$SIDECAR_PID" 2>/dev/null
    exit 1
fi
echo "[dev_ai] sidecar ready on http://127.0.0.1:$SIDECAR_PORT"

# --------------------------------------------------------------------------- #
# 前台起 Flask（app.py 的 __main__ 入口：app.run threaded）
# Ctrl-C 直接发给前台 Flask，trap 兜底停 sidecar。
# --------------------------------------------------------------------------- #
echo "[dev_ai] starting Flask: python3 app.py (PORT=${PORT:-8000})"
echo "[dev_ai] Ctrl-C to stop both."
PYTHON="${PYTHON:-python3}"
cd "$REPO_ROOT"
exec "$PYTHON" app.py
