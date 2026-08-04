# -*- coding: utf-8 -*-
"""Anthropic 协议适配 + 轨迹渲染 payload 单元测试（任务3 / 任务1）。

覆盖：
1. ai_protocol 的纯函数转换：messages / tools / image / 响应解析。
2. ai_protocol.post_model 在 anthropic 协议下的端到端（mock requests.post）。
3. run_agent 走 anthropic 协议的完整 tool-call 循环（mock 模型端点返回 Anthropic 形态）。
4. ai_agent 的 observation 事件 payload 含 no_annotation_reason/bbox（任务1 后端）。

运行：cd 项目根 && python3 tests/test_ai_protocol.py
用独立临时 SHARE_DATA_DIR，避免污染真实数据。
"""
import json
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TMP = tempfile.mkdtemp(prefix="svs-proto-")
os.environ["SHARE_DATA_DIR"] = os.path.join(TMP, "share-data")
os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)

# openslide 未安装时 stub
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

import ai_protocol  # noqa: E402
import ai_agent  # noqa: E402

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
# 1. messages 转换：OpenAI → Anthropic
# =========================================================================== #
def test_extract_system():
    print("== test_extract_system（system 提取为顶层字段）==")
    msgs = [
        {"role": "system", "content": "你是助手"},
        {"role": "user", "content": "你好"},
        {"role": "system", "content": "额外规则"},
        {"role": "assistant", "content": "嗨"},
    ]
    sys_text, rest = ai_protocol.extract_system_message(msgs)
    check("system 合并", sys_text == "你是助手\n\n额外规则", repr(sys_text))
    check("rest 无 system", all(m["role"] != "system" for m in rest))
    check("rest 长度 2", len(rest) == 2)


def test_convert_messages_text():
    print("== test_convert_messages_text（user/assistant 文本）==")
    msgs = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "嗨"},
    ]
    out = ai_protocol.convert_messages_to_anthropic(msgs)
    check("两条消息", len(out) == 2)
    check("第一条 user", out[0]["role"] == "user")
    check("第一条 text block", out[0]["content"][0] == {"type": "text", "text": "你好"})
    check("第二条 assistant", out[1]["role"] == "assistant")


