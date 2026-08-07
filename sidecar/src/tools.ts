/**
 * AI reading assistant sidecar — domain tools (Step 2 of the pi migration).
 *
 * This module ports the six OpenAI function-calling tools from
 * ``ai_agent.py`` (TOOLS schema L180-314, _execute_tool L743-962) into pi
 * {@link AgentTool} definitions. Each tool is a faithful port: numeric
 * constants (MAX_LEVEL_DELTA, 64..4096 clamp, 95% coverage tolerance), guards
 * (pending-snapshot gating, fork no-annotate, no-op goto), and the Chinese
 * user-facing copy are kept verbatim so behavior is unchanged.
 *
 * Reference line numbers throughout this file point at ai_agent.py.
 *
 * Layout:
 *   - AgentState helpers (viewport_bbox, pick_overview_level, magnification_*)
 *   - ToolContext (session store + slide info + flask client + emit)
 *   - createTools(): goto / snapshot / mark_observation / create_annotation /
 *     complete_snapshot_review / finish
 */
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { SessionStore, SessionData, PendingSnapshotReview } from "./session-store.js";
import type { FlaskClient, RegionResult, RoiDict } from "./flask-client.js";

// =========================================================================== //
// Constants (ai_agent.py:33)
// =========================================================================== //

/** 单次 goto 最多变的金字塔层数（像真实显微镜物镜转盘，禁止跨层盲跳）。 */
const MAX_LEVEL_DELTA = 2;

// =========================================================================== //
// AgentState (in-memory only; persisted via SessionStore.agent_state)
// =========================================================================== //

/**
 * Virtual microscope viewport state. Pure in-memory description of "where the
 * viewport is in level-0 pixels and how zoomed it is" — mirrors
 * ai_agent.py:39 AgentState. Persisted/loaded via {@link SessionStore} using
 * the snake_case on-disk shape (center_x/center_y/pyramid_level/viewport_px).
 */
export class AgentState {
	centerX: number;
	centerY: number;
	viewportPx: number;
	pyramidLevel: number;
	mpp: number | null;

	constructor(centerX: number, centerY: number, viewportPx: number, pyramidLevel: number, mpp: number | null = null) {
		this.centerX = +centerX;
		this.centerY = +centerY;
		this.viewportPx = viewportPx | 0;
		this.pyramidLevel = pyramidLevel | 0;
		this.mpp = mpp;
	}

	/**
	 * Return the level-0 region the viewport covers {x,y,w,h} (ai_agent.py:54).
	 *
	 * viewport output pixels are fixed (viewportPx); the covered level-0 span
	 * scales with pyramidLevel: ds = level_downsamples[level], covered side =
	 * viewportPx * ds. Centered on centerX/centerY.
	 */
	viewportBbox(levelDownsamples: readonly number[]): { x: number; y: number; w: number; h: number } {
		const lvl = this.effectiveLevel(levelDownsamples);
		let ds = 1.0;
		if (levelDownsamples.length) {
			ds = Number(levelDownsamples[lvl]) || 1.0;
		}
		const side = Math.max(1, this.viewportPx * ds);
		const x = this.centerX - side / 2.0;
		const y = this.centerY - side / 2.0;
		return {
			x: Math.round(x),
			y: Math.round(y),
			w: Math.round(side),
			h: Math.round(side),
		};
	}

	/** Clamp pyramidLevel to a valid pyramid index (incl. 0) (ai_agent.py:71). */
	effectiveLevel(levelDownsamples: readonly number[]): number {
		if (!levelDownsamples.length) return 0;
		return Math.max(0, Math.min(this.pyramidLevel | 0, levelDownsamples.length - 1));
	}

	/**
	 * Explicit magnification label that a weak model can't misread as a level
	 * (ai_agent.py:77). base = 10/mpp; actual = base/ds. Falls back to a
	 * "Nx downsample"-style label when mpp is unknown.
	 */
	magnificationLabel(levelDownsamples: readonly number[]): string {
		const lvl = this.effectiveLevel(levelDownsamples);
		let ds = 1.0;
		if (levelDownsamples.length) {
			ds = Number(levelDownsamples[lvl]) || 1.0;
		}
		if (this.mpp && this.mpp > 0) {
			const base = 10.0 / this.mpp;
			const mag = ds > 0 ? base / ds : base;
			const tier = magTier(mag, base);
			if (mag < 1) {
				return `${mag.toFixed(1)}x（${tier}，level=${lvl}）`;
			}
			return `${Math.round(mag)}x（${tier}，level=${lvl}）`;
		}
		return `level=${lvl}（level 越大倍率越低）`;
	}

