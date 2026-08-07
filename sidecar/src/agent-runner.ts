/**
 * AI reading assistant sidecar — pi Agent runner (Step 3, core).
 *
 * Wraps a pi {@link Agent} to drive a reading session and translate pi
 * lifecycle events into the SSE event vocabulary the frontend expects
 * (ai_agent.py:490 `run_agent` + app.py:1941 `_start_main_worker` /
 * 2012 `_start_fork_worker`).
 *
 * Run-level responsibilities (each aligned to the Python original):
 *   - **acquire** the session (409 on conflict) and emit the setup event
 *     (slide_opened / session_resumed / fork_created / fork_resumed);
 *   - drive the pi agent loop with the domain tools (tools.ts) and a
 *     transient-error-retrying streamFn wrapper;
 *   - map pi events to SSE events (agent_thinking / text_delta /
 *     agent_finished / agent_paused / agent_error / agent_retrying);
 *   - enforce max_steps (shouldStopAfterTurn) and the pending-snapshot
 *     plain-text guard (getFollowUpMessages);
 *   - persist transcript + agent_state + usage and transition status
 *     (finished/error/paused), which the SSE layer observes to emit
 *     session_ended.
 *
 * The runner is **async-fire**: run/continue/ask return `{sessionId}` as soon
 * as the session is acquired and the setup event emitted; the agent loop runs
 * in the background and reports completion via the event bus (the SSE stream
 * tails the bus and the session status).
 */
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { SYSTEM_PROMPT, DEFAULT_TASK, FORK_LITE_SYSTEM_PROMPT, makeMainMessages, makeForkMessages, type SpotDict } from "./prompts.js";
import { buildModel, type AiEngineConfig } from "./pi-model.js";
import {
	AgentState,
	createTools,
	type SlideInfo,
	type ToolContext,
} from "./tools.js";
import {
	SessionConflict,
	dehydrateMessages,
	type ImageMeta,
	type PersistedAgentMessage,
	type SessionData,
	type SessionStore,
} from "./session-store.js";
// Re-export so server.ts can catch it uniformly alongside RootAnnotationGone.
export { SessionConflict };
import type { FlaskClient, RegionResult, RoiDict } from "./flask-client.js";
import { SessionEventBus } from "./events.js";
import {
	buildSpotIndexMessage,
	checkShouldCompact,
	persistCompaction,
	prevCompactionInputs,
	resolveCompactionSettings,
	runCompaction,
	type ResolvedCompactionSettings,
} from "./compaction.js";
import {
	makeTransformContext,
	resolveTransformSettings,
} from "./transform-context.js";

// =========================================================================== //
// Public config / option types
// =========================================================================== //

/**
 * Per-run engine config + tuning knobs, injected by the caller (Flask proxy)
 * in the request body. The sidecar never reads ai_config.json itself.
 */
export interface RunConfig extends AiEngineConfig {
	/** Per-run step cap (ai_agent.py:504 default 50). */
	max_steps?: number;
	/** Active fork limit before oldest non-running fork is archived (app.py:1917). */
	fork_active_limit?: number;
	/** Max materialized images retained per request by transformContext (default 6). */
	keep_recent_images?: number;
	/** Tokens reserved for summary prompt + output in compaction (default 16384). */
	reserve_tokens?: number;
	/** Approximate recent-context tokens kept after compaction (default 20000). */
	keep_recent_tokens?: number;
	/** Legacy field (ai_session.py safety_margin); accepted but unused. */
	safety_margin?: number;
}

/** Common run arguments. `config` is required. */
export interface RunArgs {
	slide: string;
	config: RunConfig;
}

/** Inject a test streamFn into the runner (mock model). */
export interface AgentRunnerOverrides {
	/** Override the streamFn used by the pi Agent (tests pass a fake). */
	streamFn?: (model: unknown, context: unknown, options?: unknown) => AssistantMessageEventStream;
	/**
	 * Override the Models used by compaction's summarizer (tests pass a fake
	 * completeSimple). When unset, compaction uses the model's real registered
	 * catalog (buildModel). Production never sets this.
	 */
	compactionModels?: { completeSimple: (model: unknown, context: unknown, options?: unknown) => Promise<unknown> };
}

// =========================================================================== //
// Errors
// =========================================================================== //

/** Root annotation no longer exists (app.py:1705 returns 410). */
export class RootAnnotationGone extends Error {
	constructor(message = "该标注已删除") {
		super(message);
		this.name = "RootAnnotationGone";
	}
}

// =========================================================================== //
// AgentRunner
// =========================================================================== //

/**
 * One per sidecar process. Owns the {@link SessionStore}, the live
 * {@link SessionEventBus}, and the {@link FlaskClient}. Run methods are
 * async-fire: they acquire + emit setup + kick off the loop, then return.
 */
export class AgentRunner {
	readonly store: SessionStore;
	readonly bus: SessionEventBus;
	readonly flask: FlaskClient;
	private readonly overrides: AgentRunnerOverrides;
	/** Active agent per session, for cancel(). */
	private readonly activeAgents = new Map<string, Agent>();

	constructor(store: SessionStore, bus: SessionEventBus, flask: FlaskClient, overrides: AgentRunnerOverrides = {}) {
		this.store = store;
		this.bus = bus;
		this.flask = flask;
		this.overrides = overrides;
	}

	// ----------------------------------------------------------------------- //
	// run (fresh / reuse main) — app.py:1636 api_ai_run + 1941 _start_main_worker
	// ----------------------------------------------------------------------- //
	/**
	 * Start (or resume) the main session for a slide.
	 *
	 * - `fresh=true`: archive any existing main, create a new session, emit
	 *   `slide_opened` with the overview viewport, then run the loop from the
	 *   initial user task message.
	 * - `fresh=false` with an existing main: resume (continue) it.
	 * - `fresh=false` with no main: behave as fresh.
	 *
	 * Returns `{sessionId}` immediately; the loop runs in the background.
	 * Throws {@link SessionConflict} (409) if the main is already running.
	 */
	async runMain(args: RunArgs & { task?: string; fresh?: boolean }): Promise<{ sessionId: string }> {
		const { slide, config } = args;
		const fresh = args.fresh ?? false;

		// Resolve which session to run.
		let sessionId: string;
		let isContinue: boolean;
		if (fresh) {
			// Archive the old main slot (app.py:1655 fresh path).
			await this.archiveMainSlot(slide);
			const data = await this.store.acquire({ slide, kind: "main" });
			sessionId = data.id;
			isContinue = false;
		} else {
			const idx = await this.store.listBySlide(slide);
			const existing = idx.main;
			if (existing) {
				const data = await this.store.acquire({ sessionId: existing, slide, kind: "main" });
				sessionId = data.id;
				isContinue = true;
			} else {
				const data = await this.store.acquire({ slide, kind: "main" });
				sessionId = data.id;
				isContinue = false;
			}
		}

		// Kick off the loop without awaiting completion.
		void this.driveMain(sessionId, slide, config, args.task ?? "", isContinue).catch(async (e) => {
			await this.handleFatal(sessionId, e);
		});
		return { sessionId };
	}

