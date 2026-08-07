import { describe, expect, it } from "vitest";
import { type OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { buildModel, type AiEngineConfig } from "../src/pi-model.js";

const baseCfg: AiEngineConfig = {
	base_url: "https://cpa.example.internal/v1",
	api_key: "sk-test-key",
	model: "test-model",
};

describe("buildModel", () => {
	it("defaults api_protocol to openai-completions", () => {
		const { model, models } = buildModel(baseCfg);
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("cpa-gateway");
		expect(model.baseUrl).toBe(baseCfg.base_url);
		expect(model.id).toBe("test-model");
		expect(model.name).toBe("test-model");
		// catalog registered
		expect(models.getProvider("cpa-gateway")).toBeTruthy();
		expect(models.getModel("cpa-gateway", "test-model")?.id).toBe("test-model");
	});

	it("applies default context_window and max_tokens", () => {
		const { model } = buildModel(baseCfg);
		expect(model.contextWindow).toBe(272000);
		expect(model.maxTokens).toBe(2048);
	});

	it("respects explicit context_window_tokens and max_tokens", () => {
		const { model } = buildModel({
			...baseCfg,
			max_tokens: 1234,
			context_window_tokens: 9999,
		});
		expect(model.maxTokens).toBe(1234);
		expect(model.contextWindow).toBe(9999);
	});

	it("sets CPA compat overrides for openai-completions", () => {
		const { model } = buildModel(baseCfg);
		expect(model.api).toBe("openai-completions");
		// Model<Api>.compat is a conditional union; assert the openai-completions
		// branch explicitly so the field names type-check.
		const compat = model.compat as OpenAICompletionsCompat;
		// CPA gateway must not emit official-OpenAI-only fields
		expect(compat.supportsStore).toBe(false);
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsStrictMode).toBe(false);
		// classic chat completions field name
		expect(compat.maxTokensField).toBe("max_tokens");
		// usage + finish_reason passthrough
		expect(compat.supportsUsageInStreaming).toBe(true);
		expect(compat.supportsFinishReason).toBe(true);
	});

	it("uses anthropic-messages api when api_protocol=anthropic", () => {
		const { model } = buildModel({ ...baseCfg, api_protocol: "anthropic" });
		expect(model.api).toBe("anthropic-messages");
	});

	it("zeroes cost and disables reasoning, supports text+image input", () => {
		const { model } = buildModel(baseCfg);
		expect(model.cost.input).toBe(0);
		expect(model.cost.output).toBe(0);
		expect(model.cost.cacheRead).toBe(0);
		expect(model.cost.cacheWrite).toBe(0);
		expect(model.reasoning).toBe(false);
		expect(model.input).toEqual(["text", "image"]);
	});
});