	/**
	 * Pick the lowest-magnification level that still basically covers the whole
	 * slide (ai_agent.py:98). 5% tolerance: a strict full-cover is all-or-
	 * nothing — being 0.8% short would drop a whole level.
	 */
	static pickOverviewLevel(width: number, height: number, levelDownsamples: readonly number[], viewportPx: number): number {
		if (!levelDownsamples.length) return 0;
		const need = Math.max(width, height) * 0.95;
		for (let lvl = 0; lvl < levelDownsamples.length; lvl++) {
			const ds = Number(levelDownsamples[lvl]) || 1.0;
			if (viewportPx * ds >= need) return lvl;
		}
		return levelDownsamples.length - 1;
	}

	/** Serialize to the on-disk snake_case shape (ai_agent.py:120). */
	toDict(): { center_x: number; center_y: number; pyramid_level: number; viewport_px: number } {
		return {
			center_x: this.centerX,
			center_y: this.centerY,
			pyramid_level: this.pyramidLevel,
			viewport_px: this.viewportPx,
		};
	}

	/** Load from the on-disk snake_case shape (ai_agent.py:128). */
	static fromDict(d: { center_x?: number; center_y?: number; pyramid_level?: number; viewport_px?: number } | null | undefined, mpp: number | null = null): AgentState {
		d = d || {};
		return new AgentState(
			Number(d.center_x || 0),
			Number(d.center_y || 0),
			Number(d.viewport_px || 1024) | 0,
			Number(d.pyramid_level || 0) | 0,
			mpp,
		);
	}
}

/**
 * Magnification tier label, with a note on its position relative to the
 * slide's level-0 (ai_agent.py:140 _mag_tier).
 */
function magTier(mag: number, baseMag: number | null = null): string {
	if (baseMag && baseMag >= 30 && mag < baseMag * 0.75 && mag >= 12) {
		return "中低倍";
	}
	if (mag >= 30) return "高倍";
	if (mag >= 15) return "中低倍";
	if (mag >= 5) return "低倍";
	return "全片概览";
}

/**
 * Deterministic per-slide magnification table so the model doesn't guess
 * magnification from the level number (ai_agent.py:153 magnification_guide).
 */
export function magnificationGuide(info: { level_downsamples?: readonly number[]; mpp?: number | null }): string {
	const downsamples = info.level_downsamples && info.level_downsamples.length ? info.level_downsamples : [1.0];
	const mpp = info.mpp;
	if (!mpp || +mpp <= 0) {
		const levels = downsamples.map((ds, i) => `level ${i}=downsample ${formatG(Number(ds) || 1.0)}`);
		return "倍率规则：level 0 是最高倍率/最高分辨率，level 越大倍率越低；" + levels.join("；") + "。";
	}
	const base = 10.0 / +mpp;
	const levels = downsamples.map((rawDs, i) => {
		const ds = Number(rawDs) || 1.0;
		const mag = base / ds;
		if (mag < 1) {
			return `level ${i}≈${mag.toFixed(1)}x（${magTier(mag, base)}）`;
		}
		return `level ${i}≈${Math.round(mag)}x（${magTier(mag, base)}）`;
	});
	return "本片倍率规则：" + levels.join("；") + `。level 0 最高倍，越大越低倍；本片 level 0≈${Math.round(base)}x 为高倍，约 20x 只算中低倍。`;
}

/** Format a downsample with the same precision as Python `{:g}` (best effort). */
function formatG(v: number): string {
	if (!Number.isFinite(v)) return String(v);
	// Mimic %g: up to 6 significant digits, strip trailing zeros.
	const fixed = parseFloat(v.toPrecision(6)).toString();
	return fixed;
}

// =========================================================================== //
// ToolContext
// =========================================================================== //

/** Slide geometry/identity as fetched once via FlaskClient.slideInfo. */
export interface SlideInfo {
	width: number;
	height: number;
	levelDownsamples: number[];
	mpp: number | null;
	fingerprint: string;
}

export type EmitFn = (type: string, payload: Record<string, unknown>) => void | Promise<void>;

