/**
 * AI reading assistant sidecar — HTTP server + SSE streams (Step 3).
 *
 * node:http server bound to 127.0.0.1:`AI_SIDECAR_PORT` (default 8055).
 * Endpoints mirror the Flask contract byte-for-byte (Flask Step 5 proxies
 * these verbatim). SSE framing is byte-identical to app.py:2066 `_sse_response`.
 *
 *   POST /run                  body {slide, task?, fresh?, config}   → SSE ; 409 conflict
 *   POST /continue             body {slide, config}                 → SSE ; 404 no main
 *   POST /ask                  body {slide, annotation_id, question?, config} → SSE ; 410 root gone (lite fork)
 *   POST /branch               body {slide, annotation_id, question?, config} → SSE ; 410 root gone (true fork, full tools)
 *   POST /cancel               body {session_id?} | {slide}         → {ok:true} ; 404
 *   GET  /sessions?slide=                                          → {sessions:[...]}
 *   GET  /session/:id                                              → {session, transcript}
 *   POST /session/:id/archive | /unarchive                         → {ok, archived} ; 409 running
 *   GET  /session/:id/stream?after_seq=N | Last-Event-ID           → SSE (replay + live)
 *   GET  /healthz                                                  → {ok:true}
 *
 * SSE transport semantics (app.py:2066-2143):
 *   - event frame: `id: {seq}\nevent: {type}\ndata: {json}\n\n`
 *   - heartbeat:   `: ping\n\n`  (every 15s here; Python pinged each 0.5s poll)
 *   - after_seq < event_min_seq (and after_seq > 0) → single `event_reset` frame
 *     carrying `id: {curSeq}` then close-gap (no replay of lost events)
 *   - session status leaves "running" → emit `session_ended {status}` and close
 *   - response headers: Cache-Control:no-cache, X-Accel-Buffering:no,
 *     X-AI-Session-ID:<id>; Content-Type:text/event-stream
 *
 * Implementation: the run endpoints kick the AgentRunner (async-fire) and
 * immediately return an SSE stream for the new session id. The SSE stream
 * replays the persisted event log from after_seq, subscribes to the in-memory
 * {@link SessionEventBus} for live tailing, and closes when the session leaves
 * "running". No polling (the bus fans out instantly), but the on-disk log is
 * still the source of truth for catchup/reconnect.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AgentRunner, RunConfig, SessionConflict, RootAnnotationGone } from "./agent-runner.js";
import { SessionStore, SessionConflict as StoreConflict } from "./session-store.js";
import { SessionEventBus, formatEventFrame, formatPingFrame, formatEventResetFrame, formatSessionEndedFrame } from "./events.js";
import { buildTranscript } from "./transcript.js";
import type { FlaskClient } from "./flask-client.js";

// =========================================================================== //
// Server options
// =========================================================================== //

export interface SidecarServerOptions {
	/** Bind host (default 127.0.0.1). */
	host?: string;
	/** Bind port (default env AI_SIDECAR_PORT or 8055). */
	port?: number;
	/** Override the runner/store/bus/flask (tests). */
	runner?: AgentRunner;
	store?: SessionStore;
	bus?: SessionEventBus;
	flask?: FlaskClient;
	/** Inject a fake streamFn into the runner (tests). */
	streamFnOverride?: (model: unknown, context: unknown, options?: unknown) => unknown;
}

// =========================================================================== //
// SidecarServer
// =========================================================================== //

export class SidecarServer {
	readonly host: string;
	/** Requested port (0 = ephemeral). Use {@link boundPort} after start(). */
	readonly port: number;
	readonly store: SessionStore;
	readonly bus: SessionEventBus;
	readonly flask: FlaskClient;
	readonly runner: AgentRunner;
	private server: Server | null = null;
	/** The OS-assigned port after start() (equals {@link port} when non-zero). */
	private _boundPort = 0;

	constructor(opts: SidecarServerOptions = {}) {
		this.host = opts.host ?? "127.0.0.1";
		this.port = opts.port ?? defaultPort();
		this.store = opts.store ?? new SessionStore();
		this.bus = opts.bus ?? new SessionEventBus(this.store);
		this.flask = opts.flask ?? (null as unknown as FlaskClient); // set via createSidecarServer in index.ts
		this.runner = opts.runner ?? new AgentRunner(this.store, this.bus, this.flask, opts.streamFnOverride ? { streamFn: opts.streamFnOverride as never } : {});
	}

	/** The actual port the server is bound to (0 before start). */
	get boundPort(): number {
		return this._boundPort;
	}

