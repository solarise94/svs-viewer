#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SVS 病理图像查看 Web 应用后端（Flask + OpenSlide + Deep Zoom）。

运行：.venv/bin/python app.py   监听 0.0.0.0:8000
"""

import base64
import hmac
import io
import json
import os
import secrets
import shutil
import threading
import time
import zipfile
from collections import OrderedDict
from datetime import timedelta
from pathlib import Path

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    stream_with_context,
)
from werkzeug.utils import secure_filename

from openslide import OpenSlide
from PIL import Image

import share_store
import slide_cache
import slide_io
import ai_agent
import ai_session

app = Flask(__name__)

# 上传目录：默认 ~/svs-viewer/uploads，可用环境变量 UPLOAD_DIR 覆盖（容器内挂载）
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR") or (Path.home() / "svs-viewer" / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 支持的病理图像扩展名
SUPPORTED_EXTS = {
    "svs", "tif", "tiff", "ndpi", "mrxs", "vms", "vmu", "scn", "bif", "svslide",
}
# 归档扩展名：zip 上传后解压（用于 MRXS 等需要伴侣数据目录的格式）
ARCHIVE_EXTS = {"zip"}

# 分享服务基础 URL（外部用户访问入口，生产部署用 env 覆盖，如 https://slides.example.com:18767）
SHARE_BASE_URL = os.environ.get(
    "SHARE_BASE_URL", "http://localhost:38000"
).rstrip("/")

# --------------------------------------------------------------------------- #
# 管理员登录认证（外网门户，可选）
# --------------------------------------------------------------------------- #
# 只有 ADMIN_PASSWORD 非空时才启用认证；未设置时行为与内网完全一致（免登录）。
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME") or "browser_admin"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD") or ""
AUTH_ENABLED = bool(ADMIN_PASSWORD)

# session 有效期 7 天
app.permanent_session_lifetime = timedelta(days=7)


def _data_dir_for_secret() -> Path:
    """复用 share_store 的数据目录（SHARE_DATA_DIR）存放持久化 secret 文件。

    保证 Flask secret key 重启不失效；share_store.py 已保证该目录存在。
    """
    return Path(
        os.environ.get("SHARE_DATA_DIR") or (Path.home() / "svs-viewer" / "share-data")
    )


def _load_or_create_secret_key() -> str:
    """优先用 SECRET_KEY env；否则在数据目录下持久化随机 secret（0600）。

    gunicorn 多 worker（-w N、不 preload）时各 worker 独立 import 本模块，
    若不加锁会在「文件不存在」窗口各自生成不同 secret，导致 session 跨 worker
    失效（反复跳登录）。故用 fcntl 排他锁包裹「检查+生成+写」，保证并发首次
    生成时只写一次、其余 worker 读到同一 key。
    """
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
    data_dir = _data_dir_for_secret()
    data_dir.mkdir(parents=True, exist_ok=True)
    secret_file = data_dir / "flask_secret.key"

    def _read_or_create_locked():
        """持排他锁内：双检文件，不存在才生成写入。"""
        if secret_file.is_file():
            try:
                return secret_file.read_text(encoding="utf-8").strip()
            except OSError:
                pass
        key = secrets.token_hex(32)
        secret_file.write_text(key, encoding="utf-8")
        try:
            os.chmod(secret_file, 0o600)
        except OSError:
            pass
        return key

    try:
        import fcntl  # POSIX（Linux/macOS）；gunicorn 多 worker 跨进程互斥

        lock_file = data_dir / "flask_secret.lock"
        with open(lock_file, "a+") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            try:
                return _read_or_create_locked()
            finally:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
    except (ImportError, OSError):
        # 极少数无 fcntl 的平台：退回无锁逻辑（单 worker 仍正确）
        return _read_or_create_locked()


app.secret_key = _load_or_create_secret_key()

# 防爆破：内存 dict 按 IP 计数 {ip: {"fails": int, "locked_until": float}}
_auth_attempts: dict = {}
_AUTH_FAIL_LIMIT = 5
_AUTH_LOCK_SECONDS = 60


def _is_ip_locked(ip: str):
    """返回该 IP 是否处于锁定期（含到期清理）。"""
    rec = _auth_attempts.get(ip)
    if not rec:
        return False
    if rec.get("locked_until", 0) and time.time() < rec["locked_until"]:
        return True
    # 锁定已过期：清零
    if rec.get("locked_until", 0):
        _auth_attempts.pop(ip, None)
    return False


def _record_auth_fail(ip: str):
    """记录一次失败，达到阈值则锁定 60 秒。"""
    rec = _auth_attempts.setdefault(ip, {"fails": 0, "locked_until": 0.0})
    rec["fails"] += 1
    if rec["fails"] >= _AUTH_FAIL_LIMIT:
        rec["locked_until"] = time.time() + _AUTH_LOCK_SECONDS


def _clear_auth_fails(ip: str):
    """登录成功后清零该 IP 的失败计数。"""
    _auth_attempts.pop(ip, None)


@app.before_request
def _require_auth():
    """启用认证时拦截未登录请求。

    放行 /login、/static/ 下文件；其余请求检查 session：
    /api/ 开头返回 401 jsonify(error="auth_required")，页面 302 到 /login。
    """
    if not AUTH_ENABLED:
        return None
    # 已登录放行
    if session.get("auth_user"):
        return None
    path = request.path
    # 放行登录页与静态资源
    if path == "/login" or path.startswith("/static/"):
        return None
    if path.startswith("/api/"):
        return jsonify(error="auth_required"), 401
    # 页面：跳登录，带 next（防开放跳转在 login 路由内校验）
    return redirect("/login?next=" + path)

# Deep Zoom 参数（512 瓦片降低公网请求数，渐进式 q82 JPEG 降体积并支持模糊→清晰预览）
DZ_TILE_SIZE = 512
DZ_OVERLAP = 1
# JPEG 编码质量，可由环境变量 JPEG_QUALITY 覆盖（默认 82）
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY") or 82)
# 保留旧名（仅供历史代码引用，实际值与 DZ_* 一致）
TILE_SIZE = DZ_TILE_SIZE
OVERLAP = DZ_OVERLAP

# 切片句柄池与元数据缓存已抽到 slide_cache.py（app.py 与 share_server.py 共享，
# 各自进程独立的池与缓存）

# 瓦片内存缓存（LRU）：大切片瓦片生成是 CPU 密集操作（解压+编码），
# 缓存后平移/缩放往返时秒出，显著减少画面割裂。key=(name, level, x, y)，value=JPEG bytes
TILE_CACHE_MAX = int(os.environ.get("TILE_CACHE_MAX") or 3000)  # ~60KB/片 ≈ 180MB 上限
_tile_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_tile_cache_lock = threading.Lock()


def _tile_cache_get(key):
    """LRU 命中：取值并移到最新位。"""
    with _tile_cache_lock:
        data = _tile_cache.get(key)
        if data is not None:
            _tile_cache.move_to_end(key)
        return data


def _tile_cache_put(key, data):
    """LRU 写入，超上限淘汰最久未用。"""
    with _tile_cache_lock:
        _tile_cache[key] = data
        _tile_cache.move_to_end(key)
        while len(_tile_cache) > TILE_CACHE_MAX:
            _tile_cache.popitem(last=False)


def _tile_cache_purge(name):
    """切片删除时清掉其全部瓦片缓存。"""
    with _tile_cache_lock:
        stale = [k for k in _tile_cache if k[0] == name]
        for k in stale:
            _tile_cache.pop(k, None)


# --------------------------------------------------------------------------- #
# 辅助函数
# --------------------------------------------------------------------------- #
def _sanitize_name(name: str) -> str:
    """净化文件名：防路径穿越同时保留中文等 Unicode 字符。

    werkzeug 的 secure_filename 会剥离所有非 ASCII 字符（如中文），
    导致纯中文文件名（如"我的切片.svs"）变成仅剩扩展名"svs"。因此：
    - 含非 ASCII 字符时：手动剥离路径分隔符、冒号、控制字符、以及残留的
      点-点（.. 仍可能被解析为父目录引用），保留 Unicode；
    - 纯 ASCII 名：直接用 secure_filename（其路径穿越防护更完整）。
    """
    if not name or "\x00" in name:
        return ""

    has_non_ascii = any(ord(c) > 127 for c in name)

    if not has_non_ascii:
        return secure_filename(name)

    # 含 Unicode：手动清理，保留非 ASCII 字符
    cleaned_chars = []
    for ch in name:
        if ch in "/\\:" or ord(ch) < 32:
            continue
        cleaned_chars.append(ch)
    cleaned = "".join(cleaned_chars).strip().rstrip(".")
    # 防止残留的 ".." 序列被解析为目录跳转（Path() 在无分隔符时不会跳转，
    # 这里做二次保险）
    cleaned = cleaned.replace("..", "")
    return cleaned


def _safe_name(name: str) -> str:
    """校验 name 合法且对应文件存在于 UPLOAD_DIR，防路径穿越。"""
    safe = _sanitize_name(name)
    if not safe or safe != name:
        abort(400, jsonify(error="非法文件名"))
    path = UPLOAD_DIR / safe
    if not path.is_file():
        abort(404, jsonify(error="切片不存在"))
    return safe


def _get_slide(name: str):
    """从缓存获取（或创建）切片的句柄池 entry。

    打开是惰性的，真正的 slide_io.open_slide 在首次 borrow_pair 时发生；
    多路并发读取同一切片由句柄池（SLIDE_HANDLE_POOL）保证并行。
    """
    safe = _safe_name(name)
    return slide_cache.get_slide(safe, UPLOAD_DIR / safe)


def _close_slide(name: str) -> None:
    """关闭并移除缓存中的切片句柄池，同时清掉其瓦片缓存。"""
    slide_cache.evict(name)
    _tile_cache_purge(name)


def _to_float(v):
    """安全转 float。"""
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _mpp_from_tiff_resolution(path: Path):
    """从 TIFF 分辨率标签（真实坐标尺）读取 mpp。

    许多扫描仪/转换软件生成的 TIFF 类切片没有厂商 mpp 元数据，
    但写入了标准的 XResolution/YResolution + ResolutionUnit 标签：
    - ResolutionUnit=2（英寸）：mpp(µm/px) = 25400 / XResolution
    - ResolutionUnit=3（厘米）：mpp(µm/px) = 10000 / XResolution
    读取失败或数值不合理时返回 (None, None)。
    """
    try:
        from PIL import Image
        from PIL.TiffTags import TAGS_V2  # noqa: F401  确保标签表初始化

        with Image.open(str(path)) as img:
            tags = getattr(img, "tag_v2", None)
            if not tags:
                return None, None
            x_res = _to_float(tags.get(282))  # XResolution
            y_res = _to_float(tags.get(283))  # YResolution
            unit = tags.get(296, 2)           # ResolutionUnit，默认英寸
            if not x_res or x_res <= 0:
                return None, None
            factor = 25400.0 if unit == 2 else (10000.0 if unit == 3 else None)
            if factor is None:
                return None, None
            mpp_x = factor / x_res
            mpp_y = factor / y_res if y_res and y_res > 0 else mpp_x
            # 合理性检查：病理切片 mpp 一般在 0.1 ~ 2.0 µm/px 之间
            if 0.05 <= mpp_x <= 3.0:
                return mpp_x, mpp_y
    except Exception:
        pass
    return None, None


def _read_metadata(osr: OpenSlide, path: Path) -> dict:
    """读取尺寸与 mpp 等元数据。

    mpp 取值优先级（均为真实坐标尺，最后一个才是估算）：
    1. 厂商元数据 openslide.mpp-x/y（Aperio/滨松等，最可靠）
    2. TIFF 标准分辨率标签 XResolution + ResolutionUnit
    3. 按扫描倍率估算 mpp = 10 / objective-power（标记为 estimated）
    4. 缺失（missing）
    """
    width, height = osr.dimensions
    props = osr.properties
    objective_f = _to_float(props.get("openslide.objective-power"))

    mpp_x_f = _to_float(props.get("openslide.mpp-x"))
    mpp_y_f = _to_float(props.get("openslide.mpp-y"))

    if mpp_x_f is not None and mpp_y_f is not None:
        mpp_source = "metadata"
    else:
        # TIFF 分辨率标签兜底（真实坐标尺）
        tiff_mpp_x, tiff_mpp_y = _mpp_from_tiff_resolution(path)
        if tiff_mpp_x is not None:
            mpp_x_f = mpp_x_f if mpp_x_f is not None else tiff_mpp_x
            mpp_y_f = mpp_y_f if mpp_y_f is not None else tiff_mpp_y
            mpp_source = "tiff-resolution"
        elif objective_f is not None and objective_f > 0:
            # 估算：mpp = 10 / objective-power
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


def _slide_info_dict(name: str) -> dict:
    """构建单个切片的元数据字典（用于列表与 info 接口）。

    meta 部分（尺寸/mpp，需打开切片读取）走 mtime 感知缓存避免重复打开；
    alias/note（来自 slide_meta，可独立于文件修改）每次现查并合并。
    """
    safe = _safe_name(name)
    path = UPLOAD_DIR / safe
    base = {"name": safe, "size_bytes": path.stat().st_size}

    def _read_meta():
        entry = _get_slide(safe)
        with slide_cache.borrow_pair(entry) as pair:
            return _read_metadata(pair["osr"], path)

    try:
        meta = slide_cache.cached_read_metadata(safe, path, _read_meta)
    except Exception as e:
        base.update(
            {
                "width": None,
                "height": None,
                "mpp_x": None,
                "mpp_y": None,
                "objective": None,
                "mpp_source": "missing",
                "error": str(e),
            }
        )
        sm = share_store.get_slide_meta(safe)
        base["alias"] = sm.get("alias", "")
        base["note"] = sm.get("note", "")
        return base
    base.update(meta)
    sm = share_store.get_slide_meta(safe)
    base["alias"] = sm.get("alias", "")
    base["note"] = sm.get("note", "")
    return base


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    """管理员登录页。GET 渲染；POST 校验并写 session。

    用 hmac.compare_digest 比较用户名/密码；连续失败 5 次锁定 60 秒。
    成功：session.permanent=True，session["auth_user"]=username，跳 next（校验
    必须以 / 开头且不以 // 开头，防开放跳转）或 "/"。
    """
    if not AUTH_ENABLED:
        # 未启用认证：直接回首页
        return redirect("/")

    next_url = request.args.get("next") or "/"

    if request.method == "POST":
        ip = request.remote_addr or ""
        # 锁定期内拒绝
        if _is_ip_locked(ip):
            return render_template("login.html", error="尝试过于频繁，请稍后再试", next_url=next_url), 429

        username = request.form.get("username", "")
        password = request.form.get("password", "")
        # POST 时 next 来自表单隐藏域（GET 渲染时已写入）
        post_next = request.form.get("next") or "/"
        user_ok = hmac.compare_digest(username, ADMIN_USERNAME)
        pass_ok = hmac.compare_digest(password, ADMIN_PASSWORD)

        if user_ok and pass_ok:
            session.permanent = True
            session["auth_user"] = ADMIN_USERNAME
            _clear_auth_fails(ip)
            # 校验 next：必须以 / 开头且不以 // 开头，防开放跳转
            if not post_next.startswith("/") or post_next.startswith("//"):
                post_next = "/"
            return redirect(post_next)

        # 失败
        _record_auth_fail(ip)
        return render_template("login.html", error="用户名或密码错误", next_url=next_url), 401

    return render_template("login.html", error=None, next_url=next_url)


@app.route("/logout")
def logout():
    """登出：清 session，跳登录页。"""
    session.clear()
    return redirect("/login")


@app.route("/api/auth/info")
def api_auth_info():
    """返回认证状态与当前登录用户名。"""
    return jsonify(
        auth_enabled=AUTH_ENABLED,
        username=session.get("auth_user"),
    )


@app.route("/api/slides")
def api_slides():
    """列出所有切片的元数据。"""
    items = []
    for child in sorted(UPLOAD_DIR.iterdir()):
        if not child.is_file():
            continue
        if child.suffix.lower().lstrip(".") not in SUPPORTED_EXTS:
            continue
        try:
            items.append(_slide_info_dict(child.name))
        except Exception as e:
            # 路径穿越校验等可能抛出 HTTP 异常，这里收集为 error
            sm = share_store.get_slide_meta(child.name)
            items.append(
                {
                    "name": child.name,
                    "size_bytes": child.stat().st_size,
                    "width": None,
                    "height": None,
                    "mpp_x": None,
                    "mpp_y": None,
                    "objective": None,
                    "mpp_source": "missing",
                    "alias": sm.get("alias", ""),
                    "note": sm.get("note", ""),
                    "error": str(getattr(e, "description", e)),
                }
            )
    return jsonify(items)


def _validate_slide_file(path: Path):
    """验证单个切片文件能否被 slide_io 打开（成功返回 True，否则 False）。"""
    try:
        osr = slide_io.open_slide(path)
    except Exception:
        return False
    try:
        osr.close()
    except Exception:
        pass
    return True


def _extract_zip_to_upload(src_zip: Path):
    """把 zip 解压到 UPLOAD_DIR，返回 (主文件名, [解压出的相对路径...])。

    流程：
    1. 解压到 UPLOAD_DIR 下临时目录 .extracting-<随机>；
    2. 防 zip-slip：拒绝绝对路径与含 .. 的 member，跳过 __MACOSX/隐藏文件；
    3. 若临时目录仅含一个子目录（无文件）则剥掉包装层当根；
    4. 把根下内容 move 到 UPLOAD_DIR；任何目标已存在 → 清理并返回 409 错误；
    5. 找出 SUPPORTED_EXTS 切片文件逐个验证；一个都打不开 → 清理并返回 400。

    失败时返回 (error_message, http_status)；成功返回 (main_name_or_None, moved_paths)。
    """
    tmp_dir = UPLOAD_DIR / (".extracting-" + secrets.token_hex(8))
    try:
        tmp_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        return f"创建临时目录失败: {e}", 400

    moved: list = []

    def _cleanup_all():
        # 清理临时目录与已 move 的文件/目录
        shutil.rmtree(tmp_dir, ignore_errors=True)
        for p in moved:
            try:
                p = UPLOAD_DIR / p
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)
            except Exception:
                pass

    try:
        with zipfile.ZipFile(src_zip, "r") as zf:
            for info in zf.infolist():
                raw = info.filename
                if not raw:
                    continue
                # 规范化分隔符
                norm = raw.replace("\\", "/")
                # 跳过 macOS 元数据与隐藏文件
                parts = norm.split("/")
                if any(p == "__MACOSX" or p.startswith(".") for p in parts):
                    continue
                # 防 zip-slip：拒绝绝对路径与含 ..
                if norm.startswith("/") or any(p == ".." for p in parts):
                    _cleanup_all()
                    return "压缩包含非法路径", 400
                # member 路径各组件过 _sanitize_name
                clean_parts = [_sanitize_name(p) for p in parts]
                if any((not p and i < len(clean_parts) - 1) for i, p in enumerate(clean_parts)):
                    # 中间组件净化为空（非法字符）→ 跳过该 member
                    continue
                clean_parts = [p for p in clean_parts if p]
                if not clean_parts:
                    continue
                target = tmp_dir.joinpath(*clean_parts)
                # 二次校验目标在 tmp_dir 内
                try:
                    target.resolve().relative_to(tmp_dir.resolve())
                except ValueError:
                    _cleanup_all()
                    return "压缩包含非法路径", 400
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
    except zipfile.BadZipFile as e:
        _cleanup_all()
        return f"无效的 zip 文件: {e}", 400
    except Exception as e:
        _cleanup_all()
        return f"解压失败: {e}", 400

    # 若仅含一个子目录且无文件，剥掉包装层
    children = [p for p in tmp_dir.iterdir()] if tmp_dir.exists() else []
    files_in_root = [p for p in children if p.is_file()]
    dirs_in_root = [p for p in children if p.is_dir()]
    root = tmp_dir
    if not files_in_root and len(dirs_in_root) == 1:
        root = dirs_in_root[0]

    # 收集根下全部「文件」（不含目录，避免先移走父目录导致子文件找不到；
    # 目标父目录按需创建）
    entries = []
    for p in root.rglob("*"):
        if p.is_file():
            entries.append((p, p.relative_to(root)))

    # move 到 UPLOAD_DIR；任何目标已存在 → 409
    for abs_p, rel in entries:
        dest = UPLOAD_DIR / rel
        if dest.exists():
            _cleanup_all()
            return f"文件已存在: {rel.as_posix()}", 409

    for abs_p, rel in entries:
        dest = UPLOAD_DIR / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(abs_p), str(dest))
            moved.append(rel.as_posix())
        except Exception as e:
            _cleanup_all()
            return f"移动文件失败: {e}", 400

    # 找出其中支持的切片文件
    slide_files = []
    for rel in moved:
        ext = rel.rsplit(".", 1)[-1].lower() if "." in rel else ""
        if ext in SUPPORTED_EXTS:
            slide_files.append(rel)

    # 逐个验证能否打开
    valid = []
    for sf in slide_files:
        if _validate_slide_file(UPLOAD_DIR / sf):
            valid.append(sf)

    if not valid:
        _cleanup_all()
        return "压缩包内未找到可打开的有效切片文件", 400

    # 主文件优先 .mrxs，其次第一个
    main = next((v for v in valid if v.lower().endswith(".mrxs")), valid[0])
    # 清理临时目录（已 move 的留下）
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return main, sorted(set(valid))


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """流式上传切片文件，或上传 zip 解压（用于 MRXS 等伴侣数据目录格式）。"""
    if "file" not in request.files:
        return jsonify(error="缺少 file 字段"), 400

    file = request.files["file"]
    filename = file.filename or ""
    safe = _sanitize_name(filename)
    if not safe:
        return jsonify(error="非法文件名"), 400

    ext = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""

    # zip 上传：解压分支
    if ext in ARCHIVE_EXTS:
        tmp_zip = UPLOAD_DIR / (".upload-" + secrets.token_hex(8) + ".zip")
        try:
            file.save(tmp_zip)
        except Exception as e:
            tmp_zip.unlink(missing_ok=True)
            return jsonify(error=f"保存失败: {e}"), 400
        result = _extract_zip_to_upload(tmp_zip)
        tmp_zip.unlink(missing_ok=True)
        # _extract_zip_to_upload 失败时返回 (error_msg, status)
        if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], int):
            msg, status = result
            return jsonify(error=msg), status
        main_name, extracted = result
        return jsonify(name=main_name, extracted=extracted)

    if ext not in SUPPORTED_EXTS:
        return jsonify(error="不支持的文件类型"), 400

    dest = UPLOAD_DIR / safe
    if dest.exists():
        return jsonify(error=f"文件已存在: {safe}"), 409

    # 流式保存
    try:
        file.save(dest)
    except Exception as e:
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        return jsonify(error=f"保存失败: {e}"), 400

    # 验证能否打开（裸 .mrxs 通常缺少数据目录，给出针对性提示）
    if not _validate_slide_file(dest):
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        hint = "MRXS 需连同数据目录打包为 zip 上传" if safe.lower().endswith(".mrxs") else "无效的切片文件"
        return jsonify(error=hint), 400

    return jsonify(name=safe)


@app.route("/api/slide/<name>", methods=["DELETE"])
def api_slide_delete(name):
    """关闭句柄并删除切片。

    .mrxs 切片带有同名伴侣数据目录（去扩展名后的目录），一并删除。
    """
    safe = _safe_name(name)
    _close_slide(safe)
    try:
        (UPLOAD_DIR / safe).unlink()
    except FileNotFoundError:
        pass
    # MRXS：删除伴侣数据目录（先做安全检查确保在 UPLOAD_DIR 内）
    if safe.lower().endswith(".mrxs"):
        stem = safe[: -len(".mrxs")]
        companion = UPLOAD_DIR / stem
        try:
            companion.resolve().relative_to(UPLOAD_DIR.resolve())
        except ValueError:
            pass
        else:
            if companion.is_dir():
                shutil.rmtree(companion, ignore_errors=True)
    return jsonify(ok=True)


@app.route("/api/slide/<name>/info")
def api_slide_info(name):
    """单个切片元数据。"""
    return jsonify(_slide_info_dict(name))


@app.route("/api/slide/<name>.dzi")
def api_slide_dzi(name):
    """手工生成 Deep Zoom XML。"""
    safe = _safe_name(name)
    entry = _get_slide(safe)
    with slide_cache.borrow_pair(entry) as pair:
        dz = pair["dz"]
        # DZI Size 取最高层（level_count-1）尺寸
        width, height = dz.level_dimensions[-1]

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" '
        f'Url="/api/slide/{safe}_files/" Format="jpeg" '
        f'Overlap="{DZ_OVERLAP}" TileSize="{DZ_TILE_SIZE}">'
        f'<Size Width="{width}" Height="{height}"/>'
        "</Image>"
    )
    resp = Response(xml, mimetype="application/xml")
    # DZI 元数据短期可变（重传/换切片后 URL 不变但尺寸会变），用短缓存
    resp.headers["Cache-Control"] = "max-age=60"
    return resp


@app.route("/api/slide/<name>_files/<int:level>/<int:x>_<int:y>.jpeg")
def api_slide_tile(name, level, x, y):
    """返回 Deep Zoom 单张瓦片 JPEG（512×512、baseline、q82，带 LRU 缓存）。"""
    safe = _safe_name(name)

    key = (safe, level, x, y)
    cached = _tile_cache_get(key)
    if cached is not None:
        buf = io.BytesIO(cached)
    else:
        entry = _get_slide(safe)
        with slide_cache.borrow_pair(entry) as pair:
            dz = pair["dz"]
            tile = dz.get_tile(level, (x, y))

        # 含 alpha 通道时先转 RGB（JPEG 不支持透明度）
        if tile.mode != "RGB":
            tile = tile.convert("RGB")
        buf = io.BytesIO()
        # baseline JPEG：省掉 progressive/optimize 的编码开销（快 3–5×）；
        # 模糊→清晰的渐进预览已由切片页 base-thumb 底图层负责，瓦片无需 progressive
        tile.save(
            buf,
            format="JPEG",
            quality=JPEG_QUALITY,
        )
        _tile_cache_put(key, buf.getvalue())
        buf.seek(0)

    resp = send_file(buf, mimetype="image/jpeg")
    # 瓦片内容不变，长期不可变缓存
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/api/slide/<name>/crop")
def api_slide_crop(name):
    """裁剪 level-0 原始像素区域的 PNG 图像并下载。"""
    safe = _safe_name(name)
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

    with slide_cache.borrow_pair(entry) as pair:
        osr = pair["osr"]
        width, height = osr.dimensions
        # clamp 到图像边界
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


@app.route("/api/slide/<name>/thumbnail")
def api_slide_thumbnail(name):
    """返回缩略图 JPEG。"""
    safe = _safe_name(name)
    entry = _get_slide(safe)
    with slide_cache.borrow_pair(entry) as pair:
        osr = pair["osr"]
        thumb = osr.get_thumbnail((400, 400))
    if thumb.mode != "RGB":
        thumb = thumb.convert("RGB")
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=90)
    buf.seek(0)
    return send_file(buf, mimetype="image/jpeg")


# --------------------------------------------------------------------------- #
# AI 读片助手相关 API（管理员，走 _require_auth）
# --------------------------------------------------------------------------- #
# AI 配置文件：与 flask_secret 同目录（SHARE_DATA_DIR），0600 权限
def _ai_config_path() -> Path:
    return _data_dir_for_secret() / "ai_config.json"


def _mask_api_key(key: str) -> str:
    """api_key 掩码：前4 + **** + 后4；过短则全掩。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return key[:4] + "****" + key[-4:]