def test_convert_messages_tool_result():
    print("== test_convert_messages_tool_result（OpenAI tool → Anthropic tool_result）==")
    msgs = [
        {"role": "user", "content": "看这"},
        {"role": "assistant", "content": "",
         "tool_calls": [{"id": "call_1", "type": "function",
                         "function": {"name": "goto", "arguments": '{"x":1,"y":2}'}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "已移动"},
    ]
    out = ai_protocol.convert_messages_to_anthropic(msgs)
    # assistant 的 tool_calls → tool_use block
    asst = [m for m in out if m["role"] == "assistant"][0]
    tu = [b for b in asst["content"] if b.get("type") == "tool_use"]
    check("assistant 含 tool_use", len(tu) == 1)
    check("tool_use id", tu[0]["id"] == "call_1")
    check("tool_use name", tu[0]["name"] == "goto")
    check("tool_use input 解析", tu[0]["input"] == {"x": 1, "y": 2})
    # tool result → user 消息含 tool_result block
    last = out[-1]
    check("tool result 进 user", last["role"] == "user")
    tr = [b for b in last["content"] if b.get("type") == "tool_result"]
    check("含 tool_result block", len(tr) == 1)
    check("tool_result tool_use_id", tr[0]["tool_use_id"] == "call_1")
    check("tool_result content", tr[0]["content"] == "已移动")


def test_convert_messages_image():
    print("== test_convert_messages_image（image_url data-url → image source）==")
    msgs = [
        {"role": "user", "content": [
            {"type": "text", "text": "看图"},
            {"type": "image_url",
             "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
        ]},
    ]
    out = ai_protocol.convert_messages_to_anthropic(msgs)
    blocks = out[0]["content"]
    img = [b for b in blocks if b.get("type") == "image"]
    check("含 image block", len(img) == 1)
    src = img[0].get("source") or {}
    check("source type base64", src.get("type") == "base64")
    check("media_type", src.get("media_type") == "image/jpeg")
    check("data 透传", src.get("data") == "AAAA")


def test_convert_messages_merge_adjacent():
    print("== test_convert_messages_merge_adjacent（相邻同 role 合并）==")
    # OpenAI 里 tool 结果是独立消息（role=tool），转 Anthropic 后应并入 user
    msgs = [
        {"role": "user", "content": "问题"},
        {"role": "tool", "tool_call_id": "c1", "content": "结果1"},
        {"role": "tool", "tool_call_id": "c2", "content": "结果2"},
    ]
    out = ai_protocol.convert_messages_to_anthropic(msgs)
    # 问题 + 两个 tool 结果都进 user，应合并（Anthropic 拒绝相邻同 role）
    user_msgs = [m for m in out if m["role"] == "user"]
    check("只 1 条 user（合并）", len(user_msgs) == 1, str(len(user_msgs)))
    trs = [b for b in user_msgs[0]["content"] if b.get("type") == "tool_result"]
    check("含 2 个 tool_result", len(trs) == 2)


def test_data_url_media_types():
    print("== test_data_url_media_types（不同 media_type）==")
    for mt, url in [
        ("image/png", "data:image/png;base64,XYZ"),
        ("image/webp", "data:image/webp;base64,ABC"),
    ]:
        img = ai_protocol._data_url_to_anthropic_image({"url": url})
        check("media_type " + mt, img.get("source", {}).get("media_type") == mt)
    # 非 data-url 跳过
    check("http 链接跳过", ai_protocol._data_url_to_anthropic_image({"url": "https://x/a.png"}) == {})
    check("空 url 跳过", ai_protocol._data_url_to_anthropic_image({"url": ""}) == {})


# =========================================================================== #
# 2. tools 转换
# =========================================================================== #
def test_convert_tools():
    print("== test_convert_tools（function schema → input_schema）==")
    openai_tools = [
        {"type": "function", "function": {
            "name": "goto", "description": "移动",
            "parameters": {"type": "object", "properties": {"x": {"type": "number"}}}}},
    ]
    out = ai_protocol.convert_tools_to_anthropic(openai_tools)
    check("1 个 tool", len(out) == 1)
    check("name 平铺", out[0]["name"] == "goto")
    check("description 平铺", out[0]["description"] == "移动")
    check("input_schema", out[0]["input_schema"]["properties"]["x"]["type"] == "number")
    check("无 function 包装", "function" not in out[0])


# =========================================================================== #
# 3. 响应解析：Anthropic → OpenAI
# =========================================================================== #
def test_parse_response_text():
    print("== test_parse_response_text（纯文本响应）==")
    data = {
        "content": [{"type": "text", "text": "你好"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 100, "output_tokens": 20},
    }
    out = ai_protocol.parse_anthropic_response(data)
    choice = out["choices"][0]
    check("content 文本", choice["message"]["content"] == "你好")
    check("无 tool_calls", "tool_calls" not in choice["message"])
    check("finish_reason stop", choice["finish_reason"] == "stop")
    check("usage total", out["usage"]["total_tokens"] == 120)
    check("usage prompt", out["usage"]["prompt_tokens"] == 100)


def test_parse_response_tool_use():
    print("== test_parse_response_tool_use（tool_use → tool_calls）==")
    data = {
        "content": [
            {"type": "text", "text": "看这里"},
            {"type": "tool_use", "id": "tu_1", "name": "snapshot",
             "input": {"out_w": 512, "out_h": 512}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 50, "output_tokens": 10},
    }
    out = ai_protocol.parse_anthropic_response(data)
    msg = out["choices"][0]["message"]
    check("content 含文本", msg["content"] == "看这里")
    check("有 tool_calls", "tool_calls" in msg)
    tc = msg["tool_calls"][0]
    check("tool_call id", tc["id"] == "tu_1")
    check("tool_call type function", tc["type"] == "function")
    check("tool_call name", tc["function"]["name"] == "snapshot")
    # arguments 序列化成字符串（OpenAI 约定）
    args = json.loads(tc["function"]["arguments"])
    check("tool_call arguments", args == {"out_w": 512, "out_h": 512})
    check("finish_reason tool_calls", out["choices"][0]["finish_reason"] == "tool_calls")


def test_parse_response_max_tokens():
    print("== test_parse_response_max_tokens（max_tokens → stop）==")
    out = ai_protocol.parse_anthropic_response({"content": [{"type": "text", "text": "x"}],
                                                "stop_reason": "max_tokens"})
    check("max_tokens → stop", out["choices"][0]["finish_reason"] == "stop")


# =========================================================================== #
# 4. URL 容错
# =========================================================================== #
def test_anthropic_url():
    print("== test_anthropic_url（base_url 容错）==")
    check("裸 host 补 /v1/messages",
          ai_protocol._anthropic_messages_url("https://api.anthropic.com") ==
          "https://api.anthropic.com/v1/messages")
    check("带 /v1 补 /messages",
          ai_protocol._anthropic_messages_url("https://api.anthropic.com/v1") ==
          "https://api.anthropic.com/v1/messages")
    check("带 /messages 不重复",
          ai_protocol._anthropic_messages_url("https://x/v1/messages") ==
          "https://x/v1/messages")
    check("末尾 / 去除",
          ai_protocol._anthropic_messages_url("https://x/") == "https://x/v1/messages")


# =========================================================================== #
# 5. build_anthropic_request 端到端组装
# =========================================================================== #
def test_build_request():
    print("== test_build_request（完整请求组装）==")
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "hi"},
    ]
    tools = [{"type": "function", "function": {"name": "goto", "description": "d",
              "parameters": {"type": "object"}}}]
    url, headers, body = ai_protocol.build_anthropic_request(
        "https://api.anthropic.com", "key", "claude-3", 1024, msgs, tools)
    check("url", url == "https://api.anthropic.com/v1/messages")
    check("header x-api-key", headers.get("x-api-key") == "key")
    check("header anthropic-version", headers.get("anthropic-version") == "2023-06-01")
    check("body model", body["model"] == "claude-3")
    check("body max_tokens", body["max_tokens"] == 1024)
    check("body system 顶层", body.get("system") == "sys")
    check("body messages 无 system", all(m["role"] != "system" for m in body["messages"]))
    check("body tools 转换", body["tools"][0]["name"] == "goto")


# =========================================================================== #
# 6. post_model anthropic 分流（mock requests.post）
# =========================================================================== #
class _FakeResp:
    def __init__(self, data, status=200):
        self._data = data
        self.status_code = status
        self.text = json.dumps(data)

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            err = requests.HTTPError("{}".format(self.status_code))
            err.response = self
            raise err

    def json(self):
        return self._data


def test_post_model_anthropic():
    print("== test_post_model_anthropic（post_model 按 anthropic 分流）==")
    import requests
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = json
        return _FakeResp({
            "content": [{"type": "tool_use", "id": "tu1", "name": "goto",
                         "input": {"x": 1, "y": 2}}],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        })
    orig = requests.post
    requests.post = fake_post
    try:
        msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}]
        out = ai_protocol.post_model("https://api.anthropic.com", "k", "claude", 512,
                                     "anthropic", msgs, [], timeout=10)
    finally:
        requests.post = orig
    check("打到 /v1/messages", captured["url"].endswith("/v1/messages"))
    check("带 x-api-key", captured["headers"].get("x-api-key") == "k")
    check("system 进顶层", captured["body"].get("system") == "s")
    check("messages 无 system", all(m["role"] != "system" for m in captured["body"]["messages"]))
    check("响应归一 tool_calls", out["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "goto")


def test_post_model_anthropic_error():
    print("== test_post_model_anthropic_error（Anthropic error 体抛 HTTPError）==")
    import requests
    def fake_post(url, headers=None, json=None, timeout=None):
        return _FakeResp({"type": "error", "error": {"type": "invalid_request_error",
                          "message": "bad model"}}, status=400)
    orig = requests.post
    requests.post = fake_post
    raised = False
    try:
        ai_protocol.post_model("https://x", "k", "bad", 10, "anthropic",
                               [{"role": "user", "content": "x"}], [])
    except requests.HTTPError as e:
        raised = True
        check("error message 透传", "bad model" in str(e))
    finally:
        requests.post = orig
    check("抛 HTTPError", raised)


def test_post_model_openai_passthrough():
    print("== test_post_model_openai（openai 协议原样透传）==")
    import requests
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["body"] = json
        return _FakeResp({"choices": [{"message": {"role": "assistant", "content": "hi"},
                                       "finish_reason": "stop"}]})
    orig = requests.post
    requests.post = fake_post
    try:
        out = ai_protocol.post_model("http://mock/v1", "k", "gpt", 10, "openai",
                                     [{"role": "user", "content": "x"}], [])
    finally:
        requests.post = orig
    check("打到 /chat/completions", captured["url"] == "http://mock/v1/chat/completions")
    check("原样返回", out["choices"][0]["message"]["content"] == "hi")


# =========================================================================== #
# 7. run_agent 走 anthropic 协议完整循环（集成）
# =========================================================================== #
def _write_ai_config(protocol="anthropic"):
    cfg_dir = os.environ["SHARE_DATA_DIR"]
    os.makedirs(cfg_dir, exist_ok=True)
    cfg_path = os.path.join(cfg_dir, "ai_config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"base_url": "http://mock-anthropic", "api_key": "k",
                   "model": "claude-test", "max_tokens": 256, "max_steps": 5,
                   "api_protocol": protocol,
                   "context_window_tokens": 272000, "reserve_tokens": 16000,
                   "safety_margin": 8192, "keep_recent_tokens": 20000,
                   "fork_active_limit": 20, "lease_ttl": 150}, f, ensure_ascii=False)


def _make_runner():
    """构造一个 SessionRunner（走真实 acquire，满足 run_agent 的租约/接口）。"""
    import ai_session
    cfg = json.load(open(os.path.join(os.environ["SHARE_DATA_DIR"], "ai_config.json")))
    runner = ai_session.SessionRunner.acquire("a.svs", "main", title="t", cfg=cfg, fresh=True)
    # 注入 slide ctx（假）
    def region_fn(x, y, w, h, out_w, out_h):
        return {"image_base64": "AAAA", "mime": "image/jpeg",
                "width": out_w, "height": out_h,
                "src": {"x": x, "y": y, "w": w, "h": h},
                "magnification": 40.0}
    ctx = {
        "config": cfg,
        "info": {"width": 10000, "height": 8000, "level_downsamples": (1.0, 4.0), "mpp": 0.25},
        "fingerprint": "fake:1", "region": region_fn,
    }

    def materializer(ref):
        return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}}
    runner.set_slide_ctx(ctx)
    runner.set_materializer(materializer)
    return runner