	/** continue = runMain with fresh=false (app.py:1668). */
	async continueMain(args: RunArgs): Promise<{ sessionId: string }> {
		const idx = await this.store.listBySlide(args.slide);
		const sid = idx.main;
		if (!sid) {
			throw new SessionConflict("没有可继续的主会话");
		}
		return this.runMain({ ...args, fresh: false });
	}

	// ----------------------------------------------------------------------- //
	// ask (fork create/resume) — app.py:1687 api_ai_ask + 2012 _start_fork_worker
	// ----------------------------------------------------------------------- //
	/**
	 * Start or resume a **lite** fork for an annotation (批注小框纯解读对话).
	 *
	 * A fork (kind="fork") registers NO tools: the model answers purely from
	 * the spot card + attached image and the conversation. A plain-text turn
	 * ends the回合 naturally (agent_finished). Legacy forks with historical
	 * tool calls in their transcript are preserved on resume; only new tool
	 * availability is removed.
	 *
	 * - Root annotation gone → throws {@link RootAnnotationGone} (→ 410).
	 * - Existing fork for this annotation → resume it (append the question,
	 *   emit `fork_resumed`).
	 * - Otherwise: enforce the fork-active limit (archive oldest non-running),
	 *   create a new fork, emit `fork_created`, then run the loop.
	 *
	 * Returns `{sessionId}` immediately.
	 */
	async askFork(args: RunArgs & { annotationId: string; question?: string }): Promise<{ sessionId: string }> {
		const { slide, config, annotationId } = args;

		// Locate the root annotation via the spot change log (tombstone-aware).
		const roi = await this.findSpot(slide, annotationId);
		if (!roi || roi.deleted) {
			throw new RootAnnotationGone();
		}

		const idx = await this.store.listBySlide(slide);
		const existing = idx.forks[annotationId];

		if (existing) {
			// Resume: acquire, append the question, emit fork_resumed, run.
			const data = await this.store.acquire({ sessionId: existing, slide, kind: "fork", annotationId });
			const qText = args.question || "请谈谈这个区域";
			// Append the user question to the transcript (app.py:1720).
			const updated = await this.store.withLock(data.id, async (d) => {
				if (!d) return null;
				const msg: PersistedAgentMessage = {
					role: "user",
					content: qText,
					display_text: qText,
					timestamp: Date.now(),
				} as PersistedAgentMessage;
				d.messages = [...(d.messages || []), msg];
				d.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(data.id, d);
				return d;
			});
			void updated;
			await this.bus.emit(data.id, "fork_resumed", { session_id: data.id, annotation_id: annotationId });
			void this.driveFork(data.id, slide, config, annotationId).catch(async (e) => {
				await this.handleFatal(data.id, e);
			});
			return { sessionId: data.id };
		}

		// New fork: enforce the active limit (app.py:1726).
		const limit = Math.max(0, Math.floor(config.fork_active_limit ?? 20));
		await this.enforceForkLimit(slide, limit);

		const title = "批注@" + (roi.label || "");
		const data = await this.store.acquire({ slide, kind: "fork", annotationId, title });
		// seed spot_cursor (app.py:1739).
		await this.store.withLock(data.id, async (d) => {
			if (!d) return null;
			const spots = await this.flask.spots(slide, 0).catch(() => ({ changes: [], current_seq: 0 }));
			d.spot_cursor = spots.current_seq || 0;
			d.updated_at = Math.floor(Date.now() / 1000);
			await this.store.writeSession(data.id, d);
			return d;
		});

		await this.bus.emit(data.id, "fork_created", { annotation_id: annotationId, title });
		void this.driveFork(data.id, slide, config, annotationId, roi, args.question).catch(async (e) => {
			await this.handleFatal(data.id, e);
		});
		return { sessionId: data.id };
	}

	// ----------------------------------------------------------------------- //
	// branch (true fork: full session from an annotation) — POST /branch
	// ----------------------------------------------------------------------- //
	/**
	 * Start or resume a **branch** for an annotation (真 fork：从标注起步的完整会话).
	 *
	 * A branch (kind="branch") is a full session seeded from a spot card: it has
	 * the SAME toolset as a main session (incl. create_annotation), so the model
	 * can navigate / snapshot / annotate starting from the spot. The initial
	 * message is identical to a fork (spot card + bbox-expanded 15% image).
	 *
	 * - Root annotation gone → throws {@link RootAnnotationGone} (→ 410).
	 * - Existing branch for this annotation → resume it (append the question,
	 *   emit `branch_resumed`).
	 * - Otherwise: enforce the branch-active limit (reuses fork_active_limit but
	 *   counts only kind="branch"; archives the oldest non-running branch),
	 *   create a new branch, emit `branch_created`, then run the loop.
	 *
	 * Returns `{sessionId}` immediately.
	 */
	async askBranch(args: RunArgs & { annotationId: string; question?: string }): Promise<{ sessionId: string }> {
		const { slide, config, annotationId } = args;

		// Locate the root annotation via the spot change log (tombstone-aware).
		const roi = await this.findSpot(slide, annotationId);
		if (!roi || roi.deleted) {
			throw new RootAnnotationGone();
		}

		const existing = await this.store.findBranch(slide, annotationId);

		if (existing) {
			// Resume: acquire, append the question, emit branch_resumed, run.
			const data = await this.store.acquire({ sessionId: existing, slide, kind: "branch", annotationId });
			const qText = args.question || "请谈谈这个区域";
			// Append the user question to the transcript (mirrors fork resume).
			const updated = await this.store.withLock(data.id, async (d) => {
				if (!d) return null;
				const msg: PersistedAgentMessage = {
					role: "user",
					content: qText,
					display_text: qText,
					timestamp: Date.now(),
				} as PersistedAgentMessage;
				d.messages = [...(d.messages || []), msg];
				d.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(data.id, d);
				return d;
			});
			void updated;
			await this.bus.emit(data.id, "branch_resumed", { session_id: data.id, annotation_id: annotationId });
			void this.driveBranch(data.id, slide, config, annotationId).catch(async (e) => {
				await this.handleFatal(data.id, e);
			});
			return { sessionId: data.id };
		}

		// New branch: enforce the active limit (reuses fork_active_limit but
		// counts only kind="branch").
		const limit = Math.max(0, Math.floor(config.fork_active_limit ?? 20));
		await this.enforceBranchLimit(slide, limit);

		const title = "批注深读@" + (roi.label || "");
		const data = await this.store.acquire({ slide, kind: "branch", annotationId, title });
		// seed spot_cursor (same as fork).
		await this.store.withLock(data.id, async (d) => {
			if (!d) return null;
			const spots = await this.flask.spots(slide, 0).catch(() => ({ changes: [], current_seq: 0 }));
			d.spot_cursor = spots.current_seq || 0;
			d.updated_at = Math.floor(Date.now() / 1000);
			await this.store.writeSession(data.id, d);
			return d;
		});

		await this.bus.emit(data.id, "branch_created", { annotation_id: annotationId, title });
		void this.driveBranch(data.id, slide, config, annotationId, roi, args.question).catch(async (e) => {
			await this.handleFatal(data.id, e);
		});
		return { sessionId: data.id };
	}

