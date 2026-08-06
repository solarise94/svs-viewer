# AI 读片助手 · 会话持久化与批注式对话架构设计

> 状态：**设计稿 v4.1，可开工**。主架构已通过。
> 日期：2026-08-03（v2 补 5 边界；v3 收紧 3 个并发/存储 P0；v4 锁 2 个并发/协议 P0；
> v4.1 补 fencing 原子耦合不变量 + 2 个非阻塞修正）
> 前置：当前已实现"单轮 AI 读片"（`ai_agent.py` 手写 tool-call loop + SSE 轨迹流 + 落标注）。
>
> **v4.1**：把 fencing 校验与副作用**原子耦合**（固定锁序 `session.lock → share_store lock`），
> 防跨文件 TOCTOU；snapshot review 收口改用独立 `complete_snapshot_review`；
> event log 崩溃后扫描尾部修复 seq。主架构未变。
>
> **v4**：锁死 2 个并发/协议级 P0——① 租约加单调 fencing token（`lease_epoch`），
> 防止过期旧 worker"死而复生"造成双写；② 统一"用户取消"与"WAL 崩溃恢复"的语义
> （含 `finish` 必须回写 tool result）。并补 4 个实现契约（snapshot 守卫覆盖同 bundle、
> change_seq 存储/清理、SSE event log 独立持久化、SessionRunner 接口）。改动处标注 【v4】。

---

## 0. 要解决的三个真实痛点

1. **跑一半丢进度**：主 run 到步数上限（`max_steps`，默认 50）就停，messages 是局部变量，跑完即弃。用户"满意但想继续"时只能从头再来。
2. **无法对某个 spot 追问**：AI 落了一堆标记和注释，用户想针对**其中某一条**详细提问，现有逻辑没有入口、也没有该 spot 的上下文。
3. **上下文 / 缓存成本失控**：当前 `ImageBudget` 逐张降级历史图（改消息中间内容），把 prompt 前缀缓存在降级点全部打断，命中率趋近于 0；图 token 与全段重算叠加，越聊越贵。

---

## 1. 核心思想：把"读片知识"从"对话"里抽出来

> **图只在工作窗口里短暂停留，到点丢弃；但图对应的"位置 + 判读"以文本形式沉淀进标注库（spot 档案），对话只在需要细看时临时重取图。**

| 层 | 内容 | 生命周期 | 是否含图 |
|---|---|---|---|
| 工作窗口 | 当前 run 的 messages | 易失，到阈值被 compact | 含（阈值内全部） |
| **spot 档案**（= 现有标注库） | 位置 + 判读转述 | 持久，跨会话共享 | **纯文本，无图** |
| 会话快照 | 某 session 的 messages 落库 | 持久，图以 `image_ref` 引用 | 无内联图，仅存可重取引用 |

**关键：现有标注库就是 spot 档案，不新造存储。** AI 落标注 = 写长期记忆；AI 追问 = 从标注库读相关 spot 注入。人可编辑 AI 的转述，AI 下次读到的是人改过的版本——**人机共享一份记忆**。

---

## 2. 两类会话（session）

### 2.1 main session —— 全片跑批
- 每切片 1 个。AI 面板"开始"触发，做低倍概览 → goto → snapshot → 落标注 → finish。
- **会持续膨胀**，是要做 compact 的对象。
- **到步数上限不丢进度**：暂停而非终止，可"继续"接着跑（见 §5）。

### 2.2 fork 线程 —— 批注式对话（本设计最核心的交互）
- 点一条 AI 标记的 💬，就**以该标记为根 fork 出一个对话线程**。
- **初始上下文自包含**，不拖主 run 历史：
  ```
  system: 病理专家助手 prompt
  user:   关于切片「X」的一处已标注区域：
          位置 level-0 (x, y, side)，物理约 N mm
          你之前的判读：「note 原文」（revision R, change_seq S）
          [附图：该 spot 现取的一张 snapshot]
          用户的问题：{question}
  ```
- 每条 fork 线程**小而聚焦**：只含这个 spot 的上下文 + 现取的图。
- **【v2】能力边界**：fork 默认是**纯问答 + 按需 `goto`/`snapshot`**，**不允许 `create_annotation`**（避免批注里再造标记污染档案）。AI 新判读以对话呈现，**不自动改 note**，是否采纳由用户手动决定。
- **【v3】fork 根标注被删除**：fork 立即归档，`/ask` 返回 **410 Gone**（"该标注已删除"），UI 标记为已归档、只读，不再继续用过期档案对话。

