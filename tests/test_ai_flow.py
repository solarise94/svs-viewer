# -*- coding: utf-8 -*-
"""Flask test client + mock 模型端点 集成测试（docs §8.4/§5/§6 全流程）。

运行：cd 项目根 && python3 tests/test_ai_flow.py

覆盖：
- fresh run → pause（到 max_steps）→ continue → finish
- fork ask（批注对话）→ 根标注删了返回 410
- cancel（未开始的工具写"用户已取消"）
- SSE 事件序列含 seq；断线重挂重放（after_seq）
- 落标注 source="ai" + created_by_session_id
"""
import io
import json
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TMP = tempfile.mkdtemp(prefix="svs-flow-")
os.environ["SHARE_DATA_DIR"] = os.path.join(TMP, "share-data")
os.environ["UPLOAD_DIR"] = os.path.join(TMP, "uploads")

import share_store  # noqa: E402
import ai_session  # noqa: E402

# openslide 未安装时 stub（本测试 monkeypatch 了读图路径，不需真 OpenSlide）
try:
    import openslide  # noqa: F401
except ImportError:
    import sys as _sys
    import types as _types
    _os = _types.ModuleType("openslide")
    _os.OpenSlide = object
    _sys.modules["openslide"] = _os
    _dz = _types.ModuleType("openslide.deepzoom")
    _dz.DeepZoomGenerator = object
    _sys.modules["openslide.deepzoom"] = _dz

os.makedirs(os.environ["UPLOAD_DIR"], exist_ok=True)
os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)  # ai_config 写入前需存在
# 造一个假切片文件（region 端点在测试里被 monkeypatch，不需真实 OpenSlide）
open(os.path.join(os.environ["UPLOAD_DIR"], "a.svs"), "wb").close()

import app as app_mod  # noqa: E402
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


# --------------------------------------------------------------------------- #
# mock 模型端点：monkeypatch requests.post
# --------------------------------------------------------------------------- #
class MockModel:
    """按脚本返回固定 tool_calls 序列（覆盖 goto→snapshot→complete→create→pause/finish）。"""

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


class _FakeResp:
    def __init__(self, step):
        self._data = step

    def raise_for_status(self):
        return None

    def json(self):
        return self._data


class _FakeErrResp:
    """HTTP 错误响应壳（给 requests.HTTPError.response 挂 status_code/text）。"""

    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text

    def json(self):
        return {}


def _http_error(status_code, body_text):
    """构造带响应体的 requests.HTTPError（模拟模型端点 4xx/5xx）。"""
    import requests
    resp = _FakeErrResp(status_code, body_text)
    err = requests.HTTPError("{} Client Error".format(status_code))
    err.response = resp
    return err


class MockModelRaise:
    """mock 模型端点：脚本元素为 正常响应 dict 或 待抛出的异常。"""

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
        if isinstance(step, Exception):
            raise step
        return _FakeResp(step)


def _tool_call(tc_id, name, args):
    return {"id": tc_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}}


def _choice(msg, finish_reason="tool_calls"):
    return {"choices": [{"message": msg, "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": 1200, "completion_tokens": 10}}


def _write_ai_config():
    cfg_dir = os.environ["SHARE_DATA_DIR"]
    os.makedirs(cfg_dir, exist_ok=True)  # pytest 共享进程下 import 时机不定，写前确保目录在
    cfg_path = os.path.join(cfg_dir, "ai_config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"base_url": "http://mock/v1", "api_key": "k", "model": "m",
                   "max_tokens": 256, "max_steps": 3,
                   "context_window_tokens": 272000,
                   "reserve_tokens": 16000, "safety_margin": 8192,
                   "keep_recent_tokens": 20000, "fork_active_limit": 20,
                   "lease_ttl": 150}, f, ensure_ascii=False)


def _monkeypatch_region():
    """替换 _ai_slide_ctx 为假上下文（避免真 OpenSlide 读图）。"""
    def fake_ctx(slide_name):
        cfg = app_mod._load_ai_config()
        ctx = {
            "config": cfg,
            "info": {"width": 10000, "height": 8000,
                     "level_downsamples": (1.0, 4.0, 16.0), "mpp": 0.25},
            "fingerprint": "fake:1",
        }

        def region_fn(x, y, w, h, out_w, out_h):
            return {"image_base64": "AAAA", "mime": "image/jpeg",
                    "width": out_w, "height": out_h,
                    "src": {"x": x, "y": y, "w": w, "h": h},
                    "magnification": 40.0}
        ctx["region"] = region_fn

        def materializer(ref):
            return {"type": "image_url",
                    "image_url": {"url": "data:image/jpeg;base64,AAAA"}}
        return ctx, materializer

    app_mod._ai_slide_ctx = fake_ctx


def _parse_sse(text):
    """解析 SSE 文本为 [(seq, type, payload)]。"""
    out = []
    cur = {}
    for line in text.split("\n"):
        if line == "":
            if cur:
                out.append((cur.get("id"), cur.get("type"), cur.get("payload")))
                cur = {}
            continue
        if line.startswith("id:"):
            cur["id"] = int(line[3:].strip())
        elif line.startswith("event:"):
            cur["type"] = line[6:].strip()
        elif line.startswith("data:"):
            try:
                cur["payload"] = json.loads(line[5:].strip())
            except Exception:
                cur["payload"] = None
    if cur:
        out.append((cur.get("id"), cur.get("type"), cur.get("payload")))
    return out