def _load_ai_config() -> dict:
    """读取 ai_config.json（0600）；不存在返回空 dict。"""
    p = _ai_config_path()
    if not p.is_file():
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_ai_config(cfg: dict) -> None:
    """写 ai_config.json（0600）。api_key 不入日志。"""
    p = _ai_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)


@app.route("/api/slide/<name>/region", methods=["GET"])
def api_slide_region(name):
    """裁剪 level-0 区域为 JPEG base64（非附件下载，供 AI/前端按需取图）。

    参数：x,y,w,h（level-0 整数，必填，x,y>=0，w,h>0）；
         out_w,out_h 可选（默认保持宽高比、最长边 1568，上限各 4096）。
    返回 JSON：{image_base64, mime, width, height, src:{x,y,w,h}, magnification}。
    src 是 clamp 到边界后的实际区域。
    """
    safe = _safe_name(name)
    entry = _get_slide(safe)

    def _parse_int(key):
        try:
            return int(request.args.get(key, ""))
        except (TypeError, ValueError):
            return None

    x = _parse_int("x")
    y = _parse_int("y")
    w = _parse_int("w")
    h = _parse_int("h")
    if x is None or y is None or w is None or h is None:
        return jsonify(error="x/y/w/h 参数需为整数"), 400
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        return jsonify(error="参数越界（0<=x,y，0<w,h）"), 400

    out_w = _parse_int("out_w")
    out_h = _parse_int("out_h")

    with slide_cache.borrow_pair(entry) as pair:
        osr = pair["osr"]
        width, height = osr.dimensions
        # clamp 到图像边界
        x2 = min(x, max(0, width - 1))
        y2 = min(y, max(0, height - 1))
        max_w = max(0, width - x2)
        max_h = max(0, height - y2)
        w2 = min(w, max_w)
        h2 = min(h, max_h)
        if w2 <= 0 or h2 <= 0:
            return jsonify(error="裁剪区域超出图像边界"), 400
        # 选最佳金字塔层（按 downsample）以加速 read_region。
        # read_region 的 location 是 level-0 坐标，但 size 是该层像素尺寸，
        # 故需把 level-0 尺寸 (w2,h2) 除以该层 downsample 得层内尺寸。
        ds = max(w2, h2) / 1568.0 if max(w2, h2) > 1568 else 1.0
        try:
            lvl = osr.get_best_level_for_downsample(ds) if ds > 1 else 0
        except Exception:
            lvl = 0
        try:
            ds_lvl = float(osr.level_downsamples[lvl]) if lvl < len(osr.level_downsamples) else 1.0
        except Exception:
            ds_lvl = 1.0
        rw = max(1, int(round(w2 / ds_lvl)))
        rh = max(1, int(round(h2 / ds_lvl)))
        region = osr.read_region((x2, y2), lvl, (rw, rh))
        if region.mode != "RGB":
            region = region.convert("RGB")

        # 计算输出尺寸：默认保持宽高比、最长边 1568
        if out_w and out_w > 0 and out_h and out_h > 0:
            ow = min(out_w, 4096)
            oh = min(out_h, 4096)
        else:
            longest = max(w2, h2)
            if longest <= 1568:
                ow, oh = w2, h2
            else:
                scale = 1568.0 / longest
                ow = max(1, int(round(w2 * scale)))
                oh = max(1, int(round(h2 * scale)))
        if (ow, oh) != (w2, h2):
            region = region.resize((ow, oh), Image.LANCZOS)

        # 读取 mpp 算放大倍率（供前端展示）
        meta = _read_metadata(osr, UPLOAD_DIR / safe)
        mpp = meta.get("mpp_x")
        mag = None
        if mpp and mpp > 0:
            try:
                level_ds = osr.level_downsamples
                ds_lvl = float(level_ds[lvl]) if lvl < len(level_ds) else 1.0
            except Exception:
                ds_lvl = 1.0
            base = 10.0 / mpp
            mag = base / ds_lvl if ds_lvl > 0 else base

    buf = io.BytesIO()
    region.save(buf, format="JPEG", quality=85)
    img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return jsonify({
        "image_base64": img_b64,
        "mime": "image/jpeg",
        "width": ow,
        "height": oh,
        "src": {"x": x2, "y": y2, "w": w2, "h": h2},
        "magnification": mag,
    })


