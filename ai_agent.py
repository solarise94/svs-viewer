# -*- coding: utf-8 -*-
"""AI 读片助手后端核心（纯逻辑，不依赖 Flask）。

借鉴 VirtualMicroscope 的四件纯逻辑：状态机 / 提示词 / 图像预算 / 轨迹事件，
但放宽它的过度设计（不做渐进 zoom、不做 ±2 clamp、手写 tool-call 循环）。

设计要点：
- ``AgentState`` 只描述"当前视口在 level-0 的哪里、放大多少"，不持有图像。
- ``TOOLS`` 是 OpenAI function-calling 的 schema，5 个工具够用即可。
- ``SYSTEM_PROMPT`` 中文，要求从低倍概览开始、看清就落标注、最后 finish。
- ``ImageBudget`` 滚动窗口：messages 里只保留最近 3 张 image content，
  更早的降级为 "[image omitted]"，省 token 又保上下文。
- ``run_agent`` 手写 while loop：每轮调用 OpenAI 兼容端点（requests），
  解析 tool_calls → 执行 → 把结果（含图）作为 role=tool 回喂。
  通过 ``emit(event_type, payload)`` 回调逐步发事件，由 app.py 转 SSE。

不直接 import Flask；``get_slide_ctx`` 由 app.py 注入，封装：
- region 裁剪（返回 base64 jpeg + 真实 bbox）
- add_roi（落标注）
- slide info（width/height/level_downsamples/mpp）
"""

from __future__ import annotations

import base64
import json
import math
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests


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
# TOOLS：OpenAI function-calling schema（5 个）
# =========================================================================== #
TOOLS: List[Dict[str, Any]] = [
    {
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
    },
    {
        "type": "function",
        "function": {
            "name": "snapshot",
            "description": "在当前位置抓取一张快照（输出图像尺寸 out_w × out_h 像素）。"
                           "图像会作为 image content 回喂给你。看清细节时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "out_w": {"type": "integer", "description": "输出宽度像素（建议 ≤1568）"},
                    "out_h": {"type": "integer", "description": "输出高度像素（建议 ≤1568）"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mark_observation",
            "description": "记录一条观察（仅写入轨迹，不在切片上落标记）。"
                           "用于阶段性小结，如「左上角见异型细胞簇」。",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "简短标题"},
                    "note": {"type": "string", "description": "详细描述（镜下所见）"},
                },
                "required": ["label"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_annotation",
            "description": "在切片上落一个矩形标注（写入标注库，管理员可见可编辑）。"
                           "看清需要关注的目标时调用，一次一个。坐标为 level-0 像素。",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "标注标题/标签"},
                    "x": {"type": "number", "description": "矩形左上角 level-0 X"},
                    "y": {"type": "number", "description": "矩形左上角 level-0 Y"},
                    "side_px": {"type": "integer",
                                "description": "矩形边长（level-0 像素，1~40000）"},
                    "note": {"type": "string", "description": "备注：镜下所见与是否需关注"},
                },
                "required": ["label", "x", "y", "side_px"],
            },
        },
    },
    {
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
    },
]


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