	/** Start listening. Returns once the server is up. */
	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((e) => {
				this.sendJson(res, 500, { error: `internal: ${(e as Error)?.message || e}` });
			});
		});
		await new Promise<void>((resolve) => {
			this.server!.listen(this.port, this.host, () => {
				const addr = this.server!.address();
				this._boundPort = typeof addr === "object" && addr ? addr.port : this.port;
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		this.server = null;
	}

	// =========================================================================== //
	// Routing
	// =========================================================================== //
	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url || "/", "http://localhost");
		const path = url.pathname;
		const method = (req.method || "GET").toUpperCase();

		if (method === "GET" && path === "/healthz") return this.sendJson(res, 200, { ok: true });

		if (method === "POST" && path === "/run") return this.handleRun(req, res);
		if (method === "POST" && path === "/continue") return this.handleContinue(req, res);
		if (method === "POST" && path === "/ask") return this.handleAsk(req, res);
		if (method === "POST" && path === "/branch") return this.handleBranch(req, res);
		if (method === "POST" && path === "/cancel") return this.handleCancel(req, res);

		if (method === "GET" && path === "/sessions") return this.handleSessions(url, res);

		// /session/:id and sub-paths
		const sessionMatch = path.match(/^\/session\/([^/]+)(\/(archive|unarchive|stream))?$/);
		if (sessionMatch) {
			const id = decodeURIComponent(sessionMatch[1] || "");
			const sub = sessionMatch[3];
			if (method === "GET" && !sub) return this.handleSessionDetail(id, res);
			if (method === "POST" && (sub === "archive" || sub === "unarchive")) return this.handleArchive(id, sub === "archive", res);
			if (method === "GET" && sub === "stream") return this.handleStream(id, req, url, res);
		}

		return this.sendJson(res, 404, { error: "not found" });
	}

	// =========================================================================== //
	// POST /run
	// =========================================================================== //
	private async handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const slide = str(body.slide);
		const task = str(body.task) || undefined;
		const fresh = body.fresh === true || body.fresh === 1 || body.fresh === "1" || str(body.fresh) === "true";
		const config = body.config as RunConfig | undefined;
		if (!slide) return this.sendJson(res, 400, { error: "缺少 slide" });
		if (!config || !config.base_url || !config.api_key) {
			return this.sendJson(res, 400, { error: "AI 未配置：请先在面板里填写 base_url 与 api_key" });
		}
		try {
			const { sessionId } = await this.runner.runMain({ slide, config, task, fresh });
			// SSE stream for the new session (Flask proxies this verbatim).
			return this.startSseForNewSession(sessionId, res);
		} catch (e) {
			if (e instanceof SessionConflict || e instanceof StoreConflict) return this.sendJson(res, 409, { error: e.message });
			return this.sendJson(res, 500, { error: (e as Error)?.message || String(e) });
		}
	}

	// =========================================================================== //
	// POST /continue
	// =========================================================================== //
	private async handleContinue(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const slide = str(body.slide);
		const config = body.config as RunConfig | undefined;
		if (!slide) return this.sendJson(res, 400, { error: "缺少 slide" });
		if (!config) return this.sendJson(res, 400, { error: "缺少 config" });
		try {
			const { sessionId } = await this.runner.continueMain({ slide, config });
			return this.startSseForNewSession(sessionId, res);
		} catch (e) {
			if (e instanceof SessionConflict || e instanceof StoreConflict) {
				// continueMain throws SessionConflict("没有可继续的主会话") → 404.
				const msg = e.message || "";
				if (msg.includes("没有可继续")) return this.sendJson(res, 404, { error: msg });
				return this.sendJson(res, 409, { error: msg });
			}
			return this.sendJson(res, 500, { error: (e as Error)?.message || String(e) });
		}
	}

	// =========================================================================== //
	// POST /ask
	// =========================================================================== //
	private async handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const slide = str(body.slide);
		const annotationId = str(body.annotation_id);
		const question = str(body.question) || undefined;
		const config = body.config as RunConfig | undefined;
		if (!slide) return this.sendJson(res, 400, { error: "缺少 slide" });
		if (!annotationId) return this.sendJson(res, 400, { error: "缺少 annotation_id" });
		if (!config) return this.sendJson(res, 400, { error: "缺少 config" });
		try {
			const { sessionId, streamFromSeq } = await this.runner.askFork({ slide, config, annotationId, question });
			return this.startSseForNewSession(sessionId, res, streamFromSeq);
		} catch (e) {
			if (e instanceof RootAnnotationGone) return this.sendJson(res, 410, { error: e.message });
			if (e instanceof SessionConflict || e instanceof StoreConflict) return this.sendJson(res, 409, { error: e.message });
			return this.sendJson(res, 500, { error: (e as Error)?.message || String(e) });
		}
	}

	// =========================================================================== //
	// POST /branch (true fork: full session from an annotation, full toolset)
	// =========================================================================== //
	private async handleBranch(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const slide = str(body.slide);
		const annotationId = str(body.annotation_id);
		const question = str(body.question) || undefined;
		const config = body.config as RunConfig | undefined;
		if (!slide) return this.sendJson(res, 400, { error: "缺少 slide" });
		if (!annotationId) return this.sendJson(res, 400, { error: "缺少 annotation_id" });
		if (!config) return this.sendJson(res, 400, { error: "缺少 config" });
		try {
			const { sessionId, streamFromSeq } = await this.runner.askBranch({ slide, config, annotationId, question });
			return this.startSseForNewSession(sessionId, res, streamFromSeq);
		} catch (e) {
			if (e instanceof RootAnnotationGone) return this.sendJson(res, 410, { error: e.message });
			if (e instanceof SessionConflict || e instanceof StoreConflict) return this.sendJson(res, 409, { error: e.message });
			return this.sendJson(res, 500, { error: (e as Error)?.message || String(e) });
		}
	}

	// =========================================================================== //
	// POST /cancel
	// =========================================================================== //
	private async handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readJson(req);
		const sessionId = str(body.session_id) || undefined;
		const slide = str(body.slide) || undefined;
		if (!sessionId && !slide) return this.sendJson(res, 400, { error: "缺少 session_id 或 slide" });
		try {
			await this.runner.cancel({ sessionId, slide });
			return this.sendJson(res, 200, { ok: true });
		} catch (e) {
			if (e instanceof SessionConflict || e instanceof StoreConflict) return this.sendJson(res, 404, { error: e.message });
			return this.sendJson(res, 500, { error: (e as Error)?.message || String(e) });
		}
	}

	// =========================================================================== //
	// GET /sessions?slide=
	// =========================================================================== //
	private async handleSessions(url: URL, res: ServerResponse): Promise<void> {
		const slide = url.searchParams.get("slide") || "";
		if (!slide) return this.sendJson(res, 400, { error: "缺少 slide" });
		const idx = await this.store.listBySlide(slide);
		const out: unknown[] = [];
		if (idx.main) {
			const d = await this.store.readSession(idx.main);
			if (d) out.push(sessionListItem(d));
		}
		for (const sid of Object.values(idx.forks)) {
			const d = await this.store.readSession(sid);
			if (d && !d.archived) out.push(sessionListItem(d));
		}
		for (const sid of Object.values(idx.branches)) {
			const d = await this.store.readSession(sid);
			if (d && !d.archived) out.push(sessionListItem(d));
		}
		out.sort((a, b) => {
			const ua = (a as { updated_at?: number }).updated_at || 0;
			const ub = (b as { updated_at?: number }).updated_at || 0;
			return ub - ua;
		});
		return this.sendJson(res, 200, { sessions: out });
	}

	// =========================================================================== //
	// GET /session/:id
	// =========================================================================== //
	private async handleSessionDetail(id: string, res: ServerResponse): Promise<void> {
		const d = await this.store.readSession(id);
		if (!d) return this.sendJson(res, 404, { error: "会话不存在" });
		const transcript = buildTranscript(d);
		return this.sendJson(res, 200, {
			session: {
				id: d.id,
				slide: d.slide,
				kind: d.kind,
				title: d.title,
				status: d.status,
				archived: d.archived,
				annotation_id: d.annotation_id || "",
				created_at: d.created_at,
				updated_at: d.updated_at,
				last_accessed_at: d.last_accessed_at,
				spot_cursor: d.spot_cursor,
				last_event_seq: d.last_event_seq,
				event_min_seq: d.event_min_seq,
				agent_state: d.agent_state,
				summary: d.summary,
			},
			transcript,
		});
	}

	// =========================================================================== //
	// POST /session/:id/archive | /unarchive
	// =========================================================================== //
	private async handleArchive(id: string, archive: boolean, res: ServerResponse): Promise<void> {
		const d = await this.store.readSession(id);
		if (!d) return this.sendJson(res, 404, { error: "会话不存在" });
		if (archive && d.status === "running") {
			return this.sendJson(res, 409, { error: "运行中的会话不可归档" });
		}
		try {
			const updated = archive ? await this.store.archive(id) : await this.store.unarchive(id);
			return this.sendJson(res, 200, { ok: true, archived: updated.archived });
		} catch (e) {
			if (e instanceof StoreConflict) return this.sendJson(res, 409, { error: e.message });
			return this.sendJson(res, 500, { error: (e as Error)?.message || String(e) });
		}
	}

	// =========================================================================== //
	// GET /session/:id/stream  (replay + live SSE; reconnect-safe)
	// =========================================================================== //
	private async handleStream(id: string, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
		const d = await this.store.readSession(id);
		if (!d) return this.sendJson(res, 404, { error: "会话不存在" });
		// after_seq resolution: query param first, then Last-Event-ID header.
		let afterSeq = parseSeq(url.searchParams.get("after_seq"));
		if (afterSeq <= 0) {
			afterSeq = parseSeq(req.headers["last-event-id"]);
		}
		return this.runSseStream(id, afterSeq, res);
	}

	/**
	 * SSE stream for a freshly-acquired session (run/continue/ask). after_seq=0
	 * replays everything emitted so far (including the setup event), then tails
	 * live. The X-AI-Session-ID header carries the new id to the client.
	 */
	private startSseForNewSession(sessionId: string, res: ServerResponse, afterSeq = 0): void {
		void this.runSseStream(sessionId, afterSeq, res);
	}

	/**
	 * Drive one SSE stream for a session. Implements the app.py:2084 `gen()`
	 * semantics with in-memory fanout instead of polling:
	 *   1. Compute the gap window; if after_seq > 0 and < event_min_seq → emit
	 *      one event_reset frame (id: curSeq) and skip replay (Python behavior).
	 *   2. Otherwise replay all persisted events with seq > after_seq.
	 *   3. Subscribe to the live bus; forward each event as a frame.
	 *   4. Heartbeat every 15s with `: ping\n\n`.
	 *   5. When the session status leaves "running" (and the live queue is
	 *      drained), emit session_ended {status} and close.
	 */
	private async runSseStream(sessionId: string, afterSeq: number, res: ServerResponse): Promise<void> {
		// Headers (app.py:2140-2143).
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			"X-Accel-Buffering": "no",
			"X-AI-Session-ID": sessionId,
			Connection: "keep-alive",
		});

		let closed = false;
		res.on("close", () => {
			closed = true;
		});

		const writeFrame = (frame: string): boolean => {
			if (closed) return false;
			return res.write(frame);
		};

		let lastSeq = afterSeq;

		// Step 1+2: gap window + replay (app.py:2091-2114 _drain, first pass).
		const initial = await this.drainReplay(sessionId, afterSeq, lastSeq, writeFrame, (s) => {
			lastSeq = s;
		}, () => {});
		if (initial.close) {
			res.end();
			return;
		}

		// Step 3+4+5: live tail with heartbeat + terminal close.
		//
		// Wakeup fence: the bus callback bumps a counter; the loop captures the
		// counter before draining, then after the drain waits on a promise that
		// is re-armed each iteration. If the counter advanced during the drain
		// (an event arrived), the loop continues immediately to drain it; this
		// closes the "event arrives between drain and wait" race without losing
		// events (they're persisted, so the next drain picks them up regardless).
		//
		// Terminal detection: app.py polls every 0.5s and checks the session
		// status each iteration. We keep that cadence for status checks (a run
		// settling to "finished"/"paused" emits no event, so we can't rely on
		// the bus poke alone to surface it) but only emit a `: ping` heartbeat
		// frame every ~15s to avoid flooding the stream.
		let pokeCount = 0;
		let resolvePoke: () => void = () => {};
		const unsubscribe = this.bus.subscribe(sessionId, () => {
			pokeCount += 1;
			resolvePoke();
		});
		const HEARTBEAT_PING_MS = 15000;
		const POLL_MS = 500;
		let lastPing = Date.now();

		try {
			while (!closed) {
				const seenBefore = pokeCount;
				// Drain anything new since lastSeq (live events are persisted
				// by the bus before fanout, so the log is authoritative).
				await this.drainReplay(sessionId, 0, lastSeq, writeFrame, (s) => {
					lastSeq = s;
				}, () => {});

				// Status check (app.py:2124-2133): if not running, do a final
				// drain then emit session_ended and close.
				const data = await this.store.readSession(sessionId);
				const status = data?.status ?? "idle";
				if (status !== "running") {
					await this.drainReplay(sessionId, 0, lastSeq, writeFrame, (s) => {
						lastSeq = s;
					}, () => {});
					if (!closed) {
						writeFrame(formatSessionEndedFrame(status));
					}
					break;
				}

				// If an event arrived during the drain, loop again immediately.
				if (pokeCount > seenBefore || closed) continue;

				// Re-arm the poke promise for the wait window.
				const pokePromise = new Promise<"poke">((resolve) => {
					resolvePoke = () => resolve("poke");
				});

				// Wait for either a live event (poke) or the short poll tick.
				// The short tick lets us re-check the session status promptly
				// when a run settles without emitting an event. Every
				// HEARTBEAT_PING_MS, also emit a `: ping` heartbeat frame.
				const poll = waitHeartbeat(POLL_MS);
				const won = await Promise.race([pokePromise, poll.promise]);
				poll.cancel();
				if (closed) break;
				if (won === "heartbeat" && Date.now() - lastPing >= HEARTBEAT_PING_MS) {
					writeFrame(formatPingFrame());
					lastPing = Date.now();
				}
			}
		} finally {
			unsubscribe();
			if (!closed) {
				try {
					res.end();
				} catch {
					// already closed
				}
			}
		}
	}

	/**
	 * Drain persisted events with seq > fromSeq (or, when afterSeq>0 and
	 * < event_min_seq, emit a single event_reset frame). Returns whether this
	 * was a terminal "reset only" pass (close the gap, no replay).
	 *
	 * `afterSeq` is only honored on the first pass; subsequent live-tail calls
	 * pass afterSeq=0 so the reset check is skipped.
	 */
	private async drainReplay(
		sessionId: string,
		afterSeq: number,
		lastSeqIn: number,
		writeFrame: (f: string) => boolean,
		setLastSeq: (s: number) => void,
		setResetSent: (sent: boolean) => void,
	): Promise<{ close: boolean }> {
		let lastSeq = lastSeqIn;
		const data = await this.store.readSession(sessionId);
		if (!data) return { close: true };
		const cur = data.last_event_seq || 0;

		// Gap-window reset (app.py:2095-2103): only when the client supplied a
		// non-zero afterSeq that has aged out of the rolling window.
		if (afterSeq > 0) {
			const minSeq = data.event_min_seq || 0;
			if (afterSeq < minSeq) {
				lastSeq = Math.max(lastSeq, cur);
				setLastSeq(lastSeq);
				writeFrame(formatEventResetFrame(cur, minSeq, cur));
				setResetSent(true);
				return { close: false };
			}
		}

		if (cur > lastSeq) {
			const events = await this.store.replayEvents(sessionId, lastSeq);
			for (const ev of events) {
				const s = ev.seq || 0;
				if (s <= lastSeq) continue;
				lastSeq = s;
				setLastSeq(lastSeq);
				writeFrame(formatEventFrame(s, ev.type, ev.payload));
			}
		}
		setResetSent(false);
		return { close: false };
	}

	// =========================================================================== //
	// JSON helper
	// =========================================================================== //
	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(payload),
		});
		res.end(payload);
	}
}