/**
 * Context shared by all tools in one session (the agent loop creates one
 * ToolContext per run). Holds the session store/id for persistence, the slide
 * info, the Flask callback client, and an emit() for trajectory events.
 */
export interface ToolContext {
	sessionStore: SessionStore;
	sessionId: string;
	/** "main" | "fork" (fork disallows create_annotation). */
	kind: "main" | "fork";
	slide: string;
	slideInfo: SlideInfo;
	flask: FlaskClient;
	/** Emit a trajectory event (tool_started, snapshot_captured, ...). */
	emit: EmitFn;
	cfg: {
		max_steps?: number;
		[k: string]: unknown;
	};
}

// =========================================================================== //
// Internal helpers (mirror ai_agent.py)
// =========================================================================== //

/** Clamp a pyramid level request to [0, n-1] (ai_agent.py:726). */
function clampPyramidLevel(level: number, levelDownsamples: readonly number[]): number {
	if (!levelDownsamples.length) return 0;
	return Math.max(0, Math.min(level | 0, levelDownsamples.length - 1));
}

/**
 * Parse goto.level: distinguish "absent" from a valid 0 (ai_agent.py:733).
 * Python uses `or`-safe checks; here we check presence explicitly.
 */
function parseGotoLevel(level: unknown, defaultLevel: number): number {
	if (level === undefined || level === null) return defaultLevel | 0;
	const n = Number(level);
	if (!Number.isFinite(n)) return defaultLevel | 0;
	return n | 0;
}

/** Safe number coercion, 0 on failure (ai_agent.py:977 _to_num). */
function toNum(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0.0;
}

/** Build a single text content block. */
function text(t: string): TextContent {
	return { type: "text", text: t };
}

/** Build a single image content block from a Flask region result. */
function image(b64: string, mime: string): ImageContent {
	return { type: "image", data: b64, mimeType: mime };
}

/**
 * Bundle-seq counter for effect_key uniqueness. Single Node process, so an
 * in-memory counter per ToolContext is sufficient (matches the spec note:
 * "bundleSeq 用会话内递增计数，存内存即可——单进程").
 */
let bundleSeq = 0;
function nextBundleSeq(): number {
	bundleSeq += 1;
	return bundleSeq;
}

/**
 * Format a number the way Python `{:.0f}` does (round half away from zero to int).
 * JS Math.round rounds half toward +Infinity; Python rounds half to even, but for
 * the coordinate ranges here the difference is immaterial and ai_agent.py uses
 * round() on floats that are almost never exactly .5. We use Math.round.
 */
function fmt0(v: number): string {
	return String(Math.round(v));
}

// =========================================================================== //
// createTools
// =========================================================================== //

/**
 * Build the pi AgentTool array for one session. The set depends on kind:
 * fork sessions omit create_annotation (ai_agent.py:307 tools_for_kind).
 *
 * Tool schemas (Chinese descriptions) are copied verbatim from ai_agent.py
 * L180-304. Guards (pending-snapshot gating, no-op goto, fork no-annotate) are
 * preserved byte-for-byte in their return strings.
 */
