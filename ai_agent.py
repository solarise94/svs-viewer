# -*- coding: utf-8 -*-
"""AI 读片助手后端核心（纯逻辑，不依赖 Flask）。

借鉴 VirtualMicroscope 的四件纯逻辑：状态机 / 提示词 / 图像预算 / 轨迹事件，
但放宽它的过度设计（不做渐进 zoom、不做 ±2 clamp、手写 tool-call 循环）。

设计要点（对应 docs/ai-session-architecture.md）：
- ``AgentState`` 只描述"当前视口在 level-0 的哪里、放大多少"，不持有图像。
- ``TOOLS`` 是 OpenAI function-calling 的 schema：goto/snapshot/mark_observation/
  create_annotation/complete_snapshot_review/finish（fork 无 create_annotation）。
- ``run_agent(initial_messages, initial_state, runner)`` 只负责生成模型动作：
  - 副作用（落标注/读图）与持久化全走 ``SessionRunner``（WAL/fencing/事件/compact）；
  - snapshot 守卫（§7.2）：snapshot 后必须 create_annotation / mark_observation /
    complete_snapshot_review 消化，才能 goto / 新 snapshot / finish；
  - 到 ``max_steps`` 发 ``agent_paused{can_continue:true}``（可继续，不清空）；
  - 用户取消时未开始的工具写"用户已取消"result（§5.4）。
- 不再用 ImageBudget 滚动丢图：阈值内全留图，compact 时整体压（§3.2）。
"""

from __future__ import annotations

import json
import math
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

import ai_protocol


# =========================================================================== #
# AgentState：当前视口状态（level-0 坐标 + 放大信息）
# =========================================================================== #
class AgentState:
    """虚拟显微镜的当前视口状态。

    centerX/centerY 是 level-0 像素中心；viewportPx 是输出图像的边长（像素）；
    pyramidLevel 是金字塔层级（0 为最高倍）；mpp 是 µm/px（None 表示未知）。
    """

    def __init__(self, centerX: float, centerY: float, viewportPx: int,
                 pyramidLevel: int, mpp: Optional[float] = None):
        self.centerX = float(centerX)
        self.centerY = float(centerY)
        self.viewportPx = int(viewportPx)
        self.pyramidLevel = int(pyramidLevel)
        self.mpp = mpp  # None 表示无 mpp

    def viewport_bbox(self, level_downsamples: Tuple[float, ...]) -> Dict[str, int]:
        """返回当前视口覆盖的 level-0 区域 {x,y,w,h}。

        viewport 输出像素数固定（viewportPx），但覆盖的 level-0 范围随
        pyramidLevel 缩放：ds = level_downsamples[level]，覆盖边长 =
        viewportPx * ds。中心对齐到 centerX/centerY。
        """
        if not level_downsamples:
            ds = 1.0
        else:
            lvl = max(0, min(self.pyramidLevel, len(level_downsamples) - 1))
            ds = float(level_downsamples[lvl]) or 1.0
        side = max(1, self.viewportPx * ds)
        x = self.centerX - side / 2.0
        y = self.centerY - side / 2.0
        return {"x": int(round(x)), "y": int(round(y)),
                "w": int(round(side)), "h": int(round(side))}

    def magnification_label(self, level_downsamples: Tuple[float, ...]) -> str:
        """返回放大倍率描述，如 "20x (high power)" 或 "4x downsample"。

        base = 10/mpp（物镜等效倍率：病理切片约定 mpp(µm/px) = 10/objective，
        故 objective = 10/mpp；与 _read_metadata 的估算公式一致）；
        实际倍率 = base / ds。无 mpp 时用 "Nx downsample" 表达。
        """
        if not level_downsamples:
            ds = 1.0
        else:
            lvl = max(0, min(self.pyramidLevel, len(level_downsamples) - 1))
            ds = float(level_downsamples[lvl]) or 1.0
        if self.mpp and self.mpp > 0:
            base = 10.0 / self.mpp
            mag = base / ds if ds > 0 else base
            tier = _mag_tier(mag)
            return "{:.0f}x ({})".format(mag, tier)
        return "{:.1f}x downsample".format(ds)

    @staticmethod
    def pick_overview_level(width: int, height: int,
                            level_downsamples: Tuple[float, ...],
                            viewport_px: int) -> int:
        """选能看全片的最低倍层（ds 最小、且 viewportPx*ds 仍覆盖整片）。

        从 level 0（最高倍、ds 最小）往高找，第一个满足 viewportPx*ds >= max(w,h)
        的即返回——这是"恰好能看全片"的最高倍层，提供最紧凑的概览。
        都不满足则返回最高层（最大 ds，至少能看到尽量大的范围）。
        """
        if not level_downsamples:
            return 0
        need = float(max(width, height))
        # 从小到大（低 level → 高 level，ds 递增）找第一个覆盖整片的
        for lvl in range(len(level_downsamples)):
            ds = float(level_downsamples[lvl]) or 1.0
            if viewport_px * ds >= need:
                return lvl
        return len(level_downsamples) - 1

    def to_dict(self) -> Dict[str, Any]:
        return {
            "center_x": self.centerX,
            "center_y": self.centerY,
            "pyramid_level": self.pyramidLevel,
            "viewport_px": self.viewportPx,
        }

    @staticmethod
    def from_dict(d: Optional[dict], mpp: Optional[float] = None) -> "AgentState":
        d = d or {}
        return AgentState(
            float(d.get("center_x") or 0),
            float(d.get("center_y") or 0),
            int(d.get("viewport_px") or 1024),
            int(d.get("pyramid_level") or 0),
            mpp,
        )


