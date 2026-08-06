# -*- coding: utf-8 -*-
"""阶段1 单元测试：ROI 迁移 / change_seq / SessionRunner（fencing/WAL/cancel/compact）。

运行：cd 项目根 && python3 tests/test_ai_session.py
用独立临时 SHARE_DATA_DIR，避免污染真实数据。
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ai_session
import share_store

TMP = tempfile.mkdtemp(prefix="svs-ai-test-")
os.environ["SHARE_DATA_DIR"] = os.path.join(TMP, "share-data")

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


def reset_store():
    """清空 share_store 数据文件（各用例独立起步）。"""
    os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)
    share_store.SHARE_FILE.unlink(missing_ok=True)


# =========================================================================== #
# 1. ROI 迁移与 change_seq
# =========================================================================== #
def test_migration_and_change_seq():
    print("== test_migration_and_change_seq ==")
    reset_store()
    # 直接写旧格式数据（模拟存量）
    share_store.SHARE_FILE.write_text(json.dumps({
        "shares": {},
        "rois": [
            {"token": "admin", "slide": "a.svs", "label": "管理员", "ts": 1.0,
             "shared": True, "note": "旧", "visitor": "", "type": "rect",
             "x": 1, "y": 2, "side_px": 100, "size_mm": 6.0},
            {"token": "admin", "slide": "a.svs", "label": "管理员", "ts": 2.0,
             "shared": True, "note": "旧2", "visitor": "", "type": "rect",
             "x": 3, "y": 4, "side_px": 200, "size_mm": 6.0},
        ],
        "projects": {},
        "slide_meta": {},
    }), encoding="utf-8")
    # 第一次读触发迁移
    rois = share_store.list_rois("admin")
    check("迁移后 2 条", len(rois) == 2)
    a = rois[0]
    check("annotation_id 补 UUID", a.get("annotation_id") and len(a["annotation_id"]) >= 8)
    check("source 默认 human", a.get("source") == "human")
    check("revision=1", a.get("revision") == 1)
    check("deleted=False", a.get("deleted") is False)
    check("change_seq 递增初值", {r["change_seq"] for r in rois} == {1, 2})
    check("counter 初始化=2", share_store.current_change_seq("a.svs") == 2)

    # 新建：change_seq 继续递增（3）
    new = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "AI 建议",
                              note="新", x=5, y=5, side_px=50,
                              source="ai", created_by_session_id="sess_x")
    check("新建 change_seq=3", new["change_seq"] == 3)
    check("新建 source=ai", new["source"] == "ai")
    check("新建 created_by_session_id", new["created_by_session_id"] == "sess_x")

    # 编辑：revision+1、change_seq 递增（4）
    up = share_store.update_roi(share_store.ADMIN_TOKEN, 0, note="改过了")
    check("编辑 revision=2", up["revision"] == 2)
    check("编辑 change_seq=4", up["change_seq"] == 4)

    # 删除：tombstone，change_seq 递增（5），重复删除 no-op
    ok, aid = share_store.delete_roi(share_store.ADMIN_TOKEN, 0)
    check("删除成功", ok is True)
    check("删除有 annotation_id", bool(aid))
    check("删除后 change_seq=5", share_store.current_change_seq("a.svs") == 5)
    seq_after_first_del = share_store.current_change_seq("a.svs")
    # 对已 tombstone 的同一 ROI 再删（按稳定 ID）→ no-op，不递增
    ok2 = share_store.delete_roi_by_annotation_id(aid)
    check("重复删除 no-op", ok2 is False)
    check("重复删除不递增", share_store.current_change_seq("a.svs") == seq_after_first_del)

    # 默认接口过滤 tombstone；list_changes 返回 tombstone
    vis = share_store.list_rois("admin")
    check("list_rois 过滤 tombstone", len(vis) == 2)  # 旧2 + AI建议（幂等条尚未添加）
    all_changes = share_store.list_changes("a.svs", 0)
    check("list_changes 含 tombstone", any(r.get("deleted") for r in all_changes))
    check("list_changes 覆盖删除 seq", max(r["change_seq"] for r in all_changes) >= 5)

    # get_roi 过滤 tombstone
    g = share_store.get_roi(share_store.ADMIN_TOKEN, 0)
    check("get_roi 过滤 tombstone", g is not None and not g.get("deleted"))

    # 幂等 effect_key
    r1 = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "幂等", x=9, y=9, side_px=10,
                             _effect_key="sess_1:1:call_1")
    seq_before = share_store.current_change_seq("a.svs")
    r2 = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "幂等", x=9, y=9, side_px=10,
                             _effect_key="sess_1:1:call_1")
    check("effect_key 幂等复用同 annotation_id", r1["annotation_id"] == r2["annotation_id"])
    check("effect_key 幂等不递增 seq", share_store.current_change_seq("a.svs") == seq_before)
    check("effect_key 幂等不重复落标",
          sum(1 for r in share_store.list_rois("admin") if r["annotation_id"] == r1["annotation_id"]) == 1)


# =========================================================================== #
# 2. SessionRunner：acquire / 原子抢占 / fencing
# =========================================================================== #
def test_acquire_and_fencing():
    print("== test_acquire_and_fencing ==")
    reset_store()
    r1 = ai_session.SessionRunner.acquire("a.svs", "main")
    check("acquire 置 running", r1.get_data()["status"] == "running")
    check("active_run_id 分配", bool(r1.get_data()["active_run_id"]))
    epoch1 = r1.get_data()["lease_epoch"]
    check("lease_epoch>=1", epoch1 >= 1)
    # 同 session 再次 acquire → 409（running 且租约未过期）
    try:
        ai_session.SessionRunner.acquire("a.svs", "main", session_id=r1.session_id)
        check("running 中抢占被拒", False)
    except ai_session.SessionConflict:
        check("running 中抢占被拒", True)
    # 租约过期 → 强制恢复 paused 后重新抢占（epoch 递增）
    data = r1.get_data()
    data["lease_expires_at"] = time.time() - 10
    data["status"] = "running"
    ai_session.write_session(r1.session_id, data)
    r2 = ai_session.SessionRunner.acquire("a.svs", "main", session_id=r1.session_id)
    check("过期后重新抢占", r2.get_data()["status"] == "running")
    check("epoch 递增", r2.get_data()["lease_epoch"] > epoch1)

    # 旧 worker（r1）的 fencing 校验必须失败（旧 epoch）
    try:
        r1.assert_lease()
        check("旧 worker assert_lease 被拒", False)
    except ai_session.LeaseError:
        check("旧 worker assert_lease 被拒", True)
    # 旧 worker 不能再 begin_bundle / 写事件
    try:
        r1.begin_bundle({"role": "assistant", "tool_calls": []})
        check("旧 worker begin_bundle 被拒", False)
    except ai_session.LeaseError:
        check("旧 worker begin_bundle 被拒", True)

    # 新 worker 正常写
    tcs = r2.begin_bundle({"role": "assistant", "tool_calls": [
        {"id": "c1", "function": {"name": "finish", "arguments": "{}"}}]})
    check("新 worker begin_bundle 正常", len(tcs) == 1)
    check("effect_key 含 bundle_seq",
          tcs[0]["effect_key"] == "{}:1:c1".format(r2.session_id))

    # heartbeat 过期不续活
    r3 = ai_session.SessionRunner.acquire("a.svs", "main")
    d = r3.get_data()
    d["lease_expires_at"] = time.time() - 5
    ai_session.write_session(r3.session_id, d)
    try:
        r3.heartbeat()
        check("过期 heartbeat 被拒", False)
    except ai_session.LeaseError:
        check("过期 heartbeat 被拒", True)


# =========================================================================== #
# 3. WAL：begin → record → commit；崩溃恢复续执行幂等；取消
# =========================================================================== #
def test_wal_and_cancel():
    print("== test_wal_and_cancel ==")
    reset_store()
    r = ai_session.SessionRunner.acquire("a.svs", "main")
    tcs = r.begin_bundle({"role": "assistant", "content": "去落标注",
                          "tool_calls": [
                              {"id": "c1", "function": {"name": "create_annotation",
                                                        "arguments": json.dumps(
                                                            {"label": "L", "x": 1, "y": 2,
                                                             "side_px": 50, "note": "n"})}},
                              {"id": "c2", "function": {"name": "goto",
                                                        "arguments": json.dumps(
                                                            {"x": 10, "y": 10, "level": 0})}},
                          ]})
    # 执行副作用（带 fencing 临界区）
    e1 = tcs[0]
    with r.acquire_lease_for_side_effect():
        roi = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "L", x=1, y=2,
                                  side_px=50, note="n", source="ai",
                                  created_by_session_id=r.session_id,
                                  _effect_key=e1["effect_key"])
    r.record_tool_result("c1", "已落标注 idx={}".format(roi["index"]))
    r.record_tool_result("c2", "已移动")
    r.commit_bundle()
    data = r.get_data()
    check("commit 清 pending", data["pending_bundle"] is None)
    msgs = data["canonical_messages"]
    check("canonical 有 assistant+2 tool", len(msgs) == 3)
    check("canonical assistant 保留 tool_calls", msgs[0].get("tool_calls"))

    # 崩溃恢复：pending 存在但 tool 已执行过 → 幂等复用不重复落标
    r2 = ai_session.SessionRunner.acquire("a.svs", "main")
    # 手工造一个崩溃现场：pending_bundle 未提交，但 effect_key 已在 share_store 落过
    with ai_session._SessionLock(r2.session_id):
        d = r2.get_data()
        d["pending_bundle"] = {
            "assistant_msg": {"role": "assistant", "content": "恢复",
                              "tool_calls": [{"id": "c9", "function": {"name": "create_annotation",
                                                                       "arguments": json.dumps(
                                                                           {"label": "L9", "x": 3, "y": 3,
                                                                            "side_px": 40, "note": "n9"})}}]},
            "tool_calls": [{"tool_call_id": "c9", "name": "create_annotation",
                            "args": {"label": "L9", "x": 3, "y": 3, "side_px": 40, "note": "n9"},
                            "effect_key": "{}:9:c9".format(r2.session_id),
                            "status": "pending"}],
            "started_at": time.time(),
        }
        ai_session.write_session(r2.session_id, d)
    # 恢复：按 effect_key 补执行
    pb = r2.get_data()["pending_bundle"]
    for e in pb["tool_calls"]:
        with r2.acquire_lease_for_side_effect():
            roi = share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", e["args"]["label"],
                                      x=e["args"]["x"], y=e["args"]["y"],
                                      side_px=e["args"]["side_px"], note=e["args"]["note"],
                                      source="ai", created_by_session_id=r2.session_id,
                                      _effect_key=e["effect_key"])
        r2.record_tool_result(e["tool_call_id"], "已落标注")
    r2.commit_bundle()
    rois = share_store.list_rois("admin")
    check("崩溃恢复不重复落标", sum(1 for x in rois if x["label"] == "L9") == 1)

    # 用户取消：未开始的工具写"用户已取消" result，不再执行
    r3 = ai_session.SessionRunner.acquire("a.svs", "main")
    tcs3 = r3.begin_bundle({"role": "assistant", "content": "要取消",
                            "tool_calls": [
                                {"id": "x1", "function": {"name": "create_annotation",
                                                          "arguments": json.dumps(
                                                              {"label": "X1", "x": 5, "y": 5,
                                                               "side_px": 30, "note": ""})}},
                            ]})
    r3.mark_cancelled()
    # 模型侧在下一次循环开头发现已取消 → 不执行副作用，直接 record"用户已取消"
    r3.record_tool_result("x1", "用户已取消")
    r3.commit_bundle()
    data3 = r3.get_data()
    tool_msg = [m for m in data3["canonical_messages"] if m.get("role") == "tool"]
    check("取消后 bundle 已提交", len(tool_msg) == 1)
    check("取消 result 已记录", "用户已取消" in str(tool_msg[0].get("content")))
    check("取消后无新增标注",
          all(x["label"] != "X1" for x in share_store.list_rois("admin")))

    # finish 回写 tool result（§5.4 v4：每个 call 都有 result）
    r4 = ai_session.SessionRunner.acquire("a.svs", "main")
    tcs4 = r4.begin_bundle({"role": "assistant", "content": "同发 finish",
                            "tool_calls": [
                                {"id": "f1", "function": {"name": "create_annotation",
                                                          "arguments": json.dumps(
                                                              {"label": "F1", "x": 6, "y": 6,
                                                               "side_px": 30, "note": ""})}},
                                {"id": "f2", "function": {"name": "finish",
                                                          "arguments": json.dumps(
                                                              {"summary": "完成"})}},
                            ]})
    with r4.acquire_lease_for_side_effect():
        share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "F1", x=6, y=6,
                            side_px=30, note="", source="ai",
                            created_by_session_id=r4.session_id,
                            _effect_key=tcs4[0]["effect_key"])
    r4.record_tool_result("f1", "已落标注")
    r4.record_tool_result("f2", "已结束")
    r4.commit_bundle()
    tool_msgs = [m for m in r4.get_data()["canonical_messages"] if m.get("role") == "tool"]
    check("finish 也有 result（2 个 tool 消息）", len(tool_msgs) == 2)


# =========================================================================== #
# 4. 事件 log：seq / 断线重放 / 崩溃修复 seq
# =========================================================================== #
def test_event_log():
    print("== test_event_log ==")
    reset_store()
    r = ai_session.SessionRunner.acquire("a.svs", "main")
    r.emit_event("text_delta", {"text": "你好"})
    r.emit_event("annotation_created", {"index": 0})
    r.emit_event("agent_paused", {"can_continue": True})
    data = r.get_data()
    check("event seq 单调递增", data["last_event_seq"] == 3)
    check("event_min_seq 有效", data["event_min_seq"] >= 1)
    evs = ai_session.replay_events(r.session_id, 1, data)
    check("重放 seq>1 得 2 条", len(evs) == 2)
    check("重放 seq 连续", [e["seq"] for e in evs] == [2, 3])

    # 崩溃：events.jsonl 追加到 seq 5，但元数据停在 3 → 修复
    with open(ai_session._events_file(r.session_id), "a", encoding="utf-8") as f:
        for i in (4, 5):
            f.write(json.dumps({"seq": i, "type": "text_delta",
                                "payload": {"text": "x"}, "ts": time.time()}) + "\n")
    d2 = r.get_data()
    ai_session._repair_event_seq(r.session_id, d2)
    # 修复结果需持久化（真实流程中 acquire() 的 CAS 会写回）
    ai_session.write_session(r.session_id, d2)
    check("崩溃修复 last_event_seq=5", d2["last_event_seq"] == 5)
    # 新事件从 6 开始
    r.emit_event("text_delta", {"text": "续"})
    check("修复后不重复分配", r.get_data()["last_event_seq"] == 6)

    # fanout 断线重挂：after_seq 重放（只取重放部分，不阻塞等 live 事件）
    import itertools
    fan = ai_session.EventFanout(after_seq=4, data_provider=lambda: r.get_data())
    r.attach_fanout(fan)
    got = list(itertools.islice(fan.iter_events(), 2))
    check("断线重挂重放 seq5/6", [e["seq"] for e in got] == [5, 6])
    r.detach_fanout(fan)
    fan.close()


# =========================================================================== #
# 5. compact：触发公式 / bundle 切分 / 摘要 / spot 注入
# =========================================================================== #
def test_compact():
    print("== test_compact ==")
    reset_store()
    cfg = {"context_window_tokens": 5000, "reserve_tokens": 500,
           "safety_margin": 200, "keep_recent_tokens": 300}
    r = ai_session.SessionRunner.acquire("a.svs", "main", cfg=cfg)
    # 造 6 个 bundle（assistant + tool 各一），文本量足够撑大
    for i in range(6):
        tcs = r.begin_bundle({"role": "assistant", "content": "bundle {} {}".format(i, "字" * 600),
                              "tool_calls": [{"id": "c{}".format(i),
                                              "function": {"name": "mark_observation",
                                                           "arguments": json.dumps(
                                                               {"label": "ob{}".format(i),
                                                                "note": "看" * 600})}}]})
        r.record_tool_result("c{}".format(i), "已记录")
        r.commit_bundle()
    before = len(r.get_data()["canonical_messages"])
    ok = r.maybe_compact()
    check("紧凑触发", ok is True)
    data = r.get_data()
    check("compact 后有 summary", bool(data.get("summary")))
    check("compact 后消息变少", len(data["canonical_messages"]) < before)
    # 必须按完整 bundle 切：不能出现 tool 消息在开头而 assistant 在前一截
    msgs = data["canonical_messages"]
    first = msgs[0]
    check("cutoff 处是 assistant/system", first.get("role") in ("system", "assistant"))
    # keep_recent_tokens 边界：非 system 且非 assistant-with-tool 的头一条不是 tool
    for i, m in enumerate(msgs):
        if m.get("role") == "tool":
            check("没有孤零 tool 打头", i > 0 and msgs[i - 1].get("role") == "assistant")
            break

    # 不触发：清空后少量消息
    r2 = ai_session.SessionRunner.acquire("a.svs", "main")
    check("少量消息不触发", r2.maybe_compact() is False)


# =========================================================================== #
# 6. snapshot 守卫（pending 状态机）
# =========================================================================== #
def test_snapshot_guard():
    print("== test_snapshot_guard ==")
    reset_store()
    r = ai_session.SessionRunner.acquire("a.svs", "main")
    check("初始无 pending", not r.is_snapshot_pending())
    r.set_pending_snapshot("snap1", {"x": 0, "y": 0, "w": 100, "h": 100},
                           {"type": "image_ref", "ref_id": "r1"})
    check("进入 pending", r.is_snapshot_pending())
    check("snapshot_id 正确", r.snapshot_id() == "snap1")
    check("complete 不匹配拒绝", r.complete_snapshot_review("snap2") is False)
    check("complete 匹配关闭", r.complete_snapshot_review("snap1") is True)
    check("关闭后无 pending", not r.is_snapshot_pending())


# =========================================================================== #
# 7. spot 变更注入（§8.4）
# =========================================================================== #
def test_spot_inject():
    print("== test_spot_inject ==")
    reset_store()
    share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "旧标注", x=1, y=1,
                        side_px=100, note="旧", source="human")
    r = ai_session.SessionRunner.acquire("a.svs", "main")
    # 初始 cursor=0，启动时注入存量 spot
    r.inject_spot_changes()
    msgs = r.get_data()["canonical_messages"]
    check("启动注入 spot 消息", any("spot_updated" in m for m in msgs))
    cursor = r.get_data()["spot_cursor"]
    check("cursor 推进到当前水位", cursor == share_store.current_change_seq("a.svs"))
    # 无新变更 → 不再注入
    n_before = len(r.get_data()["canonical_messages"])
    r.inject_spot_changes()
    check("无变更不重复注入", len(r.get_data()["canonical_messages"]) == n_before)
    # 新变更（新建 + 删除）→ 追加 spot_updated / spot_deleted
    share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "新标注", x=2, y=2,
                        side_px=50, note="新", source="ai",
                        created_by_session_id=r.session_id)
    _, aid = share_store.delete_roi(share_store.ADMIN_TOKEN, 0)
    r.inject_spot_changes()
    msgs2 = r.get_data()["canonical_messages"]
    check("新变更注入 spot_updated", any("spot_updated" in m for m in msgs2[n_before:]))
    check("删除注入 spot_deleted", any("spot_deleted" in m for m in msgs2[n_before:]))


# =========================================================================== #
# 8. force_compact（§3.6 超窗兜底）与 max_steps 默认值
# =========================================================================== #
def test_force_compact():
    print("== test_force_compact (超窗兜底强制压缩) ==")
    reset_store()
    cfg = {"context_window_tokens": 5000, "reserve_tokens": 500,
           "safety_margin": 200, "keep_recent_tokens": 300}
    r = ai_session.SessionRunner.acquire("a.svs", "main", cfg=cfg)
    for i in range(6):
        tcs = r.begin_bundle({"role": "assistant", "content": "bundle {} {}".format(i, "字" * 600),
                              "tool_calls": [{"id": "c{}".format(i),
                                              "function": {"name": "mark_observation",
                                                           "arguments": json.dumps(
                                                               {"label": "ob{}".format(i),
                                                                "note": "看" * 600})}}]})
        r.record_tool_result("c{}".format(i), "已记录")
        r.commit_bundle()
    before = len(r.get_data()["canonical_messages"])
    r.force_compact(reason="context_length_exceeded")
    data = r.get_data()
    check("force_compact 后消息变少", len(data["canonical_messages"]) < before)
    check("force_compact 有 summary", bool(data.get("summary")))
    # session_compacted 事件落盘且带 reason（前端显示"已压缩并继续"）
    evs = ai_session.replay_events(r.session_id, 0, data)
    comp = [e for e in evs if e.get("type") == "session_compacted"]
    check("session_compacted 事件已发", len(comp) == 1)
    check("session_compacted 带 reason", (comp[0].get("payload") or {}).get("reason") == "context_length_exceeded")


def test_default_max_steps():
    print("== test_default_max_steps ==")
    check("DEFAULT_CONFIG max_steps=50", ai_session.DEFAULT_CONFIG["max_steps"] == 50)
    check("_merge_config({}) max_steps=50", ai_session._merge_config({})["max_steps"] == 50)
    check("_merge_config 可覆盖 max_steps", ai_session._merge_config({"max_steps": 3})["max_steps"] == 3)


def test_display_text_stripped():
    print("== test_display_text_stripped ==")
    cfg = ai_session._merge_config({"base_url": "http://x", "api_key": "k", "model": "m"})
    r = ai_session.SessionRunner.acquire("a.svs", "main", title="t", cfg=cfg, fresh=True)
    r.append_message({
        "role": "user",
        "content": "切片：a.svs（1×1）。\n任务：扫一遍",
        "display_text": "扫一遍",
    })
    data = r.get_data()
    canon = data["canonical_messages"]
    check("canonical 保留 display_text",
          any(m.get("display_text") == "扫一遍" for m in canon))
    req = r.materialize_request_messages()
    check("request 剥离 display_text",
          all("display_text" not in m for m in req))
    check("request 仍有 content",
          any(m.get("role") == "user" and "扫一遍" in str(m.get("content")) for m in req))


def test_ensure_current_system_prompt():
    print("== test_ensure_current_system_prompt ==")
    import ai_agent
    cfg = ai_session._merge_config({"base_url": "http://x", "api_key": "k", "model": "m"})
    r = ai_session.SessionRunner.acquire("b.svs", "main", title="t", cfg=cfg, fresh=True)
    r.append_message({"role": "system", "content": "旧版：优先找肿瘤"})
    r.append_message({"role": "user", "content": "任务：看一下"})
    changed = r.ensure_current_system_prompt()
    check("旧 system 被替换", changed is True)
    msgs = r.get_data()["canonical_messages"]
    sys_msgs = [m for m in msgs if m.get("role") == "system"]
    check("system 等于当前 SYSTEM_PROMPT",
          sys_msgs and sys_msgs[0].get("content") == ai_agent.SYSTEM_PROMPT)
    check("再次 ensure 无改动", r.ensure_current_system_prompt() is False)


if __name__ == "__main__":
    test_migration_and_change_seq()
    test_acquire_and_fencing()
    test_wal_and_cancel()
    test_event_log()
    test_compact()
    test_snapshot_guard()
    test_spot_inject()
    test_force_compact()
    test_default_max_steps()
    test_display_text_stripped()
    test_ensure_current_system_prompt()
    print("\nPASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
