/**
 * Tests for src/transform-context.ts (Step 4): image_ref materialization,
 * image eviction, fingerprint-mismatch degradation, and the no-throw contract.
 */
import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
	makeTransformContext,
	resolveTransformSettings,
	countImageBlocks,
	hasNoImageRefBlocks,
} from "../src/transform-context.js";
import type { FlaskClient, RegionResult } from "../src/flask-client.js";
import type { SlideInfo } from "../src/tools.js";
import type { ImageRefContent, PersistedAgentMessage } from "../src/session-store.js";

// ------------------------------------------------------------------------- //
// Fixtures
// ------------------------------------------------------------------------- //

const SLIDE = "test.svs";
const SLIDE_INFO: SlideInfo = {
	width: 10000,
	height: 8000,
	levelDownsamples: [1, 2, 4, 8],
	mpp: 0.5,
	fingerprint: "fp-test",
};

/** Build an image_ref block. */
function imgRef(refId: string, src: { x: number; y: number; w: number; h: number }, fingerprint = "fp-test"): ImageRefContent {
	return {
		type: "image_ref",
		ref_id: refId,
		slide_fingerprint: fingerprint,
		src,
		magnification: "20x",
		summary: "snap",
	};
}

/** Build a user message whose content is the given blocks. */
function userMsg(blocks: unknown[], ts = Date.now()): AgentMessage {
	return { role: "user", content: blocks as never, timestamp: ts } as AgentMessage;
}

/** Build a toolResult message carrying an image_ref (the snapshot-tool shape). */
function toolResultMsg(toolCallId: string, blocks: unknown[], ts = Date.now()): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: blocks as never,
		timestamp: ts,
	} as unknown as AgentMessage;
}

/** A minimal flask mock whose region() returns a deterministic base64 per call. */
function makeFlask(opts: { fail?: boolean; emptyB64?: boolean; b64ByRefId?: Record<string, string> } = {}): Pick<FlaskClient, "region"> & { calls: number; lastArgs: unknown[] } {
	const state = { calls: 0 };
	const lastArgs: unknown[] = [];
	const region = async (args: { slide: string; x: number; y: number; w: number; h: number; out_w?: number; out_h?: number }): Promise<RegionResult> => {
		state.calls += 1;
		lastArgs.push(args);
		if (opts.fail) throw new Error("region boom");
		const b64 = (opts.b64ByRefId && opts.b64ByRefId[`x${args.x}y${args.y}`]) || "QUFBQQ=="; // "AAAA"
		return {
			image_base64: opts.emptyB64 ? "" : b64,
			mime: "image/jpeg",
			width: args.out_w ?? 1024,
			height: args.out_h ?? 1024,
			src: { x: args.x, y: args.y, w: args.w, h: args.h },
			magnification: 20,
		};
	};
	// Use getters so `calls` reflects the live closure counter.
	const obj: Pick<FlaskClient, "region"> & { calls: number; lastArgs: unknown[] } = {
		region: region as never,
		get calls() {
			return state.calls;
		},
		get lastArgs() {
			return lastArgs;
		},
	};
	return obj;
}

// ------------------------------------------------------------------------- //
// Tests
// ------------------------------------------------------------------------- //

