/**
 * AI reading assistant sidecar — system prompt + initial message builders
 * (Step 3 of the pi migration).
 *
 * SYSTEM_PROMPT (ai_agent.py:320-341) and DEFAULT_TASK (ai_agent.py:347-349)
 * are copied **verbatim** — Chinese user-facing copy is load-bearing for model
 * behavior and must not be edited. {@link makeMainMessages} and
 * {@link makeForkMessages} are faithful ports of ai_agent.py:352-416.
 *
 * The pi Agent carries the system prompt on its state (AgentState.systemPrompt),
 * not as a message in the transcript, so the builders here return only the
 * user-turn message(s); the caller passes the system prompt separately. This
 * differs from the Python original, which returned a `system` message first —
 * see {@link makeMainMessages} notes.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { magnificationGuide, type SlideInfo } from "./tools.js";
import type { ImageRefContent } from "./session-store.js";

// =========================================================================== //
// SYSTEM_PROMPT (ai_agent.py:320-341) — VERBATIM, do not edit.
// =========================================================================== //

export const SYSTEM_PROMPT = `你是控制虚拟显微镜的病理专家助手，通过工具在数字病理切片上移动视口、抓快照、记录观察、落标注并给出中文总结。

坐标与倍率：
- 所有坐标都是 level-0 像素（最高分辨率层的原始坐标）；goto 的 x,y 是视野中心。
- 倍率名称以用户消息里的本片倍率表为准：本片 level 0 才是高倍，约 20x/21x 只是中低倍。

读片节奏（建议）：
- 初始视野已是全片概览。先建立整体印象，再主动挑 1-3 个最可疑的灶性异常区逐级放大确认并标注，不要只停留在中低倍泛泛描述全片结构。
- 渐进变倍：单次 goto 建议只变 1~2 层（放大=level 减，缩小=level 加）；跨层盲跳会因坐标漂移落到空白区，超出时服务端会夹取并提示。
- 放大节奏：goto 到候选大致坐标 → snapshot 确认目标在视野 → 再降 1~2 级，直到目标清晰；需要细胞学证据时一直到 level 0。
- 快照图顶缘与左缘有青色 level-0 坐标刻度，从图上读坐标以刻度为准，不要凭感觉猜。
- 选点选灶性紫染密集/结构异常区；切片边缘大片均一浅色区（空白玻片、标签、折痕）不是线索。若进去发现视野大部分空白，退回上一层确认过的组织坐标换点。
- 多个目标逐个处理：标完一个先升回概览再找下一个；同一区域同一层级抓 1-2 张快照通常足够。

快照消化：
- 建议每抓一张快照就完成消化再移动：先 mark_observation 记镜下所见；需关注的区域用 create_annotation 落标（同一张图可标多个）；最后 complete_snapshot_review 关闭。没消化就移动时工具会拦下并告诉你怎么继续。
- 描述保持客观（结构、细胞形态、间质、炎症等），对肿瘤/炎症/退变/反应性改变保持鉴别中立；缺少高倍细胞学证据时不要优先归为肿瘤。标注 note 写所见与鉴别要点，不只写诊断结论。

其他：
- 「已有标注」是待复核线索，不是诊断事实；其位置坐标是矩形左上角（消息附中心坐标），去看它时 goto 中心坐标。
- goto 返回"已在目标位置"时，改换坐标或 level，不要重复同一 goto。
- 全部完成后调用 finish 给出中文总结。`;

// =========================================================================== //
// DEFAULT_TASK (ai_agent.py:347-349) — VERBATIM, do not edit.
// =========================================================================== //

export const DEFAULT_TASK =
	"客观扫读这张片：先低倍定位，再高倍确认；描述镜下所见，标出值得关注的区域并总结";

// =========================================================================== //
// FORK_LITE_SYSTEM_PROMPT — lite fork (批注小框纯解读对话).
//
// A fork (kind="fork") is now a lite Q&A session bound to an annotation: it
// registers NO tools, so the model cannot navigate / snapshot / mark / annotate
// / finish. It answers purely from the initial spot card + attached image and
// the subsequent conversation. Legacy fork transcripts that contain historical
// tool calls are preserved verbatim on resume; only NEW tool availability is
// removed. A plain-text turn ends the回合 naturally (agent_finished).
// =========================================================================== //

export const FORK_LITE_SYSTEM_PROMPT = `你是病理切片的批注解读助手，基于给定标注区域的图像与上下文回答用户的问题。

你的能力边界：
- 你只能基于本次对话已经给出的标注卡（位置、边长、原标注文案）和附图，以及后续用户的追问，做文本问答。
- 你不能导航、移动视野、抓快照、记录观察、落标注或结束读片——这些工具对你不可用。不要声称或暗示自己要去"看一下""放大确认"。
- 回答简明、聚焦用户的问题；对肿瘤/炎症/退变/反应性改变等保持鉴别中立，不要优先归为肿瘤。
- 缺少高倍细胞学证据或现有信息不足以判断时，直接说明"现有信息不足以判断"，不要臆测。
- 原标注文案是待复核线索，不是诊断事实；引用时请保持这一口径。`;

// =========================================================================== //
// Slide info shape used by the builders (a subset of SlideInfo + raw dict).
// =========================================================================== //

/**
 * The slide-info dict shape the builders read. Accepts both the canonical
 * {@link SlideInfo} (camelCase) and the Flask {@link SlideInfoResult}-style
 * snake_case dict, normalizing internally. Matches ai_agent.py:357-360 which
 * reads `info.get("width")` etc.
 */
export interface SlideInfoLike {
	width?: number;
	height?: number;
	level_downsamples?: readonly number[];
	levelDownsamples?: readonly number[];
	mpp?: number | null;
}

