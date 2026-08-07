/**
 * Step 0 compatibility spike.
 *
 * Verifies the pi (earendil-works/pi) streamSimple + Agent loop end-to-end
 * against a CPA-style OpenAI-compatible endpoint.
 *
 * Modes (driven by env SPIKE_MODE):
 *   - "mock" (default): spin up a local HTTP server that mimics a CPA gateway's
 *     streaming OpenAI Chat Completions responses, including a tool_call round
 *     trip and usage passthrough. MUST pass.
 *   - "real": point at a real CPA endpoint via AI_BASE_URL/AI_API_KEY/AI_MODEL.
 *     Written but not runnable here (no CPA key locally).
 *
 * Run: npm run spike
 *       SPIKE_MODE=real AI_BASE_URL=... AI_API_KEY=... AI_MODEL=... npm run spike
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { streamSimple as openaiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { buildModel, type AiEngineConfig } from "../src/pi-model.js";

interface SpikeStats {
	turns: number;
	toolCalls: { name: string; args: unknown }[];
	toolResults: { name: string; content: string }[];
	textDeltas: string[];
	finalText: string;
	lastUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	finishReasons: string[];
	errors: string[];
}

function newStats(): SpikeStats {
	return {
		turns: 0,
		toolCalls: [],
		toolResults: [],
		textDeltas: [],
		finalText: "",
		lastUsage: undefined,
		finishReasons: [],
		errors: [],
	};
}

const echoParams = Type.Object({ text: Type.String({ description: "Text to echo back." }) });

/** echo tool: returns its `text` argument back to the model. */
function echoTool(): AgentTool<typeof echoParams, { echoed: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo the given text back. Used to validate tool-call round trips.",
		parameters: echoParams,
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: `echo: ${params.text}` }],
				details: { echoed: params.text },
			};
		},
	};
}

/**
 * Mock CPA server.
 *
 * Emits OpenAI Chat Completions streaming SSE. Detects the turn from the
 * request body: if the last message is a tool result → final text turn;
 * otherwise → tool-call turn. This mirrors what pi's openai-completions parser
 * consumes (see /tmp/pi-src/packages/ai/src/api/openai-completions.ts:440-589).
 */
function startMockServer(): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((req, res) => {
		if (!req.url?.includes("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});

			const send = (obj: unknown) => {
				res.write(`data: ${JSON.stringify(obj)}\n\n`);
			};

			let parsed: { messages?: Array<{ role: string }> };
			try {
				parsed = JSON.parse(body || "{}");
			} catch {
				parsed = {};
			}
			const messages = parsed.messages ?? [];
			const lastRole = messages.length > 0 ? messages[messages.length - 1]!.role : "";
			const isToolResultTurn = lastRole === "tool";

			const id = "chatcmpl-mock-" + Math.random().toString(36).slice(2);

			if (!isToolResultTurn) {
				// Turn 1: emit a tool_call for echo({"text":"hello"}).
				send({
					id,
					object: "chat.completion.chunk",
					model: "mock-model",
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_echo_1",
										type: "function",
										function: { name: "echo", arguments: "" },
									},
								],
							},
						},
					],
				});
				send({
					id,
					object: "chat.completion.chunk",
					model: "mock-model",
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '{"text":"hello"}' } }],
							},
						},
					],
				});
				send({
					id,
					object: "chat.completion.chunk",
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				});
			} else {
				// Turn 2: final text, then stop, then usage (OpenAI streams
				// usage in a trailing chunk with empty choices when
				// stream_options.include_usage is set — pi parses chunk.usage
				// before reading choices, openai-completions.ts:449).
				send({
					id,
					object: "chat.completion.chunk",
					model: "mock-model",
					choices: [{ index: 0, delta: { content: "Tool echoed. Done." }, finish_reason: null }],
				});
				send({
					id,
					object: "chat.completion.chunk",
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				});
				send({
					id,
					object: "chat.completion.chunk",
					model: "mock-model",
					choices: [],
					usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
				});
			}

			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
		});
	});
}

function log(label: string, ...args: unknown[]): void {
	console.log(`[spike] ${label}`, ...args);
}

