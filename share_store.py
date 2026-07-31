# -*- coding: utf-8 -*-
"""切片分享 —— 共享存储层。

被两个进程并发使用：
- app.py（主应用 :8000，管理员写入）
- share_server.py（分享服务 :38000，读为主，外部用户写入 ROI）

数据文件为单个 JSON，所有读写通过 fcntl.flock 互斥访问，保证一致性。
"""

import json
import os
import secrets
import shutil
import time
from pathlib import Path

import fcntl

# 数据目录与文件路径
SHARE_DATA_DIR = Path(
    os.environ.get("SHARE_DATA_DIR") or (Path.home() / "svs-viewer" / "share-data")
)
SHARE_DATA_DIR.mkdir(parents=True, exist_ok=True)
SHARE_FILE = SHARE_DATA_DIR / "shares.json"

# 空结构骨架
_EMPTY = {"shares": {}, "rois": [], "projects": {}, "slide_meta": {}}

# 支持的标注类型
ROI_TYPES = ("rect", "arrow", "freehand")

# 分享可选的 ROI 矩形标记尺寸（mm），以 float 存储为子集
ALLOWED_ROI_SIZES = (6.0, 6.5)
# 默认标记尺寸子集（未指定时）
DEFAULT_ROI_SIZES = [6.0, 6.5]

# 管理员标注使用的固定 token
ADMIN_TOKEN = "admin"


def _roi_shared_compat(roi):
    """读取 roi 的 shared 字段并做旧数据兼容。

    缺失 "shared" 字段时：
      - token == "admin" 视为 True（管理员标注此前对分享用户全可见，保持不突变）
      - 其他用户 token 视为 False（此前对其他用户本就不可见）
    存在但非布尔时按真值判断；最终统一返回 bool。
    """
    if not isinstance(roi, dict):
        return False
    if "shared" in roi:
        return bool(roi.get("shared"))
    # 旧数据兼容
    return roi.get("token") == ADMIN_TOKEN


def _normalize_roi_sizes(roi_sizes):
    """校验并归一化 roi_sizes：统一转 float，去重保序，且必须是
    ALLOWED_ROI_SIZES 的子集。返回 list[float]；非法抛 ValueError。
    None 时返回 DEFAULT_ROI_SIZES 的副本。
    """
    if roi_sizes is None:
        return list(DEFAULT_ROI_SIZES)
    if not isinstance(roi_sizes, (list, tuple)):
        raise ValueError("roi_sizes 需为数组")
    allowed = set(ALLOWED_ROI_SIZES)
    out = []
    seen = set()
    for s in roi_sizes:
        if isinstance(s, bool) or not isinstance(s, (int, float)):
            raise ValueError("roi_sizes 元素需为数值")
        import math
        if not math.isfinite(float(s)):
            raise ValueError("roi_sizes 元素需为有限数值")
        v = float(s)
        if v not in allowed:
            raise ValueError("roi_sizes 仅允许 6 或 6.5")
        if v not in seen:
            seen.add(v)
            out.append(v)
    if not out:
        raise ValueError("roi_sizes 不能为空")
    return out


def _share_roi_sizes(share):
    """从 share dict 读取归一化的 roi_sizes；旧分享无该字段时返回默认。"""
    rs = share.get("roi_sizes") if isinstance(share, dict) else None
    if not isinstance(rs, list) or not rs:
        return list(DEFAULT_ROI_SIZES)
    # 兜底过滤：脏数据（非数字/越界）统一回默认
    try:
        return _normalize_roi_sizes(rs)
    except ValueError:
        return list(DEFAULT_ROI_SIZES)


def _is_finite_num(v):
    """判断 v 是否为有限数值（int/float，非 NaN/Inf）。"""
    if isinstance(v, bool):
        return False
    if not isinstance(v, (int, float)):
        return False
    import math
    return math.isfinite(v)