	// ----------------------------------------------------------------------- //
	// cancel — app.py:1750 api_ai_cancel
	// ----------------------------------------------------------------------- //
	/**
	 * Cancel a running session. Aborts the pi Agent (which signals the streamFn
	 * → "aborted" stop reason) and transitions status to paused once the run
	 * settles. Accepts a sessionId or a slide (resolves the slide's main).
	 */
	async cancel(args: { sessionId?: string; slide?: string }): Promise<{ ok: true }> {
		let sessionId = args.sessionId;
		if (!sessionId) {
			if (!args.slide) throw new SessionConflict("会话不存在");
			const idx = await this.store.listBySlide(args.slide);
			sessionId = idx.main || undefined;
			if (!sessionId) throw new SessionConflict("会话不存在");
		}
		const data = await this.store.readSession(sessionId);
		if (!data) throw new SessionConflict("会话不存在");

		const agent = this.activeAgents.get(sessionId);
		if (agent) {
			agent.abort();
			// The loop's settle path transitions status. If there is no active
			// agent (e.g. crash residue), flip to paused directly.
		} else if (data.status === "running") {
			await this.store.setStatus(sessionId, "paused");
		}
		return { ok: true };
	}

	// =========================================================================== //
	// Main loop driver
	// =========================================================================== //
	/**
	 * Drive a main session: emit setup event, build initial context, run the
	 * agent, then settle status. Mirrors app.py:1957 `worker`.
	 */
	private async driveMain(sessionId: string, slide: string, config: RunConfig, task: string, resumed: boolean): Promise<void> {
		const slideInfo = await this.fetchSlideInfo(slide);
		const data = await this.store.readSession(sessionId);
		if (!data) return;

		let initialMessages: PersistedAgentMessage[];

		if (!resumed) {
			// Fresh: build the user task message, persist it, emit slide_opened
			// with the overview viewport (app.py:1960-1980).
			const vp = 1024;
			const lvl = AgentState.pickOverviewLevel(slideInfo.width, slideInfo.height, slideInfo.levelDownsamples, vp);
			const st = new AgentState(slideInfo.width / 2.0, slideInfo.height / 2.0, vp, lvl, slideInfo.mpp);
			const userMsg = makeMainMessages({ slideName: slide, task, info: slideInfo }) as unknown as PersistedAgentMessage;
			// Inject spot changes since cursor 0 (app.py:1969). injectSpotChanges
			// appends + persists the spot messages itself; we prepend the task
			// user message and persist the full initial transcript.
			const spotMsgs = await this.injectSpotChanges(sessionId, slide);
			initialMessages = [userMsg, ...spotMsgs];

			// Persist the initial transcript + agent_state.
			await this.store.withLock(sessionId, async (d) => {
				if (!d) return null;
				// injectSpotChanges already appended spotMsgs to d.messages;
				// rebuild as [userMsg, ...spotMsgs] (drop any prior residue).
				d.messages = [...initialMessages];
				d.agent_state = st.toDict();
				d.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(sessionId, d);
				return d;
			});

			const bbox = st.viewportBbox(slideInfo.levelDownsamples);
			await this.bus.emit(sessionId, "slide_opened", {
				slide,
				width: slideInfo.width,
				height: slideInfo.height,
				overview_level: lvl,
				level_count: slideInfo.levelDownsamples.length,
				mpp: slideInfo.mpp,
				viewport: bbox,
				session_id: sessionId,
			});
		} else {
			// Continue: refresh system prompt (no-op: pi keeps it on state),
			// inject spot changes (appends + persists internally), emit
			// session_resumed (app.py:1981-1994).
			await this.injectSpotChanges(sessionId, slide);
			const after = await this.store.readSession(sessionId);
			initialMessages = (after?.messages || []) as PersistedAgentMessage[];
			await this.bus.emit(sessionId, "session_resumed", {
				session_id: sessionId,
				status: after?.status ?? "running",
			});
		}

		await this.runAgentLoop(sessionId, slide, config, slideInfo, initialMessages, resumed);
	}

	/**
	 * Drive a fork session: emit fork_resumed (already emitted by askFork for
	 * new forks via fork_created), build/continue the context, run the loop.
	 * Mirrors app.py:2017 `worker`.
	 */
	private async driveFork(
		sessionId: string,
		slide: string,
		config: RunConfig,
		annotationId: string,
		roi?: RoiDict,
		question?: string,
	): Promise<void> {
		const slideInfo = await this.fetchSlideInfo(slide);
		const data = await this.store.readSession(sessionId);
		if (!data) return;

		let initialMessages: PersistedAgentMessage[];

		if (data.messages.length === 0) {
			// Brand-new fork: build the spot card + image (app.py:1731-1741).
			if (!roi) {
				roi = (await this.findSpot(slide, annotationId)) || undefined;
			}
			const spot: SpotDict = roi || { annotation_id: annotationId };
			const { imageRef, imageB64 } = await this.forkSpotImageRef(slide, slideInfo, spot);
			const userMsg = makeForkMessages({
				slideName: slide,
				info: slideInfo,
				spot,
				question: question || "",
				imageRef,
				imageB64,
			}) as unknown as PersistedAgentMessage;
			initialMessages = [userMsg];
			await this.store.withLock(sessionId, async (d) => {
				if (!d) return null;
				d.messages = [...initialMessages];
				d.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(sessionId, d);
				return d;
			});
		} else {
			// Resumed fork: inject spot changes (app.py:2021). injectSpotChanges
			// appends + persists internally; re-read the session for the full
			// transcript (avoid double-appending the spot messages).
			await this.injectSpotChanges(sessionId, slide);
			const after = await this.store.readSession(sessionId);
			initialMessages = (after?.messages || []) as PersistedAgentMessage[];
			// fork_resumed was already emitted by askFork; nothing to do here.
		}

		await this.runAgentLoop(sessionId, slide, config, slideInfo, initialMessages, false, {
			kind: "fork",
			systemPrompt: FORK_LITE_SYSTEM_PROMPT,
		});
	}