### 2.3 数量上限
- main：每切片 **1 个活跃 main**；`fresh` 后旧 main 归档，故可同时存在多个归档 main。【v4 修正"每切片 1 个"的表述】
- fork：每切片**活跃展示 ≤ 20**，超出**自动归档**（不硬删历史）。**`running` 状态的 fork 不参与归档**（只能归档 idle/paused/finished/error 的）。
- **fork 自身也需 compact**：数量上限只控"展示/活跃"，不能阻止单个 fork 无限增长。
- 换模型只改配置不改码。

---

## 3. 上下文管理：append-only + 阈值 compact（缓存友好）

### 3.1 缓存为什么现在是崩的
prompt 缓存是**前缀匹配**：从第 1 条消息起逐字节相同的最长前缀命中，第一个不同字节之后全量重算。当前 `ImageBudget.manage()` 逐张替换历史消息中间的图为文本 → 中间断点 → 断点后前缀缓存全废 → 命中率≈0。

### 3.2 图像策略：阈值内保留全部图，废弃"滚动 3 图"【v2】
> **阈值（compact 触发线）以内，保留该会话产生的全部图像，图像 token 一并计入 compact 触发判断。到阈值时由 compact 一次性把旧图随旧消息压掉。废弃"滚动替换最近 3 张"的旧策略。**

- 平时真 append-only，前缀稳定、缓存命中；图与文本统一管理，不另搞"图像 compact"。
- 因 §7 强制"看清就标注、别反复截同一区域"，图产出节奏受控；阈值设在 ~248k（§3.6），图 token 占满前先触发 compact。

### 3.3 canonical vs request messages【v3 P0：统一图像语义】
v2 留下矛盾：§3.2 说"未 compact 的图全留在上下文"，§4.1 又说"恢复时只重取最近 1–3 张"——一次 `/continue` 就无声丢掉其余未 compact 图。**v3 明确区分两种消息形态，消除歧义**：

```
canonical_messages   # 落库形式：所有图都是 image_ref（不含 base64）
request_messages     # 发模型前：把 image_ref 物化成 image_url（base64）
```

- **落库永远存 canonical**（图全为 `image_ref`，文件小）。
- **每次发模型前，把 canonical 中所有"尚未被 compact 丢弃"的 `image_ref` 全部物化成 `image_url`**——即：**阈值内（未 compact）的图全部重取**，不是"最近 1–3 张"。这样 `/continue` 后上下文与暂停前语义一致，不无声丢图。
  - "已被 compact 丢弃"的 `image_ref` 不再物化（它们的知识已进摘要）。
- **代价与缓存**：物化全部未 compact 图意味着恢复时这批图是新内容，会有一次缓存失效——但这是**明确的、一次性的**（恢复边界），而非 v2 那种"无声丢图+随机失配"。compact 阈值内图量受 §7 控制，重取量有限。
- **`image_ref` 防伪**：带 `slide_fingerprint`（切片内容指纹，如 mtime+size 或内容 hash）与**图片摘要**（一两句该图所示）。若切片被同名替换导致 fingerprint 不符，重取时降级为"该图因切片变更不可用"文本，不静默取到另一张内容。

### 3.4 正确做法：平时不动，到点一次性压（参考 pi `compaction.js`）
- **平时：append-only。** 不到阈值绝不动历史，前缀大段稳定命中缓存。
- **到阈值：一次性 compact**，旧消息（含图）整体压成**增量摘要**，prompt 强制保留"所有已看区域坐标+镜下所见"及"已标注区域清单"。
- 保留最近 `keep_recent_tokens`（默认 20k token）原文；**只能按完整 tool-call bundle 切**（一条 assistant + 其全部 tool 结果为不可分单元），不可从任意消息中间截断。
- **compact 后注入标注库 spot**（位置+转述，从标注库读，确定性）。

### 3.5 compact 触发公式（唯一，只减一次 reserve）【v2】
```
当 estimated_input_tokens + reserve_tokens >= context_window_tokens - safety_margin 时触发 compact
```
- `reserve_tokens`：默认 16000；`safety_margin`：默认 8192；`context_window_tokens`：默认 272000（§3.6）。三值都进 `ai_config.json`。
- **【v3】`estimated_input_tokens` 来源**：优先用**响应里的实际 usage**校准；缺失时用保守文本/图片估算（文本按字符启发、图按分辨率定档）；超窗报错后以单次 compact 重试兜底（§3.6）。

