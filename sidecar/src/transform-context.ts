/**
 * AI reading assistant sidecar — pi transformContext hook (Step 4).
 *
 * Replaces the Python "materialize image_ref at request time + cap recent
 * images" logic (ai_session.py:845 `_materialize_image_ref` /
 * `materialize_request_messages`, plus the implicit cap on carried snapshots).
 *
 * pi calls {@link AgentOptions.transformContext} on every LLM request, AFTER
 * the agent state is built but BEFORE {@link AgentOptions.convertToLlm}
 * (agent-loop.ts:288-292). Our hook does two jobs there:
 *
 *   1. **Materialize (rehydrate)**: turn every persisted `image_ref` block back
 *      into a real pi `image` block by calling flask.region. Slide fingerprint
 *      mismatch or fetch failure → degrade to a text block
 *      `"该图因切片变更不可用。"` (ai_session.py:855).
 *   2. **Image eviction**: keep at most the last `keep_recent_images` (default
 *      6) materialized image blocks, PLUS the first whole-slide overview
 *      snapshot which is always retained. Older image blocks beyond the cap are
 *      replaced with the placeholder
 *      `"（历史快照已省略，可用 goto+snapshot 重新查看）"`.
 *
 * Contract (types.ts:183-200): the hook MUST NOT throw or reject — on any
 * error we return the original messages unchanged. It is also a pure read-only
 * transform: we never mutate `agent.state.messages` (pi semantics).
 *
 * **All `image_ref` blocks are guaranteed removed from the output** — pi's
 * `defaultConvertToLlm` only filters by role, it does not rewrite content, so a
 * leftover `image_ref` would reach the LLM and break serialization.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

import type { FlaskClient } from "./flask-client.js";
import type { SlideInfo } from "./tools.js";
import { isImageContent, isImageRefContent, type ImageRefContent, type PersistedAgentMessage } from "./session-store.js";

// =========================================================================== //
// Public config
// =========================================================================== //

/** Tuning knobs for {@link makeTransformContext}. */
export interface TransformContextConfig {
	/** Max materialized image blocks retained per request (default 6). */
	keep_recent_images?: number;
}

/** Resolved settings. */
export interface TransformContextSettings {
	keepRecentImages: number;
}

export function resolveTransformSettings(cfg: TransformContextConfig): TransformContextSettings {
	const raw = Number(cfg.keep_recent_images);
	const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
	return { keepRecentImages: n };
}

// =========================================================================== //
// Overview-image identification
// =========================================================================== //

/**
 * Heuristic for "this image is the whole-slide overview and must never be
 * evicted" (§3.3 first-snapshot semantics). Two signals, either suffices:
 *
 *   (a) the image's toolCallId matches the session-level first-snapshot id
 *       tracked by the agent-runner closure (most reliable — exact identity);
 *   (b) the bbox covers >90% of the slide width (mirrors the snapshot tool's
 *       own "全片概览级" hint threshold in tools.ts).
 *
 * (a) is authoritative when available; (b) is a fallback for sessions resumed
 * from disk where the first-snapshot id wasn't re-derived.
 */
function isOverviewImage(
	block: ImageContent | ImageRefContent,
	slideInfo: SlideInfo,
	firstSnapshotToolCallId: string | null,
): boolean {
	// (a) identity match. For a materialized image we don't carry the toolCallId
	// on the block; for an image_ref we have ref_id ("ref_<toolCallId>"). We
	// also accept an overview tag carried in a sibling text block, but the
	// primary path is the ref_id check done before materialization.
	if (firstSnapshotToolCallId) {
		const ref = block as { ref_id?: string };
		if (typeof ref.ref_id === "string" && ref.ref_id === `ref_${firstSnapshotToolCallId}`) {
			return true;
		}
	}
	// (b) coverage fallback (only meaningful for image_ref, which carries src).
	const src = (block as { src?: { w?: number; h?: number } }).src;
	if (src && typeof src.w === "number" && slideInfo.width > 0) {
		const cov = (src.w / slideInfo.width) * 100;
		if (cov > 90) return true;
	}
	return false;
}

// =========================================================================== //
// makeTransformContext
// =========================================================================== //

