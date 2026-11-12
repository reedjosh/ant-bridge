// Antigravity and bridge state directory paths.
//
// Antigravity keeps per-conversation state in ~/.gemini/antigravity-cli/brain/<conversationId>/
// (.system_generated/tasks/, .system_generated/logs/, media/, etc.), which `stageAcpHome` links
// into each isolated ACP home so conversations, tasks, and artifacts persist across restarts.
// Bridge-owned state (config.json, sessions.json, models-cache.json, logs/, acp-homes/) lives
// under <PI_CODING_AGENT_DIR>/antigravity-bridge (default ~/.pi/agent/antigravity-bridge).

import os from "node:os";
import path from "node:path";

/** Root directory for bridge-owned config, session map, model cache, logs, and staged homes. */
export function bridgeStateDir(
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): string {
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent");
	return path.join(agentDir, "antigravity-bridge");
}

/** Brain root for `agy acp` conversations. `home` is injectable for tests. */
export function agyBrainRoot(home: string = os.homedir()): string {
	return path.join(home, ".gemini", "antigravity-cli", "brain");
}

/** Per-conversation state directory matching the raw conversationId persisted in SessionStore. */
export function agyConversationDir(
	conversationId: string,
	home: string = os.homedir(),
): string {
	return path.join(agyBrainRoot(home), conversationId);
}
