#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""切片分享 —— 独立 Flask 服务（view-only，对外）。

监听 0.0.0.0:38000（可用 SHARE_PORT 覆盖）。
所有 /s/<token>/... 路由先校验 token 有效，再校验 slide 归属于该分享。
与主应用通过共享 JSON 文件（share_store）+ 共享上传目录（UPLOAD_DIR）交换数据。
"""

import io
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_file,
    send_from_directory,
)
from werkzeug.utils import secure_filename

import openslide
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator

import share_store
import slide_io

app = Flask(__name__)

# 上传目录与主应用共享（容器内挂载同一卷）
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR") or (Path.home() / "svs-viewer" / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_EXTS = {
    "svs", "tif", "tiff", "ndpi", "mrxs", "vms", "vmu", "scn", "bif", "svslide",
}

# Deep Zoom 参数（512 瓦片降低公网请求数，渐进式 q82 JPEG 降体积并支持模糊→清晰预览）
DZ_TILE_SIZE = 512
DZ_OVERLAP = 1
# JPEG 编码质量，可由环境变量 JPEG_QUALITY 覆盖（默认 82）
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY") or 82)
# 保留旧名（与主应用一致，实际值与 DZ_* 一致）
TILE_SIZE = DZ_TILE_SIZE
OVERLAP = DZ_OVERLAP

# OpenSlide 缓存（独立进程，与主应用各自的缓存）
_slide_cache: dict = {}
_cache_lock = threading.Lock()

# 瓦片内存缓存（LRU + TTL）：key=(name, level, x, y)，value=(ts, JPEG bytes)
# 分享端只读，但切片可能被管理端删除后同名重传，加 TTL 兜底避免长期服务旧图
TILE_CACHE_MAX = int(os.environ.get("TILE_CACHE_MAX") or 3000)
TILE_CACHE_TTL = float(os.environ.get("TILE_CACHE_TTL") or 3600)  # 秒
_tile_cache: "OrderedDict[tuple, tuple]" = OrderedDict()
_tile_cache_lock = threading.Lock()


def _tile_cache_get(key):
    """LRU+TTL 命中：未过期才返回，过期剔除。"""
    with _tile_cache_lock:
        item = _tile_cache.get(key)
        if item is None:
            return None
        ts, data = item
        if time.time() - ts > TILE_CACHE_TTL:
            _tile_cache.pop(key, None)
            return None
        _tile_cache.move_to_end(key)
        return data


def _tile_cache_put(key, data):
    """LRU 写入，超上限淘汰最久未用。"""
    with _tile_cache_lock:
        _tile_cache[key] = (time.time(), data)
        _tile_cache.move_to_end(key)
        while len(_tile_cache) > TILE_CACHE_MAX:
            _tile_cache.popitem(last=False)


# --------------------------------------------------------------------------- #
# 辅助函数（从 app.py 复制，保持一致）
# --------------------------------------------------------------------------- #
def _sanitize_name(name: str) -> str:
    """净化文件名：防路径穿越同时保留中文等 Unicode 字符。"""
    if not name or "\x00" in name:
        return ""
    has_non_ascii = any(ord(c) > 127 for c in name)
    if not has_non_ascii:
        return secure_filename(name)
    cleaned_chars = []
    for ch in name:
        if ch in "/\\:" or ord(ch) < 32:
            continue
        cleaned_chars.append(ch)
    cleaned = "".join(cleaned_chars).strip().rstrip(".")
    cleaned = cleaned.replace("..", "")
    return cleaned


def _get_slide(name: str):
    """从缓存获取（或打开）OpenSlide 与 DeepZoomGenerator，返回字典。"""
    with _cache_lock:
        entry = _slide_cache.get(name)
        if entry is not None:
            return entry

    path = UPLOAD_DIR / name
    if not path.is_file():
        abort(404, "切片不存在")
    try:
        osr = slide_io.open_slide(path)
    except Exception:
        abort(400, "无法打开切片文件")

    dz = DeepZoomGenerator(
        osr, tile_size=DZ_TILE_SIZE, overlap=DZ_OVERLAP, limit_bounds=True
    )
    entry = {"osr": osr, "dz": dz, "lock": threading.Lock()}
    with _cache_lock:
        existing = _slide_cache.get(name)
        if existing is not None:
            try:
                osr.close()
            except Exception:
                pass
            return existing
        _slide_cache[name] = entry
    return entry


def _to_float(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _mpp_from_tiff_resolution(path: Path):
    """从 TIFF 分辨率标签读取 mpp（与主应用逻辑相同）。"""
    try:
        from PIL import Image
        from PIL.TiffTags import TAGS_V2  # noqa: F401

        with Image.open(str(path)) as img:
            tags = getattr(img, "tag_v2", None)
            if not tags:
                return None, None
            x_res = _to_float(tags.get(282))
            y_res = _to_float(tags.get(283))
            unit = tags.get(296, 2)
            if not x_res or x_res <= 0:
                return None, None
            factor = 25400.0 if unit == 2 else (10000.0 if unit == 3 else None)
            if factor is None:
                return None, None
            mpp_x = factor / x_res
            mpp_y = factor / y_res if y_res and y_res > 0 else mpp_x
            if 0.05 <= mpp_x <= 3.0:
                return mpp_x, mpp_y
    except Exception:
        pass
    return None, None


def _read_metadata(osr: OpenSlide, path: Path) -> dict:
    """读取尺寸与 mpp 元数据（与主应用逻辑相同）。"""
    width, height = osr.dimensions
    props = osr.properties
    objective_f = _to_float(props.get("openslide.objective-power"))

    mpp_x_f = _to_float(props.get("openslide.mpp-x"))
    mpp_y_f = _to_float(props.get("openslide.mpp-y"))

    if mpp_x_f is not None and mpp_y_f is not None:
        mpp_source = "metadata"
    else:
        tiff_mpp_x, tiff_mpp_y = _mpp_from_tiff_resolution(path)
        if tiff_mpp_x is not None:
            mpp_x_f = mpp_x_f if mpp_x_f is not None else tiff_mpp_x
            mpp_y_f = mpp_y_f if mpp_y_f is not None else tiff_mpp_y
            mpp_source = "tiff-resolution"
        elif objective_f is not None and objective_f > 0:
            est = 10.0 / objective_f
            mpp_x_f = mpp_x_f if mpp_x_f is not None else est
            mpp_y_f = mpp_y_f if mpp_y_f is not None else est
            mpp_source = "estimated"
        else:
            mpp_x_f = None
            mpp_y_f = None
            mpp_source = "missing"

    return {
        "width": width,
        "height": height,
        "mpp_x": mpp_x_f,
        "mpp_y": mpp_y_f,
        "objective": objective_f,
        "mpp_source": mpp_source,
    }


# --------------------------------------------------------------------------- #
# 安全核心：token 与 slide 校验
# --------------------------------------------------------------------------- #
def _require_share(token):
    """校验 token 有效，返回 share dict；无效则 404（不泄露信息）。"""
    share = share_store.get_share(token)
    if share is None:
        abort(404, "链接无效或已过期")
    return share


def _fmt_mm(v):
    """把 mm 数值格式化为整数优先、否则一位小数（6 → "6"，6.5 → "6.5"）。"""
    f = float(v)
    if f == int(f):
        return str(int(f))
    # 6.5 这类保留一位
    return ("%.1f" % f).rstrip("0").rstrip(".")


def _require_slide(share, name):
    """校验 name 属于该 share 且通过文件名校验；否则 403/404。"""
    safe = _sanitize_name(name)
    if not safe or safe != name:
        abort(403, "无权访问")
    if safe not in share.get("slides", []):
        abort(403, "无权访问")
    return safe


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@app.errorhandler(404)
def _handle_404(e):
    return "链接无效或已过期", 404


@app.errorhandler(403)
def _handle_403(e):
    return "无权访问", 403


@app.route("/")
def index():
    return "链接无效或已过期", 404


@app.route("/s/")
@app.route("/s")
def s_root():
    return "链接无效或已过期", 404


@app.route("/s/<token>")
def share_page(token):
    _require_share(token)
    return render_template("share.html", token=token)


@app.route("/s/<token>/api/slides")
def share_slides(token):
    share = _require_share(token)
    # 一次性取 slide_meta，减少锁竞争
    all_meta = share_store.get_all_slide_meta()
    items = []
    for name in share["slides"]:
        safe = _sanitize_name(name)
        path = UPLOAD_DIR / safe
        info = {"name": safe, "exists": path.is_file()}
        sm = all_meta.get(safe, {})
        info["alias"] = sm.get("alias", "")
        info["note"] = sm.get("note", "")
        if path.is_file():
            try:
                entry = _get_slide(safe)
                with entry["lock"]:
                    meta = _read_metadata(entry["osr"], path)
                info.update(meta)
            except Exception as e:
                info.update({
                    "width": None, "height": None,
                    "mpp_x": None, "mpp_y": None,
                    "mpp_source": "missing",
                    "error": str(getattr(e, "description", e)),
                })
        else:
            info.update({
                "width": None, "height": None,
                "mpp_x": None, "mpp_y": None,
                "mpp_source": "missing",
                "error": "文件不存在",
            })
        items.append(info)
    return jsonify(items)


@app.route("/s/<token>/api/config")
def share_config(token):
    """返回本次分享的配置（矩形标记允许的尺寸子集）。

    先 _require_share：无效 token → 404，不泄露信息。
    旧分享无 roi_sizes 字段时默认两者皆可。
    """
    share = _require_share(token)
    return jsonify({"roi_sizes": share.get("roi_sizes") or list(share_store.DEFAULT_ROI_SIZES)})


@app.route("/s/<token>/api/slide/<name>.dzi")
def share_slide_dzi(token, name):
    share = _require_share(token)
    safe = _require_slide(share, name)
    entry = _get_slide(safe)
    with entry["lock"]:
        dz = entry["dz"]
        width, height = dz.level_dimensions[-1]

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" '
        f'Url="/s/{token}/api/slide/{safe}_files/" Format="jpeg" '
        f'Overlap="{DZ_OVERLAP}" TileSize="{DZ_TILE_SIZE}">'
        f'<Size Width="{width}" Height="{height}"/>'
        "</Image>"
    )
    resp = Response(xml, mimetype="application/xml")
    # DZI 元数据短期可变（重传/换切片后尺寸会变），用短缓存
    resp.headers["Cache-Control"] = "max-age=60"
    return resp


@app.route("/s/<token>/api/slide/<name>_files/<int:level>/<int:x>_<int:y>.jpeg")
def share_slide_tile(token, name, level, x, y):
    """返回 Deep Zoom 单张瓦片 JPEG（512×512、渐进式、q82，带 LRU+TTL 缓存）。"""
    share = _require_share(token)
    safe = _require_slide(share, name)

    key = (safe, level, x, y)
    cached = _tile_cache_get(key)
    if cached is not None:
        buf = io.BytesIO(cached)
    else:
        entry = _get_slide(safe)
        with entry["lock"]:
            dz = entry["dz"]
            tile = dz.get_tile(level, (x, y))

        # 含 alpha 通道时先转 RGB（JPEG 不支持透明度）
        if tile.mode != "RGB":
            tile = tile.convert("RGB")
        buf = io.BytesIO()
        # 渐进式 JPEG：浏览器可在下载中途显示模糊→清晰的瓦片，便于慢网预览
        tile.save(
            buf,
            format="JPEG",
            quality=JPEG_QUALITY,
            progressive=True,
            optimize=True,
        )
        _tile_cache_put(key, buf.getvalue())
        buf.seek(0)

    resp = send_file(buf, mimetype="image/jpeg")
    # 瓦片内容不变，长期不可变缓存
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/s/<token>/api/slide/<name>/crop")
def share_slide_crop(token, name):
    share = _require_share(token)
    safe = _require_slide(share, name)
    entry = _get_slide(safe)

    def _parse_int(key):
        try:
            return int(request.args.get(key, ""))
        except (TypeError, ValueError):
            return None

    x = _parse_int("x")
    y = _parse_int("y")
    size = _parse_int("size")
    if x is None or y is None or size is None:
        return jsonify(error="x/y/size 参数需为整数"), 400
    if x < 0 or y < 0 or size <= 0 or size > 40000:
        return jsonify(error="参数越界（0<=x,y，0<size<=40000）"), 400

    with entry["lock"]:
        osr = entry["osr"]
        width, height = osr.dimensions
        x2 = min(x, max(0, width - 1))
        y2 = min(y, max(0, height - 1))
        max_w = max(0, width - x2)
        max_h = max(0, height - y2)
        size2 = min(size, max_w, max_h)
        if size2 <= 0:
            return jsonify(error="裁剪区域超出图像边界"), 400
        region = osr.read_region((x2, y2), 0, (size2, size2)).convert("RGB")

    buf = io.BytesIO()
    region.save(buf, format="PNG")
    buf.seek(0)

    stem = Path(safe).stem
    download_name = f"{stem}_{x2}_{y2}_{size2}px.png"
    return send_file(
        buf,
        mimetype="image/png",
        as_attachment=True,
        download_name=download_name,
    )


@app.route("/s/<token>/api/slide/<name>/thumbnail")
def share_slide_thumbnail(token, name):
    """返回缩略图 JPEG（用作查看器底图预览，慢网下避免瓦片未到区域变白）。"""
    share = _require_share(token)
    safe = _require_slide(share, name)
    entry = _get_slide(safe)
    with entry["lock"]:
        osr = entry["osr"]
        thumb = osr.get_thumbnail((400, 400))
    if thumb.mode != "RGB":
        thumb = thumb.convert("RGB")
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=90)
    buf.seek(0)
    return send_file(buf, mimetype="image/jpeg")


@app.route("/s/<token>/api/roi", methods=["POST"])
def share_roi_add(token):
    share = _require_share(token)
    body = request.get_json(silent=True) or {}
    slide = body.get("slide")
    label = body.get("label")
    typ = body.get("type", "rect")

    # label 必填：去空白后非空
    if not isinstance(label, str) or not label.strip():
        return jsonify(error="请填写用户名或标签"), 400

    if typ not in share_store.ROI_TYPES:
        return jsonify(error="未知标注类型"), 400

    if not slide:
        return jsonify(error="缺少 slide"), 400
    safe = _sanitize_name(slide)
    if not safe or safe != slide or safe not in share.get("slides", []):
        return jsonify(error="slide 不属于该分享"), 403

    # 收集几何字段透传给 store 校验
    geom = {}
    for k in ("x", "y", "side_px", "size_mm", "x1", "y1", "x2", "y2", "points"):
        if k in body:
            geom[k] = body[k]

    # rect（含未指定默认 rect）需校验 size_mm ∈ 本次分享允许的尺寸子集；
    # arrow / freehand 不受限。
    if typ == "rect":
        allowed = share.get("roi_sizes") or list(share_store.DEFAULT_ROI_SIZES)
        size_mm_v = geom.get("size_mm")
        try:
            smm = float(size_mm_v)
        except (TypeError, ValueError):
            smm = None
        if smm is None or smm not in allowed:
            # 允许值拼接到友好的提示（如 "6 / 6.5"）
            label_str = " / ".join(_fmt_mm(v) for v in allowed)
            return jsonify(error="本次分享仅允许 " + label_str + " mm 标记"), 403

    try:
        roi = share_store.add_roi(token, safe, label, type=typ, **geom)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(ok=True, index=roi["index"])


@app.route("/s/<token>/api/rois")
def share_roi_list(token):
    """返回本 token 可见的全部标注（仅本分享切片内）。

    组装三类来源：
      - source="me"：本 token 自己的全部标注（不受 shared 影响，始终可见，可删）
      - source="admin"：管理员(admin)被公开的标注
      - source="shared"：其他用户被管理员公开的标注（非本 token、非 admin）
    后两类来自 list_shared_rois_for_slides(本分享切片)，且排除本 token 自身。
    每项的 index 沿用 list_rois 的 token+index 语义（按 token 归组）。
    """
    share = _require_share(token)
    share_slides = share.get("slides", [])

    # 1) 本 token 全部标注（含未公开，source=me）
    mine = share_store.list_rois(token)
    out = []
    for r in mine:
        rr = dict(r)
        rr["source"] = "me"
        out.append(rr)

    # 2) 管理员策展公开的他人/admin 标注（排除本 token 自身）
    shared_all = share_store.list_shared_rois_for_slides(share_slides)
    for r in shared_all:
        if r.get("token") == token:
            continue  # 本人的公开标注已在 me 中，不重复
        rr = dict(r)
        rr["source"] = "admin" if r.get("token") == share_store.ADMIN_TOKEN else "shared"
        out.append(rr)

    # 按时间倒序
    out.sort(key=lambda x: x.get("ts", 0), reverse=True)
    return jsonify(out)


@app.route("/s/<token>/api/roi/<int:index>", methods=["DELETE"])
def share_roi_delete(token, index):
    """删除本 token 的标注；管理员标注不可由分享端删除。"""
    _require_share(token)
    ok = share_store.delete_roi(token, index)
    if not ok:
        return jsonify(error="选区不存在"), 404
    return jsonify(ok=True)


@app.route("/static/<path:filename>")
def share_static(filename):
    return send_from_directory("static", filename)


if __name__ == "__main__":
    # 合并管理端门户：同一端口按路径分流。
    # /s/...（含 /s/<token>/ 全部分享路由）→ 分享应用；
    # 其余（/、/login、/api/*、/static/*）→ 管理端应用（开启 ADMIN_PASSWORD
    # 后需登录），实现"同端口不同页面"：外网访问 18767 时，
    # 进 / 是管理员登录门户，进 /s/<token> 是正常分享页。
    # 这样 frp 不需要为管理端另开隧道，复用既有分享隧道即可。
    import app as admin_app

    def _combined_app(environ, start_response):
        path = environ.get("PATH_INFO") or ""
        if path == "/s" or path.startswith("/s/"):
            return app(environ, start_response)  # 分享应用
        return admin_app.app(environ, start_response)  # 管理端应用

    # HTTPS：提供 SHARE_TLS_CERT / SHARE_TLS_KEY 时直接以 TLS 运行
    # （frp TCP 隧道只是转发，TLS 需在本服务终止，避免被备案系统按 HTTP 拦截）
    tls_cert = os.environ.get("SHARE_TLS_CERT")
    tls_key = os.environ.get("SHARE_TLS_KEY")
    ssl_context = None
    if tls_cert and tls_key and os.path.exists(tls_cert) and os.path.exists(tls_key):
        ssl_context = (tls_cert, tls_key)
        print(f"[share_server] HTTPS enabled: {tls_cert}")
    else:
        print("[share_server] WARNING: 未找到 TLS 证书，以 HTTP 运行")

    from werkzeug.serving import run_simple

    run_simple(
        "0.0.0.0",
        int(os.environ.get("SHARE_PORT", 38000)),
        _combined_app,
        threaded=True,
        ssl_context=ssl_context,
    )
