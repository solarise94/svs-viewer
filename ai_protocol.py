# -*- coding: utf-8 -*-
"""AI 协议适配层：在 OpenAI 内部表示与 Anthropic Messages API 之间转换。

设计要点（对应任务3：anthropic 协议完整适配）：
- run_agent 内部始终用 **OpenAI 格式** 的 messages 作为 canonical 表示
  （role: system/user/assistant/tool，tool_calls，image_url data-url）。
- 发模型前按 cfg.api_protocol 分流：
  - openai    → 原样发 POST {base_url}/chat/completions（现有逻辑）。
  - anthropic → 用本模块把 messages/tools 转成 Anthropic Messages API 格式，
    POST {base_url}/v1/messages（base_url 容错见 build_anthropic_request），
    响应用 parse_anthropic_response 转回 OpenAI 的 {choices, usage} 形态，
    让 run_agent 的下游（choice/message/tool_calls）分支无感知。

Anthropic Messages API 关键差异：
- system 是顶层字段，不进 messages。
- 无 role:tool；工具结果包进 role:user 的 content，用 tool_result block。
- assistant 的 tool_calls → content 里的 tool_use block（带 id/name/input）。
- tools schema：{type:function,function:{name,desc,parameters}} → {name,desc,input_schema}。
- image：image_url data-url → {type:image,source:{type:base64,media_type,data}}。
- 响应 content 是 block 数组（text / tool_use），stop_reason 对应 finish_reason。
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import requests


# =========================================================================== #
# messages 转换：OpenAI → Anthropic
# =========================================================================== #
def extract_system_message(messages: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]]]:
    """把第一条 role=system 抽出来作为 Anthropic 顶层 system 字段。

    OpenAI 允许多条 system（散落），Anthropic 只接受一个顶层 system。
    这里把所有 system 消息合并成一段文本（用换行连接），其余消息原样保留。
    返回 (system_text, non_system_messages)。
    """
    sys_parts: List[str] = []
    rest: List[Dict[str, Any]] = []
    for m in messages:
        if m.get("role") == "system":
            sys_parts.append(_openai_content_text(m.get("content")))
        else:
            rest.append(m)
    return ("\n\n".join(p for p in sys_parts if p)), rest


def convert_messages_to_anthropic(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把 OpenAI messages（去掉 system 后）转成 Anthropic messages。

    规则：
    - role:user / role:assistant 文本/图片 → content blocks（text/image）。
    - role:tool（OpenAI 工具结果）→ 合并进前一条/新建 role:user，
      content 用 tool_result block（tool_use_id/content）。
    - assistant.tool_calls → content 里追加 tool_use block（id/name/input）。
    - 连续同 role 的消息会被 Anthropic 拒绝，这里把相邻 user 合并、
      相邻 assistant 合并（主要是 tool 结果跟在 user 文本后这种情况）。
    """
    out: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            # OpenAI tool result → Anthropic role:user 的 tool_result block
            tool_use_id = m.get("tool_call_id") or ""
            result_text = _openai_content_text(m.get("content"))
            block = {"type": "tool_result", "tool_use_id": tool_use_id,
                     "content": result_text or "(无结果)"}
            _append_block(out, "user", block)
            continue
        blocks = _content_to_blocks(m.get("content"))
        # assistant 的 tool_calls → tool_use blocks
        if role == "assistant":
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = __import__("json").loads(args or "{}")
                    except Exception:
                        args = {}
                if not isinstance(args, dict):
                    args = {}
                blocks.append({"type": "tool_use", "id": tc.get("id") or "",
                               "name": fn.get("name") or "",
                               "input": args})
        if not blocks:
            # 空内容兜底：Anthropic 不接受空 content
            blocks = [{"type": "text", "text": ""}]
        target_role = "user" if role in ("user", "tool") else "assistant"
        _append_blocks(out, target_role, blocks)
    return out


def _append_block(out: List[Dict[str, Any]], role: str, block: Dict[str, Any]) -> None:
    """把单个 block 追加到 messages（合并相邻同 role）。"""
    _append_blocks(out, role, [block])


