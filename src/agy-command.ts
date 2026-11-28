// /agy slash command, argument completions, status/settings output, and interactive picker.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { AcpDriver } from "./acp/driver.js";
import {
	agyAuthenticationMessage,
	agyMissingMessage,
	isAgyInstalled,
} from "./agy-install.js";
import { agyConversationDir, resolveAgyBinary } from "./agy-paths.js";
import {
	agyVersionVerdict,
	checkAgyCliVersion,
	describeAgyVersionCheck,
	MIN_AGY_ACP_VERSION,
} from "./agy-version.js";
import { artifactOpenCommand, listAgyArtifacts } from "./artifacts.js";
import { showArtifactsBrowser } from "./artifacts-ui.js";
import {
	configPath,
	loadConfig,
	logsDir,
	MAX_TURN_CAP_MIN,
	parseCapMinutes,
	saveConfig,
	type AgyConfig,
	type AgyMode,
	type BridgeTools,
	type PermissionMode,
	type ToolMode,
	type UsageEstimate,
} from "./config.js";
import type { DailyLogger } from "./daily-log.js";
import type { AgyModelEntry } from "./models.js";
import type { SessionStore } from "./sessions.js";
import { formatSubagentRoster, type SubagentRoster } from "./subagent-roster.js";
import { listAgyTasks, tailAgyTaskLog } from "./tasks.js";
import { showTasksBrowser } from "./tasks-ui.js";
import { showSettingsDialog } from "./ui-helpers.js";
import { fetchAgyQuota, formatAgyQuotaReport } from "./usage.js";

export interface AgyCommandCtx {
	entries: AgyModelEntry[];
	store: SessionStore;
	usingFallback: boolean;
	acpDriver: AcpDriver;
	getMcpPort: () => number | null;
	ensureMcpServer?: () => Promise<number | null>;
	syncBridgeCatalog?: (reason: string) => Promise<void>;
	getActiveSessionKey?: () => string | undefined;
	onSessionContext?: (ctx: ExtensionContext) => void;
	bridgeTools: () => Array<{ name: string }>;
	hiddenBridgeTools: Set<string>;
	fileLog: DailyLogger;
	roster: SubagentRoster;
	setActiveUi?: (ui: ExtensionUIContext) => void;
	checkAgySetup: (
		ctx: { ui: ExtensionUIContext; mode: string },
		explicit?: boolean,
	) => Promise<void>;
}

function settingsRows(): string[] {
	const config = loadConfig();
	const perm = config.skipPermissions
		? "auto-approved"
		: `prompt (${config.permissionMode})`;
	const row = (label: string, value: string) => `  ${label.padEnd(20)} ${value}`;
	return [
		row("mode:", config.mode),
		row("readOnly:", config.readOnly ? "on (provider turns refused)" : "off"),
		row("permissions:", perm),
		row("bridge tools:", config.bridgeTools),
		row("tool mode:", config.toolMode),
		row("usage estimate:", config.acp.usageEstimate),
		row("digest:", config.digest ? "on" : "off"),
		row("system prompt:", config.systemPrompt ? "on" : "off"),
		row("turn cap:", config.turnTimeoutMin === 0 ? "off" : `${config.turnTimeoutMin}m`),
		row(
			"inactivity cap:",
			config.inactivityTimeoutMin === 0 ? "off" : `${config.inactivityTimeoutMin}m`,
		),
	];
}

function statusText(ctx: AgyCommandCtx, cmdCtx?: ExtensionCommandContext): string {
	const source = ctx.usingFallback ? "fallback (agy models failed)" : "discovered";
	const key = cmdCtx ? currentSessionKey(cmdCtx) : ctx.getActiveSessionKey?.();
	const boundConversation = (key ? ctx.store.get(key)?.conversationId : undefined) ?? "(none)";
	const subcommands = [
		"/agy doctor",
		"/agy auth",
		"/agy auth-manual",
		"/agy mode accept-edits",
		"/agy readonly on|off",
		"/agy permissions on|off",
		"/agy permission-mode ask|allow|deny",
		"/agy bridge all|mcp|none",
		"/agy tool-mode hybrid|pi-only",
		"/agy tools [hide|show <name>|reset]",
		"/agy usage estimate|direct|off",
		"/agy digest on|off",
		"/agy system-prompt on|off",
		"/agy timeout <1-1440|off>",
		"/agy quota",
		"/agy subagents",
		"/agy artifacts [open <n|name>]",
		"/agy tasks [tail <id>]",
		"/agy clear [all]",
	].join(", ");
	return [
		"Antigravity bridge (agy acp)",
		`  models:              ${ctx.entries.length} ${source}`,
		...settingsRows(),
		`  bound conversation:  ${boundConversation}`,
		`  sessions:            ${ctx.store.size} bound`,
		`  config:              ${configPath()}`,
		"",
		`Subcommands: ${subcommands}`,
	].join("\n");
}