@app.route("/api/ai/config", methods=["GET", "PUT"])
def api_ai_config():
    """读写 AI 配置（base_url/api_key/model/max_tokens + 会话调优参数）。

    GET：api_key 脱敏为 api_key_set:bool + 掩码（前4后4），不回显明文。
    PUT：空串=清除 api_key；与掩码同值=不变；其他=覆盖。
    api_key 不入日志。会话调优参数（§8.1）进 ai_config.json，缺省用文档默认。
    """
    if request.method == "GET":
        cfg = _load_ai_config()
        key = cfg.get("api_key") or ""
        out = {
            "base_url": cfg.get("base_url") or "",
            "api_key_set": bool(key),
            "api_key_mask": _mask_api_key(key),
            "model": cfg.get("model") or "",
            "max_tokens": cfg.get("max_tokens") or 2048,
        }
        for k, v in ai_session.DEFAULT_CONFIG.items():
            out[k] = cfg.get(k, v)
        return jsonify(out)

    body = request.get_json(silent=True) or {}
    cfg = _load_ai_config()
    # base_url / model / max_tokens 直接覆盖（字符串/数字）
    if "base_url" in body:
        cfg["base_url"] = str(body.get("base_url") or "").strip()
    if "model" in body:
        cfg["model"] = str(body.get("model") or "").strip()
    if "max_tokens" in body:
        try:
            cfg["max_tokens"] = int(body.get("max_tokens"))
        except (TypeError, ValueError):
            return jsonify(error="max_tokens 需为整数"), 400
    # 会话调优参数（数字类型，§8.1）
    for k in ai_session.DEFAULT_CONFIG:
        if k in body:
            try:
                cfg[k] = float(body[k]) if isinstance(body[k], float) else int(body[k])
            except (TypeError, ValueError):
                return jsonify(error="{} 需为数值".format(k)), 400
    # api_key：空串=清除；与掩码同值=不变；其他=覆盖
    if "api_key" in body:
        new_key = body.get("api_key")
        if new_key is None:
            pass  # 不传不动
        else:
            new_key = str(new_key)
            if new_key == "":
                cfg.pop("api_key", None)
            elif new_key == _mask_api_key(cfg.get("api_key") or ""):
                pass  # 与掩码同值，不变
            else:
                cfg["api_key"] = new_key
    _save_ai_config(cfg)
    # 回显脱敏
    key = cfg.get("api_key") or ""
    out = {
        "base_url": cfg.get("base_url") or "",
        "api_key_set": bool(key),
        "api_key_mask": _mask_api_key(key),
        "model": cfg.get("model") or "",
        "max_tokens": cfg.get("max_tokens") or 2048,
    }
    for k, v in ai_session.DEFAULT_CONFIG.items():
        out[k] = cfg.get(k, v)
    return jsonify(out)


