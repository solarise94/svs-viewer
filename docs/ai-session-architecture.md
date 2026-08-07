# AI 读片助手 · 架构文档（pi sidecar 迁移后）

> 状态：**已实施**。本文档描述 pi 迁移（Step 1–6）完成后的实际架构。
> 实现位置：`sidecar/`（Node + pi 0.84.0）、`app.py`（Flask 代理层）、
> `docker_entry.sh`（双进程容器入口）。
>
> 旧版手写 tool-call loop（`ai_agent.py` / `ai_session.py` / `ai_protocol.py`）
> 已整体删除；本文档取代其原设计稿。**领域语义章节**（坐标语义、渐进导航、
> 快照消化守卫、标注幂等）规则未变，只是实现搬到了 sidecar，仍照旧生效。

---

## 1. 总体架构

```
┌──────────────┐  HTTPS  ┌──────────────────────────────┐  loopback  ┌──────────────────────────────────┐  HTTPS  ┌─────────────┐
│ 管理员浏览器   │ ──────→ │ Flask app.py (gunicorn :8000)  │ ─────────→ │ Node sidecar (node :8055)          │ ──────→ │ cpa 网关     │
│ (管理员登录)  │         │ - 鉴权 / 上传 / 切片瓦片        │            │ - pi Agent loop / compaction        │         │ (OpenAI 兼容)│
│              │ ←────── │ - 标注库 (share_store)          │ ←───────── │ - 会话存储 / SSE 事件总线           │         │ LLM 模型     │
│              │  SSE    │ - /api/ai/* 透传代理到 sidecar   │            │ - /internal/ai/* 回调 Flask 读图    │         │             │
└──────────────┘         │ - /internal/ai/* 回调端点       │            └──────────────────────────────────┘         └─────────────┘
                         └──────────────────────────────┘
                          共享：uploads/（切片）+ SHARE_DATA_DIR/ai_sessions/（会话）
```

**职责切分**：

| 层 | 职责 | 实现 |
|---|---|---|
| Flask（`app.py`） | 鉴权（管理员 session + IP 锁定）、切片 IO 与 Deep Zoom 瓦片、上传/项目、标注库（`share_store`）、AI 配置读写（`ai_config.json`，api_key Fernet 加密）、`/internal/ai/*` 回调端点（sidecar 回读图/落标注/取变更）、`/api/ai/*` 透传代理到 sidecar | Python 3.12 + gunicorn 线程 worker |
| sidecar（`sidecar/src`） | pi Agent loop（模型流式 + tool 执行）、compaction、会话存储与 SSE 事件、`/internal/ai/*` 回调客户端 | Node 22 + pi `@earendil-works/pi-agent-core@0.84.0` |
| 标注库（`share_store`） | ROI CRUD、`change_seq` 切片级单调序号、tombstone、`_effect_key` 幂等 | Python，被 Flask 直接调用 |

Flask 与 sidecar 之间**只有两个方向的 HTTP 契约**：浏览器 → Flask → sidecar（`/api/ai/*` 代理），sidecar → Flask（`/internal/ai/*` 回调）。两者都走 127.0.0.1，用 `X-AI-Internal-Token` 互信（回调方向）。

---

## 2. 进程、端口与环境变量

### 2.1 进程拓扑（容器内）

容器（`Containerfile`）单镜像内同跑两个进程，由 `docker_entry.sh` 编排：

```
docker_entry.sh
├── node /app/sidecar/dist/index.js   （AI_SIDECAR_PORT=8055，仅 127.0.0.1）
│   └── AI_FLASK_URL=http://127.0.0.1:8000  （回调 Flask）
└── gunicorn app:app -b 0.0.0.0:8000 -w 2 --threads 8
```

启动顺序：先起 sidecar，轮询 `/healthz` 直到就绪（最多 30s），再起 gunicorn。任一进程退出 → 容器退出（首个退出码传播）；SIGTERM 先停 gunicorn（优雅 drain）再停 sidecar。

**生产入口命令固定**：`gunicorn app:app -b 0.0.0.0:8000 -w 2 --threads 8`（沿用 `share_entry.sh` 的 worker 模型：不 preload，openslide 句柄在 borrow_pair 惰性打开，fork 安全；不用 gevent/eventlet）。

### 2.2 端口