function readInfo(info: SlideInfoLike): {
	width: number;
	height: number;
	levelDownsamples: number[];
	mpp: number | null;
} {
	const downsamples = (info.level_downsamples ?? info.levelDownsamples ?? []).map((d) => Number(d) || 1.0);
	return {
		width: Math.max(0, Math.floor(Number(info.width) || 0)),
		height: Math.max(0, Math.floor(Number(info.height) || 0)),
		levelDownsamples: downsamples.length ? downsamples : [1.0],
		mpp: info.mpp == null ? null : Number(info.mpp) || null,
	};
}

/** Format mpp the way Python `"{:.4f}".format(mpp)` does (4 decimal places). */
function formatMpp(mpp: number | null): string {
	if (mpp == null || !Number.isFinite(mpp) || mpp <= 0) return "未知";
	return mpp.toFixed(4);
}

// =========================================================================== //
// makeMainMessages (ai_agent.py:352-375)
// =========================================================================== //

/**
 * Build the initial user-turn message for a fresh main session
 * (ai_agent.py:352-375 `make_main_messages`).
 *
 * Returns the **user message only** (no system message): the pi Agent holds the
 * system prompt on its state. The Python original returned a leading
 * `{role:"system", content: SYSTEM_PROMPT}` entry; here the caller sets
 * `agent.state.systemPrompt = SYSTEM_PROMPT` separately, which is the pi
 * idiom and keeps the system prompt out of the persisted transcript (it is
 * always re-derived from the current SYSTEM_PROMPT on resume — see
 * ai_session.py:747 `ensure_current_system_prompt`).
 *
 * `display_text` is a UI-only field (ai_session.py:1170 `_UI_ONLY_KEYS`): it
 * lets the frontend render a clean task bubble without the slide-meta preamble.
 * It is stripped before the message is sent to the model.
 */
export function makeMainMessages(args: {
	slideName: string;
	task?: string;
	info: SlideInfoLike;
}): { role: "user"; content: string; display_text: string; timestamp: number } {
	const { slideName, info } = args;
	const { width, height, levelDownsamples, mpp } = readInfo(info);
	const taskText = (args.task || "").trim() || DEFAULT_TASK;

	const guide = magnificationGuide({ level_downsamples: levelDownsamples, mpp });

	// ai_agent.py:365-372 — exact field order and separators.
	const content =
		`切片：${slideName}（${width}×${height} 像素，mpp=${formatMpp(mpp)}，金字塔 ${levelDownsamples.length} 层）。\n` +
		`${guide}\n` +
		`任务：${taskText}`;

	return {
		role: "user",
		content,
		display_text: taskText,
		timestamp: Date.now(),
	};
}

// =========================================================================== //
// makeForkMessages (ai_agent.py:378-416)
// =========================================================================== //

/**
 * A spot (ROI) dict as returned by FlaskClient. Mirrors the Python ROI dict
 * shape read by ai_agent.py:386-392.
 */
export interface SpotDict {
	annotation_id?: string;
	label?: string;
	note?: string;
	x?: number;
	y?: number;
	side_px?: number;
	size_mm?: number;
	[k: string]: unknown;
}

/**
 * Build the initial user-turn message for a fork session
 * (ai_agent.py:378-416 `make_fork_messages`).
 *
 * The fork user message is self-contained: a spot card (text) + an attached
 * image. The image is supplied either as an inline base64 {@link ImageContent}
 * block (preferred for the first model call, avoiding a separate materialize
 * step) or as an {@link ImageRefContent} placeholder (canonical persisted form).
 *
 * As with {@link makeMainMessages}, the system prompt is not included here;
 * the caller sets it on the pi Agent state.
 *
 * `display_text` carries the bare question for the UI bubble.
 */
export function makeForkMessages(args: {
	slideName: string;
	info: SlideInfoLike;
	spot: SpotDict;
	question?: string;
	imageRef?: ImageRefContent | null;
	imageB64?: string | null;
}): {
	role: "user";
	content: (TextContent | ImageContent | ImageRefContent)[];
	display_text: string;
	timestamp: number;
} {
	const { slideName, info, spot } = args;
	const geom = spot;
	const x = Math.trunc(Number(geom.x) || 0);
	const y = Math.trunc(Number(geom.y) || 0);
	const side = Math.trunc(Number(geom.side_px) || 0);
	const note = spot.note || "";
	const sizeMm = Number(spot.size_mm) || 0.0;
	const phys = sizeMm ? `，物理约 ${sizeMm.toFixed(1)} mm` : "";

	const guide = magnificationGuide({ level_downsamples: readInfo(info).levelDownsamples, mpp: readInfo(info).mpp });
	const question = args.question || "请谈谈这个区域";

	// ai_agent.py:393-405 — exact text, field order, and format specs.
	const spotText =
		`关于切片「${slideName}」的一处已标注区域（待复核线索，非诊断事实）：\n` +
		`位置 level-0 左上角 (${x}, ${y})，边长 ${side} 像素${phys}` +
		`（中心 (${x + (side >> 1)}, ${y + (side >> 1)})，goto 请对准中心）\n` +
		`原标注文案：「${note}」\n` +
		`${guide}\n` +
		`用户的问题：${question}`;

	const parts: (TextContent | ImageContent | ImageRefContent)[] = [{ type: "text", text: spotText }];
	if (args.imageB64) {
		parts.push({ type: "image", data: args.imageB64, mimeType: "image/jpeg" });
	} else if (args.imageRef) {
		parts.push(args.imageRef);
	}

	return {
		role: "user",
		content: parts,
		display_text: question,
		timestamp: Date.now(),
	};
}
