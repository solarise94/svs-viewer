/**
 * AI reading assistant sidecar — session store + event log (Step 1 of the
 * pi migration).
 *
 * This module is the Node replacement for the persistence layer of
 * ai_session.py. The disk format and externally-visible JSON field names are
 * kept byte-for-byte compatible with the existing Flask proxy layer and the
 * frontend; only the in-process concurrency model changes (single Node
 * process: no cross-process file locks, no lease/fencing/WAL machinery).
 *
 * Alignment / deviation notes reference ai_session.py by line.
 *
 * Directory layout (under `<sessionsDir>`, env SHARE_DATA_DIR/ai_sessions,
 * default ~/svs-viewer/share-data/ai_sessions):
 *   - <id>.json            session metadata (atomic tmp+rename, 0600)
 *   - <id>.events.jsonl    one event per line, append + fsync
 *   - index.json           {slide: {main, forks:{annotation_id: sid}}}
 *
 * Cross-references:
 *   _empty_session   ai_session.py:135
 *   _ai_sessions_dir ai_session.py:77
 *   write_session    ai_session.py:182
 *   append_event     ai_session.py:326
 *   replay_events    ai_session.py:352
 *   _repair_event_seq ai_session.py:295
 *   register/unregister/list_session_ids_by_slide ai_session.py:250/264/280
 */
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

/** Session kind (ai_session.py:140 "main" | "fork"). */
export type SessionKind = "main" | "fork";

/** Status state machine (ai_session.py:9, 155). */
export type SessionStatus = "idle" | "running" | "paused" | "finished" | "error";

/** Viewport snapshot persisted for continue-from-last-position (ai_session.py:148). */
export interface AgentState {
	center_x: number;
	center_y: number;
	pyramid_level: number;
	viewport_px: number;
}

/**
 * On-disk image placeholder. Replaces pi {@link ImageContent} blocks when
 * persisting messages so session JSON never carries base64 blobs (matches the
 * existing canonical image_ref contract, ai_session.py:1185-1196 / 1214-1226).
 *
 * Field names follow the existing on-disk shape; `src` / `magnification` /
 * `slide_fingerprint` come from the tool execution site via {@link ImageMeta}.
 */
export interface ImageRefContent {
	type: "image_ref";
	ref_id: string;
	slide_fingerprint: string;
	src: { x: number; y: number; w: number; h: number };
	magnification: string;
	summary: string;
}

/**
 * Metadata produced by the tool execution site that identifies an image block;
 * passed into {@link dehydrateMessages} so each replaced image becomes an
 * {@link ImageRefContent}. Keyed by the toolCallId whose result carries the
 * image (assistant-authored image blocks are rare; they fall back to ref_id
 * derived from the assistant message id).
 */
export interface ImageMeta {
	/** Tool call id (pi ToolCall.id) this image belongs to, or assistant key. */
	toolCallId: string;
	slide_fingerprint: string;
	src: { x: number; y: number; w: number; h: number };
	magnification: string;
	/** Short human-readable note shown alongside the placeholder. */
	summary: string;
}

/**
 * A content block that may appear in a persisted message: any pi content type
 * plus our {@link ImageRefContent} placeholder.
 */
export type PersistedContent =
	| TextContent
	| ImageContent
	| ImageRefContent
	| { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };

/**
 * A persisted AgentMessage. pi AgentMessage is a union of LLM Message types
 * plus app-defined custom messages; on disk we keep that exact shape, except
 * image content blocks are dehydrated to {@link ImageRefContent}. Because the
 * persisted form widens the content union, we type messages as a structural
 * superset (`PersistedAgentMessage`) rather than the narrower pi union.
 */
export type PersistedAgentMessage = (
	| { role: "user"; content: string | PersistedContent[]; timestamp: number }
	| (Omit<AssistantMessage, "content"> & { content: PersistedContent[] })
	| (Omit<ToolResultMessage, "content"> & { content: PersistedContent[] })
	| { role: string; content: unknown; timestamp?: number }
);

/** Compaction bookkeeping entry (Step 4 fills this in; declared now). */
export interface CompactionEntry {
	/** Event seq at which the compaction was emitted. */
	seq: number;
	/** Estimated tokens before/after, for the session_compacted event payload. */
	tokens_before: number;
	tokens_after: number;
	reason?: string;
	/** Unix seconds. */
	ts: number;
}

