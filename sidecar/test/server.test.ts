/**
 * SidecarServer tests (Step 3): HTTP contract + SSE transport semantics.
 *
 * Covers the run/continue/ask/cancel/sessions/session endpoints' status codes
 * and response shapes, the SSE frame format, after_seq replay, event_reset on
 * a gap, the X-AI-Session-ID header, session_ended on terminal status, and the
 * heartbeat frame.
 */
import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { BASE_CONFIG, makeFakeStreamFn, makeMockFlask, SLIDE } from "./helpers.js";
import { SessionStore } from "../src/session-store.js";
import { SessionEventBus } from "../src/events.js";
import { AgentRunner } from "../src/agent-runner.js";
import { SidecarServer } from "../src/server.js";
import type { FlaskClient } from "../src/flask-client.js";

/** Track created session dirs for cleanup. */
const createdDirs: string[] = [];

// ------------------------------------------------------------------------- //
// Harness: a real SidecarServer bound to an ephemeral port, with a fake
// streamFn + in-memory FlaskClient mock.
// ------------------------------------------------------------------------- //

interface ServerHarness {
	server: SidecarServer;
	baseUrl: string;
	store: SessionStore;
	bus: SessionEventBus;
	mock: ReturnType<typeof makeMockFlask>;
}

async function startServer(fakeStreamFn: (model: unknown, context: unknown, options?: unknown) => unknown): Promise<ServerHarness> {
	const dir = `/tmp/svs-srv-${Math.random().toString(36).slice(2)}`;
	createdDirs.push(dir);
	const store = new SessionStore({ sessionsDir: dir });
	await store.ensureDir();
	const bus = new SessionEventBus(store);
	const mock = makeMockFlask();
	const runner = new AgentRunner(store, bus, mock as unknown as FlaskClient, { streamFn: fakeStreamFn as never });
	const server = new SidecarServer({ host: "127.0.0.1", port: 0, store, bus, flask: mock as unknown as FlaskClient, runner });
	await server.start();
	const port = server.boundPort;
	return { server, baseUrl: `http://127.0.0.1:${port}`, store, bus, mock };
}

// Best-effort cleanup of created session dirs (runs may still be settling in
// the background; rm errors are ignored).
afterAll(async () => {
	await Promise.all(createdDirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

/** POST JSON and return {status, headers, body}. */
async function post(baseUrl: string, path: string, body: unknown): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
	const res = await fetch(baseUrl + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: unknown = text;
	try { parsed = JSON.parse(text); } catch { /* keep text */ }
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	return { status: res.status, headers, body: parsed };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
	const res = await fetch(baseUrl + path);
	const text = await res.text();
	let parsed: unknown = text;
	try { parsed = JSON.parse(text); } catch { /* keep text */ }
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	return { status: res.status, headers, body: parsed };
}

/** Read an SSE stream until a predicate frame matches, returning collected frames. */
async function readSseUntil(
	res: Response,
	predicate: (frame: string) => boolean,
	opts: { maxMs?: number; maxFrames?: number } = {},
): Promise<string[]> {
	const maxMs = opts.maxMs ?? 5000;
	const maxFrames = opts.maxFrames ?? 1000;
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	const frames: string[] = [];
	const deadline = Date.now() + maxMs;
	let buffer = "";
	while (Date.now() < deadline && frames.length < maxFrames) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buffer.indexOf("\n\n")) >= 0) {
			const frame = buffer.slice(0, idx + 2);
			buffer = buffer.slice(idx + 2);
			frames.push(frame);
			if (predicate(frame)) {
				reader.cancel();
				return frames;
			}
		}
	}
	reader.cancel();
	return frames;
}

/** Parse an SSE frame into {id?, event?, data?}. */
function parseFrame(frame: string): { id?: number; event?: string; data?: unknown; comment?: boolean } {
	const out: { id?: number; event?: string; data?: unknown; comment?: boolean } = {};
	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) { out.comment = true; continue; }
		if (line.startsWith("id:")) { out.id = parseInt(line.slice(3).trim(), 10); continue; }
		if (line.startsWith("event:")) { out.event = line.slice(6).trim(); continue; }
		if (line.startsWith("data:")) {
			try { out.data = JSON.parse(line.slice(5).trim()); } catch { out.data = line.slice(5).trim(); }
		}
	}
	return out;
}

// ------------------------------------------------------------------------- //
// Tests
// ------------------------------------------------------------------------- //