语境：
- 病理切片通常很大（万级像素），ROI 一般是 6mm 物理尺寸级别（约数千像素）。
- level 越大越低倍（看全片用大 level，看细胞细节用 0）。
- 抓取快照后图像会回喂给你；为省带宽，较早的快照会被替换为文本 [image omitted]，\
所以关键发现要及时用 create_annotation 落标注。
"""


# =========================================================================== #
# ImageBudget：滚动窗口，控制 messages 里 image content 数量
# =========================================================================== #
class ImageBudget:
    """管理 messages 里的 image content 数量。

    OpenAI vision 把 image 当 token 大头；只保留最近 ``keep`` 张 image content，
    更早的 image 降级为文本 "[image omitted]"，既省 token 又保留"看过"的上下文。
    """

    OMITTED_TEXT = "[image omitted]"

    def __init__(self, keep: int = 3):
        self.keep = int(keep) if keep and keep > 0 else 3

    def manage(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """对 messages 做原地+返回处理：保留最近 keep 张 image，其余降级文本。

        扫描全部消息的 content（list 形式），收集所有 image_url 的位置；
        超出 keep 的（按出现顺序靠前的）替换为 OMITTED_TEXT 文本块。
        """
        # 收集所有 image 出现位置（按消息顺序）
        img_positions: List[Tuple[int, int]] = []  # (msg_idx, content_idx)
        for mi, msg in enumerate(messages):
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for ci, part in enumerate(content):
                if isinstance(part, dict) and part.get("type") == "image_url":
                    img_positions.append((mi, ci))
        # 超出 keep 的降级（保留最后 keep 个）
        if len(img_positions) <= self.keep:
            return messages
        to_omit = img_positions[: len(img_positions) - self.keep]
        for (mi, ci) in to_omit:
            content = messages[mi]["content"]
            content[ci] = {"type": "text", "text": self.OMITTED_TEXT}
        return messages


# =========================================================================== #
# run_agent：手写 tool-call while loop
# =========================================================================== #
# emit 回调签名：emit(event_type:str, payload:dict) -> None（或 bool；返回 False 可中断）
EmitFn = Callable[[str, Dict[str, Any]], Any]
# get_slide_ctx 返回一个对象/字典，提供：
#   .info -> {width,height,level_downsamples,mpp}
#   .region(x,y,w,h,out_w,out_h) -> {image_base64, mime, width, height, src:{x,y,w,h}, magnification}
#   .add_annotation(label,x,y,side_px,note) -> {index, ...}
# 为简单起见用鸭子类型 dict 即可。
SlideCtxFn = Callable[[], Dict[str, Any]]


def _is_client_gone(emit_ret: Any) -> bool:
    """emit 回调返回 False（或 falsy）视为客户端已断开，应中断。"""
    return emit_ret is False


def run_agent(slide_name: str, task: str, emit: EmitFn,
              get_slide_ctx: SlideCtxFn, max_steps: int = 12) -> None:
    """驱动 AI 读片助手循环。

    参数：
      slide_name: 切片文件名（仅用于事件 payload）。
      task: 用户给的自然语言任务。
      emit: 事件回调，每步调用；返回 False 可中断（客户端断开）。
      get_slide_ctx: 返回 slide 上下文 dict，含 info/region/add_annotation。
      max_steps: 最多多少轮模型调用（防失控）。

    事件类型（emit 的第一个参数）：
      slide_opened / agent_thinking / text_delta / tool_started /
      snapshot_captured / observation / annotation_created /
      agent_finished / agent_error
    """
    try:
        ctx = get_slide_ctx()
        cfg = ctx.get("config") or {}
        base_url = (cfg.get("base_url") or "").rstrip("/")
        api_key = cfg.get("api_key") or ""
        model = cfg.get("model") or "gpt-4o"
        max_tokens = int(cfg.get("max_tokens") or 2048)

        info = ctx.get("info") or {}
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
        level_downsamples = tuple(info.get("level_downsamples") or (1.0,))
        mpp = info.get("mpp")

        if not base_url or not api_key:
            emit("agent_error", {"error": "AI 未配置：请先在面板里填写 base_url 与 api_key"})
            return
        if width <= 0 or height <= 0:
            emit("agent_error", {"error": "无法读取切片尺寸"})
            return

        # 初始状态：选概览层，居中
        vp = 1024
        overview_lvl = AgentState.pick_overview_level(width, height, level_downsamples, vp)
        st = AgentState(width / 2.0, height / 2.0, vp, overview_lvl, mpp)

        bbox = st.viewport_bbox(level_downsamples)
        emit("slide_opened", {
            "slide": slide_name,
            "width": width, "height": height,
            "overview_level": overview_lvl,
            "level_count": len(level_downsamples),
            "mpp": mpp,
            "viewport": bbox,
        })

        budget = ImageBudget(keep=3)

        # 组装初始 messages
        messages: List[Dict[str, Any]] = [
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

        url = base_url + "/chat/completions"
        headers = {
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        }
        finished = False

        for step in range(max_steps):
            if finished:
                break
            # 应用图像预算（降级旧图）
            budget.manage(messages)

            emit("agent_thinking", {"step": step})
            req_body = {
                "model": model,
                "messages": messages,
                "tools": TOOLS,
                "max_tokens": max_tokens,
            }
            try:
                resp = requests.post(url, headers=headers, json=req_body, timeout=120)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                emit("agent_error", {"error": "调用模型失败：{}".format(e),
                                      "step": step})
                return

            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}

            # 把 assistant 消息追加到历史（保留 tool_calls 结构）
            messages.append(dict(msg))

            # 文本增量
            content_text = msg.get("content")
            if isinstance(content_text, str) and content_text.strip():
                if _is_client_gone(emit("text_delta", {"text": content_text})):
                    return

            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                # 无 tool_calls 且没 finish：模型给了纯文本回答，视为结束
                emit("agent_finished", {"summary": content_text or "(无总结)"})
                return

            finish_reason = choice.get("finish_reason")
            for tc in tool_calls:
                tc_id = tc.get("id") or ""
                fn = (tc.get("function") or {})
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if raw_args else {}
                except Exception:
                    args = {}

                if name == "finish":
                    summary = args.get("summary") or "(无总结)"
                    emit("agent_finished", {"summary": summary})
                    finished = True
                    break

                # tool_started：goto 单独带 magnification
                if name == "goto":
                    gx = _to_num(args.get("x"))
                    gy = _to_num(args.get("y"))
                    glvl = int(args.get("level") or st.pyramidLevel)
                    st.centerX, st.centerY = float(gx), float(gy)
                    st.pyramidLevel = max(0, glvl)
                    mag = st.magnification_label(level_downsamples)
                    if _is_client_gone(emit("tool_started", {
                        "tool": "goto", "x": st.centerX, "y": st.centerY,
                        "level": st.pyramidLevel, "magnification": mag,
                        "reason": args.get("reason") or "",
                    })):
                        return
                    # goto 不需要回喂图像，给个简短 tool 结果
                    messages.append({
                        "role": "tool", "tool_call_id": tc_id, "name": "goto",
                        "content": "已移动到 ({:.0f},{:.0f}) level={}，当前 {}。".format(
                            st.centerX, st.centerY, st.pyramidLevel, mag),
                    })
                    continue

                if name == "snapshot":
                    ow = int(args.get("out_w") or st.viewportPx)
                    oh = int(args.get("out_h") or st.viewportPx)
                    ow = max(64, min(ow, 4096))
                    oh = max(64, min(oh, 4096))
                    bb = st.viewport_bbox(level_downsamples)
                    region_fn = ctx.get("region")
                    if not callable(region_fn):
                        continue
                    try:
                        r = region_fn(bb["x"], bb["y"], bb["w"], bb["h"], ow, oh)
                    except Exception as e:
                        messages.append({"role": "tool", "tool_call_id": tc_id,
                                         "name": "snapshot",
                                         "content": "抓取快照失败：{}".format(e)})
                        continue
                    img_b64 = r.get("image_base64") or ""
                    src = r.get("src") or bb
                    mag = r.get("magnification") or st.magnification_label(level_downsamples)
                    if _is_client_gone(emit("snapshot_captured", {
                        "bboxLevel0": src, "magnification": mag,
                        "out_w": r.get("width"), "out_h": r.get("height"),
                    })):
                        return
                    # 回喂带图（image content）的 tool 消息
                    data_url = "data:image/jpeg;base64,{}".format(img_b64)
                    messages.append({
                        "role": "tool", "tool_call_id": tc_id, "name": "snapshot",
                        "content": [
                            {"type": "text", "text": "快照区域 level-0 bbox={x},{y},{w},{h}，"
                                                      "放大 {}，输出 {}×{} 像素。".format(
                                                          "{},{},{},{}".format(
                                                              src.get("x"), src.get("y"),
                                                              src.get("w"), src.get("h")),
                                                          mag, r.get("width"), r.get("height"))},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    })
                    continue

                if name == "mark_observation":
                    label = args.get("label") or ""
                    note = args.get("note") or ""
                    if _is_client_gone(emit("observation", {
                        "label": label, "note": note,
                    })):
                        return
                    messages.append({"role": "tool", "tool_call_id": tc_id,
                                     "name": "mark_observation",
                                     "content": "已记录观察：{}".format(label)})
                    continue

                if name == "create_annotation":
                    alabel = args.get("label") or "AI 建议"
                    ax = _to_num(args.get("x"))
                    ay = _to_num(args.get("y"))
                    aside = int(args.get("side_px") or 0)
                    anote = args.get("note") or ""
                    aside = max(1, min(aside, 40000))
                    add_fn = ctx.get("add_annotation")
                    index = -1
                    if callable(add_fn):
                        try:
                            res = add_fn(alabel, ax, ay, aside, anote)
                            index = int(res.get("index", -1)) if res else -1
                        except Exception as e:
                            emit("agent_error", {"error": "落标注失败：{}".format(e)})
                    if _is_client_gone(emit("annotation_created", {
                        "label": alabel, "x": ax, "y": ay,
                        "side_px": aside, "note": anote, "index": index,
                    })):
                        return
                    messages.append({"role": "tool", "tool_call_id": tc_id,
                                     "name": "create_annotation",
                                     "content": "已落标注「{}」于 ({:.0f},{:.0f}) 边长 {} 像素。".format(
                                         alabel, ax, ay, aside)})
                    continue

                # 未知工具
                messages.append({"role": "tool", "tool_call_id": tc_id, "name": name,
                                 "content": "未知工具 {}".format(name)})

            # finish_reason 为 length 等也继续，直到 max_steps

        if not finished:
            emit("agent_finished", {"summary": "(已达步数上限，自动结束)"})
    except Exception as e:
        # 兜底：任何未捕获异常都发 agent_error，不让 SSE 流挂死
        try:
            emit("agent_error", {"error": "读片助手异常：{}".format(e)})
        except Exception:
            pass


def _to_num(v) -> float:
    """安全转 float，失败回 0。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0
