import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
	SessionConflict,
	SessionStore,
	dehydrateMessages,
	isImageRefContent,
	rehydrateMessages,
	type ImageMeta,
	type ImageRefContent,
	type PersistedAgentMessage,
} from "../src/session-store.js";

// Per-test temp directory tree. We create one root and a unique sessions dir
// per store so file-mode assertions don't collide.
let rootTmp = "";
beforeAll(async () => {
	rootTmp = await fs.mkdtemp(join(tmpdir(), "svs-session-store-"));
});
afterAll(async () => {
	await fs.rm(rootTmp, { recursive: true, force: true });
});

let dirCounter = 0;
async function newStoreDir(): Promise<string> {
	const p = join(rootTmp, `d${dirCounter++}`);
	await fs.mkdir(p, { recursive: true });
	return p;
}

// On macOS / Linux the umask interferes with mkdir mode; the store chmods the
// directory explicitly. For file perms we read with stat.
async function mode(p: string): Promise<number> {
	const st = await fs.stat(p);
	return st.mode & 0o777;
}

const SLIDE = "slide-abc.svs";

describe("SessionStore: create / read / permissions", () => {
	let store: SessionStore;
	let dir: string;

	beforeAll(async () => {
		dir = await newStoreDir();
		store = new SessionStore({ sessionsDir: dir });
	});

	it("creates a session with all required external fields", async () => {
		const s = await store.createSession({ slide: SLIDE, kind: "main", title: "T" });
		expect(s.id).toMatch(/^sess_/);
		expect(s.slide).toBe(SLIDE);
		expect(s.kind).toBe("main");
		expect(s.status).toBe("idle");
		expect(s.archived).toBe(false);
		expect(s.last_event_seq).toBe(0);
		expect(s.event_min_seq).toBe(0);
		expect(s.messages).toEqual([]);
		expect(s.compaction_entries).toEqual([]);
		expect(s.agent_state).toEqual({ center_x: 0, center_y: 0, pyramid_level: 0, viewport_px: 1024 });
	});

	it("writes session json with 0600 and dir with 0700", async () => {
		const s = await store.createSession({ slide: SLIDE, kind: "fork", annotationId: "ann-1" });
		const fileMode = await mode(join(dir, `${s.id}.json`));
		// On some CoW/fs-verity filesystems the mode bits can be restricted;
		// assert the owner bits at least.
		expect(fileMode & 0o700).toBe(0o600);
		const dirMode = await mode(dir);
		expect(dirMode & 0o700).toBe(0o700);
	});

	it("reads back the persisted session verbatim", async () => {
		const s = await store.createSession({ slide: SLIDE, kind: "main" });
		const back = await store.readSession(s.id);
		expect(back).not.toBeNull();
		expect(back?.id).toBe(s.id);
		expect(back?.title).toBe("全片读片"); // default main title
	});

	it("returns null for missing session", async () => {
		expect(await store.readSession("sess_doesnotexist")).toBeNull();
	});

	it("atomic write: no .tmp left behind after write", async () => {
		const s = await store.createSession({ slide: SLIDE, kind: "main" });
		const entries = await fs.readdir(dir);
		expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
		expect(entries).toContain(`${s.id}.json`);
	});
});

describe("SessionStore: event log append / replay / watermark", () => {
	let store: SessionStore;
	let sid: string;

	beforeAll(async () => {
		store = new SessionStore({ sessionsDir: await newStoreDir(), eventBuffer: 5 });
		const s = await store.createSession({ slide: SLIDE, kind: "main" });
		sid = s.id;
	});

	it("appends events with monotonic seq", async () => {
		const e1 = await store.appendEvent(sid, "turn_start", { n: 1 });
		const e2 = await store.appendEvent(sid, "turn_end", { n: 2 });
		expect(e1.seq).toBe(1);
		expect(e2.seq).toBe(2);
		expect(e1.type).toBe("turn_start");
	});

	it("replays only events with seq > afterSeq", async () => {
		await store.appendEvent(sid, "x", { i: 3 });
		const after1 = await store.replayEvents(sid, 1);
		expect(after1.map((e) => e.seq)).toEqual([2, 3]);
		const after3 = await store.replayEvents(sid, 3);
		expect(after3).toEqual([]);
	});

	it("event_min_seq advances per the rolling window but file is not truncated", async () => {
		// eventBuffer=5; after 3 appends seq=3, window = max(3-5+1,1)=1.
		let data = await store.readSession(sid);
		expect(data!.event_min_seq).toBe(1);
		// Append up to seq 10 → window should be 10-5+1=6.
		for (let i = 4; i <= 10; i++) {
			await store.appendEvent(sid, "bulk", { i });
		}
		data = await store.readSession(sid);
		expect(data!.last_event_seq).toBe(10);
		expect(data!.event_min_seq).toBe(6);
		// File is NOT physically truncated: replaying from seq 0 still returns all.
		const all = await store.replayEvents(sid, 0);
		expect(all.length).toBe(10);
		expect(all[0]!.seq).toBe(1);
	});

	it("replay on missing events file returns []", async () => {
		const s2 = await store.createSession({ slide: SLIDE, kind: "main" });
		expect(await store.replayEvents(s2.id, 0)).toEqual([]);
	});
});

