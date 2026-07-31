#!/bin/sh
# share_server 生产启动入口：用 gunicorn 线程 worker 跑合并 WSGI（combined_app），
# 并按 SHARE_TLS_CERT/SHARE_TLS_KEY 决定是否终止 TLS。
#
# 之所以用脚本而非在 quadlet/systemd 的 Exec 里直接写 gunicorn 命令行：
# Exec 是 execve 直调，不展开 $SHARE_TLS_CERT 等环境变量，而 gunicorn 的
# --certfile/--keyfile 需要真实路径。这里由 shell 拼接，证书路径仍由 env 控制。
#
# worker 模型：-w 2 --threads 8 线程 worker，不 preload。openslide 句柄在
# borrow_pair 时惰性打开，preload 阶段不打开句柄，故 fork 安全；不用
# gevent/eventlet（与 openslide C 扩展交互有坑）。
set -e

PORT="${SHARE_PORT:-38000}"
WORKERS="${GUNICORN_WORKERS:-2}"
THREADS="${GUNICORN_THREADS:-8}"

if [ -n "$SHARE_TLS_CERT" ] && [ -n "$SHARE_TLS_KEY" ] \
   && [ -f "$SHARE_TLS_CERT" ] && [ -f "$SHARE_TLS_KEY" ]; then
  exec gunicorn share_server:combined_app \
    -b "0.0.0.0:${PORT}" -w "${WORKERS}" --threads "${THREADS}" \
    --certfile "${SHARE_TLS_CERT}" --keyfile "${SHARE_TLS_KEY}" \
    --access-logfile - --error-logfile -
else
  echo "[share_entry] WARNING: 未找到 TLS 证书，以 HTTP 运行" >&2
  exec gunicorn share_server:combined_app \
    -b "0.0.0.0:${PORT}" -w "${WORKERS}" --threads "${THREADS}" \
    --access-logfile - --error-logfile -
fi