def _append_blocks(out: List[Dict[str, Any]], role: str,
                   blocks: List[Dict[str, Any]]) -> None:
    """把一批 block 追加到 messages（合并相邻同 role 的 content）。"""
    if out and out[-1].get("role") == role:
        out[-1]["content"].extend(blocks)
    else:
        out.append({"role": role, "content": list(blocks)})


def _content_to_blocks(content: Any) -> List[Dict[str, Any]]:
    """OpenAI content（string 或 parts 数组）→ Anthropic content blocks。

    - string → [{type:text,text:...}]
    - {type:text,text} → 原样
    - {type:image_url, image_url:{url: "data:image/jpeg;base64,XXXX"}} →
      {type:image, source:{type:base64, media_type, data}}
    - {type:image_ref}（canonical 物化前的引用）→ 跳过（物化后才是 image_url）
    """
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]
    blocks: List[Dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            blocks.append({"type": "text", "text": str(part)})
            continue
        ptype = part.get("type")
        if ptype == "text":
            t = part.get("text") or ""
            if t:
                blocks.append({"type": "text", "text": t})
        elif ptype == "image_url":
            img = _data_url_to_anthropic_image(part.get("image_url") or {})
            if img:
                blocks.append(img)
        # image_ref 等其它类型：物化阶段已转 image_url，此处忽略
    return blocks


def _data_url_to_anthropic_image(image_url: Dict[str, Any]) -> Dict[str, Any]:
    """data:image/jpeg;base64,XXXX → {type:image, source:{type:base64,...}}。

    非 data-url（http(s) 链接）Anthropic 也支持 source.type=url，但本项目
    图片都是 base64 内联，这里只处理 data-url；非 data-url 返回空（跳过）。
    """
    url = image_url.get("url") or ""
    if not url.startswith("data:"):
        return {}
    # data:image/jpeg;base64,XXXX
    header, _, data = url.partition(",")
    media_type = "image/jpeg"
    if header.startswith("data:") and ";" in header:
        media_type = header[5:].split(";")[0] or media_type
    if not data:
        return {}
    return {"type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data}}


def _openai_content_text(content: Any) -> str:
    """取 OpenAI content 的纯文本（string 或 parts 数组里的 text 拼接）。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text":
                parts.append(p.get("text") or "")
        return "\n".join(parts)
    return str(content)


# =========================================================================== #
# tools 转换：OpenAI function schema → Anthropic tool schema
# =========================================================================== #
def convert_tools_to_anthropic(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """OpenAI tools → Anthropic tools。

    OpenAI: {type:"function", function:{name, description, parameters:{...}}}
    Anthropic: {name, description, input_schema:{...}}
    """
    out: List[Dict[str, Any]] = []
    for t in tools or []:
        fn = t.get("function") if isinstance(t, dict) else None
        if not fn:
            continue
        schema = fn.get("parameters") or {"type": "object", "properties": {}}
        out.append({
            "name": fn.get("name") or "",
            "description": fn.get("description") or "",
            "input_schema": schema,
        })
    return out


# =========================================================================== #
# 请求构建 + 响应解析
# =========================================================================== #
def build_anthropic_request(base_url: str, api_key: str, model: str,
                            max_tokens: int, messages: List[Dict[str, Any]],
                            tools: List[Dict[str, Any]]) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    """组装 Anthropic Messages API 的 url/headers/body。

    base_url 容错：
    - 末尾去 /；
    - 若已含 /v1 或 /messages（用户填了完整端点），不重复拼；
    - 否则补 /v1/messages。
    返回 (url, headers, body)。headers 含 x-api-key + anthropic-version。
    """
    system, msgs = extract_system_message(messages)
    anthropic_msgs = convert_messages_to_anthropic(msgs)
    body: Dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": anthropic_msgs,
    }
    if system:
        body["system"] = system
    if tools:
        body["tools"] = convert_tools_to_anthropic(tools)

    url = _anthropic_messages_url(base_url)
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    return url, headers, body


def _anthropic_messages_url(base_url: str) -> str:
    """根据 base_url 推断 messages 端点（容错用户填法）。"""
    b = (base_url or "").rstrip("/")
    if not b:
        return "/v1/messages"
    low = b.lower()
    # 用户已填到 messages 端点
    if low.endswith("/messages"):
        return b
    # 用户填到 /v1 或版本号
    if low.endswith("/v1") or "/v1/" in low:
        return b + "/messages"
    # 兜底：补 /v1/messages（官方约定）
    return b + "/v1/messages"


def parse_anthropic_response(data: Dict[str, Any]) -> Dict[str, Any]:
    """把 Anthropic 响应转回 OpenAI 形态 {choices:[{message,finish_reason}], usage}。

    - content blocks 里 text → message.content；
    - tool_use → message.tool_calls（OpenAI 格式，arguments 序列化成字符串）；
    - stop_reason → finish_reason（tool_use→tool_calls，end→stop，其余原样）。
    run_agent 下游只认 OpenAI 的 choice/message，故这里做归一。
    """
    import json as _json
    content_blocks = data.get("content") or []
    text_parts: List[str] = []
    tool_calls: List[Dict[str, Any]] = []
    for blk in content_blocks:
        if not isinstance(blk, dict):
            continue
        btype = blk.get("type")
        if btype == "text":
            text_parts.append(blk.get("text") or "")
        elif btype == "tool_use":
            tool_calls.append({
                "id": blk.get("id") or "",
                "type": "function",
                "function": {
                    "name": blk.get("name") or "",
                    "arguments": _json.dumps(blk.get("input") or {}),
                },
            })
    content_text = "".join(text_parts)
    msg = {"role": "assistant", "content": content_text or None}
    if tool_calls:
        msg["tool_calls"] = tool_calls

    stop_reason = data.get("stop_reason") or ""
    finish_reason = _anthropic_stop_to_openai(stop_reason, bool(tool_calls))

    usage_in = data.get("usage") or {}
    usage = {
        "prompt_tokens": usage_in.get("input_tokens") or 0,
        "completion_tokens": usage_in.get("output_tokens") or 0,
        "total_tokens": (usage_in.get("input_tokens") or 0) + (usage_in.get("output_tokens") or 0),
    }
    return {
        "choices": [{"message": msg, "finish_reason": finish_reason}],
        "usage": usage,
    }


def _anthropic_stop_to_openai(stop_reason: str, has_tool_calls: bool) -> str:
    """Anthropic stop_reason → OpenAI finish_reason。"""
    sr = (stop_reason or "").lower()
    if sr == "tool_use" or sr == "tool_calls":
        return "tool_calls"
    if sr in ("end_turn", "stop_sequence", "max_tokens", "stop"):
        return "stop"
    # 有 tool_use 但 stop_reason 缺失时也按 tool_calls
    return "tool_calls" if has_tool_calls else "stop"


# =========================================================================== #
# 统一调用入口：按协议分流发请求
# =========================================================================== #
def post_model(base_url: str, api_key: str, model: str, max_tokens: int,
               api_protocol: str, messages: List[Dict[str, Any]],
               tools: List[Dict[str, Any]], timeout: float = 120.0) -> Dict[str, Any]:
    """按 api_protocol 发模型请求，返回归一化后的 OpenAI 形态响应 dict。

    - openai：POST {base_url}/chat/completions，原样返回 json。
    - anthropic：POST {messages_url}，响应经 parse_anthropic_response 归一。

    由调用方处理 raise_for_status / HTTPError（run_agent 已有重试逻辑）。
    """
    if api_protocol == "anthropic":
        url, headers, body = build_anthropic_request(
            base_url, api_key, model, max_tokens, messages, tools)
        resp = requests.post(url, headers=headers, json=body, timeout=timeout)
        # 先读 body：Anthropic 错误体是 {type:"error", error:{type,message}}，
        # 优先用其中的 message 抛 HTTPError（比 raise_for_status 的裸 body 更可读）。
        try:
            data = resp.json()
        except Exception:
            resp.raise_for_status()
            raise
        if isinstance(data, dict) and data.get("type") == "error":
            err = data.get("error") or {}
            http_err = requests.HTTPError(err.get("message") or "anthropic error")
            http_err.response = resp
            raise http_err
        # 非错误体也校验状态码（兼容把错误放进 status 但 body 无 type:error 的端点）
        resp.raise_for_status()
        return parse_anthropic_response(data)
    # 默认 openai
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "max_tokens": max_tokens,
    }
    resp = requests.post(url, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    return resp.json()
