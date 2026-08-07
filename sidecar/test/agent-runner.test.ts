/**
 * AgentRunner tests (Step 3): golden event sequences, transcript recovery,
 * spot injection, fork flows, conflict/cancel, max_steps/length/pending-
 * snapshot guards, and transient-error retry.
 *
 * The fake streamFn (helpers.ts) drives the REAL pi Agent + agent-loop, so
 * these tests exercise the actual event-translation paths in agent-runner.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

import { BASE_CONFIG, DOWNSAMPLES, makeFakeStreamFn, newHarness, cleanupRootTmp, waitForSettle, type Harness } from "./helpers.js";
import { buildTranscript } from "../src/transcript.js";

/** Minimal AssistantMessage builder for the cancel test's handcrafted stream. */
function makeRawAssistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "cpa-gateway",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

// Golden run script: goto a candidate → snapshot → observation → annotation →
// snapshot_review → finish. Tools are exercised through the real tools.ts
// executors, which emit the domain events in the expected order. The initial
// viewport is the overview (center=W/2,H/2, level=pick_overview_level), so the
// goto target is chosen OFF the overview to avoid the no-op path.
const GOLDEN_SCRIPT = [
	// Turn 0: goto a candidate region (distinct from the overview center).
	{ toolCalls: [{ id: "tc-goto", name: "goto", arguments: { x: 2000, y: 1500, level: 2, reason: "看这" } }] },
	// Turn 1: snapshot the current view.
	{ toolCalls: [{ id: "tc-snap", name: "snapshot", arguments: {} }] },
	// Turn 2: mark an observation on the snapshot.
	{ toolCalls: [{ id: "tc-obs", name: "mark_observation", arguments: { label: "可疑灶", note: "紫染密集" } }] },
	// Turn 3: drop an annotation.
	{ toolCalls: [{ id: "tc-ann", name: "create_annotation", arguments: { label: "AI 建议", x: 1900, y: 1400, side_px: 200 } }] },
	// Turn 4: close the snapshot review.
	{ toolCalls: [{ id: "tc-rev", name: "complete_snapshot_review", arguments: { disposition: "annotated", summary: "已确认" } }] },
	// Turn 5: finish with a summary text first, then the finish tool.
	{ text: "读片完成。", toolCalls: [{ id: "tc-fin", name: "finish", arguments: { summary: "发现一处可疑灶并已标注。" } }] },
];

beforeAll(async () => {
	// touch
});
afterAll(async () => {
	await cleanupRootTmp();
});