### 3.6 gpt-5.6-luna 的窗口与阈值【v2】
官方窗口 1,050,000 tokens、最大输出 128,000；输入超 272k 进更高价格档。ikuncode 转发能否透传 1.05M 无法保证，**保守**：
```
context_window_tokens = 272000
reserve_tokens        = 16000
safety_margin         = 8192
→ 约 248k 输入触发 compact
```
实测支持更大再上调。遇 `context_length_exceeded`：compact 后自动重试一次。

### 3.7 compact 的固有代价（可接受）
compact 那一刻前缀全变 → **缓存全失效一次**。但低频，平时一直命中，摊下来可控。

---

## 4. 存储

### 4.1 session 文件
`share-data/ai_sessions/`（目录 **0700**，session/index 文件 **0600**）【v3 修正权限】：

```
index.json            # {slide: {main: session_id, forks: {annotation_id: session_id}}}
<session_id>.json     # {id, slide, kind: "main"|"fork",
                      #  annotation_id?, title, created_at, updated_at, last_accessed_at,
                      #  archived: bool,
                      #  agent_state: {center_x, center_y, pyramid_level, viewport_px},
                      #  canonical_messages: [...图均为 image_ref...],
                      #  observations: [...],                # §7.2 结构化观察（schema 字段）
                      #  pending_bundle: {...}|null,          # §5.4 WAL
                      #  pending_snapshot_review: {...}|null, # §7.2 快照守卫（schema/WAL 字段）
                      #  compacted_upto: int, summary: str|null,
                      #  status: idle|running|paused|finished|error,
                      #  revision: int, bundle_seq: int,
                      #  active_run_id: str|null, cancel_requested: bool,
                      #  lease_epoch: int,                    # §5.5 fencing token
                      #  lease_expires_at: float, heartbeat_at: float,
                      #  spot_cursor: int,                   # §4.2 已消费到的 change_seq
                      #  last_event_seq: int, event_min_seq: int}  # §5.6 SSE event log
<session_id>.events.jsonl   # SSE 事件独立持久化（§5.6），一行一事件
```

- **`agent_state`**：持久化当前视口（中心 level-0 / 层 / 视口像素），continue 从上次停下的位置接着看（否则 `ai_agent.py:330` 会重建回概览）。
- **原子写**：`tmp + rename`，但**锁一个稳定的 `.lock` 文件**，不锁会被 rename 替换的 JSON（否则锁不住）。【v3 修正】
- **`observations`【v3】**：直接定为 session schema 字段（不再保留"或另一个轻量存储"的开放分支）。

### 4.2 标注（ROI）稳定 ID + 切片级变更序号【v3 P0 重构】
现有 ROI `index` 会因 `delete_roi` 的 `pop()` 位移，不能作 fork 根键。给 ROI 增加：

```
annotation_id: UUID          # 稳定主键；fork 映射 / 端点 / UI 全用它
source: "ai" | "human"
created_by_session_id: str
revision: int                # 单条 ROI 自身的版本（每次编辑 +1）
change_seq: int              # 整张切片全局单调递增的变更序号（新建/编辑/删除都 +1）
updated_at: float
deleted: bool                # tombstone；物理删除改为置位（见下）
```

**为什么需要 `change_seq`【v3 P0】**：`revision` 是每条 ROI 各自递增，单个 int cursor 追不了多条（A 到 rev5、cursor=5，新建 B rev=1，`1>5` 不成立，B 被漏）。改用**切片级全局单调 `change_seq`**：每次新建/编辑/删除任一 ROI，整片 `change_seq` 递增并写在该 ROI 上；session 记 `spot_cursor = 已消费到的 change_seq`，启动时取 `change_seq > spot_cursor` 的所有变更。

