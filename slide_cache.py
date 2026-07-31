# -*- coding: utf-8 -*-
"""切片句柄池与元数据缓存（app.py 与 share_server.py 共享）。

早期实现用 per-slide 互斥锁保护单个 OpenSlide 句柄：``with entry["lock"]``。
问题在于 openslide.read_region 非线程安全，加锁后同一切片的并发 tile 请求全部
串行——浏览器一次拉 8 个瓦片会排队，慢网下画面割裂明显。

这里改为「句柄池」：
- 每个切片持有 N 个 (osr, dz) 句柄，``borrow_pair`` 取出一个用完归还；
- 池空且并发超过 N 时 ``sem.acquire()`` 阻塞等待归还——至少 N 路真并行，
  优于全锁串行；
- 句柄池大小由环境变量 SLIDE_HANDLE_POOL 控制（默认 6），同一进程内每个
  切片独立一个池。openslide 句柄非 fork 安全，生产用线程 worker（不 preload、
  不用 gevent/eventlet），每 worker 进程各自持有一份独立的池与缓存。

元数据缓存（mtime 感知）：读 properties + PIL 读 TIFF 标签较慢，列表/单图 info
接口会重复打开。``cached_read_metadata`` 以 (mtime_ns, meta_dict) 缓存 meta 部分，
文件 mtime 未变则复用，避免重复打开；alias/note 由调用方现查合并（可独立于
文件修改）。
"""

import contextlib
import os
import queue
import threading

import openslide
from openslide.deepzoom import DeepZoomGenerator

import slide_io

# Deep Zoom 参数（与主应用保持一致）
DZ_TILE_SIZE = 512
DZ_OVERLAP = 1

# 句柄池大小：每个切片可并行的句柄数（默认 6）
SLIDE_HANDLE_POOL = int(os.environ.get("SLIDE_HANDLE_POOL") or 6)

# 切片缓存：name -> {"name", "path", "pool": Queue, "sem": Semaphore, "created_handles": int}
_slide_cache: dict = {}
_cache_lock = threading.Lock()

# 元数据缓存：name -> (mtime_ns, meta_dict)（mtime 感知，文件未变则复用）
_info_cache: dict = {}
_info_cache_lock = threading.Lock()


def _make_pair(path):
    """打开一个 (osr, dz) 句柄对。"""
    osr = slide_io.open_slide(path)
    dz = DeepZoomGenerator(
        osr, tile_size=DZ_TILE_SIZE, overlap=DZ_OVERLAP, limit_bounds=True
    )
    return {"osr": osr, "dz": dz}


def _new_entry(name, path):
    """创建空句柄池 entry（初始不含任何打开句柄，首次借用时惰性创建）。"""
    return {
        "name": name,
        "path": path,
        "pool": queue.Queue(),
        "sem": threading.Semaphore(SLIDE_HANDLE_POOL),
        "created_handles": 0,
    }


def get_slide(name, path):
    """从缓存获取（或创建）切片的句柄池 entry。

    打开是惰性的：首次 borrow_pair 时才真正调用 slide_io.open_slide，因此这里
    无需处理"并发打开同一文件"的句柄泄漏（空 entry 被丢弃也无副作用）。
    """
    with _cache_lock:
        entry = _slide_cache.get(name)
        if entry is not None:
            return entry
    # 缓存未命中：创建空 entry（不在全局锁内，避免阻塞其他切片）
    entry = _new_entry(name, path)
    with _cache_lock:
        existing = _slide_cache.get(name)
        if existing is not None:
            return existing
        _slide_cache[name] = entry
    return entry


@contextlib.contextmanager
def borrow_pair(entry):
    """借出一个 (osr, dz) 句柄对，用完归还到池。

    并发数受 entry["sem"] 限制：池空且并发 > N 时阻塞等待归还（至少 N 路并行）。
    """
    entry["sem"].acquire()
    pair = None
    try:
        try:
            pair = entry["pool"].get_nowait()
        except queue.Empty:
            pair = _make_pair(entry["path"])
            entry["created_handles"] += 1
        yield pair
    finally:
        entry["sem"].release()
        # _make_pair 失败时 pair 为 None：只归还信号量（避免死锁），
        # 不把 None 放进池里（否则后续借用会拿到 None 报 TypeError）
        if pair is not None:
            entry["pool"].put(pair)


def evict(name):
    """移除并关闭缓存中该切片的全部句柄，同时清掉其 info 缓存。"""
    with _cache_lock:
        entry = _slide_cache.pop(name, None)
    if entry is not None:
        pool = entry["pool"]
        while True:
            try:
                pair = pool.get_nowait()
            except queue.Empty:
                break
            try:
                pair["osr"].close()
            except Exception:
                pass
    with _info_cache_lock:
        _info_cache.pop(name, None)


def cached_read_metadata(name, path, read_meta_fn):
    """mtime 感知的元数据读取：文件未变则复用缓存的 meta 部分。

    read_meta_fn() 需返回 meta dict（内部自取句柄）。alias/note 不在缓存内，
    由调用方每次现查并合并。
    """
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = None
    with _info_cache_lock:
        hit = _info_cache.get(name)
        if hit is not None and hit[0] == mtime:
            return hit[1]
    meta = read_meta_fn()
    with _info_cache_lock:
        _info_cache[name] = (mtime, meta)
    return meta