def _mag_tier(mag: float) -> str:
    """物镜倍率分档描述。"""
    if mag >= 30:
        return "high power"
    if mag >= 15:
        return "medium power"
    if mag >= 5:
        return "low power"
    return "overview"


# =========================================================================== #
# TOOLS：OpenAI function-calling schema
# =========================================================================== #
def _goto_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "goto",
            "description": "把虚拟显微镜移到指定 level-0 坐标与金字塔层级。"
                           "直接跳转，不做渐进 zoom。reason 简述为何看这里。",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "number", "description": "level-0 像素 X（中心）"},
                    "y": {"type": "number", "description": "level-0 像素 Y（中心）"},
                    "level": {"type": "integer",
                              "description": "金字塔层级（0 最高倍，越大越低倍）"},
                    "reason": {"type": "string", "description": "为何移动到此处的简短理由"},
                },
                "required": ["x", "y", "level"],
            },
        },
    }


def _snapshot_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "snapshot",
            "description": "在当前位置抓取一张快照（输出图像尺寸 out_w × out_h 像素）。"
                           "图像会作为 image content 回喂给你。看清细节时调用。"
                           "每次快照后必须消化：create_annotation / mark_observation / "
                           "complete_snapshot_review 后才能移动或结束。",
            "parameters": {
                "type": "object",
                "properties": {
                    "out_w": {"type": "integer", "description": "输出宽度像素（建议 ≤1568）"},
                    "out_h": {"type": "integer", "description": "输出高度像素（建议 ≤1568）"},
                },
                "required": [],
            },
        },
    }


def _mark_observation_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "mark_observation",
            "description": "记录一条结构化观察（写入轨迹，不在切片上落标记）。"
                           "用于对当前快照判读后的记录：含 bbox、镜下所见、"
                           "以及'不需标注的理由'。必须引用当前待消化的 snapshot_id。",
            "parameters": {
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string", "description": "当前 pending 快照的 id"},
                    "x": {"type": "number", "description": "观察区域 level-0 X（左上）"},
                    "y": {"type": "number", "description": "观察区域 level-0 Y（左上）"},
                    "w": {"type": "number", "description": "观察区域宽度"},
                    "h": {"type": "number", "description": "观察区域高度"},
                    "label": {"type": "string", "description": "简短标题"},
                    "note": {"type": "string", "description": "镜下所见描述"},
                    "no_annotation_reason": {"type": "string",
                                             "description": "为何无需落标注（可空）"},
                },
                "required": ["snapshot_id", "label"],
            },
        },
    }