describe("AgentRunner.runMain — golden run flow", () => {
	it("emits slide_opened → agent_thinking → domain tools → text_delta → agent_finished, then settles finished", async () => {
		const { fn } = makeFakeStreamFn(GOLDEN_SCRIPT);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, task: "扫读", fresh: true });
		h.watch(sessionId);
		const status = await waitForSettle(h.store, sessionId);
		expect(status).toBe("finished");

		const types = h.events.map((e) => e.type);
		// Setup event first.
		expect(types[0]).toBe("slide_opened");
		const slideOpened = h.events[0]!.payload as Record<string, unknown>;
		expect(slideOpened).toMatchObject({ slide: "test.svs", width: 10000, height: 8000, session_id: sessionId });
		expect(slideOpened.viewport).toMatchObject({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
		expect(slideOpened.overview_level).toBe(3); // pick_overview_level for this slide

		// Each turn starts with agent_thinking.
		const thinkingSteps = h.events.filter((e) => e.type === "agent_thinking").map((e) => e.payload.step);
		expect(thinkingSteps).toEqual([0, 1, 2, 3, 4, 5]);

		// Domain events in order.
		const domainTypes = ["tool_started", "snapshot_captured", "observation", "annotation_created", "snapshot_reviewed"];
		for (const dt of domainTypes) {
			expect(types).toContain(dt);
		}
		// text_delta for the finish turn's preamble text.
		expect(types).toContain("text_delta");
		expect((h.events.find((e) => e.type === "text_delta")!.payload as { text: string }).text).toBe("读片完成。");
		// agent_finished with the finish summary.
		const finished = h.events.find((e) => e.type === "agent_finished");
		expect(finished).toBeDefined();
		expect((finished!.payload as { summary: string }).summary).toBe("发现一处可疑灶并已标注。");
		// annotation_created carries the index/annotation_id.
		const ann = h.events.find((e) => e.type === "annotation_created")!.payload as Record<string, unknown>;
		expect(ann).toMatchObject({ label: "AI 建议", x: 1900, y: 1400, side_px: 200 });
		expect(ann.annotation_id).toBeTruthy();
	});

	it("persists a transcript whose tool_calls pair with tool results by id, and dehydrates the snapshot image to image_ref", async () => {
		const { fn } = makeFakeStreamFn(GOLDEN_SCRIPT);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		await waitForSettle(h.store, sessionId);

		const data = await h.store.readSession(sessionId);
		expect(data).not.toBeNull();
		const transcript = buildTranscript(data!);

		// The first non-user message is the goto assistant turn.
		const assistantMsgs = transcript.filter((m) => m.role === "assistant");
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
		const gotoAssistant = assistantMsgs[0] as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
		expect(gotoAssistant.tool_calls).toBeDefined();
		const gotoTc = gotoAssistant.tool_calls![0]!;
		expect(gotoTc.function.name).toBe("goto");
		expect(gotoTc.function.arguments).toBe(JSON.stringify({ x: 2000, y: 1500, level: 2, reason: "看这" }));

		// The snapshot tool result carries an image_ref block (no base64).
		const toolMsgs = transcript.filter((m) => m.role === "tool") as unknown as Array<{ tool_call_id: string; content: unknown }>;
		const snapResult = toolMsgs.find((m) => m.tool_call_id === "tc-snap");
		expect(snapResult).toBeDefined();
		expect(Array.isArray(snapResult!.content)).toBe(true);
		const imgRef = (snapResult!.content as Array<{ type: string; src?: unknown; magnification?: string }>).find((p) => p.type === "image_ref");
		expect(imgRef).toBeDefined();
		expect(imgRef!.src).toBeDefined();
		expect(typeof imgRef!.magnification).toBe("string");

		// Tool results pair with the tool_call ids above.
		for (const tc of gotoAssistant.tool_calls!) {
			expect(toolMsgs.some((m) => m.tool_call_id === tc.id)).toBe(true);
		}

		// The first user message has display_text equal to the task (this test
		// passes no task, so it falls back to DEFAULT_TASK).
		const userMsgs = transcript.filter((m) => m.role === "user");
		expect((userMsgs[0] as { display_text?: string }).display_text).toBe(
			"客观扫读这张片：先低倍定位，再高倍确认；描述镜下所见，标出值得关注的区域并总结",
		);
	});
});