describe("SessionStore: index.json register/unregister/list/findFork", () => {
	let store: SessionStore;

	beforeAll(async () => {
		store = new SessionStore({ sessionsDir: await newStoreDir() });
	});

	it("registers main and forks", async () => {
		const main = await store.createSession({ slide: SLIDE, kind: "main" });
		const f1 = await store.createSession({ slide: SLIDE, kind: "fork", annotationId: "a1" });
		const f2 = await store.createSession({ slide: SLIDE, kind: "fork", annotationId: "a2" });
		const listed = await store.listBySlide(SLIDE);
		expect(listed.main).toBe(main.id);
		expect(listed.forks).toEqual({ a1: f1.id, a2: f2.id });
	});

	it("findFork resolves by annotation id", async () => {
		const f = await store.findFork(SLIDE, "a1");
		expect(f).not.toBeNull();
		const listed = await store.listBySlide(SLIDE);
		expect(f).toBe(listed.forks["a1"]);
	});

	it("unregister only removes the matching slot", async () => {
		const listed = await store.listBySlide(SLIDE);
		const mainId = listed.main!;
		await store.unregister(SLIDE, mainId, "main");
		const after = await store.listBySlide(SLIDE);
		expect(after.main).toBeNull();
		expect(after.forks.a1).toBeDefined();
	});

	it("unregister fork removes the annotation mapping", async () => {
		const listed = await store.listBySlide(SLIDE);
		const forkId = listed.forks.a1!;
		await store.unregister(SLIDE, forkId, "fork", "a1");
		const after = await store.listBySlide(SLIDE);
		expect(after.forks.a1).toBeUndefined();
	});

	it("index.json is written with 0600", async () => {
		const dir = store.sessionsDir;
		const m = await mode(join(dir, "index.json"));
		expect(m & 0o700).toBe(0o600);
	});
});

describe("SessionStore: acquire 409 conflict", () => {
	let store: SessionStore;
	let sid: string;

	beforeAll(async () => {
		store = new SessionStore({ sessionsDir: await newStoreDir() });
		const s = await store.createSession({ slide: SLIDE, kind: "main" });
		sid = s.id;
	});

	it("first acquire flips idle→running", async () => {
		const acquired = await store.acquire({ sessionId: sid, slide: SLIDE, kind: "main" });
		expect(acquired.status).toBe("running");
	});

	it("second acquire on running session throws SessionConflict", async () => {
		await expect(store.acquire({ sessionId: sid, slide: SLIDE, kind: "main" })).rejects.toBeInstanceOf(
			SessionConflict,
		);
	});

	it("acquire on a paused session succeeds", async () => {
		await store.setStatus(sid, "paused");
		const acquired = await store.acquire({ sessionId: sid, slide: SLIDE, kind: "main" });
		expect(acquired.status).toBe("running");
	});

	it("acquire with mismatched slide/kind throws SessionConflict", async () => {
		await store.setStatus(sid, "idle");
		await expect(
			store.acquire({ sessionId: sid, slide: "other.svs", kind: "main" }),
		).rejects.toBeInstanceOf(SessionConflict);
	});
});

