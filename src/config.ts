// Runtime config for the Antigravity ACP provider. Persisted at
// <PI_CODING_AGENT_DIR>/antigravity-bridge/config.json (default
// ~/.pi/agent/antigravity-bridge/config.json) so /agy toggles survive restarts.

import fs from "node:fs";
import path from "node:path";
import { bridgeStateDir } from "./agy-paths.js";

export function configPath(): string {
	return path.join(bridgeStateDir(), "config.json");
}

export const CONFIG_PATH = configPath();

/** Daily NDJSON debug logs land under <bridgeStateDir>/logs/<YYYY-MM-DD>.ndjson. */
export function logsDir(): string {
	return path.join(bridgeStateDir(), "logs");
}

export type AgyMode = "accept-edits" | "plan";
export type BridgeTools = "none" | "mcp" | "all";
export type UsageEstimate = "estimate" | "direct" | "off";
export type PermissionMode = "ask" | "allow" | "deny";

export interface AcpConfig {
	/** Client-side token estimate mode while `agy acp` omits exact token usage. */
	usageEstimate: UsageEstimate;
}

export interface AgyConfig {
	acp: AcpConfig;
	mode: AgyMode;
	/** Fail-closed kill switch for provider turns when the caller requires zero writes. */
	readOnly: boolean;
	/** Auto-approve ACP permission requests (default true so non-interactive runs do not stall). */
	skipPermissions: boolean;
	/** Policy for ACP `session/request_permission` when `skipPermissions` is false. */
	permissionMode: PermissionMode;
	/** Which Pi tools the MCP bridge exposes to `agy acp`: "all" (default), "mcp", or "none". */
	bridgeTools: BridgeTools;
	/** Extra Pi tool names that get the 120s synchronous window before STILL RUNNING escalation. */
	escalateLongTools: string[];
	/** Inject a delta digest of non-Antigravity Pi context into each prompt (default false). */
	digest: boolean;
	/** Prepend Pi's composed system prompt (including AGENTS.md files) on fresh conversations. */
	systemPrompt: boolean;
	/** Overall cap on one turn in minutes (0 disables; default 0 on TTY, 20 headless). */
	turnTimeoutMin: number;
	/** Silence cap in minutes before a turn fails as a stall (default 5; 0 disables). */
	inactivityTimeoutMin: number;
}

const DEFAULTS: AgyConfig = {
	acp: { usageEstimate: "estimate" },
	mode: "accept-edits",
	readOnly: false,
	skipPermissions: true,
	permissionMode: "ask",
	bridgeTools: "all",
	escalateLongTools: [],
	digest: false,
	systemPrompt: true,
	turnTimeoutMin: 0,
	inactivityTimeoutMin: 5,
};

/** Hard ceiling for a configured turn cap: one day in minutes. */
export const MAX_TURN_CAP_MIN = 1440;

export function defaultTurnTimeoutMin(): number {
	return process.stdout.isTTY || process.stdin.isTTY ? 0 : 20;
}

export function parseCapMinutes(raw: string | number | undefined, fallback: number): number {
	if (raw === undefined || String(raw).trim() === "") return fallback;
	const n = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(n)) return fallback;
	if (n === 0) return 0;
	return n >= 1 && n <= MAX_TURN_CAP_MIN ? n : fallback;
}

type LegacyRawConfig = Partial<AgyConfig> & {
	approvals?: { mode?: unknown };
};

function readConfigFile(filePath: string): LegacyRawConfig {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as LegacyRawConfig;
		}
	} catch {
		// Missing or malformed file falls back to defaults.
	}
	return {};
}

function normalizeLongTools(raw: unknown): string[] {
	const parts: unknown[] =
		typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
	return parts
		.filter((s): s is string => typeof s === "string")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.slice(0, 32);
}