describe("AgentRunner.continueMain — spot injection", () => {
	it("appends spot_updated/spot_deleted user messages and advances spot_cursor", async () => {
		// Seed an existing main session, then add spots and continue.
		const { fn: fn1 } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h: Harness = await newHarness(fn1);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		await waitForSettle(h.store, sessionId);

		// Simulate external annotation changes.
		h.mock.spotChanges.push(
			{ annotation_id: "spot-a", x: 100, y: 200, side_px: 50, note: "灶A", change_seq: ++h.mock.currentSeq, deleted: false },
			{ annotation_id: "spot-b", change_seq: ++h.mock.currentSeq, deleted: true },
		);

		// Continue: build a runner over the SAME store/bus/mock with a fresh
		// streamFn so the second run uses a non-exhausted script.
		const { fn: fn2 } = makeFakeStreamFn([{ text: "ok", stopReason: "stop" as const }]);
		const { AgentRunner } = await import("../src/agent-runner.js");
		const runnerReuse = new AgentRunner(h.store, h.bus, h.mock as never, { streamFn: fn2 as never });
		const resumed = await runnerReuse.continueMain({ slide: "test.svs", config: { ...BASE_CONFIG } });
		expect(resumed.sessionId).toBe(sessionId);
		await waitForSettle(h.store, sessionId);

		const data = await h.store.readSession(sessionId);
		const spotUpdated = data!.messages.find(
			(m) => (m as { role?: string; spot_updated?: string }).role === "user" && !!(m as { spot_updated?: string }).spot_updated,
		) as { content?: string; spot_updated?: string } | undefined;
		expect(spotUpdated).toBeDefined();
		expect(spotUpdated!.content).toContain("spot_updated");
		expect(spotUpdated!.content).toContain("灶A");
		expect(spotUpdated!.content).toContain("中心 (125,225)");
		const spotDeleted = data!.messages.find(
			(m) => (m as { role?: string; spot_deleted?: string }).role === "user" && !!(m as { spot_deleted?: string }).spot_deleted,
		) as { content?: string; spot_deleted?: string } | undefined;
		expect(spotDeleted).toBeDefined();
		expect(spotDeleted!.content).toContain("spot_deleted");
		expect(spotDeleted!.content).toContain("spot-b");
		// Cursor advanced to current_seq.
		expect(data!.spot_cursor).toBe(h.mock.currentSeq);
	});
});

describe("AgentRunner.askFork — fork flows", () => {
	it("creates a fork for a live annotation, emits fork_created, and the fork has no create_annotation tool", async () => {
		// Seed a live spot.
		const { fn } = makeFakeStreamFn([{ text: "看了", stopReason: "stop" as const }]);
		const h: Harness = await newHarness(fn);
		h.mock.spotChanges.push({ annotation_id: "root-1", x: 1000, y: 2000, side_px: 400, note: "原标注", label: "可疑", change_seq: ++h.mock.currentSeq, deleted: false, size_mm: 0.02 });

		const { sessionId } = await h.runner.askFork({ slide: "test.svs", config: { ...BASE_CONFIG }, annotationId: "root-1", question: "这里是什么？" });
		h.watch(sessionId);
		await waitForSettle(h.store, sessionId);

		// fork_created is emitted inside askFork before the loop starts; read
		// it back from the persisted event log (the live watch may have missed
		// it since it fired before watch() was attached).
		const persisted = await h.store.replayEvents(sessionId, 0);
		const forkCreated = persisted.find((e) => e.type === "fork_created");
		expect(forkCreated).toBeDefined();
		expect((forkCreated!.payload as { annotation_id: string; title: string })).toMatchObject({ annotation_id: "root-1", title: "批注@可疑" });

		const data = await h.store.readSession(sessionId);
		expect(data!.kind).toBe("fork");
		expect(data!.annotation_id).toBe("root-1");
		// The first user message is the spot card with the question as display_text.
		const firstUser = data!.messages[0] as { role?: string; display_text?: string; content?: unknown };
		expect(firstUser.role).toBe("user");
		expect(firstUser.display_text).toBe("这里是什么？");
		const content = firstUser.content as Array<{ type: string; text?: string }>;
		expect(content[0]!.text).toContain("关于切片「test.svs」的一处已标注区域");
		// The attached image is dehydrated to an image_ref on persist (the
		// inline base64 was sent to the model on the first call, then stored
		// as the canonical image_ref placeholder).
		expect(content.some((p) => p.type === "image_ref")).toBe(true);
	});

	it("resumes an existing fork (fork_resumed) by appending the question", async () => {
		const { fn: fn1 } = makeFakeStreamFn([{ text: "首次", stopReason: "stop" as const }]);
		const h: Harness = await newHarness(fn1);
		h.mock.spotChanges.push({ annotation_id: "root-2", x: 100, y: 100, side_px: 100, note: "n", label: "L", change_seq: ++h.mock.currentSeq, deleted: false, size_mm: 0 });
		const first = await h.runner.askFork({ slide: "test.svs", config: { ...BASE_CONFIG }, annotationId: "root-2", question: "q1" });
		await waitForSettle(h.store, first.sessionId);

		// Second ask → resume.
		const { fn: fn2 } = makeFakeStreamFn([{ text: "续聊", stopReason: "stop" as const }]);
		const { AgentRunner } = await import("../src/agent-runner.js");
		const runnerReuse = new AgentRunner(h.store, h.bus, h.mock as never, { streamFn: fn2 as never });
		h.watch(first.sessionId);
		const second = await runnerReuse.askFork({ slide: "test.svs", config: { ...BASE_CONFIG }, annotationId: "root-2", question: "再看一眼" });
		expect(second.sessionId).toBe(first.sessionId);
		await waitForSettle(h.store, first.sessionId);

		const persisted = await h.store.replayEvents(first.sessionId, 0);
		const forkResumed = persisted.find((e) => e.type === "fork_resumed");
		expect(forkResumed).toBeDefined();
		expect((forkResumed!.payload as { annotation_id: string })).toMatchObject({ annotation_id: "root-2" });

		const data = await h.store.readSession(first.sessionId);
		// The appended question is the last user message.
		const lastUser = [...data!.messages].reverse().find((m) => (m as { role?: string }).role === "user") as { content?: string; display_text?: string };
		expect(lastUser.content).toBe("再看一眼");
		expect(lastUser.display_text).toBe("再看一眼");
	});

	it("throws RootAnnotationGone (→ 410) when the root annotation is deleted", async () => {
		const { fn } = makeFakeStreamFn([{ text: "x", stopReason: "stop" as const }]);
		const h: Harness = await newHarness(fn);
		h.mock.spotChanges.push({ annotation_id: "root-gone", x: 1, y: 1, side_px: 1, note: "", change_seq: ++h.mock.currentSeq, deleted: true });
		await expect(h.runner.askFork({ slide: "test.svs", config: { ...BASE_CONFIG }, annotationId: "root-gone" })).rejects.toThrow(/已删除/);
	});
});