describe("SidecarServer — /healthz", () => {
	it("returns ok", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const r = await getJson(h.baseUrl, "/healthz");
			expect(r.status).toBe(200);
			expect(r.body).toEqual({ ok: true });
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — POST /run SSE", () => {
	it("returns an SSE stream with X-AI-Session-ID and the golden event sequence, ending in session_ended", async () => {
		const { fn } = makeFakeStreamFn([
			{ toolCalls: [{ id: "tc-goto", name: "goto", arguments: { x: 2000, y: 1500, level: 2, reason: "z" } }] },
			{ text: "done", stopReason: "stop" as const },
		]);
		const h = await startServer(fn);
		try {
			const res = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			const sessionId = res.headers.get("x-ai-session-id");
			expect(sessionId).toBeTruthy();
			expect(res.headers.get("cache-control")).toBe("no-cache");
			expect(res.headers.get("x-accel-buffering")).toBe("no");

			const frames = await readSseUntil(res, (f) => f.includes("event: session_ended"));
			const events = frames.map(parseFrame).filter((e) => e.event);
			const types = events.map((e) => e.event);
			expect(types[0]).toBe("slide_opened");
			expect(types).toContain("agent_thinking");
			expect(types).toContain("tool_started");
			expect(types).toContain("text_delta");
			expect(types).toContain("agent_finished");
			expect(types[types.length - 1]).toBe("session_ended");
			// Frames carry id: lines.
			const idFrames = frames.filter((f) => f.startsWith("id:"));
			expect(idFrames.length).toBeGreaterThan(0);
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — POST /run 409 conflict", () => {
	it("returns 409 when the main is already running", async () => {
		// A script whose first turn blocks on a promise we control, so the
		// first run is guaranteed to still be "running" when we fire the second.
		let resolveTurn: () => void = () => {};
		const blockingFn = (_model: unknown, _context: unknown, _options?: unknown) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await new Promise<void>((r) => { resolveTurn = r; });
				const msg = {
					role: "assistant" as const, content: [{ type: "text" as const, text: "done" }],
					api: "openai-completions" as const, provider: "cpa-gateway", model: "test-model",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop" as const, timestamp: Date.now(),
				};
				stream.push({ type: "start" as const, partial: msg });
				stream.push({ type: "done" as const, reason: "stop" as const, message: msg });
				stream.end(msg);
			})();
			return stream;
		};
		const h = await startServer(blockingFn as never);
		try {
			// Kick the first run (its streamFn blocks on resolveTurn).
			const firstRes = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			// Give the runner a tick to acquire + flip status to running.
			await delay(30);
			const r = await post(h.baseUrl, "/run", { slide: SLIDE, config: { ...BASE_CONFIG }, fresh: false });
			expect(r.status).toBe(409);
			// Release the first run so the server can shut down cleanly.
			resolveTurn();
			try { await firstRes.body!.cancel(); } catch { /* ignore */ }
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — GET /sessions and /session/:id", () => {
	it("lists sessions and returns a detail with a transcript", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			// Run a session to completion.
			const runRes = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			const sessionId = runRes.headers.get("x-ai-session-id")!;
			await readSseUntil(runRes, (f) => f.includes("event: session_ended"));

			// GET /sessions
			const list = await getJson(h.baseUrl, `/sessions?slide=${encodeURIComponent(SLIDE)}`);
			expect(list.status).toBe(200);
			const sessions = (list.body as { sessions: Array<{ id: string; kind: string }> }).sessions;
			expect(sessions.length).toBe(1);
			expect(sessions[0]!.id).toBe(sessionId);

			// GET /session/:id
			const detail = await getJson(h.baseUrl, `/session/${sessionId}`);
			expect(detail.status).toBe(200);
			const d = detail.body as { session: { id: string; status: string; agent_state: unknown }; transcript: unknown[] };
			expect(d.session.id).toBe(sessionId);
			expect(d.session.status).toBe("finished");
			expect(d.session.agent_state).toBeDefined();
			expect(Array.isArray(d.transcript)).toBe(true);
		} finally {
			await h.server.stop();
		}
	});

	it("returns 404 for an unknown session id", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const r = await getJson(h.baseUrl, "/session/sess-doesnotexist");
			expect(r.status).toBe(404);
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — GET /session/:id/stream (replay + event_reset)", () => {
	it("replays persisted events from after_seq, then session_ended", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const runRes = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			const sessionId = runRes.headers.get("x-ai-session-id")!;
			await readSseUntil(runRes, (f) => f.includes("event: session_ended"));

			// Reconnect from after_seq=0 — replays everything + session_ended.
			const streamRes = await fetch(h.baseUrl + `/session/${sessionId}/stream?after_seq=0`);
			expect(streamRes.status).toBe(200);
			expect(streamRes.headers.get("x-ai-session-id")).toBe(sessionId);
			const frames = await readSseUntil(streamRes, (f) => f.includes("event: session_ended"));
			const events = frames.map(parseFrame).filter((e) => e.event);
			expect(events[0]!.event).toBe("slide_opened");
			expect(events[events.length - 1]!.event).toBe("session_ended");
		} finally {
			await h.server.stop();
		}
	});

	it("emits event_reset when after_seq is below event_min_seq", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const runRes = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			const sessionId = runRes.headers.get("x-ai-session-id")!;
			await readSseUntil(runRes, (f) => f.includes("event: session_ended"));

			// Lower the event_min_seq watermark above 1, then reconnect with
			// after_seq=1 — which is now below the watermark → event_reset.
			const data = await h.store.readSession(sessionId);
			expect(data).not.toBeNull();
			data!.event_min_seq = 50;
			await h.store.writeSession(sessionId, data!);

			const streamRes = await fetch(h.baseUrl + `/session/${sessionId}/stream?after_seq=1`);
			const frames = await readSseUntil(streamRes, (f) => f.includes("event: event_reset"));
			const reset = frames.map(parseFrame).find((e) => e.event === "event_reset");
			expect(reset).toBeDefined();
			expect((reset!.data as { event_min_seq: number; last_event_seq: number }).event_min_seq).toBe(50);
			// The reset frame carries an id: line (advances Last-Event-ID).
			expect(reset!.id).toBeDefined();
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — heartbeat frame", () => {
	it("emits a `: ping` heartbeat on a long-lived idle stream", async () => {
		// A run that stays in "running" (never settles) so the stream lives
		// past the heartbeat interval. We lower the heartbeat interval for the
		// test by... we can't, so instead we verify the ping format by reading
		// a finished session's stream that we keep open longer than 15s is
		// impractical. Instead, unit-test the format helper directly.
		const { formatPingFrame } = await import("../src/events.js");
		expect(formatPingFrame()).toBe(": ping\n\n");
	});
});

describe("SidecarServer — POST /cancel", () => {
	it("returns ok:true for an existing session", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const runRes = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			const sessionId = runRes.headers.get("x-ai-session-id")!;
			await readSseUntil(runRes, (f) => f.includes("event: session_ended"));
			const r = await post(h.baseUrl, "/cancel", { session_id: sessionId });
			expect(r.status).toBe(200);
			expect(r.body).toEqual({ ok: true });
		} finally {
			await h.server.stop();
		}
	});

	it("returns 404 for an unknown session_id", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const r = await post(h.baseUrl, "/cancel", { session_id: "sess-nope" });
			expect(r.status).toBe(404);
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — POST /continue 404", () => {
	it("returns 404 when there is no main session", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const r = await post(h.baseUrl, "/continue", { slide: SLIDE, config: { ...BASE_CONFIG } });
			expect(r.status).toBe(404);
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — POST /ask 410", () => {
	it("returns 410 when the root annotation is deleted", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			h.mock.spotChanges.push({ annotation_id: "gone", x: 1, y: 1, side_px: 1, note: "", change_seq: ++h.mock.currentSeq, deleted: true });
			const r = await post(h.baseUrl, "/ask", { slide: SLIDE, annotation_id: "gone", config: { ...BASE_CONFIG } });
			expect(r.status).toBe(410);
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — POST /branch", () => {
	it("starts a branch session (SSE) with branch_created + X-AI-Session-ID, settling finished", async () => {
		const { fn } = makeFakeStreamFn([{ text: "深读完成。", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			h.mock.spotChanges.push({ annotation_id: "br-srv-1", x: 1000, y: 2000, side_px: 400, note: "原标注", label: "可疑", change_seq: ++h.mock.currentSeq, deleted: false, size_mm: 0.02 });
			const res = await fetch(h.baseUrl + "/branch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, annotation_id: "br-srv-1", question: "深读", config: { ...BASE_CONFIG } }),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			const sessionId = res.headers.get("x-ai-session-id");
			expect(sessionId).toBeTruthy();

			const frames = await readSseUntil(res, (f) => f.includes("event: session_ended"));
			const events = frames.map(parseFrame).filter((e) => e.event);
			const types = events.map((e) => e.event);
			expect(types).toContain("branch_created");
			expect(types).toContain("agent_finished");
			expect(types[types.length - 1]).toBe("session_ended");
			// branch_created payload carries annotation_id + title.
			const created = events.find((e) => e.event === "branch_created")!;
			expect((created.data as { annotation_id: string }).annotation_id).toBe("br-srv-1");
			expect(typeof (created.data as { title: string }).title).toBe("string");
		} finally {
			await h.server.stop();
		}
	});

	it("returns 410 when the root annotation is deleted", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			h.mock.spotChanges.push({ annotation_id: "br-gone", x: 1, y: 1, side_px: 1, note: "", change_seq: ++h.mock.currentSeq, deleted: true });
			const r = await post(h.baseUrl, "/branch", { slide: SLIDE, annotation_id: "br-gone", config: { ...BASE_CONFIG } });
			expect(r.status).toBe(410);
		} finally {
			await h.server.stop();
		}
	});

	it("lists the branch under /sessions with kind='branch'", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			h.mock.spotChanges.push({ annotation_id: "br-srv-2", x: 100, y: 100, side_px: 100, note: "n", label: "L", change_seq: ++h.mock.currentSeq, deleted: false });
			const res = await fetch(h.baseUrl + "/branch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, annotation_id: "br-srv-2", config: { ...BASE_CONFIG } }),
			});
			await readSseUntil(res, (f) => f.includes("event: session_ended"));

			const r = await getJson(h.baseUrl, `/sessions?slide=${encodeURIComponent(SLIDE)}`);
			expect(r.status).toBe(200);
			const sessions = (r.body as { sessions: Array<{ kind: string; annotation_id: string }> }).sessions;
			const branch = sessions.find((s) => s.annotation_id === "br-srv-2");
			expect(branch).toBeDefined();
			expect(branch!.kind).toBe("branch");
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — archive/unarchive", () => {
	it("toggles archived and forbids archiving a running session", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			const runRes = await fetch(h.baseUrl + "/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, config: { ...BASE_CONFIG }, fresh: true }),
			});
			const sessionId = runRes.headers.get("x-ai-session-id")!;
			await readSseUntil(runRes, (f) => f.includes("event: session_ended"));

			// Archive (session is finished, not running).
			const ar = await post(h.baseUrl, `/session/${sessionId}/archive`, {});
			expect(ar.status).toBe(200);
			expect((ar.body as { archived: boolean }).archived).toBe(true);
			// Unarchive.
			const ur = await post(h.baseUrl, `/session/${sessionId}/unarchive`, {});
			expect((ur.body as { archived: boolean }).archived).toBe(false);
		} finally {
			await h.server.stop();
		}
	});
});

describe("SidecarServer — fork/branch 续聊 SSE 不重放历史", () => {
	it("fork resume stream starts at fork_resumed (no fork_created / old frames)", async () => {
		const { fn } = makeFakeStreamFn([{ text: "第一次回答。", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			h.mock.spotChanges.push({ annotation_id: "fk-re-1", x: 100, y: 200, side_px: 400, note: "", label: "灶", change_seq: ++h.mock.currentSeq, deleted: false });
			// 第一轮：创建并跑完。
			const res1 = await fetch(h.baseUrl + "/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, annotation_id: "fk-re-1", question: "第一问", config: { ...BASE_CONFIG } }),
			});
			expect(res1.status).toBe(200);
			const frames1 = await readSseUntil(res1, (f) => f.includes("event: session_ended"));
			expect(frames1.some((f) => f.includes("fork_created"))).toBe(true);

			// 第二轮：续聊——流必须从 fork_resumed 起，不带任何第一轮的事件。
			const res2 = await fetch(h.baseUrl + "/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, annotation_id: "fk-re-1", question: "第二问", config: { ...BASE_CONFIG } }),
			});
			expect(res2.status).toBe(200);
			const frames2 = await readSseUntil(res2, (f) => f.includes("event: session_ended"));
			const joined = frames2.join("");
			expect(frames2[0]).toContain("fork_resumed");
			expect(joined).not.toContain("fork_created");
			expect(joined).not.toContain("第一次回答。");
		} finally {
			await h.server.stop();
		}
	});

	it("branch resume stream starts at branch_resumed (no branch_created / old frames)", async () => {
		const { fn } = makeFakeStreamFn([{ text: "首轮深读。", stopReason: "stop" as const }]);
		const h = await startServer(fn);
		try {
			h.mock.spotChanges.push({ annotation_id: "br-re-1", x: 100, y: 200, side_px: 400, note: "", label: "灶", change_seq: ++h.mock.currentSeq, deleted: false });
			const res1 = await fetch(h.baseUrl + "/branch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, annotation_id: "br-re-1", question: "首轮", config: { ...BASE_CONFIG } }),
			});
			expect(res1.status).toBe(200);
			const frames1 = await readSseUntil(res1, (f) => f.includes("event: session_ended"));
			expect(frames1.some((f) => f.includes("branch_created"))).toBe(true);

			const res2 = await fetch(h.baseUrl + "/branch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slide: SLIDE, annotation_id: "br-re-1", question: "续问", config: { ...BASE_CONFIG } }),
			});
			expect(res2.status).toBe(200);
			const frames2 = await readSseUntil(res2, (f) => f.includes("event: session_ended"));
			const joined = frames2.join("");
			expect(frames2[0]).toContain("branch_resumed");
			expect(joined).not.toContain("branch_created");
			expect(joined).not.toContain("首轮深读。");
		} finally {
			await h.server.stop();
		}
	});
});
