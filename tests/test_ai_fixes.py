# -*- coding: utf-8 -*-
"""新增测试：#4 ROI source 数据修正 / api_key 加密往返 / fork 💬 渲染条件。

运行：cd 项目根 && python3 tests/test_ai_fixes.py
用独立临时 SHARE_DATA_DIR，避免污染真实数据。
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import share_store  # noqa: E402

TMP = tempfile.mkdtemp(prefix="svs-fixes-")
os.environ["SHARE_DATA_DIR"] = os.path.join(TMP, "share-data")
os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)

# openslide 未安装时 stub（本测试只覆盖配置/迁移，不需真 OpenSlide）
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

# cryptography 可用性检测（影响 api_key 加密是否启用）
try:
    import cryptography  # noqa: F401
    HAS_CRYPTO = True
except Exception:
    HAS_CRYPTO = False

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
    os.makedirs(os.environ["SHARE_DATA_DIR"], exist_ok=True)
    share_store.SHARE_FILE.unlink(missing_ok=True)


# =========================================================================== #
# #4：ROI 迁移 source 数据修正（只改 AI 落标，不误伤人工标注）
# =========================================================================== #
def test_roi_source_fix():
    print("== test_roi_source_fix（source 迁移：旧默认 human，新数据落标写 ai）==")
    reset_store()
    # 构造旧格式 ROI（无 source 字段）：人工 + 访客混合。迁移应一律默认 human，
    # 不做"看起来像 AI"的启发式猜测（判据已移除，见 commit refactor）。
    share_store.SHARE_FILE.write_text(json.dumps({
        "shares": {"tok_user": {"slides": ["a.svs"], "created_at": 1.0,
                                "expires_at": 1e12, "revoked": False}},
        "rois": [
            # 旧标注（含此前被误判的"可疑区域"措辞）→ 一律默认 human
            {"token": "admin", "slide": "a.svs", "label": "可疑区域1-气道周围致密病变",
             "ts": 1.0, "shared": False, "note": "气道周围见致密病变，伴纤维化", "visitor": "",
             "type": "rect", "x": 100, "y": 100, "side_px": 500, "size_mm": 6.0},
            {"token": "admin", "slide": "a.svs", "label": "管理员", "ts": 3.0, "shared": True,
             "note": "旧", "visitor": "", "type": "rect", "x": 1, "y": 2, "side_px": 100, "size_mm": 6.0},
            {"token": "tok_user", "slide": "a.svs", "label": "访客A", "ts": 5.0, "shared": False,
             "note": "访客画的", "visitor": "dev1", "type": "rect", "x": 10, "y": 10, "side_px": 100, "size_mm": 6.0},
        ],
        "projects": {}, "slide_meta": {},
    }), encoding="utf-8")

    rois = share_store.list_rois()  # 触发迁移
    by_label = {r["label"]: r for r in rois}

    # 旧数据：一律 human（不猜测 AI 来源），但 annotation_id 必须补齐
    check("旧标注默认 human", by_label["可疑区域1-气道周围致密病变"].get("source") == "human")
    check("旧标注有 annotation_id", bool(by_label["可疑区域1-气道周围致密病变"].get("annotation_id")))
    check("人工标注 human", by_label["管理员"].get("source") == "human")
    check("访客标注 human", by_label["访客A"].get("source") == "human")

    # 幂等：再读一遍，值稳定
    rois2 = share_store.list_rois()
    by_label2 = {r["label"]: r for r in rois2}
    check("幂等：仍 human", by_label2["可疑区域1-气道周围致密病变"].get("source") == "human")

    # 迁移落盘：读路径后磁盘带上 source=human
    raw = json.loads(share_store.SHARE_FILE.read_text(encoding="utf-8"))
    disk = [r for r in raw["rois"] if r["label"] == "可疑区域1-气道周围致密病变"][0]
    check("磁盘落盘 source=human", disk.get("source") == "human")

    # 新数据：AI 落标显式写 source="ai"（add_roi source 参数），fork 渲染条件满足
    new_ai = share_store.add_roi("admin", "a.svs", "可疑区域X", type="rect",
                                 note="AI 新落标", x=1, y=1, side_px=100,
                                 source="ai", created_by_session_id="sess_x")
    check("新 AI 落标 source=ai", new_ai.get("source") == "ai")
    check("新 AI 落标带 annotation_id", bool(new_ai.get("annotation_id")))

    # annotations_by_slide 返回的 item 带 source/annotation_id（前端 💬 渲染条件依赖）
    by_slide = share_store.annotations_by_slide()
    items = []
    for groups in by_slide.values():
        for g in groups:
            items.extend(g.get("items") or [])
    ai_items = [it for it in items if it.get("source") == "ai"]
    check("annotations 返回新 AI 项", len(ai_items) == 1, "got %d" % len(ai_items))
    check("annotations 的 ai 项带 annotation_id", all(it.get("annotation_id") for it in ai_items))


# =========================================================================== #
# #2：api_key 加密往返（存→读解密一致；GET 掩码不明文；明文迁移）
# =========================================================================== #
def test_api_key_encryption():
    print("== test_api_key_encryption（#2 加密）==")
    reset_store()
    # 清掉可能残留的 ai_secret.key / ai_config.json（隔离）
    import app as app_mod
    for p in (app_mod._ai_config_path(), app_mod._ai_secret_path()):
        try:
            p.unlink()
        except Exception:
            pass

    plain = "sk-test-1234567890abcdef"

    # PUT 明文 → 磁盘应为密文（enc: 前缀），GET 掩码不明文
    app_mod._save_ai_config({"base_url": "http://x/v1", "api_key": plain, "model": "m"})
    raw = json.loads(app_mod._ai_config_path().read_text(encoding="utf-8"))
    if HAS_CRYPTO:
        check("磁盘 api_key 为密文（enc: 前缀）", raw.get("api_key", "").startswith("enc:"),
              "got %r" % raw.get("api_key"))
        check("磁盘不明文存 api_key", plain not in raw.get("api_key", ""))
    else:
        check("无 cryptography 时磁盘降级明文", raw.get("api_key") == plain)

    # 读回解密 = 原明文
    cfg = app_mod._load_ai_config()
    check("读回解密 api_key 与原值一致", cfg.get("api_key") == plain, "got %r" % cfg.get("api_key"))

    # GET 掩码不明文
    mask = app_mod._mask_api_key(cfg.get("api_key") or "")
    check("掩码不含完整明文", plain not in mask, "mask=%r" % mask)
    check("掩码非空", bool(mask))

    # 明文旧配置迁移：直接写明文进磁盘 → 读取自动加密重写
    if HAS_CRYPTO:
        app_mod._ai_config_path().write_text(json.dumps(
            {"base_url": "http://x/v1", "api_key": "legacy-plain-key-xyz", "model": "m"}),
            encoding="utf-8")
        cfg2 = app_mod._load_ai_config()
        check("明文旧配置读取解密一致", cfg2.get("api_key") == "legacy-plain-key-xyz",
              "got %r" % cfg2.get("api_key"))
        raw2 = json.loads(app_mod._ai_config_path().read_text(encoding="utf-8"))
        check("明文旧配置迁移为密文落盘", raw2.get("api_key", "").startswith("enc:"),
              "got %r" % raw2.get("api_key"))

    # 清空 api_key
    app_mod._save_ai_config({"base_url": "http://x/v1", "api_key": "", "model": "m"})
    cfg3 = app_mod._load_ai_config()
    check("清空 api_key 读回空", cfg3.get("api_key") == "", "got %r" % cfg3.get("api_key"))


# =========================================================================== #
# #2：api_protocol 字段往返（openai 默认 / anthropic 接受 / 非法拒绝）
# =========================================================================== #
def test_api_protocol():
    print("== test_api_protocol（#2 协议字段）==")
    reset_store()
    import app as app_mod
    for p in (app_mod._ai_config_path(), app_mod._ai_secret_path()):
        try:
            p.unlink()
        except Exception:
            pass
    app_mod._save_ai_config({"base_url": "http://x/v1", "api_key": "k", "model": "m",
                             "api_protocol": "anthropic"})
    cfg = app_mod._load_ai_config()
    check("api_protocol 存取往返", cfg.get("api_protocol") == "anthropic",
          "got %r" % cfg.get("api_protocol"))
    # GET 默认 openai（无配置时）
    app_mod._save_ai_config({})
    cfg2 = app_mod._load_ai_config()
    check("缺省 api_protocol 读回 None（GET 层默认 openai）", cfg2.get("api_protocol") is None)


# =========================================================================== #
# #4 前端 💬 渲染条件：source=ai 才渲染（断言数据契约，前端条件已锁定为 source==='ai'）
# =========================================================================== #
def test_fork_render_condition():
    print("== test_fork_render_condition（#4 💬 渲染条件数据契约）==")
    reset_store()
    # 落一条 AI 标注 + 一条人工标注
    share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "可疑区域-浸润性病变",
                        note="浸润性生长", x=10, y=10, side_px=100, source="ai")
    share_store.add_roi(share_store.ADMIN_TOKEN, "a.svs", "管理员",
                        note="手画", x=20, y=20, side_px=100, source="human")
    by_slide = share_store.annotations_by_slide()
    items = []
    for groups in by_slide.values():
        for g in groups:
            items.extend(g.get("items") or [])
    ai = [it for it in items if it.get("source") == "ai"]
    human = [it for it in items if it.get("source") == "human"]
    check("AI 标注满足渲染条件（source=ai 且 annotation_id）",
          all(it.get("source") == "ai" and it.get("annotation_id") for it in ai))
    check("人工标注不满足 ai 条件",
          all(it.get("source") == "human" for it in human))
    check("AI/人工各 1 条", len(ai) == 1 and len(human) == 1,
          "ai=%d human=%d" % (len(ai), len(human)))


if __name__ == "__main__":
    test_roi_source_fix()
    test_api_key_encryption()
    test_api_protocol()
    test_fork_render_condition()
    print("\nPASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