def _load_locked(f):
    """在已锁定的文件对象上读取并解析 JSON；损坏则备份重建。"""
    f.seek(0)
    raw = f.read()
    if not raw:
        return _copy_empty()
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("top-level not object")
        data.setdefault("shares", {})
        data.setdefault("rois", [])
        # 向后兼容：旧文件无 projects 时补 {}
        data.setdefault("projects", {})
        # 向后兼容：旧文件无 slide_meta 时补 {}
        data.setdefault("slide_meta", {})
        if not isinstance(data["shares"], dict):
            data["shares"] = {}
        if not isinstance(data["rois"], list):
            data["rois"] = []
        if not isinstance(data["projects"], dict):
            data["projects"] = {}
        if not isinstance(data["slide_meta"], dict):
            data["slide_meta"] = {}
        return data
    except (json.JSONDecodeError, ValueError):
        # 损坏：备份后重建
        f.seek(0)
        bak = SHARE_FILE.with_suffix(".json.bak")
        try:
            with open(bak, "w", encoding="utf-8") as bf:
                bf.write(raw)
        except Exception:
            pass
        return _copy_empty()


def _copy_empty():
    """返回一个新的空结构（避免共享引用）。"""
    return {"shares": {}, "rois": [], "projects": {}, "slide_meta": {}}


def _save_locked(f, data):
    """在已锁定的文件对象上写入 JSON（先截断）。"""
    f.seek(0)
    f.truncate()
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.flush()
    os.fsync(f.fileno())