| 端口 | 监听 | 服务 |
|---|---|---|
| 8000 | 0.0.0.0 | Flask 管理端（gunicorn），对外暴露；`/api/ai/*` 代理到 sidecar |
| 8055 | 127.0.0.1 | sidecar HTTP server，**仅本机**（容器内/同主机开发时） |

### 2.3 环境变量契约

| 变量 | 缺省 | 说明 |
|---|---|---|
| `AI_SIDECAR_PORT` | 8055 | sidecar 监听端口 |
| `AI_FLASK_URL` | `http://127.0.0.1:8000` | sidecar 回调 Flask 的基础 URL |
| `AI_SIDECAR_URL` | `http://127.0.0.1:8055` | Flask 代理 `/api/ai/*` 到 sidecar 的基础 URL |
| `AI_INTERNAL_TOKEN` | （空 → 读文件） | sidecar ↔ Flask 内部回调共享 token；空则两边各自从 `SHARE_DATA_DIR/ai_internal.token`（0600）读取/生成，fcntl 锁保证 gunicorn 多 worker 首次生成只写一次 |
| `SHARE_DATA_DIR` | `~/svs-viewer/share-data`（容器内 `/data/share`） | 会话存储根目录（`ai_sessions/` 子目录）；同时是 `ai_config.json` / `flask_secret.key` / `ai_internal.token` / `ai_secret.key` 所在目录 |

**注意**：sidecar **不读** `ai_config.json`。每请求的引擎配置（`base_url` / `api_key` 明文 / `model` / `api_protocol` + 全部调优参数）由 Flask 在 `/api/ai/*` 代理时注入到 body 的 `config` 字段（`app.py:_build_sidecar_config`）。这样 api_key 只在 Flask 解密后短暂出现在内存与 loopback 请求里，不落 sidecar 磁盘。

---

## 3. HTTP 契约

### 3.1 `/internal/ai/*`（sidecar → Flask，内部回调）

全部 `POST`/`GET`，鉴权 `X-AI-Internal-Token`（`_require_internal`），**不走**管理员 session。参数缺失/非法 → 400 JSON `{error}`。`_require_auth` 在 `before_request` 里对 `/internal/` 前缀放行。

| 端点 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `/internal/ai/region` | POST | `{slide, x, y, w, h, out_w?, out_h?}`（level-0 整数） | `{image_base64, mime, width, height, src, magnification}`（含青色坐标刻度尺） |
| `/internal/ai/annotate` | POST | `{slide, label, x, y, side_px, note, effect_key, session_id}` | `share_store.add_roi(...)` 返回的 roi dict（含 `annotation_id`/`index`/`change_seq`）；`_effect_key` 幂等、`source="ai"` |
| `/internal/ai/spots` | GET | `?slide=&after_seq=`（缺省 0） | `{changes: [...], current_seq: int}`（`share_store.list_changes` / `current_change_seq`，含 tombstone） |
| `/internal/ai/slide_info` | GET | `?slide=` | `{width, height, level_downsamples: [...], mpp, fingerprint}`（`_slide_fingerprint` = mtime+size） |

### 3.2 `/api/ai/*`（浏览器 → Flask → sidecar，代理契约）

Flask 把这些端点**字节级透传**到 sidecar（普通端点 `_proxy_json`，SSE 端点 `_proxy_sse`：流式透传、状态码原样、`Last-Event-ID` / `after_seq` 透传）。sidecar 不可达 → 503。请求 body 里 Flask 注入 `config`。

| Flask 端点 | 方法 | sidecar 路径 | body / query | 说明 |
|---|---|---|---|---|
| `/api/ai/run` | POST | `/run` | `{slide, task?, fresh?, config}` | 主 session 起跑；SSE；冲突 409 |
| `/api/ai/continue` | POST | `/continue` | `{slide, config}` | 主 session 续跑；SSE；无 main 404 |
| `/api/ai/ask` | POST | `/ask` | `{slide, annotation_id, question?, config}` | fork 起跑/续聊；SSE；根标注已删 410 |
| `/api/ai/cancel` | POST | `/cancel` | `{session_id?} \| {slide}` | 显式取消；原样转发 |
| `/api/ai/sessions` | GET | `/sessions` | `?slide=` | 列 main + 活跃 forks |
| `/api/ai/session/<id>` | GET | `/session/<id>` | — | session detail + 脱敏 transcript |
| `/api/ai/session/<id>/archive` `/unarchive` | POST | `/session/<id>/archive` `/unarchive` | `{}` | fork 归档/恢复；running 409 |
| `/api/ai/session/<id>/stream` | GET | `/session/<id>/stream` | `?after_seq=N`，`Last-Event-ID` | SSE 重挂/断线重连 |
| `/api/ai/config` | GET/PUT | —（Flask 自处理） | — | 读写 `ai_config.json`（不转发 sidecar） |