export function createTools(ctx: ToolContext): AgentTool<any, any>[] {
	const { slideInfo } = ctx;
	const downsamples = slideInfo.levelDownsamples;

	// In-memory mutable viewport state. Initialized from the persisted
	// agent_state; tools mutate it and write it back to the session.
	const stateHolder: { st: AgentState } = {
		st: new AgentState(0, 0, 1024, 0, slideInfo.mpp),
	};

	// We lazy-load the persisted agent_state on the first tool call so tests
	// that construct a ToolContext without a pre-existing session still work.
	let stateLoaded = false;
	async function ensureStateLoaded(): Promise<void> {
		if (stateLoaded) return;
		stateLoaded = true;
		const data = await ctx.sessionStore.readSession(ctx.sessionId);
		if (data) {
			stateHolder.st = AgentState.fromDict(data.agent_state, slideInfo.mpp);
		}
	}
	async function persistState(): Promise<void> {
		const data = await ctx.sessionStore.readSession(ctx.sessionId);
		if (!data) return;
		data.agent_state = stateHolder.st.toDict();
		data.updated_at = Math.floor(Date.now() / 1000);
		await ctx.sessionStore.writeSession(ctx.sessionId, data);
	}

	// Pending-snapshot helpers (read/write session.pending_snapshot_review).
	async function getPending(): Promise<PendingSnapshotReview | null> {
		const data = await ctx.sessionStore.readSession(ctx.sessionId);
		return data ? data.pending_snapshot_review : null;
	}
	async function setPending(p: PendingSnapshotReview | null): Promise<void> {
		const data = await ctx.sessionStore.readSession(ctx.sessionId);
		if (!data) return;
		data.pending_snapshot_review = p;
		data.updated_at = Math.floor(Date.now() / 1000);
		await ctx.sessionStore.writeSession(ctx.sessionId, data);
	}
	async function addObservation(obs: Record<string, unknown>): Promise<void> {
		const data = await ctx.sessionStore.readSession(ctx.sessionId);
		if (!data) return;
		data.observations = data.observations || [];
		data.observations.push(obs);
		data.updated_at = Math.floor(Date.now() / 1000);
		await ctx.sessionStore.writeSession(ctx.sessionId, data);
	}
	async function readSession(): Promise<SessionData | null> {
		return ctx.sessionStore.readSession(ctx.sessionId);
	}

	// ------------------------------------------------------------------------- //
	// goto (ai_agent.py:185 schema, L753-814 execute)
	// ------------------------------------------------------------------------- //
	const gotoTool: AgentTool<any, any> = {
		name: "goto",
		label: "移动视口",
		description:
			"把虚拟显微镜移到指定 level-0 坐标与金字塔层级。" +
			"单次最多变 ±2 层（像物镜转盘），超出会被夹取并提示。" +
			"放大=level 减 1~2，缩小=level 加 1~2。" +
			"reason 简述为何看这里。",
		parameters: Type.Object({
			x: Type.Number({ description: "level-0 像素 X（中心）" }),
			y: Type.Number({ description: "level-0 像素 Y（中心）" }),
			level: Type.Integer({ description: "金字塔层级（0 最高倍，越大越低倍）" }),
			reason: Type.Optional(Type.String({ description: "为何移动到此处的简短理由" })),
		}),
		async execute(toolCallId, params): Promise<AgentToolResult<any>> {
			await ensureStateLoaded();
			const st = stateHolder.st;
			const args = params as { x?: number; y?: number; level?: number; reason?: string };

			// Pending snapshot guard (ai_agent.py:754).
			if (await getPending()) {
				return okText("需先消化当前快照：调用 complete_snapshot_review（或先 create_annotation/mark_observation）后再移动。");
			}

			const gx = toNum(args.x);
			const gy = toNum(args.y);
			const requested = parseGotoLevel(args.level, st.pyramidLevel);
			// Normalize stale/out-of-range persisted level before no-op check.
			const prevEff = st.effectiveLevel(downsamples);
			if (st.pyramidLevel !== prevEff) st.pyramidLevel = prevEff;

			// Step clamp: ±MAX_LEVEL_DELTA per goto (ai_agent.py:766).
			const cur = st.pyramidLevel;
			let stepReq: number;
			let stepNote = "";
			if (Math.abs(requested - cur) > MAX_LEVEL_DELTA) {
				stepReq = cur + (requested > cur ? MAX_LEVEL_DELTA : -MAX_LEVEL_DELTA);
				stepNote = `单次 goto 最多变 2 层（当前 level=${cur}）；请求 level=${requested} 已夹到 ${stepReq}。请渐进变倍：确认本层视野后再继续。`;
			} else {
				stepReq = requested;
			}
			const glvl = clampPyramidLevel(stepReq, downsamples);

			const sameXy = Math.round(gx) === Math.round(st.centerX) && Math.round(gy) === Math.round(st.centerY);
			const sameLvl = glvl === st.pyramidLevel;
			if (sameXy && sameLvl) {
				const mag = st.magnificationLabel(downsamples);
				if (requested !== glvl) {
					return okText(
						`已在目标位置 (${fmt0(st.centerX)},${fmt0(st.centerY)})（${mag}）。` +
							`请求 level=${requested} 已夹到有效层 ${glvl}；请改换坐标或切换其他 level，不要重复相同的 goto。`,
					);
				}
				return okText(
					`已在目标位置 (${fmt0(st.centerX)},${fmt0(st.centerY)})（${mag}）。` +
						"请改换坐标、切换其他 level，或直接 snapshot / 继续判读，不要重复相同的 goto。",
				);
			}

			st.centerX = gx;
			st.centerY = gy;
			st.pyramidLevel = glvl;
			const mag = st.magnificationLabel(downsamples);

			// Emit tool_started (ai_agent.py:794).
			await ctx.emit("tool_started", {
				tool: "goto",
				x: st.centerX,
				y: st.centerY,
				level: st.pyramidLevel,
				magnification: mag,
				reason: args.reason || "",
				requested_level: requested,
			});

			// Note assembly (ai_agent.py:804).
			const reqOutOfRange = clampPyramidLevel(requested, downsamples) !== requested;
			let note = "";
			if (stepNote && reqOutOfRange) {
				note = `（${stepNote}；请求 level=${requested} 已夹到有效层 ${glvl}）`;
			} else if (stepNote) {
				note = `（${stepNote}）`;
			} else if (requested !== glvl) {
				note = `（请求 level=${requested} 已夹到有效层 ${glvl}）`;
			}

			await persistState();
			return okText(`已移动到 (${fmt0(st.centerX)},${fmt0(st.centerY)})，当前 ${mag}${note}。`);
		},
	};

	// ------------------------------------------------------------------------- //
	// snapshot (ai_agent.py:204 schema, L816-875 execute)
	// ------------------------------------------------------------------------- //
	const snapshotTool: AgentTool<any, any> = {
		name: "snapshot",
		label: "抓快照",
		description: "抓取当前视野的快照图像回喂给你。看清细节时调用。",
		parameters: Type.Object({
			out_w: Type.Optional(Type.Integer({ description: "输出宽度像素（建议 ≤1568）" })),
			out_h: Type.Optional(Type.Integer({ description: "输出高度像素（建议 ≤1568）" })),
		}),
		async execute(toolCallId, params): Promise<AgentToolResult<any>> {
			await ensureStateLoaded();
			const st = stateHolder.st;
			const args = params as { out_w?: number; out_h?: number };

			// Pending snapshot guard (ai_agent.py:817).
			if (await getPending()) {
				return okText("需先消化当前快照后再抓新快照。");
			}

			let ow = Number(args.out_w) || st.viewportPx;
			let oh = Number(args.out_h) || st.viewportPx;
			ow = Math.max(64, Math.min(ow, 4096));
			oh = Math.max(64, Math.min(oh, 4096));

			const bb = st.viewportBbox(downsamples);
			let r: RegionResult;
			try {
				r = await ctx.flask.region({
					slide: ctx.slide,
					x: bb.x,
					y: bb.y,
					w: bb.w,
					h: bb.h,
					out_w: ow,
					out_h: oh,
				});
			} catch (e) {
				return okText(`抓取快照失败：${(e as Error).message || e}`);
			}

			const imgB64 = r.image_base64 || "";
			const src = (r.src as { x: number; y: number; w: number; h: number }) || bb;
			const mag = st.magnificationLabel(downsamples);

			// Emit snapshot_captured (ai_agent.py:836).
			await ctx.emit("snapshot_captured", {
				bboxLevel0: src,
				magnification: mag,
				out_w: r.width,
				out_h: r.height,
			});

			// Enter pending snapshot state (ai_agent.py:841).
			const imageRef = {
				type: "image_ref" as const,
				ref_id: `ref_${toolCallId}`,
				slide_fingerprint: slideInfo.fingerprint || "",
				src,
				magnification: mag,
				summary: "",
			};
			const pending: PendingSnapshotReview = {
				snapshot_id: toolCallId,
				bbox: src,
				image_ref: imageRef,
			};
			await setPending(pending);

			// Tool text with coverage-tier hint (ai_agent.py:849).
			let toolText = `快照区域 level-0 bbox=${src.x},${src.y},${src.w},${src.h}，放大 ${mag}，`;
			const slideW = +slideInfo.width || 0;
			const bw = +src.w || 0;
			const cov = slideW > 0 && bw > 0 ? (bw / slideW) * 100.0 : 0.0;
			let hint: string;
			if (cov > 90) {
				hint = "全片概览级：选定候选区，消化本快照后 goto 该处并降 1-2 级放大。";
			} else if (cov > 40) {
				hint = "低倍：看到目标就消化本快照、goto 其坐标并降 1-2 级确认。";
			} else if (cov > 0 && cov < 15) {
				hint = "高倍：目标清晰即可 create_annotation 落标，不必再放大。";
			} else {
				hint = "中倍：目标清晰可标注；否则消化后继续降 1-2 级。";
			}
			toolText += `覆盖全片约 ${cov.toFixed(1)}%。${hint}`;

			return {
				content: [text(toolText), image(imgB64, r.mime || "image/jpeg")],
				details: {
					snapshot_id: toolCallId,
					src,
					magnification: mag,
					width: r.width,
					height: r.height,
					slide_fingerprint: slideInfo.fingerprint || "",
				},
			};
		},
	};

	// ------------------------------------------------------------------------- //
	// mark_observation (ai_agent.py:222 schema, L877-904 execute)
	// ------------------------------------------------------------------------- //
	const markObservationTool: AgentTool<any, any> = {
		name: "mark_observation",
		label: "记录观察",
		description: "记录对当前快照的一条观察（写入轨迹，不落标记）。",
		parameters: Type.Object({
			x: Type.Optional(Type.Number({ description: "观察区域 level-0 X（左上）" })),
			y: Type.Optional(Type.Number({ description: "观察区域 level-0 Y（左上）" })),
			w: Type.Optional(Type.Number({ description: "观察区域宽度" })),
			h: Type.Optional(Type.Number({ description: "观察区域高度" })),
			label: Type.String({ description: "简短标题" }),
			note: Type.Optional(Type.String({ description: "镜下所见描述" })),
		}),
		async execute(toolCallId, params): Promise<AgentToolResult<any>> {
			const args = params as { x?: number; y?: number; w?: number; h?: number; label?: string; note?: string };

			const pending = await getPending();
			const snapId = pending ? pending.snapshot_id : "";
			if (!snapId) {
				return okText("当前没有待消化的快照；请先 snapshot。");
			}

			const label = args.label || "";
			const note = args.note || "";
			const x = toNum(args.x);
			const y = toNum(args.y);
			const w = toNum(args.w);
			const h = toNum(args.h);
			const obs = {
				label,
				note,
				bbox: { x, y, w, h },
				no_annotation_reason: "",
				snapshot_id: snapId,
				ts: Date.now() / 1000,
			};
			await addObservation(obs);

			// Emit observation (ai_agent.py:899).
			await ctx.emit("observation", {
				label,
				note,
				no_annotation_reason: (obs as { no_annotation_reason: string }).no_annotation_reason || "",
				bbox: (obs as { bbox: unknown }).bbox || {},
			});

			return okText(`已记录观察：${label}`);
		},
	};

	// ------------------------------------------------------------------------- //
	// create_annotation (ai_agent.py:244 schema, L906-934 execute)
	// ------------------------------------------------------------------------- //
	const createAnnotationTool: AgentTool<any, any> = {
		name: "create_annotation",
		label: "落标注",
		description:
			"在切片上落一个矩形标注（写入标注库，管理员可见可编辑）。" +
			"看清需要关注的目标时调用，一次一个。坐标为 level-0 像素。",
		parameters: Type.Object({
			label: Type.String({ description: "标注标题/标签" }),
			x: Type.Number({ description: "矩形左上角 level-0 X" }),
			y: Type.Number({ description: "矩形左上角 level-0 Y" }),
			side_px: Type.Integer({ description: "矩形边长（level-0 像素，1~40000）" }),
			note: Type.Optional(Type.String({ description: "备注：镜下所见与是否需关注" })),
		}),
		async execute(toolCallId, params): Promise<AgentToolResult<any>> {
			const args = params as { label?: string; x?: number; y?: number; side_px?: number; note?: string };

			// fork disallow (ai_agent.py:907).
			if (ctx.kind === "fork") {
				return okText("fork 会话不允许 create_annotation（批注只做问答，不改标注库）。");
			}

			const pending = await getPending();
			const snapId = pending ? pending.snapshot_id : "";
			if (!snapId) {
				return okText("当前没有待消化的快照；请先 snapshot。");
			}

			const alabel = args.label || "AI 建议";
			const ax = toNum(args.x);
			const ay = toNum(args.y);
			let aside = parseInt(String(args.side_px || 0), 10);
			if (!Number.isFinite(aside)) aside = 0;
			aside = Math.max(1, Math.min(aside, 40000));
			const anote = args.note || "";

			// effect_key = sessionId:bundleSeq:toolCallId (idempotency).
			const seq = nextBundleSeq();
			const effectKey = `${ctx.sessionId}:${seq}:${toolCallId}`;

			let roi: RoiDict | null = null;
			try {
				roi = await ctx.flask.annotate({
					slide: ctx.slide,
					label: alabel,
					x: ax,
					y: ay,
					side_px: aside,
					note: anote,
					effect_key: effectKey,
					session_id: ctx.sessionId,
				});
			} catch (e) {
				return okText(`落标注失败：${(e as Error).message || e}`);
			}

			const index = roi && typeof roi.index === "number" ? roi.index : -1;
			// Emit annotation_created (ai_agent.py:927).
			await ctx.emit("annotation_created", {
				label: alabel,
				x: ax,
				y: ay,
				side_px: aside,
				note: anote,
				index,
				annotation_id: roi ? roi.annotation_id : null,
			});

			return okText(
				`已落标注「${alabel}」于左上角 (${fmt0(ax)},${fmt0(ay)}) 边长 ${aside} 像素（中心 (${fmt0(ax + aside / 2.0)},${fmt0(ay + aside / 2.0)})）。`,
			);
		},
	};

	// ------------------------------------------------------------------------- //
	// complete_snapshot_review (ai_agent.py:267 schema, L936-959 execute)
	// ------------------------------------------------------------------------- //
	const completeSnapshotReviewTool: AgentTool<any, any> = {
		name: "complete_snapshot_review",
		label: "关闭快照判读",
		description:
			"关闭当前快照的判读（服务端跟踪当前快照，无需传 id）。" +
			"annotated=已落标注；no_annotation=无需标注。",
		parameters: Type.Object({
			disposition: Type.Union([Type.Literal("annotated"), Type.Literal("no_annotation")]),
			summary: Type.Optional(Type.String({ description: "对这张图的判读小结（可空：缺省时服务端取本次观察的 note）" })),
			no_annotation_reason: Type.Optional(Type.String({ description: "仅 disposition=no_annotation 时给" })),
		}),
		async execute(toolCallId, params): Promise<AgentToolResult<any>> {
			const args = params as { disposition?: string; summary?: string; no_annotation_reason?: string };

			const pending = await getPending();
			const snapId = pending ? pending.snapshot_id : "";
			if (!snapId) {
				return okText("当前没有待消化的快照；请先 snapshot。");
			}

			const disposition = args.disposition || "";
			if (disposition !== "annotated" && disposition !== "no_annotation") {
				return okText("disposition 必须是 annotated 或 no_annotation。");
			}
			if (disposition === "no_annotation" && !(args.no_annotation_reason || "").trim()) {
				return okText("disposition=no_annotation 时请给 no_annotation_reason（一句话即可，如：导航确认 / 无明确异常）。");
			}

			let summary = (args.summary || "").trim();
			if (!summary) {
				// Fallback: take the latest observation's note/label for this snapshot.
				const data = await readSession();
				const observations = (data && data.observations) || [];
				for (let i = observations.length - 1; i >= 0; i--) {
					const o = observations[i] as { snapshot_id?: string; note?: string; label?: string };
					if (o.snapshot_id === snapId) {
						summary = o.note || o.label || "";
						break;
					}
				}
			}

			await setPending(null);

			// Emit snapshot_reviewed (ai_agent.py:954).
			await ctx.emit("snapshot_reviewed", {
				snapshot_id: snapId,
				disposition,
				summary,
				no_annotation_reason: args.no_annotation_reason || "",
			});

			return okText(`已关闭快照 ${snapId}（${disposition}）。`);
		},
	};

	// ------------------------------------------------------------------------- //
	// finish (ai_agent.py:290 schema, L750-751 execute)
	// ------------------------------------------------------------------------- //
	const finishTool: AgentTool<any, any> = {
		name: "finish",
		label: "结束读片",
		description: "完成读片，给出总结。调用后 agent 结束循环。",
		parameters: Type.Object({
			summary: Type.String({ description: "整体读片总结（中文）" }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<any>> {
			const args = params as { summary?: string };
			return {
				content: [text("已结束")],
				details: { summary: args.summary || "" },
				terminate: true,
			};
		},
	};

	// Assemble the tool set: fork omits create_annotation (ai_agent.py:307).
	const tools: AgentTool<any, any>[] = [gotoTool, snapshotTool, markObservationTool];
	if (ctx.kind !== "fork") {
		tools.push(createAnnotationTool);
	}
	tools.push(completeSnapshotReviewTool);
	tools.push(finishTool);
	return tools;
}

/** Build a single-text success result. */
function okText(t: string): AgentToolResult<any> {
	return { content: [text(t)], details: {} };
}
