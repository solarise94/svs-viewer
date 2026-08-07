/**
 * Tests for src/compaction.ts (Step 4): Entry adapter, threshold check,
 * runCompaction (LLM summary + retained tail + previousSummary), spot-index
 * injection, and persistence round-trip.
 *
 * The LLM summary call is mocked via a fake Models whose completeSimple
 * returns a controlled AssistantMessage, so we exercise pi's real
 * prepareCompaction / compact / estimateContextTokens without a network.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";

import {
	buildSpotIndexMessage,
	checkShouldCompact,
	persistCompaction,
	prevCompactionInputs,
	resolveCompactionSettings,
	runCompaction,
	toEntries,
	type CompactionOutcome,
} from "../src/compaction.js";
import { SessionStore } from "../src/session-store.js";
import type { FlaskClient, SpotsResult } from "../src/flask-client.js";

// ------------------------------------------------------------------------- //
// Fixtures
// ------------------------------------------------------------------------- //

function usage(input: number, output: number): Usage {
	return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function userMsg(text: string, ts = Date.now()): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: ts } as AgentMessage;
}

function assistantMsg(text: string, u: Usage, ts = Date.now()): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: u,
		stopReason: "stop",
		timestamp: ts,
	} as AgentMessage;
}

/** A small model with a 2048-token window so thresholds are easy to cross. */
const MODEL: Model<Api> = {
	id: "test-model",
	name: "test-model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "http://test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 2048,
	maxTokens: 1024,
} as Model<Api>;

/** A fake Models whose completeSimple returns a scripted summary. */
function makeFakeModels(opts: { summary?: string; fail?: boolean; calls?: { count: number } } = {}): { completeSimple: never } {
	const summary = opts.summary ?? "## Goal\nsummarized history\n";
	const fake = {
		completeSimple: async (_model: Model<Api>, _context: unknown, _options?: unknown): Promise<AssistantMessage> => {
			if (opts.calls) opts.calls.count += 1;
			if (opts.fail) {
				return {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					api: "openai-completions",
					provider: "test",
					model: "test-model",
					usage: usage(10, 5),
					stopReason: "error",
					errorMessage: "summarization failed",
					timestamp: Date.now(),
				} as AssistantMessage;
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: summary }],
				api: "openai-completions",
				provider: "test",
				model: "test-model",
				usage: usage(100, 50),
				stopReason: "stop",
				timestamp: Date.now(),
			} as AssistantMessage;
		},
	};
	return fake as unknown as { completeSimple: never };
}

/** Build a session store rooted in a temp dir. */
async function newStore(): Promise<SessionStore> {
	const dir = await fs.mkdtemp(join(tmpdir(), "svs-compaction-"));
	return new SessionStore({ sessionsDir: dir });
}

/** A fake flask whose spots() returns a scripted change list. */
function makeSpotsFlask(changes: Record<string, unknown>[] = [], currentSeq = 0): Pick<FlaskClient, "spots"> {
	return {
		spots: async (_slide: string, _afterSeq: number): Promise<SpotsResult> => ({ changes, current_seq: currentSeq }),
	};
}

// ------------------------------------------------------------------------- //
// Tests
// ------------------------------------------------------------------------- //