def _read_events(session_id):
    """读 .events.jsonl 全量事件（测试辅助）。"""
    import ai_session
    return ai_session.replay_events(session_id, -1, {})


class AnthropicMockModel:
    """模拟 Anthropic Messages API 端点：按脚本返回 content blocks。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []
        self.i = 0
        self.lock = threading.Lock()

    def __call__(self, url, headers=None, json=None, timeout=None):
        with self.lock:
            self.calls.append((url, json))
            if self.i >= len(self.script):
                raise AssertionError("mock 脚本耗尽")
            step = self.script[self.i]
            self.i += 1
        return _FakeResp(step)


def test_run_agent_anthropic_flow():
    print("== test_run_agent_anthropic_flow（anthropic 协议完整 tool-call 循环）==")
    _write_ai_config("anthropic")
    # 配置 share_store 基本数据
    import share_store
    share_store.SHARE_FILE.unlink(missing_ok=True)

    runner = _make_runner()
    import requests
    # 脚本：第1步 snapshot+mark_observation，第2步 finish
    script = [
        # snapshot + mark_observation（同一条 assistant）
        {"content": [
            {"type": "text", "text": "看一眼"},
            {"type": "tool_use", "id": "tu1", "name": "snapshot",
             "input": {"out_w": 512, "out_h": 512}},
            {"type": "tool_use", "id": "tu2", "name": "mark_observation",
             "input": {"snapshot_id": "tu1", "label": "肺泡增厚",
                       "note": "间质增厚", "no_annotation_reason": ""}},
        ], "stop_reason": "tool_use",
            "usage": {"input_tokens": 100, "output_tokens": 20}},
        # finish
        {"content": [
            {"type": "text", "text": "完成了"},
            {"type": "tool_use", "id": "tu3", "name": "finish",
             "input": {"summary": "读片总结"}},
        ], "stop_reason": "tool_use",
            "usage": {"input_tokens": 200, "output_tokens": 30}},
    ]
    mock = AnthropicMockModel(script)
    requests.post = mock
    try:
        initial = ai_agent.make_main_messages("a.svs", "扫一遍",
                                              {"width": 10000, "height": 8000,
                                               "level_downsamples": (1.0, 4.0), "mpp": 0.25})
        st = ai_agent.AgentState(5000, 4000, 1024, 1, 0.25)
        ai_agent.run_agent(initial, st, runner)
        runner.finalize()
    finally:
        requests.post = requests.post.__self__.post if hasattr(requests.post, "__self__") else requests.post

    data = runner.get_data()
    check("会话终态 finished", data.get("status") == "finished", data.get("status"))
    # 事件流含 observation（且 payload 带 no_annotation_reason/bbox）
    events = _read_events(runner.session_id)
    obs_evs = [e for e in events if e.get("type") == "observation"]
    check("有 observation 事件", len(obs_evs) >= 1)
    if obs_evs:
        payload = obs_evs[0].get("payload") or {}
        check("observation payload 带 label", payload.get("label") == "肺泡增厚")
        check("observation payload 带 note", payload.get("note") == "间质增厚")
        check("observation payload 带 no_annotation_reason 字段", "no_annotation_reason" in payload)
        check("observation payload 带 bbox 字段", "bbox" in payload)
    # canonical_messages 里工具结果已落（anthropic 转换不影响落库形态）
    canon = data.get("canonical_messages") or []
    tool_msgs = [m for m in canon if m.get("role") == "tool"]
    check("落库含 tool 结果", len(tool_msgs) >= 2)
    # 请求打到 anthropic 端点
    check("请求 url 含 messages", "messages" in mock.calls[0][0])
    # 请求 body 是 anthropic 形态（system 顶层、tools 用 input_schema）
    body0 = mock.calls[0][1]
    check("请求 body system 顶层", "system" in body0)
    check("请求 body tools 用 input_schema",
          body0.get("tools", [{}])[0].get("input_schema") is not None)
    # 工具结果在请求里是 tool_result block（role=user）
    # 第2次请求包含第1次的 tool 结果
    body1 = mock.calls[1][1]
    all_blocks = []
    for m in body1.get("messages", []):
        all_blocks.extend(m.get("content", []))
    trs = [b for b in all_blocks if b.get("type") == "tool_result"]
    check("第2次请求含 tool_result", len(trs) >= 2, "trs=%d" % len(trs))


# =========================================================================== #
# 8. openai 协议仍走原路径（回归：不因 anthropic 适配误伤 openai）
# =========================================================================== #
def test_run_agent_openai_still_works():
    print("== test_run_agent_openai_still_works（openai 协议回归）==")
    _write_ai_config("openai")
    import share_store
    share_store.SHARE_FILE.unlink(missing_ok=True)
    runner = _make_runner()
    import requests
    script = [
        {"choices": [{"message": {"role": "assistant", "content": "",
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "finish", "arguments": '{"summary":"done"}'}}]},
          "finish_reason": "tool_calls"}],
         "usage": {"prompt_tokens": 10, "completion_tokens": 5}},
    ]

    class OM:
        def __init__(self):
            self.calls = []

        def __call__(self, url, headers=None, json=None, timeout=None):
            self.calls.append((url, json))
            return _FakeResp(script[0])
    mock = OM()
    requests.post = mock
    try:
        initial = ai_agent.make_main_messages("a.svs", "t",
                                              {"width": 10000, "height": 8000,
                                               "level_downsamples": (1.0,), "mpp": 0.25})
        st = ai_agent.AgentState(5000, 4000, 1024, 0, 0.25)
        ai_agent.run_agent(initial, st, runner)
        runner.finalize()
    finally:
        requests.post = requests.post.__self__.post if hasattr(requests.post, "__self__") else requests.post
    check("openai 打到 /chat/completions", mock.calls[0][0].endswith("/chat/completions"))
    check("openai 终态 finished", runner.get_data().get("status") == "finished")


def main():
    print("\n=== ai_protocol / 轨迹渲染 测试 ===")
    test_extract_system()
    test_convert_messages_text()
    test_convert_messages_tool_result()
    test_convert_messages_image()
    test_convert_messages_merge_adjacent()
    test_data_url_media_types()
    test_convert_tools()
    test_parse_response_text()
    test_parse_response_tool_use()
    test_parse_response_max_tokens()
    test_anthropic_url()
    test_build_request()
    test_post_model_anthropic()
    test_post_model_anthropic_error()
    test_post_model_openai_passthrough()
    test_run_agent_anthropic_flow()
    test_run_agent_openai_still_works()
    print("\n=== 结果：PASS=%d FAIL=%d ===" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
