FROM docker.io/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py share_server.py share_store.py slide_io.py slide_cache.py ./
COPY share_entry.sh ./
RUN chmod +x share_entry.sh
COPY templates/ templates/
COPY static/ static/

ENV PORT=8000 \
    SHARE_PORT=38000 \
    UPLOAD_DIR=/data/uploads \
    SHARE_DATA_DIR=/data/share

EXPOSE 8000

# 生产用 gunicorn 线程 worker（-w 2 --threads 8）。不用 preload：openslide 句柄
# 非 fork 安全，让每 worker 独立开句柄池；也不用 gevent/eventlet。
CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8000", "-w", "2", "--threads", "8"]
