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
    return sid


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
    test_pause_continue()
    test_cancel()
    test_fork_flow()
    test_reconnect_replay()
    test_context_continuity()
    test_archive()
    print("\nPASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