describe("compaction", () => {
	describe("toEntries (Entry adapter)", () => {
		it("wraps each message as a linear MessageEntry", () => {
			const msgs = [userMsg("a"), assistantMsg("b", usage(10, 5))];
			const entries = toEntries(msgs);
			expect(entries.length).toBe(2);
			expect(entries[0]!.type).toBe("message");
			expect(entries[1]!.type).toBe("message");
			// Linear parent chain.
			expect(entries[0]!.parentId).toBe(null);
			expect(entries[1]!.parentId).toBe(entries[0]!.id);
		});

		it("prefixes a synthesized CompactionEntry when prevSummary is given", () => {
			const msgs = [userMsg("a")];
			const entries = toEntries(msgs, "old summary", [userMsg("tail")], 500);
			expect(entries.length).toBe(2);
			expect(entries[0]!.type).toBe("compaction");
			expect((entries[0] as { summary: string }).summary).toBe("old summary");
			expect((entries[0] as { retainedTail: unknown[] }).retainedTail.length).toBe(1);
			// The message follows the compaction entry.
			expect(entries[1]!.parentId).toBe(entries[0]!.id);
		});

		it("skips in-stream compactionSummary messages (canonical summary is the CompactionEntry)", () => {
			const summaryMsg = { role: "compactionSummary", summary: "stale", tokensBefore: 1, timestamp: 1 } as unknown as AgentMessage;
			const msgs = [summaryMsg, userMsg("a")];
			const entries = toEntries(msgs);
			expect(entries.length).toBe(1);
			expect(entries[0]!.type).toBe("message");
		});
	});

	describe("checkShouldCompact", () => {
		it("returns false under the threshold", () => {
			const settings = resolveCompactionSettings({ context_window_tokens: 8192, reserve_tokens: 1024 });
			// Small message, tiny usage.
			const check = checkShouldCompact([assistantMsg("hi", usage(100, 10))], settings);
			expect(check.should).toBe(false);
			expect(check.tokens).toBeGreaterThan(0);
		});

		it("returns true when usage+trailing exceeds window - reserve", () => {
			const settings = resolveCompactionSettings({ context_window_tokens: 1000, reserve_tokens: 100 });
			// usage reports 950 input tokens → 950 > 1000-100=900 → should compact.
			const check = checkShouldCompact([assistantMsg("hi", usage(950, 10))], settings);
			expect(check.should).toBe(true);
		});

		it("counts trailing tokens after the last usage block (fixes the one-turn lag)", () => {
			const settings = resolveCompactionSettings({ context_window_tokens: 1000, reserve_tokens: 100 });
			// Last usage reports only 100 input tokens, but a big trailing user
			// message pushes the estimate over the threshold.
			const big = "x".repeat(4000); // ~1000 tokens at 4 chars/token
			const check = checkShouldCompact([assistantMsg("hi", usage(100, 10)), userMsg(big)], settings);
			expect(check.should).toBe(true);
			expect(check.tokens).toBeGreaterThan(900);
		});
	});

	describe("runCompaction", () => {
		it("summarizes history, keeps the retained tail, and rebuilds messages with a compactionSummary", async () => {
			const calls = { count: 0 };
			const models = makeFakeModels({ summary: "SUMMARY-1", calls });
			const settings = resolveCompactionSettings({ context_window_tokens: 1000, reserve_tokens: 100, keep_recent_tokens: 20 });
			// Build a conversation where the early part is large (to summarize)
			// and the tail is small (to retain).
			const msgs: AgentMessage[] = [
				userMsg("long history line " + "y".repeat(800), 1),
				assistantMsg("response " + "z".repeat(800), usage(500, 100), 2),
				userMsg("recent question", 3),
			];
			const outcome = await runCompaction({ messages: msgs, settings, models: models as never, model: MODEL });
			expect(outcome).not.toBeNull();
			expect(calls.count).toBe(1);
			const o = outcome as CompactionOutcome;
			// First rebuilt message is a compactionSummary carrying the summary.
			expect((o.messages[0] as { role: string }).role).toBe("compactionSummary");
			expect((o.messages[0] as { summary: string }).summary).toContain("SUMMARY-1");
			// Retained tail follows.
			expect(o.messages.length).toBeGreaterThan(1);
			expect(o.retainedTail.length).toBeGreaterThan(0);
			// tokensBefore recorded.
			expect(o.tokensBefore).toBeGreaterThan(0);
		});

		it("passes previousSummary for an incremental update on the second compaction", async () => {
			const calls = { count: 0 };
			const settings = resolveCompactionSettings({ context_window_tokens: 1000, reserve_tokens: 100, keep_recent_tokens: 20 });
			const first: CompactionOutcome = {
				messages: [],
				tokensBefore: 100,
				tokensAfter: 10,
				summary: "PREV-SUMMARY",
				retainedTail: [userMsg("kept tail")],
			};
			const msgs: AgentMessage[] = [
				userMsg("new turn " + "y".repeat(800), 10),
				assistantMsg("resp " + "z".repeat(800), usage(500, 100), 11),
				userMsg("latest", 12),
			];
			// Capture the prompt the summarizer received to assert previousSummary
			// was threaded into the prompt text.
			let capturedPrompt = "";
			const inspecting = {
				completeSimple: async (_m: Model<Api>, ctx: { messages?: Array<{ content?: Array<{ type: string; text?: string }> }> }) => {
					calls.count += 1;
					const c = ctx.messages?.[0]?.content?.[0]?.text || "";
					// Capture the prompt that carries <previous-summary>; ignore the
					// turn-prefix summary call (a different prompt template).
					if (c.includes("<previous-summary>")) capturedPrompt = c;
					return {
						role: "assistant",
						content: [{ type: "text", text: "SUMMARY-2" }],
						api: "openai-completions",
						provider: "test",
						model: "test-model",
						usage: usage(100, 50),
						stopReason: "stop",
						timestamp: Date.now(),
					} as AssistantMessage;
				},
			};
			const outcome = await runCompaction({
				messages: msgs,
				settings,
				models: inspecting as never,
				model: MODEL,
				prevSummary: first.summary,
				prevRetainedTail: first.retainedTail,
				prevTokensBefore: first.tokensBefore,
			});
			expect(outcome).not.toBeNull();
			// At least one summarizer call happened.
			expect(calls.count).toBeGreaterThanOrEqual(1);
			// The history-update prompt template references <previous-summary>
			// and embeds the previous summary text.
			expect(capturedPrompt).toContain("<previous-summary>");
			expect(capturedPrompt).toContain("PREV-SUMMARY");
		});

		it("returns null when the summarizer fails (non-fatal; caller keeps going)", async () => {
			const models = makeFakeModels({ fail: true });
			const settings = resolveCompactionSettings({ context_window_tokens: 1000, reserve_tokens: 100, keep_recent_tokens: 20 });
			const msgs: AgentMessage[] = [
				userMsg("history " + "y".repeat(800), 1),
				assistantMsg("resp " + "z".repeat(800), usage(500, 100), 2),
				userMsg("recent", 3),
			];
			const outcome = await runCompaction({ messages: msgs, settings, models: models as never, model: MODEL });
			expect(outcome).toBeNull();
		});

		it("returns null when compaction is not applicable (no messages)", async () => {
			const models = makeFakeModels({ summary: "X" });
			const settings = resolveCompactionSettings({ context_window_tokens: 1000, reserve_tokens: 100, keep_recent_tokens: 20000 });
			// pi's prepareCompaction returns undefined for an empty entry list.
			const outcome = await runCompaction({ messages: [], settings, models: models as never, model: MODEL });
			expect(outcome).toBeNull();
		});
	});

	describe("buildSpotIndexMessage", () => {
		it("formats the visible-spot snapshot text and returns the new cursor", async () => {
			const flask = makeSpotsFlask(
				[
					{ annotation_id: "a1", deleted: false, x: 10, y: 20, side_px: 100, note: "note one" },
					{ annotation_id: "a2", deleted: true, x: 0, y: 0, side_px: 50, note: "gone" }, // tombstone skipped
				],
				7,
			);
			const r = await buildSpotIndexMessage(flask as unknown as FlaskClient, "slide");
			expect(r).not.toBeNull();
			expect(r!.newCursor).toBe(7);
			const text = (r!.message as { content: Array<{ type: string; text?: string }> }).content[0]!.text!;
			expect(text).toContain("当前切片标注库快照（待复核线索，非诊断事实）：");
			expect(text).toContain("位置 level-0 左上角 (10,20)，边长 100px");
			expect(text).toContain("中心 (60,70)，goto 请对准中心）：note one");
			// Tombstone filtered out.
			expect(text).not.toContain("gone");
		});

		it("returns null when there are no visible spots", async () => {
			const flask = makeSpotsFlask([], 0);
			const r = await buildSpotIndexMessage(flask as unknown as FlaskClient, "slide");
			expect(r).toBeNull();
		});

		it("returns null when flask.spots throws", async () => {
			const flask = { spots: async () => Promise.reject(new Error("boom")) };
			const r = await buildSpotIndexMessage(flask as unknown as FlaskClient, "slide");
			expect(r).toBeNull();
		});
	});

	describe("persistCompaction + prevCompactionInputs round-trip", () => {
		it("writes summary + retained_tail to the log and reads them back", async () => {
			const store = await newStore();
			await store.ensureDir();
			const data = await store.createSession({ slide: "s", kind: "main" });
			const sid = data.id;
			const outcome: CompactionOutcome = {
				messages: [],
				tokensBefore: 1234,
				tokensAfter: 56,
				summary: "THE-SUMMARY",
				retainedTail: [userMsg("tail msg")],
			};
			const newMessages = [{ role: "compactionSummary", summary: "THE-SUMMARY", tokensBefore: 1234, timestamp: 1 } as unknown as AgentMessage, ...outcome.retainedTail];
			await persistCompaction(store, sid, outcome, newMessages);

			const after = await store.readSession(sid);
			expect(after!.compaction_entries.length).toBe(1);
			expect(after!.compaction_entries[0]!.tokens_before).toBe(1234);
			expect(after!.compaction_entries[0]!.tokens_after).toBe(56);

			const prev = prevCompactionInputs(after!);
			expect(prev.summary).toBe("THE-SUMMARY");
			expect(prev.tokensBefore).toBe(1234);
			expect(prev.retainedTail.length).toBe(1);
		});
	});
});
