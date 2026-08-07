# -*- coding: utf-8 -*-
"""AI sidecar 代理测试（pi 迁移 Step 5）。

覆盖 Flask /api/ai/* → sidecar 的代理转发：
  - run/continue/ask/cancel/sessions/session/archive/stream 路径与 body
  - body 注入 config（api_key 是解密后的明文）
  - 响应 body / 状态码透传（含 409/404/410）
  - SSE 字节透传（假 sidecar 返回若干 SSE 帧，断言客户端收到完全一致字节）
  - X-AI-Session-ID 头透传
  - Last-Event-ID / after_seq 透传
  - sidecar 宕机 → 503 {error:"ai sidecar 不可用"}
  - 鉴权 401 仍然生效

方案：用内存中的 FakeRequests 替换 app.requests，无需起真 server。
运行：cd 项目根 && python3 tests/test_ai_proxy.py
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TMP = tempfile.mkdtemp(prefix="svs-proxy-")
os.environ["SHARE_DATA_DIR"] = os.path.join(TMP, "share-data")
os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)
# 固定 sidecar 地址（测试用假 requests，地址不会真的被访问）
os.environ["AI_SIDECAR_URL"] = "http://127.0.0.1:8055"

# openslide 未安装时 stub（本测试不需要真 OpenSlide）
try:
    import openslide  # noqa: F401
except ImportError:
    import types as _types
    _os = _types.ModuleType("openslide")
    _os.OpenSlide = object
    sys.modules["openslide"] = _os
    _dz = _types.ModuleType("openslide.deepzoom")
    _dz.DeepZoomGenerator = object
    sys.modules["openslide.deepzoom"] = _dz

import app as app_mod  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok  %s" % name)
    else:
        FAIL += 1
        print("FAIL  %s  %s" % (name, detail))


# =========================================================================== #
# Fake requests layer
# =========================================================================== #
class FakeResponse:
    """模拟 requests.Response：普通 + SSE 两种形态。"""

    def __init__(self, status_code=200, content=b"", headers=None,
                 sse_frames=None, ctype=None):
        self.status_code = status_code
        if sse_frames is not None:
            # SSE：content 是帧字节序列拼接；iter_content 逐帧吐
            self._sse_frames = list(sse_frames)
            data = b"".join(sse_frames)
            self.content = data
            self.headers = {"Content-Type": ctype or "text/event-stream"}
            # X-AI-Session-ID 由调用方在 headers 里给
            if headers:
                self.headers.update(headers)
        else:
            self._sse_frames = None
            self.content = content if isinstance(content, bytes) else content.encode("utf-8")
            self.headers = dict(headers or {})
            if "Content-Type" not in self.headers:
                self.headers["Content-Type"] = ctype or "application/json"
        self._closed = False

    def iter_content(self, chunk_size=4096):
        if self._sse_frames is None:
            # 普通 body：一次吐完
            yield self.content
            return
        # SSE：逐帧吐（不分块，保持帧边界便于断言）
        for frame in self._sse_frames:
            yield frame

    def close(self):
        self._closed = True


class FakeRequests:
    """替换 app.requests。按 (method, path) 注册响应工厂；记录所有调用。"""

    def __init__(self):
        self._routes = {}  # (method, path) -> handler(body, query, headers, kwargs)
        self.calls = []    # 记录：{method, path, body, query, headers}
        self._next_error = None  # ConnectionError/Timeout 触发器

    ConnectionError = __import__("requests").ConnectionError
    Timeout = __import__("requests").Timeout

    def register(self, method, path, handler):
        self._routes[(method.upper(), path)] = handler

    def set_unreachable(self):
        self._next_error = True

    def clear_unreachable(self):
        self._next_error = None
        self.calls.clear()

    def _dispatch(self, method, url, **kwargs):
        # url 形如 http://127.0.0.1:8055/run
        base = app_mod.AI_SIDECAR_URL
        path = url[len(base):] if url.startswith(base) else url
        body = kwargs.get("json")
        params = kwargs.get("params")
        headers = kwargs.get("headers") or {}
        self.calls.append({
            "method": method, "path": path, "body": body,
            "query": params, "headers": headers,
        })
        if self._next_error:
            raise FakeRequests.ConnectionError("sidecar down (test)")
        handler = self._routes.get((method, path))
        if handler is None:
            return FakeResponse(404, json.dumps({"error": "no route"}).encode(),
                                headers={"Content-Type": "application/json"})
        return handler(body, params, headers, kwargs)

    def get(self, url, **kwargs):
        return self._dispatch("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._dispatch("POST", url, **kwargs)


def install_fake_requests():
    fake = FakeRequests()
    app_mod.requests = fake
    return fake


def make_client():
    app_mod.app.config["TESTING"] = True
    # 认证默认关闭（多数测试需要放行 /api/）
    app_mod.AUTH_ENABLED = False
    return app_mod.app.test_client()


# =========================================================================== #
# 配置一个带 api_key 的 ai_config.json（加密落盘 → 代理时应解密为明文）
# =========================================================================== #
def setup_ai_config(plain_key="sk-proxy-secret-123456"):
    app_mod._save_ai_config({
        "base_url": "http://llm.example/v1",
        "api_key": plain_key,
        "model": "gpt-proxy",
        "api_protocol": "openai",
        "keep_recent_images": 7,
    })
    return plain_key


# =========================================================================== #
# 测试
# =========================================================================== #
def test_run_proxies_with_decrypted_config_and_sse():
    print("== test_run: 代理 /run，body 注入解密明文 api_key + SSE 字节透传 ==")
    fake = install_fake_requests()
    client = make_client()
    plain = setup_ai_config()

    frames = [
        b"id: 1\nevent: slide_opened\ndata: {\"a\":1}\n\n",
        b"id: 2\nevent: delta\ndata: {\"t\":\"hi\"}\n\n",
    ]
    sent_bytes = b"".join(frames)

    def handler(body, query, headers, kwargs):
        # 断言 body 注入了 config 且 api_key 是明文
        check("run body 含 slide", body.get("slide") == "s.svs", "body=%r" % body)
        cfg = body.get("config") or {}
        check("run config.api_key 为明文（解密后）", cfg.get("api_key") == plain,
              "got %r" % cfg.get("api_key"))
        check("run config.base_url 注入", cfg.get("base_url") == "http://llm.example/v1")
        check("run config 含调优字段 keep_recent_images", cfg.get("keep_recent_images") == 7)
        check("run config 含 api_protocol", cfg.get("api_protocol") == "openai")
        check("run body task 透传", body.get("task") == "看全片")
        return FakeResponse(200, sse_frames=frames,
                            headers={"X-AI-Session-ID": "sess-run-1"})

    fake.register("POST", "/run", handler)
    resp = client.post("/api/ai/run", json={"slide": "s.svs", "task": "看全片"})
    check("run 状态码 200", resp.status_code == 200, "got %d" % resp.status_code)
    check("run X-AI-Session-ID 头透传",
          resp.headers.get("X-AI-Session-ID") == "sess-run-1",
          "got %r" % resp.headers.get("X-AI-Session-ID"))
    check("run Content-Type 为 text/event-stream",
          resp.headers.get("Content-Type", "").startswith("text/event-stream"),
          "got %r" % resp.headers.get("Content-Type"))
    check("run SSE 字节完全一致", resp.data == sent_bytes,
          "got %r" % resp.data)
    # fresh=1 query 透传成 body.fresh=True
    fake.calls.clear()
    fake.register("POST", "/run", lambda b, q, h, k: FakeResponse(200, sse_frames=[]))
    client.post("/api/ai/run?fresh=1", json={"slide": "s.svs"})
    check("run fresh=1 query → body.fresh=True",
          fake.calls[-1]["body"].get("fresh") is True,
          "got %r" % fake.calls[-1]["body"])


def test_continue_and_ask_proxy():
    print("== test_continue / test_ask: 代理 + config 注入 + 状态码透传 ==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()

    fake.register("POST", "/continue",
                  lambda b, q, h, k: FakeResponse(200, sse_frames=[b"x\n\n"],
                   headers={"X-AI-Session-ID": "sess-c"}))
    r = client.post("/api/ai/continue", json={"slide": "s.svs"})
    check("continue 路径转发 /continue",
          fake.calls[-1]["path"] == "/continue")
    check("continue body.config.api_key 明文",
          (fake.calls[-1]["body"].get("config") or {}).get("api_key"))
    check("continue SSE 透传", r.data == b"x\n\n", "got %r" % r.data)
    check("continue X-AI-Session-ID", r.headers.get("X-AI-Session-ID") == "sess-c")

    # ask：410 根标注已删除（错误响应，非 SSE，JSON 透传）
    fake.register("POST", "/ask",
                  lambda b, q, h, k: FakeResponse(410,
                   json.dumps({"error": "该标注已删除"}).encode(),
                   headers={"Content-Type": "application/json"}))
    r2 = client.post("/api/ai/ask",
                     json={"slide": "s.svs", "annotation_id": "ann-1", "question": "?"})
    check("ask 路径转发 /ask", fake.calls[-1]["path"] == "/ask")
    check("ask body.annotation_id 透传",
          fake.calls[-1]["body"].get("annotation_id") == "ann-1")
    check("ask 410 状态码透传", r2.status_code == 410, "got %d" % r2.status_code)
    check("ask 错误 JSON body 透传",
          json.loads(r2.data).get("error") == "该标注已删除")


def test_branch_proxy():
    print("== test_branch: 代理 /branch，body 注入 config + annotation_id 透传 + SSE 透传 + 410 ==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()

    # 1) branch SSE 透传 + config 注入 + annotation_id/question 透传
    frames = [
        b"id: 1\nevent: branch_created\ndata: {\"annotation_id\":\"br-1\"}\n\n",
        b"id: 2\nevent: agent_finished\ndata: {\"summary\":\"ok\"}\n\n",
    ]
    sent_bytes = b"".join(frames)

    def branch_handler(body, query, headers, kwargs):
        check("branch 路径转发 /branch", True)
        check("branch body.slide 透传", body.get("slide") == "s.svs",
              "body=%r" % body)
        check("branch body.annotation_id 透传",
              body.get("annotation_id") == "br-1",
              "body=%r" % body)
        check("branch body.question 透传",
              body.get("question") == "深读这里")
        cfg = body.get("config") or {}
        check("branch config.api_key 明文", cfg.get("api_key"),
              "got %r" % cfg.get("api_key"))
        check("branch config.base_url 注入",
              cfg.get("base_url") == "http://llm.example/v1")
        return FakeResponse(200, sse_frames=frames,
                            headers={"X-AI-Session-ID": "sess-branch-1"})

    fake.register("POST", "/branch", branch_handler)
    r = client.post("/api/ai/branch",
                    json={"slide": "s.svs", "annotation_id": "br-1", "question": "深读这里"})
    check("branch 路径转发 /branch",
          fake.calls[-1]["path"] == "/branch",
          "got %r" % fake.calls[-1]["path"])
    check("branch 状态码 200", r.status_code == 200, "got %d" % r.status_code)
    check("branch X-AI-Session-ID 头透传",
          r.headers.get("X-AI-Session-ID") == "sess-branch-1",
          "got %r" % r.headers.get("X-AI-Session-ID"))
    check("branch Content-Type 为 text/event-stream",
          r.headers.get("Content-Type", "").startswith("text/event-stream"),
          "got %r" % r.headers.get("Content-Type"))
    check("branch SSE 字节完全一致", r.data == sent_bytes, "got %r" % r.data)

    # 2) branch 410 根标注已删除（错误响应，非 SSE，JSON 透传）
    fake.register("POST", "/branch",
                  lambda b, q, h, k: FakeResponse(410,
                   json.dumps({"error": "该标注已删除"}).encode(),
                   headers={"Content-Type": "application/json"}))
    r2 = client.post("/api/ai/branch",
                     json={"slide": "s.svs", "annotation_id": "br-gone"})
    check("branch 410 状态码透传", r2.status_code == 410, "got %d" % r2.status_code)
    check("branch 410 JSON body 透传",
          json.loads(r2.data).get("error") == "该标注已删除")

    # 3) branch 缺 annotation_id → 400（不转发到 sidecar）
    fake.calls.clear()
    r3 = client.post("/api/ai/branch", json={"slide": "s.svs"})
    check("branch 缺 annotation_id 400", r3.status_code == 400,
          "got %d" % r3.status_code)
    check("branch 缺 annotation_id 未转发", len(fake.calls) == 0,
          "calls=%d" % len(fake.calls))


def test_run_conflict_409_non_sse_passthrough():
    print("== test_run 409 冲突（非 SSE JSON 错误透传）==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()
    fake.register("POST", "/run",
                  lambda b, q, h, k: FakeResponse(409,
                   json.dumps({"error": "会话正在运行中"}).encode(),
                   headers={"Content-Type": "application/json"}))
    r = client.post("/api/ai/run", json={"slide": "s.svs"})
    check("409 状态码透传", r.status_code == 409)
    check("409 JSON body 透传", json.loads(r.data).get("error") == "会话正在运行中")
    check("409 非 SSE Content-Type",
          r.headers.get("Content-Type", "").startswith("application/json"))


def test_cancel_proxy():
    print("== test_cancel: 原样转发 body，透传 ok ==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()
    fake.register("POST", "/cancel",
                  lambda b, q, h, k: FakeResponse(200,
                   json.dumps({"ok": True}).encode(),
                   headers={"Content-Type": "application/json"}))
    r = client.post("/api/ai/cancel", json={"session_id": "sess-x"})
    check("cancel 路径转发 /cancel", fake.calls[-1]["path"] == "/cancel")
    check("cancel body.session_id 透传",
          fake.calls[-1]["body"].get("session_id") == "sess-x")
    check("cancel config 不注入（原样转发）",
          "config" not in fake.calls[-1]["body"],
          "body=%r" % fake.calls[-1]["body"])
    check("cancel 200 ok 透传", json.loads(r.data).get("ok") is True)


def test_sessions_and_session_detail_proxy():
    print("== test_sessions / session detail: GET 代理，query 透传 ==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()

    def sessions_handler(body, query, headers, kwargs):
        check("sessions query.slide 透传", query.get("slide") == "s.svs",
              "query=%r" % query)
        check("sessions 无 body（GET）", body is None)
        return FakeResponse(200, json.dumps({"sessions": [{"id": "m1"}]}).encode(),
                            headers={"Content-Type": "application/json"})

    fake.register("GET", "/sessions", sessions_handler)
    r = client.get("/api/ai/sessions?slide=s.svs")
    check("sessions 状态码 200", r.status_code == 200)
    check("sessions body 透传", json.loads(r.data) == {"sessions": [{"id": "m1"}]})

    fake.register("GET", "/session/sess-d",
                  lambda b, q, h, k: FakeResponse(200,
                   json.dumps({"session": {"id": "sess-d"}, "transcript": []}).encode(),
                   headers={"Content-Type": "application/json"}))
    r2 = client.get("/api/ai/session/sess-d")
    check("session detail 路径转发 /session/sess-d",
          fake.calls[-1]["path"] == "/session/sess-d")
    check("session detail 200", r2.status_code == 200)


def test_archive_proxy_paths():
    print("== test_archive/unarchive: 路径分支与 body 透传 ==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()

    fake.register("POST", "/session/sid-1/archive",
                  lambda b, q, h, k: FakeResponse(200,
                   json.dumps({"ok": True, "archived": True}).encode(),
                   headers={"Content-Type": "application/json"}))
    fake.register("POST", "/session/sid-1/unarchive",
                  lambda b, q, h, k: FakeResponse(200,
                   json.dumps({"ok": True, "archived": False}).encode(),
                   headers={"Content-Type": "application/json"}))
    r1 = client.post("/api/ai/session/sid-1/archive", json={})
    check("archive 路径 /session/sid-1/archive",
          fake.calls[-1]["path"] == "/session/sid-1/archive")
    check("archive 返回 archived=True", json.loads(r1.data).get("archived") is True)

    r2 = client.post("/api/ai/session/sid-1/unarchive", json={})
    check("unarchive 路径 /session/sid-1/unarchive",
          fake.calls[-1]["path"] == "/session/sid-1/unarchive")
    check("unarchive 返回 archived=False", json.loads(r2.data).get("archived") is False)


def test_stream_proxy_passes_after_seq_and_last_event_id():
    print("== test_stream: SSE 重挂，after_seq query + Last-Event-ID header 透传 ==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()

    frames = [
        b"id: 5\nevent: delta\ndata: {\"t\":\"a\"}\n\n",
        b"event: session_ended\ndata: {\"status\":\"finished\"}\n\n",
    ]
    expected = b"".join(frames)

    def stream_handler(body, query, headers, kwargs):
        check("stream after_seq query 透传", query.get("after_seq") == "3",
              "query=%r" % query)
        check("stream Last-Event-ID header 透传",
              headers.get("Last-Event-ID") == "2",
              "headers=%r" % headers)
        return FakeResponse(200, sse_frames=frames,
                            headers={"X-AI-Session-ID": "sess-stream"})

    fake.register("GET", "/session/sess-stream/stream", stream_handler)
    r = client.get("/api/ai/session/sess-stream/stream?after_seq=3",
                   headers={"Last-Event-ID": "2"})
    check("stream 状态码 200", r.status_code == 200)
    check("stream SSE 字节完全一致", r.data == expected, "got %r" % r.data)
    check("stream X-AI-Session-ID 透传",
          r.headers.get("X-AI-Session-ID") == "sess-stream")


def test_sidecar_down_returns_503():
    print("== test_sidecar_down: sidecar 不可达 → 503（JSON 与 SSE 端点）==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()
    fake.set_unreachable()

    r1 = client.post("/api/ai/cancel", json={"session_id": "x"})
    check("cancel 503", r1.status_code == 503, "got %d" % r1.status_code)
    check("cancel 503 body", json.loads(r1.data).get("error") == "ai sidecar 不可用")

    r2 = client.post("/api/ai/run", json={"slide": "s.svs"})
    check("run SSE 端点 503", r2.status_code == 503, "got %d" % r2.status_code)
    check("run 503 body", json.loads(r2.data).get("error") == "ai sidecar 不可用")

    r3 = client.get("/api/ai/session/sess-x/stream")
    check("stream SSE 端点 503", r3.status_code == 503)
    fake.clear_unreachable()


def test_auth_still_enforced():
    print("== test_auth: 开启认证时 /api/ai/* 仍返回 401（代理前鉴权）==")
    install_fake_requests()
    client = make_client()
    setup_ai_config()
    app_mod.AUTH_ENABLED = True
    try:
        # 未登录 session
        r = client.post("/api/ai/run", json={"slide": "s.svs"})
        check("开启认证时 /api/ai/run 401", r.status_code == 401,
              "got %d" % r.status_code)
        check("401 body auth_required",
              json.loads(r.data).get("error") == "auth_required")
        r2 = client.get("/api/ai/sessions?slide=s.svs")
        check("开启认证时 /api/ai/sessions 401", r2.status_code == 401)
    finally:
        app_mod.AUTH_ENABLED = False


def test_missing_slide_returns_400():
    print("== test_missing_slide: slide 缺失 400（不转发到 sidecar）==")
    fake = install_fake_requests()
    client = make_client()
    setup_ai_config()
    r = client.post("/api/ai/run", json={})
    check("run 缺 slide 400", r.status_code == 400, "got %d" % r.status_code)
    check("未转发到 sidecar（无调用）", len(fake.calls) == 0,
          "calls=%d" % len(fake.calls))


if __name__ == "__main__":
    test_run_proxies_with_decrypted_config_and_sse()
    test_continue_and_ask_proxy()
    test_branch_proxy()
    test_run_conflict_409_non_sse_passthrough()
    test_cancel_proxy()
    test_sessions_and_session_detail_proxy()
    test_archive_proxy_paths()
    test_stream_proxy_passes_after_seq_and_last_event_id()
    test_sidecar_down_returns_503()
    test_auth_still_enforced()
    test_missing_slide_returns_400()
    print("\nPASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