/**
 * Build a pi transformContext hook bound to one session's flask client, slide
 * info, and tuning settings.
 *
 * @param firstSnapshotToolCallIdRef a mutable ref (object) so the runner can
 *   record the first snapshot's toolCallId as the session progresses; the hook
 *   reads it live each call. null until the first snapshot lands.
 */
export function makeTransformContext(args: {
	flask: FlaskClient;
	slide: string;
	slideInfo: SlideInfo;
	settings: TransformContextSettings;
	firstSnapshotToolCallIdRef: { value: string | null };
}): (messages: AgentMessage[], _signal?: AbortSignal) => Promise<AgentMessage[]> {
	const { flask, slide, slideInfo, settings, firstSnapshotToolCallIdRef } = args;

	return async (messages): Promise<AgentMessage[]> => {
		try {
			return await transformOnce(messages, flask, slide, slideInfo, settings, firstSnapshotToolCallIdRef);
		} catch {
			// pi contract (types.ts:183-200): never throw — return originals.
			return messages;
		}
	};
}

/**
 * One materialize-then-evict pass. Pure: returns a new array, leaves inputs
 * untouched.
 *
 * Algorithm:
 *   1. Walk every message; for each `image_ref` block, attempt to materialize
 *      it into an `image` block (flask.region). Mismatch / failure → text
 *      fallback. Collect the *index path* (message i, block j) of every
 *      materialized image so step 2 can evict by position without re-scanning.
 *      image_ref blocks whose ref_id matches the first-snapshot id, or whose
 *      bbox covers the whole slide, are tagged as overview (protected).
 *   2. If the number of materialized images exceeds keepRecentImages, evict the
 *      oldest ones — except protected overview images — replacing them with the
 *      placeholder text. Keep the most recent `keepRecentImages` non-protected
 *      images.
 */
async function transformOnce(
	messages: AgentMessage[],
	flask: FlaskClient,
	slide: string,
	slideInfo: SlideInfo,
	settings: TransformContextSettings,
	firstSnapshotToolCallIdRef: { value: string | null },
): Promise<AgentMessage[]> {
	// Phase 1: materialize. First scan for all image_ref blocks and fetch them
	// concurrently (one flask.region call each), recording each result by its
	// (msgIdx, blkIdx) position. Then rebuild the message array with the
	// materialized (or degraded) blocks substituted in.
	type ImgPos = { msgIdx: number; blkIdx: number; overview: boolean };
	const imgPositions: ImgPos[] = [];

	// Collect ref positions + kick off all fetches concurrently.
	const refJobs: Array<{ msgIdx: number; blkIdx: number; overview: boolean; promise: ReturnType<typeof materializeRefSync> }> = [];
	for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
		const m = messages[msgIdx]!;
		const role = (m as { role?: string }).role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (let blkIdx = 0; blkIdx < content.length; blkIdx++) {
			const part = content[blkIdx];
			if (part && isImageRefContent(part)) {
				const overview = isOverviewImage(part, slideInfo, firstSnapshotToolCallIdRef.value);
				refJobs.push({ msgIdx, blkIdx, overview, promise: materializeRefSync(part, flask, slide) });
			}
		}
	}
	const refResults = await Promise.all(refJobs.map(async (j) => ({ ...j, block: await j.promise })));
	const refByKey = new Map<string, { block: ImageContent | { type: "text"; text: string }; overview: boolean }>();
	for (const r of refResults) {
		refByKey.set(`${r.msgIdx}:${r.blkIdx}`, { block: r.block, overview: r.overview });
	}

	// Rebuild messages, substituting refs + recording materialized image positions.
	const out: AgentMessage[] = messages.map((m, msgIdx) => {
		const role = (m as { role?: string }).role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") {
			return m;
		}
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string" || !Array.isArray(content)) {
			return m;
		}
		let touched = false;
		const newContent = content.map((part, blkIdx): unknown => {
			const key = `${msgIdx}:${blkIdx}`;
			const ref = refByKey.get(key);
			if (ref) {
				touched = true;
				if (ref.block.type === "image") {
					imgPositions.push({ msgIdx, blkIdx, overview: ref.overview });
				}
				return ref.block;
			}
			if (isImageContent(part)) {
				// An already-materialized image (e.g. just produced this turn, not
				// yet dehydrated). Treat it like a materialized one for eviction
				// accounting. Pure image blocks carry no ref_id, so overview
				// detection can't apply — these are always evictable.
				imgPositions.push({ msgIdx, blkIdx, overview: false });
				return part;
			}
			return part;
		});
		return touched ? ({ ...(m as object), content: newContent } as AgentMessage) : m;
	});

	// Phase 2: evict. Protected (overview) images never count against the cap.
	// Among the rest, keep the most recent `keepRecentImages`; older ones become
	// placeholders. "Recent" = highest (msgIdx, blkIdx) ordering.
	const evictable = imgPositions
		.filter((p) => !p.overview)
		.sort((a, b) => rank(a) - rank(b)); // oldest first
	const toEvictCount = Math.max(0, evictable.length - settings.keepRecentImages);

	if (toEvictCount === 0) {
		return out;
	}

	// Build a set of "msgIdx:blkIdx" keys to evict.
	const evictKeys = new Set(evictable.slice(0, toEvictCount).map((p) => `${p.msgIdx}:${p.blkIdx}`));

	// Apply evictions by walking messages again and replacing the targeted
	// image blocks with the placeholder text.
	const placeholderText = "（历史快照已省略，可用 goto+snapshot 重新查看）";
	return out.map((m, msgIdx) => {
		const role = (m as { role?: string }).role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") {
			return m;
		}
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string" || !Array.isArray(content)) {
			return m;
		}
		let touched = false;
		const newContent = content.map((part, blkIdx): unknown => {
			if (isImageContent(part) && evictKeys.has(`${msgIdx}:${blkIdx}`)) {
				touched = true;
				return { type: "text", text: placeholderText };
			}
			return part;
		});
		return touched ? ({ ...(m as object), content: newContent } as AgentMessage) : m;
	});

	// Helper: lexicographic rank by (msgIdx, blkIdx); fine for our sizes.
	function rank(p: ImgPos): number {
		return p.msgIdx * 1_000_000 + p.blkIdx;
	}
}

