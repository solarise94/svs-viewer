/**
 * AI reading assistant sidecar — Flask internal callback client (Step 2 of the
 * pi migration).
 *
 * Sidecar (Node) calls back into the Flask app to read slide regions / drop
 * annotations / poll spot changes / fetch slide info. These are the same
 * operations the Python agent used to do in-process; the sidecar now performs
 * them over a loopback HTTP call secured by a shared token.
 *
 * Endpoint inventory (app.py, Step 2):
 *   POST /internal/ai/region       {slide,x,y,w,h,out_w?,out_h?} → region dict
 *   POST /internal/ai/annotate     {slide,label,x,y,side_px,note,effect_key,session_id} → roi dict
 *   GET  /internal/ai/spots        ?slide=&after_seq= → {changes,current_seq}
 *   GET  /internal/ai/slide_info   ?slide= → {width,height,level_downsamples,mpp,fingerprint}
 *
 * Auth: every request carries `X-AI-Internal-Token`. The token resolves the
 * same way Flask does: env `AI_INTERNAL_TOKEN` first, else read
 * `SHARE_DATA_DIR/ai_internal.token`. Resolved once at construction.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --------------------------------------------------------------------------- //
// Types — mirror the Flask response shapes (app.py Step 2 endpoints)
// --------------------------------------------------------------------------- //

/** Region read result (matches /api/slide/<name>/region + _read_region_b64). */
export interface RegionResult {
	image_base64: string;
	mime: string;
	width: number;
	height: number;
	src: { x: number; y: number; w: number; h: number };
	magnification: number | null;
}

/** ROI dict returned by share_store.add_roi (rect). */
export interface RoiDict {
	annotation_id: string;
	index: number;
	token: string;
	slide: string;
	label: string;
	note: string;
	type: string;
	x: number;
	y: number;
	side_px: number;
	size_mm: number;
	shared: boolean;
	source: string;
	created_by_session_id: string;
	change_seq: number;
	revision: number;
	[k: string]: unknown;
}

/** GET /internal/ai/spots response. */
export interface SpotsResult {
	changes: Record<string, unknown>[];
	current_seq: number;
}

/** GET /internal/ai/slide_info response. */
export interface SlideInfoResult {
	width: number;
	height: number;
	level_downsamples: number[];
	mpp: number | null;
	fingerprint: string;
}

/** Error thrown on a non-2xx response from Flask; carries the HTTP status. */
export class FlaskHttpError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(status: number, body: unknown, message?: string) {
		super(message || `flask ${status}`);
		this.name = "FlaskHttpError";
		this.status = status;
		this.body = body;
	}
}

// --------------------------------------------------------------------------- //
// Token resolution (mirrors app.py _load_or_create_ai_internal_token read path)
// --------------------------------------------------------------------------- //

function defaultDataDir(): string {
	return process.env.SHARE_DATA_DIR || join(homedir(), "svs-viewer", "share-data");
}

/**
 * Resolve the shared internal token: env `AI_INTERNAL_TOKEN` first, else read
 * `SHARE_DATA_DIR/ai_internal.token`. Unlike the Flask side, the sidecar is a
 * read-only consumer of the token (Flask generates it), so we do NOT create
 * the file if it is missing — we throw so misconfiguration surfaces loudly.
 */
export async function resolveAiInternalToken(): Promise<string> {
	const envTok = process.env.AI_INTERNAL_TOKEN;
	if (envTok && envTok.trim()) {
		return envTok.trim();
	}
	const p = join(defaultDataDir(), "ai_internal.token");
	const raw = await fs.readFile(p, "utf8");
	const tok = raw.trim();
	if (!tok) {
		throw new Error(`AI_INTERNAL_TOKEN not set and ${p} is empty`);
	}
	return tok;
}

// --------------------------------------------------------------------------- //
// FlaskClient
// --------------------------------------------------------------------------- //