def _create_annotation_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "create_annotation",
            "description": "在切片上落一个矩形标注（写入标注库，管理员可见可编辑）。"
                           "看清需要关注的目标时调用，一次一个。坐标为 level-0 像素。"
                           "必须引用当前待消化的 snapshot_id（同一张图可补标多个）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string", "description": "当前 pending 快照的 id"},
                    "label": {"type": "string", "description": "标注标题/标签"},
                    "x": {"type": "number", "description": "矩形左上角 level-0 X"},
                    "y": {"type": "number", "description": "矩形左上角 level-0 Y"},
                    "side_px": {"type": "integer",
                                "description": "矩形边长（level-0 像素，1~40000）"},
                    "note": {"type": "string", "description": "备注：镜下所见与是否需关注"},
                },
                "required": ["snapshot_id", "label", "x", "y", "side_px"],
            },
        },
    }


def _complete_snapshot_review_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "complete_snapshot_review",
            "description": "显式关闭当前待消化的快照（§7.2）。"
                           "disposition=annotated：已对这张图完成标注（可已标多个）；"
                           "disposition=no_annotation：无需标注（必须给 no_annotation_reason）。"
                           "关闭后才能 goto / 抓新快照 / finish。",
            "parameters": {
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string", "description": "当前 pending 快照的 id"},
                    "disposition": {"type": "string",
                                    "enum": ["annotated", "no_annotation"]},
                    "summary": {"type": "string", "description": "对这张图的判读小结"},
                    "no_annotation_reason": {"type": "string",
                                             "description": "仅 disposition=no_annotation 时必填"},
                },
                "required": ["snapshot_id", "disposition", "summary"],
            },
        },
    }


def _finish_schema() -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": "finish",
            "description": "完成读片，给出总结。调用后 agent 结束循环。",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "整体读片总结（中文）"},
                },
                "required": ["summary"],
            },
        },
    }


def tools_for_kind(kind: str) -> List[Dict[str, Any]]:
    """按会话类型返回工具集：fork 不允许 create_annotation（§2.2）。"""
    tools = [_goto_schema(), _snapshot_schema(), _mark_observation_schema()]
    if kind != "fork":
        tools.append(_create_annotation_schema())
    tools.append(_complete_snapshot_review_schema())
    tools.append(_finish_schema())
    return tools


# =========================================================================== #
# SYSTEM_PROMPT（中文）
# =========================================================================== #
SYSTEM_PROMPT = """你是控制虚拟显微镜的病理专家助手。你通过调用工具在数字病理切片上\
移动视口、抓取快照、记录观察、落标注并给出总结。

工作方式：
- 所有坐标都是 level-0 像素（切片最高分辨率层的原始像素坐标）。
- 从低倍概览开始（用 goto 跳到能看全片的层级），先建立整体印象，不必渐进 zoom。
- 看清目标后立即用 create_annotation 落矩形标记，note 里写清镜下所见与是否需要关注。
- 多个目标逐个处理，一次一个标注。
- 阶段性发现可用 mark_observation 记录（不落标记，仅写入轨迹）。
- 全部完成后调用 finish 给出中文总结。

快照消化（强制流程）：
- 每次 snapshot 后、下一次 goto / 新 snapshot / finish 之前，必须消化当前快照：
  对需关注的区域调用 create_annotation（必须带当前 snapshot_id），
  然后调用 complete_snapshot_review(disposition="annotated") 关闭；
  若该区域无需标注，则调用 mark_observation + complete_snapshot_review(\
disposition="no_annotation", no_annotation_reason=...)。
- 同一张快照可以补标多个 create_annotation，之后一次性 complete_snapshot_review。

语境：
- 病理切片通常很大（万级像素），ROI 一般是 6mm 物理尺寸级别（约数千像素）。
- level 越大越低倍（看全片用大 level，看细胞细节用 0）。
"""