def _ai_slide_ctx(slide_name: str):
    """构造 AI 读片所需的 slide 上下文 dict + 物化回调（materializer）。

    上下文含 config/info/region/fingerprint：region 调本进程内的 slide_cache
    读图（不走 HTTP）；materializer 把 canonical 的 image_ref 物化为 base64
    image_url（§3.3），带 slide_fingerprint 防伪（§3.3 image_ref 防伪）。
    """
    safe = _safe_name(slide_name)
    entry = _get_slide(safe)
    cfg = _load_ai_config()
    with slide_cache.borrow_pair(entry) as pair:
        osr = pair["osr"]
        width, height = osr.dimensions
        try:
            level_downsamples = tuple(osr.level_downsamples)
        except Exception:
            level_downsamples = (1.0,)
        meta = _read_metadata(osr, UPLOAD_DIR / safe)
        mpp = meta.get("mpp_x")
    fingerprint = _slide_fingerprint(safe)

    def region_fn(x, y, w, h, out_w, out_h):
        return _read_region_b64(entry, int(x), int(y), int(w), int(h),
                                int(out_w), int(out_h), safe, mpp)

    ctx = {
        "config": cfg,
        "info": {
            "width": width, "height": height,
            "level_downsamples": level_downsamples, "mpp": mpp,
        },
        "region": region_fn,
        "fingerprint": fingerprint,
    }

    def materializer(ref):
        """image_ref → image_url（物化，§3.3）。"""
        fp = ref.get("slide_fingerprint") or ""
        if fp and fp != fingerprint:
            return {"type": "text", "text": "该图因切片变更不可用。"}
        src = ref.get("src") or {}
        x = int(src.get("x") or 0)
        y = int(src.get("y") or 0)
        w = int(src.get("w") or 1)
        h = int(src.get("h") or 1)
        try:
            r = _read_region_b64(entry, x, y, w, h, 1568, 1568, safe, mpp)
        except Exception:
            return {"type": "text", "text": "该图因切片变更不可用。"}
        return {
            "type": "image_url",
            "image_url": {"url": "data:image/jpeg;base64," + r["image_base64"]},
        }

    return ctx, materializer