**`change_seq` 存储与清理规则【v4】**：
- 全局计数器存为 `change_seq_by_slide[slide]`（share_store 内，按切片一条计数）。
- **分配新 seq 与 ROI 新建/编辑/删除在同一个 share_store 锁临界区内完成**（不能先读后写，否则并发分配重号）。
- 现有 list/get/update/delete API **默认过滤 tombstone**（`deleted=true` 不进 UI 标注层、不进 spot 索引），仅"按 change_seq 拉变更"的内部接口返回 tombstone。
- **重复删除不再次递增 change_seq**（对已 `deleted=true` 的再删是 no-op）。
- **tombstone 永久保留**（v4 定稿）。若以后引入清理水位，则 `spot_cursor` 落后于清理水位的 session 必须执行**全量 spot resync**（重注入完整索引），不能再增量。

**删除 = tombstone【v3】**：物理删除改为置 `deleted: true` + 递增 `change_seq`（产生 `spot_deleted` 事件）。fork 根标注被删 → §2.2 的 410。

**fork 的变更消费范围【v4】**：fork **只追加根 `annotation_id` 的 `spot_updated`/`spot_deleted`** 进自己的对话（不把整张切片所有 spot 变更灌进批注线程）；但 `spot_cursor` 仍推进到全局最新水位。**根标注在 fork 运行中被删**：先 `cancel_requested` + fencing（§5.5），到边界后归档，而不是让正在运行的模型继续追加回复。

**迁移【v3】**：现有 ROI 一次性补 `annotation_id`(UUID)、`change_seq`（按现有顺序赋递增初值，并初始化 `change_seq_by_slide`）、`revision=1`、`source`（缺省安全地默认 `human`）、`deleted=false`。

---

## 5. 后端端点（全部走现有 `_require_auth`，仅管理员）

| 端点 | body | 说明 |
|---|---|---|
| `POST /api/ai/run` | `{slide, task, fresh?}` | 主 session 起跑；`fresh=1` 归档旧 main 开新（§5.2）。SSE |
| `POST /api/ai/continue` | `{slide}` | 主 session 从落库 state+messages 续跑。SSE |
| `POST /api/ai/ask` | `{slide, annotation_id, question}` | fork 起跑/续聊。根标注已删返回 410。SSE |
| `POST /api/ai/cancel` | `{session_id}` | 显式取消（写 `cancel_requested`）。【v3 新增】 |
| `GET /api/ai/sessions?slide=` | — | 列 main + 活跃 forks（id/title/status/updated_at） |
| `GET /api/ai/session/<id>` | — | session detail + **脱敏 transcript**（图以 image_ref/缩略引用，不含 base64 全量）供 UI 恢复对话。【v3 新增】 |
| `POST /api/ai/session/<id>/archive` / `/unarchive` | — | fork 归档/恢复。【v3 新增】 |

### 5.1 `run_agent` 改造 → SessionRunner 接口【v4】
单个 `on_messages(cb)` 收尾回调不足以实现 WAL、逐 bundle checkpoint、heartbeat、cancel、fencing。**把持久化/并发控制收敛进一个外层 `SessionRunner`，`run_agent` 只负责生成模型动作**，避免持久化逻辑散进 Flask 路由和 agent loop。`SessionRunner` 暴露：

```
begin_bundle(assistant_msg)        # 开 WAL pending_bundle，分配 bundle_seq + 各 effect_key
record_tool_result(tool_call_id, result)  # 副作用后回填（含"用户已取消"/finish 的 result）
commit_bundle()                    # 完整 bundle 提交进 canonical_messages，清 pending
heartbeat()                        # 独立线程周期续租（lease_epoch 校验）
is_cancelled() -> bool             # 查 cancel_requested
assert_lease()                     # 校验 active_run_id + lease_epoch，失配则抛（旧 worker 弃写）
emit_event(type, payload)          # 单调 seq，append .events.jsonl + 推 SSE
materialize_request_messages()     # canonical → request（物化未 compact 的 image_ref）
maybe_compact()                    # §3.5 触发判断 + 执行
force_compact(reason)              # 无条件执行一次 compact（§3.6 超窗兜底），并发 session_compacted{reason}
```

`run_agent(initial_messages, initial_state, runner)` 只调 `runner.*`，不直接碰文件/锁。
到 `max_steps` 发 `agent_paused{summary, can_continue:true}`，不清空。
SSE 事件加：`agent_paused`、`session_compacted{tokens_before, tokens_after, reason?}`、`spot_updated`、`spot_deleted`、`event_reset`。
模型调用报**上下文超窗**（HTTP 400 `context_length_exceeded` 等措辞，§3.6）：先 `force_compact` 再重新物化并重试该次调用一次；重试仍失败才 `agent_error` 终止。