	// ----------------------------------------------------------------------- //
	// branch (true fork: full session from an annotation) — POST /branch
	// ----------------------------------------------------------------------- //
	/**
	 * Drive a branch session: same initial context shape as a fork (spot card +
	 * bbox-expanded image) but with the FULL toolset (incl. create_annotation),
	 * so the model can navigate / snapshot / annotate starting from the spot.
	 * Mirrors driveFork but passes kind="branch" (full tools + SYSTEM_PROMPT).
	 */
	private async driveBranch(
		sessionId: string,
		slide: string,
		config: RunConfig,
		annotationId: string,
		roi?: RoiDict,
		question?: string,
	): Promise<void> {
		const slideInfo = await this.fetchSlideInfo(slide);
		const data = await this.store.readSession(sessionId);
		if (!data) return;

		let initialMessages: PersistedAgentMessage[];

		if (data.messages.length === 0) {
			// Brand-new branch: build the spot card + image (same shape as fork).
			if (!roi) {
				roi = (await this.findSpot(slide, annotationId)) || undefined;
			}
			const spot: SpotDict = roi || { annotation_id: annotationId };
			const { imageRef, imageB64 } = await this.forkSpotImageRef(slide, slideInfo, spot);
			const userMsg = makeForkMessages({
				slideName: slide,
				info: slideInfo,
				spot,
				question: question || "",
				imageRef,
				imageB64,
			}) as unknown as PersistedAgentMessage;
			initialMessages = [userMsg];
			await this.store.withLock(sessionId, async (d) => {
				if (!d) return null;
				d.messages = [...initialMessages];
				d.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(sessionId, d);
				return d;
			});
		} else {
			// Resumed branch: inject spot changes (same as fork/main resume).
			await this.injectSpotChanges(sessionId, slide);
			const after = await this.store.readSession(sessionId);
			initialMessages = (after?.messages || []) as PersistedAgentMessage[];
			// branch_resumed was already emitted by askBranch; nothing to do here.
		}

		// Full toolset + full SYSTEM_PROMPT (branch == main toolset, seeded from spot).
		await this.runAgentLoop(sessionId, slide, config, slideInfo, initialMessages, false, {
			kind: "branch",
			systemPrompt: SYSTEM_PROMPT,
		});
	}
	/**
	 * Build a pi Agent, wire event mapping + run-level guards, and run to
	 * completion. Settles status (finished/error/paused) at the end so the SSE
	 * layer emits session_ended.
	 */
	private async runAgentLoop(
		sessionId: string,
		slide: string,
		config: RunConfig,
		slideInfo: SlideInfo,
		initialMessages: PersistedAgentMessage[],
		_continued: boolean,
		loopOptions: { systemPrompt?: string; kind?: "main" | "fork" | "branch" } = {},
	): Promise<void> {
		const { models, model } = buildModel(config);
		const maxSteps = Math.max(1, Math.floor(config.max_steps ?? 50));

		// Resolve the effective kind + system prompt for this run. Defaults
		// mirror the legacy behavior (main / branch = full SYSTEM_PROMPT + full
		// tools; fork = lite prompt + no tools). The caller (askFork) overrides
		// for lite forks; main/branch drive this from the session's persisted kind.
		const sessionForKind = await this.store.readSession(sessionId);
		const kind: "main" | "fork" | "branch" =
			loopOptions.kind ?? (sessionForKind?.kind === "fork" ? "fork" : sessionForKind?.kind === "branch" ? "branch" : "main");
		const systemPrompt = loopOptions.systemPrompt ?? (kind === "fork" ? FORK_LITE_SYSTEM_PROMPT : SYSTEM_PROMPT);

		// Compaction + transform settings, resolved once per run.
		const compactionSettings = resolveCompactionSettings(config);
		const transformSettings = resolveTransformSettings(config);

		// Session-level mutable: the first snapshot's toolCallId, used by
		// transformContext to protect the whole-slide overview from eviction.
		// Set when the first snapshot_captured event fires for this run.
		const firstSnapshotToolCallIdRef = { value: <string | null>null };

		// Tools + tool context (tools.ts). emit routes domain events to the bus.
		// fork (lite) registers NO tools — the model does pure text Q&A. main
		// and branch get the full toolset (createTools returns [] for fork as a
		// defensive fallback, but we skip building the tool context entirely
		// for forks so no domain events can fire).
		const toolCtx: ToolContext = {
			sessionStore: this.store,
			sessionId,
			kind,
			slide,
			slideInfo,
			flask: this.flask,
			emit: (type, payload) => {
				// Fire-and-forget; emit is async but tools need not await each.
				// Track the first snapshot so transformContext can protect it.
				if (type === "snapshot_captured" && firstSnapshotToolCallIdRef.value === null) {
					const sid = (payload as { snapshot_id?: string } | undefined)?.snapshot_id;
					if (sid) firstSnapshotToolCallIdRef.value = sid;
				}
				void this.bus.emit(sessionId, type, payload);
			},
			cfg: config as unknown as Record<string, unknown>,
		};
		const tools = kind === "fork" ? [] : createTools(toolCtx);

		// transformContext hook: materialize image_ref + evict old images. Bound
		// to this run's flask/slide/settings/first-snapshot id.
		const transformContext = makeTransformContext({
			flask: this.flask,
			slide,
			slideInfo,
			settings: transformSettings,
			firstSnapshotToolCallIdRef,
		});

		/**
		 * Run a compaction pass against the agent's current messages, apply the
		 * result in place (compactionSummary + retained tail + spot-index),
		 * emit session_compacted, and persist. Used by both the turn_end
		 * threshold path and the context_length_exceeded fallback. Returns the
		 * new message list on success, or null if compaction was a no-op or
		 * failed (the fallback treats null as "give up").
		 */
		const runCompactionPass = async (reason?: string): Promise<AgentMessage[] | null> => {
			const data = await this.store.readSession(sessionId);
			if (!data) return null;
			const prev = prevCompactionInputs(data);
			const msgs = agent.state.messages.slice();
			const outcome = await runCompaction({
				messages: msgs,
				settings: compactionSettings,
				models: (this.overrides.compactionModels as never) ?? models,
				model,
				prevSummary: prev.summary,
				prevRetainedTail: prev.retainedTail,
				prevTokensBefore: prev.tokensBefore,
			});
			if (!outcome) return null;

			// Append a spot-index user message after the summary + retained tail
			// (ai_session.py:954 _inject_spot_index), updating spot_cursor.
			let finalMessages = outcome.messages.slice();
			const spot = await buildSpotIndexMessage(this.flask, slide);
			if (spot) {
				finalMessages = [...finalMessages, spot.message];
			}
			// Apply to the agent's message state (replace in place).
			(agent.state as { messages: unknown[] }).messages = finalMessages;
			// Persist + emit session_compacted.
			await persistCompaction(this.store, sessionId, outcome, finalMessages, reason);
			await this.store.withLock(sessionId, async (d) => {
				if (!d) return null;
				if (spot) d.spot_cursor = spot.newCursor;
				d.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(sessionId, d);
				return d;
			});
			await this.bus.emit(sessionId, "session_compacted", {
				tokens_before: outcome.tokensBefore,
				tokens_after: outcome.tokensAfter,
				...(reason ? { reason } : {}),
			});
			return finalMessages;
		};

		// StreamFn with transient-error retry + context_length_exceeded fallback
		// (ai_agent.py:582-608). The fallback force-compacts then retries once.
		// transformContext is passed in so the in-wrapper retry (which bypasses
		// pi's per-request transform) still strips image_ref blocks. The fatal
		// "second context-exceeded" case is detected in the message_end handler
		// (pi surfaces the streamFn's terminal error there), not here.
		const stepRef = { current: -1 };
		const streamFn = this.makeRetryingStreamFn(sessionId, config, stepRef, runCompactionPass, transformContext);

		// Run-state machine for event mapping.
		const runState: RunState = {
			turnCount: 0,
			finished: false,
			paused: false,
			errored: false,
			lastAssistant: null,
			hitMaxSteps: false,
			abortRequested: false,
		};

		// max_steps: when reached, emit agent_paused (ai_agent.py:696-698) and
		// stop. The flag ensures agent_end below does not also emit
		// agent_finished.
		const emitMaxStepsPause = async (): Promise<void> => {
			runState.hitMaxSteps = true;
			runState.paused = true;
			await this.bus.emit(sessionId, "agent_paused", {
				summary: "已达步数上限",
				can_continue: true,
			});
		};

		const agent = new Agent({
			streamFn: streamFn as Agent["streamFunction"],
			transformContext,
			getApiKey: () => config.api_key,
			initialState: {
				model: model as never,
				systemPrompt,
				tools,
				messages: initialMessages as never[],
			},
			// shouldStopAfterTurn: enforce max_steps (ai_agent.py:696-698).
			shouldStopAfterTurn: async () => {
				if (runState.turnCount >= maxSteps) {
					await emitMaxStepsPause();
					return true;
				}
				return false;
			},
		});

		this.activeAgents.set(sessionId, agent);

		// Pending-snapshot plain-text guard (ai_agent.py:650-655):
		// when a plain-text turn ends with a pending snapshot, push a nudge
		// onto the agent's followUp queue. pi's loop drains follow-ups after
		// the agent would otherwise stop (agent-loop.js:162-168), continuing
		// the loop with the nudge as a new user turn — exactly mirroring
		// Python's `append user msg + continue`.

		/**
		 * Threshold compaction check (ai_session.py:908 maybe_compact). Called at
		 * turn_end: estimate context tokens off the agent's current messages
		 * (pi's usage+trailing estimator, fixing the old Python one-turn lag) and
		 * compact when over `context_window - reserve_tokens`.
		 *
		 * Only fires when the turn did not already settle into a terminal/paused
		 * state (no point compacting a run that's about to stop).
		 */
		const maybeCompact = async (): Promise<void> => {
			if (runState.finished || runState.paused || runState.errored || runState.hitMaxSteps) return;
			const check = checkShouldCompact(agent.state.messages.slice(), compactionSettings);
			if (!check.should) return;
			// Compact failure is non-fatal: log + continue with the un-compacted
			// context (no session_compacted event emitted).
			try {
				await runCompactionPass();
			} catch (e) {
				console.warn(`[compaction] threshold compact failed for ${sessionId}: ${(e as Error)?.message || e}`);
			}
		};

		const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
			await this.handleAgentEvent(sessionId, event, runState, stepRef, agent, maybeCompact);
		});

		try {
			// Fresh run: prompt with the initial user message (already on state
			// via initialState.messages, so use continue() to avoid re-adding).
			// pi requires prompt() to add a new message; since we seeded
			// initialState.messages, we use continue() for the first turn too.
			await agent.continue();
			await agent.waitForIdle();
		} catch (e) {
			runState.errored = true;
			await this.bus.emit(sessionId, "agent_error", {
				error: `读片助手异常：${(e as Error)?.message || String(e)}`,
			});
		} finally {
			unsubscribe();
			this.activeAgents.delete(sessionId);
		}

		// Persist the final transcript + settle status.
		await this.settleRun(sessionId, runState, agent);
	}

	// =========================================================================== //
	// Agent event → SSE event mapping
	// =========================================================================== //
	/**
	 * Subscribe callback: map one pi AgentEvent to SSE events + run-state
	 * updates. Async to coexist with the agent's await-settling contract.
	 */
	private async handleAgentEvent(
		sessionId: string,
		event: AgentEvent,
		runState: RunState,
		stepRef: { current: number },
		agent: Agent,
		maybeCompact: () => Promise<void>,
	): Promise<void> {
		switch (event.type) {
			case "turn_start": {
				runState.turnCount += 1;
				stepRef.current = runState.turnCount - 1; // 0-based like Python
				await this.bus.emit(sessionId, "agent_thinking", { step: stepRef.current });
				break;
			}
			case "message_update": {
				if (event.assistantMessageEvent.type === "text_delta") {
					await this.bus.emit(sessionId, "text_delta", { text: event.assistantMessageEvent.delta });
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					const msg = event.message as AssistantMessage;
					runState.lastAssistant = msg;
					// Fatal post-compact context-exceeded (ai_agent.py:594-596):
					// if the streamFn already force-compacted once (recorded in
					// compaction_entries) and the model STILL returns a context-
					// length error, the run cannot recover → agent_error. Detected
					// here (not in the streamFn wrapper) because pi surfaces the
					// streamFn's terminal error as an assistant message_end whose
					// stopReason is "error".
					if (msg.stopReason === "error" && isContextExceeded(msg.errorMessage || "")) {
						const data = await this.store.readSession(sessionId);
						const alreadyCompacted = (data?.compaction_entries || []).length > 0;
						if (alreadyCompacted && !runState.errored) {
							runState.errored = true;
							await this.bus.emit(sessionId, "agent_error", {
								error: `调用模型失败：${msg.errorMessage || "context_length_exceeded"}`,
								step: stepRef.current,
							});
						}
					}
					// length → paused (ai_agent.py:637-646). pi already fails the
					// (possibly truncated) tool calls; we just pause.
					if (msg.stopReason === "length") {
						const tip =
							"模型输出被截断（达到 max_tokens）" +
							(msg.content.some((c) => c.type === "toolCall") ? "，工具调用可能不完整" : "") +
							"，可继续生成或提高 max_tokens";
						await this.bus.emit(sessionId, "agent_paused", {
							summary: tip,
							can_continue: true,
							reason: "max_tokens",
						});
						runState.paused = true;
					}
					// Record usage (ai_agent.py:619-623).
					await this.recordUsage(sessionId, msg.usage);
				}
				break;
			}
			case "turn_end": {
				// Plain-text end with a pending snapshot → enqueue the nudge
				// (ai_agent.py:650-655). pi drains the followUp queue after the
				// agent would otherwise stop, continuing the loop with the
				// nudge — exactly mirroring Python's `append user msg + continue`.
				const msg = event.message as AssistantMessage;
				const hasToolCalls = msg.content.some((c) => c.type === "toolCall");
				if (!hasToolCalls && !runState.paused && !runState.finished && !runState.hitMaxSteps) {
					const pending = await this.isSnapshotPending(sessionId);
					if (pending) {
						const nudge: PersistedAgentMessage = {
							role: "user",
							content:
								"当前还有未消化的快照，请先调用 complete_snapshot_review 关闭后再继续。",
							timestamp: Date.now(),
						} as PersistedAgentMessage;
						agent.followUp(nudge as never);
					}
				}
				// finish tool: the tool sets terminate:true → loop exits. We
				// detect it here so agent_end does not also emit agent_finished.
				if (hasToolCalls) {
					for (const tc of msg.content) {
						if (tc.type === "toolCall" && tc.name === "finish") {
							runState.finished = true;
							const summary = (tc.arguments as { summary?: string })?.summary || "(无总结)";
							await this.bus.emit(sessionId, "agent_finished", { summary });
							break;
						}
					}
				}
				// Threshold compaction (ai_session.py:908 maybe_compact). Runs
				// after the turn fully settles (usage recorded, finish detected).
				// No-op when the turn ended the run or compaction isn't needed.
				await maybeCompact();
				break;
			}
			case "agent_end": {
				// User abort → paused (ai_agent.py:471-477 _pause_cancelled).
				// Detected: the last assistant message has stopReason "aborted".
				if (
					!runState.finished &&
					!runState.paused &&
					!runState.errored &&
					runState.lastAssistant?.stopReason === "aborted"
				) {
					await this.bus.emit(sessionId, "agent_paused", {
						summary: "已停止",
						can_continue: true,
					});
					runState.paused = true;
					break;
				}
				// Plain-text stop → agent_finished (ai_agent.py:656-657).
				// max_steps pauses and length pauses were already emitted.
				if (!runState.finished && !runState.paused && !runState.errored && !runState.hitMaxSteps) {
					const text = runState.lastAssistant
						? runState.lastAssistant.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("")
						: "";
					await this.bus.emit(sessionId, "agent_finished", { summary: text || "(无总结)" });
					runState.finished = true;
				}
				break;
			}
		}
	}

	// =========================================================================== //
	// Settle: persist transcript + transition status
	// =========================================================================== //
	private async settleRun(sessionId: string, runState: RunState, agent: Agent): Promise<void> {
		// Persist the agent's transcript, dehydrating image blocks.
		const msgs = agent.state.messages as unknown as PersistedAgentMessage[];
		const imageMeta = this.collectImageMeta(msgs);
		const dehydrated = dehydrateMessages(msgs, imageMeta);

		let nextStatus: "finished" | "error" | "paused";
		if (runState.errored) {
			nextStatus = "error";
		} else if (runState.paused) {
			nextStatus = "paused";
		} else if (runState.finished) {
			nextStatus = "finished";
		} else {
			// Defensive fallback: loop exited without an explicit terminal
			// event. Pause so the user can continue.
			nextStatus = "paused";
		}

		await this.store.withLock(sessionId, async (d) => {
			if (!d) return null;
			d.messages = dehydrated;
			d.updated_at = Math.floor(Date.now() / 1000);
			await this.store.writeSession(sessionId, d);
			return d;
		});
		await this.store.setStatus(sessionId, nextStatus);
	}

	/** Record last_usage on the session for Step 4 compaction triggers. */
	private async recordUsage(sessionId: string, usage: Usage | undefined): Promise<void> {
		if (!usage) return;
		await this.store.withLock(sessionId, async (d) => {
			if (!d) return null;
			(d as SessionData & { last_usage?: Usage }).last_usage = usage;
			await this.store.writeSession(sessionId, d);
			return d;
		});
	}

	/** True if the session currently has a pending_snapshot_review. */
	private async isSnapshotPending(sessionId: string): Promise<boolean> {
		const d = await this.store.readSession(sessionId);
		return !!d?.pending_snapshot_review;
	}

	/**
	 * Build a dehydrate imageMeta map keyed by toolCallId so settleRun can
	 * replace image blocks with image_ref placeholders. For tool results we
	 * read the snapshot details the snapshot tool stored in result.details.
	 */
	private collectImageMeta(msgs: PersistedAgentMessage[]): Record<string, ImageMeta> {
		const out: Record<string, ImageMeta> = {};
		for (const m of msgs) {
			if ((m as { role?: string }).role !== "toolResult") continue;
			const tr = m as { toolCallId: string; details?: { src?: { x: number; y: number; w: number; h: number }; magnification?: string; slide_fingerprint?: string } };
			if (tr.details && tr.details.src) {
				out[tr.toolCallId] = {
					toolCallId: tr.toolCallId,
					slide_fingerprint: tr.details.slide_fingerprint || "",
					src: tr.details.src,
					magnification: tr.details.magnification || "",
					summary: "(本次会话内抓取的快照)",
				};
			}
		}
		return out;
	}

	// =========================================================================== //
	// Retrying streamFn wrapper (ai_agent.py:597-608)
	// =========================================================================== //
	/**
	 * Wrap a real streamFn so:
	 *   - transient errors (SSL/timeout/429/5xx) retry up to 3 times with
	 *     2/4/8s backoff, emitting `agent_retrying` each attempt;
	 *   - context-window errors (ai_agent.py:582-596) trigger a one-shot
	 *     force-compact (skipping the threshold check) then retry the call once
	 *     with the re-materialized messages; a second failure is terminal.
	 *
	 * The wrapper consumes each underlying stream to completion; on a retryable
	 * error it starts a fresh stream. The wrapper itself returns a single
	 * combined AssistantMessageEventStream. Events from the failed first stream
	 * are forwarded (so the UI sees the attempt), then superseded by the retry.
	 */
	private makeRetryingStreamFn(
		sessionId: string,
		config: RunConfig,
		stepRef: { current: number },
		forceCompact: (reason?: string) => Promise<AgentMessage[] | null>,
		transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>,
	): (model: unknown, context: unknown, options?: unknown) => AssistantMessageEventStream {
		const realStreamFn = (this.overrides.streamFn ??
			// Default: bind the openai-completions streamSimple for the built
			// model. Imported lazily so tests that pass a fake streamFn never
			// touch the real provider module.
			this.defaultStreamFnForConfig(config)) as (
				model: unknown,
				context: unknown,
				options?: unknown,
			) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

		const self = this;
		return function (model, context, options) {
			const out = createAssistantMessageEventStream();
			void (async () => {
				const maxTransient = 3;
				let compacted = false; // one-shot context-exceeded guard
				let currentContext = context;
				for (let attempt = 0; ; attempt++) {
					let stream: AssistantMessageEventStream;
					try {
						// Await: the default streamFn is async (dynamic import of
						// the ESM-only provider module), so this may be a Promise.
						stream = await realStreamFn(model, currentContext, options);
					} catch (e) {
						// streamFn contract says it must not throw, but be defensive.
						out.push({
							type: "error",
							reason: "error",
							error: makeErrorAssistant(String((e as Error)?.message || e)),
						});
						out.end(makeErrorAssistant(String((e as Error)?.message || e)));
						return;
					}
					let finalMessage: AssistantMessage | null = null;
					let eventType: "done" | "error" | null = null;
					let terminalEvent: AssistantMessageEvent | null = null;
					try {
						for await (const ev of stream) {
							if (ev.type === "done") {
								finalMessage = ev.message;
								eventType = "done";
								terminalEvent = ev; // hold back; decide below
							} else if (ev.type === "error") {
								finalMessage = ev.error;
								eventType = "error";
								terminalEvent = ev; // hold back; decide below
							} else {
								// Forward non-terminal events (text_delta, etc.) live so
								// streaming stays responsive.
								out.push(ev);
							}
							// On done/error we stop forwarding further events from this
							// underlying stream; the for-await will end naturally.
						}
					} catch (e) {
						finalMessage = makeErrorAssistant(String((e as Error)?.message || e));
						eventType = "error";
						terminalEvent = { type: "error", reason: "error", error: finalMessage };
					}

					if (eventType === "done") {
						// Forward the held-back done event, then end.
						if (terminalEvent) out.push(terminalEvent);
						out.end(finalMessage!);
						return;
					}
					if (eventType === "error" && finalMessage) {
						const errMsg = finalMessage.errorMessage || "";
						// Helper to forward the held-back terminal error event then end.
						const forwardTerminalError = (): void => {
							out.push(terminalEvent as AssistantMessageEvent);
							out.end(finalMessage);
						};
						// Context-window exceeded: force-compact once, rebuild the
						// context from the compacted messages, retry once. A second
						// failure (or compact failure) is terminal.
						if (isContextExceeded(errMsg) && !compacted) {
							compacted = true;
							let newMessages: AgentMessage[] | null = null;
							try {
								newMessages = await forceCompact("context_length_exceeded");
							} catch (e) {
								console.warn(`[compaction] force-compact threw for ${sessionId}: ${(e as Error)?.message || e}`);
							}
							if (newMessages) {
								// Re-materialize the context: forceCompact rewrote
								// agent.state.messages in place AND returned the new
								// list. The retry bypasses pi's per-request
								// transformContext, so we run it inline here to keep
								// the image_ref-elimination contract (any image_ref
								// in the compacted tail must become a real image or
								// a text fallback before the LLM sees it).
								const transformed = await transformContext(newMessages).catch(() => newMessages);
								currentContext = { ...(currentContext as object), messages: transformed };
								attempt = -1; // next iteration → attempt 0 again
								continue;
							}
							// compact failed → forward the error; the message_end
							// handler treats a context-exceeded error after a
							// compaction as terminal agent_error.
							forwardTerminalError();
							return;
						}
						if (isContextExceeded(errMsg)) {
							// Already compacted once and still over → forward; the
							// message_end handler emits the terminal agent_error
							// (ai_agent.py:594-596).
							forwardTerminalError();
							return;
						}
						if (isTransientError(errMsg) && attempt < maxTransient) {
							const delay = 2 ** (attempt + 1); // 2/4/8s
							await self.bus.emit(sessionId, "agent_retrying", {
								step: stepRef.current,
								attempt: attempt + 1,
								max: maxTransient,
								delay,
								reason: `reconnection ${attempt + 1}/${maxTransient} (${delay}s)`,
							});
							await sleep(delay * 1000);
							continue; // retry the model call
						}
						forwardTerminalError();
						return;
					}
					// Stream ended without a terminal event (shouldn't happen).
					out.push({ type: "error", reason: "error", error: makeErrorAssistant("Stream ended without a terminal event") });
					out.end(makeErrorAssistant("Stream ended without a terminal event"));
					return;
				}
			})().catch(() => {
				// Last-resort: ensure the output stream terminates.
				out.end(makeErrorAssistant("retry wrapper failed"));
			});
			return out;
		};
	}

	/** Lazy-import the openai-completions streamSimple bound to the config. */
	private defaultStreamFnForConfig(_config: RunConfig): (model: unknown, context: unknown, options?: unknown) => Promise<AssistantMessageEventStream> {
		// Dynamic import keeps the provider module out of the test graph when a
		// fake streamFn is supplied. The returned fn dispatches by model.api.
		// StreamFn allows returning a Promise (pi agent-loop awaits it).
		return async (model, context, options) => {
			const m = model as { api?: string };
			if (m?.api === "anthropic-messages") {
				throw new Error("anthropic protocol not yet wired in sidecar streamFn");
			}
			const mod = await this.loadOpenAiStream();
			return mod.streamSimple(model as never, context as never, options as never);
		};
	}

	private openAiStreamCache: Promise<{ streamSimple: typeof import("@earendil-works/pi-ai/api/openai-completions").streamSimple }> | null = null;
	private loadOpenAiStream(): Promise<{ streamSimple: typeof import("@earendil-works/pi-ai/api/openai-completions").streamSimple }> {
		if (!this.openAiStreamCache) {
			// The published pi-ai package marks ./api/* exports as ESM-only
			// ("import" condition, no "require"), so createRequire() fails at
			// runtime with "subpath not defined by exports". Use dynamic import.
			this.openAiStreamCache = import("@earendil-works/pi-ai/api/openai-completions") as Promise<{
				streamSimple: typeof import("@earendil-works/pi-ai/api/openai-completions").streamSimple;
			}>;
		}
		return this.openAiStreamCache!;
	}

	// =========================================================================== //
	// Fatal error handler (uncaught exception in the driver)
	// =========================================================================== //
	private async handleFatal(sessionId: string, e: unknown): Promise<void> {
		const msg = (e as Error)?.message || String(e);
		try {
			await this.bus.emit(sessionId, "agent_error", { error: `读片助手异常：${msg}` });
		} catch {
			// ignore
		}
		await this.store.setStatus(sessionId, "error");
	}

	// =========================================================================== //
	// Spot injection (ai_session.py:985-1024 inject_spot_changes)
	// =========================================================================== //
	/**
	 * Append user messages for spot changes since spot_cursor, updating the
	 * cursor. Returns the appended messages (for fresh-run initial assembly).
	 *
	 * Text format is byte-for-byte aligned with ai_session.py:999-1016.
	 */
	async injectSpotChanges(sessionId: string, slide: string): Promise<PersistedAgentMessage[]> {
		const data = await this.store.readSession(sessionId);
		if (!data) return [];
		const cursor = Math.floor(data.spot_cursor || 0);
		let result: { changes: Record<string, unknown>[]; current_seq: number };
		try {
			result = await this.flask.spots(slide, cursor);
		} catch {
			return [];
		}
		const changes = result.changes || [];
		if (!changes.length) return [];

		const msgs: PersistedAgentMessage[] = [];
		for (const r of changes) {
			const annotationId = String(r.annotation_id || "");
			if (r.deleted) {
				msgs.push({
					role: "user",
					content: `spot_deleted：标注 (${annotationId}) 已被删除。`,
					spot_deleted: annotationId,
					timestamp: Date.now(),
				} as PersistedAgentMessage);
			} else {
				const s = Math.trunc(Number(r.side_px) || 0);
				const x0 = Number(r.x) || 0;
				const y0 = Number(r.y) || 0;
				const note = String(r.note || "");
				msgs.push({
					role: "user",
					content:
						`spot_updated：已有标注线索（待复核，非诊断事实）——` +
						`位置 level-0 左上角 (${fmt0(x0)},${fmt0(y0)})，边长 ${s}px` +
						`（中心 (${fmt0(x0 + s / 2.0)},${fmt0(y0 + s / 2.0)})；goto 看这里请把视野中心对准中心坐标），` +
						`原标注文案：「${note}」。` +
						`请独立观察后决定采纳、修正或忽略。`,
					spot_updated: annotationId,
					timestamp: Date.now(),
				} as PersistedAgentMessage);
			}
		}

		await this.store.withLock(sessionId, async (d) => {
			if (!d) return null;
			d.messages = [...(d.messages || []), ...msgs];
			d.spot_cursor = result.current_seq || cursor;
			d.updated_at = Math.floor(Date.now() / 1000);
			await this.store.writeSession(sessionId, d);
			return d;
		});
		return msgs;
	}

	// =========================================================================== //
	// Helpers: slide info, spot lookup, fork image, archive, fork limit
	// =========================================================================== //

	/** Cached slide info fetcher. */
	private slideInfoCache = new Map<string, SlideInfo>();
	private async fetchSlideInfo(slide: string): Promise<SlideInfo> {
		const cached = this.slideInfoCache.get(slide);
		if (cached) return cached;
		const r = await this.flask.slideInfo(slide);
		const info: SlideInfo = {
			width: r.width,
			height: r.height,
			levelDownsamples: [...(r.level_downsamples || [1.0])],
			mpp: r.mpp == null ? null : r.mpp,
			fingerprint: r.fingerprint || "",
		};
		this.slideInfoCache.set(slide, info);
		return info;
	}

	/**
	 * Find a spot by annotation_id from the full change log (tombstone-aware).
	 * Returns the latest record for the id (deleted or not) or null.
	 * Equivalent to app.py:1704 share_store.get_roi_by_annotation_id.
	 */
	private async findSpot(slide: string, annotationId: string): Promise<(RoiDict & { deleted?: boolean }) | null> {
		let result;
		try {
			result = await this.flask.spots(slide, 0);
		} catch {
			return null;
		}
		// The change log may carry multiple revisions; take the latest for id.
		let latest: (RoiDict & { deleted?: boolean }) | null = null;
		for (const c of result.changes || []) {
			if (String(c.annotation_id || "") === annotationId) {
				latest = c as RoiDict & { deleted?: boolean };
			}
		}
		return latest;
	}

	/**
	 * Build the fork's attached image_ref + inline base64 (app.py:1883
	 * _fork_spot_image_ref). bbox expanded 15%, output 1024-1568px.
	 */
	private async forkSpotImageRef(
		slide: string,
		info: SlideInfo,
		spot: SpotDict,
	): Promise<{ imageRef: import("./session-store.js").ImageRefContent | null; imageB64: string | null }> {
		const x = Math.trunc(Number(spot.x) || 0);
		const y = Math.trunc(Number(spot.y) || 0);
		const side = Math.trunc(Number(spot.side_px) || 0);
		if (side <= 0) return { imageRef: null, imageB64: null };
		const pad = Math.round(side * 0.15);
		const width = info.width;
		const height = info.height;
		const ex = Math.max(0, x - pad);
		const ey = Math.max(0, y - pad);
		const ew = Math.min(side + pad * 2, Math.max(1, width - ex));
		const eh = Math.min(side + pad * 2, Math.max(1, height - ey));
		const src = { x: ex, y: ey, w: ew, h: eh };

		let b64 = "";
		let mag: string | null = null;
		try {
			const r: RegionResult = await this.flask.region({ slide, x: ex, y: ey, w: ew, h: eh, out_w: 1568, out_h: 1568 });
			b64 = r.image_base64 || "";
			mag = (r.magnification == null ? null : String(r.magnification)) || null;
		} catch {
			b64 = "";
		}

		const imageRef = {
			type: "image_ref" as const,
			ref_id: `ref_fork_${String(spot.annotation_id || "").slice(0, 12)}`,
			slide_fingerprint: info.fingerprint || "",
			src,
			magnification: mag ?? "",
			summary: "该 spot 当前快照（bbox 外扩 15%）",
		};
		return { imageRef, imageB64: b64 || null };
	}

	/** Archive the current main session for a slide (fresh path). */
	private async archiveMainSlot(slide: string): Promise<void> {
		const idx = await this.store.listBySlide(slide);
		const mainId = idx.main;
		if (!mainId) return;
		const d = await this.store.readSession(mainId);
		if (!d) return;
		if (d.archived) return;
		await this.store.withLock(mainId, async (data) => {
			if (!data) return null;
			data.archived = true;
			data.updated_at = Math.floor(Date.now() / 1000);
			await this.store.writeSession(mainId, data);
			return data;
		});
		// Remove the main slot from the index (app.py fresh semantics).
		await this.store.unregister(slide, mainId, "main");
	}

	/**
	 * Archive the oldest non-running forks until under the active limit
	 * (app.py:1917 _enforce_fork_limit). Running forks are never archived.
	 */
	private async enforceForkLimit(slide: string, limit: number): Promise<void> {
		if (limit <= 0) return;
		const idx = await this.store.listBySlide(slide);
		const forks: SessionData[] = [];
		for (const sid of Object.values(idx.forks)) {
			const d = await this.store.readSession(sid);
			if (d) forks.push(d);
		}
		const running = forks.filter((d) => d.status === "running");
		const idle = forks
			.filter((d) => d.status !== "running" && !d.archived)
			.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
		const allowed = Math.max(0, limit - running.length);
		const toArchive = idle.slice(Math.max(0, allowed - idle.length));
		for (const d of toArchive) {
			await this.store.withLock(d.id, async (data) => {
				if (!data) return null;
				data.archived = true;
				data.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(d.id, data);
				return data;
			});
		}
	}

	/**
	 * Archive the oldest non-running branches until under the active limit.
	 * Reuses `fork_active_limit` as the cap but counts ONLY kind="branch"
	 * sessions (forks and branches are rate-limited independently). Running
	 * branches are never archived.
	 */
	private async enforceBranchLimit(slide: string, limit: number): Promise<void> {
		if (limit <= 0) return;
		const idx = await this.store.listBySlide(slide);
		const branches: SessionData[] = [];
		for (const sid of Object.values(idx.branches)) {
			const d = await this.store.readSession(sid);
			if (d) branches.push(d);
		}
		const running = branches.filter((d) => d.status === "running");
		const idle = branches
			.filter((d) => d.status !== "running" && !d.archived)
			.sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
		const allowed = Math.max(0, limit - running.length);
		const toArchive = idle.slice(Math.max(0, allowed - idle.length));
		for (const d of toArchive) {
			await this.store.withLock(d.id, async (data) => {
				if (!data) return null;
				data.archived = true;
				data.updated_at = Math.floor(Date.now() / 1000);
				await this.store.writeSession(d.id, data);
				return data;
			});
		}
	}
}