describe("transform-context", () => {
	describe("resolveTransformSettings", () => {
		it("defaults to 6 when unset or invalid", () => {
			expect(resolveTransformSettings({}).keepRecentImages).toBe(6);
			expect(resolveTransformSettings({ keep_recent_images: 0 }).keepRecentImages).toBe(6);
			expect(resolveTransformSettings({ keep_recent_images: -1 }).keepRecentImages).toBe(6);
			expect(resolveTransformSettings({ keep_recent_images: NaN }).keepRecentImages).toBe(6);
			expect(resolveTransformSettings({ keep_recent_images: "abc" as unknown as number }).keepRecentImages).toBe(6);
		});
		it("floors a positive number", () => {
			expect(resolveTransformSettings({ keep_recent_images: 3 }).keepRecentImages).toBe(3);
			expect(resolveTransformSettings({ keep_recent_images: 4.9 }).keepRecentImages).toBe(4);
		});
	});

	describe("materialization", () => {
		it("turns an image_ref into an image block via flask.region", async () => {
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs: AgentMessage[] = [userMsg([imgRef("ref_a", { x: 100, y: 100, w: 500, h: 500 })])];
			const out = await transform(msgs);
			expect(flask.calls).toBe(1);
			expect(countImageBlocks(out)).toBe(1);
			// invariant: no image_ref left
			expect(hasNoImageRefBlocks(out)).toBe(true);
		});

		it("degrades to text when flask.region throws (fingerprint/availability)", async () => {
			const flask = makeFlask({ fail: true });
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs: AgentMessage[] = [userMsg([imgRef("ref_a", { x: 100, y: 100, w: 500, h: 500 })])];
			const out = await transform(msgs);
			expect(countImageBlocks(out)).toBe(0);
			expect(hasNoImageRefBlocks(out)).toBe(true);
			// The degraded text matches ai_session.py:855.
			const c = (out[0] as { content: Array<{ type: string; text?: string }> }).content;
			expect(c.some((b) => b.type === "text" && b.text === "该图因切片变更不可用。")).toBe(true);
		});

		it("degrades to text when region returns empty base64", async () => {
			const flask = makeFlask({ emptyB64: true });
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs: AgentMessage[] = [toolResultMsg("tc1", [imgRef("ref_tc1", { x: 1, y: 1, w: 10, h: 10 })])];
			const out = await transform(msgs);
			expect(countImageBlocks(out)).toBe(0);
			expect(hasNoImageRefBlocks(out)).toBe(true);
		});

		it("preserves sibling text blocks and non-content messages", async () => {
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs: AgentMessage[] = [
				{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1 } as never,
				userMsg([{ type: "text", text: "look" }, imgRef("ref_a", { x: 1, y: 1, w: 10, h: 10 })]),
			];
			const out = await transform(msgs);
			// assistant message untouched
			expect((out[0] as { content: Array<{ type: string; text: string }> }).content[0]!.text).toBe("hello");
			// user message keeps its text block + gains an image block
			const u = out[1] as { content: Array<{ type: string; text?: string }> };
			expect(u.content[0]!.type).toBe("text");
			expect(u.content[0]!.text).toBe("look");
			expect(u.content.some((b) => b.type === "image")).toBe(true);
			expect(hasNoImageRefBlocks(out)).toBe(true);
		});
	});

	describe("eviction", () => {
		it("keeps only the last N images, drops older ones to placeholder text", async () => {
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			// 8 snapshots, each its own toolResult message (no overview protection).
			const msgs: AgentMessage[] = [];
			for (let i = 0; i < 8; i++) {
				msgs.push(toolResultMsg(`tc${i}`, [imgRef(`ref_tc${i}`, { x: i, y: i, w: 100, h: 100 })], 1000 + i));
			}
			const out = await transform(msgs);
			// 6 images retained, 2 evicted to text placeholders.
			expect(countImageBlocks(out)).toBe(6);
			// The 6 kept are the most recent (tc2..tc7); tc0, tc1 evicted.
			const evictedTexts = (out as Array<{ content: Array<{ type: string; text?: string }> }>)
				.flatMap((m) => m.content)
				.filter((b) => b.type === "text" && b.text === "（历史快照已省略，可用 goto+snapshot 重新查看）");
			expect(evictedTexts.length).toBe(2);
			expect(hasNoImageRefBlocks(out)).toBe(true);
		});

		it("always retains the whole-slide overview snapshot (identity match)", async () => {
			const flask = makeFlask();
			const firstSnapshotRef = { value: "snap-overview-1" };
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 2 }),
				firstSnapshotToolCallIdRef: firstSnapshotRef,
			});
			// First snapshot is the overview (ref_id matches snap-overview-1),
			// followed by 4 normal snapshots. keep_recent_images=2 → normally
			// only the last 2 non-overview survive, but the overview is protected.
			const msgs: AgentMessage[] = [
				toolResultMsg("snap-overview-1", [imgRef("ref_snap-overview-1", { x: 0, y: 0, w: 100, h: 100 })], 1),
				toolResultMsg("snap-2", [imgRef("ref_snap-2", { x: 1, y: 1, w: 100, h: 100 })], 2),
				toolResultMsg("snap-3", [imgRef("ref_snap-3", { x: 2, y: 2, w: 100, h: 100 })], 3),
				toolResultMsg("snap-4", [imgRef("ref_snap-4", { x: 3, y: 3, w: 100, h: 100 })], 4),
				toolResultMsg("snap-5", [imgRef("ref_snap-5", { x: 4, y: 4, w: 100, h: 100 })], 5),
			];
			const out = await transform(msgs);
			// Overview + last 2 = 3 images.
			expect(countImageBlocks(out)).toBe(3);
			// The overview (first message) is still an image, not a placeholder.
			const first = out[0] as { content: Array<{ type: string }> };
			expect(first.content.some((b) => b.type === "image")).toBe(true);
			expect(hasNoImageRefBlocks(out)).toBe(true);
		});

		it("always retains a >90% coverage snapshot (coverage fallback)", async () => {
			const flask = makeFlask();
			// No identity ref set → coverage heuristic must catch the wide bbox.
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 1 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			// Overview bbox covers the whole width (w=9500 on a 10000-wide slide → 95%).
			const msgs: AgentMessage[] = [
				toolResultMsg("ov", [imgRef("ref_ov", { x: 0, y: 0, w: 9500, h: 8000 })], 1),
				toolResultMsg("s2", [imgRef("ref_s2", { x: 1, y: 1, w: 100, h: 100 })], 2),
				toolResultMsg("s3", [imgRef("ref_s3", { x: 2, y: 2, w: 100, h: 100 })], 3),
			];
			const out = await transform(msgs);
			// Overview (protected) + last 1 = 2 images.
			expect(countImageBlocks(out)).toBe(2);
			const first = out[0] as { content: Array<{ type: string }> };
			expect(first.content.some((b) => b.type === "image")).toBe(true);
		});

		it("does not evict when under the cap", async () => {
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs: AgentMessage[] = [
				toolResultMsg("a", [imgRef("ref_a", { x: 1, y: 1, w: 10, h: 10 })], 1),
				toolResultMsg("b", [imgRef("ref_b", { x: 2, y: 2, w: 10, h: 10 })], 2),
			];
			const out = await transform(msgs);
			expect(countImageBlocks(out)).toBe(2);
		});
	});

	describe("contract", () => {
		it("never rejects: returns original messages when the transform body throws", async () => {
			// Force a top-level throw inside transformOnce by passing a slideInfo
			// whose width getter throws — the overview-detection path touches
			// slideInfo.width on every ref, so this throws inside the rebuild.
			const poisonInfo = {
				get width(): number {
					throw new Error("poison");
				},
				height: 8000,
				levelDownsamples: [1, 2, 4, 8],
				mpp: 0.5,
				fingerprint: "fp-test",
			};
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: poisonInfo as unknown as SlideInfo,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs: AgentMessage[] = [userMsg([imgRef("ref_a", { x: 1, y: 1, w: 10, h: 10 })])];
			// Must not reject; returns the original messages (total passthrough).
			const out = await transform(msgs);
			expect(Array.isArray(out)).toBe(true);
			expect(out).toBe(msgs);
		});

		it("is pure: does not mutate the input array", async () => {
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const original: AgentMessage[] = [userMsg([imgRef("ref_a", { x: 1, y: 1, w: 10, h: 10 })])];
			const snapshotBefore = JSON.stringify(original);
			await transform(original);
			expect(JSON.stringify(original)).toBe(snapshotBefore);
		});

		it("handles string content (passthrough)", async () => {
			const flask = makeFlask();
			const transform = makeTransformContext({
				flask: flask as unknown as FlaskClient,
				slide: SLIDE,
				slideInfo: SLIDE_INFO,
				settings: resolveTransformSettings({ keep_recent_images: 6 }),
				firstSnapshotToolCallIdRef: { value: null },
			});
			const msgs = [{ role: "user", content: "plain text", timestamp: 1 }] as unknown as AgentMessage[];
			const out = await transform(msgs);
			expect((out[0] as { content: unknown }).content).toBe("plain text");
			expect(flask.calls).toBe(0);
		});
	});

	describe("countImageBlocks / hasNoImageRefBlocks helpers", () => {
		it("count image blocks only (not refs)", () => {
			const msgs: PersistedAgentMessage[] = [
				{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/jpeg" }, { type: "text", text: "hi" }] } as never,
				{ role: "user", content: [{ type: "image_ref", ref_id: "r", slide_fingerprint: "", src: { x: 0, y: 0, w: 0, h: 0 }, magnification: "", summary: "" }] } as never,
			];
			expect(countImageBlocks(msgs)).toBe(1);
			expect(hasNoImageRefBlocks(msgs)).toBe(false);
		});
	});
});
