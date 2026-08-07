/**
 * AI reading assistant sidecar — transcript view model (Step 3).
 *
 * Converts the persisted pi {@link AgentMessage} transcript (session.messages)
 * into the **canonical frontend shape** that app.js `renderAiTranscript`
 * (static/app.js:3849) consumes. The frontend was written against the Python
 * canonical_messages format (OpenAI-style tool_calls / tool_call_id pairing),
 * so this module narrows the pi union into that shape — field names are
 * load-bearing (the frontend hard-codes them).
 *
 * Output shapes (matching app.py:1807-1826 + app.js consumption):
 *
 *   user(msg)      → { role:"user",
 *                      content: string | TextContent[]|ImageRefContent[],
 *                      display_text?,            // UI bubble label
 *                      spot_updated?, spot_deleted? }
 *   assistant(msg) → { role:"assistant",
 *                      content: string,          // concatenated text blocks
 *                      tool_calls: [{ id, type:"function",
 *                                     function:{ name, arguments: JSON-string } }] }
 *   toolResult     → { role:"tool",
 *                      tool_call_id,
 *                      content: string | (TextContent|ImageRefContent)[] }
 *
 * Image blocks are dehydrated to image_ref by session-store on persist; this
 * module passes them through unchanged (the frontend reads image_ref.src /
 * .magnification directly — app.js:3924-3925, 3984).
 *
 * System messages are not persisted (the pi Agent carries the system prompt on
 * its state), so the transcript never contains a system entry; if one slips in
 * (e.g., legacy data) it is passed through.
 */
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import type {
	ImageRefContent,
	PersistedAgentMessage,
	PersistedContent,
	SessionData,
} from "./session-store.js";
import { isImageRefContent } from "./session-store.js";

// =========================================================================== //
// Frontend canonical types
// =========================================================================== //

/** A frontend tool_calls entry (OpenAI function-calling shape). */
export interface FrontendToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/** A canonical frontend message (the union the frontend renders). */
export type FrontendMessage = {
	role: "user" | "assistant" | "tool" | "system" | string;
	content: unknown;
	[k: string]: unknown;
};

// =========================================================================== //
// Helpers
// =========================================================================== //

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull every text block's text out of a content array; join with " " (app.js:3963). */
function concatText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isObject(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		}
		// image_ref / image blocks are skipped here; they're handled where the
		// array form is preserved (toToolResultMessage).
	}
	return parts.join(" ");
}

/** True if a content array contains any image_ref or image block. */
function contentHasImage(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	for (const part of content) {
		if (isObject(part) && (part.type === "image_ref" || part.type === "image")) return true;
	}
	return false;
}

// =========================================================================== //
// Per-role converters
// =========================================================================== //

/**
 * Convert a pi/persisted user message to the frontend shape.
 *
 * - `display_text`, `spot_updated`, `spot_deleted` are carried through verbatim
 *   (they are UI-only markers persisted alongside the message; app.js:3866,
 *   3941 read them off the message).
 * - `content`: passed through. The frontend handles both string and array
 *   forms (app.js:3963 messageText, 3979 findImageRef).
 */
function toUserMessage(m: UserMessage & Record<string, unknown>): FrontendMessage {
	const out: FrontendMessage = { role: "user", content: m.content };
	// Persisted user messages may carry UI-only fields (display_text, spot_*).
	if (typeof m.display_text === "string") out.display_text = m.display_text;
	if (m.spot_updated !== undefined) out.spot_updated = m.spot_updated;
	if (m.spot_deleted !== undefined) out.spot_deleted = m.spot_deleted;
	return out;
}

/**
 * Convert a pi/persisted assistant message to the frontend OpenAI shape.
 *
 * pi represents tool calls as `toolCall` content blocks
 * ({type:"toolCall", id, name, arguments}); the frontend expects the OpenAI
 * `tool_calls:[{id, type:"function", function:{name, arguments: JSON-string}}]`
 * shape (app.js:3875-3882). `arguments` must be a JSON **string** (the frontend
 * parses it with parseToolArgs). Text content is concatenated into a single
 * string (app.js:3876 reads `text` from messageText).
 */
function toAssistantMessage(m: AssistantMessage): FrontendMessage {
	const toolCalls: FrontendToolCall[] = [];
	for (const part of m.content as unknown[]) {
		if (isObject(part) && part.type === "toolCall") {
			const tc = part as unknown as { id: string; name: string; arguments: Record<string, unknown> };
			toolCalls.push({
				id: tc.id,
				type: "function",
				function: {
					name: tc.name,
					arguments: JSON.stringify(tc.arguments ?? {}),
				},
			});
		}
	}
	const text = concatText(m.content);
	const out: FrontendMessage = { role: "assistant", content: text };
	if (toolCalls.length > 0) out.tool_calls = toolCalls;
	return out;
}

/**
 * Convert a pi/persisted tool-result message to the frontend shape.
 *
 * - `tool_call_id` (not pi's camelCase `toolCallId`) is what app.js:3857 keys
 *   tool results by to pair them with the originating assistant tool_call.
 * - `content`: a string when there is no image (the common case); an array
 *   (kept as-is, with image_ref blocks) when there is one, so app.js:3979
 *   findImageRef can pull out the snapshot reference.
 */
function toToolResultMessage(m: ToolResultMessage): FrontendMessage {
	const content = m.content as unknown[];
	let outContent: unknown;
	if (contentHasImage(content)) {
		// Keep the array form so the frontend can find the image_ref block.
		// Strip any raw image (base64) blocks — the persisted form already
		// dehydrated these to image_ref, but be defensive.
		outContent = content.filter((p) => !isObject(p) || p.type !== "image");
	} else {
		outContent = concatText(content);
	}
	return { role: "tool", tool_call_id: m.toolCallId, content: outContent };
}

// =========================================================================== //
// Public API
// =========================================================================== //

/**
 * Convert a single persisted pi message to the frontend canonical shape.
 * Returns null for messages that have no role (shouldn't happen for persisted
 * messages; defensive).
 */
export function toFrontendMessage(m: PersistedAgentMessage): FrontendMessage | null {
	if (!isObject(m)) return null;
	const role = (m as { role?: string }).role;
	if (role === "user") return toUserMessage(m as UserMessage & Record<string, unknown>);
	if (role === "assistant") return toAssistantMessage(m as unknown as AssistantMessage);
	if (role === "toolResult") return toToolResultMessage(m as unknown as ToolResultMessage);
	// system / custom / unknown: pass through (frontend handles system entries).
	return m as unknown as FrontendMessage;
}

/**
 * Build the full transcript array for GET /session/:id.
 *
 * Pulls `messages` off the session data and maps each entry. The order is
 * preserved (the frontend renders in order and pairs tool results to tool_calls
 * by id, app.js:3854-3860).
 */
export function buildTranscript(data: SessionData): FrontendMessage[] {
	const out: FrontendMessage[] = [];
	for (const m of data.messages ?? []) {
		const fm = toFrontendMessage(m);
		if (fm) out.push(fm);
	}
	return out;
}

/**
 * Convenience: extract the first image_ref from a frontend tool message's
 * content array. Mirrors app.js:3979 findImageRef; exported for tests.
 */
export function findImageRef(msg: FrontendMessage): ImageRefContent | null {
	const c = msg.content;
	if (!Array.isArray(c)) return null;
	for (const part of c) {
		if (isImageRefContent(part)) return part;
	}
	return null;
}