### 5.2 `fresh` 语义【v3 修正】
`fresh=1` **归档旧 main（`archived=true`）、新建一个新 `session_id` 的 main**。不让旧 AI 标注的 `created_by_session_id` 指向一个内容已被清空重用的 session。**不动 forks，也不动已落的 AI 标注**。

### 5.3 会话状态机与原子抢占【v3 强化】
- **状态机**：`status: idle | running | paused | finished | error` + `revision` + `active_run_id` + `cancel_requested`。
- **原子抢占（compare-and-set）**：检查 `status` 与写入 `active_run_id` 必须在**同一稳定锁**内完成——`/run`、`/continue`、`/ask` 进来在 `.lock` 临界区里 CAS：仅当 `status ∈ {idle,paused,finished,error}` 才置 `running` + 新 `active_run_id`，否则 409。
- **单活跃 run**：同一 session 同时只允许一个 active run。
- **checkpoint 粒度**：只在**完整 assistant/tool bundle**（一条 assistant + 其全部 tool 结果）落库，不在半截 turn 落库。

### 5.4 WAL 幂等（防跨文件崩溃）【v3 P0，v4 强化 effect_key + 取消语义】
v2 的"完整 bundle 后才 checkpoint + 执行前查 tool_call_id"挡不住这个时序：ROI 已写入 share_store → session 尚未存完整 bundle → 崩溃 → 恢复后无原 tool_call 记录 → 模型生成新 tool_call_id 重复落标。**改为 write-ahead**：

```
1. 收到 assistant 消息（含 tool_calls）→ 先持久化 pending_bundle
     {assistant_msg, tool_calls:[{tool_call_id, name, args, effect_key, status}]}
2. 逐个执行副作用：
     create_annotation → 在 share_store 自己的文件锁临界区内，
        按 effect_key 查是否已落 → 已落则跳过复用，未落则写入
     （幂等检查与 ROI 写入必须在同一个 share_store 临界区，只在 session 文件"先查后写"仍有竞态）
3. 补齐所有 tool results → 提交为完整 bundle 进 canonical_messages
4. 清空 pending_bundle
```

- **`effect_key = session_id:bundle_seq:tool_call_id`**【v4】：加 `bundle_seq`，避免第三方服务意外复用 `tool_call_id` 导致幂等键冲突。`bundle_seq` 是该 session 内单调递增的 bundle 序号。
- 崩溃后恢复：若发现非空 `pending_bundle`，按其中 `effect_key` 续执行/复用已落副作用，补齐 bundle 再提交——**不会重复落标**。
- `effect_key` 对无状态工具（goto/snapshot）也记录但无需幂等（重取无副作用）。

**用户取消 vs WAL 崩溃恢复的语义统一【v4 P0】**：v3 只说"发现 pending 就续执行所有工具"，但若 pending 是用户点停止后留下的，恢复时继续执行 `create_annotation` 会违反取消意图。写死：

- **崩溃恢复**：重放 pending 工具，靠 `effect_key` 幂等（已落的复用、未落的补执行）。
- **用户取消**：**完成当前已进入临界区的副作用**（不可半截回滚）；**尚未开始的工具全部写入 `role=tool` 的"用户已取消"结果**，不再执行。提交完整 bundle 后进入 `paused`，清 pending。
- **`continue` 不得重新执行被用户取消的工具**（它们已有"用户已取消"的 tool result，属已提交 bundle 的一部分）。
- **`finish` 也必须生成对应 tool result**【v4】：现有实现收到 finish 直接退出（`ai_agent.py:418`），若保存了 assistant 的 finish tool call 却无 tool result，continue 会得到非法的工具消息序列。**一条 assistant 消息同时返回多个 tool call（含 finish）时，每个 call 都必须有 result**——finish 的 result 可为 `"已结束"`，其余照常执行；不得因 finish 而丢弃同 bundle 其它 call 的 result。

### 5.5 运行租约 + fencing（防 running 残留 & 旧 worker 死而复生）【v4 P0】
`status==running` 可能因进程崩溃永久残留。但更隐蔽的是：**TTL 过期后新 worker 抢占，旧 worker 却可能随后继续写**——当前模型请求超时 120s（`ai_agent.py:381`），若租约 TTL 90s：