/** Load config merged over defaults. Environment variables override file values when set. */
export function loadConfig(filePath: string = configPath()): AgyConfig {
	const file = readConfigFile(filePath);

	const mode: AgyMode =
		process.env.AGY_MODE !== undefined
			? process.env.AGY_MODE === "plan"
				? "plan"
				: "accept-edits"
			: file.mode === "plan"
				? "plan"
				: "accept-edits";

	const envPerm = process.env.AGY_SKIP_PERMISSIONS;
	const skipPermissions =
		envPerm !== undefined
			? envPerm === "1" || envPerm.toLowerCase() === "true"
			: file.skipPermissions ?? DEFAULTS.skipPermissions;

	const permModeRaw = String(
		process.env.AGY_PERMISSION_MODE ??
			process.env.AGY_APPROVALS_MODE ??
			file.permissionMode ??
			file.approvals?.mode ??
			DEFAULTS.permissionMode,
	).toLowerCase();
	const permissionMode: PermissionMode =
		permModeRaw === "allow" || permModeRaw === "deny" ? permModeRaw : "ask";

	const envReadOnly = process.env.AGY_READONLY;
	const readOnly =
		envReadOnly !== undefined
			? envReadOnly === ""
				? false
				: !["0", "false", "off"].includes(envReadOnly.trim().toLowerCase())
			: file.readOnly ?? DEFAULTS.readOnly;

	const bridgeRaw = String(
		process.env.AGY_BRIDGE_TOOLS ?? file.bridgeTools ?? DEFAULTS.bridgeTools,
	).toLowerCase();
	const bridgeTools: BridgeTools =
		bridgeRaw === "none" || bridgeRaw === "all" || bridgeRaw === "mcp"
			? bridgeRaw
			: DEFAULTS.bridgeTools;

	const escalateLongTools = normalizeLongTools(
		process.env.AGY_ESCALATE_LONG_TOOLS ?? file.escalateLongTools,
	);

	const digest =
		process.env.AGY_DIGEST !== undefined
			? ["1", "true", "on"].includes(process.env.AGY_DIGEST.toLowerCase())
			: file.digest ?? DEFAULTS.digest;

	const envSys = process.env.AGY_SYSTEM_PROMPT;
	const systemPrompt =
		envSys !== undefined
			? ["1", "true", "on"].includes(envSys.toLowerCase())
			: file.systemPrompt ?? DEFAULTS.systemPrompt;

	const turnTimeoutMin = parseCapMinutes(
		process.env.AGY_TURN_TIMEOUT_MIN ?? file.turnTimeoutMin,
		defaultTurnTimeoutMin(),
	);
	const inactivityTimeoutMin = parseCapMinutes(
		process.env.AGY_INACTIVITY_TIMEOUT_MIN ?? file.inactivityTimeoutMin,
		DEFAULTS.inactivityTimeoutMin,
	);

	const fileAcp =
		typeof file.acp === "object" && file.acp !== null ? (file.acp as Partial<AcpConfig>) : {};
	const usageRaw = String(
		process.env.AGY_USAGE_ESTIMATE ?? fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate,
	).toLowerCase();
	const usageEstimate: UsageEstimate =
		usageRaw === "direct" || usageRaw === "off" ? usageRaw : "estimate";

	return {
		acp: { usageEstimate },
		mode,
		readOnly,
		skipPermissions,
		permissionMode,
		bridgeTools,
		escalateLongTools,
		digest,
		systemPrompt,
		turnTimeoutMin,
		inactivityTimeoutMin,
	};
}

function writeConfigJson(filePath: string, value: unknown): void {
	let target = filePath;
	try {
		if (fs.existsSync(filePath)) target = fs.realpathSync(filePath);
	} catch {
		// Keep original path when realpath fails.
	}
	const dir = path.dirname(target);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Nothing to clean.
		}
		throw err;
	}
}

/** Atomically persist a config patch onto raw file values without baking in env overrides. */
export function saveConfig(
	patch: Partial<AgyConfig>,
	filePath: string = configPath(),
): AgyConfig {
	const file = readConfigFile(filePath);
	const fileAcp =
		typeof file.acp === "object" && file.acp !== null ? (file.acp as Partial<AcpConfig>) : {};
	const rawPerm = String(
		patch.permissionMode ?? file.permissionMode ?? file.approvals?.mode ?? DEFAULTS.permissionMode,
	).toLowerCase();
	const next: AgyConfig = {
		acp: {
			usageEstimate:
				patch.acp?.usageEstimate ?? fileAcp.usageEstimate ?? DEFAULTS.acp.usageEstimate,
		},
		mode: (patch.mode ?? file.mode) === "plan" ? "plan" : "accept-edits",
		readOnly: patch.readOnly ?? file.readOnly ?? DEFAULTS.readOnly,
		skipPermissions: patch.skipPermissions ?? file.skipPermissions ?? DEFAULTS.skipPermissions,
		permissionMode: rawPerm === "allow" || rawPerm === "deny" ? rawPerm : "ask",
		bridgeTools: patch.bridgeTools ?? file.bridgeTools ?? DEFAULTS.bridgeTools,
		escalateLongTools: normalizeLongTools(patch.escalateLongTools ?? file.escalateLongTools),
		digest: patch.digest ?? file.digest ?? DEFAULTS.digest,
		systemPrompt: patch.systemPrompt ?? file.systemPrompt ?? DEFAULTS.systemPrompt,
		turnTimeoutMin: parseCapMinutes(
			patch.turnTimeoutMin ?? file.turnTimeoutMin,
			defaultTurnTimeoutMin(),
		),
		inactivityTimeoutMin: parseCapMinutes(
			patch.inactivityTimeoutMin ?? file.inactivityTimeoutMin,
			DEFAULTS.inactivityTimeoutMin,
		),
	};
	writeConfigJson(filePath, next);
	return next;
}