/** Pending snapshot review guard payload (ai_session.py:1037). */
export interface PendingSnapshotReview {
	snapshot_id: string;
	bbox: Record<string, number>;
	image_ref: ImageRefContent;
}

/** Observation record persisted into the session (ai_session.py:1066). */
export interface Observation {
	bbox?: { x?: number; y?: number; w?: number; h?: number };
	note?: string;
	[k: string]: unknown;
}

/**
 * Session JSON shape (external contract).
 *
 * Fields retained verbatim from ai_session.py:138-166: id, slide, kind,
 * annotation_id, title, created_at, updated_at, last_accessed_at, archived,
 * agent_state, observations, pending_snapshot_review, spot_cursor, status,
 * summary, last_event_seq, event_min_seq.
 *
 * Dropped (in-process only now; no longer written to disk):
 * active_run_id, lease_epoch, lease_expires_at, heartbeat_at, pending_bundle,
 * cancel_requested, revision, bundle_seq, compacted_upto.
 *
 * New: `messages` (pi AgentMessage[] form, replacing canonical_messages) and
 * `compaction_entries` (Step 4).
 */
export interface SessionData {
	id: string;
	slide: string;
	kind: SessionKind;
	annotation_id: string;
	title: string;
	created_at: number;
	updated_at: number;
	last_accessed_at: number;
	archived: boolean;
	agent_state: AgentState;
	observations: Observation[];
	pending_snapshot_review: PendingSnapshotReview | null;
	spot_cursor: number;
	status: SessionStatus;
	summary: string | null;
	last_event_seq: number;
	event_min_seq: number;

	/** Size of the rolling event window (ai_session.py:341 `event_buffer_size`). */
	event_buffer_size: number;

	// New vs ai_session.py -------------------------------------------------
	/** pi AgentMessage[] form with image blocks dehydrated to image_ref. */
	messages: PersistedAgentMessage[];
	/** Compaction log; populated in Step 4. */
	compaction_entries: CompactionEntry[];
}

/** A logged event line in `<id>.events.jsonl` (ai_session.py:333). */
export interface SessionEvent {
	type: string;
	payload: Record<string, unknown>;
	ts: number;
	seq: number;
}

/** index.json entry shape (ai_session.py:255). */
export interface SlideIndexEntry {
	main: string | null;
	forks: Record<string, string>;
}

export type SessionIndex = Record<string, SlideIndexEntry>;

// --------------------------------------------------------------------------- //
// Errors
// --------------------------------------------------------------------------- //

/** HTTP 409 semantic: session already running / illegal transition. */
export class SessionConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionConflict";
	}
}

// --------------------------------------------------------------------------- //
// Paths & defaults
// --------------------------------------------------------------------------- //

const DEFAULT_EVENT_BUFFER = 200;

function defaultSessionsDir(): string {
	const base = process.env.SHARE_DATA_DIR || join(homedir(), "svs-viewer", "share-data");
	return join(base, "ai_sessions");
}

function sessionFile(sessionsDir: string, id: string): string {
	return join(sessionsDir, `${id}.json`);
}

function eventsFile(sessionsDir: string, id: string): string {
	return join(sessionsDir, `${id}.events.jsonl`);
}

function indexPath(sessionsDir: string): string {
	return join(sessionsDir, "index.json");
}