```
worker A 发模型请求，阻塞
→ 90s 租约过期 → worker B 抢占
→ A 在 100s 收到模型响应，继续执行工具和 checkpoint   ← 双写
```

**解：单调递增 fencing token `lease_epoch`**：
- 每次抢占（CAS 置 running）都 `lease_epoch += 1`，并记下自己的 `(active_run_id, lease_epoch)`。
- 之后**所有 heartbeat、WAL 更新、tool 副作用、checkpoint**都必须验证 fencing（见下）。
- **heartbeat 独立于模型请求循环**（单独线程/定时器周期续租），否则阻塞的模型请求期间无法续租、会被误判崩溃。
- 租约字段：`heartbeat_at` 周期更新，`lease_expires_at = heartbeat_at + TTL`（TTL ≥ 模型超时，建议 **150s** 以盖过 120s 请求超时 + 余量）。CAS 抢占用：若 `status==running` 但 `lease_expires_at < now`（租约过期，视为崩溃残留），允许 `lease_epoch+1` 强制恢复为 `paused` 后重新抢占。

**fencing 校验与副作用原子耦合【v4.1 P0：防跨文件 TOCTOU】**：
仅"副作用前校验一次 fencing"仍有窗口——A 校验通过 → B 抢占（epoch+1）→ A 进入 share_store 写 ROI，过期 worker 仍落标。**校验必须与副作用在同一临界区内**：

```
持有 session.lock
  → 校验 active_run_id == my_run_id
  → 校验 lease_epoch == my_epoch
  → 校验 lease_expires_at >= now          # 租约未过期
  → 持有 session.lock 的同时获取 share_store lock
  → effect_key 幂等检查 + ROI 写入
  → 释放 share_store lock
→ 释放 session.lock
```

- **全局锁序固定为 `session.lock → share_store lock`，任何代码不得反向持锁**（否则死锁）。
- ROI 删除需通知 fork 时：**先完成并释放 share_store lock，再处理 session**；运行中的 fork 在下一模型/工具边界再检查根标注与 fencing。
- `assert_lease()` 除 `active_run_id` 和 `lease_epoch` 外，**还必须检查 `lease_expires_at >= now`**（租约未过期）。
- **heartbeat 不得续活已过期的 lease**；过期后只能通过**重新 CAS + 递增 epoch** 获得新租约——否则旧 worker 在无人抢占时会把已过期租约自行"续活"。

### 5.6 SSE 断开语义 + event log 独立持久化【v4 定稿：后台继续 + 可重挂】
SSE 断开（页面刷新/网络断）**不自动暂停，run 后台继续**（租约保活）。事件**不**逐条重写整个 session JSON（太贵），改用独立 append-only 事件日志：

```
<session_id>.events.jsonl     # 一行一事件，含单调 seq
session.last_event_seq        # 已发最大 seq
session.event_min_seq         # 当前缓冲里可用的最小 seq（滚动窗口）
```

- 事件按 session 单调编号，append 到 `.events.jsonl`，定期/到量更新 session 的 `last_event_seq`/`event_min_seq`。
- **崩溃恢复修 seq【v4.1】**：`.events.jsonl` 可能已追加到 seq 120，但 session 元数据只定期写到 115。SessionRunner 启动时**扫描日志尾部，以实际最大 seq 修复 `last_event_seq`/`event_min_seq`**，避免重启后重复分配序号。
- 前端断开重连带 `Last-Event-ID` / `?after_seq=N`：
  - `after_seq >= event_min_seq` → 从 `.events.jsonl` 重放缺失事件后接续 live 流；
  - `after_seq < event_min_seq`（缓冲已滚过）→ 发 `event_reset`，前端**重新 GET session detail** 拿全量脱敏 transcript 再接续。
- **多 worker / 跨进程重挂**：重放读持久化的 `.events.jsonl`（轮询/通知），**不依赖原 SSE 请求里的内存 queue**（原请求可能已随进程/连接消失）。
- 事件缓冲默认保留最近 ~200 条（`event_min_seq` 随滚动前移）。
- 前端"停止"按钮走 `/cancel`（§5），不只是断开 SSE。

---

## 6. 前端（复用现有面板，不加新窗口）