// =========================================================================== //
// Run-state machine
// =========================================================================== //

interface RunState {
	turnCount: number;
	finished: boolean;
	paused: boolean;
	errored: boolean;
	lastAssistant: AssistantMessage | null;
	/** True when the loop exited because max_steps was reached. */
	hitMaxSteps: boolean;
	abortRequested: boolean;
}

// =========================================================================== //
// Transient / context-exceeded error classification (ai_agent.py:422-468)
// =========================================================================== //

/** ai_agent.py:422 _is_context_exceeded. */
function isContextExceeded(msg: string): boolean {
	const lower = (msg || "").toLowerCase();
	const kws = ["context_length", "maximum context", "too many tokens", "context window"];
	for (const kw of kws) {
		if (lower.includes(kw)) return true;
	}
	return lower.includes("context_length_exceeded");
}

/** ai_agent.py:446 _is_transient_error (message-substring half). */
function isTransientError(msg: string): boolean {
	const lower = (msg || "").toLowerCase();
	const kws = [
		"sslerror",
		"unexpected_eof",
		"eof while",
		"connection reset",
		"connection aborted",
		"broken pipe",
		"timed out",
		"max retries",
	];
	for (const kw of kws) {
		if (lower.includes(kw)) return true;
	}
	// HTTP status code hints in error text (429/5xx).
	if (/\b(408|409|425|429|500|502|503|504)\b/.test(lower)) return true;
	return false;
}

// =========================================================================== //
// Small helpers
// =========================================================================== //

function fmt0(v: number): string {
	return String(Math.round(v));
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Build a minimal error AssistantMessage to terminate a stream. */
function makeErrorAssistant(message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "cpa-gateway",
		model: "unknown",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	} as AssistantMessage;
}

/** Avoid an unused-import warning while keeping Message available for typing. */
export type { Message };