# --------------------------------------------------------------------------- #
def test_main_flow():
    print("== test_main_flow (fresh→pause→continue→finish) ==")
    reset_all()
    # 脚本：第1次响应 snapshot+mark_observation，第2次 finish
    script = [
        _choice({"role": "assistant", "content": "开始看",
                 "tool_calls": [
                     _tool_call("c1", "snapshot", {"out_w": 512, "out_h": 512}),
                     _tool_call("c2", "mark_observation", {"snapshot_id": "c1", "label": "ob",
                                                           "note": "所见"})]}),
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [
                     _tool_call("c4", "create_annotation",
                                {"snapshot_id": "c1", "label": "L", "x": 10, "y": 20,
                                 "side_px": 100, "note": "n"})]}),
        _choice({"role": "assistant", "content": "看完了",
                 "tool_calls": [
                     _tool_call("c3", "complete_snapshot_review",
                                {"snapshot_id": "c1", "disposition": "annotated",
                                 "summary": "s"}),
                     _tool_call("c5", "finish", {"summary": "完成总结"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    # fresh run
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "扫一遍", "fresh": 1})
    check("run 200", resp.status_code == 200)
    body = resp.get_data(as_text=True)
    events = _parse_sse(body)
    types = [t for (_, t, _) in events]
    check("事件含 slide_opened", "slide_opened" in types)
    check("事件含 snapshot_captured", "snapshot_captured" in types)
    check("事件含 observation", "observation" in types)
    check("事件含 snapshot_reviewed", "snapshot_reviewed" in types)
    check("事件含 annotation_created", "annotation_created" in types)
    check("事件含 agent_finished", "agent_finished" in types)
    check("事件含 session_ended", "session_ended" in types)
    # 事件 seq 单调递增
    seqs = [s for (s, _, _) in events if s is not None]
    check("事件 seq 单调递增", seqs == sorted(seqs) and len(seqs) > 0)
    check("事件 seq 连续", seqs == list(range(1, len(seqs) + 1)))
    # session_id 出现在 slide_opened payload
    sid = None
    for (s, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    check("slide_opened 带 session_id", bool(sid))

    # 落标注 source=ai + created_by_session_id
    rois = share_store.list_rois("admin")
    ai_roi = [r for r in rois if r.get("source") == "ai"]
    check("AI 落标注 source=ai", len(ai_roi) >= 1)
    check("AI 落标注 created_by_session_id", bool(ai_roi[0].get("created_by_session_id")))
    check("AI 落标注 annotation_id", bool(ai_roi[0].get("annotation_id")))

    # sessions 列表
    r = client.get("/api/ai/sessions?slide=a.svs")
    sdata = r.get_json()
    check("sessions 有 main", any(s["kind"] == "main" for s in sdata["sessions"]))
    # 会话终态
    d = ai_session.read_session(sid)
    check("会话终态 finished", d and d.get("status") == "finished")
    # detail 脱敏 transcript
    r = client.get("/api/ai/session/" + sid)
    detail = r.get_json()
    check("detail 返回 transcript", isinstance(detail.get("transcript"), list))
    # display_text：UI 气泡用，不暴露 canonical 切片上下文
    user_msgs = [m for m in (detail.get("transcript") or []) if m.get("role") == "user"]
    check("user 消息带 display_text",
          any(m.get("display_text") == "扫一遍" for m in user_msgs))
    return sid


def test_fresh_query_param():
    """前端历史上把 fresh=1 放 query；后端应与 JSON body 双重兼容。"""
    print("== test_fresh_query_param ==")
    reset_all()
    script = [
        _choice({"role": "assistant", "content": "好",
                 "tool_calls": [_tool_call("f1", "finish", {"summary": "完"})]}),
        _choice({"role": "assistant", "content": "新",
                 "tool_calls": [_tool_call("f2", "finish", {"summary": "新会话"})]}),
        _choice({"role": "assistant", "content": "续",
                 "tool_calls": [_tool_call("f3", "finish", {"summary": "续跑"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()

    # 第一次：body 无 fresh，但 query fresh=1 → 应走 fresh（slide_opened，非 session_resumed）
    resp = client.post("/api/ai/run?fresh=1",
                       json={"slide": "a.svs", "task": "第一次"},
                       content_type="application/json")
    check("query fresh=1 → 200", resp.status_code == 200)
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("query fresh 发 slide_opened", "slide_opened" in types)
    check("query fresh 不发 session_resumed", "session_resumed" not in types)
    sid1 = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid1 = p.get("session_id")

    # 第二次：再 fresh=1 → 归档旧 main，新 session（不应复用 sid1）
    resp2 = client.post("/api/ai/run?fresh=1",
                        json={"slide": "a.svs", "task": "第二次", "fresh": True},
                        content_type="application/json")
    events2 = _parse_sse(resp2.get_data(as_text=True))
    sid2 = None
    for (_, t, p) in events2:
        if t == "slide_opened" and p:
            sid2 = p.get("session_id")
    check("再次 fresh 新建 session", bool(sid2) and sid2 != sid1)

    # 第三次：无 fresh → 复用现有 main，发 session_resumed
    resp3 = client.post("/api/ai/run",
                        json={"slide": "a.svs", "task": "续"},
                        content_type="application/json")
    events3 = _parse_sse(resp3.get_data(as_text=True))
    types3 = [t for (_, t, _) in events3]
    check("无 fresh 发 session_resumed", "session_resumed" in types3)


def test_pause_continue():
    print("== test_pause_continue (到 max_steps 暂停→继续→finish) ==")
    reset_all()
    # max_steps=1：第一步只有 goto（不 finish）→ pause
    cfg_path = os.path.join(os.environ["SHARE_DATA_DIR"], "ai_config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"base_url": "http://mock/v1", "api_key": "k", "model": "m",
                   "max_tokens": 256, "max_steps": 1}, f, ensure_ascii=False)
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("g1", "goto", {"x": 100, "y": 200, "level": 2,
                                                          "reason": "看看"})]}),
        _choice({"role": "assistant", "content": "完了",
                 "tool_calls": [_tool_call("f1", "finish", {"summary": "总结"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("到步数上限发 agent_paused", "agent_paused" in types)
    # 会话 paused
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    d = ai_session.read_session(sid)
    check("会话状态 paused", d and d.get("status") == "paused")

    # 继续
    last_seq_run1 = max([s for (s, _, _) in events if s] or [0])
    resp2 = client.post("/api/ai/continue", json={"slide": "a.svs"})
    check("continue 200", resp2.status_code == 200)
    events2 = _parse_sse(resp2.get_data(as_text=True))
    types2 = [t for (_, t, _) in events2]
    check("continue 后 agent_finished", "agent_finished" in types2)
    # continue 重放历史（含第一轮的 agent_paused），但新事件 seq > 上轮末
    new_ev = [(s, t) for (s, t, _) in events2 if s and s > last_seq_run1]
    new_types = [t for (_, t) in new_ev]
    check("continue 新事件不含 agent_paused", "agent_paused" not in new_types)
    check("continue 新事件含 agent_finished", "agent_finished" in new_types)
    check("continue 后 seq 单调", [s for (s, _) in new_ev] == sorted([s for (s, _) in new_ev]))
    # continue 的首次模型请求必须含 system 前缀（落库保证）
    cont_first_req = mock.calls[1][1]["messages"]
    check("continue 请求含 system 前缀", cont_first_req[0].get("role") == "system")


def test_cancel():
    print("== test_cancel ==")
    reset_all()
    # 脚本：第一步两个工具（一个执行、一个未开始），然后 cancel
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [
                     _tool_call("a1", "goto", {"x": 1, "y": 1, "level": 1}),
                     _tool_call("a2", "create_annotation",
                                {"snapshot_id": "sx", "label": "X", "x": 1, "y": 1,
                                 "side_px": 10, "note": ""})]}),
        _choice({"role": "assistant", "content": "续",
                 "tool_calls": [_tool_call("a3", "finish", {"summary": "ok"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    check("SSE 响应头立即带 session id",
          resp.headers.get("X-AI-Session-ID") == sid)
    # 取消
    r = client.post("/api/ai/cancel", json={"session_id": sid})
    check("cancel 200", r.status_code == 200)
    d = ai_session.read_session(sid)
    check("cancel_requested 置位", d.get("cancel_requested") is True)
    # 等 worker 感知取消并收尾
    time.sleep(1.0)
    d2 = ai_session.read_session(sid)
    # 未开始的 create_annotation（snapshot 未 pending → 会被拒/或取消）不落标
    rois = share_store.list_rois("admin")
    check("取消后无 X 标注", all(x.get("label") != "X" for x in rois))

    # 首个 SSE 事件尚未到浏览器时，前端只能用 slide 取消。
    r2 = client.post("/api/ai/cancel", json={"slide": "a.svs"})
    check("按 slide 兜底取消 200", r2.status_code == 200)


def test_cancel_discards_model_response():
    """模型请求期间取消：响应返回后不得再输出文本或执行工具。"""
    print("== test_cancel_discards_model_response ==")
    reset_all()

    class CancelBeforeReturn(MockModel):
        def __call__(self, url, headers=None, json=None, timeout=None):
            sid = ai_session.list_session_ids_by_slide("a.svs").get("main")
            if sid:
                ai_session.SessionRunner(sid).mark_cancelled()
            return super().__call__(url, headers=headers, json=json, timeout=timeout)

    script = [_choice({"role": "assistant", "content": "这段不应显示",
                       "tool_calls": [_tool_call("late", "finish", {"summary": "不应完成"})]})]
    import requests
    requests.post = CancelBeforeReturn(script)
    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": True})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("取消后进入 paused", "agent_paused" in types)
    check("取消后不发 text_delta", "text_delta" not in types)
    check("取消后不 finished", "agent_finished" not in types)


def test_slide_magnification_guide():
    print("== test_slide_magnification_guide ==")
    info = {"mpp": 0.242, "level_downsamples": (1.0, 2.0, 4.0)}
    guide = ai_agent.magnification_guide(info)
    check("0.242 mpp 的 level 0 明确为约 41x 高倍",
          "level 0≈41x（高倍）" in guide, guide)
    check("downsample 2 明确为约 21x 中低倍",
          "level 1≈21x（中低倍）" in guide, guide)
    st = ai_agent.AgentState(0, 0, 1024, 1, 0.242)
    label = st.magnification_label((1.0, 2.0, 4.0))
    check("快照倍率标签保留 level 与低倍语义",
          "21x" in label and "低倍" in label and "level=1" in label, label)


def test_pick_overview_level_tolerance():
    """概览层选择带 5% 容差：差 0.8% 不该掉一整级（0.6x → 0.3x 回归）。"""
    print("== test_pick_overview_level_tolerance ==")
    ds = (1.0, 2.00004, 4.00016, 8.00091, 16.00279, 32.01112, 64.04444, 128.17787)
    # 真实案例：66061×46199 的片，vp=1024 时 level 6 覆盖 65582（差 0.7%）
    lvl = ai_agent.AgentState.pick_overview_level(66061, 46199, ds, 1024)
    check("差 0.7% 时选 level 6 而非掉到 7", lvl == 6, lvl)
    # 差太多仍按原规则掉级：宽度 ×1.2 后 level 6 覆盖 < 95%，选 7
    lvl2 = ai_agent.AgentState.pick_overview_level(80000, 46199, ds, 1024)
    check("覆盖不足 95% 仍掉到 level 7", lvl2 == 7, lvl2)
    # 小片精确命中不受影响
    lvl3 = ai_agent.AgentState.pick_overview_level(60000, 40000, ds, 1024)
    check("精确覆盖仍选 level 6", lvl3 == 6, lvl3)


class _FakeGotoRunner:
    def __init__(self):
        self.events = []
        self._pending = False

    def is_snapshot_pending(self):
        return self._pending

    def emit_event(self, typ, payload):
        self.events.append((typ, payload))


def test_goto_level_zero_and_clamp():
    """level=0 不得被 or 吞掉；越界 level 夹到有效层；同坐标同 level 为 no-op。"""
    print("== test_goto_level_zero_and_clamp ==")
    downs = (1.0, 4.0, 16.0)  # level 0/1/2
    st = ai_agent.AgentState(5000, 4000, 1024, 2, 0.25)
    runner = _FakeGotoRunner()

    # 当前 level 2 → 请求 level 0（最高倍）
    result, done = ai_agent._execute_tool(
        "goto", {"x": 100, "y": 200, "level": 0, "reason": "高倍确认"},
        "g0", st, downs, runner, "main", {})
    check("level0 goto 未结束", done is False)
    check("状态 pyramidLevel=0", st.pyramidLevel == 0, st.pyramidLevel)
    check("结果含 level=0", "level=0" in str(result), result)
    check("坐标已更新", round(st.centerX) == 100 and round(st.centerY) == 200)
    check("发出 tool_started", any(t == "tool_started" for t, _ in runner.events))
    ev = [p for t, p in runner.events if t == "tool_started"][-1]
    check("事件 level=0", ev.get("level") == 0, ev)
    check("倍率标签为高倍 level0",
          "level=0" in (ev.get("magnification") or ""), ev.get("magnification"))

    # 越界 level=99 → 夹到最后一层 2
    n_ev = len(runner.events)
    result2, _ = ai_agent._execute_tool(
        "goto", {"x": 300, "y": 400, "level": 99},
        "g99", st, downs, runner, "main", {})
    check("越界夹到 max level=2", st.pyramidLevel == 2, st.pyramidLevel)
    check("结果提示夹取", "夹到有效层" in str(result2), result2)
    ev2 = [p for t, p in runner.events[n_ev:] if t == "tool_started"][-1]
    check("事件持久化 level=2 非 99", ev2.get("level") == 2, ev2)
    check("事件保留 requested_level=99", ev2.get("requested_level") == 99, ev2)
    check("倍率标签用有效层", "level=2" in (ev2.get("magnification") or ""),
          ev2.get("magnification"))

    # 同坐标同实际 level → no-op，不发新事件
    n_ev2 = len(runner.events)
    result3, _ = ai_agent._execute_tool(
        "goto", {"x": 300, "y": 400, "level": 2},
        "gnoop", st, downs, runner, "main", {})
    check("noop 不推进状态", st.pyramidLevel == 2 and round(st.centerX) == 300)
    check("noop 提示勿重复", "不要重复" in str(result3), result3)
    check("noop 不发 tool_started", len(runner.events) == n_ev2)

    # 缺省 level 字段时回退当前层（仍可移动坐标）
    result4, _ = ai_agent._execute_tool(
        "goto", {"x": 10, "y": 20},
        "gdef", st, downs, runner, "main", {})
    check("缺省 level 保持当前层", st.pyramidLevel == 2, st.pyramidLevel)
    check("缺省 level 仍可改坐标", round(st.centerX) == 10 and round(st.centerY) == 20)

    # 旧状态 pyramidLevel=99：同坐标请求越界 level 仍说明夹取，并归一状态
    st_stale = ai_agent.AgentState(10, 20, 1024, 99, 0.25)
    n_ev3 = len(runner.events)
    result5, _ = ai_agent._execute_tool(
        "goto", {"x": 10, "y": 20, "level": 99},
        "gstale", st_stale, downs, runner, "main", {})
    check("旧状态 99 归一为 2", st_stale.pyramidLevel == 2, st_stale.pyramidLevel)
    check("同坐标越界仍返回夹取说明", "夹到有效层" in str(result5), result5)
    check("请求 99 出现在夹取说明里", "level=99" in str(result5), result5)
    check("归一+夹取 no-op 不发 tool_started", len(runner.events) == n_ev3)


def test_continue_refreshes_system_prompt_and_level():
    """旧会话 continue：刷新 system 为当前政策；越界 pyramid_level 归一。"""
    print("== test_continue_refreshes_system_prompt_and_level ==")
    reset_all()
    cfg_path = os.path.join(os.environ["SHARE_DATA_DIR"], "ai_config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"base_url": "http://mock/v1", "api_key": "k", "model": "m",
                   "max_tokens": 256, "max_steps": 1}, f, ensure_ascii=False)
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("g1", "goto", {"x": 100, "y": 200, "level": 1,
                                                          "reason": "看看"})]}),
        _choice({"role": "assistant", "content": "完了",
                 "tool_calls": [_tool_call("f1", "finish", {"summary": "总结"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    check("有 session", bool(sid))

    # 污染：旧肿瘤倾向 system + 越界 level
    OLD_SYS = "你是助手。看清目标后立即落标，优先标出可疑肿瘤区域。"
    with ai_session._SessionLock(sid):
        data = ai_session.read_session(sid)
        msgs = data.get("canonical_messages") or []
        for i, m in enumerate(msgs):
            if m.get("role") == "system":
                msgs[i] = dict(m, content=OLD_SYS)
        data["canonical_messages"] = msgs
        st = data.get("agent_state") or {}
        st["pyramid_level"] = 99
        data["agent_state"] = st
        data["status"] = "paused"
        ai_session.write_session(sid, data)

    data_before = ai_session.read_session(sid)
    check("污染后 system 是旧文案",
          any(m.get("role") == "system" and m.get("content") == OLD_SYS
              for m in (data_before.get("canonical_messages") or [])))
    check("污染后 level=99",
          (data_before.get("agent_state") or {}).get("pyramid_level") == 99)

    resp2 = client.post("/api/ai/continue", json={"slide": "a.svs"})
    _parse_sse(resp2.get_data(as_text=True))
    data_after = ai_session.read_session(sid)
    sys_msgs = [m for m in (data_after.get("canonical_messages") or [])
                if m.get("role") == "system"]
    check("continue 后 system 已换新政策",
          sys_msgs and sys_msgs[0].get("content") == ai_agent.SYSTEM_PROMPT)
    check("continue 后 system 含诊断中立",
          "缺少高倍" in (sys_msgs[0].get("content") or ""))
    # mock slide downs=(1,4,16) → max level 2
    check("continue 后 pyramid_level 归一",
          (data_after.get("agent_state") or {}).get("pyramid_level") == 2,
          data_after.get("agent_state"))


def test_goto_level_zero_in_flow():
    """端到端：概览层起步后模型请求 level 0，事件与 transcript 均应落到 0。"""
    print("== test_goto_level_zero_in_flow ==")
    reset_all()
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("g0", "goto",
                                          {"x": 123, "y": 456, "level": 0,
                                           "reason": "高倍确认细胞"})]}),
        _choice({"role": "assistant", "content": "完",
                 "tool_calls": [_tool_call("f0", "finish", {"summary": "ok"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "高倍看一下", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    gotos = [p for (_, t, p) in events if t == "tool_started" and p and p.get("tool") == "goto"]
    check("有 goto 事件", len(gotos) >= 1)
    check("flow goto level=0", gotos[0].get("level") == 0, gotos[0])
    # 会话 agent_state 也应为 0
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    data = ai_session.read_session(sid) if sid else None
    st = (data or {}).get("agent_state") or {}
    check("持久化 pyramid_level=0", st.get("pyramid_level") == 0, st)


def test_fork_flow():
    print("== test_fork_flow (ask 批注 + 根标注删除 410) ==")
    reset_all()
    # 先造一条 source=ai 的标注作为 fork 根
    roi = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "AI 建议", x=5, y=5,
                              side_px=100, note="可疑区域", source="ai",
                              created_by_session_id="sess_pre")
    aid = roi["annotation_id"]

    # fork 脚本：问→答（纯文本结束）
    script = [
        _choice({"role": "assistant", "content": "这是炎症细胞，无需标注。", "tool_calls": []}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/ask", json={
        "slide": "a.svs", "annotation_id": aid, "question": "这是什么？"})
    check("ask 200", resp.status_code == 200)
    body = resp.get_data(as_text=True)
    events = _parse_sse(body)
    types = [t for (_, t, _) in events]
    check("fork 事件含 fork_created", "fork_created" in types)
    check("fork 事件含 text_delta", "text_delta" in types)
    check("fork 事件含 agent_finished", "agent_finished" in types)
    # fork 没有 create_annotation
    check("fork 无 annotation_created", "annotation_created" not in types)

    # sessions 有 fork
    r = client.get("/api/ai/sessions?slide=a.svs")
    forks = [s for s in r.get_json()["sessions"] if s["kind"] == "fork"]
    check("sessions 有 fork", len(forks) == 1)
    check("fork 关联 annotation_id", forks[0]["annotation_id"] == aid)

    # 根标注删除 → ask 返回 410
    share_store.delete_roi_by_annotation_id(aid)
    resp2 = client.post("/api/ai/ask", json={
        "slide": "a.svs", "annotation_id": aid, "question": "还在吗？"})
    check("根标注删除 ask 410", resp2.status_code == 410)


def test_reconnect_replay():
    print("== test_reconnect_replay (断线重挂重放) ==")
    reset_all()
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("r1", "goto", {"x": 1, "y": 1, "level": 1})]}),
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("r2", "finish", {"summary": "ok"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    sid = None
    last_seq = 0
    for (s, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
        if s: last_seq = max(last_seq, s)
    check("有 session_id", bool(sid))
    # 断线重挂：after_seq = last_seq 之后继续（此时会话已 finished → session_ended）
    r = client.get("/api/ai/session/{}/stream?after_seq={}".format(sid, last_seq))
    check("stream 200", r.status_code == 200)
    body = r.get_data(as_text=True)
    events2 = _parse_sse(body)
    types2 = [t for (_, t, _) in events2]
    check("重挂收到 session_ended", "session_ended" in types2)
    # 重放历史（after_seq=0）会重放全部事件
    r3 = client.get("/api/ai/session/{}/stream?after_seq=0".format(sid))
    body3 = r3.get_data(as_text=True)
    events3 = _parse_sse(body3)
    seqs3 = [s for (s, _, _) in events3 if s is not None]
    check("重放历史事件完整", len(events3) >= 1)
    check("重放 seq 从 1 开始", seqs3[0] == 1)


def test_context_continuity():
    print("== test_context_continuity (tool result 进入后续模型请求) ==")
    reset_all()
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("k1", "goto", {"x": 1, "y": 1, "level": 1})]}),
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [_tool_call("k2", "finish", {"summary": "done"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    resp.get_data(as_text=True)  # 消费 SSE 到 session_ended，确保 worker 完成
    # 第 2 次模型请求应包含第 1 轮 goto 的 tool result
    second_req = mock.calls[1][1]["messages"]
    roles = [m.get("role") for m in second_req]
    check("第二次请求含 role=tool", "tool" in roles)
    tool_msgs = [m for m in second_req if m.get("role") == "tool"]
    check("tool result 内容可见", "已移动到" in str(tool_msgs[0].get("content")))
    # 第 2 次请求也含 system 前缀
    check("第二次请求含 system", second_req[0].get("role") == "system")


def test_archive():
    print("== test_archive ==")
    reset_all()
    roi = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "AI 建议", x=5, y=5,
                              side_px=100, note="n", source="ai", created_by_session_id="s")
    aid = roi["annotation_id"]
    script = [_choice({"role": "assistant", "content": "答", "tool_calls": []})]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()
    client.post("/api/ai/ask", json={"slide": "a.svs", "annotation_id": aid, "question": "q"})
    forks = [s for s in client.get("/api/ai/sessions?slide=a.svs").get_json()["sessions"]
             if s["kind"] == "fork"]
    check("fork 存在", len(forks) == 1)
    fid = forks[0]["id"]
    # 确保 fork 已离开 running（ask SSE 结束后 status=finished）
    time.sleep(0.5)
    print("    fork status:", ai_session.read_session(fid).get("status"))
    r = client.post("/api/ai/session/" + fid + "/archive")
    print("    archive resp:", r.status_code, r.get_data(as_text=True)[:200])
    check("archive 200", r.status_code == 200 and r.get_json().get("archived") is True)
    # 归档后不在活跃列表
    forks2 = [s for s in client.get("/api/ai/sessions?slide=a.svs").get_json()["sessions"]
              if s["kind"] == "fork"]
    check("归档 fork 不在活跃列表", len(forks2) == 0)
    r = client.post("/api/ai/session/" + fid + "/unarchive")
    check("unarchive 200", r.status_code == 200 and r.get_json().get("archived") is False)


def test_context_exceeded_retry():
    """超窗(400 context_length_exceeded) → compact → 重试成功 → 正常 finish。"""
    print("== test_context_exceeded_retry (超窗后 compact 重试成功) ==")
    reset_all()
    err = _http_error(400, "This model's maximum context length is 4097 tokens. "
                            "However, your messages resulted in 5000 tokens. "
                            '{"error":{"code":"context_length_exceeded",...}}')
    finish = _choice({"role": "assistant", "content": "看完了",
                      "tool_calls": [_tool_call("f1", "finish", {"summary": "完成"})]})
    mock = MockModelRaise([err, finish])
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("超窗重试含 session_compacted", "session_compacted" in types)
    comp = [p for (_, t, p) in events if t == "session_compacted"]
    check("session_compacted 带 reason=context_length_exceeded",
          comp and (comp[0] or {}).get("reason") == "context_length_exceeded")
    check("超窗重试后 agent_finished", "agent_finished" in types)
    check("超窗重试不 agent_error", "agent_error" not in types)
    check("模型调用恰好 2 次（1 失败 + 1 重试）", len(mock.calls) == 2)
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    d = ai_session.read_session(sid)
    check("会话终态 finished", d and d.get("status") == "finished")


def test_context_exceeded_retry_fail():
    """超窗后重试仍超窗 → agent_error 终止（不无限重试）。"""
    print("== test_context_exceeded_retry_fail (重试仍失败则终止) ==")
    reset_all()
    err = _http_error(400, "context_length_exceeded")
    mock = MockModelRaise([err, err])
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("重试仍超窗含 agent_error", "agent_error" in types)
    check("重试仍超窗不 agent_finished", "agent_finished" not in types)
    check("仅重试一次（共 2 次调用）", len(mock.calls) == 2)
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    d = ai_session.read_session(sid)
    check("会话终态 error", d and d.get("status") == "error")


def test_non_context_error_no_retry():
    """瞬时错误（5xx/网络）退避重试；非瞬时（4xx 鉴权）不触发 compact、直接终止。"""
    print("== test_non_context_error_no_retry (瞬时退避/非瞬时终止) ==")
    reset_all()
    # 401 鉴权错误：非瞬时、非超窗 → 不 compact、不重试，直接 agent_error
    err401 = _http_error(401, "invalid api key")
    mock = MockModelRaise([err401])
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("401 错误 agent_error", "agent_error" in types)
    check("401 错误无 session_compacted", "session_compacted" not in types)
    check("401 非瞬时不重试（只 1 次调用）", len(mock.calls) == 1)


def test_transient_error_retry():
    """瞬时错误（500）退避重试：首次 500 → agent_retrying → 重试成功 → finish。"""
    print("== test_transient_error_retry (瞬时错误退避重试) ==")
    reset_all()
    _write_ai_config()
    err500 = _http_error(500, "server error")
    finish = _choice({"role": "assistant", "content": "完成",
                      "tool_calls": [_tool_call("f", "finish", {"summary": "ok"})]},
                     finish_reason="tool_calls")
    # 第 1 次 500（瞬时）→ 退避重试 → 第 2 次正常 finish
    mock = MockModelRaise([err500, finish])
    import requests
    requests.post = mock
    import ai_agent as _ag
    # 退避 sleep 加速（2s→0）
    orig_sleep = _ag.time.sleep
    _ag.time.sleep = lambda s: None
    try:
        client = app_mod.app.test_client()
        resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
        events = _parse_sse(resp.get_data(as_text=True))
    finally:
        _ag.time.sleep = orig_sleep
    types = [t for (_, t, _) in events]
    check("瞬时 500 含 agent_retrying", "agent_retrying" in types)
    check("瞬时 500 重试后 agent_finished", "agent_finished" in types)
    check("瞬时 500 不 agent_error", "agent_error" not in types)
    check("瞬时 500 共 2 次调用（1 失败+1 重试）", len(mock.calls) == 2)


def test_max_steps_default_50():
    """不传 max_steps（配置里也没有）→ 默认 50 步上限，到顶 agent_paused。"""
    print("== test_max_steps_default_50 (默认 50 步上限) ==")
    reset_all()
    cfg_path = os.path.join(os.environ["SHARE_DATA_DIR"], "ai_config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        # 故意不写 max_steps：验证默认 50
        json.dump({"base_url": "http://mock/v1", "api_key": "k", "model": "m",
                   "max_tokens": 256}, f, ensure_ascii=False)
    goto_call = _choice({"role": "assistant", "content": "",
                         "tool_calls": [_tool_call("g", "goto",
                                                   {"x": 10, "y": 10, "level": 1})]})
    script = [goto_call] * 50
    mock = MockModelRaise(script)
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("默认 50 步到顶 agent_paused", "agent_paused" in types)
    check("默认 50 步共 50 次模型调用", len(mock.calls) == 50)
    check("默认 50 步无 agent_finished", "agent_finished" not in types)
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    d = ai_session.read_session(sid)
    check("会话终态 paused", d and d.get("status") == "paused")


def test_event_reset():
    """after_seq < event_min_seq（缓冲已滚过断点）→ 收到 event_reset 帧。"""
    print("== test_event_reset (断点被滚动窗口丢弃 → event_reset) ==")
    reset_all()
    # 小 event_buffer：让 event_min_seq 快速前移，且不启动真实 worker
    cfg = {"base_url": "http://mock/v1", "api_key": "k", "model": "m",
           "max_steps": 3, "event_buffer": 5}
    r = ai_session.SessionRunner.acquire("a.svs", "main", cfg=cfg)
    for i in range(10):
        r.emit_event("text_delta", {"text": "e{}".format(i)})
    r.pause()  # 离开 running，SSE 才能正常收尾
    data = r.get_data()
    min_seq = int(data.get("event_min_seq") or 0)
    last_seq = int(data.get("last_event_seq") or 0)
    check("event_min_seq 前移（>5）", min_seq > 5)

    client = app_mod.app.test_client()
    # after_seq=2 < event_min_seq → event_reset
    resp = client.get("/api/ai/session/{}/stream?after_seq=2".format(r.session_id))
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("重挂收到 event_reset", "event_reset" in types)
    rp = None
    for (_, t, p) in events:
        if t == "event_reset":
            rp = p
    check("event_reset 带 event_min_seq", rp and rp.get("event_min_seq") == min_seq)
    check("event_reset 带 last_event_seq", rp and rp.get("last_event_seq") == last_seq)
    check("event_reset 后不重放旧事件", not any(s is not None and s <= 2 for (s, _, _) in events))
    # after_seq >= event_min_seq → 不触发 event_reset（走正常重放/收尾）
    resp2 = client.get("/api/ai/session/{}/stream?after_seq={}".format(r.session_id, last_seq))
    events2 = _parse_sse(resp2.get_data(as_text=True))
    types2 = [t for (_, t, _) in events2]
    check("after_seq>=min_seq 无 event_reset", "event_reset" not in types2)


def test_length_truncation_pauses():
    """finish_reason=length（Anthropic max_tokens）不得 mark_finished，应 pause。"""
    print("== test_length_truncation_pauses (截断 → paused) ==")
    reset_all()
    script = [
        _choice({"role": "assistant", "content": "这是被截断的回答…", "tool_calls": []},
                finish_reason="length"),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock

    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    types = [t for (_, t, _) in events]
    check("截断发 agent_paused", "agent_paused" in types)
    check("截断不发 agent_finished", "agent_finished" not in types)
    paused_payload = None
    for (_, t, p) in events:
        if t == "agent_paused":
            paused_payload = p
    check("paused payload reason=max_tokens",
          paused_payload and paused_payload.get("reason") == "max_tokens")
    sid = None
    for (_, t, p) in events:
        if t == "slide_opened" and p:
            sid = p.get("session_id")
    d = ai_session.read_session(sid)
    check("截断会话终态 paused", d and d.get("status") == "paused")


def test_snapshot_reviewed_has_no_annotation_reason():
    """snapshot_reviewed 实时事件应带 no_annotation_reason（与历史恢复一致）。"""
    print("== test_snapshot_reviewed_has_no_annotation_reason ==")
    reset_all()
    script = [
        _choice({"role": "assistant", "content": "",
                 "tool_calls": [
                     _tool_call("s1", "snapshot", {"out_w": 512, "out_h": 512}),
                     _tool_call("o1", "mark_observation",
                                {"snapshot_id": "s1", "label": "正常",
                                 "note": "未见异常", "no_annotation_reason": "炎症细胞"}),
                     _tool_call("r1", "complete_snapshot_review",
                                {"snapshot_id": "s1", "disposition": "no_annotation",
                                 "summary": "无需标",
                                 "no_annotation_reason": "仅见炎症细胞"}),
                     _tool_call("f1", "finish", {"summary": "ok"})]}),
    ]
    mock = MockModel(script)
    import requests
    requests.post = mock
    client = app_mod.app.test_client()
    resp = client.post("/api/ai/run", json={"slide": "a.svs", "task": "t", "fresh": 1})
    events = _parse_sse(resp.get_data(as_text=True))
    reviewed = [p for (_, t, p) in events if t == "snapshot_reviewed"]
    check("有 snapshot_reviewed", len(reviewed) >= 1)
    if reviewed:
        p = reviewed[0] or {}
        check("snapshot_reviewed 含 no_annotation_reason 字段",
              "no_annotation_reason" in p)
        check("snapshot_reviewed no_annotation_reason 值正确",
              p.get("no_annotation_reason") == "仅见炎症细胞")


class _FakeDigestRunner:
    """消化工具用 fake runner：snapshot_state + observations + 事件。"""

    def __init__(self, pending_id="snap1", observations=None):
        self._pending = pending_id
        self.observations = list(observations or [])
        self.events = []
        self.completed = None

    def snapshot_state(self):
        return {"snapshot_id": self._pending} if self._pending else {}

    def get_data(self):
        return {"observations": self.observations}

    def add_observation(self, obs):
        self.observations.append(obs)

    def emit_event(self, typ, payload):
        self.events.append((typ, payload))

    def complete_snapshot_review(self, snap_id):
        self.completed = snap_id
        self._pending = None
        return True


def _digest_ctx():
    return ai_agent.AgentState(0, 0, 1024, 0, 0.25), (1.0, 4.0, 16.0)


def test_digest_without_snapshot_id():
    """不带 snapshot_id 也能 mark_observation / complete（服务端跟踪 pending）。"""
    print("== test_digest_without_snapshot_id ==")
    st, downs = _digest_ctx()
    runner = _FakeDigestRunner(pending_id="snap1")
    # mark_observation 不带 snapshot_id
    res, done = ai_agent._execute_tool(
        "mark_observation", {"label": "ob", "note": "所见", "x": 1, "y": 2, "w": 3, "h": 4},
        "t1", st, downs, runner, "main", {})
    check("mark_observation 不带 id 成功", done is False and "已记录观察" in str(res), res)
    check("观察落库带 snapshot_id", bool(runner.observations) and
          runner.observations[-1].get("snapshot_id") == "snap1")
    # complete 不带 snapshot_id
    res2, done2 = ai_agent._execute_tool(
        "complete_snapshot_review", {"disposition": "annotated", "summary": "s"},
        "t2", st, downs, runner, "main", {})
    check("complete 不带 id 成功", done2 is False and "已关闭快照" in str(res2), res2)
    check("complete 关闭的是当前 pending", runner.completed == "snap1")


def test_complete_fallback_summary():
    """complete 缺省 summary 时兜底到最后一条该快照 observation 的 note。"""
    print("== test_complete_fallback_summary ==")
    st, downs = _digest_ctx()
    runner = _FakeDigestRunner(
        pending_id="snap9",
        observations=[{"snapshot_id": "snap9", "note": "未见异常病灶", "label": "正常"},
                      {"snapshot_id": "snap0", "note": "别处", "label": "x"}])
    res, done = ai_agent._execute_tool(
        "complete_snapshot_review", {"disposition": "annotated"},
        "t1", st, downs, runner, "main", {})
    check("缺省 summary 仍成功", done is False and "已关闭快照" in str(res), res)
    reviewed = [p for (t, p) in runner.events if t == "snapshot_reviewed"]
    check("snapshot_reviewed 发出", len(reviewed) == 1)
    check("兜底 summary 取最后观察 note",
          reviewed and reviewed[0].get("summary") == "未见异常病灶",
          reviewed[0] if reviewed else None)


def test_digest_no_pending():
    """无 pending 快照时三个消化工具都返回"当前没有待消化的快照"。"""
    print("== test_digest_no_pending ==")
    st, downs = _digest_ctx()
    runner = _FakeDigestRunner(pending_id=None)
    for name, args in [
        ("mark_observation", {"label": "ob"}),
        ("create_annotation", {"label": "L", "x": 1, "y": 1, "side_px": 10}),
        ("complete_snapshot_review", {"disposition": "annotated"}),
    ]:
        res, done = ai_agent._execute_tool(name, args, "t", st, downs, runner, "main", {})
        check("无 pending 被拦：{}".format(name),
              "当前没有待消化的快照；请先 snapshot。" in str(res), res)


def test_guide_shows_0_3x_not_0x():
    """guide 中 mag<1 的层显示为 0.3x 而非 0x。"""
    print("== test_guide_shows_0_3x_not_0x ==")
    info = {"mpp": 0.25, "level_downsamples": (1.0, 4.0, 16.0, 64.0, 128.0)}
    guide = ai_agent.magnification_guide(info)
    check("全片概览层显示 0.3x", "≈0.3x" in guide, guide)
    check("不显示为 0x", "≈0x" not in guide, guide)


def reset_all():
    """清空 share_store 与 ai_sessions。"""
    share_store.SHARE_FILE.unlink(missing_ok=True)
    sess_dir = os.path.join(os.environ["SHARE_DATA_DIR"], "ai_sessions")
    if os.path.isdir(sess_dir):
        import shutil
        shutil.rmtree(sess_dir, ignore_errors=True)
    cfg = os.path.join(os.environ["SHARE_DATA_DIR"], "ai_config.json")
    if os.path.exists(cfg):
        os.unlink(cfg)
    _write_ai_config()
    # 恢复原 requests.post
    import requests
    requests.post = requests.post.__self__.post if hasattr(requests.post, "__self__") else requests.post


if __name__ == "__main__":
    # 预置：写配置 + monkeypatch region + 恢复 requests.post 兜底
    os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)
    _write_ai_config()
    _monkeypatch_region()

    test_main_flow()
    test_fresh_query_param()
    test_pause_continue()
    test_cancel()
    test_cancel_discards_model_response()
    test_slide_magnification_guide()
    test_pick_overview_level_tolerance()
    test_goto_level_zero_and_clamp()
    test_continue_refreshes_system_prompt_and_level()
    test_goto_level_zero_in_flow()
    test_fork_flow()
    test_reconnect_replay()
    test_context_continuity()
    test_archive()
    test_context_exceeded_retry()
    test_context_exceeded_retry_fail()
    test_non_context_error_no_retry()
    test_transient_error_retry()
    test_max_steps_default_50()
    test_event_reset()
    test_length_truncation_pauses()
    test_snapshot_reviewed_has_no_annotation_reason()
    test_digest_without_snapshot_id()
    test_complete_fallback_summary()
    test_digest_no_pending()
    test_guide_shows_0_3x_not_0x()
    print("\nPASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