### 3.3 sidecar 原生端点（仅供 Flask 代理与探活）

`POST /run`、`POST /continue`、`POST /ask`、`POST /cancel`、`GET /sessions`、`GET /session/:id`、`POST /session/:id/archive|unarchive`、`GET /session/:id/stream`、`GET /healthz`（→ `{ok:true}`）。SSE 帧格式见 §6。

---

## 4. 会话存储

### 4.1 目录布局

```
<SHARE_DATA_DIR>/ai_sessions/          （目录 0700）
├── index.json                          # {slide: {main: <id>, forks: {annotation_id: <id>}}}
├── <session_id>.json                   # 会话元数据（原子 tmp+rename，0600）
└── <session_id>.events.jsonl           # SSE 事件流（append + fsync，一行一事件，含单调 seq）
```

`index.json` 被 `pruneIndex()` 在 boot 恢复时裁剪：指向已删/legacy 文件的条目会被清掉，避免 `listBySlide`/`findFork` 拿到死 id。

### 4.2 `<session_id>.json` 字段（新格式，`SessionData`）

```
id, slide, kind: "main" | "fork", annotation_id, title,
created_at, updated_at, last_accessed_at, archived: bool,
agent_state: {center_x, center_y, pyramid_level, viewport_px},
observations: [...],                      # 结构化观察（mark_observation 写入）
pending_snapshot_review: {...} | null,    # 快照消化守卫
spot_cursor: int,                         # 已消费到的 change_seq
status: idle | running | paused | finished | error,
summary: str | null,
last_event_seq, event_min_seq,            # SSE 事件 seq 窗口（滚动）
event_buffer_size: int,                   # 滚动窗口大小（默认 200）
messages: PersistedAgentMessage[],        # pi AgentMessage[]，图块脱水为 image_ref（不含 base64）
compaction_entries: [{seq, tokens_before, tokens_after, reason?, ts}]   # compaction 日志
```

**对比旧 `ai_session.py` 字段**：
- **新增**：`messages`（取代 `canonical_messages`，pi AgentMessage 形态）、`compaction_entries`。
- **保留**：`id` / `slide` / `kind` / `annotation_id` / `title` / 时间戳 / `archived` / `agent_state` / `observations` / `pending_snapshot_review` / `spot_cursor` / `status` / `summary` / `last_event_seq` / `event_min_seq`。
- **废弃**（见 §8）：`active_run_id` / `lease_epoch` / `lease_expires_at` / `heartbeat_at` / `pending_bundle`（WAL）/ `cancel_requested` / `revision` / `bundle_seq` / `compacted_upto` / `canonical_messages`。

### 4.3 image_ref 脱水（`PersistedAgentMessage`）

落库的 `messages` 里，所有图块都是 `image_ref`（不带 base64），形如：

```ts
{ type: "image_ref", ref_id, slide_fingerprint, src: {x,y,w,h}, magnification, summary }
```

- `ref_id = ref_<toolCallId>`，snapshot 工具执行时由 `tools.ts` 写入。
- `slide_fingerprint` = 切片 mtime+size，物化时校验，不符则降级为「该图因切片变更不可用」文本（防同名替换静默取到另一张内容）。
- 发模型前由 `transform-context.ts` 把 image_ref 物化成 `image_url`（base64）。

### 4.4 `<session_id>.events.jsonl`

每行一个事件：`{type, payload, ts, seq}`，`seq` 单调递增。`SessionStore.appendEvent` 分配 seq 并更新滚动窗口水位 `event_min_seq`（取「现存最小」与「观测最大」的较小者）。

### 4.5 单进程并发模型（关键变化）

sidecar 是**单 Node 进程**，事件循环串行化所有 IO 与状态变更。因此旧架构为多进程/多 worker 设计的并发机制全部废弃：