def _slide_fingerprint(safe: str) -> str:
    """切片内容指纹（mtime+size），image_ref 防伪用（§3.3）。"""
    p = UPLOAD_DIR / safe
    try:
        st = p.stat()
        return "{}:{}".format(st.st_mtime_ns, st.st_size)
    except Exception:
        return ""


def _read_region_b64(entry, x, y, w, h, out_w, out_h, safe, mpp):
    """实际读 region → JPEG base64（与 /region 端点逻辑一致，供 AI 进程内调用）。"""
    with slide_cache.borrow_pair(entry) as pair:
        osr = pair["osr"]
        width, height = osr.dimensions
        x2 = max(0, min(x, max(0, width - 1)))
        y2 = max(0, min(y, max(0, height - 1)))
        w2 = max(0, min(w, max(0, width - x2)))
        h2 = max(0, min(h, max(0, height - y2)))
        if w2 <= 0 or h2 <= 0:
            w2, h2 = 1, 1
        ds = max(w2, h2) / 1568.0 if max(w2, h2) > 1568 else 1.0
        try:
            lvl = osr.get_best_level_for_downsample(ds) if ds > 1 else 0
        except Exception:
            lvl = 0
        try:
            ds_lvl = float(osr.level_downsamples[lvl]) if lvl < len(osr.level_downsamples) else 1.0
        except Exception:
            ds_lvl = 1.0
        rw = max(1, int(round(w2 / ds_lvl)))
        rh = max(1, int(round(h2 / ds_lvl)))
        region = osr.read_region((x2, y2), lvl, (rw, rh))
        if region.mode != "RGB":
            region = region.convert("RGB")
        ow = max(1, min(out_w, 4096))
        oh = max(1, min(out_h, 4096))
        if (ow, oh) != (w2, h2):
            region = region.resize((ow, oh), Image.LANCZOS)
        mag = None
        if mpp and mpp > 0:
            try:
                level_ds = osr.level_downsamples
                ds_lvl = float(level_ds[lvl]) if lvl < len(level_ds) else 1.0
            except Exception:
                ds_lvl = 1.0
            base = 10.0 / mpp
            mag = base / ds_lvl if ds_lvl > 0 else base
    buf = io.BytesIO()
    region.save(buf, format="JPEG", quality=85)
    img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {
        "image_base64": img_b64,
        "mime": "image/jpeg",
        "width": ow, "height": oh,
        "src": {"x": x2, "y": y2, "w": w2, "h": h2},
        "magnification": mag,
    }


@app.route("/api/ai/run", methods=["POST"])
def api_ai_run():
    """主 session 起跑（SSE）。body: {slide, task, fresh?}。

    fresh=1（前端"开始"）：归档旧 main、新建 session 跑全片（§5.2），
    等价于过去的单轮 AI 读片体验。fresh 缺省时复用已有 main（有则续跑）。
    会话已 running（租约未过期）→ 409。
    """
    body = request.get_json(silent=True) or {}
    slide = body.get("slide")
    task = body.get("task") or ""
    fresh = bool(body.get("fresh"))
    safe = _validate_ai_slide(slide)
    _require_ai_configured()

    ctx, materializer = _ai_slide_ctx(safe)
    cfg = ai_session._merge_config(_load_ai_config())

    if fresh:
        runner = ai_session.SessionRunner.acquire(safe, "main", cfg=cfg, fresh=True)
    else:
        idx = ai_session.list_session_ids_by_slide(safe)
        sid = idx.get("main")
        if sid:
            runner = ai_session.SessionRunner.acquire(safe, "main", session_id=sid, cfg=cfg)
        else:
            runner = ai_session.SessionRunner.acquire(safe, "main", cfg=cfg, fresh=True)

    return _start_main_worker(runner, ctx, materializer, task, fresh)


@app.route("/api/ai/continue", methods=["POST"])
def api_ai_continue():
    """主 session 从落库 state+messages 续跑（SSE）。body: {slide}。"""
    body = request.get_json(silent=True) or {}
    slide = body.get("slide")
    safe = _validate_ai_slide(slide)
    _require_ai_configured()

    idx = ai_session.list_session_ids_by_slide(safe)
    sid = idx.get("main")
    if not sid:
        return jsonify(error="没有可继续的主会话"), 404

    ctx, materializer = _ai_slide_ctx(safe)
    cfg = ai_session._merge_config(_load_ai_config())
    runner = ai_session.SessionRunner.acquire(safe, "main", session_id=sid, cfg=cfg)
    return _start_main_worker(runner, ctx, materializer, None, fresh=False, resumed=True)


@app.route("/api/ai/ask", methods=["POST"])
def api_ai_ask():
    """fork 起跑/续聊（批注式对话，SSE）。body: {slide, annotation_id, question}。

    根标注已删除 → 410 Gone（§2.2）。fork 默认无 create_annotation（纯问答+看图）。
    活跃 fork 超上限自动归档最旧 idle 的（running 不归档，§2.3）。
    """
    body = request.get_json(silent=True) or {}
    slide = body.get("slide")
    annotation_id = body.get("annotation_id")
    question = body.get("question") or ""
    safe = _validate_ai_slide(slide)
    _require_ai_configured()
    if not isinstance(annotation_id, str) or not annotation_id:
        return jsonify(error="缺少 annotation_id"), 400

    # 根标注定位（含 tombstone 判断）
    roi = share_store.get_roi_by_annotation_id(annotation_id)
    if roi is None or roi.get("deleted"):
        return jsonify(error="该标注已删除"), 410

    ctx, materializer = _ai_slide_ctx(safe)
    cfg = ai_session._merge_config(_load_ai_config())

    # 已有 fork 则续聊，否则新建
    idx = ai_session.list_session_ids_by_slide(safe)
    existing = idx.get("forks", {}).get(annotation_id)
    if existing:
        runner = ai_session.SessionRunner.acquire(safe, "fork", session_id=existing, cfg=cfg)
        # 追加用户问题
        with ai_session._SessionLock(runner.session_id):
            data = runner.get_data()
            data.setdefault("canonical_messages", []).append(
                {"role": "user", "content": question or "请谈谈这个区域"})
            ai_session.write_session(runner.session_id, data)
        initial_messages = None  # 用 canonical 续跑
    else:
        # 新 fork：按 §2.2 构建自包含初始上下文
        _enforce_fork_limit(safe, int(cfg.get("fork_active_limit") or 20))
        runner = ai_session.SessionRunner.acquire(
            safe, "fork", annotation_id=annotation_id,
            title="批注@" + roi.get("label", ""), cfg=cfg)
        info = ctx["info"]
        # 附图：bbox 外扩 10-20%，输出 1024-1568px（§8.3），存 image_ref
        img_ref, img_b64 = _fork_spot_image_ref(ctx, roi)
        spot_msgs = ai_agent.make_fork_messages(
            safe, info, roi, question,
            image_ref=img_ref, image_b64=img_b64)
        with ai_session._SessionLock(runner.session_id):
            data = runner.get_data()
            data["canonical_messages"] = list(spot_msgs)
            data["spot_cursor"] = share_store.current_change_seq(safe)
            ai_session.write_session(runner.session_id, data)
        initial_messages = None
        runner.emit_event("fork_created", {
            "annotation_id": annotation_id,
            "title": data["title"],
        })

    return _start_fork_worker(runner, ctx, materializer, annotation_id, question)


@app.route("/api/ai/cancel", methods=["POST"])
def api_ai_cancel():
    """显式取消（写 cancel_requested，§5.4）。body: {session_id}。"""
    body = request.get_json(silent=True) or {}
    session_id = body.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return jsonify(error="缺少 session_id"), 400
    data = ai_session.read_session(session_id)
    if data is None:
        return jsonify(error="会话不存在"), 404
    runner = ai_session.SessionRunner(session_id)
    runner.cfg = ai_session._merge_config(_load_ai_config())
    runner.mark_cancelled()
    return jsonify(ok=True)


