/**
 * AI reading assistant sidecar — pi compaction hook (Step 4).
 *
 * Wires pi's harness compaction primitives
 * ({@link shouldCompact}/{@link prepareCompaction}/{@link compact}) into the
 * agent-runner. Replaces ai_session.py:908 `maybe_compact` / 916 `force_compact`
 * / 954 `_inject_spot_index`, and the `_compact_now` history-summary mechanic.
 *
 * Design — Entry adapter (selection rationale):
 *
 * pi's compaction operates on a session-branch `Entry[]` tree
 * (harness/session/types.ts). Our sidecar stores a flat `AgentMessage[]` on
 * `agent.state.messages` (no session-manager branch), so we need a thin adapter
 * that:
 *   - presents each message as a `MessageEntry` (parent chain = linear), and
 *   - materializes the most recent previous compaction as a single
 *     `CompactionEntry` (with `summary` + `retainedTail`) at the front, so pi's
 *     `prepareCompaction` can (a) pick up `previousSummary` for incremental
 *     updates, and (b) virtually unroll the retained tail.
 *
 * We chose the flat-linear adapter (Option A) over re-running pi's full
 * SessionManager because:
 *   - we have no session-manager / branch store; messages are the source of
 *     truth (Step 1 design);
 *   - pi's `prepareCompaction` only reads `Entry` shape + the previous
 *     `CompactionEntry`; a linear `MessageEntry[]` with one synthesized
 *     `CompactionEntry` satisfies that contract exactly;
 *   - the harness `compact()` returns a `CompactResult` (no firstKeptEntryId /
 *     session-manager coupling), so we rebuild the post-compaction message list
 *     directly from `summary + retainedTail`.
 *
 * Outcome of a successful compact:
 *   - the agent's `messages` become `[compactionSummary, ...retainedTail]`;
 *   - a `session_compacted` event is emitted with `tokens_before`/`tokens_after`;
 *   - a spot-index user message is appended (ai_session.py:954 `_inject_spot_index`)
 *     so the model has the current annotation snapshot;
 *   - the previous compaction's `summary` + `retainedTail` are persisted on the
 *     session's `compaction_entries` log so the next compaction can update the
 *     summary incrementally.
 *
 * Failure handling: a compaction LLM-summary failure never breaks the main
 * loop — we log to console and leave the messages untouched (the agent-runner
 * continues with the un-compacted context). Only the `context_length_exceeded`
 * fallback path (force compact → retry the model call once) treats a second
 * failure as fatal.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	compact as piCompact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	type CompactResult,
	type CompactionPreparation,
	type CompactionSettings,
	prepareCompaction,
	type Entry,
	shouldCompact,
	type MessageEntry,
	type CompactionEntry as PiCompactionEntry,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createCompactionSummaryMessage } from "@earendil-works/pi-agent-core";

import type { FlaskClient } from "./flask-client.js";
import type { PersistedAgentMessage, SessionData, SessionStore } from "./session-store.js";

// =========================================================================== //
// Public config
// =========================================================================== //

/** Tuning knobs for compaction. */
export interface CompactionConfig {
	/** Tokens reserved for summary prompt + output (default 16384). */
	reserve_tokens?: number;
	/** Approximate recent-context tokens kept after compaction (default 20000). */
	keep_recent_tokens?: number;
	/** Context window (inherited from engine config; default 272000). */
	context_window_tokens?: number;
}

/** Resolved compaction settings (pi CompactionSettings + context window). */
export interface ResolvedCompactionSettings {
	settings: CompactionSettings;
	contextWindow: number;
}