def _with_lock(mode, fn):
    """以指定模式打开 SHARE_FILE，加排他锁后执行 fn(file_obj)。

    mode 为 'r+'（读写，要求文件已存在；不存在则先创建）或 'w+'。
    返回 fn 的返回值。
    """
    # 确保文件存在
    if not SHARE_FILE.exists():
        SHARE_FILE.touch()
    with open(SHARE_FILE, mode, encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            return fn(f)
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


# --------------------------------------------------------------------------- #
# 公共 API
# --------------------------------------------------------------------------- #
def create_share(slides, expires_hours, roi_sizes=None):
    """创建分享：生成 token、写入并返回 share dict（含 token 与 roi_sizes）。

    roi_sizes：矩形标记可选尺寸子集（元素 6/6.5），None 时默认两者皆可。
    非法（非数组、含越界值、空）抛 ValueError。
    """
    roi_sizes_norm = _normalize_roi_sizes(roi_sizes)
    token = secrets.token_urlsafe(18)
    now = time.time()
    expires_at = now + float(expires_hours) * 3600.0
    share = {
        "slides": list(slides),
        "created_at": now,
        "expires_at": expires_at,
        "revoked": False,
        "token": token,
        "roi_sizes": list(roi_sizes_norm),
    }

    def _do(f):
        data = _load_locked(f)
        data["shares"][token] = {
            "slides": list(slides),
            "created_at": now,
            "expires_at": expires_at,
            "revoked": False,
            "roi_sizes": list(roi_sizes_norm),
        }
        _save_locked(f, data)
        return share

    return _with_lock("r+", _do)


def _is_active(share):
    """判断 share dict 是否仍有效（未撤销且未过期）。"""
    if share.get("revoked"):
        return False
    exp = share.get("expires_at")
    if exp is not None and exp < time.time():
        return False
    return True


def get_share(token):
    """获取有效分享；不存在/已撤销/已过期返回 None。

    返回 dict 含 token 与归一化的 roi_sizes（旧分享无该字段默认两者皆可）。
    """
    def _do(f):
        data = _load_locked(f)
        share = data["shares"].get(token)
        if share is None:
            return None
        if not _is_active(share):
            return None
        out = dict(share)
        out["token"] = token
        out["roi_sizes"] = _share_roi_sizes(share)
        return out

    return _with_lock("r+", _do)


def _status_of(share):
    if share.get("revoked"):
        return "revoked"
    exp = share.get("expires_at")
    if exp is not None and exp < time.time():
        return "expired"
    return "active"


def list_shares():
    """返回全部分享（含 status 与 roi_sizes 字段），按 created_at 倒序。"""
    def _do(f):
        data = _load_locked(f)
        items = []
        for tok, sh in data["shares"].items():
            out = dict(sh)
            out["token"] = tok
            out["status"] = _status_of(sh)
            out["roi_sizes"] = _share_roi_sizes(sh)
            items.append(out)
        items.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return items

    return _with_lock("r+", _do)


def revoke_share(token):
    """撤销分享，返回是否成功。"""
    def _do(f):
        data = _load_locked(f)
        share = data["shares"].get(token)
        if share is None:
            return False
        share["revoked"] = True
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


def _validate_geom(typ, geom):
    """校验几何字段，返回归一化后的几何 dict（不含 type/label/token/slide/ts）。

    - rect：x, y, side_px, size_mm（side_px 1~40000）
    - arrow：x1, y1, x2, y2（两端点距离 > 0）
    - freehand：points: [[x,y],...]（3~500 点，坐标 ≥0 且有限）
    坐标均要求 ≥0 且数值有限；x/y/side_px 等兼容字段据此计算。
    校验失败抛 ValueError。
    """
    if typ == "rect":
        x = geom.get("x")
        y = geom.get("y")
        side_px = geom.get("side_px")
        size_mm = geom.get("size_mm")
        if not (_is_finite_num(x) and _is_finite_num(y) and _is_finite_num(side_px)):
            raise ValueError("几何参数需为数值")
        x = int(x); y = int(y)
        side_px = int(side_px)
        if x < 0 or y < 0:
            raise ValueError("坐标需 ≥0")
        if side_px < 1 or side_px > 40000:
            raise ValueError("side_px 需在 1~40000 之间")
        size_mm_v = float(size_mm) if _is_finite_num(size_mm) else 0.0
        return {
            "type": "rect",
            "x": x, "y": y,
            "side_px": side_px,
            "size_mm": size_mm_v,
        }

    if typ == "arrow":
        x1 = geom.get("x1"); y1 = geom.get("y1")
        x2 = geom.get("x2"); y2 = geom.get("y2")
        if not all(_is_finite_num(v) for v in (x1, y1, x2, y2)):
            raise ValueError("几何参数需为数值")
        x1 = int(x1); y1 = int(y1); x2 = int(x2); y2 = int(y2)
        if any(v < 0 for v in (x1, y1, x2, y2)):
            raise ValueError("坐标需 ≥0")
        dist2 = (x1 - x2) ** 2 + (y1 - y2) ** 2
        if dist2 <= 0:
            raise ValueError("箭头两端点不能重合")
        # 中点存 x/y，side_px 留 0（兼容旧查询，无意义）
        cx = (x1 + x2) // 2
        cy = (y1 + y2) // 2
        return {
            "type": "arrow",
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "x": cx, "y": cy,
            "side_px": 0,
            "size_mm": 0.0,
        }

    if typ == "freehand":
        pts = geom.get("points")
        if not isinstance(pts, list) or len(pts) < 3 or len(pts) > 500:
            raise ValueError("描图需 3~500 个点")
        clean = []
        for p in pts:
            if (not isinstance(p, (list, tuple))) or len(p) != 2:
                raise ValueError("points 元素需为 [x,y]")
            px, py = p
            if not (_is_finite_num(px) and _is_finite_num(py)):
                raise ValueError("坐标需为数值")
            px = int(px); py = int(py)
            if px < 0 or py < 0:
                raise ValueError("坐标需 ≥0")
            clean.append([px, py])
        xs = [p[0] for p in clean]
        ys = [p[1] for p in clean]
        minx = min(xs); miny = min(ys)
        side = max(max(xs) - minx, max(ys) - miny)
        return {
            "type": "freehand",
            "points": clean,
            "x": minx, "y": miny,
            "side_px": int(side),
            "size_mm": 0.0,
        }

    raise ValueError("未知标注类型")


def _clean_note(note):
    """归一化备注文本：非 str 视为空串；strip 后长度 ≤ 500，否则抛 ValueError。

    None → ""；非字符串 → ""。返回清洗后的字符串。
    """
    if note is None:
        return ""
    if not isinstance(note, str):
        return ""
    n = note.strip()
    if len(n) > 500:
        raise ValueError("备注过长")
    return n


def add_roi(token, slide, label, type="rect", size_mm=0.0, shared=False, note="", **geom):
    """为 token 的 share 添加一条标注；统一入口，支持 rect/arrow/freehand。

    管理员标注使用 token="admin"（此时 share 校验放宽：不要求 token 命中 shares，
    但仍要求 slide 文件名合法）。普通用户标注校验 share 存在、有效、且 slide 属于它。

    label（标记人/标签）为必填，去空白后非空，否则抛 ValueError。
    type 必须是 ROI_TYPES 之一（缺省 rect，向后兼容）。
    shared 为布尔，记录该标注是否对全部分享用户公开展示（缺省 False）。
    note 为备注文本（可选，缺省空串；strip 后 ≤ 500 字符，超出抛 ValueError）。

    返回新增的 roi dict（含该 token 下的 index，从 0 起按时间顺序，以及 shared/note）。
    若校验失败抛出 ValueError。
    """
    # type 合法性
    if type not in ROI_TYPES:
        raise ValueError("未知标注类型")
    # label 非空校验（在锁外做即可）
    if not isinstance(label, str):
        raise ValueError("请填写用户名或标签")
    label = label.strip()
    if not label:
        raise ValueError("请填写用户名或标签")
    # note 清洗（在锁外做即可）
    note_clean = _clean_note(note)

    # 几何校验（合并 size_mm，rect 会覆盖）
    geom_full = dict(geom)
    geom_full["size_mm"] = size_mm
    norm = _validate_geom(type, geom_full)
    norm["type"] = type

    def _do(f):
        data = _load_locked(f)
        is_admin = (token == ADMIN_TOKEN)
        if is_admin:
            # 管理员标注：不要求 token 命中 shares，slide 文件名合法性由调用方保证
            pass
        else:
            share = data["shares"].get(token)
            if share is None or not _is_active(share):
                raise ValueError("share invalid")
            if slide not in share.get("slides", []):
                raise ValueError("slide not in share")
        roi = {
            "token": token,
            "slide": slide,
            "label": label,
            "ts": time.time(),
            "shared": bool(shared),
            "note": note_clean,
        }
        roi.update(norm)
        data["rois"].append(roi)
        _save_locked(f, data)
        # index 为该 token 下按插入顺序的序号
        same_token = [r for r in data["rois"] if r["token"] == token]
        roi_out = dict(roi)
        roi_out["index"] = len(same_token) - 1
        roi_out["shared"] = bool(shared)
        return roi_out

    return _with_lock("r+", _do)


def update_roi(token, index, geom=None, note=None):
    """更新该 token 下第 index 条 roi 的几何与/或备注。

    - 锁定内按 token 内序号定位（逻辑同 delete_roi：same 列表）。
      index 越界返回 False（与 set_roi_shared 风格一致，不抛异常）。
    - 非 admin token 时校验 share 有效（同 add_roi 的 _is_active 逻辑），
      无效抛 ValueError("share invalid")。admin token 直接放行。
    - geom（dict，不含 type）经 _validate_geom(原type, geom) 归一化后 merge 进 roi
      （type 保持原值，ts 不动 → index 语义稳定）；geom 为 None/缺省时不改几何。
    - note 为 None 时不改备注，否则按 _clean_note 规则清洗并写入。
    - 返回更新后的 roi dict（含 index，按 token 内序号计算，同 list_rois 逻辑）。
    """
    # 几何基本校验（真正按原 type 归一化在锁内做，因需读取 roi 原始 type）
    if geom is not None and not isinstance(geom, dict):
        raise ValueError("geom 需为对象")

    # note 清洗（note 非 None 时在锁外校验长度，失败早抛）
    note_clean = "_UNSET_"  # 哨兵：不修改
    if note is not None:
        note_clean = _clean_note(note)

    def _do(f):
        data = _load_locked(f)
        # 非 admin token 校验 share 有效
        is_admin = (token == ADMIN_TOKEN)
        if not is_admin:
            share = data["shares"].get(token)
            if share is None or not _is_active(share):
                raise ValueError("share invalid")
        # 定位该 token 下第 index 条 roi
        same = [i for i, r in enumerate(data["rois"]) if r["token"] == token]
        if index < 0 or index >= len(same):
            return False
        real_i = same[index]
        roi = data["rois"][real_i]
        orig_type = roi.get("type", "rect")

        # 几何更新：用原 type 归一化后 merge（type 保持原值，ts 不动）
        if geom is not None:
            geom_full = dict(geom)
            # 补齐 size_mm（rect 需要，缺失时用原值）
            if orig_type == "rect" and "size_mm" not in geom_full:
                geom_full["size_mm"] = roi.get("size_mm", 0.0)
            norm_g = _validate_geom(orig_type, geom_full)
            norm_g["type"] = orig_type
            roi.update(norm_g)

        # 备注更新
        if note_clean != "_UNSET_":
            roi["note"] = note_clean

        _save_locked(f, data)

        # 返回更新后的 roi dict（含 index）
        out = dict(roi)
        # index 按 token 内序号计算（同 list_rois 逻辑）
        all_same = [r for r in data["rois"] if r["token"] == token]
        out["index"] = all_same.index(roi)
        out["shared"] = _roi_shared_compat(roi)
        return out

    return _with_lock("r+", _do)


def list_rois(token=None):
    """返回 ROI 列表；可按 token 过滤。

    每项含 index（该 token 下的序号）与 shared（按兼容规则归一为 bool）。
    """
    def _do(f):
        data = _load_locked(f)
        rois = data["rois"]
        if token is not None:
            rois = [r for r in rois if r["token"] == token]
            # 计算 index：原列表中同 token 的顺序序号
            all_same = [r for r in data["rois"] if r["token"] == token]
            idx_map = {}
            for i, r in enumerate(all_same):
                idx_map[id(r)] = i
            out = []
            for r in rois:
                rr = dict(r)
                rr["index"] = idx_map.get(id(r), 0)
                rr["shared"] = _roi_shared_compat(r)
                rr["note"] = r.get("note", "")
                out.append(rr)
            out.sort(key=lambda x: x.get("ts", 0), reverse=True)
            return out
        # 全部：按 token 分组计算 index
        from collections import defaultdict
        counters = defaultdict(int)
        out = []
        for r in rois:
            rr = dict(r)
            rr["index"] = counters[r["token"]]
            counters[r["token"]] += 1
            rr["shared"] = _roi_shared_compat(r)
            rr["note"] = r.get("note", "")
            out.append(rr)
        out.sort(key=lambda x: x.get("ts", 0), reverse=True)
        return out

    return _with_lock("r+", _do)


def delete_roi(token, index):
    """删除该 token 下第 index 条 ROI；返回是否删除成功。"""
    def _do(f):
        data = _load_locked(f)
        same = [i for i, r in enumerate(data["rois"]) if r["token"] == token]
        if index < 0 or index >= len(same):
            return False
        real_i = same[index]
        data["rois"].pop(real_i)
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


def set_roi_shared(token, index, shared):
    """设置该 token 下第 index 条 ROI 的 shared 字段。

    返回是否设置成功（token/index 无效时返回 False，不抛异常）。
    shared 会被归一为 bool 并持久化。
    """
    shared_b = bool(shared)

    def _do(f):
        data = _load_locked(f)
        same = [i for i, r in enumerate(data["rois"]) if r["token"] == token]
        if index < 0 or index >= len(same):
            return False
        data["rois"][same[index]]["shared"] = shared_b
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


def roi_count_by_token():
    """返回 {token: count} 计数表。"""
    def _do(f):
        data = _load_locked(f)
        counts = {}
        for r in data["rois"]:
            counts[r["token"]] = counts.get(r["token"], 0) + 1
        return counts

    return _with_lock("r+", _do)


def list_shared_rois_for_slides(slides):
    """返回 shared 为真（按兼容规则判定）且 slide ∈ slides 的标注列表。

    供分享端展示「公开标注」使用：包含管理员公开标注与其他用户被管理员公开的标注。
    每项带 index/token/label/type/几何/ts/shared=True，按 token 归组计算 index
    （与 list_rois 的 index 语义一致，便于按 token+index 定位）。
    不传 slides 或空列表时返回空列表。
    """
    if not slides:
        return []
    slide_set = set(slides)

    def _do(f):
        data = _load_locked(f)
        from collections import defaultdict
        counters = defaultdict(int)  # token -> 下一个 index
        out = []
        for r in data["rois"]:
            idx = counters[r["token"]]
            counters[r["token"]] += 1
            if r.get("slide") not in slide_set:
                continue
            if not _roi_shared_compat(r):
                continue
            rr = dict(r)
            rr["index"] = idx
            rr["shared"] = True
            rr.setdefault("type", "rect")
            rr["note"] = r.get("note", "")
            out.append(rr)
        out.sort(key=lambda x: x.get("ts", 0), reverse=True)
        return out

    return _with_lock("r+", _do)


# --------------------------------------------------------------------------- #
# 样本元数据（别名/备注）—— shares.json 顶层 slide_meta
# --------------------------------------------------------------------------- #
def set_slide_meta(name, alias=None, note=None):
    """设置/更新某切片的别名与备注。

    alias/note 为 None 表示不改该项；空串表示清除该项。
    name 不存在时仍写入（便于先建别名后传文件）；返回更新后的 meta dict。
    """
    def _do(f):
        data = _load_locked(f)
        meta_map = data.setdefault("slide_meta", {})
        if not isinstance(meta_map, dict):
            meta_map = {}
            data["slide_meta"] = meta_map
        cur = meta_map.get(name)
        if not isinstance(cur, dict):
            cur = {}
        if alias is not None:
            a = alias.strip() if isinstance(alias, str) else ""
            if a:
                cur["alias"] = a
            else:
                cur.pop("alias", None)
        if note is not None:
            n = note.strip() if isinstance(note, str) else ""
            if n:
                cur["note"] = n
            else:
                cur.pop("note", None)
        if cur:
            meta_map[name] = cur
        else:
            meta_map.pop(name, None)
        _save_locked(f, data)
        return dict(cur)

    return _with_lock("r+", _do)


def get_slide_meta(name):
    """返回某切片的 {alias, note}（无则空 dict，保证字段存在为空串）。"""
    def _do(f):
        data = _load_locked(f)
        meta_map = data.get("slide_meta", {})
        cur = meta_map.get(name) if isinstance(meta_map, dict) else None
        if not isinstance(cur, dict):
            return {"alias": "", "note": ""}
        return {"alias": cur.get("alias", ""), "note": cur.get("note", "")}

    return _with_lock("r+", _do)


def get_all_slide_meta():
    """返回全量 {name: {alias, note}}。"""
    def _do(f):
        data = _load_locked(f)
        meta_map = data.get("slide_meta", {})
        if not isinstance(meta_map, dict):
            return {}
        out = {}
        for k, v in meta_map.items():
            if not isinstance(v, dict):
                continue
            out[k] = {"alias": v.get("alias", ""), "note": v.get("note", "")}
        return out

    return _with_lock("r+", _do)


# --------------------------------------------------------------------------- #
# 项目（projects）—— 仅维护切片归属关系，不移动/删除切片文件
# --------------------------------------------------------------------------- #
def create_project(name, note="", slides=None):
    """创建项目。pid=secrets.token_urlsafe(10)。

    slides 在此只做去重，是否为已存在切片由调用方保证。
    返回新建项目 dict（含 pid）。
    """
    pid = secrets.token_urlsafe(10)
    now = time.time()
    # 去重（保序）
    seen = set()
    uniq = []
    for s in slides or []:
        if isinstance(s, str) and s not in seen:
            seen.add(s)
            uniq.append(s)
    project = {
        "name": str(name or "").strip() or "未命名项目",
        "note": str(note or ""),
        "slides": uniq,
        "created_at": now,
    }

    def _do(f):
        data = _load_locked(f)
        data["projects"][pid] = dict(project)
        _save_locked(f, data)
        out = dict(project)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def list_projects():
    """返回全部项目列表，每项附加 pid、slide_count；按 created_at 倒序。"""
    def _do(f):
        data = _load_locked(f)
        items = []
        for pid, proj in data["projects"].items():
            out = dict(proj)
            out["pid"] = pid
            out["slide_count"] = len(out.get("slides", []))
            items.append(out)
        items.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return items

    return _with_lock("r+", _do)


def get_project(pid):
    """返回单个项目 dict（附加 pid）；不存在返回 None。"""
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def update_project(pid, *, name=None, note=None, slides=None):
    """更新项目字段（仅更新非 None 字段）。slides 传入时去重替换。
    返回更新后的项目 dict；不存在返回 None。
    """
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        if name is not None:
            proj["name"] = str(name).strip() or proj.get("name", "未命名项目")
        if note is not None:
            proj["note"] = str(note)
        if slides is not None:
            seen = set()
            uniq = []
            for s in slides:
                if isinstance(s, str) and s not in seen:
                    seen.add(s)
                    uniq.append(s)
            proj["slides"] = uniq
        _save_locked(f, data)
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def add_slides_to_project(pid, slides):
    """向项目追加切片（去重保序）。返回更新后的项目 dict；不存在返回 None。"""
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        existing = proj.get("slides", [])
        seen = set(existing)
        for s in slides or []:
            if isinstance(s, str) and s not in seen:
                seen.add(s)
                existing.append(s)
        proj["slides"] = existing
        _save_locked(f, data)
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def remove_slide_from_project(pid, slide):
    """从项目移除某切片。返回更新后的项目 dict；不存在或无该切片返回 None。"""
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        slides = proj.get("slides", [])
        if slide not in slides:
            return None
        proj["slides"] = [s for s in slides if s != slide]
        _save_locked(f, data)
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def delete_project(pid):
    """删除项目（仅删项目记录，不动切片文件）。返回是否删除成功。"""
    def _do(f):
        data = _load_locked(f)
        if pid not in data["projects"]:
            return False
        del data["projects"][pid]
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


# --------------------------------------------------------------------------- #
# 标注（annotations）汇总 —— 把 rois 按 slide/label 聚合，供管理员查看
# --------------------------------------------------------------------------- #
def _norm_label(label):
    """读旧 roi 缺 label 时视为「未署名」。"""
    if isinstance(label, str) and label.strip():
        return label.strip()
    return "未署名"


def annotations_by_slide():
    """把全部 rois 按 slide 分组聚合。

    返回 {slide: {label: {"label","count","items":[...]}, ...}}，items 含
    index/token/slide/x/y/size_mm/side_px/ts/type 及 arrow/freehand 的几何字段。
    index 为该 token 的 rois 按文件插入顺序的序号（同 list_rois 的 counters
    逻辑），与 delete_roi / set_roi_shared / update_roi 的 index 语义完全一致，
    前端可直接用于 DELETE/PATCH /api/annotation/<token>/<index>。
    结构是嵌套：slide -> label -> group。为方便前端，外层每个 slide 的值是按
    label 的分组列表。
    """
    def _do(f):
        data = _load_locked(f)
        from collections import defaultdict
        counters = defaultdict(int)  # token -> 下一个 index（按文件内出现顺序）
        # slide -> label -> {label, count, items}
        by_slide = {}
        for r in data["rois"]:
            slide = r.get("slide")
            lbl = _norm_label(r.get("label"))
            grp_map = by_slide.setdefault(slide, {})
            grp = grp_map.get(lbl)
            if grp is None:
                grp = {"label": lbl, "count": 0, "items": []}
                grp_map[lbl] = grp
            grp["count"] += 1
            # index：该 token 下按文件插入顺序的序号（同 list_rois 的 counters 逻辑）
            tok = r.get("token")
            idx = counters[tok]
            counters[tok] += 1
            item = {
                "index": idx,
                "token": tok,
                # slide 字段也带上：前端兜底反推 index（旧缓存无 index 时）需要
                "slide": r.get("slide"),
                "type": r.get("type", "rect"),  # 旧数据无 type 视为 rect
                "x": r.get("x"),
                "y": r.get("y"),
                "size_mm": r.get("size_mm"),
                "side_px": r.get("side_px"),
                "ts": r.get("ts"),
                "shared": _roi_shared_compat(r),
                "note": r.get("note", ""),
            }
            # 带上 arrow / freehand 专属几何字段（存在则透传）
            for k in ("x1", "y1", "x2", "y2", "points"):
                if k in r:
                    item[k] = r[k]
            grp["items"].append(item)
        # 转为 slide -> list[group]（label 按出现顺序）
        result = {}
        for slide, grp_map in by_slide.items():
            result[slide] = list(grp_map.values())
        return result

    return _with_lock("r+", _do)


def annotations_by_project(pid=None):
    """与 annotations_by_slide 同结构，但可选按项目内的 slides 过滤。

    pid=None 时等同于 annotations_by_slide()。
    pid 存在但项目不存在则按空 slides 过滤（返回空）。
    """
    by_slide = annotations_by_slide()
    if pid is None:
        return by_slide
    proj = get_project(pid)
    project_slides = set(proj.get("slides", [])) if proj else set()
    return {
        slide: groups
        for slide, groups in by_slide.items()
        if slide in project_slides
    }