export function currentSessionKey(cmdCtx: {
	cwd?: string;
	sessionManager?: { getSessionId?: () => string; getCwd?: () => string };
}): string {
	const sessionId = cmdCtx.sessionManager?.getSessionId?.();
	if (sessionId && sessionId.length > 0) return `sid:${sessionId}@acp`;
	return `cwd:${cmdCtx.cwd ?? cmdCtx.sessionManager?.getCwd?.() ?? process.cwd()}@acp`;
}

function resolveConversationId(
	ctx: AgyCommandCtx,
	cmdCtx: ExtensionCommandContext,
): string | undefined {
	const currentKey = currentSessionKey(cmdCtx);
	return (
		ctx.store.get(currentKey)?.conversationId ??
		ctx.acpDriver.snapshot().conversationId ??
		undefined
	);
}

interface AgyCompletionItem {
	value: string;
	label: string;
	description?: string;
}

const AGY_SUBCOMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "doctor", description: "Inspect CLI, session, driver, and MCP bridge status" },
	{ name: "auth", description: "Show Antigravity sign-in instructions" },
	{ name: "auth-manual", description: "Show CLI install and manual sign-in instructions" },
	{ name: "mode", description: "Show or set provider mode (accept-edits)" },
	{ name: "readonly", description: "Toggle read-only kill switch (on|off)" },
	{ name: "permissions", description: "Toggle ACP permission auto-approval (on|off)" },
	{ name: "permission-mode", description: "Set ACP permission fallback (ask|allow|deny)" },
	{ name: "bridge", description: "Set bridged Pi tool scope (all|mcp|none)" },
	{ name: "tool-mode", description: "Set tool execution mode (hybrid|pi-only)" },
	{ name: "tools", description: "Inspect, hide, show, or reset bridged Pi tools" },
	{ name: "usage", description: "Set token usage estimate mode (estimate|direct|off)" },
	{ name: "digest", description: "Toggle Pi context digest injection (on|off)" },
	{ name: "system-prompt", description: "Toggle fresh-session system prompt injection (on|off)" },
	{ name: "timeout", description: "Set per-turn timeout cap in minutes or off" },
	{ name: "quota", description: "Check Antigravity model quota" },
	{ name: "subagents", description: "List tracked Antigravity subagents" },
	{ name: "artifacts", description: "Browse or open bound conversation artifacts" },
	{ name: "tasks", description: "Browse or tail bound conversation background tasks" },
	{ name: "clear", description: "Clear session binding (/agy clear [all])" },
];

const AGY_SUBCOMMAND_ARGS: Readonly<Record<string, readonly string[]>> = {
	clear: ["all"],
	mode: ["accept-edits"],
	readonly: ["on", "off"],
	permissions: ["on", "off"],
	"permission-mode": ["ask", "allow", "deny"],
	bridge: ["all", "mcp", "none"],
	"tool-mode": ["hybrid", "pi-only"],
	usage: ["estimate", "direct", "off"],
	digest: ["on", "off"],
	"system-prompt": ["on", "off"],
	tools: ["reset", "hide", "show"],
	tasks: ["tail"],
	artifacts: ["open"],
};

function listConversationTaskIds(conversationDir: string): string[] {
	try {
		const entries = fs.readdirSync(path.join(conversationDir, ".system_generated", "tasks"), {
			withFileTypes: true,
		});
		const ids = new Set<number>();
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = /^task-(\d+)\.log$/.exec(entry.name);
			if (!match) continue;
			const id = Number(match[1]);
			if (Number.isInteger(id) && id >= 0) ids.add(id);
		}
		return [...ids].sort((a, b) => a - b).map(String);
	} catch {
		return [];
	}
}