# =========================================================================== #
# 初始消息构建
# =========================================================================== #
def make_main_messages(slide_name: str, task: str, info: dict) -> List[Dict[str, Any]]:
    """fresh main 的初始 messages（system + 用户任务）。"""
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    level_downsamples = tuple(info.get("level_downsamples") or (1.0,))
    mpp = info.get("mpp")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": (
            "切片：{}（{}×{} 像素，mpp={}，金字塔 {} 层）。\n"
            "任务：{}".format(
                slide_name, width, height,
                "{:.4f}".format(mpp) if mpp else "未知",
                len(level_downsamples), task or "扫一遍这张片，标出可疑区域并总结"
            )
        )},
    ]


def make_fork_messages(slide_name: str, info: dict, spot: dict, question: str,
                       image_ref: dict, image_b64: Optional[str] = None) -> List[Dict[str, Any]]:
    """fork 的初始 messages（§2.2：自包含 spot 卡 + 附图 + 用户问题）。

    spot 为 ROI dict（含 annotation_id/source/revision/change_seq/note/几何）。
    image_ref 为 spot 现取快照的 canonical image_ref；image_b64 为首次发模型
    的物化内容（非 None 时直接内联，避免先落库再物化的取图成本）。
    """
    geom = spot
    x = int(geom.get("x") or 0)
    y = int(geom.get("y") or 0)
    side = int(geom.get("side_px") or 0)
    note = spot.get("note") or ""
    revision = spot.get("revision") or 1
    change_seq = spot.get("change_seq") or 0
    size_mm = spot.get("size_mm") or 0.0
    phys = ("，物理约 {:.1f} mm".format(size_mm)) if size_mm else ""
    spot_text = (
        "关于切片「{}」的一处已标注区域：\n"
        "位置 level-0 ({}, {}), 边长 {} 像素{}（change_seq {})\n"
        "你之前的判读：「{}」（revision {}, change_seq {}）\n"
        "用户的问题：{}".format(
            slide_name, x, y, side, phys, change_seq,
            note, revision, change_seq, question or "请谈谈这个区域"
        )
    )
    parts = [{"type": "text", "text": spot_text}]
    if image_b64:
        parts.append({"type": "image_url",
                      "image_url": {"url": "data:image/jpeg;base64,{}".format(image_b64)}})
    elif image_ref:
        parts.append(image_ref)
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": parts},
    ]


# =========================================================================== #
# run_agent：手写 tool-call while loop（走 SessionRunner）
# =========================================================================== #
def _is_context_exceeded(exc: Exception) -> bool:
    """判断模型调用异常是否"上下文超窗"（§3.6 重试兜底）。

    兼容 OpenAI 官方与兼容端点的不同措辞（大小写不敏感）：
    - HTTP 400 且响应体含 context_length_exceeded（OpenAI 官方 error.code）；
    - 异常消息含 context_length / maximum context / too many tokens /
      context window（部分端点把超窗描述放进 message）。
    """
    if isinstance(exc, requests.HTTPError):
        resp = exc.response
        if resp is not None and getattr(resp, "status_code", None) == 400:
            try:
                body = (resp.text or "")
            except Exception:
                body = ""
            if "context_length_exceeded" in body.lower():
                return True
    msg = str(exc).lower()
    for kw in ("context_length", "maximum context", "too many tokens", "context window"):
        if kw in msg:
            return True
    return False


def _is_transient_error(exc: Exception) -> bool:
    """判断模型调用异常是否"瞬时/可重试"（网络抖动、限流、网关临时错误）。

    这类错误（尤其第三方转发端点的偶发 SSL 断连/502/429）不应直接终止 run，
    有限退避重试即可恢复。与超窗（_is_context_exceeded，走 compact）互斥判断。
    """
    # 连接/超时/SSL 等传输层错误：典型偶发
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True
    # HTTP 状态码类：限流与网关临时错误可重试
    if isinstance(exc, requests.HTTPError):
        resp = exc.response
        code = getattr(resp, "status_code", None) if resp is not None else None
        if code in (408, 409, 425, 429, 500, 502, 503, 504):
            return True
        return False
    # 兜底：消息里出现 SSL/EOF/连接重置等传输特征
    msg = str(exc).lower()
    for kw in ("sslerror", "unexpected_eof", "eof while", "connection reset",
               "connection aborted", "broken pipe", "timed out", "max retries"):
        if kw in msg:
            return True
    return False


