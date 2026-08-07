/**
 * pi model factory for the AI reading assistant sidecar.
 *
 * Builds a pi {@link Model} and a registered {@link Models} catalog from the
 * sidecar's engine config. The model targets a CPA (compatibility proxy /
 * aggregation gateway) OpenAI-compatible endpoint, so every OpenAI
 * compatibility flag is explicitly overridden instead of relying on pi's
 * URL-based auto-detection (which turns on store/developer/strict for unknown
 * baseUrls — see compat rationale below).
 *
 * Source-file/line references point at /tmp/pi-src (pi main, v0.84.0).
 */
import {
	createModels,
	createProvider,
	type Api,
	type ApiKeyAuth,
	type Model,
	type Models,
	type OpenAICompletionsCompat,
	type Provider,
} from "@earendil-works/pi-ai";

/**
 * Engine config supplied by the Python host (mirrors the Flask AI engine config).
 */
export interface AiEngineConfig {
	base_url: string;
	api_key: string;
	model: string;
	/** Default 2048. */
	max_tokens?: number;
	/** Default 272000. */
	context_window_tokens?: number;
	/** Default "openai". */
	api_protocol?: "openai" | "anthropic";
}

/**
 * Provider id we register the model under. Stable, host-facing identifier;
 * not a real upstream provider so it intentionally avoids every name pi
 * recognises in detectCompat (pi-ai/src/api/openai-completions.ts:1443).
 */
const CPA_PROVIDER_ID = "cpa-gateway";

/** OpenAI-completions compat overrides for a CPA aggregation gateway. */
const CPA_COMPAT: OpenAICompletionsCompat = {
	// detectCompat turns these ON for unknown official-like baseUrls
	// (pi-ai/src/api/openai-completions.ts:1494 supportsStore: !isNonStandard,
	//  :1495 supportsDeveloperRole, :1522 supportsStrictMode). A CPA gateway is
	//  a passthrough and must not emit these OpenAI-only fields.
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	// CPA speaks the classic OpenAI Chat Completions field set
	// (:1500 maxTokensField defaults to max_completion_tokens for unknown
	//  baseUrls; use max_tokens).
	maxTokensField: "max_tokens",
	// CPA passes usage through in the final streamed chunk
	// (:1498-1499 default true; kept explicit for clarity).
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
};

/**
 * Static api-key auth: the key comes from config, not from the environment or
 * a credential store, so we return it verically from resolve(). This is the
 * "or resolve() returns a static key" path described in
 * pi-ai/src/auth/types.ts (ApiKeyAuth interface).
 */
function staticApiKeyAuth(key: string): ApiKeyAuth {
	return {
		name: "CPA gateway API key",
		async resolve() {
			return {
				auth: { apiKey: key },
				source: "config",
			};
		},
	};
}

/**
 * Build a pi model + registered catalog from the engine config.
 *
 * @returns `{ models, model }` — `models` is the registered catalog (provider
 *   `cpa-gateway`), `model` is the single configured model. The model is typed
 *   as `Model<Api>` because the protocol may be either openai-completions or
 *   anthropic-messages; narrow with `hasApi()` at the call site.
 */
export function buildModel(cfg: AiEngineConfig): {
	models: Models;
	model: Model<Api>;
} {
	const protocol = cfg.api_protocol ?? "openai";
	const maxTokens = cfg.max_tokens ?? 2048;
	const contextWindow = cfg.context_window_tokens ?? 272000;

	const api: Api = protocol === "anthropic" ? "anthropic-messages" : "openai-completions";

	// Model shape per pi-ai/src/types.ts:785 (Model<TApi>). cost all zero
	// (ModelCostRates, types.ts:767) — billing is handled upstream by CPA.
	// reasoning:false, input text+image.
	const model: Model<Api> = {
		id: cfg.model,
		name: cfg.model,
		api,
		provider: CPA_PROVIDER_ID,
		baseUrl: cfg.base_url,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindow,
		maxTokens: maxTokens,
		// compat only applies to openai-completions (types.ts:805). For
		// anthropic-messages the field is typed to AnthropicMessagesCompat and
		// the CPA defaults (no special flags) are fine, so we only set it for
		// the openai path.
		...(api === "openai-completions" ? { compat: CPA_COMPAT } : {}),
	} as Model<Api>;

	// Build a single-model provider. createProvider is the public factory
	// (pi-ai/src/models.ts:762). api streams live under
	// @earendil-works/pi-ai/api/<name>; we bind the matching implementation.
	const providerInput: Parameters<typeof createProvider>[0] = {
		id: CPA_PROVIDER_ID,
		name: "CPA gateway",
		baseUrl: cfg.base_url,
		auth: { apiKey: staticApiKeyAuth(cfg.api_key) },
		models: [model as Model<typeof api>],
		// ProviderStreams contract: types.ts:268. Each api/ module exports
		// `stream`/`streamSimple`. Dynamic import would complicate the spike;
		// the Agent path used by the sidecar invokes the low-level
		// streamSimple directly (see scripts/spike.ts), so a minimal provider
		// without api implementations is sufficient for model registration.
		api: {} as never,
	};

	const provider: Provider<Api> = createProvider(providerInput);

	const models = createModels();
	// MutableModels.setProvider (models.ts:225) registers the provider.
	(models as unknown as { setProvider(p: Provider<Api>): void }).setProvider(provider);

	return { models, model };
}