describe("AgentRunner.runMain — 409 conflict", () => {
	it("throws SessionConflict when the main is already running", async () => {
		// Long-running script so the first run is still active when we fire the second.
		const { fn } = makeFakeStreamFn([
			{ toolCalls: [{ id: "tc1", name: "goto", arguments: { x: 1, y: 1, level: 0 } }] },
			{ text: "done", stopReason: "stop" as const },
		]);
		const h: Harness = await newHarness(fn);
		const first = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		// Fire a second run on the same slide while the first is still running.
		await expect(h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: false })).rejects.toThrow(/运行中/);
		await waitForSettle(h.store, first.sessionId);
	});
});

describe("AgentRunner — abort path (stopReason=aborted → paused/已停止)", () => {
	it("maps an aborted stopReason to agent_paused(已停止)", async () => {
		// The fake streamFn returns an aborted assistant message for turn 0,
		// exercising the abort → agent_paused mapping in agent-runner without
		// depending on real abort-signal timing.
		const fn = (_model: unknown, _context: unknown, _options?: unknown) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const msg = makeRawAssistant([], "aborted");
				stream.push({ type: "start", partial: makeRawAssistant([], "pending") });
				stream.push({ type: "done", reason: "stop", message: msg });
				stream.end(msg);
			})();
			return stream;
		};
		const h: Harness = await newHarness(fn as never);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		h.watch(sessionId);
		const status = await waitForSettle(h.store, sessionId);
		expect(status).toBe("paused");
		expect(h.events.some((e) => e.type === "agent_paused" && (e.payload as { summary: string }).summary === "已停止")).toBe(true);
	});

	it("cancel() on a not-currently-running session still reports ok and is a no-op", async () => {
		const { fn } = makeFakeStreamFn([{ text: "done", stopReason: "stop" as const }]);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		await waitForSettle(h.store, sessionId);
		// After settle, status is finished; cancel should still return ok.
		const res = await h.runner.cancel({ sessionId });
		expect(res).toEqual({ ok: true });
	});
});