def run_agent(initial_messages: List[Dict[str, Any]],
              initial_state: "AgentState",
              runner: Any,
              max_steps: Optional[int] = None) -> None:
    """驱动 AI 读片助手循环（docs §5.1：只生成模型动作，持久化走 runner）。

    参数：
      initial_messages: 初始 request messages（system + user）。
      initial_state: 初始 AgentState（fresh 概览 或 continue 的持久化视口）。
      runner: SessionRunner（提供 slide 上下文 / config / WAL / 事件 / compact）。
      max_steps: 单轮步数上限（默认 runner.cfg.max_steps）。

    runner 需已注入 slide 上下文：runner.set_slide_ctx({config, info, region})。
    """
    max_steps = max_steps or int((runner.cfg or {}).get("max_steps") or 50)
    kind = runner.get_data().get("kind") or "main"
    ctx = getattr(runner, "get_slide_ctx", lambda: {})() or {}
    cfg = ctx.get("config") or {}
    base_url = (cfg.get("base_url") or "").rstrip("/")
    api_key = cfg.get("api_key") or ""
    model = cfg.get("model") or "gpt-4o"
    max_tokens = int(cfg.get("max_tokens") or 2048)
    api_protocol = str(cfg.get("api_protocol") or "openai").strip().lower()

    info = ctx.get("info") or {}
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    level_downsamples = tuple(info.get("level_downsamples") or (1.0,))
    mpp = info.get("mpp")

    try:
        if not base_url or not api_key:
            runner.emit_event("agent_error", {"error": "AI 未配置：请先在面板里填写 base_url 与 api_key"})
            runner.mark_error()
            return
        if width <= 0 or height <= 0:
            runner.emit_event("agent_error", {"error": "无法读取切片尺寸"})
            runner.mark_error()
            return

        st = initial_state
        # 初始 canonical 上下文（fresh 时 app 已把它写进 session？没有——fresh 的
        # initial_messages 由 app 传入；这里把 system+user 落库进 canonical，
        # 保证 continue 恢复时有完整 system 前缀。）
        try:
            data = runner.get_data()
            canon = data.get("canonical_messages") or []
            if not canon:
                for m in initial_messages:
                    runner.append_message(m)
        except Exception:
            pass

        # 模型调用按协议分流（openai / anthropic）由 ai_protocol.post_model 统一处理：
        # anthropic 在该层完成 messages/tools/image 转换与响应归一，run_agent 下游
        # 只认 OpenAI 形态的 choice/message/tool_calls（任务3：协议完整适配）。
        tools = tools_for_kind(kind)
        finished = False

        for step in range(max_steps):
            # 用户取消：不再发模型请求，未开始的 bundle 由 commit 补"用户已取消"
            if runner.is_cancelled():
                runner.emit_event("agent_paused", {"summary": "已停止", "can_continue": True})
                runner.pause()
                return

            runner.emit_event("agent_thinking", {"step": step})
            # 每轮前把当前视口持久化（continue 从上次位置接着看）
            runner.set_agent_state(st.to_dict())

            # 上下文 = canonical（含上轮已提交的 assistant + tool results）
            try:
                request_messages = runner.materialize_request_messages()
            except Exception as e:
                runner.emit_event("agent_error", {"error": "上下文物化失败：{}".format(e)})
                runner.mark_error()
                return

            # 超窗报错（HTTP 400 context_length_exceeded / 各端点措辞）→
            # 强制执行一次 compact 后重新物化并重试该次调用（§3.6 兜底）。
            # 瞬时错误（SSL 断连/超时/429/5xx）→ 有限退避重试（网络抖动，尤
            # 其第三方转发端点偶发，不应直接终止）。其余错误（4xx 鉴权/参数）终止。
            compact_retried = False
            transient_attempts = 0
            max_transient = 3  # 瞬时错误最多重试 3 次（退避 2s/4s/8s）
            while True:
                try:
                    # post_model 内部按 api_protocol 分流（openai/anthropic），
                    # anthropic 完成转换后归一回 OpenAI 形态，下游无感知。
                    data = ai_protocol.post_model(
                        base_url, api_key, model, max_tokens,
                        api_protocol, request_messages, tools, timeout=120)
                    break
                except Exception as e:
                    if not compact_retried and _is_context_exceeded(e):
                        compact_retried = True
                        # force_compact 会并发 session_compacted{reason} 事件，
                        # 前端据此显示"上下文已满，已压缩并继续"。
                        try:
                            runner.force_compact(reason="context_length_exceeded")
                            request_messages = runner.materialize_request_messages()
                        except Exception as ce:  # noqa: BLE001
                            # compact 本身失败（fencing 失守/异常）→ 按原错误终止
                            runner.emit_event("agent_error", {"error": "调用模型失败：{}".format(e),
                                                              "step": step})
                            runner.mark_error()
                            return
                        # 重试该次模型调用
                        continue
                    if _is_transient_error(e) and transient_attempts < max_transient:
                        transient_attempts += 1
                        delay = 2 ** transient_attempts  # 2/4/8s 退避
                        runner.emit_event("agent_retrying", {
                            "step": step, "attempt": transient_attempts,
                            "max": max_transient, "delay": delay,
                            "reason": "网络波动，{}s 后重试（{}/{}）".format(
                                delay, transient_attempts, max_transient),
                        })
                        time.sleep(delay)
                        continue
                    runner.emit_event("agent_error", {"error": "调用模型失败：{}".format(e),
                                                      "step": step})
                    runner.mark_error()
                    return

            # 记录 usage（compact 触发判断，§3.5）
            choice = (data.get("choices") or [{}])[0]
            usage = data.get("usage")
            if usage:
                runner.set_last_usage(usage)

            msg = choice.get("message") or {}
            content_text = msg.get("content")

            # 文本增量事件（仅在非纯文本结束时有意义）
            if isinstance(content_text, str) and content_text.strip():
                runner.emit_event("text_delta", {"text": content_text})

            tool_calls = msg.get("tool_calls") or []

            # 纯文本（无 tool_calls）
            if not tool_calls:
                if runner.is_snapshot_pending():
                    # pending review 期间不允许纯文本结束（§7.2）
                    runner.append_message({"role": "user",
                                           "content": "当前还有未消化的快照，请先调用 "
                                                       "complete_snapshot_review 关闭后再继续。"})
                    continue
                runner.emit_event("agent_finished", {"summary": content_text or "(无总结)"})
                runner.mark_finished()
                return

            # 有 tool_calls：先开 WAL，拿 effect_key
            entries = runner.begin_bundle(msg)
            pending_tc_ids = {e["tool_call_id"] for e in entries}

            # 逐个执行工具（同 bundle 内 finish 不中断其它 call，§5.4）
            for entry in entries:
                tc_id = entry["tool_call_id"]
                name = entry["name"]
                args = entry["args"] or {}
                if tc_id not in pending_tc_ids:
                    continue
                if runner.is_cancelled():
                    # 用户取消：不再执行（commit 时补"用户已取消"result）
                    continue
                result, done = _execute_tool(name, args, tc_id, st, level_downsamples,
                                             runner, kind, ctx)
                if done:  # finish
                    finished = True
                    runner.record_tool_result(tc_id, "已结束")
                    continue
                runner.record_tool_result(tc_id, result)

            # 提交完整 bundle 进 canonical（未执行的自动补"用户已取消"）
            runner.commit_bundle()

            if finished:
                runner.emit_event("agent_finished", {"summary": _finish_summary(msg)})
                runner.mark_finished()
                return

            # compact 触发判断（§3.5）
            try:
                runner.maybe_compact()
            except Exception:
                pass

        # 到 max_steps：暂停可继续，不清空
        if not finished:
            runner.emit_event("agent_paused", {"summary": "已达步数上限", "can_continue": True})
            runner.pause()
    except Exception as e:  # noqa: BLE001
        # 兜底：任何未捕获异常都发 agent_error，不让 SSE 流挂死
        try:
            runner.emit_event("agent_error", {"error": "读片助手异常：{}".format(e)})
        except Exception:
            pass
        try:
            runner.mark_error()
        except Exception:
            pass