/**
 * Materialize one image_ref synchronously-ish (await flask.region). Returns
 * either an image block or a degraded text block. Never throws — callers rely
 * on the text fallback to keep the transform total.
 *
 * NOTE: despite the `Sync` name this is async; the name just signals it does
 * not coordinate across blocks (one ref → one call).
 */
async function materializeRefSync(
	ref: ImageRefContent,
	flask: FlaskClient,
	slide: string,
): Promise<ImageContent | { type: "text"; text: string }> {
	// Fingerprint guard (ai_session.py:1321): a mismatch means the slide file
	// changed under us; the cached region would be wrong.
	// We don't have the live fingerprint here (slideInfo was captured at run
	// start), so flask.region itself enforces it server-side by reading the
	// current file. A fetch failure is treated as "slide changed / unavailable".
	const src = ref.src || { x: 0, y: 0, w: 0, h: 0 };
	try {
		const r = await flask.region({
			slide,
			x: src.x,
			y: src.y,
			w: Math.max(1, src.w),
			h: Math.max(1, src.h),
			out_w: 1568,
			out_h: 1568,
		});
		const b64 = r.image_base64 || "";
		if (!b64) {
			return { type: "text", text: "该图因切片变更不可用。" };
		}
		return { type: "image", data: b64, mimeType: r.mime || "image/jpeg" };
	} catch {
		return { type: "text", text: "该图因切片变更不可用。" };
	}
}

// =========================================================================== //
// Test-visible helpers (not exported via the public surface)
// =========================================================================== //

/**
 * Count image blocks (materialized images, not refs) in a message array. Used
 * by tests to assert the eviction outcome.
 */
export function countImageBlocks(messages: AgentMessage[] | PersistedAgentMessage[]): number {
	let n = 0;
	for (const m of messages) {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (isImageContent(part)) n += 1;
		}
	}
	return n;
}

/**
 * Assert no `image_ref` blocks remain (transform output invariant). Returns
 * true when clean. Used by tests.
 */
export function hasNoImageRefBlocks(messages: AgentMessage[] | PersistedAgentMessage[]): boolean {
	for (const m of messages) {
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (isImageRefContent(part)) return false;
		}
	}
	return true;
}