export function resolveCompactionSettings(cfg: CompactionConfig): ResolvedCompactionSettings {
	const reserve = numOr(cfg.reserve_tokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
	const keepRecent = numOr(cfg.keep_recent_tokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
	return {
		settings: { enabled: true, reserveTokens: reserve, keepRecentTokens: keepRecent },
		contextWindow: numOr(cfg.context_window_tokens, 272000),
	};
}

function numOr(v: unknown, d: number): number {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}

// =========================================================================== //
// Entry adapter: AgentMessage[] (+ prev compaction) → pi Entry[]
// =========================================================================== //

let entryIdCounter = 0;
function nextEntryId(): string {
	entryIdCounter += 1;
	return `svs-compaction-entry-${entryIdCounter}`;
}

/**
 * Build a flat-linear pi `Entry[]` from our message list, optionally prefixed
 * by a synthesized previous-compaction entry.
 *
 * The previous-compaction entry, when supplied, carries the last summary + the
 * retained-tail messages from that compaction. pi's `prepareCompaction` will
 * unroll the retained tail as virtual message entries and feed everything after
 * it to the summarizer, passing `summary` as `previousSummary` for an
 * incremental update.
 *
 * @param prevSummary   summary text from the prior compaction (undefined if none)
 * @param prevRetained  retained-tail messages kept by the prior compaction
 * @param prevTokensBefore tokensBefore recorded for the prior compaction
 */
export function toEntries(
	messages: AgentMessage[],
	prevSummary?: string,
	prevRetained?: AgentMessage[],
	prevTokensBefore?: number,
): Entry[] {
	const entries: Entry[] = [];
	let parentId: string | null = null;

	if (prevSummary !== undefined) {
		const ce: PiCompactionEntry = {
			type: "compaction",
			id: nextEntryId(),
			parentId: null,
			seq: 0,
			timestamp: Date.now(),
			summary: prevSummary,
			retainedTail: prevRetained ?? [],
			tokensBefore: prevTokensBefore ?? 0,
		};
		entries.push(ce);
		parentId = ce.id;
	}

	for (const message of messages) {
		// Skip any compactionSummary messages already in the stream: the
		// synthesized CompactionEntry above is the canonical representation of
		// the last compaction. Carrying both would double-count.
		if ((message as { role?: string }).role === "compactionSummary") continue;
		const me: MessageEntry = {
			type: "message",
			id: nextEntryId(),
			parentId,
			seq: 0,
			timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
			message,
		};
		entries.push(me);
		parentId = me.id;
	}
	return entries;
}

// =========================================================================== //
// Previous-compaction state on the session
// =========================================================================== //

/**
 * Read the most recent compaction's summary + retained tail from the session
 * log, if any. The session store records each compaction in `compaction_entries`
 * with `summary` + `retained_tail` (dehydrated); we rehydrate the tail here.
 */
function readPrevCompaction(data: SessionData): { summary?: string; retainedTail: AgentMessage[]; tokensBefore?: number } {
	const log = data.compaction_entries || [];
	if (log.length === 0) return { retainedTail: [] };
	const last = log[log.length - 1]!;
	const stored = last as PersistedCompactionEntry;
	const summary = stored.summary;
	const tail = stored.retained_tail ?? [];
	// Tail is persisted dehydrated (image blocks → image_ref); it's fine to pass
	// to pi compaction as-is because the summarizer only reads text (serializeConversation).
	const retainedTail = tail as unknown as AgentMessage[];
	return { summary, retainedTail, tokensBefore: last.tokens_before };
}

/** Internal compaction-log record (extends the public CompactionEntry). */
export interface PersistedCompactionEntry {
	seq: number;
	tokens_before: number;
	tokens_after: number;
	reason?: string;
	ts: number;
	/** Summary text (for incremental updates on the next compaction). */
	summary?: string;
	/** Retained-tail messages kept after this compaction (dehydrated form). */
	retained_tail?: PersistedAgentMessage[];
}

// =========================================================================== //
// shouldCompact: usage+trailing estimate (fixes the old Python one-turn lag)
// =========================================================================== //

/**
 * Decide whether the current messages exceed the compaction threshold.
 *
 * Uses pi's `estimateContextTokens` (usage + trailing-tail estimate). This
 * fixes the old Python estimator's one-turn lag: Python keyed off
 * `last_usage.prompt_tokens` which reflects the *previous* request's input, so
 * it could not see tokens added by the just-completed turn until the next one
 * ran. pi's estimator adds an `estimateTokens(message)` walk over the messages
 * after the last usage block, so the threshold check is current.
 */
export function checkShouldCompact(messages: AgentMessage[], settings: ResolvedCompactionSettings): { should: boolean; tokens: number } {
	const est = estimateContextTokens(messages);
	const should = shouldCompact(est.tokens, settings.contextWindow, settings.settings);
	return { should, tokens: est.tokens };
}

// =========================================================================== //
// runCompaction: prepare + compact + rebuild messages
// =========================================================================== //

/** Result of a successful compaction. */
export interface CompactionOutcome {
	/** New message list: compactionSummary + retainedTail. */
	messages: AgentMessage[];
	/** Estimated tokens before compaction. */
	tokensBefore: number;
	/** Estimated tokens after compaction (re-estimated on the new list). */
	tokensAfter: number;
	/** Generated summary text. */
	summary: string;
	/** Retained-tail messages (for the next incremental compaction). */
	retainedTail: AgentMessage[];
}

/**
 * Run one compaction pass over the given messages.
 *
 * @returns the outcome, or `null` when compaction was not applicable (no
 *   messages, or the last entry is already a compaction) or failed.
 */
export async function runCompaction(args: {
	messages: AgentMessage[];
	settings: ResolvedCompactionSettings;
	models: Models;
	model: Model<Api>;
	prevSummary?: string;
	prevRetainedTail?: AgentMessage[];
	prevTokensBefore?: number;
	signal?: AbortSignal;
}): Promise<CompactionOutcome | null> {
	const { messages, settings, models, model } = args;

	const entries = toEntries(messages, args.prevSummary, args.prevRetainedTail, args.prevTokensBefore);
	const preparationResult = prepareCompaction(entries, settings.settings);
	const preparation: CompactionPreparation | undefined = preparationResult.ok ? preparationResult.value : undefined;
	if (!preparation) return null;

	let result: CompactResult;
	try {
		const r = await piCompact(preparation, models, model, undefined, args.signal);
		if (!r.ok) return null;
		result = r.value;
	} catch {
		return null;
	}

	// Build the post-compaction message list: a compactionSummary message
	// carrying the summary, followed by the retained tail. This guarantees the
	// next LLM request sees the summary (fixes "amnesia after compaction").
	const summaryMsg = createCompactionSummaryMessage(result.summary, result.tokensBefore, Date.now()) as unknown as AgentMessage;
	const newMessages: AgentMessage[] = [summaryMsg, ...result.retainedTail];

	// tokensAfter: re-estimate on the new list (usage from retained assistant
	// messages is stale post-compaction, so estimateContextTokens falls back to
	// the char heuristic — fine for a rough "after" number for the event).
	const after = estimateContextTokens(newMessages);

	return {
		messages: newMessages,
		tokensBefore: result.tokensBefore,
		tokensAfter: after.tokens,
		summary: result.summary,
		retainedTail: result.retainedTail,
	};
}

// =========================================================================== //
// Spot-index injection (ai_session.py:954 _inject_spot_index)
// =========================================================================== //

/**
 * Build the "current annotation snapshot" user message injected after every
 * compaction (ai_session.py:964-972). Text-only, full visible-spot list,
 * updates spot_cursor. Byte-for-byte format alignment with the Python original.
 *
 * Returns null when there are no visible spots.
 */
export async function buildSpotIndexMessage(
	flask: FlaskClient,
	slide: string,
): Promise<{ message: AgentMessage; newCursor: number } | null> {
	let result;
	try {
		result = await flask.spots(slide, 0);
	} catch {
		return null;
	}
	const visible = (result.changes || []).filter((r) => !r.deleted);
	if (visible.length === 0) return null;

	const lines: string[] = ["当前切片标注库快照（待复核线索，非诊断事实）："];
	for (const r of visible) {
		const s = Math.trunc(Number(r.side_px) || 0);
		const x0 = Number(r.x) || 0;
		const y0 = Number(r.y) || 0;
		lines.push(
			`- 位置 level-0 左上角 (${fmt0(x0)},${fmt0(y0)})，边长 ${s}px` +
				`（中心 (${fmt0(x0 + s / 2.0)},${fmt0(y0 + s / 2.0)})，goto 请对准中心）：${String(r.note || "")}`,
		);
	}
	const message: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		timestamp: Date.now(),
	} as AgentMessage;
	return { message, newCursor: result.current_seq || 0 };
}

function fmt0(v: number): string {
	return String(Math.round(v));
}

// =========================================================================== //
// Persist helpers
// =========================================================================== //

/**
 * Record a compaction on the session log + apply the new messages. Caller
 * passes the rebuilt message list (already including the compactionSummary and
 * any spot-index injection).
 */
export async function persistCompaction(
	store: SessionStore,
	sessionId: string,
	outcome: CompactionOutcome,
	newMessages: AgentMessage[],
	reason?: string,
): Promise<void> {
	await store.withLock(sessionId, async (d) => {
		if (!d) return null;
		const entry: PersistedCompactionEntry = {
			seq: (d.last_event_seq || 0) + 1,
			tokens_before: outcome.tokensBefore,
			tokens_after: outcome.tokensAfter,
			reason,
			ts: Math.floor(Date.now() / 1000),
			summary: outcome.summary,
			// Persist the retained tail in dehydrated form. The summary message is
			// already at the head of newMessages, so we only need the tail.
			retained_tail: outcome.retainedTail as unknown as PersistedAgentMessage[],
		};
		d.compaction_entries = [...(d.compaction_entries || []), entry as unknown as (typeof d.compaction_entries)[number]];
		d.messages = newMessages as unknown as PersistedAgentMessage[];
		d.updated_at = Math.floor(Date.now() / 1000);
		await store.writeSession(sessionId, d);
		return d;
	});
}

/**
 * Read previous-compaction inputs for the session (summary + retained tail),
 * for the next incremental compaction.
 */
export function prevCompactionInputs(data: SessionData): { summary?: string; retainedTail: AgentMessage[]; tokensBefore?: number } {
	return readPrevCompaction(data);
}