// =========================================================================== //
// Helpers
// =========================================================================== //

function defaultPort(): number {
	const p = parseInt(process.env.AI_SIDECAR_PORT || "", 10);
	return Number.isFinite(p) && p > 0 ? p : 8055;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : v == null ? "" : String(v);
}

function parseSeq(v: unknown): number {
	if (v == null) return 0;
	const n = parseInt(String(v), 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const c of req) {
		chunks.push(c as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** app.py:1870 _session_list_item field set. */
function sessionListItem(d: { id: string; title: string; kind: string; status: string; archived: boolean; annotation_id: string; updated_at: number; created_at: number }): Record<string, unknown> {
	return {
		id: d.id,
		title: d.title,
		kind: d.kind,
		status: d.status,
		archived: d.archived,
		annotation_id: d.annotation_id || "",
		updated_at: d.updated_at,
		created_at: d.created_at,
	};
}

/**
 * Cancellable heartbeat. Resolves with "heartbeat" after `ms`. The returned
 * `.cancel()` makes the pending promise never settle (the caller races it, so
 * a non-settling promise is harmless — it gets GC'd when the race winner does).
 */
function waitHeartbeat(ms: number): { promise: Promise<"heartbeat">; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<"heartbeat">((resolve) => {
		timer = setTimeout(() => resolve("heartbeat"), ms);
	});
	return {
		promise,
		cancel: () => {
			if (timer) clearTimeout(timer);
		},
	};
}
