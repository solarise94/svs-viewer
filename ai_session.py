# -*- coding: utf-8 -*-
"""AI 读片助手 —— 会话持久化 SessionRunner（纯逻辑，不依赖 Flask）。

实现 docs/ai-session-architecture.md §4~§5 的存储与并发契约：

- session 文件：`share-data/ai_sessions/`（目录 0700 / 文件 0600），原子写
  （tmp + rename），锁稳定的 `.lock` 文件。
- index.json：{slide: {main: session_id, forks: {annotation_id: session_id}}}。
- 会话状态机：idle | running | paused | finished | error；原子抢占 CAS。
- 租约 + fencing token（lease_epoch，§5.5）：过期旧 worker 无法续活/写，只能
  重新 CAS + 递增 epoch 抢占。
- WAL pending_bundle（§5.4）：effect_key = session_id:bundle_seq:tool_call_id，
  崩溃恢复靠 effect_key 幂等，不重复落标。
- SSE event log（§5.6）：`<session_id>.events.jsonl` 一行一事件，含单调 seq，
  崩溃后扫描尾部修复 last_event_seq / event_min_seq。
- compact（§3.5）：estimated_input + reserve >= window - safety_margin 时触发，
  按完整 bundle 切 keep_recent_tokens，增量摘要，compact 后注入 spot 索引。
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import fcntl

# 默认参数（§8.1；ai_config.json 可覆盖）
DEFAULT_CONFIG = {
    "max_steps": 12,
    "context_window_tokens": 272000,
    "reserve_tokens": 16000,
    "safety_margin": 8192,
    "keep_recent_tokens": 20000,
    "fork_active_limit": 20,
    "lease_ttl": 150.0,
    "event_buffer": 200,
    "max_tokens": 2048,
}


class LeaseError(Exception):
    """fencing 校验失败（active_run_id / lease_epoch / 租约过期）→ 旧 worker 弃写。"""


class SessionConflict(Exception):
    """会话状态机冲突（已在 running 等），对应 HTTP 409。"""


class SessionGone(Exception):
    """fork 根标注已被删除，对应 HTTP 410。"""


def _now() -> float:
    return time.time()


def _default_config() -> dict:
    return dict(DEFAULT_CONFIG)


def _merge_config(cfg: Optional[dict]) -> dict:
    out = _default_config()
    if isinstance(cfg, dict):
        for k in DEFAULT_CONFIG:
            if k in cfg and cfg[k] is not None:
                out[k] = cfg[k]
    return out


def _ai_sessions_dir() -> Path:
    base = Path(os.environ.get("SHARE_DATA_DIR") or (Path.home() / "svs-viewer" / "share-data"))
    d = base / "ai_sessions"
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


# --------------------------------------------------------------------------- #
# 会话元数据读写（原子写 + 稳定 .lock）
# --------------------------------------------------------------------------- #
def _new_session_id() -> str:
    return "sess_" + uuid.uuid4().hex[:16]


def _session_file(session_id: str) -> Path:
    return _ai_sessions_dir() / (session_id + ".json")


def _events_file(session_id: str) -> Path:
    return _ai_sessions_dir() / (session_id + ".events.jsonl")


def _lock_path(session_id: str) -> Path:
    return _ai_sessions_dir() / (session_id + ".lock")


class _SessionLock:
    """stable .lock 文件排他锁（不锁会被 rename 替换的 JSON，§4.1）。"""

    def __init__(self, session_id: str):
        self._p = _lock_path(session_id)
        self._fh = None

    def acquire(self):
        self._p.touch(exist_ok=True)
        self._fh = open(self._p, "a+", encoding="utf-8")
        fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        return self

    def release(self):
        if self._fh is not None:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            finally:
                self._fh.close()
                self._fh = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()


def _empty_session(slide: str, kind: str, session_id: str, annotation_id: Optional[str] = None,
                   title: str = "") -> dict:
    now = _now()
    return {
        "id": session_id,
        "slide": slide,
        "kind": kind,  # "main" | "fork"
        "annotation_id": annotation_id or "",
        "title": title or ("批注对话" if kind == "fork" else "全片读片"),
        "created_at": now,
        "updated_at": now,
        "last_accessed_at": now,
        "archived": False,
        "agent_state": {"center_x": 0.0, "center_y": 0.0, "pyramid_level": 0, "viewport_px": 1024},
        "canonical_messages": [],
        "observations": [],
        "pending_bundle": None,
        "pending_snapshot_review": None,
        "compacted_upto": 0,  # 已进摘要的 message 条数（仅当 compact 后非 0）
        "summary": None,
        "status": "idle",
        "revision": 0,
        "bundle_seq": 0,
        "active_run_id": None,
        "cancel_requested": False,
        "lease_epoch": 0,
        "lease_expires_at": 0.0,
        "heartbeat_at": 0.0,
        "spot_cursor": 0,
        "last_event_seq": 0,
        "event_min_seq": 0,
    }


def read_session(session_id: str) -> Optional[dict]:
    """读取会话（无锁，返回副本）。不存在返回 None。"""
    p = _session_file(session_id)
    if not p.is_file():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


def write_session(session_id: str, data: dict) -> None:
    """原子写会话 JSON（tmp + rename），调用方需已持 lock 或单线程。"""
    p = _session_file(session_id)
    tmp = p.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


def delete_session(session_id: str) -> None:
    """删除会话文件 + events + lock（fresh 清理用）。"""
    for p in (_session_file(session_id), _events_file(session_id), _lock_path(session_id)):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# index.json（slide → main/forks 映射）
# --------------------------------------------------------------------------- #
def _index_path() -> Path:
    return _ai_sessions_dir() / "index.json"


def _index_lock_path() -> Path:
    return _ai_sessions_dir() / "index.lock"


def _read_index_locked(fh) -> dict:
    fh.seek(0)
    raw = fh.read()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, ValueError):
        pass
    return {}


def _write_index_locked(fh, data: dict) -> None:
    fh.seek(0)
    fh.truncate()
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.flush()
    os.fsync(fh.fileno())


def _with_index_lock(fn):
    p = _index_path()
    p.touch(exist_ok=True)
    lock = p.with_suffix(".lock")
    lock.touch(exist_ok=True)
    with open(lock, "a+", encoding="utf-8") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def register_session(slide: str, session_id: str, kind: str, annotation_id: Optional[str] = None):
    """在 index 中登记会话；main 覆盖旧 main，fork 按 annotation_id 登记。"""
    def _do():
        with open(_index_path(), "r+", encoding="utf-8") as fh:
            idx = _read_index_locked(fh)
            entry = idx.setdefault(slide, {"main": None, "forks": {}})
            if kind == "main":
                entry["main"] = session_id
            elif annotation_id:
                entry["forks"][annotation_id] = session_id
            _write_index_locked(fh, idx)
    _with_index_lock(_do)


def unregister_session(slide: str, session_id: str, kind: str, annotation_id: Optional[str] = None):
    """从 index 移除登记（仅当当前指向本 session）。"""
    def _do():
        with open(_index_path(), "r+", encoding="utf-8") as fh:
            idx = _read_index_locked(fh)
            entry = idx.get(slide)
            if entry is None:
                return
            if kind == "main" and entry.get("main") == session_id:
                entry["main"] = None
            elif kind == "fork" and annotation_id and entry.get("forks", {}).get(annotation_id) == session_id:
                entry["forks"].pop(annotation_id, None)
            _write_index_locked(fh, idx)
    _with_index_lock(_do)


def list_session_ids_by_slide(slide: str) -> Dict[str, Optional[str]]:
    """返回 {main: session_id|None, forks: {annotation_id: session_id}}。"""
    def _do():
        with open(_index_path(), "r+", encoding="utf-8") as fh:
            idx = _read_index_locked(fh)
            entry = idx.get(slide)
            if not entry:
                return {"main": None, "forks": {}}
            return {"main": entry.get("main"), "forks": dict(entry.get("forks") or {})}
    return _with_index_lock(_do)


# --------------------------------------------------------------------------- #
# SSE event log（§5.6）
# --------------------------------------------------------------------------- #
def _repair_event_seq(session_id: str, data: dict) -> None:
    """崩溃恢复：扫描 .events.jsonl 尾部，以实际最大 seq 修复元数据序号。

    避免 .events.jsonl 已 append 到 seq 120 但元数据只写到 115，重启后重复分配。
    """
    p = _events_file(session_id)
    if not p.is_file():
        return
    max_seq = 0
    try:
        with open(p, "r", encoding="utf-8") as f:
            # 从尾部反向扫 512 行，找最大 seq 即可（seq 单调递增）
            tail = f.readlines()[-512:]
        for line in tail:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            s = ev.get("seq")
            if isinstance(s, (int, float)):
                max_seq = max(max_seq, int(s))
    except OSError:
        return
    if max_seq > int(data.get("last_event_seq") or 0):
        data["last_event_seq"] = max_seq
        data["event_min_seq"] = min(int(data.get("event_min_seq") or max_seq), max_seq)


def append_event(session_id: str, ev: dict, data: dict) -> int:
    """append 一条事件到 .events.jsonl 并更新 data 的 seq 水位（调用方持锁）。

    ev 需含 "type" 与 "payload"（"seq" 由调用方由 _next_seq 分配并写入）。
    返回分配的 seq。
    """
    seq = int(data.get("last_event_seq") or 0) + 1
    ev["seq"] = seq
    line = json.dumps(ev, ensure_ascii=False)
    with open(_events_file(session_id), "a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()
        os.fsync(f.fileno())
    data["last_event_seq"] = seq
    # 滚动窗口：只保留最近 ~200 条可用（event_min_seq 随滚动前移）
    buf = int(data.get("event_buffer_size") or 0)
    if buf:
        data["event_min_seq"] = max(seq - buf + 1, 1)
    else:
        if seq > 200:
            data["event_min_seq"] = seq - 199
        else:
            data["event_min_seq"] = 1
    return seq


def replay_events(session_id: str, after_seq: int, data: dict) -> List[dict]:
    """从 .events.jsonl 重放 seq > after_seq 的事件（供断线重挂，§5.6）。"""
    p = _events_file(session_id)
    if not p.is_file():
        return []
    out = []
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                s = ev.get("seq")
                if isinstance(s, (int, float)) and int(s) > after_seq:
                    out.append(ev)
    except OSError:
        return []
    return out


# --------------------------------------------------------------------------- #
# 事件缓冲（同一 worker 内 emit 到 SSE 的桥）
# --------------------------------------------------------------------------- #
class EventFanout:
    """给 SSE 请求线程的事件队列；SessionRunner 生命周期内可被多个请求重挂。"""

    def __init__(self, after_seq: int, data_provider: Callable[[], dict]):
        self._q: "queue.Queue" = queue.Queue()
        self._closed = False
        self._after_seq = int(after_seq or 0)
        self._data_provider = data_provider

    def put(self, ev: dict):
        if self._closed:
            return
        self._q.put(ev)

    def close(self):
        self._closed = True
        try:
            self._q.put(None)
        except Exception:
            pass

    def iter_events(self):
        """产出事件 dict 序列；先补发 after_seq 之后的历史事件再 live。"""
        data = self._data_provider() if self._data_provider else {}
        if self._after_seq > 0 and isinstance(data, dict):
            for ev in replay_events(data.get("id") or "", self._after_seq, data):
                yield ev
        while True:
            ev = self._q.get()
            if ev is None:
                return
            yield ev


# --------------------------------------------------------------------------- #
# SessionRunner —— 持久化/并发控制收敛点（docs §5.1）
# --------------------------------------------------------------------------- #
class SessionRunner:
    """单个 session 的运行上下文：状态机 + WAL + 租约 + 事件 + compact。

    用法：
      runner = SessionRunner.acquire(slide, kind="main", ...)   # CAS 抢占
      try:
          run_agent(initial_messages, initial_state, runner)
      finally:
          runner.finalize()   # 收 lease、归档等
    """

    def __init__(self, session_id: str, cfg: Optional[dict] = None):
        self.session_id = session_id
        self.cfg = _merge_config(cfg)
        self._lease_ttl = float(self.cfg.get("lease_ttl") or 150.0)
        self._event_buffer = int(self.cfg.get("event_buffer") or 200)
        self._lease_lock = threading.Lock()
        self._hb_stop = threading.Event()
        self._hb_thread: Optional[threading.Thread] = None
        self._hb_daemon = True
        self._fanouts = []
        self._fanout_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # 生命周期 / CAS 抢占（§5.3、§5.5）
    # ------------------------------------------------------------------ #
    @staticmethod
    def _prepare(slide: str, kind: str, session_id: str,
                 annotation_id: Optional[str] = None, title: str = "") -> dict:
        return _empty_session(slide, kind, session_id, annotation_id, title)

    @classmethod
    def acquire(cls, slide: str, kind: str, session_id: Optional[str] = None,
                annotation_id: Optional[str] = None, title: str = "",
                cfg: Optional[dict] = None, fresh: bool = False) -> "SessionRunner":
        """CAS 抢占一个可运行的 session（status ∈ idle/paused/finished/error）。

        session_id 缺省时新建；fresh 时先归档旧 main（§5.2）再新建 main。
        已 running 且租约未过期 → 409（SessionConflict）。
        租约过期（崩溃残留）→ lease_epoch+1 强制转 paused 后重新抢占（§5.5）。
        """
        runner = cls.__new__(cls)
        runner.session_id = session_id or _new_session_id()
        runner.cfg = _merge_config(cfg)
        runner._lease_ttl = float(runner.cfg.get("lease_ttl") or 150.0)
        runner._event_buffer = int(runner.cfg.get("event_buffer") or 200)
        runner._lease_lock = threading.Lock()
        runner._hb_stop = threading.Event()
        runner._hb_thread = None
        runner._hb_daemon = True
        runner._fanouts = []
        runner._fanout_lock = threading.Lock()

        with _SessionLock(runner.session_id) as lock:  # noqa: F841
            data = read_session(runner.session_id)
            if data is None:
                data = _empty_session(slide, kind, runner.session_id, annotation_id, title)
                if fresh and kind == "main":
                    # fresh：归档旧 main（§5.2），不动 forks / 已落 AI 标注
                    idx = list_session_ids_by_slide(slide)
                    old_main = idx.get("main")
                    if old_main and old_main != runner.session_id:
                        with _SessionLock(old_main):
                            old = read_session(old_main)
                            if old:
                                old["archived"] = True
                                write_session(old_main, old)
                write_session(runner.session_id, data)
                register_session(slide, runner.session_id, kind, annotation_id)
            else:
                # 已存在 session：校验 slide/kind 一致性
                if data.get("slide") != slide or data.get("kind") != kind:
                    raise SessionConflict("会话类型不匹配")
                # 崩溃恢复：扫描事件日志尾部修 seq（§5.6 v4.1）
                _repair_event_seq(runner.session_id, data)

            # 原子抢占 CAS（§5.3）
            now = _now()
            if data.get("status") == "running":
                exp = float(data.get("lease_expires_at") or 0)
                if exp >= now:
                    raise SessionConflict("会话正在运行中")
                # 租约过期 → 崩溃残留：epoch+1 强制恢复 paused 后重新抢占
                data["status"] = "paused"
                data["lease_epoch"] = int(data.get("lease_epoch") or 0) + 1
                data["active_run_id"] = None
                data["cancel_requested"] = False
                data["lease_expires_at"] = 0.0
                data["heartbeat_at"] = 0.0
            elif data.get("status") not in ("idle", "paused", "finished", "error"):
                raise SessionConflict("会话状态非法")

            data["status"] = "running"
            data["revision"] = int(data.get("revision") or 0) + 1
            data["active_run_id"] = "run_" + uuid.uuid4().hex[:12]
            data["lease_epoch"] = int(data.get("lease_epoch") or 0) + 1
            data["cancel_requested"] = False
            data["lease_expires_at"] = now + runner._lease_ttl
            data["heartbeat_at"] = now
            data["last_accessed_at"] = now
            data["updated_at"] = now
            data["event_buffer_size"] = runner._event_buffer
            write_session(runner.session_id, data)

        runner._data = read_session(runner.session_id) or data
        runner._my_run_id = runner._data.get("active_run_id")
        runner._my_epoch = int(runner._data.get("lease_epoch") or 0)
        return runner

    def _refresh(self) -> dict:
        self._data = read_session(self.session_id) or self._data
        return self._data

    def _save(self) -> None:
        write_session(self.session_id, self._data)

    # ------------------------------------------------------------------ #
    # 租约 / heartbeat（§5.5）
    # ------------------------------------------------------------------ #
    def heartbeat(self) -> None:
        """周期续租（独立线程）。过期不续活，只能重新 CAS 抢占。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            if data.get("active_run_id") != self._my_run_id:
                raise LeaseError("fencing: active_run_id 不匹配")
            if int(data.get("lease_epoch") or 0) != self._my_epoch:
                raise LeaseError("fencing: lease_epoch 不匹配")
            now = _now()
            if float(data.get("lease_expires_at") or 0) < now:
                # 租约已过期：heartbeat 不得续活（§5.5）——只能重新 CAS
                raise LeaseError("fencing: 租约已过期")
            data["heartbeat_at"] = now
            data["lease_expires_at"] = now + self._lease_ttl
            data["updated_at"] = now
            self._save()

    def start_heartbeat_thread(self) -> None:
        """启动独立续租线程（模型请求阻塞期间仍能续租，§5.5）。"""
        if self._hb_thread and self._hb_thread.is_alive():
            return
        interval = max(10.0, self._lease_ttl / 5.0)

        def _loop():
            while not self._hb_stop.is_set():
                time.sleep(interval)
                if self._hb_stop.is_set():
                    break
                try:
                    self.heartbeat()
                except Exception:
                    # 租约失守：worker 即将退出，标记结束即可
                    try:
                        self._hb_stop.set()
                    except Exception:
                        pass
                    return

        self._hb_thread = threading.Thread(target=_loop, name="ai-hb-" + self.session_id[:12],
                                           daemon=self._hb_daemon)
        self._hb_thread.start()

    def stop_heartbeat_thread(self) -> None:
        self._hb_stop.set()
        if self._hb_thread and self._hb_thread.is_alive():
            try:
                self._hb_thread.join(timeout=2.0)
            except Exception:
                pass
        self._hb_thread = None

    def assert_lease(self) -> None:
        """fencing 校验：active_run_id + lease_epoch + 租约未过期（§5.5）。"""
        data = self._refresh()
        if data.get("active_run_id") != self._my_run_id:
            raise LeaseError("fencing: active_run_id 不匹配")
        if int(data.get("lease_epoch") or 0) != self._my_epoch:
            raise LeaseError("fencing: lease_epoch 不匹配")
        if float(data.get("lease_expires_at") or 0) < _now():
            raise LeaseError("fencing: 租约已过期")

    def is_cancelled(self) -> bool:
        """查 cancel_requested（§5.4）。"""
        data = self._refresh()
        return bool(data.get("cancel_requested"))

    def mark_cancelled(self) -> None:
        """显式取消（/cancel 端点）。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            data["cancel_requested"] = True
            data["updated_at"] = _now()
            self._save()

    def acquire_lease_for_side_effect(self) -> "_SessionLock":
        """持 session.lock 校验 fencing 后返回锁对象（副作用前调用，§5.5 v4.1）。

        调用方随后必须在同一临界区内完成 effect_key 幂等检查 + share_store 写入。
        锁序固定：session.lock → share_store lock（不得反向）。
        """
        lock = _SessionLock(self.session_id)
        lock.acquire()
        try:
            data = self._refresh()
            if data.get("active_run_id") != self._my_run_id:
                raise LeaseError("fencing: active_run_id 不匹配")
            if int(data.get("lease_epoch") or 0) != self._my_epoch:
                raise LeaseError("fencing: lease_epoch 不匹配")
            if float(data.get("lease_expires_at") or 0) < _now():
                raise LeaseError("fencing: 租约已过期")
        except Exception:
            lock.release()
            raise
        return lock

    # ------------------------------------------------------------------ #
    # WAL pending_bundle（§5.4）
    # ------------------------------------------------------------------ #
    def begin_bundle(self, assistant_msg: dict) -> List[dict]:
        """开 WAL pending_bundle，分配 bundle_seq + 各 tool_call 的 effect_key。

        assistant_msg 需含 tool_calls。返回按原顺序补齐 effect_key 后的
        tool_calls 列表（副本，不会污染 canonical_messages 里的原消息）。
        """
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            tcs = list(assistant_msg.get("tool_calls") or [])
            seq = int(data.get("bundle_seq") or 0) + 1
            data["bundle_seq"] = seq
            entries = []
            for tc in tcs:
                fn = tc.get("function") or {}
                name = fn.get("name") or ""
                effect_key = "{}:{}:{}".format(self.session_id, seq, tc.get("id") or "")
                entries.append({
                    "tool_call_id": tc.get("id") or "",
                    "name": name,
                    "args": _safe_json_load(fn.get("arguments") or "{}"),
                    "effect_key": effect_key,
                    "status": "pending",
                })
            data["pending_bundle"] = {
                "assistant_msg": assistant_msg,
                "tool_calls": entries,
                "started_at": _now(),
            }
            data["updated_at"] = _now()
            self._save()
        return [dict(e) for e in entries]

    def _assert_lease_in_lock(self, data: dict) -> None:
        if data.get("active_run_id") != self._my_run_id:
            raise LeaseError("fencing: active_run_id 不匹配")
        if int(data.get("lease_epoch") or 0) != self._my_epoch:
            raise LeaseError("fencing: lease_epoch 不匹配")
        if float(data.get("lease_expires_at") or 0) < _now():
            raise LeaseError("fencing: 租约已过期")

    def _pending_tool_entries(self) -> List[dict]:
        data = self._refresh()
        pb = data.get("pending_bundle") or {}
        return list(pb.get("tool_calls") or [])

    def record_tool_result(self, tool_call_id: str, result) -> None:
        """副作用后回填 tool result（含"用户已取消"/finish 的 result，§5.4 v4）。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            pb = data.get("pending_bundle")
            if not pb:
                return
            for e in pb.get("tool_calls") or []:
                if e.get("tool_call_id") == tool_call_id:
                    e["result"] = result
                    e["status"] = "done"
                    break
            data["updated_at"] = _now()
            self._save()

    def commit_bundle(self) -> List[dict]:
        """完整 bundle 提交进 canonical_messages，清 pending_bundle。

        返回本次提交的消息列表（assistant + 各 tool result，canonical 形态），
        供 run_agent 同步上下文。tool result 含图（dict 含 image_base64）的
        在此统一 canonical 化为 image_ref（§3.3）。
        """
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            pb = data.get("pending_bundle")
            if not pb:
                return []
            msgs = data.setdefault("canonical_messages", [])
            # assistant 消息（canonical 化：去掉内联 base64，改 image_ref）
            am = pb.get("assistant_msg") or {}
            committed = [_canonicalize_message(am)]
            msgs.append(committed[0])
            entries = pb.get("tool_calls") or []
            # 每个 tool_call 都要有 result：已执行的用记录值；
            # 未执行的（用户取消/崩溃恢复）写"用户已取消"结果（§5.4 v4）
            for e in entries:
                if e.get("result") is None:
                    tm = {
                        "role": "tool",
                        "tool_call_id": e.get("tool_call_id"),
                        "name": e.get("name"),
                        "content": "用户已取消，该工具未执行。",
                    }
                else:
                    tm = {
                        "role": "tool",
                        "tool_call_id": e.get("tool_call_id"),
                        "name": e.get("name"),
                        "content": _canonical_tool_content(e.get("result")),
                    }
                msgs.append(tm)
                committed.append(tm)
            data["pending_bundle"] = None
            data["updated_at"] = _now()
            self._save()
            return committed

    def append_message(self, msg: dict) -> None:
        """追加一条消息到 canonical_messages（纯文本回答/守卫提示等）。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data.setdefault("canonical_messages", []).append(_canonicalize_message(msg))
            data["updated_at"] = _now()
            self._save()

    # 别名（文档接口命名）
    def commit_bundle_and_checkpoint(self) -> None:
        self.commit_bundle()

    # ------------------------------------------------------------------ #
    # 事件（§5.6）
    # ------------------------------------------------------------------ #
    def emit_event(self, event_type: str, payload: dict) -> None:
        """单调 seq，append .events.jsonl + 推送给所有活跃 fanout（SSE）。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            ev = {"type": event_type, "payload": payload, "ts": _now()}
            append_event(self.session_id, ev, data)
            data["updated_at"] = _now()
            self._save()
        # 锁外推送（不阻塞事件落盘）
        with self._fanout_lock:
            fans = list(self._fanouts)
        for fan in fans:
            try:
                fan.put(ev)
            except Exception:
                pass

    def attach_fanout(self, fanout: "EventFanout") -> None:
        with self._fanout_lock:
            self._fanouts.append(fanout)

    def detach_fanout(self, fanout: "EventFanout") -> None:
        with self._fanout_lock:
            if fanout in self._fanouts:
                self._fanouts.remove(fanout)

    # ------------------------------------------------------------------ #
    # materialize / compact（§3.3、§3.5、§3.4）
    # ------------------------------------------------------------------ #
    def materialize_request_messages(self) -> List[dict]:
        """canonical → request：把未 compact 丢弃的 image_ref 物化为 image_url。

        需要 slide 上下文（region 取图 + slide fingerprint），通过
        `set_materializer(materializer_fn)` 注入。物化失败按 §3.3 降级文本。
        """
        data = self._refresh()
        msgs = data.get("canonical_messages") or []
        compacted_upto = int(data.get("compacted_upto") or 0)
        out = []
        for i, m in enumerate(msgs):
            if i < compacted_upto:
                out.append(dict(m))  # 已进摘要，image_ref 不再物化
                continue
            out.append(self._materialize_one(m))
        return out

    def _materialize_one(self, msg: dict) -> dict:
        content = msg.get("content")
        if not isinstance(content, list):
            return dict(msg)
        new_content = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "image_ref":
                new_content.append(self._materialize_image_ref(part))
            else:
                new_content.append(part)
        m = dict(msg)
        m["content"] = new_content
        return m

    def _materialize_image_ref(self, ref: dict) -> dict:
        mz = getattr(self, "_materializer", None)
        if mz is None:
            return {"type": "text", "text": "该图因上下文压缩已不可用。"}
        try:
            return mz(ref)
        except Exception:
            return {"type": "text", "text": "该图因切片变更不可用。"}

    def set_materializer(self, fn: Callable[[dict], dict]) -> None:
        """注入 image_ref → image_url 的物化回调（由 app.py 提供）。"""
        self._materializer = fn

    def estimate_input_tokens(self) -> int:
        """估计 request messages 的输入 token（§3.5 v3：优先 usage 校准）。

        usage 存在时按 1 token/char 折算文本；图按固定档估算。
        """
        data = self._refresh()
        usage = data.get("last_usage") or {}
        if usage and (usage.get("prompt_tokens") or 0) > 0:
            return int(usage["prompt_tokens"])
        total = 0
        for m in self.materialize_request_messages():
            content = m.get("content")
            if isinstance(content, str):
                total += int(len(content) * 1.3)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        if part.get("type") == "image_url":
                            total += 720
                        elif part.get("text"):
                            total += int(len(part["text"]) * 1.3)
        return max(1, total)

    def set_last_usage(self, usage: Optional[dict]) -> None:
        """记录最近一次模型响应的 usage（compact 触发判断用）。"""
        if not usage:
            return
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data["last_usage"] = {"prompt_tokens": usage.get("prompt_tokens") or 0}
            data["updated_at"] = _now()
            self._save()

    def maybe_compact(self) -> bool:
        """§3.5 触发判断：estimated_input + reserve >= window - safety_margin。

        触发则执行 compact（按完整 bundle 切 keep_recent_tokens），发
        session_compacted 事件。返回是否发生 compact。
        """
        data = self._refresh()
        est = self.estimate_input_tokens()
        window = int(self.cfg.get("context_window_tokens") or 272000)
        reserve = int(self.cfg.get("reserve_tokens") or 16000)
        margin = int(self.cfg.get("safety_margin") or 8192)
        if est + reserve < window - margin:
            return False
        tokens_before = est
        self._compact_now()
        tokens_after = self.estimate_input_tokens()
        self.emit_event("session_compacted", {
            "tokens_before": tokens_before, "tokens_after": tokens_after,
        })
        return True

    def _compact_now(self) -> None:
        """执行 compact：增量摘要 + 按完整 bundle 切 keep_recent_tokens。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            msgs = data.get("canonical_messages") or []
            keep_tokens = int(self.cfg.get("keep_recent_tokens") or 20000)
            # 找到保持尾部 keep_tokens 的起始 message 下标（按完整 bundle 切）
            cutoff = _find_cutoff_by_bundle(msgs, keep_tokens)
            # 生成增量摘要（只摘要被压掉的部分）
            dropped = msgs[:cutoff]
            summary = _summarize_dropped(data, dropped)
            old_summary = data.get("summary")
            if old_summary:
                summary = old_summary + "\n" + summary
            data["summary"] = summary
            data["canonical_messages"] = msgs[cutoff:]
            data["compacted_upto"] = 0  # 压掉后的消息都未进摘要
            data["updated_at"] = _now()
            self._save()
        # compact 后注入标注库 spot 索引（§8.4：全量文本 spot 卡）
        self._inject_spot_index()

    def _inject_spot_index(self) -> None:
        """compact 后注入一次完整 canonical spot 索引（全量文本、无图，§8.4）。"""
        import share_store
        data = self._refresh()
        slide = data.get("slide")
        rois = share_store.list_changes(slide, -1)  # 全部（含 tombstone？不：索引用可见的）
        # 注：列表索引只注入可见 spot（tombstone 已被过滤），语义为"当前标注库快照"
        visible = [r for r in rois if not r.get("deleted")]
        if not visible:
            return
        lines = ["当前切片标注库快照："]
        for r in visible:
            lines.append("- 位置 level-0 ({x},{y}) 边长 {s}px：{note}（revision {rv}, change_seq {cs}）".format(
                x=r.get("x", 0), y=r.get("y", 0), s=r.get("side_px", 0),
                note=r.get("note", ""), rv=r.get("revision", 1), cs=r.get("change_seq", 0)))
        spot_msg = {
            "role": "user",
            "content": "\n".join(lines),
        }
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data.setdefault("canonical_messages", []).append(spot_msg)
            data["spot_cursor"] = share_store.current_change_seq(slide)
            data["updated_at"] = _now()
            self._save()

    def inject_spot_changes(self) -> List[dict]:
        """每次 run/continue/ask：只追加 change_seq > spot_cursor 的变更（§8.4）。

        返回本次追加的消息列表（供 fresh 初始消息拼装用）。
        """
        import share_store
        data = self._refresh()
        slide = data.get("slide")
        cursor = int(data.get("spot_cursor") or 0)
        changes = share_store.list_changes(slide, cursor)
        if not changes:
            return []
        msgs = []
        for r in changes:
            if r.get("deleted"):
                msgs.append({"role": "user", "content":
                             "spot_deleted：标注 ({}) 已被删除。".format(
                                 r.get("annotation_id") or ""),
                             "spot_deleted": r.get("annotation_id")})
            else:
                msgs.append({"role": "user", "content":
                             "spot_updated：位置 level-0 ({x},{y}) 边长 {s}px，"
                             "判读：「{note}」（revision {rv}, change_seq {cs}）。".format(
                                 x=r.get("x", 0), y=r.get("y", 0), s=r.get("side_px", 0),
                                 note=r.get("note", ""), rv=r.get("revision", 1),
                                 cs=r.get("change_seq", 0)),
                             "spot_updated": r.get("annotation_id")})
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data.setdefault("canonical_messages", []).extend(msgs)
            data["spot_cursor"] = share_store.current_change_seq(slide)
            data["updated_at"] = _now()
            self._save()
        return msgs

    # ------------------------------------------------------------------ #
    # snapshot 守卫（§7.2）
    # ------------------------------------------------------------------ #
    def snapshot_state(self) -> dict:
        data = self._refresh()
        return data.get("pending_snapshot_review") or {}

    def set_pending_snapshot(self, snapshot_id: str, bbox: dict, image_ref: dict) -> None:
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data["pending_snapshot_review"] = {
                "snapshot_id": snapshot_id,
                "bbox": bbox,
                "image_ref": image_ref,
            }
            data["updated_at"] = _now()
            self._save()

    def complete_snapshot_review(self, snapshot_id: str) -> bool:
        """关闭 pending_snapshot_review；snapshot_id 不匹配返回 False。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            pending = data.get("pending_snapshot_review") or {}
            if pending.get("snapshot_id") != snapshot_id:
                return False
            data["pending_snapshot_review"] = None
            data["updated_at"] = _now()
            self._save()
        return True

    def is_snapshot_pending(self) -> bool:
        return bool((self._refresh().get("pending_snapshot_review") or {}).get("snapshot_id"))

    def snapshot_id(self) -> Optional[str]:
        return (self._refresh().get("pending_snapshot_review") or {}).get("snapshot_id")

    def add_observation(self, obs: dict) -> None:
        """mark_observation 持久化到 session.observations（§7.2）。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data.setdefault("observations", []).append(obs)
            data["updated_at"] = _now()
            self._save()

    # ------------------------------------------------------------------ #
    # 状态迁移 / 收尾
    # ------------------------------------------------------------------ #
    def set_agent_state(self, agent_state: dict) -> None:
        """持久化当前视口（§4.1），continue 从上次位置接着看。"""
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            st = data.get("agent_state") or {}
            for k in ("center_x", "center_y", "pyramid_level", "viewport_px"):
                if k in agent_state and agent_state[k] is not None:
                    st[k] = agent_state[k]
            data["updated_at"] = _now()
            self._save()

    def transition(self, status: str) -> None:
        with _SessionLock(self.session_id):
            data = self._refresh()
            self._assert_lease_in_lock(data)
            data["status"] = status
            data["cancel_requested"] = False
            data["active_run_id"] = None
            data["lease_expires_at"] = 0.0
            data["heartbeat_at"] = 0.0
            data["updated_at"] = _now()
            data["last_accessed_at"] = _now()
            self._save()

    def touch(self) -> None:
        with _SessionLock(self.session_id):
            data = self._refresh()
            data["last_accessed_at"] = _now()
            data["updated_at"] = _now()
            self._save()

    def pause(self) -> None:
        self.transition("paused")

    def mark_finished(self) -> None:
        self.transition("finished")

    def mark_error(self) -> None:
        self.transition("error")

    def mark_paused(self) -> None:
        self.transition("paused")

    def finalize(self) -> None:
        """收尾：停心跳线程 + 关闭 fanout。"""
        self.stop_heartbeat_thread()
        with self._fanout_lock:
            fans = list(self._fanouts)
            self._fanouts = []
        for fan in fans:
            try:
                fan.close()
            except Exception:
                pass

    def get_data(self) -> dict:
        return self._refresh()

    def read(self) -> dict:
        return self.get_data()

    # ------------------------------------------------------------------ #
    # slide 上下文（app.py 注入；run_agent 不直接碰文件/锁）
    # ------------------------------------------------------------------ #
    def set_slide_ctx(self, ctx: dict) -> None:
        """注入 slide 上下文：{config, info, region, fingerprint}。"""
        self._slide_ctx = ctx

    def get_slide_ctx(self) -> dict:
        return getattr(self, "_slide_ctx", None) or {}

    def create_annotation_effect(self, effect_key: str, label: str, x: float, y: float,
                                 side_px: int, note: str) -> dict:
        """落标注副作用（§5.4/§5.5 v4.1 原子耦合）。

        fencing 校验（active_run_id + lease_epoch + 未过期）与 effect_key 幂等
        检查 + ROI 写入在同一临界区：持 session.lock → 校验 → 取 share_store
        锁 → 幂等/写入 → 释放。锁序固定 session.lock → share_store lock。
        """
        import share_store
        with self.acquire_lease_for_side_effect():
            slide = self._refresh().get("slide")
            return share_store.add_roi(
                share_store.ADMIN_TOKEN, slide, label, type="rect", note=note,
                x=float(x), y=float(y), side_px=int(side_px),
                source="ai", created_by_session_id=self.session_id,
                _effect_key=effect_key,
            )


# --------------------------------------------------------------------------- #
# canonical / request 消息转换辅助
# --------------------------------------------------------------------------- #
def _canonical_tool_content(result) -> Any:
    """tool result 规范化：str 直接用；含 image_base64 的 dict 转 image_ref。"""
    if isinstance(result, dict) and result.get("image_base64"):
        text = result.get("text") or "（快照）"
        ref = {
            "type": "image_ref",
            "ref_id": "ref_" + uuid.uuid4().hex[:12],
            "slide_fingerprint": result.get("slide_fingerprint") or "",
            "src": result.get("src"),
            "magnification": result.get("magnification"),
            "summary": _image_ref_summary("data:image"),
        }
        return [
            {"type": "text", "text": text},
            ref,
        ]
    if isinstance(result, dict):
        return json.dumps(result, ensure_ascii=False)
    return str(result)


def _canonicalize_message(msg: dict) -> dict:
    """把含 image_url(data:base64) 的消息转 canonical（image_ref 占位）。

    tool 消息里的图在 bundle 提交时替换为 image_ref（引用 + 摘要），
    由 materializer 在发模型前物化。这里保存 text 部分与引用元数据。
    """
    m = dict(msg)
    content = msg.get("content")
    if not isinstance(content, list):
        return m
    new_content = []
    for part in content:
        if isinstance(part, dict) and part.get("type") == "image_url":
            url = ((part.get("image_url") or {}).get("url")) or ""
            ref = {
                "type": "image_ref",
                "ref_id": "ref_" + uuid.uuid4().hex[:12],
                "url": url,
                "summary": _image_ref_summary(url),
            }
            new_content.append(ref)
        else:
            new_content.append(part)
    m["content"] = new_content
    return m


def _image_ref_summary(url: str) -> str:
    """图片摘要：一两句该图所示（§3.3 image_ref 防伪带摘要）。"""
    if url.startswith("data:image/"):
        return "(本次会话内抓取的快照)"
    return "(图像引用)"


def _summarize_dropped(data: dict, dropped: List[dict]) -> str:
    """增量摘要：坐标+镜下所见（来自 observations）+已标注区域清单。

    注意：不调用 self._refresh()（避免在锁内替换 self._data 使外层
    data 引用悬空），改为显式传入 data。
    """
    lines = []
    for obs in data.get("observations") or []:
        bbox = obs.get("bbox") or {}
        note = obs.get("note") or ""
        lines.append("观察：bbox=({x},{y},{w},{h}) {note}".format(
            x=bbox.get("x", 0), y=bbox.get("y", 0), w=bbox.get("w", 0),
            h=bbox.get("h", 0), note=note))
    # 从 dropped 里抽 goto 与 create_annotation 的坐标信息
    for m in dropped:
        role = m.get("role")
        if role == "assistant":
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                name = fn.get("name") or ""
                if name == "goto":
                    args = _safe_json_load(fn.get("arguments") or "{}")
                    lines.append("已看区域：goto ({x},{y}) level={l}".format(
                        x=args.get("x", 0), y=args.get("y", 0), l=args.get("level", 0)))
        elif role == "tool" and m.get("name") == "create_annotation":
            txt = (m.get("content") or "")
            lines.append("已标注：" + str(txt))
    return "\n".join(lines) if lines else "(无关键内容)"


def _find_cutoff_by_bundle(msgs: List[dict], keep_tokens: int) -> int:
    """按完整 tool-call bundle 切 keep_recent_tokens：返回 cutoff 下标。

    bundle = 一条 assistant（含 tool_calls）+ 其全部 role=tool 结果。
    从尾部向前累计 token，找到首个「整个 bundle 都在 keep 范围内」的位置；
    任何情况下都至少保留第一条（system）。
    """
    if not msgs:
        return 0
    # 预估每条消息的 token
    def _tok(m):
        c = m.get("content")
        if isinstance(c, str):
            return max(1, int(len(c) * 1.3))
        if isinstance(c, list):
            t = 0
            for p in c:
                if isinstance(p, dict):
                    if p.get("type") == "image_ref":
                        t += 400
                    elif p.get("text"):
                        t += max(1, int(len(p["text"]) * 1.3))
            return max(1, t)
        return 8

    n = len(msgs)
    acc = 0
    # 从尾部向前走，跳过 tool 消息（它们属于前一条 assistant 的 bundle）
    i = n - 1
    while i >= 0:
        if msgs[i].get("role") == "tool":
            i -= 1
            continue
        # assistant 消息：其 bundle 含后续连续的 tool 消息
        j = i
        while j + 1 < n and msgs[j + 1].get("role") == "tool":
            j += 1
        bundle_tok = sum(_tok(msgs[k]) for k in range(i, j + 1))
        if acc + bundle_tok > keep_tokens:
            # 这个 bundle 放不下 → cutoff 在它之前（但必须保留 system）
            return max(1, i)
        acc += bundle_tok
        i -= 1
    return 0


def _safe_json_load(s: str) -> Any:
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s) if s else {}
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