| 旧机制 | 现状 | 理由 |
|---|---|---|
| `lease_epoch` fencing token | **废弃** | 单进程内同一 session 同时只有一个 run（`AgentRunner` 内存里一个 `activeAgents` map），不存在「过期旧 worker 死而复生」 |
| `lease_expires_at` / `heartbeat_at` | **废弃** | 无跨进程租约竞争 |
| `pending_bundle` WAL | **废弃** | 进程崩溃由 `recoverOnBoot` 把 running → paused；同 bundle 内副作用按 pi 的 tool 执行顺序串行，无需 WAL 重放 |
| `active_run_id` CAS | **废弃**（in-process） | `SessionStore.withLock`（基于 Node 事件循环的互斥）保证同 session 串行；409 冲突由 sidecar `SessionConflict` 抛出 |
| `revision` / `bundle_seq` | **废弃** | 无并发写竞争，无需乐观锁 |
| `cancel_requested` | **废弃**（in-process） | `/cancel` 直接调 `Agent.abort()`（`activeAgents` map 持有句柄） |
| 跨文件锁序 `session.lock → share_store lock` | **不再需要** | sidecar 不直接写 share_store，落标注走 `/internal/ai/annotate` 回调，由 Flask 的 share_store 单边锁保证；`_effect_key` 幂等仍在 share_store 内 |

**保留的并发原语**：
- `SessionStore.withLock(sessionId, fn)`：基于 Node Promise 队列的 per-session 互斥，保证 `appendEvent` 的 seq 单调、`writeSession` 的原子性。
- share_store 的 `fcntl.flock`（Flask 侧，多 gunicorn worker 互斥）与 `_effect_key` 幂等。

### 4.6 boot 恢复（`recoverOnBoot`）

sidecar 启动时（`index.ts:main`）扫描所有 session 文件：

1. **running → paused**：任何 `status==="running"` 的 session 视为「worker 随进程死掉」，翻成 `paused`（前端可「▶ 继续」续跑）。
2. **seq 修复**：每个 session 的 `last_event_seq` 与 `.events.jsonl` 尾部实际最大 seq 对齐（旧实现可能已 append 到 120 但元数据只写到 115）。
3. **legacy 跳过**：检测到旧 Python-agent 格式（有 `canonical_messages`、或缺 `messages` 数组）的文件**不加载、不删除**，仅 `console.warn` 提示运维手动清理；`pruneIndex` 把指向它的 index 条目清掉。
4. 返回 `{paused, repaired, legacy}`，`index.ts` 打印汇总日志。

### 4.7 legacy 数据跳过策略

旧 `ai_session.py` 产生的会话（`canonical_messages` 形态）无法被新 store 加载。策略是**只跳过、不迁移、不删除**：

- `isLegacySessionFile` 用 `canonical_messages` 存在 / `messages` 缺失两个信号判定。
- `recoverOnBoot` 遇到 legacy 文件：push 进 `legacy[]`，打 warn，`continue`（不进 paused/repaired 流程）。
- `pruneIndex` 把指向 legacy/缺失文件的 index 条目移除，保证 `/sessions` 列表不冒死 id。
- 运维若想清理：直接删 `<id>.json` 与 `<id>.events.jsonl`。

这样旧数据在新版本下「不可见但安全」，不丢数据也不需要写一次性迁移脚本。

---

## 5. Compaction（上下文压缩）

实现：`sidecar/src/compaction.ts`（挂接 pi 的 harness compaction 原语）+ `agent-runner.ts` 的 `runCompactionPass`。

### 5.1 挂接方式（flat-linear adapter）

sidecar 没有 pi 的 SessionManager/branch 树，`messages` 是扁平的 `AgentMessage[]`。adapter 把它包成 pi 的 `Entry[]`（线性 parent 链），并在头部合成一个「上一次 compaction」的 `CompactionEntry`（带 `summary` + `retainedTail`），让 pi 的 `prepareCompaction` 能：
- 取 `previousSummary` 做增量摘要；
- 虚拟展开 retained tail 后续跑摘要。

### 5.2 触发阈值

`shouldCompact` 判定（唯一公式，只减一次 reserve）：

```
estimated_input_tokens + reserve_tokens >= context_window_tokens - safety_margin
```

- `reserve_tokens`（缺省 16000）、`keep_recent_tokens`（缺省 20000）、`context_window_tokens`（缺省 272000，§7 窗口说明）。
- `estimated_input_tokens`：优先用响应里的实际 `usage` 校准；缺失时 `estimateContextTokens` 保守估算（文本按字符启发、图按分辨率定档）。