describe("SessionStore: boot recovery", () => {
	let store: SessionStore;
	let dir: string;
	let runningId: string;
	let seqTestId: string;

	beforeAll(async () => {
		dir = await newStoreDir();
		store = new SessionStore({ sessionsDir: dir });
		const r = await store.createSession({ slide: SLIDE, kind: "main" });
		runningId = r.id;
		await store.acquire({ sessionId: runningId, slide: SLIDE, kind: "main" });

		const s2 = await store.createSession({ slide: SLIDE, kind: "main" });
		seqTestId = s2.id;
		// Append events directly to the file so the on-disk max seq exceeds
		// the metadata's last_event_seq (simulating a crash between append and
		// the metadata write).
		await fs.appendFile(
			join(dir, `${seqTestId}.events.jsonl`),
			JSON.stringify({ type: "leak", payload: {}, ts: 1, seq: 42 }) + "\n" +
				JSON.stringify({ type: "leak", payload: {}, ts: 2, seq: 99 }) + "\n",
		);
	});

	it("flips running→paused and repairs last_event_seq from file tail", async () => {
		const { paused, repaired } = await store.recoverOnBoot();
		expect(paused).toContain(runningId);
		expect(repaired).toContain(seqTestId);

		const r = await store.readSession(runningId);
		expect(r!.status).toBe("paused");
		const s = await store.readSession(seqTestId);
		expect(s!.last_event_seq).toBe(99);
	});

	it("idempotent: second recoverOnBoot does not pause/repair again", async () => {
		const { paused, repaired } = await store.recoverOnBoot();
		expect(paused).not.toContain(runningId); // already paused
		expect(repaired).not.toContain(seqTestId); // seq already 99
	});
});

describe("SessionStore: legacy session file compatibility", () => {
	let store: SessionStore;
	let dir: string;
	const legacyId1 = "legacy-main-aaaaaaaa";
	const legacyId2 = "legacy-fork-bbbbbbbb";
	const goodId = "good-main-cccccccc";

	beforeAll(async () => {
		dir = await newStoreDir();
		store = new SessionStore({ sessionsDir: dir });

		// Legacy Python-agent format: has canonical_messages, no messages/
		// compaction_entries. These must be skipped, not crash, not deleted.
		await fs.writeFile(
			join(dir, `${legacyId1}.json`),
			JSON.stringify({
				id: legacyId1,
				slide: SLIDE,
				kind: "main",
				title: "old python main",
				status: "idle",
				archived: false,
				canonical_messages: [{ role: "user", content: "hi" }],
				agent_state: {},
				created_at: 1,
				updated_at: 2,
				last_accessed_at: 2,
				spot_cursor: 0,
				last_event_seq: 5,
				event_min_seq: 1,
			}),
		);
		// A second legacy file that has neither messages nor canonical_messages
		// (just the missing-messages case).
		await fs.writeFile(
			join(dir, `${legacyId2}.json`),
			JSON.stringify({
				id: legacyId2,
				slide: SLIDE,
				kind: "fork",
				status: "finished",
				archived: false,
				observations: [],
				// no messages, no canonical_messages
			}),
		);

		// A good new-format session.
		const g = await store.createSession({ slide: SLIDE, kind: "main" });
		// Replace its id by writing a known-name file then reading it back via
		// createSession is awkward; instead write a minimal valid new-format file.
		await fs.writeFile(
			join(dir, `${goodId}.json`),
			JSON.stringify({
				id: goodId,
				slide: SLIDE,
				kind: "main",
				title: "good",
				status: "idle",
				archived: false,
				agent_state: { center_x: 0, center_y: 0, pyramid_level: 0, viewport_px: 1024 },
				observations: [],
				pending_snapshot_review: null,
				spot_cursor: 0,
				created_at: 1,
				updated_at: 1,
				last_accessed_at: 1,
				last_event_seq: 0,
				event_min_seq: 0,
				messages: [],
				compaction_entries: [],
			}),
		);

		// index.json references all three (including the legacy ones).
		await fs.writeFile(
			join(dir, "index.json"),
			JSON.stringify({
				[SLIDE]: { main: legacyId1, forks: { ax: legacyId2 } },
			}),
		);
		// The createSession above also registered `g.id`; rebuild index by hand
		// to a deterministic shape (main legacy, one fork legacy, plus the good
		// one referenced from a second slide so it is not pruned).
		await fs.writeFile(
			join(dir, "index.json"),
			JSON.stringify({
				[SLIDE]: { main: legacyId1, forks: { ax: legacyId2 } },
				"other.svs": { main: goodId, forks: {} },
			}),
		);
		// Clean up the stray createSession file so it does not interfere.
		await fs.rm(join(dir, `${g.id}.json`), { force: true });
	});

	it("readSession returns null for legacy files", async () => {
		expect(await store.readSession(legacyId1)).toBeNull();
		expect(await store.readSession(legacyId2)).toBeNull();
	});

	it("recoverOnBoot reports legacy files, does not crash or delete them", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { legacy, paused, repaired } = await store.recoverOnBoot();
		expect(legacy).toContain(legacyId1);
		expect(legacy).toContain(legacyId2);
		// Good session is left alone (not paused/repaired — idle, seq 0).
		expect(paused).not.toContain(goodId);
		expect(repaired).not.toContain(goodId);
		// A warning was logged mentioning at least one legacy id.
		const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(warned).toContain(legacyId1);
		warnSpy.mockRestore();

		// Files are NOT deleted.
		expect(await fs.readFile(join(dir, `${legacyId1}.json`), "utf8").catch(() => null)).not.toBeNull();
		expect(await fs.readFile(join(dir, `${legacyId2}.json`), "utf8").catch(() => null)).not.toBeNull();
	});

	it("index.json prunes references to legacy/missing sessions", async () => {
		// After recoverOnBoot pruned the index, listBySlide should reflect null.
		const idx = JSON.parse(await fs.readFile(join(dir, "index.json"), "utf8"));
		// The slide with only legacy refs: main null, forks empty.
		expect(idx[SLIDE].main).toBeNull();
		expect(Object.keys(idx[SLIDE].forks)).toHaveLength(0);
		// The good session's slide keeps its reference.
		expect(idx["other.svs"].main).toBe(goodId);
		// listBySlide honors the pruned index.
		const entry = await store.listBySlide(SLIDE);
		expect(entry.main).toBeNull();
		expect(Object.keys(entry.forks)).toHaveLength(0);
	});
});

