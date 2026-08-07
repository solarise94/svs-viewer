/**
 * AI reading assistant sidecar — process entry point (Step 3).
 *
 * Resolves env-based configuration, runs boot-time session recovery, and
 * starts the HTTP server. The sidecar does NOT read ai_config.json — the
 * per-run engine config is injected by the caller (Flask proxy, Step 5) in
 * each request body.
 *
 * Env:
 *   AI_SIDECAR_PORT   listen port (default 8055)
 *   AI_FLASK_URL      Flask callback base URL (default http://127.0.0.1:8000)
 *   SHARE_DATA_DIR    data dir (sessions live under <dir>/ai_sessions)
 *   AI_INTERNAL_TOKEN shared callback token (else read from data dir)
 */
import { SessionStore } from "./session-store.js";
import { SessionEventBus } from "./events.js";
import { AgentRunner } from "./agent-runner.js";
import { SidecarServer } from "./server.js";
import { createFlaskClient } from "./flask-client.js";

async function main(): Promise<void> {
	const store = new SessionStore();
	await store.ensureDir();

	// Boot recovery (ai_session.py:498-504 generalized): any session left
	// "running" by a crashed process is flipped to "paused", and every
	// session's last_event_seq is reconciled against its events file tail.
	const recovery = await store.recoverOnBoot();
	if (recovery.paused.length || recovery.repaired.length) {
		console.log(
			`[sidecar] boot recovery: ${recovery.paused.length} session(s) paused, ${recovery.repaired.length} seq-repaired`,
		);
	}

	const bus = new SessionEventBus(store);
	const flask = await createFlaskClient();
	const runner = new AgentRunner(store, bus, flask);

	const port = parseInt(process.env.AI_SIDECAR_PORT || "", 10) || 8055;
	const host = "127.0.0.1";
	const server = new SidecarServer({ host, port, store, bus, flask, runner });
	await server.start();
	console.log(`[sidecar] listening on http://${host}:${port}`);
}

main().catch((err) => {
	console.error("[sidecar] fatal:", err);
	process.exit(1);
});