### 5.3 compact 执行

`compact()` 返回 `{summary, retainedTail}`。sidecar 重建 post-compaction messages 为 `[compactionSummary, ...retainedTail]`，应用到 `agent.state.messages`，持久化（`persistCompaction` 写 `compaction_entries`），并：

1. **LLM 摘要注回**：`runCompaction` 内部用配置好的 model 调 pi 的 summarizer 生成增量摘要，写进 `compactionSummary` 消息。
2. **spot 索引注入**：compact 后追加一条 spot-index user message（`buildSpotIndexMessage` 从 `/internal/ai/spots` 取全量标注快照，文本无图），推进 `spot_cursor`。下次 run/continue/ask 只追加 `change_seq > spot_cursor` 的增量（`spot_updated`/`spot_deleted`）。

### 5.4 超窗 force-compact 重试

模型调用报上下文超窗（HTTP 400 `context_length_exceeded` 等措辞）：

1. `makeRetryingStreamFn` 捕获 → `runCompactionPass("context_length_exceeded")` 无条件压一次 → 重新物化并重试该次调用**一次**。
2. 重试仍超窗 → 视为致命，message_end handler 发 `agent_error` 终止 run。
3. compaction LLM-summary 失败本身**不**断主循环：只打日志、messages 不变，agent 继续用未压缩上下文跑；仅 force-compact 路径把第二次失败当致命。

### 5.5 compaction 事件

成功压缩后发 `session_compacted {tokens_before, tokens_after, reason?}`（reason 仅 force-compact 路径带）。

---

## 6. 图片管线

实现：`sidecar/src/transform-context.ts`（pi `transformContext` hook）+ `tools.ts`（snapshot 工具产生图）。

### 6.1 请求时物化

pi 在每次模型调用前调 `transformContext(messages)`。sidecar 的实现（`transformOnce`）：

1. **Phase 1 物化**：扫描所有 `image_ref` 块，**并发**向 `/internal/ai/region` 拉图（一张一个 loopback 请求），替换为 `image_url`（base64）。
2. **Phase 2 淘汰**：物化后统计图块，保留最近 N 张，旧的替换为占位文本。

### 6.2 指纹降级

物化时校验 `slide_fingerprint`（切片 mtime+size）。不符（切片被同名替换）→ 该图块降级为 `{type:"text", text:"该图因切片变更不可用。"}`，不静默取到另一张内容。region 调用本身失败也降级为同款文本。

### 6.3 只留最近 N 张（`keep_recent_images`）

- 配置 `keep_recent_images`（缺省 **6**，正整数，`ai_config.json` 可覆盖；PUT 校验非正整数 → 400）。
- **概览首图永不被淘汰**：`firstSnapshotToolCallId`（session 的第一张 snapshot 的 toolCallId）匹配，或 bbox 覆盖全片宽 >90%，任一信号命中即视为 protected，不计入淘汰窗口。
- 其余图块按 `(msgIdx, blkIdx)` 排序，保留最近 `keep_recent_images` 张，更早的替换为「（历史快照已省略，可用 goto+snapshot 重新查看）」。
- 这与旧 `ImageBudget`「滚动 3 图 + 逐张改历史」不同：**不动落库的 canonical 形态**（messages 里仍是 image_ref），只在每次发模型前的 request 形态里淘汰，前缀稳定、缓存友好。

---

## 7. SSE 事件契约

SSE 帧格式（`events.ts`，与旧 `app.py` 字节一致）：
```
id: {seq}\nevent: {type}\ndata: {json}\n\n      普通事件
: ping\n\n                                   心跳（每 15s）
id: {curSeq}\nevent: event_reset\ndata: {event_min_seq, last_event_seq}\n\n   断点已滚过窗口
event: session_ended\ndata: {status}\n\n      session 离开 running（无 id 行，流随即关闭）
```