function listConversationArtifactNames(conversationDir: string): string[] {
	const roots = [
		conversationDir,
		path.join(conversationDir, ".tempmediaStorage"),
		path.join(conversationDir, ".user_uploaded"),
	];
	const names = new Set<string>();
	for (const dir of roots) {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				if (entry.name.startsWith(".") || entry.name.endsWith(".metadata.json")) continue;
				names.add(entry.name);
			}
		} catch {
			continue;
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

function getAgyArgumentCompletions(
	argumentPrefix: string,
	getAllTools: () => ReadonlyArray<{ name: string; description?: string }>,
	getActiveConversationDir?: () => string | undefined,
): AgyCompletionItem[] | null {
	const trimmedStart = argumentPrefix.trimStart();
	if (trimmedStart === "") {
		return AGY_SUBCOMMANDS.map((sub) => ({
			value: sub.name,
			label: sub.name,
			description: sub.description,
		}));
	}

	const hasTrailingSpace = /\s$/.test(trimmedStart);
	const parts = trimmedStart.trimEnd().split(/\s+/);

	if (parts.length === 1 && !hasTrailingSpace) {
		const subPrefix = parts[0].toLowerCase();
		const matches = AGY_SUBCOMMANDS.filter((sub) => sub.name.startsWith(subPrefix));
		return matches.length > 0
			? matches.map((sub) => ({
					value: sub.name,
					label: sub.name,
					description: sub.description,
				}))
			: null;
	}

	const sub = parts[0].toLowerCase();

	if ((parts.length === 1 && hasTrailingSpace) || (parts.length === 2 && !hasTrailingSpace)) {
		const argPrefix = parts.length === 2 ? parts[1].toLowerCase() : "";
		const candidates = AGY_SUBCOMMAND_ARGS[sub];
		if (!candidates) return null;
		const matches = candidates.filter((arg) => arg.startsWith(argPrefix));
		return matches.length > 0
			? matches.map((arg) => ({
					value: `${sub} ${arg}`,
					label: arg,
				}))
			: null;
	}

	if (sub === "tools") {
		const action = parts[1].toLowerCase();
		if (
			(action === "hide" || action === "show") &&
			((parts.length === 2 && hasTrailingSpace) || (parts.length === 3 && !hasTrailingSpace))
		) {
			const toolPrefix = parts.length === 3 ? parts[2].toLowerCase() : "";
			const seen = new Set<string>();
			const matches: AgyCompletionItem[] = [];
			for (const tool of getAllTools()) {
				if (!tool?.name || seen.has(tool.name)) continue;
				if (!tool.name.toLowerCase().startsWith(toolPrefix)) continue;
				seen.add(tool.name);
				matches.push({
					value: `tools ${action} ${tool.name}`,
					label: tool.name,
					...(tool.description ? { description: tool.description } : {}),
				});
			}
			return matches.length > 0 ? matches : null;
		}
	}

	if (sub === "tasks" && parts[1]?.toLowerCase() === "tail") {
		if ((parts.length === 2 && hasTrailingSpace) || (parts.length === 3 && !hasTrailingSpace)) {
			const dir = getActiveConversationDir?.();
			if (!dir) return null;
			const idPrefix = parts.length === 3 ? parts[2].toLowerCase() : "";
			const matches = listConversationTaskIds(dir)
				.filter((id) => id.startsWith(idPrefix))
				.map((id) => ({
					value: `tasks tail ${id}`,
					label: id,
				}));
			return matches.length > 0 ? matches : null;
		}
	}

	if (sub === "artifacts") {
		const openMatch = /^artifacts\s+open\s+(.*)$/i.exec(trimmedStart);
		if (openMatch) {
			const dir = getActiveConversationDir?.();
			if (!dir) return null;
			const namePrefix = openMatch[1].toLowerCase();
			const matches = listConversationArtifactNames(dir)
				.filter((name) => name.toLowerCase().startsWith(namePrefix))
				.map((name) => ({
					value: `artifacts open ${name}`,
					label: name,
				}));
			return matches.length > 0 ? matches : null;
		}
	}

	return null;
}

async function notifyTaskTail(
	ui: ExtensionUIContext | undefined,
	task: { id: number; logPath: string },
): Promise<void> {
	const tail = await tailAgyTaskLog(task.logPath);
	if (tail === "") {
		ui?.notify(`task #${task.id} has no readable log.`, "warning");
		return;
	}
	const lines = tail.split("\n");
	const body = lines.length > 40 ? `...\n${lines.slice(-40).join("\n")}` : tail;
	ui?.notify(`task #${task.id} tail:\n${body}`, "info");
}

export function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	let lastCommandSessionKey: string | undefined;
	const activeConversationDir = (): string | undefined => {
		const key = ctx.getActiveSessionKey ? ctx.getActiveSessionKey() : lastCommandSessionKey;
		const conversationId =
			(key ? ctx.store.get(key)?.conversationId : undefined) ??
			ctx.acpDriver.snapshot().conversationId ??
			undefined;
		return conversationId ? agyConversationDir(conversationId) : undefined;
	};
	pi.registerCommand("agy", {
		description:
			"Antigravity ACP provider: settings picker, doctor, session/task/artifact inspection. Usage: /agy [doctor|auth|auth-manual|mode|readonly|permissions|permission-mode|bridge|tool-mode|tools|usage|digest|system-prompt|timeout|quota|subagents|artifacts|tasks|clear]",
		getArgumentCompletions: (argumentPrefix: string) =>
			getAgyArgumentCompletions(argumentPrefix, () => pi.getAllTools(), activeConversationDir),
		handler: async (args, cmdCtx: ExtensionCommandContext) => {
			const ui = cmdCtx.ui;
			if (ui) ctx.setActiveUi?.(ui);
			lastCommandSessionKey = currentSessionKey(cmdCtx);
			ctx.onSessionContext?.(cmdCtx);
			const mode = cmdCtx.mode;
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();
			const val = parts[1]?.toLowerCase();
			ctx.fileLog.log("agy-command", { args }, "info");

			if (sub === "clear") {
				if (val === "all" || val === "--all") {
					if (parts.length > 2) {
						ui?.notify("usage: /agy clear [all]", "warning");
						return;
					}
					ctx.store.clear();
					ui?.notify("Cleared all antigravity session bindings.", "info");
					return;
				}
				if (!val) {
					const currentKey = currentSessionKey(cmdCtx);
					const existing = ctx.store.get(currentKey);
					ctx.store.delete(currentKey);
					ui?.notify(
						existing
							? "Cleared Antigravity session binding for this Pi session. Use /agy clear all to clear every session."
							: "No Antigravity session bound for this Pi session. Use /agy clear all to clear every session.",
						"info",
					);
					return;
				}
				ui?.notify("usage: /agy clear [all]", "warning");
				return;
			}
			if (sub === "auth") {
				ui?.notify(agyAuthenticationMessage(), "info");
				return;
			}
			if (sub === "auth-manual") {
				ui?.notify(
					[
						"Antigravity turns run `agy acp` using your CLI Google sign-in.",
						"",
						"Install on Linux or macOS:",
						"  curl -fsSL https://antigravity.google/cli/install.sh | bash",
						"Install on Windows PowerShell:",
						"  irm https://antigravity.google/cli/install.ps1 | iex",
						"",
						agyAuthenticationMessage(),
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "timeout") {
				const live = loadConfig();
				const cur = live.turnTimeoutMin;
				if (!val) {
					ui?.notify(
						`Turn time cap: ${cur === 0 ? "off (no cap)" : `${cur}m`}. Usage: /agy timeout <1-${MAX_TURN_CAP_MIN}|off>.`,
						"info",
					);
					return;
				}
				const parsed = val === "off" ? 0 : parseCapMinutes(val, Number.NaN);
				if (Number.isNaN(parsed)) {
					ui?.notify(
						`Invalid turn cap "${val}". Use 1-${MAX_TURN_CAP_MIN} minutes, or off/0 to disable.`,
						"error",
					);
					return;
				}
				saveConfig({ turnTimeoutMin: parsed });
				ui?.notify(
					parsed === 0
						? `Turn time cap disabled. Inactivity stall guard (${live.inactivityTimeoutMin}m) still applies.`
						: `Turn time cap set to ${parsed}m. Takes effect next turn.`,
					"info",
				);
				return;
			}
			if (sub === "doctor") {
				const config = loadConfig();
				const snap = ctx.acpDriver.snapshot();
				const port = ctx.getMcpPort();
				const rawCliCheck = await checkAgyCliVersion(resolveAgyBinary());
				const cliCheck =
					rawCliCheck.status === "ok" || rawCliCheck.status === "unsupported"
						? agyVersionVerdict(rawCliCheck.raw, MIN_AGY_ACP_VERSION)
						: rawCliCheck;
				const boundConversation =
					ctx.store.get(currentSessionKey(cmdCtx))?.conversationId ?? "(none)";
				const driverLine = [
					snap.state,
					snap.pid ? `pid=${snap.pid}` : "",
					snap.conversationId ? `session=${snap.conversationId.slice(0, 8)}` : "",
				]
					.filter(Boolean)
					.join(" ");
				const s = snap.stats;
				const statsLine = `spawns=${s.spawns} turns=${s.turns} recycles=${s.recycles}`;
				const lines = [
					"Antigravity doctor (no tokens spent)",
					"  transport:           agy acp (isolated MCP home)",
					`  bridge:              ${config.bridgeTools}${port ? ` (port ${port})` : " (not running)"}`,
					`  tool mode:           ${config.toolMode}`,
					`  driver:              ${driverLine}`,
					`  driver stats:        ${statsLine}`,
					`  bound conversation:  ${boundConversation}`,
					`  sessions:            ${ctx.store.size} bound`,
					`  models:              ${ctx.entries.length} ${ctx.usingFallback ? "FALLBACK (agy models failed)" : "discovered"}`,
					`  agy cli:             ${describeAgyVersionCheck(cliCheck)} (min ${MIN_AGY_ACP_VERSION})`,
					`  config:              ${configPath()}`,
					`  logs:                ${logsDir()} (set AGY_DEBUG=1 for verbose logs)`,
				];
				if (snap.acp) {
					lines.push(
						`  acp session:         ${snap.acp.sessionId ?? "(none)"}`,
						`  acp server:          ${snap.acp.serverVersion ?? "unknown"}${snap.acp.agentTitle ? ` (${snap.acp.agentTitle})` : ""}`,
						`  acp stats:           prompts=${snap.acp.prompts} created=${snap.acp.sessionsCreated} loaded=${snap.acp.sessionsLoaded} kills=${snap.acp.kills} reconnects=${snap.acp.reconnects}`,
					);
					if (snap.acp.usageSeen) {
						lines.push("  acp tokens:          NATIVE exact usage in PromptResponse");
					} else if (config.acp.usageEstimate !== "off") {
						lines.push(
							`  acp tokens:          ESTIMATED client-side (mode: ${config.acp.usageEstimate})`,
						);
					}
				}
				if (snap.lifecycle.length > 0) {
					lines.push("  lifecycle (last 5):");
					for (const entry of snap.lifecycle.slice(-5)) lines.push(`    ${entry}`);
				}
				lines.push("", "settings:", ...settingsRows());
				ui?.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "mode") {
				if (val === "plan") {
					ui?.notify(
						"Plan mode cannot be enforced on ACP provider turns. Keep /agy mode accept-edits and enforce review-only in the host.",
						"warning",
					);
					return;
				}
				if (val === "accept-edits") {
					const next = saveConfig({ mode: val as AgyMode });
					ui?.notify(`mode set to ${next.mode}`, "info");
				} else {
					ui?.notify(
						`current mode: ${loadConfig().mode}\nusage: /agy mode accept-edits`,
						"info",
					);
				}
				return;
			}
			if (sub === "readonly") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ readOnly: val === "on" });
					ui?.notify(
						next.readOnly
							? "readOnly is on: provider turns are REFUSED until /agy readonly off."
							: "readOnly off: provider turns enabled.",
						"info",
					);
				} else {
					ui?.notify(
						`readOnly is ${loadConfig().readOnly ? "on" : "off"}\nusage: /agy readonly on|off`,
						"info",
					);
				}
				return;
			}
			if (sub === "permissions") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ skipPermissions: val === "on" });
					ui?.notify(
						`permissions: ${next.skipPermissions ? "auto-approved" : `prompt (${next.permissionMode})`}`,
						"info",
					);
				} else {
					ui?.notify(
						`permissions: ${loadConfig().skipPermissions ? "auto-approved" : "prompt"}\nusage: /agy permissions on|off`,
						"info",
					);
				}
				return;
			}
			if (sub === "permission-mode") {
				if (val === "ask" || val === "allow" || val === "deny") {
					const next = saveConfig({ permissionMode: val as PermissionMode });
					ui?.notify(`permission-mode set to ${next.permissionMode}`, "info");
				} else {
					ui?.notify(
						`permission-mode: ${loadConfig().permissionMode}\nusage: /agy permission-mode ask|allow|deny`,
						"info",
					);
				}
				return;
			}
			if (sub === "bridge") {
				if (val === "all" || val === "mcp" || val === "none") {
					const next = saveConfig({ bridgeTools: val });
					let port = ctx.getMcpPort();
					if ((val === "all" || val === "mcp") && port === null && ctx.ensureMcpServer) {
						port = await ctx.ensureMcpServer();
					}
					await ctx.syncBridgeCatalog?.(`/agy bridge ${val}`);
					if ((val === "all" || val === "mcp") && port === null) {
						ui?.notify(
							`bridge set to ${next.bridgeTools}, but the MCP bridge server failed to start.`,
							"warning",
						);
					} else {
						ui?.notify(
							`bridge set to ${next.bridgeTools}. Active catalog and call guard updated.`,
							"info",
						);
					}
				} else {
					ui?.notify(
						`bridge: ${loadConfig().bridgeTools}\nusage: /agy bridge all|mcp|none`,
						"info",
					);
				}
				return;
			}
			if (sub === "tool-mode") {
				if (val === "hybrid" || val === "pi-only") {
					const next = saveConfig({ toolMode: val });
					if (
						val === "pi-only" &&
						next.bridgeTools !== "none" &&
						ctx.getMcpPort() === null &&
						ctx.ensureMcpServer
					) {
						await ctx.ensureMcpServer();
					}
					await ctx.syncBridgeCatalog?.(`/agy tool-mode ${val}`);
					ui?.notify(
						next.toolMode === "pi-only"
							? "tool-mode set to pi-only. Next turn will start a fresh seeded agy session using Pi tools (native read_file kept for images/offloaded outputs)."
							: "tool-mode set to hybrid. Next turn will start a fresh seeded agy session using agy native workspace tools plus Pi MCP bridge.",
						"info",
					);
				} else {
					ui?.notify(
						`tool-mode: ${loadConfig().toolMode}\nusage: /agy tool-mode hybrid|pi-only`,
						"info",
					);
				}
				return;
			}
			if (sub === "usage") {
				if (val === "estimate" || val === "direct" || val === "off") {
					const next = saveConfig({ acp: { usageEstimate: val as UsageEstimate } });
					ui?.notify(`usage estimate set to ${next.acp.usageEstimate}`, "info");
				} else {
					ui?.notify(
						`usage estimate: ${loadConfig().acp.usageEstimate}\nusage: /agy usage estimate|direct|off`,
						"info",
					);
				}
				return;
			}
			if (sub === "tools") {
				const name = parts.slice(2).join(" ");
				if (val === "reset") {
					ctx.hiddenBridgeTools.clear();
					await ctx.syncBridgeCatalog?.("/agy tools reset");
					ui?.notify("Tool visibility reset for this Pi session.", "info");
				} else if ((val === "hide" || val === "show") && name) {
					if (!pi.getAllTools().some((tool) => tool.name === name)) {
						ui?.notify(`Unknown Pi tool: ${name}`, "error");
						return;
					}
					if (val === "hide") ctx.hiddenBridgeTools.add(name);
					else ctx.hiddenBridgeTools.delete(name);
					await ctx.syncBridgeCatalog?.(`/agy tools ${val} ${name}`);
					ui?.notify(
						`${name}: ${val === "hide" ? "hidden from Antigravity" : "visible if active in Pi"}.`,
						"info",
					);
				} else {
					ui?.notify(
						`Exposed active Pi tools: ${ctx.bridgeTools().map((tool) => tool.name).join(", ") || "(none)"}\nHidden in this session: ${[...ctx.hiddenBridgeTools].join(", ") || "(none)"}\nusage: /agy tools hide|show <exact Pi tool name> | reset`,
						"info",
					);
				}
				return;
			}
			if (sub === "digest") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ digest: val === "on" });
					ui?.notify(`digest ${next.digest ? "on" : "off"}`, "info");
				} else {
					ui?.notify(
						`digest: ${loadConfig().digest ? "on" : "off"}\nusage: /agy digest on|off`,
						"info",
					);
				}
				return;
			}
			if (sub === "system-prompt") {
				if (val === "on" || val === "off") {
					const next = saveConfig({ systemPrompt: val === "on" });
					ui?.notify(`system-prompt ${next.systemPrompt ? "on" : "off"}`, "info");
				} else {
					ui?.notify(
						`system-prompt: ${loadConfig().systemPrompt ? "on" : "off"}\nusage: /agy system-prompt on|off`,
						"info",
					);
				}
				return;
			}
			if (sub === "quota") {
				const bin = resolveAgyBinary();
				if (!isAgyInstalled(bin)) {
					ui?.notify(`agy CLI is not installed. ${agyMissingMessage()}`, "warning");
					return;
				}
				ui?.setStatus("agy-quota", "checking agy quota...");
				try {
					const report = await fetchAgyQuota(bin);
					if (report === undefined) {
						ui?.notify("quota unavailable: agy did not return a /usage payload.", "warning");
						return;
					}
					ui?.notify(formatAgyQuotaReport(report), "info");
				} finally {
					ui?.setStatus("agy-quota", undefined);
				}
				return;
			}
			if (sub === "subagents") {
				const list = ctx.roster.snapshot();
				if (list.length === 0) {
					ui?.notify("antigravity subagents: none tracked this session.", "info");
					return;
				}
				ui?.notify(formatSubagentRoster(list), "info");
				return;
			}
			if (sub === "tasks") {
				const conversationId = resolveConversationId(ctx, cmdCtx);
				if (!conversationId) {
					ui?.notify("no Antigravity conversation bound yet; run a turn first.", "warning");
					return;
				}
				const dir = agyConversationDir(conversationId);
				if (val === "tail") {
					const id = Number(parts[2]);
					if (!Number.isInteger(id) || id < 0) {
						ui?.notify("usage: /agy tasks tail <id>", "warning");
						return;
					}
					const tasks = await listAgyTasks(dir);
					const task = tasks.find((t) => t.id === id);
					if (!task) {
						ui?.notify(`no task #${id} in this conversation.`, "warning");
						return;
					}
					await notifyTaskTail(ui, task);
					return;
				}
				let tasks = await listAgyTasks(dir);
				if (tasks.length === 0) {
					ui?.notify("no background tasks recorded for this conversation.", "info");
					return;
				}
				if (!ui) {
					const lines = tasks.map((t) => {
						const state = t.livenessKnown ? (t.active ? "ACTIVE" : "idle") : "liveness?";
						return `#${t.id}  ${state}  ${t.bytes}B`;
					});
					console.log([`antigravity tasks (${tasks.length}):`, ...lines].join("\n"));
					return;
				}
				for (;;) {
					const action = await showTasksBrowser(ui, tasks, tasks[0]?.livenessKnown ?? false);
					if (action.type === "rescan") {
						tasks = await listAgyTasks(dir);
						if (tasks.length === 0) {
							ui?.notify("no background tasks recorded for this conversation.", "info");
							break;
						}
						continue;
					}
					if (action.type === "tail") {
						await notifyTaskTail(ui, action.task);
					}
					break;
				}
				return;
			}
			if (sub === "artifacts") {
				const conversationId = resolveConversationId(ctx, cmdCtx);
				if (!conversationId) {
					ui?.notify("no Antigravity conversation bound yet; run a turn first.", "warning");
					return;
				}
				const dir = agyConversationDir(conversationId);
				if (val === "open") {
					const artifacts = await listAgyArtifacts(dir);
					if (artifacts.length === 0) {
						ui?.notify("no artifacts in this conversation.", "info");
						return;
					}
					const target = parts.slice(2).join(" ").trim();
					if (target === "") {
						ui?.notify("usage: /agy artifacts open <name|index>", "warning");
						return;
					}
					const byIndex = /^\d+$/.test(target) ? Number(target) : undefined;
					const artifact =
						byIndex !== undefined
							? artifacts[byIndex]
							: (artifacts.find((a) => a.name.toLowerCase() === target.toLowerCase()) ??
								(artifacts.filter((a) => a.name.toLowerCase().includes(target.toLowerCase()))
									.length === 1
									? artifacts.find((a) => a.name.toLowerCase().includes(target.toLowerCase()))
									: undefined));
					if (!artifact) {
						ui?.notify(`no unique artifact matches ${JSON.stringify(target)}.`, "warning");
						return;
					}
					const openCmd = artifactOpenCommand();
					if (!openCmd) {
						ui?.notify(
							`no file-open handler for ${process.platform}; path: ${artifact.absolutePath}`,
							"warning",
						);
						return;
					}
					spawn(openCmd.cmd, [artifact.absolutePath], {
						detached: true,
						stdio: "ignore",
						shell: false,
					}).unref();
					ui?.notify(`opened ${artifact.name}`, "info");
					return;
				}
				let artifacts = await listAgyArtifacts(dir);
				if (artifacts.length === 0) {
					ui?.notify("no artifacts in this conversation.", "info");
					return;
				}
				if (!ui) {
					const lines = artifacts.map((a, i) => `${i}  ${a.name} (${a.kind}, ${a.bytes}B)`);
					console.log([`antigravity artifacts (${artifacts.length}):`, ...lines].join("\n"));
					return;
				}
				for (;;) {
					const action = await showArtifactsBrowser(ui, artifacts);
					if (action.type === "rescan") {
						artifacts = await listAgyArtifacts(dir);
						continue;
					}
					if (action.type === "open") {
						const openCmd = artifactOpenCommand();
						if (!openCmd) {
							ui.notify(`no file-open handler for ${process.platform}.`, "warning");
							continue;
						}
						spawn(openCmd.cmd, [action.artifact.absolutePath], {
							detached: true,
							stdio: "ignore",
							shell: false,
						}).unref();
					}
					break;
				}
				return;
			}

			if (sub) {
				ui?.notify(`unknown subcommand: ${sub}\n${statusText(ctx, cmdCtx)}`, "warning");
				return;
			}

			if (mode !== "tui" || !ui) {
				ui?.notify(statusText(ctx, cmdCtx), "info");
				return;
			}

			await openAgyPicker(ui, ctx);
		},
	});
}