- **AI 面板**（主 run）：轨迹流 + "开始/停止"。到上限显示"(已暂停，可继续)" + **"▶ 继续"**（`/continue`）。"🔄 新会话"= fresh（提示"归档旧对话开新，不影响标注与批注"）。**刷新页面后用 `GET session` + SSE 重挂恢复进行中的 run**。
- **标注面板**（fork 批注）：每条 `source=ai` 标记下挂 💬 → 就地展开小对话流（走 `/ask` 带 `annotation_id`）。根标注被删 → 该对话流标灰只读（410）。
- **轨迹流 📌 行也挂 💬**，同样 fork。
- **note 回写**：对话归对话，AI 在 fork 的新判读**不自动改 note**，采纳与否用户手动。

---

## 7. 保证"知识一定沉淀"（不只靠 prompt）

### 7.1 prompt 强制落标注
> "每看清一处需关注的区域，**必须立即 `create_annotation`**，note 写一两句镜下所见。这是你唯一的长期记忆——上下文压缩后只有标注会被保留，不落标你就会忘记它。"

### 7.2 结构化 mark_observation + snapshot 守卫【v3 具体化，v4 覆盖同 bundle】
要求**每次 snapshot 后、下一次 goto 前，必须二选一**：`create_annotation`，或结构化 `mark_observation`（含 bbox、所见、"不需标注的理由"）。实现态：

```
pending_snapshot_review: {snapshot_id, bbox, image_ref}
```

- 成功 snapshot → 进入 pending 状态，记 `snapshot_id`。
- **守卫覆盖同一条 bundle【v4】**：模型可在一条 assistant 消息里同时返回 `snapshot` 和 `goto`——执行 snapshot 后它还没看到图，**同 bundle 后面的 `goto` 也必须拒绝**（一并写入"需先消化快照"的 tool result）。
- **pending review 期间拒绝**：`goto`、新的 `snapshot`、`finish`、以及纯文本结束（这些都不能在没消化当前快照前发生）。
- **`create_annotation` / `mark_observation` 的 schema 强制包含 `snapshot_id`**【v4】，且必须引用当前 pending 的 `snapshot_id`，否则拒绝。
- **关闭 pending 的明确动作【v4.1 改】**：一个 snapshot 允许多个 `create_annotation`（一处快照发现多个目标）。pending 由**独立的 `complete_snapshot_review` 工具**显式关闭（不复用 `mark_observation(final=true)`——已标注的图不属于"不需标注"，复用会让模型生成自相矛盾的内容）：
  ```
  complete_snapshot_review(
    snapshot_id,
    disposition: "annotated" | "no_annotation",
    summary,
    no_annotation_reason?      # 仅 disposition=no_annotation 时必填
  )
  ```
  `create_annotation` 不关闭 pending（允许继续对同一张图补标）；只有 `complete_snapshot_review` 关闭。
- **守卫只约束 main**（fork 没有 `create_annotation`，仅问答+看图，不进 pending）。
- `pending_snapshot_review` 进入 session schema / WAL（§4.1），崩溃恢复后仍处于 pending，模型下一步仍须先消化该快照。
- `mark_observation` 持久化到 session 的 `observations` 字段（§4.1），compact 摘要保留其坐标与结论。

### 7.3 人编辑 note 与 append-only 兼容【v3 强化】
- 不改 fork 的初始 spot 卡（历史不变）。
- 每次 `/ask` / `run` / `continue`：取 `change_seq > spot_cursor` 的变更，**追加一条 `spot_updated` / `spot_deleted` 消息**到历史尾部，再续跑/续聊；更新 `spot_cursor`。
- **`spot_updated` 携带完整当前 spot 快照**（bbox、note、revision、change_seq），不只描述 note——因为人工也可能改几何（几何变更同样递增 revision 与 change_seq）。

### 7.4 渐进导航：goto ±2 层 clamp + 快照坐标刻度尺
- 单次 `goto` 最多变 **±2 层**（`MAX_LEVEL_DELTA=2`，像真实显微镜物镜转盘）。超步长先夹步长（结果消息带警告"请渐进变倍"），再做有效层范围 clamp；仅超范围保持原"请求 level=… 已夹到有效层 …"句式。
- 快照图像顶缘/左缘带**青色 level-0 坐标刻度尺**（`_overlay_coord_ticks`，视觉尺子）：模型读图内特征坐标一律以刻度为准，倍率/bbox 仍走文本返回。
- 注入的标注线索（spot 索引 / `spot_updated` / fork spot 卡）统一写明**左上角坐标 + 中心坐标**，goto 看线索用中心坐标——否则视野偏半格，目标落到右下角（"导航偏移"的根因）。