@app.route("/api/ai/sessions")
def api_ai_sessions():
    """列出某切片的 main + 活跃 forks（§2.1/§2.3）。?slide= 必填。"""
    slide = request.args.get("slide")
    if not slide:
        return jsonify(error="缺少 slide"), 400
    safe = _sanitize_name(slide)
    if not safe or safe != slide:
        return jsonify(error="非法文件名"), 400
    idx = ai_session.list_session_ids_by_slide(safe)
    out = []
    main_sid = idx.get("main")
    if main_sid:
        d = ai_session.read_session(main_sid)
        if d:
            out.append(_session_list_item(d))
    for aid, sid in (idx.get("forks") or {}).items():
        d = ai_session.read_session(sid)
        if d and not d.get("archived"):
            out.append(_session_list_item(d))
    out.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return jsonify({"sessions": out})


@app.route("/api/ai/session/<session_id>")
def api_ai_session_detail(session_id):
    """session detail + 脱敏 transcript（§5：图以 image_ref，不含 base64）。"""
    data = ai_session.read_session(session_id)
    if data is None:
        return jsonify(error="会话不存在"), 404
    msgs = data.get("canonical_messages") or []
    return jsonify({
        "session": {
            "id": data.get("id"),
            "slide": data.get("slide"),
            "kind": data.get("kind"),
            "title": data.get("title"),
            "status": data.get("status"),
            "archived": data.get("archived"),
            "annotation_id": data.get("annotation_id") or "",
            "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
            "last_accessed_at": data.get("last_accessed_at"),
            "spot_cursor": data.get("spot_cursor"),
            "last_event_seq": data.get("last_event_seq"),
            "event_min_seq": data.get("event_min_seq"),
            "agent_state": data.get("agent_state"),
            "summary": data.get("summary"),
        },
        "transcript": msgs,
    })


@app.route("/api/ai/session/<session_id>/archive", methods=["POST"])
@app.route("/api/ai/session/<session_id>/unarchive", methods=["POST"])
def api_ai_session_archive(session_id):
    """fork 归档/恢复（§2.3）。running 的 fork 不可归档。"""
    data = ai_session.read_session(session_id)
    if data is None:
        return jsonify(error="会话不存在"), 404
    archived = request.path.endswith("/archive")
    if archived and data.get("status") == "running":
        return jsonify(error="运行中的会话不可归档"), 409
    with ai_session._SessionLock(session_id):
        data = ai_session.read_session(session_id)
        if data is None:
            return jsonify(error="会话不存在"), 404
        data["archived"] = bool(archived)
        data["updated_at"] = time.time()
        ai_session.write_session(session_id, data)
    return jsonify(ok=True, archived=bool(archived))


# --------------------------------------------------------------------------- #
# AI 会话辅助（app 内部）
# --------------------------------------------------------------------------- #
def _validate_ai_slide(slide):
    """校验 slide 参数合法且存在，返回净化名。"""
    if not isinstance(slide, str) or not slide:
        abort(400, jsonify(error="缺少 slide"))
    safe = _sanitize_name(slide)
    if not safe or safe != slide:
        abort(400, jsonify(error="非法文件名"))
    if not (UPLOAD_DIR / safe).is_file():
        abort(404, jsonify(error="切片不存在"))
    return safe


def _require_ai_configured():
    cfg = _load_ai_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        abort(400, jsonify(error="AI 未配置：请先在面板里填写 base_url 与 api_key"))


def _session_list_item(d: dict) -> dict:
    return {
        "id": d.get("id"),
        "title": d.get("title"),
        "kind": d.get("kind"),
        "status": d.get("status"),
        "archived": d.get("archived"),
        "annotation_id": d.get("annotation_id") or "",
        "updated_at": d.get("updated_at"),
        "created_at": d.get("created_at"),
    }


def _fork_spot_image_ref(ctx: dict, roi: dict):
    """fork 附图：bbox 外扩 10-20%，输出 1024-1568px（§8.3），返回 (image_ref, b64|None)。"""
    x = int(roi.get("x") or 0)
    y = int(roi.get("y") or 0)
    side = int(roi.get("side_px") or 0)
    if side <= 0:
        return None, None
    pad = int(round(side * 0.15))  # 外扩 15%
    info = ctx.get("info") or {}
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    ex = max(0, x - pad)
    ey = max(0, y - pad)
    ew = min(side + pad * 2, max(1, width - ex))
    eh = min(side + pad * 2, max(1, height - ey))
    src = {"x": ex, "y": ey, "w": ew, "h": eh}
    mag = None
    try:
        r = ctx["region"](ex, ey, ew, eh, 1568, 1568)
        b64 = r.get("image_base64") or ""
        mag = r.get("magnification")
    except Exception:
        b64 = ""
    image_ref = {
        "type": "image_ref",
        "ref_id": "ref_fork_" + (roi.get("annotation_id") or "")[:12],
        "slide_fingerprint": ctx.get("fingerprint") or "",
        "src": src,
        "magnification": mag,
        "summary": "该 spot 当前快照（bbox 外扩 15%）",
    }
    return image_ref, (b64 or None)


def _enforce_fork_limit(slide: str, limit: int) -> None:
    """活跃 fork 超上限时归档最旧的 idle/paused/finished/error（running 不归档）。"""
    if limit <= 0:
        return
    idx = ai_session.list_session_ids_by_slide(slide)
    forks = []
    for sid in (idx.get("forks") or {}).values():
        d = ai_session.read_session(sid)
        if d:
            forks.append(d)
    running = [d for d in forks if d.get("status") == "running"]
    idle = [d for d in forks if d.get("status") != "running" and not d.get("archived")]
    allowed = max(0, limit - len(running))
    if len(idle) <= allowed:
        return
    idle.sort(key=lambda d: d.get("last_accessed_at") or d.get("updated_at") or 0)
    for d in idle[: len(idle) - allowed]:
        with ai_session._SessionLock(d.get("id")):
            cur = ai_session.read_session(d.get("id"))
            if cur:
                cur["archived"] = True
                ai_session.write_session(d.get("id"), cur)


def _start_main_worker(runner, ctx, materializer, task, fresh, resumed=False):
    """启动 main session 的 worker 线程并返回 SSE Response。

    fresh：初始消息 = system + 用户任务 + spot 变更；初始视口 = 概览。
    resumed：从落库 canonical（materialize 物化）+ agent_state 续跑。
    """
    runner.set_slide_ctx(ctx)
    runner.set_materializer(materializer)

    # 预取 slide 信息与初始视口
    info = ctx.get("info") or {}
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    downsamples = tuple(info.get("level_downsamples") or (1.0,))
    mpp = info.get("mpp")

    def worker():
        try:
            runner.start_heartbeat_thread()
            if fresh:
                vp = 1024
                lvl = ai_agent.AgentState.pick_overview_level(width, height, downsamples, vp)
                st = ai_agent.AgentState(width / 2.0, height / 2.0, vp, lvl, mpp)
                # 先把 system + 用户任务落库 canonical（否则 continue 丢 system 前缀）
                main_msgs = ai_agent.make_main_messages(
                    runner.get_data().get("slide"), task, info)
                for m in main_msgs:
                    runner.append_message(m)
                spot_msgs = runner.inject_spot_changes() or []
                initial = main_msgs + spot_msgs
                bbox = st.viewport_bbox(downsamples)
                runner.emit_event("slide_opened", {
                    "slide": runner.get_data().get("slide"),
                    "width": width, "height": height,
                    "overview_level": lvl,
                    "level_count": len(downsamples),
                    "mpp": mpp,
                    "viewport": bbox,
                    "session_id": runner.session_id,
                })
            else:
                # continue：从落库 state + messages 续跑（§4.1/§3.3）
                runner.inject_spot_changes()
                data = runner.get_data()
                initial = runner.materialize_request_messages()
                st = ai_agent.AgentState.from_dict(data.get("agent_state"), mpp)
                runner.emit_event("session_resumed", {
                    "session_id": runner.session_id,
                    "status": data.get("status"),
                })
            ai_agent.run_agent(initial, st, runner)
        except Exception as e:  # noqa: BLE001
            try:
                runner.emit_event("agent_error", {"error": "读片助手异常：{}".format(e)})
            except Exception:
                pass
        finally:
            try:
                runner.finalize()
            except Exception:
                pass

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return _sse_response(runner.session_id)


def _start_fork_worker(runner, ctx, materializer, annotation_id, question):
    """启动 fork session 的 worker 线程并返回 SSE Response（§2.2）。"""
    runner.set_slide_ctx(ctx)
    runner.set_materializer(materializer)

    def worker():
        try:
            runner.start_heartbeat_thread()
            runner.inject_spot_changes()
            data = runner.get_data()
            initial = runner.materialize_request_messages()
            info = ctx.get("info") or {}
            mpp = info.get("mpp")
            # fork 初始视口：定位到根标注中心
            st = ai_agent.AgentState.from_dict(data.get("agent_state"), mpp)
            runner.emit_event("fork_resumed", {
                "session_id": runner.session_id,
                "annotation_id": annotation_id,
            })
            ai_agent.run_agent(initial, st, runner)
        except Exception as e:  # noqa: BLE001
            try:
                runner.emit_event("agent_error", {"error": "读片助手异常：{}".format(e)})
            except Exception:
                pass
        finally:
            try:
                runner.finalize()
            except Exception:
                pass

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return _sse_response(runner.session_id)