describe("SessionStore: archive guard", () => {
	let store: SessionStore;
	let sid: string;

	beforeAll(async () => {
		store = new SessionStore({ sessionsDir: await newStoreDir() });
		const s = await store.createSession({ slide: SLIDE, kind: "fork", annotationId: "ax" });
		sid = s.id;
	});

	it("archive a non-running session succeeds", async () => {
		const archived = await store.archive(sid);
		expect(archived.archived).toBe(true);
	});

	it("archive a running session throws SessionConflict", async () => {
		const s2 = await store.createSession({ slide: SLIDE, kind: "main" });
		await store.acquire({ sessionId: s2.id, slide: SLIDE, kind: "main" });
		await expect(store.archive(s2.id)).rejects.toBeInstanceOf(SessionConflict);
	});

	it("unarchive flips archived back", async () => {
		const u = await store.unarchive(sid);
		expect(u.archived).toBe(false);
	});
});

describe("dehydrateMessages: image_ref round trip", () => {
	it("replaces toolResult image blocks with image_ref placeholders", () => {
		const imageBlock: ImageContent = {
			type: "image",
			data: "BASE64DATA",
			mimeType: "image/png",
		};
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc_1",
			toolName: "snapshot",
			content: [{ type: "text" as const, text: "快照" }, imageBlock],
			isError: false,
			timestamp: 1,
		};
		const meta: ImageMeta = {
			toolCallId: "tc_1",
			slide_fingerprint: "fp-123",
			src: { x: 10, y: 20, w: 100, h: 100 },
			magnification: "10x",
			summary: "低倍镜视野",
		};
		const out = dehydrateMessages([toolResult], { tc_1: meta }) as PersistedAgentMessage[];
		const content = (out[0] as unknown as { content: { type: string }[] }).content;
		expect(content[0]!.type).toBe("text");
		expect(isImageRefContent(content[1])).toBe(true);
		const ref = content[1] as ImageRefContent;
		expect(ref.ref_id).toContain("tc_1");
		expect(ref.slide_fingerprint).toBe("fp-123");
		expect(ref.magnification).toBe("10x");
		expect(ref.src).toEqual({ x: 10, y: 20, w: 100, h: 100 });
	});

	it("leaves non-image messages untouched", () => {
		const user = { role: "user" as const, content: "hi", timestamp: 1 };
		const out = dehydrateMessages([user], {});
		expect(out[0]).toEqual(user);
	});

	it("falls back to a placeholder when no metadata is supplied", () => {
		const imageBlock: ImageContent = { type: "image", data: "x", mimeType: "image/png" };
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc_2",
			toolName: "snap",
			content: [imageBlock],
			isError: false,
			timestamp: 1,
		};
		const out = dehydrateMessages([toolResult], {}) as PersistedAgentMessage[];
		const content = (out[0] as unknown as { content: { type: string }[] }).content;
		expect(isImageRefContent(content[0])).toBe(true);
		const ref = content[0] as ImageRefContent;
		expect(ref.slide_fingerprint).toBe("");
		expect(ref.summary).toBeTruthy();
	});

	it("rehydrateMessages is a pass-through without a resolver", () => {
		const imageBlock: ImageContent = { type: "image", data: "x", mimeType: "image/png" };
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc_3",
			toolName: "snap",
			content: [imageBlock],
			isError: false,
			timestamp: 1,
		};
		const dehydrated = dehydrateMessages([toolResult], { tc_3: {
			toolCallId: "tc_3",
			slide_fingerprint: "fp",
			src: { x: 0, y: 0, w: 1, h: 1 },
			magnification: "10x",
			summary: "s",
		} });
		// Without a resolver, image_ref blocks stay as-is (Step 4 supplies one).
		const rehydrated = rehydrateMessages(dehydrated);
		expect(rehydrated.length).toBe(1);
	});

	it("rehydrateMessages swaps image_ref back to ImageContent with a resolver", () => {
		const imageBlock: ImageContent = { type: "image", data: "x", mimeType: "image/png" };
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc_4",
			toolName: "snap",
			content: [imageBlock],
			isError: false,
			timestamp: 1,
		};
		const dehydrated = dehydrateMessages([toolResult], { tc_4: {
			toolCallId: "tc_4",
			slide_fingerprint: "fp",
			src: { x: 0, y: 0, w: 1, h: 1 },
			magnification: "10x",
			summary: "s",
		} });
		const restored: ImageContent = { type: "image", data: "REGENDATA", mimeType: "image/png" };
		const rehydrated = rehydrateMessages(dehydrated, () => restored);
		const content = (rehydrated[0] as unknown as { content: { type: string }[] }).content;
		expect(content[0]!.type).toBe("image");
	});
});