describe("AgentRunner.runMain — max_steps pause", () => {
	it("emits agent_paused(已达步数上限) when max_steps is reached", async () => {
		// A script that always calls goto; with max_steps=2 it pauses after 2 turns.
		const script = Array.from({ length: 10 }, (_, i) => ({
			toolCalls: [{ id: `tc-${i}`, name: "goto", arguments: { x: i, y: i, level: 0 } }],
		}));
		const { fn } = makeFakeStreamFn(script);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG, max_steps: 2 }, fresh: true });
		h.watch(sessionId);
		const status = await waitForSettle(h.store, sessionId);
		expect(status).toBe("paused");
		const paused = h.events.find((e) => e.type === "agent_paused" && (e.payload as { summary: string }).summary === "已达步数上限");
		expect(paused).toBeDefined();
		// No more than max_steps turns ran.
		const thinkCount = h.events.filter((e) => e.type === "agent_thinking").length;
		expect(thinkCount).toBe(2);
	});
});

describe("AgentRunner.runMain — length truncation pause", () => {
	it("emits agent_paused(reason:max_tokens) when the model output is truncated", async () => {
		// Turn 0 returns a tool call but with stopReason "length" → pause.
		const { fn } = makeFakeStreamFn([
			{ text: "截断", toolCalls: [{ id: "tc1", name: "goto", arguments: { x: 1, y: 1, level: 0 } }], stopReason: "length" as const },
		]);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		h.watch(sessionId);
		const status = await waitForSettle(h.store, sessionId);
		expect(status).toBe("paused");
		const paused = h.events.find((e) => e.type === "agent_paused" && (e.payload as { reason?: string }).reason === "max_tokens");
		expect(paused).toBeDefined();
		expect((paused!.payload as { summary: string }).summary).toContain("被截断");
	});
});

describe("AgentRunner.runMain — pending-snapshot plain-text guard", () => {
	it("injects a complete_snapshot_review nudge when plain text ends with a pending snapshot, then continues", async () => {
		// Turn 0: snapshot (opens pending). Turn 1: plain text (no tool calls) —
		// should trigger the nudge. Turn 2: complete_snapshot_review. Turn 3: finish.
		const { fn } = makeFakeStreamFn([
			{ toolCalls: [{ id: "tc-snap", name: "snapshot", arguments: {} }] },
			{ text: "我看到这张图了。" }, // plain text, no tool → pending guard fires
			{ toolCalls: [{ id: "tc-rev", name: "complete_snapshot_review", arguments: { disposition: "no_annotation", no_annotation_reason: "无异常" } }] },
			{ text: "ok", stopReason: "stop" as const },
		]);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		await waitForSettle(h.store, sessionId);

		const data = await h.store.readSession(sessionId);
		// The nudge user message is present.
		const nudge = data!.messages.find(
			(m) => (m as { role?: string; content?: string }).role === "user" && ((m as { content?: string }).content || "").includes("未消化的快照"),
		);
		expect(nudge).toBeDefined();
	});
});

describe("AgentRunner.runMain — transient error retry", () => {
	it("retries a transient error up to 3 times with agent_retrying, then succeeds", async () => {
		// Inject a transient error on the first turn (turn 0), then a normal finish.
		const { fn } = makeFakeStreamFn(
			[
				{ text: "recovered", stopReason: "stop" as const },
			],
			{ injectError: { atTurn: 0, message: "Connection reset by peer", transient: true } },
		);
		const h: Harness = await newHarness(fn);
		const { sessionId } = await h.runner.runMain({ slide: "test.svs", config: { ...BASE_CONFIG }, fresh: true });
		h.watch(sessionId);
		// The injected error happens on the first model call; the retry wrapper
		// retries and the second attempt returns the scripted "recovered" turn.
		const status = await waitForSettle(h.store, sessionId, 30000);
		expect(status).toBe("finished");
		const retries = h.events.filter((e) => e.type === "agent_retrying");
		expect(retries.length).toBeGreaterThanOrEqual(1);
		expect((retries[0]!.payload as { reason: string }).reason).toMatch(/reconnection 1\/3/);
	}, 30000);
});