@app.route("/api/ai/session/<session_id>/stream")
def api_ai_session_stream(session_id):
    """SSE 重挂/断线重连：流式重放某 session 的 event log（§5.6）。

    不重新 acquire（CAS 在 /run /continue /ask 里做）；只轮询读持久化
    .events.jsonl，`?after_seq=N` 或 Last-Event-ID 从断点重放后接续 live。
    session 离开 running 且无新事件时发 session_ended 结束。
    """
    data = ai_session.read_session(session_id)
    if data is None:
        return jsonify(error="会话不存在"), 404
    return _sse_response(session_id)


def _sse_response(session_id: str):
    """SSE 生成器：轮询 .events.jsonl，带 Last-Event-ID 断线重挂（§5.6）。

    after_seq 来自 query 参数或 Last-Event-ID header；断线重挂时重放缺失
    事件后接续 live 流（轮询读持久化日志，不依赖原请求的内存 queue）。
    会话离开 running 且无新事件 → 终态后 session_ended 结束。
    """
    after_seq = request.args.get("after_seq")
    try:
        after_seq = int(after_seq) if after_seq else 0
    except (TypeError, ValueError):
        after_seq = 0
    if after_seq <= 0 and request.headers.get("Last-Event-ID"):
        try:
            after_seq = int(request.headers.get("Last-Event-ID"))
        except (TypeError, ValueError):
            after_seq = 0

    def gen():
        last_seq = after_seq
        # 若客户端断点已被事件日志滚动窗口丢弃（after_seq < event_min_seq，
        # §5.6）→ 先发 event_reset，前端全量 GET session detail 重建轨迹，
        # 不再补发不完整的历史。
        _event_reset_sent = False

        def _drain():
            nonlocal last_seq
            data = ai_session.read_session(session_id) or {}
            cur = int(data.get("last_event_seq") or 0)
            if not _event_reset_sent and after_seq > 0:
                min_seq = int(data.get("event_min_seq") or 0)
                if after_seq < min_seq:
                    # 断点已被滚动窗口丢弃 → 只发 event_reset，让前端全量刷新
                    # （带 id: 推进 Last-Event-ID，避免重连时再次触发）
                    last_seq = max(last_seq, cur)
                    return [("id: {}\nevent: event_reset\ndata: {}\n\n".format(
                        cur, json.dumps({"event_min_seq": min_seq,
                                         "last_event_seq": cur}, ensure_ascii=False)))]
            yielded = []
            if cur > last_seq:
                for ev in ai_session.replay_events(session_id, last_seq, data):
                    s = int(ev.get("seq") or 0)
                    if s <= last_seq:
                        continue
                    last_seq = s
                    yielded.append("id: {}\nevent: {}\ndata: {}\n\n".format(
                        s, ev.get("type", "message"),
                        json.dumps(ev.get("payload") or {}, ensure_ascii=False)))
            return yielded

        try:
            while True:
                frames = _drain()
                if frames:
                    for f in frames:
                        yield f
                    _event_reset_sent = True
                    continue
                data = ai_session.read_session(session_id) or {}
                status = data.get("status")
                # 会话结束（含租约过期视为崩溃残留）→ 终态收尾
                if status not in ("running",):
                    frames = _drain()
                    for f in frames:
                        yield f
                    yield ("event: session_ended\ndata: {}\n\n".format(
                        json.dumps({"status": status or "idle"}, ensure_ascii=False)))
                    return
                yield ": ping\n\n"
                time.sleep(0.5)
        except GeneratorExit:
            # 客户端断开：不停止后台 run（§5.6），worker 自行收尾
            pass

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache",
                             "X-Accel-Buffering": "no"})



# --------------------------------------------------------------------------- #
# 分享管理 API（管理员，内网）
# --------------------------------------------------------------------------- #
@app.route("/api/share/create", methods=["POST"])
def api_share_create():
    """创建分享链接。JSON: {slides: [...], expires_hours: number}。"""
    body = request.get_json(silent=True) or {}
    slides = body.get("slides")
    expires_hours = body.get("expires_hours")

    if not isinstance(slides, list) or len(slides) == 0:
        return jsonify(error="slides 不能为空"), 400
    if expires_hours is None:
        return jsonify(error="缺少 expires_hours"), 400
    try:
        expires_hours = float(expires_hours)
    except (TypeError, ValueError):
        return jsonify(error="expires_hours 需为数值"), 400
    if expires_hours < 0.1 or expires_hours > 720:
        return jsonify(error="expires_hours 需在 0.1~720 之间"), 400

    # 校验每个文件存在且扩展名合法
    clean = []
    for name in slides:
        if not isinstance(name, str):
            return jsonify(error="slides 含非法文件名"), 400
        safe = _sanitize_name(name)
        if not safe or safe != name:
            return jsonify(error=f"非法文件名: {name}"), 400
        if safe.split(".")[-1].lower() not in SUPPORTED_EXTS:
            return jsonify(error=f"不支持的文件类型: {name}"), 400
        if not (UPLOAD_DIR / safe).is_file():
            return jsonify(error=f"切片不存在: {name}"), 400
        clean.append(safe)

    # roi_sizes 可选：未传或 None 用默认；数组则逐元素校验（6/6.5/6.0/6.5）
    roi_sizes = body.get("roi_sizes")
    if roi_sizes is not None:
        if not isinstance(roi_sizes, list):
            return jsonify(error="roi_sizes 需为数组"), 400
        for s in roi_sizes:
            if isinstance(s, bool) or not isinstance(s, (int, float)):
                return jsonify(error="roi_sizes 元素需为 6 或 6.5"), 400
            if float(s) not in share_store.ALLOWED_ROI_SIZES:
                return jsonify(error="roi_sizes 仅允许 6 或 6.5"), 400

    try:
        share = share_store.create_share(clean, expires_hours, roi_sizes=roi_sizes)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    url = SHARE_BASE_URL + "/s/" + share["token"]
    return jsonify(
        token=share["token"],
        url=url,
        expires_at=share["expires_at"],
        roi_sizes=share.get("roi_sizes", list(share_store.DEFAULT_ROI_SIZES)),
    )


@app.route("/api/share/list")
def api_share_list():
    """列出全部分享，附加 url 与 roi_count。"""
    shares = share_store.list_shares()
    roi_counts = share_store.roi_count_by_token()
    for sh in shares:
        sh["url"] = SHARE_BASE_URL + "/s/" + sh["token"]
        sh["roi_count"] = roi_counts.get(sh["token"], 0)
    return jsonify(shares)


@app.route("/api/share/revoke", methods=["POST"])
def api_share_revoke():
    """撤销分享。JSON: {token}。"""
    body = request.get_json(silent=True) or {}
    token = body.get("token")
    if not token:
        return jsonify(error="缺少 token"), 400
    ok = share_store.revoke_share(token)
    if not ok:
        return jsonify(error="分享不存在"), 404
    return jsonify(ok=True)


@app.route("/api/share/rois")
def api_share_rois():
    """列出全部 ROI（管理员查看）。"""
    rois = share_store.list_rois()
    return jsonify(rois)


# --------------------------------------------------------------------------- #
# 项目管理 API（管理员，内网）
# --------------------------------------------------------------------------- #
def _validate_slide_names(names):
    """校验切片名列表：均需合法、扩展名受支持、文件存在。

    返回 (clean_list, error_str)；成功时 error_str 为 None。
    """
    if not isinstance(names, list):
        return None, "slides 需为数组"
    clean = []
    for name in names:
        if not isinstance(name, str):
            return None, "slides 含非法文件名"
        safe = _sanitize_name(name)
        if not safe or safe != name:
            return None, "非法文件名: " + name
        if safe.split(".")[-1].lower() not in SUPPORTED_EXTS:
            return None, "不支持的文件类型: " + name
        if not (UPLOAD_DIR / safe).is_file():
            return None, "切片不存在: " + name
        clean.append(safe)
    return clean, None


@app.route("/api/project/create", methods=["POST"])
def api_project_create():
    """创建项目。JSON: {name, note?, slides?}。"""
    body = request.get_json(silent=True) or {}
    name = body.get("name", "")
    note = body.get("note", "")
    slides = body.get("slides", [])
    if not isinstance(name, str) or not name.strip():
        return jsonify(error="name 不能为空"), 400
    clean, err = _validate_slide_names(slides if isinstance(slides, list) else [])
    if err:
        return jsonify(error=err), 400
    proj = share_store.create_project(name=name.strip(), note=note or "", slides=clean)
    return jsonify(proj)


@app.route("/api/projects")
def api_projects():
    """列出全部项目，附加 roi_count（项目内切片的标注总数）。"""
    projects = share_store.list_projects()
    # 一次性取 annotations_by_slide，按项目 slides 汇总
    by_slide = share_store.annotations_by_slide()

    def _count_for(slides):
        total = 0
        for s in slides:
            for grp in by_slide.get(s, []):
                total += grp.get("count", 0)
        return total

    out = []
    for p in projects:
        item = dict(p)
        item["roi_count"] = _count_for(p.get("slides", []))
        out.append(item)
    return jsonify(out)