export interface FlaskClientOptions {
	/** Base URL (env AI_FLASK_URL, default http://127.0.0.1:8000). */
	baseUrl?: string;
	/** Shared token; if omitted, resolved via {@link resolveAiInternalToken}. */
	token?: string;
	/** Per-request timeout ms (default 30000). */
	timeoutMs?: number;
}

export class FlaskClient {
	readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(opts: FlaskClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? process.env.AI_FLASK_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
		this.token = opts.token ?? "";
		this.timeoutMs = opts.timeoutMs ?? 30000;
	}

	/**
	 * Ensure the token is loaded (env-resolved at construction is a no-op; the
	 * file path is read lazily so construction never throws on a missing file
	 * in environments that set the env var). Safe to call repeatedly.
	 */
	async ensureToken(): Promise<void> {
		if (!this.token) {
			// A token captured via env at construction is already set; this only
			// runs when the caller constructed with no token and no env. We read
			// the file then, but cannot mutate `readonly token` — so callers that
			// rely on file-based resolution should construct via createFlaskClient.
			throw new Error("FlaskClient built without a token; use createFlaskClient()");
		}
	}

	private async request<T>(method: string, path: string, init?: { body?: unknown; query?: Record<string, string> }): Promise<T> {
		await this.ensureToken();
		const url = new URL(this.baseUrl + path);
		if (init?.query) {
			for (const [k, v] of Object.entries(init.query)) {
				url.searchParams.set(k, v);
			}
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers: {
					"X-AI-Internal-Token": this.token,
					"Content-Type": "application/json",
				},
				body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
		const text = await res.text();
		let parsed: unknown = undefined;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		if (!res.ok) {
			throw new FlaskHttpError(res.status, parsed, `flask ${res.status} ${method} ${path}`);
		}
		return parsed as T;
	}

	/** POST /internal/ai/region — read a level-0 region (with cyan coord ticks). */
	async region(args: {
		slide: string;
		x: number;
		y: number;
		w: number;
		h: number;
		out_w?: number;
		out_h?: number;
	}): Promise<RegionResult> {
		return this.request<RegionResult>("POST", "/internal/ai/region", { body: args });
	}

	/** POST /internal/ai/annotate — drop a rect annotation (idempotent via effect_key). */
	async annotate(args: {
		slide: string;
		label: string;
		x: number;
		y: number;
		side_px: number;
		note?: string;
		effect_key?: string;
		session_id?: string;
	}): Promise<RoiDict> {
		return this.request<RoiDict>("POST", "/internal/ai/annotate", { body: args });
	}

	/** GET /internal/ai/spots — incremental change log for a slide. */
	async spots(slide: string, afterSeq = 0): Promise<SpotsResult> {
		return this.request<SpotsResult>("GET", "/internal/ai/spots", {
			query: { slide, after_seq: String(afterSeq) },
		});
	}

	/** GET /internal/ai/slide_info — dimensions / pyramid / mpp / fingerprint. */
	async slideInfo(slide: string): Promise<SlideInfoResult> {
		return this.request<SlideInfoResult>("GET", "/internal/ai/slide_info", {
			query: { slide },
		});
	}
}

/**
 * Build a {@link FlaskClient} with the shared token resolved the same way Flask
 * resolves it (env first, else file). Use this in production; tests typically
 * pass an explicit `token`.
 */
export async function createFlaskClient(opts: Omit<FlaskClientOptions, "token"> = {}): Promise<FlaskClient> {
	const token = process.env.AI_INTERNAL_TOKEN?.trim() || (await readTokenFile());
	return new FlaskClient({ ...opts, token });
}

async function readTokenFile(): Promise<string> {
	const p = join(defaultDataDir(), "ai_internal.token");
	const raw = await fs.readFile(p, "utf8");
	const tok = raw.trim();
	if (!tok) {
		throw new Error(`AI_INTERNAL_TOKEN not set and ${p} is empty`);
	}
	return tok;
}