async function runSpike(cfg: AiEngineConfig): Promise<SpikeStats> {
	const { model } = buildModel(cfg);
	const stats = newStats();

	// The Agent uses the low-level openai-completions streamSimple as its
	// streamFn (agent-loop.ts:308). getApiKey returns the configured key; the
	// loop forwards it as options.apiKey (agent-loop.ts:305-310), which
	// streamSimple passes straight through to getClientApiKey
	// (openai-completions.ts:621-623). This avoids Models credential-store
	// resolution entirely.
	const streamFn =
		model.api === "openai-completions"
			? (openaiStreamSimple as unknown as (
					m: Model<Api>,
					ctx: Parameters<typeof openaiStreamSimple>[1],
					opts?: Parameters<typeof openaiStreamSimple>[2],
			  ) => ReturnType<typeof openaiStreamSimple>)
			: undefined;

	if (!streamFn) {
		throw new Error(`spike only implements openai-completions; model.api=${model.api}`);
	}

	const agent = new Agent({
		streamFn,
		getApiKey: () => cfg.api_key,
		initialState: {
			model,
			systemPrompt: "You are a test agent. Use the echo tool when asked.",
			tools: [echoTool()],
		},
	});

	agent.subscribe((event: AgentEvent) => {
		switch (event.type) {
			case "turn_start":
				stats.turns += 1;
				log("turn_start (turn", stats.turns + ")");
				break;
			case "tool_execution_start":
				stats.toolCalls.push({ name: event.toolName, args: event.args });
				log("tool_execution_start", event.toolName, JSON.stringify(event.args));
				break;
			case "tool_execution_end": {
				const content =
					typeof event.result?.content === "object" && Array.isArray(event.result.content)
						? event.result.content.map((c: { text?: string }) => c.text ?? "").join("")
						: String(event.result);
				stats.toolResults.push({ name: event.toolName, content });
				log("tool_execution_end", event.toolName, "isError=" + event.isError, "content=" + content);
				break;
			}
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					stats.textDeltas.push(event.assistantMessageEvent.delta);
				} else if (event.assistantMessageEvent.type === "done") {
					stats.finishReasons.push(event.assistantMessageEvent.reason);
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					const text = event.message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("");
					if (text) stats.finalText = text;
					if (event.message.usage) {
						stats.lastUsage = {
							prompt_tokens: event.message.usage.input,
							completion_tokens: event.message.usage.output,
							total_tokens: event.message.usage.totalTokens,
						};
					}
					if (event.message.stopReason) {
						stats.finishReasons.push(event.message.stopReason);
					}
				}
				break;
			case "agent_end":
				log("agent_end");
				break;
		}
	});

	await agent.prompt("Please echo the word hello.");
	await agent.waitForIdle();

	return stats;
}

function report(stats: SpikeStats): void {
	console.log("\n========== SPIKE RESULT ==========");
	console.log("turns:           ", stats.turns);
	console.log("tool calls:      ", JSON.stringify(stats.toolCalls));
	console.log("tool results:    ", JSON.stringify(stats.toolResults));
	console.log("text deltas:     ", stats.textDeltas.length, "delta(s)");
	console.log("final text:      ", JSON.stringify(stats.finalText));
	console.log("usage (passthru):", JSON.stringify(stats.lastUsage));
	console.log("finish reasons:  ", JSON.stringify(stats.finishReasons));
	console.log("errors:          ", JSON.stringify(stats.errors));
	console.log("==================================\n");

	const toolOk = stats.toolCalls.length >= 1 && stats.toolResults.length >= 1;
	const usageOk = stats.lastUsage?.prompt_tokens !== undefined && stats.lastUsage.prompt_tokens > 0;
	const streamingOk = stats.textDeltas.length >= 1;
	const finishOk = stats.finishReasons.includes("stop");

	console.log("ACCEPTANCE CHECKS");
	console.log("  received tool_calls:        ", toolOk ? "PASS" : "FAIL");
	console.log("  usage passthrough (>0):     ", usageOk ? "PASS" : "FAIL");
	console.log("  streaming text deltas:      ", streamingOk ? "PASS" : "FAIL");
	console.log("  finish_reason stop present: ", finishOk ? "PASS" : "FAIL");
	console.log("");

	if (toolOk && usageOk && streamingOk && finishOk) {
		console.log("RESULT: ALL CHECKS PASSED");
	} else {
		console.log("RESULT: FAILURES PRESENT");
		process.exitCode = 1;
	}
}

async function main(): Promise<void> {
	const mode = process.env.SPIKE_MODE ?? "mock";
	log(`mode = ${mode}`);

	let cfg: AiEngineConfig;
	let mockServer: Server | undefined;

	if (mode === "real") {
		const base = process.env.AI_BASE_URL;
		const key = process.env.AI_API_KEY;
		const modelName = process.env.AI_MODEL;
		if (!base || !key || !modelName) {
			console.error("SPIKE_MODE=real requires AI_BASE_URL, AI_API_KEY, AI_MODEL");
			process.exit(2);
		}
		cfg = { base_url: base, api_key: key, model: modelName };
	} else {
		// mock
		const { server, baseUrl } = await startMockServer();
		mockServer = server;
		cfg = {
			base_url: baseUrl,
			api_key: "mock-key-not-checked",
			model: "mock-model",
			max_tokens: 256,
			context_window_tokens: 8192,
			api_protocol: "openai",
		};
		log(`mock server listening at ${baseUrl}`);
	}

	try {
		const stats = await runSpike(cfg);
		report(stats);
	} catch (err) {
		console.error("[spike] FATAL:", err);
		process.exitCode = 1;
	} finally {
		if (mockServer) await new Promise<void>((r) => mockServer!.close(() => r()));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