@app.route("/api/project/<pid>")
def api_project_detail(pid):
    """单个项目详情，含每张切片的标注摘要。"""
    proj = share_store.get_project(pid)
    if proj is None:
        return jsonify(error="项目不存在"), 404
    by_slide = share_store.annotations_by_slide()
    project_slides = set(proj.get("slides", []))
    slide_annotations = [
        {"slide": s, "annotations": by_slide.get(s, [])}
        for s in proj.get("slides", [])
    ]
    return jsonify(project=proj, slide_annotations=slide_annotations)


@app.route("/api/project/<pid>", methods=["PATCH"])
def api_project_update(pid):
    """更新项目字段。JSON: {name?, note?, slides?}。"""
    body = request.get_json(silent=True) or {}
    slides = body.get("slides")
    if slides is not None:
        clean, err = _validate_slide_names(slides)
        if err:
            return jsonify(error=err), 400
        slides = clean
    proj = share_store.update_project(
        pid,
        name=body.get("name"),
        note=body.get("note"),
        slides=slides,
    )
    if proj is None:
        return jsonify(error="项目不存在"), 404
    return jsonify(proj)


@app.route("/api/project/<pid>/slides", methods=["POST"])
def api_project_add_slides(pid):
    """向项目追加切片。JSON: {slides: [...]}。"""
    body = request.get_json(silent=True) or {}
    slides = body.get("slides")
    clean, err = _validate_slide_names(slides)
    if err:
        return jsonify(error=err), 400
    proj = share_store.add_slides_to_project(pid, clean)
    if proj is None:
        return jsonify(error="项目不存在"), 404
    return jsonify(proj)


@app.route("/api/project/<pid>/slide/<name>", methods=["DELETE"])
def api_project_remove_slide(pid, name):
    """从项目移除某切片（仅解除归属，不删文件）。"""
    safe = _sanitize_name(name)
    if not safe or safe != name:
        return jsonify(error="非法文件名"), 400
    proj = share_store.remove_slide_from_project(pid, safe)
    if proj is None:
        return jsonify(error="项目不存在或无该切片"), 404
    return jsonify(proj)


@app.route("/api/project/<pid>", methods=["DELETE"])
def api_project_delete(pid):
    """删除项目（不删切片文件）。"""
    ok = share_store.delete_project(pid)
    if not ok:
        return jsonify(error="项目不存在"), 404
    return jsonify(ok=True)


@app.route("/api/annotations")
def api_annotations():
    """返回标注（按 slide 或 project 过滤），供查看器加载某切片的标记。

    查询参数：
      - slide=<name>：只返回该切片的标注分组
      - project=<pid>：只返回该项目内切片的标注
    同时传 slide 与 project 时，slide 优先（且需属于项目）。
    items 已含 type 与全部几何字段（经 store 自动带）。
    """
    slide = request.args.get("slide")
    project = request.args.get("project")

    if slide:
        safe = _sanitize_name(slide)
        if not safe or safe != slide:
            return jsonify(error="非法文件名"), 400
        by_slide = share_store.annotations_by_slide()
        return jsonify({"slide": safe, "annotations": by_slide.get(safe, [])})

    if project:
        by_slide = share_store.annotations_by_project(project)
        return jsonify({"project": project, "by_slide": by_slide})

    # 默认返回全部
    return jsonify({"by_slide": share_store.annotations_by_slide()})


# --------------------------------------------------------------------------- #
# 样本别名/备注 API（管理员）
# --------------------------------------------------------------------------- #
@app.route("/api/slide/<name>/meta", methods=["POST"])
def api_slide_meta(name):
    """设置切片的别名/备注。JSON: {alias?, note?}（None 不改，空串清除）。

    name 需为已存在的切片文件。
    """
    safe = _safe_name(name)
    body = request.get_json(silent=True) or {}
    alias = body.get("alias", None)
    note = body.get("note", None)
    # alias/note 仅接受字符串或 None
    if alias is not None and not isinstance(alias, str):
        return jsonify(error="alias 需为字符串"), 400
    if note is not None and not isinstance(note, str):
        return jsonify(error="note 需为字符串"), 400
    meta = share_store.set_slide_meta(safe, alias=alias, note=note)
    return jsonify(ok=True, meta=meta)


# --------------------------------------------------------------------------- #
# 标注 API（管理员直接在切片上做 rect/arrow/freehand 标注）
# --------------------------------------------------------------------------- #
@app.route("/api/annotation", methods=["POST"])
def api_annotation_add():
    """管理员新增标注。JSON: {slide, type?, label?, shared?, ...geometry}。

    token 固定为 "admin"，label 默认 "管理员"。slide 必须存在。
    几何字段随 type 不同：rect(x,y,side_px,size_mm) / arrow(x1,y1,x2,y2) /
    freehand(points)。shared 可选（默认 false），透传给 store 记录公开状态。
    """
    body = request.get_json(silent=True) or {}
    slide = body.get("slide")
    if not isinstance(slide, str) or not slide:
        return jsonify(error="缺少 slide"), 400
    safe = _sanitize_name(slide)
    if not safe or safe != slide:
        return jsonify(error="非法文件名"), 400
    if not (UPLOAD_DIR / safe).is_file():
        return jsonify(error="切片不存在"), 404

    typ = body.get("type", "rect")
    if typ not in share_store.ROI_TYPES:
        return jsonify(error="未知标注类型"), 400
    label = body.get("label")
    if label is None:
        label = "管理员"
    if not isinstance(label, str):
        return jsonify(error="label 需为字符串"), 400

    # shared 可选，透传给 store（默认 False）
    shared = bool(body.get("shared", False))
    # note 可选（备注文本），透传给 store 校验/清洗
    note = body.get("note", "")

    # 收集几何字段（透传给 add_roi 校验）
    geom = {}
    for k in ("x", "y", "side_px", "size_mm", "x1", "y1", "x2", "y2", "points"):
        if k in body:
            geom[k] = body[k]
    try:
        roi = share_store.add_roi(
            share_store.ADMIN_TOKEN, safe, label, type=typ, shared=shared, note=note, **geom
        )
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(ok=True, index=roi["index"], shared=roi.get("shared", shared))


@app.route("/api/annotation/admin/<int:index>", methods=["DELETE"])
def api_annotation_delete_admin(index):
    """管理员删除自己的标注（token="admin" 下第 index 条）。"""
    ok = share_store.delete_roi(share_store.ADMIN_TOKEN, index)
    if not ok:
        return jsonify(error="标注不存在"), 404
    return jsonify(ok=True)


@app.route("/api/annotation/<token>/<int:index>", methods=["DELETE"])
def api_annotation_delete(token, index):
    """管理员删除任意 token 的标注。token 仅允许非空字符串。"""
    if not isinstance(token, str) or not token:
        return jsonify(error="缺少 token"), 400
    ok = share_store.delete_roi(token, index)
    if not ok:
        return jsonify(error="标注不存在"), 404
    return jsonify(ok=True)


@app.route("/api/annotation/<token>/<int:index>", methods=["PATCH"])
def api_annotation_set_shared(token, index):
    """管理员策展/编辑：可切换「公开」状态，或更新几何/备注。

    JSON body 支持任意组合：
      - {"shared": bool}：走 set_roi_shared；
      - {"geom": {...}}：走 update_roi 更新几何（不含 type）；
      - {"note": "..."}：走 update_roi 更新备注。
    两者可同时传（shared 与 geom/note 独立处理）。
    token/index 无效（shared 或 update 侧）返回 404；
    成功返回 {"ok": true, "shared": <更新后值>, "note": <更新后值>}。
    """
    if not isinstance(token, str) or not token:
        return jsonify(error="缺少 token"), 400
    body = request.get_json(silent=True) or {}

    shared_after = None
    note_after = None

    # shared 部分
    if "shared" in body:
        shared_target = bool(body.get("shared"))
        ok = share_store.set_roi_shared(token, index, shared_target)
        if not ok:
            return jsonify(error="标注不存在"), 404
        shared_after = shared_target

    # geom / note 部分
    if "geom" in body or "note" in body:
        geom = body.get("geom")
        note = body.get("note")
        try:
            updated = share_store.update_roi(token, index, geom=geom, note=note)
        except ValueError as e:
            return jsonify(error=str(e)), 400
        if updated is False:
            return jsonify(error="标注不存在"), 404
        note_after = updated.get("note", "")
        # 若同时没传 shared，回填当前 shared 值便于前端同步
        if shared_after is None:
            shared_after = updated.get("shared")

    # 仅 shared 时回填 note（读当前值）
    if note_after is None:
        rois = share_store.list_rois(token)
        cur = None
        for r in rois:
            if r.get("index") == index:
                cur = r
                break
        note_after = cur.get("note", "") if cur else ""

    return jsonify(ok=True, shared=shared_after, note=note_after)


if __name__ == "__main__":
    # 管理端外网门户由 share_server 合并进程提供（同端口按路径分流），
    # 本进程只保留内网 HTTP 监听；外网走 https://browser.pingoodmice.top:18767/
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        threaded=True,
    )