function newSessionId(): string {
	return "sess_" + randomUUID().replace(/-/g, "").slice(0, 16);
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

// --------------------------------------------------------------------------- //
// Session store
// --------------------------------------------------------------------------- //

export interface SessionStoreOptions {
	/** Override sessions directory (tests). Defaults to SHARE_DATA_DIR/ai_sessions. */
	sessionsDir?: string;
	/** Rolling event window size (ai_session.py:44 event_buffer). */
	eventBuffer?: number;
}

/**
 * Per-session-store async mutex map. Keyed by store instance + session id so
 * independent stores (e.g. test temp dirs) don't share locks. Single Node
 * process means in-process serialization is sufficient; there are no
 * cross-process file locks.
 */
class AsyncMutex {
	private tail: Promise<unknown> = Promise.resolve();
	acquire<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn, fn);
		// Keep the chain alive even if fn rejects.
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

export class SessionStore {
	readonly sessionsDir: string;
	private readonly eventBuffer: number;
	private readonly mutex = new AsyncMutex();

	constructor(opts: SessionStoreOptions = {}) {
		this.sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
		this.eventBuffer = opts.eventBuffer ?? DEFAULT_EVENT_BUFFER;
	}

	// ------------------------------------------------------------------ //
	// Directory bootstrap (ai_session.py:77-85)
	// ------------------------------------------------------------------ //
	/**
	 * Ensures the sessions directory exists with 0700 perms. mkdir + chmod is
	 * split because mkdir's mode is masked by umask; we chmod explicitly like
	 * the Python impl (which ignores chmod failures).
	 */
	async ensureDir(): Promise<void> {
		await fs.mkdir(this.sessionsDir, { recursive: true });
		try {
			await fs.chmod(this.sessionsDir, 0o700);
		} catch {
			// chmod may fail on some filesystems; ignore (ai_session.py:83).
		}
	}

	// ------------------------------------------------------------------ //
	// Atomic write (ai_session.py:182-192)
	// ------------------------------------------------------------------ //
	/**
	 * Atomic write: tmp file + fsync(dir) + rename. Files are 0600.
	 *
	 * Trade-off: we use synchronous fsyncSync for durability because Node's
	 * fs.promises has no fd-based fsync helper and file handle APIs add churn
	 * for no gain on these small files. Renames are atomic on POSIX so a
	 * reader never observes a half-written JSON.
	 */
	async writeSession(id: string, data: SessionData): Promise<void> {
		const target = sessionFile(this.sessionsDir, id);
		const tmp = `${target}.tmp`;
		const serialized = JSON.stringify(data, null, 2) + "\n";
		// Write + fsync the tmp file, then rename atomically.
		const fh = await fs.open(tmp, "w");
		try {
			await fh.writeFile(serialized);
			await fh.sync(); // durability of tmp content
		} finally {
			await fh.close();
		}
		try {
			await fs.chmod(tmp, 0o600);
		} catch {
			// ignore (matches ai_session.py:190)
		}
		await fs.rename(tmp, target);
		await this.syncDir(); // durability of the rename entry
	}

	/** fsync the directory so the rename is durable. No-op-safe on errors. */
	private async syncDir(): Promise<void> {
		const dir = await fs.open(dirname(this.sessionsDir), "r");
		try {
			await dir.sync();
		} catch {
			// some platforms can't fsync directories
		} finally {
			await dir.close();
		}
	}

	/** Read session JSON (ai_session.py:169). Returns null if missing/corrupt. */
	async readSession(id: string): Promise<SessionData | null> {
		const p = sessionFile(this.sessionsDir, id);
		try {
			const raw = await fs.readFile(p, "utf8");
			const data = JSON.parse(raw);
			return isSessionData(data) ? data : null;
		} catch {
			return null;
		}
	}

	/** Read+write under the per-session mutex. */
	async withLock<T>(id: string, fn: (data: SessionData | null) => Promise<T>): Promise<T> {
		return this.mutex.acquire(async () => {
			const data = await this.readSession(id);
			return fn(data);
		});
	}

	// ------------------------------------------------------------------ //
	// Session creation (ai_session.py:135 _empty_session)
	// ------------------------------------------------------------------ //
	emptySession(slide: string, kind: SessionKind, id: string, annotationId = "", title = ""): SessionData {
		const t = nowSec();
		return {
			id,
			slide,
			kind,
			annotation_id: annotationId,
			title: title || (kind === "fork" ? "批注对话" : "全片读片"),
			created_at: t,
			updated_at: t,
			last_accessed_at: t,
			archived: false,
			agent_state: { center_x: 0, center_y: 0, pyramid_level: 0, viewport_px: 1024 },
			observations: [],
			pending_snapshot_review: null,
			spot_cursor: 0,
			status: "idle",
			summary: null,
			last_event_seq: 0,
			event_min_seq: 0,
			event_buffer_size: this.eventBuffer,
			messages: [],
			compaction_entries: [],
		};
	}

	/**
	 * Create + persist a new session and register it in index.json. Throws
	 * SessionConflict if a main/fork slot is already occupied with a different
	 * id (caller decides overwrite semantics; we mirror register_session's
	 * overwrite behavior only for main).
	 */
	async createSession(args: {
		slide: string;
		kind: SessionKind;
		annotationId?: string;
		title?: string;
	}): Promise<SessionData> {
		await this.ensureDir();
		const id = newSessionId();
		const data = this.emptySession(args.slide, args.kind, id, args.annotationId ?? "", args.title ?? "");
		await this.writeSession(id, data);
		await this.register(args.slide, id, args.kind, args.annotationId ?? "");
		return data;
	}

	// ------------------------------------------------------------------ //
	// Acquire (CAS, ai_session.py:447-518)
	// ------------------------------------------------------------------ //
	/**
	 * Acquire a session for running: status must not be "running" (409
	 * SessionConflict). On success sets status="running".
	 *
	 * Deviation from ai_session.py: no lease_epoch / active_run_id / fencing
	 * token — the new sidecar is a single Node process, so in-process mutex
	 * serialization replaces cross-process lease fencing. Crash recovery is
	 * handled by {@link recoverOnBoot} (running → paused).
	 */
	async acquire(args: {
		sessionId?: string;
		slide: string;
		kind: SessionKind;
		annotationId?: string;
		title?: string;
	}): Promise<SessionData> {
		await this.ensureDir();
		return this.withLock(args.sessionId ?? "", async (existing) => {
			const id = args.sessionId ?? newSessionId();
			let data: SessionData;
			if (existing === null) {
				data = this.emptySession(args.slide, args.kind, id, args.annotationId ?? "", args.title ?? "");
			} else {
				if (existing.slide !== args.slide || existing.kind !== args.kind) {
					throw new SessionConflict("会话类型不匹配");
				}
				// Crash recovery: repair event seq against the events file tail
				// (ai_session.py:490 _repair_event_seq).
				await this.repairEventSeq(id, existing);
				data = existing;
			}
			if (data.status === "running") {
				throw new SessionConflict("会话正在运行中");
			}
			if (data.status !== "idle" && data.status !== "paused" && data.status !== "finished" && data.status !== "error") {
				throw new SessionConflict("会话状态非法");
			}
			const t = nowSec();
			data.status = "running";
			data.last_accessed_at = t;
			data.updated_at = t;
			await this.writeSession(id, data);
			if (existing === null) {
				await this.register(args.slide, id, args.kind, args.annotationId ?? "");
			}
			return data;
		});
	}

	/** Transition to a terminal/paused status (ai_session.py:1088 transition). */
	async setStatus(id: string, status: SessionStatus): Promise<SessionData | null> {
		return this.withLock(id, async (data) => {
			if (data === null) return null;
			const t = nowSec();
			data.status = status;
			data.updated_at = t;
			data.last_accessed_at = t;
			await this.writeSession(id, data);
			return data;
		});
	}

	// ------------------------------------------------------------------ //
	// Archive guard (ai_session.py "finalize" + archive semantics)
	// ------------------------------------------------------------------ //
	/**
	 * Archive a session. A running session cannot be archived → 409
	 * (SessionConflict). Forks share the same guard.
	 */
	async archive(id: string): Promise<SessionData> {
		return this.withLock(id, async (data) => {
			if (data === null) throw new SessionConflict("会话不存在");
			if (data.status === "running") {
				throw new SessionConflict("会话正在运行中，无法归档");
			}
			data.archived = true;
			data.updated_at = nowSec();
			await this.writeSession(id, data);
			return data;
		});
	}

	async unarchive(id: string): Promise<SessionData> {
		return this.withLock(id, async (data) => {
			if (data === null) throw new SessionConflict("会话不存在");
			data.archived = false;
			data.updated_at = nowSec();
			await this.writeSession(id, data);
			return data;
		});
	}

	// ------------------------------------------------------------------ //
	// Event log (ai_session.py:326 append_event / 352 replay_events)
	// ------------------------------------------------------------------ //
	/**
	 * Append one event to `<id>.events.jsonl` under the per-session mutex,
	 * assign a monotonic seq (last_event_seq+1), and update the rolling-window
	 * watermark `event_min_seq`.
	 *
	 * Rolling semantics (ai_session.py:340-348):
	 *   event_min_seq = max(seq - buf + 1, 1)
	 * The Python code does NOT physically truncate the file; event_min_seq is
	 * a *declarative* watermark. Consumers seeing afterSeq < event_min_seq
	 * must issue event_reset. We preserve that exact semantic here (see
	 * {@link replayEvents}). Keeping the file append-only also avoids an
	 * expensive rewrite on every event.
	 */
	async appendEvent(id: string, type: string, payload: Record<string, unknown>): Promise<SessionEvent> {
		return this.withLock(id, async (data) => {
			if (data === null) throw new SessionConflict("会话不存在");
			const seq = data.last_event_seq + 1;
			const ev: SessionEvent = { type, payload, ts: nowSec(), seq };
			const line = JSON.stringify(ev) + "\n";
			const p = eventsFile(this.sessionsDir, id);
			// append + fsync (ai_session.py:335-338 uses flush+fsync).
			const fh = await fs.open(p, "a");
			try {
				await fh.appendFile(line);
				await fh.sync();
			} finally {
				await fh.close();
			}
			data.last_event_seq = seq;
			const buf = data.event_buffer_size || this.eventBuffer;
			data.event_min_seq = Math.max(seq - buf + 1, 1);
			data.updated_at = nowSec();
			await this.writeSession(id, data);
			return ev;
		});
	}

	/**
	 * Replay events with seq > afterSeq (ai_session.py:352).
	 *
	 * Returns the in-file events strictly after afterSeq. The caller is
	 * responsible for emitting `event_reset` when afterSeq < event_min_seq:
	 * this module surfaces the watermark via {@link SessionData}.event_min_seq
	 * and via the returned array, but does not synthesize a reset event.
	 */
	async replayEvents(id: string, afterSeq: number): Promise<SessionEvent[]> {
		const p = eventsFile(this.sessionsDir, id);
		let raw: string;
		try {
			raw = await fs.readFile(p, "utf8");
		} catch {
			return [];
		}
		const out: SessionEvent[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let ev: SessionEvent;
			try {
				ev = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (typeof ev.seq === "number" && ev.seq > afterSeq) {
				out.push(ev);
			}
		}
		return out;
	}

	/**
	 * Boot-time repair: scan the events file tail and reconcile
	 * `last_event_seq` / `event_min_seq` with the actual max seq on disk
	 * (ai_session.py:295 _repair_event_seq).
	 *
	 * Avoids the case where events were appended up to seq 120 but the
	 * metadata write only reached 115 (crash between append and metadata
	 * write), which would otherwise cause duplicate seq allocation.
	 *
	 * Mutates `data` in place; does NOT write the session file (callers write
	 * once after all repairs, e.g. {@link recoverOnBoot}).
	 */
	async repairEventSeq(id: string, data: SessionData): Promise<void> {
		const p = eventsFile(this.sessionsDir, id);
		let raw: string;
		try {
			raw = await fs.readFile(p, "utf8");
		} catch {
			return;
		}
		// Mirror ai_session.py:307 — read up to the last 512 lines; seq is
		// monotonic so the tail's max is the file's max.
		const lines = raw.split("\n");
		const tail = lines.slice(Math.max(0, lines.length - 512));
		let maxSeq = 0;
		let minSeq = Number.POSITIVE_INFINITY;
		for (const line of tail) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let ev: { seq?: unknown };
			try {
				ev = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (typeof ev.seq === "number") {
				if (ev.seq > maxSeq) maxSeq = ev.seq;
				if (ev.seq < minSeq) minSeq = ev.seq;
			}
		}
		if (!Number.isFinite(minSeq)) minSeq = maxSeq;
		if (maxSeq > data.last_event_seq) {
			data.last_event_seq = maxSeq;
			// ai_session.py:323 — keep the smaller of (existing min, observed max).
			data.event_min_seq = Math.min(data.event_min_seq || maxSeq, maxSeq);
		}
	}

	/**
	 * Boot recovery (ai_session.py:498-504 crash-residue path, generalized).
	 *
	 * Scans every session file; any status==="running" session is flipped to
	 * "paused" (its worker died with the process), and every session's
	 * last_event_seq is reconciled against its events file tail.
	 */
	async recoverOnBoot(): Promise<{ repaired: string[]; paused: string[] }> {
		await this.ensureDir();
		const entries = await fs.readdir(this.sessionsDir);
		const sessionIds = entries
			.filter((e) => e.endsWith(".json") && !e.endsWith(".tmp") && e !== "index.json")
			.map((e) => e.slice(0, -".json".length));
		const repaired: string[] = [];
		const paused: string[] = [];
		for (const id of sessionIds) {
			const data = await this.readSession(id);
			if (data === null) continue;
			const beforeSeq = data.last_event_seq;
			await this.repairEventSeq(id, data);
			const seqChanged = data.last_event_seq !== beforeSeq;
			let statusChanged = false;
			if (data.status === "running") {
				data.status = "paused";
				statusChanged = true;
				paused.push(id);
			}
			if (seqChanged || statusChanged) {
				data.updated_at = nowSec();
				await this.writeSession(id, data);
				if (seqChanged) repaired.push(id);
			}
		}
		return { repaired, paused };
	}

	// ------------------------------------------------------------------ //
	// index.json (ai_session.py:207-289)
	// ------------------------------------------------------------------ //
	private async readIndex(): Promise<SessionIndex> {
		const p = indexPath(this.sessionsDir);
		try {
			const raw = await fs.readFile(p, "utf8");
			const data = JSON.parse(raw);
			return isSessionIndex(data) ? data : {};
		} catch {
			return {};
		}
	}

	/**
	 * Atomic write of index.json at 0600 (ai_session.py:229-234).
	 * Index writes are serialized by the JS event loop (single-threaded), so
	 * the Python per-index fcntl lock is unnecessary.
	 */
	private async writeIndex(idx: SessionIndex): Promise<void> {
		const target = indexPath(this.sessionsDir);
		const tmp = `${target}.tmp`;
		const fh = await fs.open(tmp, "w");
		try {
			await fh.writeFile(JSON.stringify(idx, null, 2) + "\n");
			await fh.sync();
		} finally {
			await fh.close();
		}
		try {
			await fs.chmod(tmp, 0o600);
		} catch {
			// ignore
		}
		await fs.rename(tmp, target);
	}

	/** Register a session in index.json (ai_session.py:250). */
	async register(
		slide: string,
		sessionId: string,
		kind: SessionKind,
		annotationId = "",
	): Promise<void> {
		await this.ensureDir();
		const idx = await this.readIndex();
		const entry: SlideIndexEntry = idx[slide] ?? { main: null, forks: {} };
		if (kind === "main") {
			entry.main = sessionId;
		} else if (annotationId) {
			entry.forks[annotationId] = sessionId;
		}
		idx[slide] = entry;
		await this.writeIndex(idx);
	}

	/** Unregister a session from index.json (ai_session.py:264). */
	async unregister(
		slide: string,
		sessionId: string,
		kind: SessionKind,
		annotationId = "",
	): Promise<void> {
		const idx = await this.readIndex();
		const entry = idx[slide];
		if (!entry) return;
		if (kind === "main" && entry.main === sessionId) {
			entry.main = null;
		} else if (kind === "fork" && annotationId && entry.forks[annotationId] === sessionId) {
			delete entry.forks[annotationId];
		}
		await this.writeIndex(idx);
	}

	/** List main + forks for a slide (ai_session.py:280). */
	async listBySlide(slide: string): Promise<SlideIndexEntry> {
		const idx = await this.readIndex();
		const entry = idx[slide];
		if (!entry) return { main: null, forks: {} };
		return { main: entry.main ?? null, forks: { ...entry.forks } };
	}

	/** Find a fork session id by annotation id (convenience over listBySlide). */
	async findFork(slide: string, annotationId: string): Promise<string | null> {
		const entry = await this.listBySlide(slide);
		return entry.forks[annotationId] ?? null;
	}
}

// --------------------------------------------------------------------------- //
// Type guards
// --------------------------------------------------------------------------- //

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSessionData(v: unknown): v is SessionData {
	if (!isRecord(v)) return false;
	// Spot-check the externally-load-bearing fields; full structural validation
	// is the caller's responsibility (the Flask proxy also tolerates partial).
	return (
		typeof v.id === "string" &&
		typeof v.slide === "string" &&
		(v.kind === "main" || v.kind === "fork") &&
		Array.isArray(v.messages) &&
		Array.isArray(v.compaction_entries)
	);
}

function isSessionIndex(v: unknown): v is SessionIndex {
	if (!isRecord(v)) return false;
	for (const val of Object.values(v)) {
		if (!isRecord(val)) return false;
		if (val.main !== null && typeof val.main !== "string") return false;
		if (!isRecord(val.forks)) return false;
	}
	return true;
}

// --------------------------------------------------------------------------- //
// image_ref dehydration (ai_session.py:1181 _canonical_tool_content,
//   1202 _canonicalize_message)
// --------------------------------------------------------------------------- //

/** Type guard for pi ImageContent blocks. */
export function isImageContent(c: unknown): c is ImageContent {
	return isRecord(c) && c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string";
}

/** Type guard for our on-disk ImageRefContent placeholder. */
export function isImageRefContent(c: unknown): c is ImageRefContent {
	return (
		isRecord(c) &&
		c.type === "image_ref" &&
		typeof c.ref_id === "string" &&
		typeof c.slide_fingerprint === "string" &&
		isRecord(c.src) &&
		typeof c.magnification === "string" &&
		typeof c.summary === "string"
	);
}

function refIdFor(meta: ImageMeta, fallback: string): string {
	// Mirror ai_session.py:1187 ref_<hex>. Prefer the tool call id so re-runs
	// can re-attach metadata; fall back to a uuid prefix.
	return meta.toolCallId ? `ref_${meta.toolCallId}` : `ref_${fallback.slice(0, 12)}`;
}

/**
 * Replace every {@link ImageContent} block in a message array with an
 * {@link ImageRefContent} placeholder (ai_session.py:1202 canonicalize).
 *
 * `imageMeta` is keyed by the tool call id (for toolResult messages) or by the
 * assistant message id / a stable key the caller chooses (for assistant-
 * authored image blocks). Image blocks without matching metadata get a
 * best-effort placeholder with empty metadata (matches the Python fallback
 * where `_canonical_tool_content` synthesizes a ref with the data url as
 * `url` and a generic summary).
 *
 * Loading does NOT re-materialize the image; materialization is Step 4.
 */
export function dehydrateMessages(
	msgs: AgentMessage[] | PersistedAgentMessage[],
	imageMeta: Record<string, ImageMeta> = {},
): PersistedAgentMessage[] {
	const out: PersistedAgentMessage[] = [];
	for (const m of msgs) {
		out.push(dehydrateMessage(m as Message, imageMeta));
	}
	return out;
}

function dehydrateMessage(m: Message, imageMeta: Record<string, ImageMeta>): PersistedAgentMessage {
	const role = (m as { role?: string }).role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") {
		// Custom agent message: pass through untouched.
		return m as unknown as PersistedAgentMessage;
	}
	const content = (m as { content?: unknown }).content;
	if (typeof content === "string") {
		return m as unknown as PersistedAgentMessage;
	}
	if (!Array.isArray(content)) {
		return m as unknown as PersistedAgentMessage;
	}
	const key = role === "toolResult" ? (m as ToolResultMessage).toolCallId : `assistant:${(m as { timestamp?: number }).timestamp ?? ""}`;
	const newContent: PersistedContent[] = content.map((part, i) => {
		if (isImageContent(part)) {
			const meta = imageMeta[key];
			if (meta) {
				const ref: ImageRefContent = {
					type: "image_ref",
					ref_id: refIdFor(meta, key + ":" + i),
					slide_fingerprint: meta.slide_fingerprint,
					src: meta.src,
					magnification: meta.magnification,
					summary: meta.summary,
				};
				return ref;
			}
			// Fallback placeholder (no tool-supplied metadata).
			const fallback: ImageRefContent = {
				type: "image_ref",
				ref_id: `ref_${key.slice(0, 12)}:${i}`,
				slide_fingerprint: "",
				src: { x: 0, y: 0, w: 0, h: 0 },
				magnification: "",
				summary: "(本次会话内抓取的快照)",
			};
			return fallback;
		}
		return part as PersistedContent;
	});
	return { ...(m as object), content: newContent } as PersistedAgentMessage;
}

/**
 * Best-effort rehydration: turn {@link ImageRefContent} blocks back into pi
 * {@link ImageContent} using an optional resolver. Without a resolver this is
 * a no-op pass-through (Step 4 supplies the resolver). Provided for symmetry
 * and future use; not required by the storage layer.
 */
export function rehydrateMessages(
	msgs: PersistedAgentMessage[],
	resolve?: (ref: ImageRefContent) => ImageContent | undefined,
): AgentMessage[] {
	if (!resolve) return msgs as unknown as AgentMessage[];
	return msgs.map((m) => {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) return m as unknown as AgentMessage;
		const newContent = content.map((part) => {
			if (isImageRefContent(part)) {
				const img = resolve(part);
				if (img) return img;
			}
			return part;
		});
		return { ...(m as object), content: newContent } as AgentMessage;
	});
}

// Re-export helpers useful to callers.
export { newSessionId };