---

## 8. 默认参数与已定稿开放点

### 8.1 默认参数
| 参数 | 默认 | 说明 |
|---|---|---|
| `max_steps` | 50 | 单轮步数上限（暂停可继续；ai_config.json 可覆盖） |
| `context_window_tokens` | 272000 | compact 触发窗口（保守，§3.6） |
| `reserve_tokens` | 16000 | 摘要 prompt+输出预留（只减一次） |
| `safety_margin` | 8192 | 防估算误差顶爆 |
| `keep_recent_tokens` | 20000 | compact 后保留原文 token（按完整 bundle 切） |
| fork 活跃上限 / 切片 | 20 | 超出归档（不硬删；running 不归档） |
| 租约 TTL | 150s | 须 ≥ 模型超时（120s）+余量；heartbeat 独立线程续租 |
| SSE 事件缓冲 | 最近 ~200 条 | `.events.jsonl` 滚动窗口，断线重挂重放用 |

### 8.2 gpt-5.6-luna 窗口 → §3.6（272k 保守 + 可上调 + context_length_exceeded 重试）
### 8.3 fork 初始图【v2】：附图，bbox 外扩 10–20%，输出 1024–1568px，存 image_ref。
### 8.4 spot 索引注入【v3 用 change_seq】：
- **compact 后**：注入一次完整 canonical spot 索引（全量、文本、无图）。
- **每次 run/continue/ask**：只追加 `change_seq > spot_cursor` 的变更（`spot_updated`/`spot_deleted`），没变化不重复注入。

---

## 9. 缓存友好总结

- 历史 append-only，只有到阈值才 compact（低频），平时前缀稳定命中缓存。
- 阈值内保留全部图（§3.2），恢复时物化全部未 compact 图（§3.3），不在历史中间制造随机断点；恢复边界的一次性失效是明确的。
- fork 线程前缀（system + spot 卡）高度稳定，同线程反复聊命中极好。
- 最新 snapshot 图放消息末尾；§7 引导"看清就标注、别反复截同一区域"，减少新图产出。
- spot 变更用 `change_seq` 增量注入（§8.4），不破坏前缀。

---

## 10. 版本小结

- **v2**：补齐续跑状态（agent_state）、稳定标注 ID、图像策略（阈值内全留图）、compact 唯一公式、状态机/幂等初版、fresh/fork 边界。
- **v3**：收紧 3 个并发/存储 P0——① `change_seq`+tombstone 追踪多 ROI 变更；② canonical/request 消息分离统一图像恢复语义；③ WAL `pending_bundle` 幂等防跨文件崩溃。补运行语义（租约/原子抢占/cancel 端点/SSE 后台继续+重挂/session detail 端点）、snapshot 守卫具体化、权限与锁修正、ROI 迁移策略、token 估算来源、spot_updated 携带完整快照。
- **v4**：锁死 2 个并发/协议 P0——① 租约加单调 fencing token `lease_epoch`；② 统一用户取消与 WAL 崩溃恢复语义（含 finish 回写 tool result）。补 4 个实现契约：snapshot 守卫覆盖同 bundle、`change_seq` 存储/清理、SSE event log 独立持久化、SessionRunner 接口。
- **v4.1**：补 fencing 与副作用的原子耦合不变量（固定锁序 `session.lock → share_store lock`，校验 active_run_id+lease_epoch+未过期与 effect_key 幂等+ROI 写入在同一临界区；heartbeat 不续活过期 lease，过期只能重新 CAS+递增 epoch）；snapshot review 收口改独立 `complete_snapshot_review`（`disposition: annotated|no_annotation`，仅后者强制 reason）；event log 崩溃后扫描尾部修复 `last_event_seq/event_min_seq`。

**全部 P0 已在编码前写死，可交给 coder。核心架构（知识分层 / compact / fork / ROI 变更模型）自 v3 起稳定，v4/v4.1 未改动主架构。**

**建议实施顺序**：先做存储迁移（ROI 补 annotation_id/change_seq/source、index/session schema）与 SessionRunner 单元测试（fencing/WAL/幂等/租约），再接 agent loop，最后接前端——返工风险最低。
