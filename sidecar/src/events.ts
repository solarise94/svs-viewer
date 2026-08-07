/**
 * AI reading assistant sidecar — session event bus + SSE framing (Step 3).
 *
 * This module provides the in-process event bus that connects agent runs to SSE
 * streams. It has two responsibilities:
 *
 * 1. **Persistence**: every emitted event is appended to the session's
 *    `<id>.events.jsonl` log via {@link SessionStore.appendEvent}, which
 *    assigns a monotonic `seq` and updates the rolling-window watermark.
 * 2. **Live fanout**: an in-memory subscriber set receives each event as soon
 *    as it is persisted, so SSE streams can replay the catchup window and then
 *    tail live without polling. This preserves the *semantics* of
 *    app.py `_sse_response` (which polls the file every 0.5s) but without the
 *    polling latency.
 *
 * SSE frame format is byte-for-byte identical to app.py:2111-2113:
 *   `id: {seq}\nevent: {type}\ndata: {json}\n\n`
 * Heartbeat frame (app.py:2134): `: ping\n\n`
 * event_reset / session_ended frames are produced by the SSE handler in
 * server.ts using {@link formatEventResetFrame} / {@link formatSessionEndedFrame}.
 *
 * Event-name and payload-field names are **load-bearing** (the frontend hard-
 * codes them); do not rename.
 */
import type { SessionStore } from "./session-store.js";

// =========================================================================== //
// SSE frame formatting (app.py:2099-2134)
// =========================================================================== //

/**
 * Format a normal event frame with an `id:` line (advances Last-Event-ID).
 * Mirrors app.py:2111-2113.
 */
export function formatEventFrame(seq: number, type: string, payload: Record<string, unknown>): string {
	return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Format the heartbeat frame (app.py:2134). SSE comments start with `:` and
 * are ignored by EventSource but keep the connection alive through proxies.
 */
export function formatPingFrame(): string {
	return ": ping\n\n";
}

/**
 * Format the event_reset frame (app.py:2101-2103). Carries an `id:` line so
 * Last-Event-ID advances past the gap and a reconnect does not re-trigger the
 * reset. Note: this frame's `id` is the *current* last_event_seq, matching the
 * Python `id: {}\nevent: event_reset\ndata: ...` template.
 */
export function formatEventResetFrame(curSeq: number, minSeq: number, lastSeq: number): string {
	const payload = { event_min_seq: minSeq, last_event_seq: lastSeq };
	return `id: ${curSeq}\nevent: event_reset\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Format the session_ended frame (app.py:2131-2132). No `id:` line — the
 * stream closes immediately after, so advancing Last-Event-ID is unnecessary.
 */
export function formatSessionEndedFrame(status: string): string {
	return `event: session_ended\ndata: ${JSON.stringify({ status })}\n\n`;
}

// =========================================================================== //
// SessionEventBus
// =========================================================================== //

/**
 * Live subscriber callback. Receives the assigned seq, the event type, and the
 * payload. Subscribers are the SSE streams (server.ts).
 */
export type LiveEventListener = (seq: number, type: string, payload: Record<string, unknown>) => void;

/**
 * Per-session in-process event bus. One instance per sidecar process (the
 * process is single-tenant for AI runs). Backed by {@link SessionStore} for
 * persistence and catchup; the in-memory subscriber set is the live fanout.
 *
 * Concurrency: all persistence goes through SessionStore's per-session mutex,
 * so seq assignment is monotonic. Subscriber callbacks are invoked after the
 * persist resolves, in subscription order; a slow subscriber does not block
 * persistence (it only delays its own notification).
 */
export class SessionEventBus {
	private readonly store: SessionStore;
	private readonly listeners = new Map<string, Set<LiveEventListener>>();

	constructor(store: SessionStore) {
		this.store = store;
	}

	/**
	 * Persist an event and fan it out to live subscribers. Returns the assigned
	 * seq (so the caller can, e.g., log it).
	 *
	 * This is the single emit path used by agent-runner and the run/ask setup
	 * code (slide_opened, fork_created, session_resumed, ...). It replaces
	 * Python's `runner.emit_event`.
	 */
	async emit(sessionId: string, type: string, payload: Record<string, unknown>): Promise<number> {
		const ev = await this.store.appendEvent(sessionId, type, payload);
		const set = this.listeners.get(sessionId);
		if (set) {
			// Copy to avoid mutation-during-iteration if a listener unsubscribes.
			for (const fn of Array.from(set)) {
				try {
					fn(ev.seq, type, payload);
				} catch {
					// A subscriber throwing must not break other subscribers or
					// the emit path. The SSE stream's own error handling closes it.
				}
			}
		}
		return ev.seq;
	}

	/** Subscribe to live events for a session. Returns an unsubscribe function. */
	subscribe(sessionId: string, fn: LiveEventListener): () => void {
		let set = this.listeners.get(sessionId);
		if (!set) {
			set = new Set();
			this.listeners.set(sessionId, set);
		}
		set.add(fn);
		return () => {
			const s = this.listeners.get(sessionId);
			if (!s) return;
			s.delete(fn);
			if (s.size === 0) this.listeners.delete(sessionId);
		};
	}
}

// =========================================================================== //
// AgentEvent → SSE event name mapping reference
// =========================================================================== //
//
// The actual mapping lives in agent-runner.ts (it needs step counters, pending-
// snapshot state, and the run-level decisions). The rules, for reference:
//
//   turn_start                          → agent_thinking {step}
//   message_update(text_delta)          → text_delta {text: delta}
//   (run-level: transient error retry)  → agent_retrying {step,attempt,max:3,delay,reason}
//   (run-level: max_steps reached)      → agent_paused {summary:"已达步数上限",can_continue:true}
//   message_end stopReason==="length"   → agent_paused {summary:"模型输出被截断…",can_continue:true,reason:"max_tokens"}
//   finish tool terminate               → agent_finished {summary}
//   plain-text end (no tool calls)      → agent_finished {summary: text or "(无总结)"}
//   (run-level: exception)              → agent_error {error, step?}
//
// Domain events emitted by tools.ts (tool_started, snapshot_captured,
// observation, annotation_created, snapshot_reviewed) are NOT re-emitted here —
// they are produced directly by the tool executors via the same
// SessionEventBus.emit path.