响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`、`X-AI-Session-ID: <id>`。

### 7.1 事件表（事件名 + payload 字段）

| 事件名 | 触发点 | payload |
|---|---|---|
| `slide_opened` | 主 session 首跑（run）setup | `{slide, width, height, overview_level, level_count, mpp, viewport:{x,y,w,h}, session_id}` |
| `session_resumed` | 主 session 续跑（continue） | `{session_id, status}` |
| `fork_created` | fork 首次起跑（ask 新 fork） | `{annotation_id, title}` |
| `fork_resumed` | fork 续聊（ask 已有 fork） | `{session_id, annotation_id}` |
| `tool_started` | `goto` 工具执行后 | `{tool:"goto", x, y, level, magnification, reason, requested_level}` |
| `snapshot_captured` | `snapshot` 工具执行后（**不含 base64**，省带宽） | `{bboxLevel0:{x,y,w,h}, magnification, out_w, out_h}` |
| `observation` | `mark_observation` 工具 | `{label, note, no_annotation_reason, bbox:{x,y,w,h}}` |
| `annotation_created` | `create_annotation` 工具（落标注库） | `{label, x, y, side_px, note, index, annotation_id}` |
| `snapshot_reviewed` | `complete_snapshot_review` 工具 | `{snapshot_id, disposition:"annotated"\|"no_annotation", summary, no_annotation_reason}` |
| `agent_thinking` | 每个 pi turn 开始 | `{step}` |
| `text_delta` | pi `assistantMessageEvent` 增量 | `{text: delta}` |
| `agent_retrying` | 瞬时错误重试（最多 3 次，2/4/8s 退避） | `{step, attempt, max:3, delay, reason}` |
| `agent_paused` | 达 `max_steps`（缺省 50）/ 输出被 `max_tokens` 截断 | `{summary, can_continue:true, reason?:"max_tokens"}` |
| `agent_finished` | `finish` 工具 terminate / 纯文本结束 | `{summary}`（纯文本无总结时为 `"(无总结)"`） |
| `agent_error` | run 异常 / 二次超窗 / streamFn 致命错误 | `{error, step?}` |
| `session_compacted` | compaction 成功 | `{tokens_before, tokens_after, reason?}` |
| `event_reset` | 重挂时 `after_seq < event_min_seq`（缓冲已滚过） | `{event_min_seq, last_event_seq}`（带 `id: {curSeq}`） |
| `session_ended` | session 离开 running（finished/paused/error） | `{status}` |

**断线重连**：前端带 `Last-Event-ID` 或 `?after_seq=N`。
- `after_seq >= event_min_seq` → 从 `.events.jsonl` 重放缺失事件后接续 live 流。
- `after_seq < event_min_seq` → 发单个 `event_reset` 帧（带 `id: curSeq` 推进 Last-Event-ID），前端重新 `GET /session/<id>` 拿全量脱敏 transcript 再接续。

SSE 断开（页面刷新/网络断）**不暂停 run**：run 在 sidecar 后台继续，事件持久化到 `.events.jsonl`，重挂时重放。

---

## 8. 与旧架构的差异（废弃清单）

以下旧设计稿（v2–v4.1）里的机制**已废弃**，理由见 §4.5（单进程并发模型）：

- **租约 + fencing**：`lease_epoch` / `lease_expires_at` / `heartbeat_at` / TTL 续租线程 / 跨文件锁序 `session.lock → share_store lock`。单进程内无跨进程租约竞争。
- **WAL 幂等**：`pending_bundle` / `effect_key = session_id:bundle_seq:tool_call_id` 的 WAL 重放。`_effect_key` 幂等仍保留在 `share_store.add_roi`（Flask 侧），但 sidecar 不再写 WAL；进程崩溃由 `recoverOnBoot` 兜底（running → paused）。
- **乐观锁**：`revision` / `bundle_seq` / `active_run_id` CAS。改为 in-process `SessionStore.withLock` + `AgentRunner` 内存 `activeAgents` map。
- **取消标记**：`cancel_requested` 字段。改为 `/cancel` 直接 `Agent.abort()`。
- **canonical/request 双形态分离的复杂性**：旧设计要显式区分 `canonical_messages`（落库）与 `request_messages`（物化）。新实现里落库形态统一为 `messages`（图块是 image_ref），物化由 pi `transformContext` hook 在发模型前自动完成，无需双形态字段。
- **旧图像策略**：「滚动 3 图 + 逐张改历史消息中间内容」（打断前缀缓存）。改为 §6 的 transformContext 淘汰（不动落库形态，只动 request 形态）。

---

## 9. 领域语义（规则未变，实现搬迁）

以下规则从旧 `ai_agent.py` / `ai_session.py` 整体迁到 sidecar，**语义不变**：

### 9.1 坐标语义
- 所有 ROI / goto / snapshot 坐标统一为 **level-0 像素坐标**。
- snapshot 图像顶缘/左缘画**青色 level-0 坐标刻度尺**（`app.py:_overlay_coord_ticks`，sidecar 经 `/internal/ai/region` 回调 Flask 取图，Flask 内画刻度），让模型看着图内特征读出 level-0 坐标。
- 注入的标注线索（spot 索引 / `spot_updated` / fork spot 卡）统一写明**左上角 + 中心**坐标，goto 用中心坐标（否则视野偏半格）。

### 9.2 渐进导航（goto ±2 层 clamp）
- 单次 `goto` 最多变 **±2 层**（`MAX_LEVEL_DELTA=2`，像显微镜物镜转盘）。超步长先夹步长（结果消息带「请渐进变倍」警告），再做有效层范围 clamp。
- 仅超有效层范围（非超步长）保持原「请求 level=… 已夹到有效层 …」句式。
- 防重复 goto 同坐标：连续两次 goto 同 level 同中心会拒绝并提示。

### 9.3 快照消化守卫（`pending_snapshot_review`）
- 每次 `snapshot` 后、下一次 `goto`/新 `snapshot`/`finish`/纯文本结束前，**必须二选一**：`create_annotation`，或 `mark_observation`（结构化观察，含 bbox + 所见 + 「不需标注的理由」）。
- 守卫**覆盖同 bundle**：模型可在一条 assistant 消息里同时返回 `snapshot` 和 `goto`——执行 snapshot 后它还没看到图，同 bundle 后面的 `goto` 也必须拒绝。
- pending review 期间拒绝：`goto`、新 `snapshot`、`finish`、纯文本结束。
- `create_annotation` / `mark_observation` 的 schema 强制引用当前 pending 的 `snapshot_id`。
- **关闭 pending 的明确动作**：独立的 `complete_snapshot_review(disposition, summary, no_annotation_reason?)`。一个 snapshot 允许多个 `create_annotation`（一处快照发现多个目标），`create_annotation` 不关闭 pending；只有 `complete_snapshot_review` 关闭。
- 守卫**只约束 main**（fork 没有 `create_annotation`，仅问答 + 看图，不进 pending）。
- `pending_snapshot_review` 持久化到 session JSON（崩溃恢复后仍 pending，模型下一步仍须先消化）。

### 9.4 标注幂等与变更追踪
- ROI 稳定主键 `annotation_id`（UUID），`change_seq` 切片级全局单调序号（新建/编辑/删除都 +1，重复删除不递增）。
- 删除 = tombstone（`deleted=true` + `change_seq++`），物理保留。
- sidecar 落标注走 `/internal/ai/annotate`，传 `effect_key`（`session_id:toolCallId`）给 `share_store.add_roi` 做幂等（已落则复用，防 sidecar 重试重复落标）。
- fork 的变更消费范围：只追加根 `annotation_id` 的 `spot_updated`/`spot_deleted` 进自己对话；`spot_cursor` 仍推进到全局最新水位。根标注在 fork 运行中被删 → 410。

---

## 10. 默认参数（`DEFAULT_CONFIG`，`ai_config.json` 可覆盖）

| 参数 | 默认 | 说明 |
|---|---|---|
| `max_steps` | 50 | 单轮步数上限（到点 `agent_paused`，可继续） |
| `context_window_tokens` | 272000 | compact 触发窗口（保守；gpt-5.6-luna 超 272k 进高价档） |
| `reserve_tokens` | 16000 | 摘要 prompt+输出预留 |
| `safety_margin` | 8192 | 防估算误差顶爆（legacy 字段，当前 compaction 未直接用） |
| `keep_recent_tokens` | 20000 | compact 后保留原文 token |
| `keep_recent_images` | 6 | 每次请求物化后保留的最近图数（正整数） |
| `fork_active_limit` | 20 | 活跃 fork 上限（超出归档，不硬删；running 不归档） |
| `lease_ttl` | 150.0 | （legacy 字段，保留兼容旧配置；新架构无租约） |
| `event_buffer` | 200 | SSE 事件滚动窗口（`.events.jsonl` 重放用） |
| `max_tokens` | 2048 | 单次模型输出 token 上限 |

`gpt-5.6-luna` 窗口说明：官方窗口 1,050,000、最大输出 128,000；输入超 272k 进更高价档，转发层能否透传 1.05M 不保证，故保守取 272k；遇 `context_length_exceeded` 走 §5.4 的 force-compact 重试。