describe("SessionStore: end-to-end message persistence with image_ref", () => {
	it("persists a toolResult with an image, reloads it as image_ref", async () => {
		const store = new SessionStore({ sessionsDir: await newStoreDir() });
		const s = await store.createSession({ slide: SLIDE, kind: "main" });

		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "tc_e2e",
			toolName: "snapshot",
			content: [
				{ type: "text" as const, text: "see this" },
				{ type: "image" as const, data: "BIGBASE64", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 1,
		};
		const meta: ImageMeta = {
			toolCallId: "tc_e2e",
			slide_fingerprint: "fp-e2e",
			src: { x: 1, y: 2, w: 3, h: 4 },
			magnification: "20x",
			summary: "e2e view",
		};
		const dehydrated = dehydrateMessages([toolResult], { tc_e2e: meta });

		// Write through the store and read back.
		const data = await store.readSession(s.id);
		data!.messages = dehydrated;
		await store.writeSession(s.id, data!);
		const back = await store.readSession(s.id);
		const content = (back!.messages[0] as unknown as { content: { type: string }[] }).content;
		expect(content.some((c) => isImageRefContent(c))).toBe(true);
		// The persisted JSON must not contain the raw base64.
		const raw = await fs.readFile(join(store.sessionsDir, `${s.id}.json`), "utf8");
		expect(raw).not.toContain("BIGBASE64");
	});
});

describe("SessionStore: mutex serializes concurrent appends", () => {
	it("100 concurrent appends produce 100..1 sequential seqs with no gaps", async () => {
		const store = new SessionStore({ sessionsDir: await newStoreDir(), eventBuffer: 1000 });
		const s = await store.createSession({ slide: SLIDE, kind: "main" });
		const seqs = await Promise.all(
			Array.from({ length: 100 }, (_, i) => store.appendEvent(s.id, "c", { i }).then((e) => e.seq)),
		);
		expect(seqs.length).toBe(100);
		const set = new Set(seqs);
		expect(set.size).toBe(100); // no duplicates
		expect(Math.min(...seqs)).toBe(1);
		expect(Math.max(...seqs)).toBe(100);
	});
});