async function openAgyPicker(ui: ExtensionUIContext, ctx?: AgyCommandCtx): Promise<void> {
	const config = loadConfig();
	const pending: Partial<AgyConfig> = {};

	const items: SettingItem[] = [
		{
			id: "readonly",
			label: "Read-only kill switch",
			description: "Refuse provider turns when set to on.",
			currentValue: config.readOnly ? "on" : "off",
			values: ["off", "on"],
		},
		{
			id: "permissions",
			label: "Auto-approve permissions",
			description: "Auto-approve ACP tool permission requests (default on).",
			currentValue: config.skipPermissions ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "permission-mode",
			label: "Permission fallback",
			description: "Policy for ACP permission prompts when auto-approve is off.",
			currentValue: config.permissionMode,
			values: ["ask", "allow", "deny"],
		},
		{
			id: "bridge",
			label: "Bridge tools",
			description:
				"Which active Pi tools are bridged over MCP: all (default), mcp (MCP + codemode + skills), or none.",
			currentValue: config.bridgeTools,
			values: ["all", "mcp", "none"],
		},
		{
			id: "tool-mode",
			label: "Tool execution mode",
			description:
				"hybrid (agy native file/shell + Pi MCP, default) or pi-only (disable agy native tools, route all tools through Pi).",
			currentValue: config.toolMode,
			values: ["hybrid", "pi-only"],
		},
		{
			id: "usage",
			label: "Token usage estimate",
			description: "Client-side token estimate mode until ACP emits native usage.",
			currentValue: config.acp.usageEstimate,
			values: ["estimate", "direct", "off"],
		},
		{
			id: "turn-cap",
			label: "Turn time cap (min)",
			description: "Maximum minutes for one turn (0 disables).",
			currentValue: String(config.turnTimeoutMin),
			values: ["0", "5", "10", "15", "30", "60", "120", "360", "720", "1440"],
		},
		{
			id: "inactivity-cap",
			label: "Inactivity stall cap (min)",
			description: "Silence cap when no tool is running (0 disables).",
			currentValue: String(config.inactivityTimeoutMin),
			values: ["0", "5", "10", "15", "30", "60"],
		},
		{
			id: "digest",
			label: "Context digest",
			description: "Inject non-Antigravity Pi context delta each turn (defeats server cache).",
			currentValue: config.digest ? "on" : "off",
			values: ["off", "on"],
		},
		{
			id: "system-prompt",
			label: "System prompt",
			description: "Prepend Pi's system prompt and AGENTS.md files on fresh conversations.",
			currentValue: config.systemPrompt ? "on" : "off",
			values: ["on", "off"],
		},
	];

	await showSettingsDialog(ui, {
		title: "Antigravity ACP provider",
		subtitle: `${configPath()} - Esc saves and closes`,
		items,
		onChange: (id, newValue) => {
			if (id === "readonly") pending.readOnly = newValue === "on";
			else if (id === "permissions") pending.skipPermissions = newValue === "on";
			else if (id === "permission-mode") pending.permissionMode = newValue as PermissionMode;
			else if (id === "bridge") pending.bridgeTools = newValue as BridgeTools;
			else if (id === "tool-mode") pending.toolMode = newValue as ToolMode;
			else if (id === "usage") pending.acp = { usageEstimate: newValue as UsageEstimate };
			else if (id === "turn-cap") pending.turnTimeoutMin = Number(newValue);
			else if (id === "inactivity-cap") pending.inactivityTimeoutMin = Number(newValue);
			else if (id === "digest") pending.digest = newValue === "on";
			else if (id === "system-prompt") pending.systemPrompt = newValue === "on";
		},
	});

	if (Object.keys(pending).length === 0) return;

	try {
		const next = saveConfig(pending);
		if (
			(next.bridgeTools === "all" || next.bridgeTools === "mcp") &&
			ctx &&
			ctx.getMcpPort() === null &&
			ctx.ensureMcpServer
		) {
			await ctx.ensureMcpServer();
		}
		if (pending.bridgeTools !== undefined || pending.toolMode !== undefined) {
			await ctx?.syncBridgeCatalog?.(
				`/agy picker ${[
					pending.bridgeTools !== undefined ? `bridge=${next.bridgeTools}` : null,
					pending.toolMode !== undefined ? `toolMode=${next.toolMode}` : null,
				]
					.filter(Boolean)
					.join(" ")}`,
			);
		}
		const changed = [
			pending.readOnly !== undefined ? `readOnly=${next.readOnly ? "on" : "off"}` : null,
			pending.skipPermissions !== undefined
				? `permissions=${next.skipPermissions ? "on" : "off"}`
				: null,
			pending.permissionMode !== undefined ? `permission-mode=${next.permissionMode}` : null,
			pending.bridgeTools !== undefined ? `bridge=${next.bridgeTools}` : null,
			pending.toolMode !== undefined ? `tool-mode=${next.toolMode}` : null,
			pending.acp !== undefined ? `usage=${next.acp.usageEstimate}` : null,
			pending.turnTimeoutMin !== undefined
				? `turn-cap=${next.turnTimeoutMin === 0 ? "off" : `${next.turnTimeoutMin}m`}`
				: null,
			pending.inactivityTimeoutMin !== undefined
				? `inactivity-cap=${next.inactivityTimeoutMin === 0 ? "off" : `${next.inactivityTimeoutMin}m`}`
				: null,
			pending.digest !== undefined ? `digest=${next.digest ? "on" : "off"}` : null,
			pending.systemPrompt !== undefined
				? `system-prompt=${next.systemPrompt ? "on" : "off"}`
				: null,
		]
			.filter(Boolean)
			.join(", ");
		ui.notify(`Saved: ${changed}`, "info");
	} catch (err) {
		ui.notify(`Failed to save config: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