def _finish_summary(msg: dict) -> str:
    """从当前 assistant 消息里取 finish 的 summary（没有则用文本）。"""
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        if fn.get("name") == "finish":
            try:
                args = json.loads(fn.get("arguments") or "{}")
                return args.get("summary") or "(无总结)"
            except Exception:
                return "(无总结)"
    text = msg.get("content")
    return text or "(无总结)"


def _execute_tool(name: str, args: dict, tc_id: str, st: "AgentState",
                  level_downsamples: Tuple[float, ...], runner: Any,
                  kind: str, ctx: dict) -> Tuple[Any, bool]:
    """执行单个工具，返回 (result, done)。done=True 表示 finish。

    result 为字符串或含 image_base64 的 dict（commit 时 canonical 化）。
    """
    if name == "finish":
        return "已结束", True

    if name == "goto":
        if runner.is_snapshot_pending():
            return ("需先消化当前快照：调用 complete_snapshot_review（或先 "
                    "create_annotation/mark_observation）后再移动。"), False
        gx = _to_num(args.get("x"))
        gy = _to_num(args.get("y"))
        glvl = int(args.get("level") or st.pyramidLevel)
        st.centerX, st.centerY = float(gx), float(gy)
        st.pyramidLevel = max(0, glvl)
        mag = st.magnification_label(level_downsamples)
        runner.emit_event("tool_started", {
            "tool": "goto", "x": st.centerX, "y": st.centerY,
            "level": st.pyramidLevel, "magnification": mag,
            "reason": args.get("reason") or "",
        })
        return ("已移动到 ({:.0f},{:.0f}) level={}，当前 {}。".format(
            st.centerX, st.centerY, st.pyramidLevel, mag)), False

    if name == "snapshot":
        if runner.is_snapshot_pending():
            return "需先消化当前快照后再抓新快照。", False
        ow = int(args.get("out_w") or st.viewportPx)
        oh = int(args.get("out_h") or st.viewportPx)
        ow = max(64, min(ow, 4096))
        oh = max(64, min(oh, 4096))
        bb = st.viewport_bbox(level_downsamples)
        region_fn = ctx.get("region")
        if not callable(region_fn):
            return "抓取快照失败：缺少 region 能力。", False
        try:
            r = region_fn(bb["x"], bb["y"], bb["w"], bb["h"], ow, oh)
        except Exception as e:
            return "抓取快照失败：{}".format(e), False
        img_b64 = r.get("image_base64") or ""
        src = r.get("src") or bb
        mag = r.get("magnification") or st.magnification_label(level_downsamples)
        runner.emit_event("snapshot_captured", {
            "bboxLevel0": src, "magnification": mag,
            "out_w": r.get("width"), "out_h": r.get("height"),
        })
        # 进入 pending snapshot 状态（§7.2）
        image_ref = {
            "type": "image_ref",
            "ref_id": "ref_" + tc_id,
            "slide_fingerprint": ctx.get("fingerprint") or "",
            "src": src,
            "magnification": mag,
        }
        runner.set_pending_snapshot(tc_id, src, image_ref)
        tool_text = ("快照区域 level-0 bbox={bx},{by},{bw},{bh}，放大 {mag}，"
                     "输出 {w}×{h} 像素。".format(
                         bx=src.get("x"), by=src.get("y"), bw=src.get("w"), bh=src.get("h"),
                         mag=mag, w=r.get("width"), h=r.get("height")))
        return {
            "text": tool_text,
            "image_base64": img_b64,
            "mime": r.get("mime") or "image/jpeg",
            "src": src,
            "magnification": mag,
            "width": r.get("width"), "height": r.get("height"),
            "snapshot_id": tc_id,
            "slide_fingerprint": ctx.get("fingerprint") or "",
        }, False

    if name == "mark_observation":
        pending = runner.snapshot_state()
        snap_id = pending.get("snapshot_id")
        if args.get("snapshot_id") != snap_id or not snap_id:
            return ("mark_observation 必须引用当前 pending 的 snapshot_id（当前：{}）。"
                    .format(snap_id or "无")), False
        label = args.get("label") or ""
        note = args.get("note") or ""
        x = _to_num(args.get("x"))
        y = _to_num(args.get("y"))
        w = _to_num(args.get("w"))
        h = _to_num(args.get("h"))
        obs = {
            "label": label,
            "note": note,
            "bbox": {"x": x, "y": y, "w": w, "h": h},
            "no_annotation_reason": args.get("no_annotation_reason") or "",
            "snapshot_id": snap_id,
            "ts": time.time(),
        }
        runner.add_observation(obs)
        # payload 带 label/note/no_annotation_reason/bbox：前端渲染成"观察卡"
        # （§7.2），不显示 snapshot_id 等内部 id。
        runner.emit_event("observation", {
            "label": label, "note": note,
            "no_annotation_reason": obs.get("no_annotation_reason") or "",
            "bbox": obs.get("bbox") or {},
        })
        return "已记录观察：{}".format(label), False

    if name == "create_annotation":
        if kind == "fork":
            return "fork 会话不允许 create_annotation（批注只做问答，不改标注库）。", False
        pending = runner.snapshot_state()
        snap_id = pending.get("snapshot_id")
        if args.get("snapshot_id") != snap_id or not snap_id:
            return ("create_annotation 必须引用当前 pending 的 snapshot_id（当前：{}）。"
                    .format(snap_id or "无")), False
        alabel = args.get("label") or "AI 建议"
        ax = _to_num(args.get("x"))
        ay = _to_num(args.get("y"))
        aside = int(args.get("side_px") or 0)
        anote = args.get("note") or ""
        aside = max(1, min(aside, 40000))
        # effect_key 由 WAL 分配；fencing + 幂等 + 落标在同一临界区（§5.4/§5.5）
        effect_key = _current_effect_key(runner, tc_id)
        roi = None
        try:
            roi = runner.create_annotation_effect(effect_key, alabel, ax, ay, aside, anote)
        except Exception as e:
            return "落标注失败：{}".format(e), False
        index = roi.get("index", -1) if roi else -1
        runner.emit_event("annotation_created", {
            "label": alabel, "x": ax, "y": ay,
            "side_px": aside, "note": anote, "index": index,
            "annotation_id": roi.get("annotation_id") if roi else None,
        })
        return ("已落标注「{}」于 ({:.0f},{:.0f}) 边长 {} 像素。".format(
            alabel, ax, ay, aside)), False

    if name == "complete_snapshot_review":
        pending = runner.snapshot_state()
        snap_id = pending.get("snapshot_id")
        if args.get("snapshot_id") != snap_id or not snap_id:
            return ("complete_snapshot_review 的 snapshot_id 与当前 pending（{}）不匹配。"
                    .format(snap_id or "无")), False
        disposition = args.get("disposition") or ""
        if disposition not in ("annotated", "no_annotation"):
            return "disposition 必须是 annotated 或 no_annotation。", False
        if disposition == "no_annotation" and not (args.get("no_annotation_reason") or "").strip():
            return "disposition=no_annotation 时必须提供 no_annotation_reason。", False
        runner.complete_snapshot_review(snap_id)
        runner.emit_event("snapshot_reviewed", {
            "snapshot_id": snap_id, "disposition": disposition,
            "summary": args.get("summary") or "",
        })
        return ("已关闭快照 {sid}（{disp}）。".format(sid=snap_id, disp=disposition)), False

    # 未知工具
    return "未知工具 {}".format(name), False


def _current_effect_key(runner: Any, tc_id: str) -> str:
    """从当前 pending_bundle 里查该 tool_call 的 effect_key。"""
    try:
        pb = runner.get_data().get("pending_bundle") or {}
        for e in pb.get("tool_calls") or []:
            if e.get("tool_call_id") == tc_id:
                return e.get("effect_key") or ""
    except Exception:
        pass
    return ""


def _to_num(v) -> float:
    """安全转 float，失败回 0。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0
