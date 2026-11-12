// ant-bridge - focused ACP model provider and Pi MCP/skill bridge.

import { spawn } from "node:child_process";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { type SettingItem, Text } from "@earendil-works/pi-tui";
import { AcpDriver } from "../src/acp/driver.js";
import { sweepStaleAcpHomes } from "../src/acp/home.js";
import {
	agyAuthenticationMessage,
	agyMissingMessage,
	isAgyInstalled,
} from "../src/agy-install.js";
import { agyConversationDir } from "../src/agy-paths.js";
import { createAgySetupOffer } from "../src/agy-setup.js";
import {
	agyVersionVerdict,
	checkAgyCliVersion,
	describeAgyVersionCheck,
	MIN_AGY_ACP_VERSION,
} from "../src/agy-version.js";
import { artifactOpenCommand, listAgyArtifacts } from "../src/artifacts.js";
import { showArtifactsBrowser } from "../src/artifacts-ui.js";
import {
	armBackgroundWatch,
	partitionRearmPlans,
	type BackgroundWatchEntry,
	type BackgroundWatchHandle,
} from "../src/background-watch.js";
import { bridgedPiTools } from "../src/bridge-catalog.js";
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
	type UsageEstimate,
} from "../src/config.js";
import { createDailyLogger, type DailyLogger } from "../src/daily-log.js";
import { withDialogLock } from "../src/dialog-lock.js";
import type { TurnOutcome } from "../src/driver-types.js";
import { startMcpServer, TOKEN_HEADER, type McpServerHandle } from "../src/mcp-server.js";
import {
	entriesFromRaw,
	FALLBACK_MODELS,
	loadModelCatalogRaw,
	toPiModel,
	type AgyModelEntry,
} from "../src/models.js";
import { PollRunFolder, type PollRunData } from "../src/poll-fold.js";
import {
	createStreamSimple,
	defaultEscalateAfterMs,
	formatEscalatedAck,
	formatPollAnswer,
	POLL_TOOL_NAME,
	ToolRoundTrips,
	type NativeDisplayEvent,
} from "../src/provider.js";
import { ensureQueuedMessagesDefaults } from "../src/queued-messages.js";
import { redactText } from "../src/redact.js";
import { SessionStore } from "../src/sessions.js";
import {
	ACTIVATE_SKILL_TOOL_NAME,
	activateSkillSchema,
	catalogSummary,
	findSkillByName,
	readSkillBody,
	scanSkills,
	type SkillLite,
} from "../src/skills.js";
import { formatSubagentRoster, SubagentRoster } from "../src/subagent-roster.js";
import { listAgyTasks, readDeliveredTaskIds, tailAgyTaskLog } from "../src/tasks.js";
import { showTasksBrowser } from "../src/tasks-ui.js";
import { showSettingsDialog } from "../src/ui-helpers.js";
import { fetchAgyQuota, formatAgyQuotaReport } from "../src/usage.js";

let activeUi: ExtensionUIContext | null = null;

function resolveAgyBinary(): string {
	return process.env.AGY_BIN || "agy";
}

export default async function (pi: ExtensionAPI): Promise<void> {
	ensureQueuedMessagesDefaults({ onlyIfDirExists: true });
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-antigravity-bridge:active")] = true;

	const binary = resolveAgyBinary();
	const raw = await loadModelCatalogRaw(binary);
	const discovered = entriesFromRaw(raw);
	const usingFallback = discovered.length === 0;
	const entries: AgyModelEntry[] = usingFallback ? FALLBACK_MODELS : discovered;
	const models = entries.map((e) => toPiModel(e, ["text", "image"]));

	const FAIL_REASON_TURN_END = "antigravity turn ended with an unresolved pi tool call";
	const FAIL_REASON_SHUTDOWN = "antigravity session shut down";

	const fileLog = createDailyLogger({ dir: logsDir() });
	const rawFileLog = fileLog.log.bind(fileLog);
	fileLog.log = (event, data, level) => {
		rawFileLog(event, data, level);
		if (level !== "warn") return;
		if (event.startsWith("abort:") || event === "connection-exited") return;
		const d = (data ?? {}) as Record<string, unknown>;
		let text: string;
		if (event === "round-trip-fail") {
			text = `Bridge tool call failed: ${String(d.name ?? "tool")} (${String(d.reason ?? "unknown")})`;
		} else if (event.startsWith("stall:")) {
			text = "Antigravity stalled with no output; the turn was stopped";
		} else if (event.startsWith("timeout:")) {
			text = "Antigravity turn timed out";
		} else if (event.startsWith("exit:") && event !== "exit:0") {
			text = "Antigravity process exited unexpectedly";
		} else if (event === "turn-error") {
			text = `Antigravity turn issue: ${String(d.reason ?? "unknown")}`;
		} else {
			text = `Antigravity warning: ${event}`;
		}
		if (activeUi) activeUi.notify(text, "warning");
		else console.error(`[ant-bridge] ${text}`);
	};
	fileLog.log(
		"extension-load",
		{ models: models.length, fallback: usingFallback, bridge: loadConfig().bridgeTools },
		"info",
	);

	const store = new SessionStore();
	let mcpHandle: McpServerHandle | null = null;
	const hiddenBridgeTools = new Set<string>();
	const getBridgeTools = () =>
		bridgedPiTools(
			pi.getAllTools(),
			pi.getActiveTools(),
			loadConfig().bridgeTools,
			hiddenBridgeTools,
		);

	let agySetupOffer: (() => Promise<void>) | null = null;
	let agyMissingWarned = false;
	let agyVersionWarned = false;

	const acpFailures = new Set([
		"start-failed",
		"spawn-error",
		"parse-error",
		"write-failed",
		"mode-apply-failed",
		"timeout",
		"stall",
		"auth-required",
		"session-load-failed-creating-fresh",
		"connection-exited",
		"cancel-failed",
		"unsupported-server-request",
	]);
	const acpLog = (msg: string, data?: unknown): void => {
		const expectedExit =
			msg === "connection-exited" &&
			(data as { expected?: boolean } | undefined)?.expected === true;
		const level = expectedExit
			? "debug"
			: acpFailures.has(msg)
				? "warn"
				: msg === "turn-start"
					? "info"
					: "debug";
		fileLog.log(msg, data, level);
	};

	const acpDriver = new AcpDriver({
		bin: binary,
		binArgs: ["acp"],
		isolateHome: true,
		usageEstimate: () => loadConfig().acp.usageEstimate,
		permissionPolicy: () => (loadConfig().permissionMode === "allow" ? "auto" : "deny"),
		onPermissionRequest: async (req) => {
			const ui = activeUi;
			if (loadConfig().permissionMode === "deny" || !ui) return undefined;
			return await withDialogLock(async () => {
				const labels = req.options.map((o) => o.name ?? o.kind ?? o.optionId ?? "?");
				const title = req.toolCall?.title
					? `agy requests: ${req.toolCall.title}`
					: "agy requests permission";
				const picked = await ui.select(title, labels);
				if (picked === undefined) return undefined;
				const idx = labels.indexOf(picked);
				return idx >= 0 ? (req.options[idx]?.optionId ?? undefined) : undefined;
			});
		},
		log: acpLog,
		mcpServers: () => {
			const handle = mcpHandle;
			if (!handle) return [];
			return [
				{
					name: "pi-bridge",
					type: "http",
					url: `http://127.0.0.1:${handle.port}/mcp`,
					headers: [{ name: TOKEN_HEADER, value: handle.token }],
				},
			];
		},
	});

	const roundTrips = new ToolRoundTrips(
		acpDriver,
		(s, d, level) =>
			fileLog.log(s, d, level ?? (s === "round-trip-fail" ? "warn" : "debug")),
		{ escalateAfterMs: (name) => defaultEscalateAfterMs(name, loadConfig().escalateLongTools) },
	);
	const roster = new SubagentRoster();

	pi.registerEntryRenderer<NativeDisplayEvent>(
		"agy-native-event",
		(entry, { expanded }, theme) => {
			const event = entry.data;
			const firstLine = (value: string | undefined): string | undefined =>
				value?.split(/\r?\n/, 1)[0].trim() || undefined;
			const detail = event?.path
				? path.basename(event.path)
				: (firstLine(event?.command) ?? firstLine(event?.output));
			const status =
				event?.status === "failed" ? theme.fg("error", "x") : theme.fg("success", "ok");
			const lines = [
				`${status} ${theme.fg("toolTitle", event?.name ?? "Antigravity")}${detail ? ` ${theme.fg("muted", detail.slice(0, 160))}` : ""}`,
			];
			if (expanded) {
				if (event?.path) lines.push(theme.fg("dim", event.path));
				if (event?.diff) {
					for (const line of event.diff.split("\n")) {
						const color = line.startsWith("+")
							? "toolDiffAdded"
							: line.startsWith("-")
								? "toolDiffRemoved"
								: "toolDiffContext";
						lines.push(theme.fg(color, line));
					}
				}
				if (event?.output && (!event.diff || event.status === "failed")) {
					lines.push(theme.fg("toolOutput", event.output));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	);

	pi.registerEntryRenderer<PollRunData>("agy-poll-run", (entry, { expanded }, theme) => {
		const run = entry.data;
		const count = run?.count ?? 0;
		const label = `Poll ${run?.target ?? "bridge call"} (x${count}${run?.state === "failed" ? ", failed" : ""})`;
		const lines = [`[poll] ${theme.fg("toolTitle", POLL_TOOL_NAME)} ${theme.fg("muted", label)}`];
		if (expanded && run) {
			const time = (iso: string): string => new Date(iso).toLocaleTimeString();
			lines.push(
				theme.fg(
					"dim",
					`${count} ${count === 1 ? "poll" : "polls"}, ${time(run.firstAt)} -> ${time(run.lastAt)}`,
				),
			);
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	let pendingNativeTools = 0;
	const pollRuns = new PollRunFolder();
	const setDimStatus = (key: string, text: string | undefined): void => {
		const ui = activeUi;
		if (!ui) return;
		ui.setStatus(key, text === undefined ? undefined : ui.theme.fg("dim", text));
	};
	const closePollRun = (): void => {
		const settled = pollRuns.flush();
		if (settled) pi.appendEntry<PollRunData>("agy-poll-run", settled);
		setDimStatus("agy-poll", undefined);
	};

	const onNativeEvent = (event: NativeDisplayEvent): void => {
		if (event.name === POLL_TOOL_NAME) {
			const view = event.callId ? roundTrips.poll(event.callId) : undefined;
			const switched = pollRuns.add(
				view?.name ?? "unknown call",
				view?.state ?? "running",
				new Date(),
			);
			if (switched) pi.appendEntry<PollRunData>("agy-poll-run", switched);
			const open = pollRuns.open;
			setDimStatus(
				"agy-poll",
				open ? `bridge_poll_result -> ${open.target} (x${open.count})` : undefined,
			);
			return;
		}
		closePollRun();
		if (/^pi-bridge(?:-\d+)?$/.test(event.mcpServer ?? "")) return;
		if (event.status === "started") {
			pendingNativeTools++;
			setDimStatus("agy-native", `agy ${event.name}... (${pendingNativeTools})`);
			return;
		}
		pendingNativeTools = Math.max(0, pendingNativeTools - 1);
		if (pendingNativeTools === 0) activeUi?.setStatus("agy-native", undefined);
		pi.appendEntry<NativeDisplayEvent>("agy-native-event", {
			...event,
			output: event.output?.slice(0, 4000),
			diff: event.diff?.slice(0, 12000),
			command: event.command?.slice(0, 500),
		});
	};

	acpDriver.onTurnEnd = (outcome: TurnOutcome) => {
		fileLog.log(
			"turn-end",
			{ status: outcome.status, error: outcome.error?.slice(0, 500), aborted: outcome.aborted },
			outcome.status === "OK" ? "info" : "warn",
		);
		roundTrips.failAll(FAIL_REASON_TURN_END);
		closePollRun();
		if (outcome.conversationId) roundTrips.stampConversation(outcome.conversationId);
	};

	let lastUsageStatus = "";
	pi.on("message_update", (event, ctx) => {
		if (
			!ctx.hasUI ||
			event.message.role !== "assistant" ||
			event.message.provider !== "antigravity" ||
			loadConfig().acp.usageEstimate === "off"
		) {
			return;
		}
		const { input, output } = event.message.usage;
		const status = ctx.ui.theme.fg("dim", `ACP ~ ${input} in / ${output} out`);
		if (status !== lastUsageStatus) {
			lastUsageStatus = status;
			ctx.ui.setStatus("agy-usage", status);
		}
	});
	const clearUsageStatus = (
		_event: unknown,
		ctx: { hasUI: boolean; ui: ExtensionUIContext },
	) => {
		lastUsageStatus = "";
		if (ctx.hasUI) ctx.ui.setStatus("agy-usage", undefined);
	};
	pi.on("agent_end", (event, ctx) => {
		clearUsageStatus(event, ctx);
		pendingNativeTools = 0;
		closePollRun();
		if (ctx.hasUI) ctx.ui.setStatus("agy-native", undefined);
	});

	const backgroundWatchers = new Map<
		string,
		{ handle: BackgroundWatchHandle; armedAt: number; settled: boolean }
	>();
	let backgroundWatchDisposed = false;
	const appendWatchSettled = (
		conversationId: string,
		armedAt: number,
		taskIds: number[],
	): void => {
		try {
			pi.appendEntry<BackgroundWatchEntry>("agy-background-watch", {
				kind: "settled",
				conversationId,
				armedAt,
				settledAt: Date.now(),
				taskIds,
			});
		} catch {
			// Best-effort persistence.
		}
	};
	const sendTaskWake = (content: string): void => {
		if (backgroundWatchDisposed) return;
		try {
			pi.sendMessage(
				{ customType: "agy-background-task", content: redactText(content), display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// Ignore shutdown race.
		}
	};
	const armConversationWatcher = (
		conversationId: string,
		turnStartMs: number,
		opts?: { armedAt?: number; recordArmed?: boolean },
	): void => {
		const conversationDir = agyConversationDir(conversationId);
		const prev = backgroundWatchers.get(conversationId);
		if (prev) {
			prev.handle.stop();
			if (!prev.settled) {
				prev.settled = true;
				appendWatchSettled(conversationId, prev.armedAt, []);
			}
		}
		const armedAt = opts?.armedAt ?? Date.now();
		if (opts?.recordArmed !== false) {
			try {
				pi.appendEntry<BackgroundWatchEntry>("agy-background-watch", {
					kind: "armed",
					conversationId,
					turnStartMs,
					armedAt,
				});
			} catch {
				// Best-effort persistence.
			}
		}
		const slot = {
			handle: undefined as unknown as BackgroundWatchHandle,
			armedAt,
			settled: false,
		};
		slot.handle = armBackgroundWatch({
			conversationId,
			conversationDir,
			turnStartMs,
			armedAt,
			listTasks: listAgyTasks,
			deliveredTaskIds: readDeliveredTaskIds,
			tail: tailAgyTaskLog,
			onSettle: (result) => {
				if (slot.settled) return;
				slot.settled = true;
				appendWatchSettled(conversationId, armedAt, result.taskIds);
			},
			sendWake: sendTaskWake,
			log: fileLog.log.bind(fileLog),
		});
		backgroundWatchers.set(conversationId, slot);
	};

	const streamSimple = createStreamSimple({
		entries,
		store,
		acpDriver,
		roundTrips,
		onNativeEvent,
		onNativeBackground: (info) => armConversationWatcher(info.conversationId, info.turnStartMs),
		roster,
		log: fileLog.log.bind(fileLog),
	});

	pi.registerProvider("antigravity", {
		name: "Antigravity (agy)",
		baseUrl: "agy-bridge://antigravity",
		apiKey: "not-used",
		api: "agy-bridge",
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		streamSimple,
	});

	function offerSetup(ui: ExtensionUIContext, explicit = false): void {
		if (agySetupOffer && explicit) {
			ui.notify(`CLI setup was already offered in this session. ${agyMissingMessage()}`, "info");
		}
		agySetupOffer ??= createAgySetupOffer({
			ui,
			binaryOverride: process.env.AGY_BIN || undefined,
			missingMessage: agyMissingMessage,
			log: (event, data, level) => fileLog.log(event, data, level),
		});
		void agySetupOffer();
	}

	async function checkAgySetup(
		ctx: { ui: ExtensionUIContext; mode: string },
		explicit = false,
	): Promise<void> {
		try {
			if (!isAgyInstalled(binary)) {
				if (ctx.mode === "tui") {
					offerSetup(ctx.ui, explicit);
				} else if (!agyMissingWarned) {
					agyMissingWarned = true;
					console.error(`[ant-bridge] ${agyMissingMessage()}`);
				}
				return;
			}
			if (agyVersionWarned) {
				if (explicit && ctx.mode === "tui") offerSetup(ctx.ui, true);
				return;
			}
			const rawCheck = await checkAgyCliVersion(binary);
			const check = agyVersionVerdict(rawCheck.raw, MIN_AGY_ACP_VERSION);
			if (check.status !== "unsupported") return;
			agyVersionWarned = true;
			const msg = `agy ${check.version} is too old for ACP; install ${MIN_AGY_ACP_VERSION} or newer.`;
			if (ctx.mode === "tui") {
				ctx.ui.notify(msg, "warning");
				offerSetup(ctx.ui, explicit);
			} else {
				console.error(`[ant-bridge] ${msg}`);
			}
		} catch (err) {
			fileLog.log("agy-version-check", { error: String(err) }, "warn");
		}
	}

	registerAgyCommand(pi, {
		entries,
		store,
		usingFallback,
		acpDriver,
		getMcpPort: () => mcpHandle?.port ?? null,
		bridgeTools: getBridgeTools,
		hiddenBridgeTools,
		fileLog,
		roster,
		checkAgySetup,
	});

	pi.on("session_start", async (_event, ctx) => {
		backgroundWatchDisposed = false;
		if (ctx.hasUI) activeUi = ctx.ui;

		try {
			const records: Array<{ customType: string; data: unknown }> = [];
			for (const e of ctx.sessionManager.getEntries()) {
				if ("customType" in e && e.customType === "agy-background-watch") {
					records.push({ customType: e.customType, data: (e as { data?: unknown }).data });
				}
			}
			const { active, superseded } = partitionRearmPlans(records);
			for (const old of superseded) {
				appendWatchSettled(old.conversationId, old.armedAt, []);
			}
			for (const plan of active) {
				if (!backgroundWatchers.has(plan.conversationId)) {
					armConversationWatcher(plan.conversationId, plan.turnStartMs, {
						armedAt: plan.armedAt,
						recordArmed: false,
					});
					fileLog.log(
						"background-watch-rearm",
						{ conversation: plan.conversationId, armedAt: plan.armedAt },
						"info",
					);
				}
			}
		} catch (err) {
			fileLog.log(
				"background-watch-sweep-error",
				{ error: err instanceof Error ? err.message : String(err) },
				"warn",
			);
		}

		void checkAgySetup(ctx);
		sweepStaleAcpHomes();

		const bridgeMode: BridgeTools = loadConfig().bridgeTools;
		if (bridgeMode === "none" || mcpHandle) return;

		const skills: SkillLite[] = scanSkills(ctx.isProjectTrusted() ? process.cwd() : undefined);
		const mcpLog = (s: string, d?: unknown) => {
			const failures = new Set([
				"http-error",
				"call-tool-fail",
				"transport-error",
				"handleRequest-error",
				"request-error",
				"request-handler-error",
				"unauthorized",
			]);
			const detail = (d as { msg?: string } | undefined)?.msg ?? "";
			const routineAbort =
				s === "call-tool-fail" &&
				(detail.includes(FAIL_REASON_TURN_END) || detail.includes(FAIL_REASON_SHUTDOWN));
			const level = !failures.has(s)
				? s === "call-tool" || s === "call-tool-ok"
					? "info"
					: "debug"
				: routineAbort
					? "debug"
					: s === "call-tool-fail"
						? "error"
						: "warn";
			fileLog.log(s, d, level);
			if (routineAbort || !failures.has(s)) return;
			const msg = `[ant-bridge mcp] ${s}${d !== undefined ? " " + JSON.stringify(d) : ""}`;
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			else console.error(msg);
		};

		const listTools = () => {
			const liveDescriptions = new Map<string, string>();
			try {
				const msgs = ctx.sessionManager
					.getBranch()
					.filter((e): e is typeof e & { type: "message" } => e.type === "message")
					.map((e) => e.message);
				for (const t of getCurrentTools(msgs)) {
					if (t.description) liveDescriptions.set(t.name, t.description);
				}
			} catch {
				// Fall back to static tool descriptions.
			}
			const tools = getBridgeTools().map((t) => {
				let inputSchema: object = { type: "object", properties: {}, additionalProperties: true };
				try {
					if (t.parameters) inputSchema = JSON.parse(JSON.stringify(t.parameters)) as object;
				} catch {
					// Keep permissive fallback schema.
				}
				return {
					name: t.name,
					description: liveDescriptions.get(t.name) ?? t.description ?? t.name,
					inputSchema,
				};
			});
			if (skills.length > 0 && loadConfig().bridgeTools !== "none") {
				tools.push({
					name: ACTIVATE_SKILL_TOOL_NAME,
					description: `Activate a pi Agent Skill by name. Catalog:\n${catalogSummary(skills)}`,
					inputSchema: activateSkillSchema(skills) as object,
				});
			}
			tools.push({
				name: POLL_TOOL_NAME,
				description:
					"Fetch the result of a long-running bridge tool call that answered STILL RUNNING with a callId. Poll again if it still reports running; the result or an error arrives here.",
				inputSchema: {
					type: "object",
					properties: {
						callId: { type: "string", description: "callId from the STILL RUNNING answer" },
					},
					required: ["callId"],
				},
			});
			return tools;
		};

		const bridgeOnToolCall = (
			callId: string,
			name: string,
			args: Record<string, unknown>,
			signal: AbortSignal,
		) => {
			if (name === POLL_TOOL_NAME) {
				const wanted = typeof args.callId === "string" ? args.callId : "";
				mcpLog("poll-tool", { callId: wanted });
				const view = roundTrips.poll(wanted);
				if (view && view.state !== "running") roundTrips.markDelivered(wanted);
				return Promise.resolve(formatPollAnswer(wanted, view));
			}
			if (name !== ACTIVATE_SKILL_TOOL_NAME) {
				if (!getBridgeTools().some((tool) => tool.name === name)) {
					return Promise.resolve({
						content: [
							{
								type: "text",
								text: `Pi tool ${name} is not active or not exposed to Antigravity`,
							},
						],
						isError: true,
					});
				}
				return roundTrips.onToolCall(callId, name, args, signal).then((r) => {
					if (!("escalated" in r)) return r;
					mcpLog("call-tool-escalated", { name, callId: r.callId });
					return formatEscalatedAck(r);
				});
			}
			const wanted = typeof args.name === "string" ? args.name : "";
			const skill =
				loadConfig().bridgeTools !== "none" ? findSkillByName(skills, wanted) : undefined;
			const body = skill ? readSkillBody(skill) : `unknown skill: ${wanted || "(none given)"}`;
			return Promise.resolve({
				content: [
					{
						type: "text",
						text: skill ? `${body}\n\n[skill resources dir: ${skill.dir}]` : `Error: ${body}`,
					},
				],
				isError: !skill,
			});
		};

		const r = await startMcpServer({ listTools, onToolCall: bridgeOnToolCall }, { log: mcpLog });
		if (r.ok && r.handle) {
			mcpHandle = r.handle;
		} else {
			console.error(`[ant-bridge] MCP tool bridge disabled: ${r.reason}`);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		clearUsageStatus(event, ctx);
		pendingNativeTools = 0;
		if (ctx.hasUI) ctx.ui.setStatus("agy-native", undefined);
		backgroundWatchDisposed = true;
		for (const slot of backgroundWatchers.values()) slot.handle.stop();
		backgroundWatchers.clear();

		activeUi = null;
		const h = mcpHandle;
		mcpHandle = null;
		await acpDriver.close("recycle", "session shutdown");
		roundTrips.failAll(FAIL_REASON_SHUTDOWN);
		await h?.close();
		hiddenBridgeTools.clear();
	});
}

interface AgyCommandCtx {
	entries: AgyModelEntry[];
	store: SessionStore;
	usingFallback: boolean;
	acpDriver: AcpDriver;
	getMcpPort: () => number | null;
	bridgeTools: () => Array<{ name: string }>;
	hiddenBridgeTools: Set<string>;
	fileLog: DailyLogger;
	roster: SubagentRoster;
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
		row("usage estimate:", config.acp.usageEstimate),
		row("digest:", config.digest ? "on" : "off"),
		row("system prompt:", config.systemPrompt ? "on" : "off"),
		row("turn cap:", config.turnTimeoutMin === 0 ? "off" : `${config.turnTimeoutMin}m`),
	];
}

function statusText(ctx: AgyCommandCtx): string {
	const source = ctx.usingFallback ? "fallback (agy models failed)" : "discovered";
	return [
		"Antigravity bridge (agy acp)",
		`  models:              ${ctx.entries.length} ${source}`,
		...settingsRows(),
		`  sessions:            ${ctx.store.size} bound`,
		`  config:              ${configPath()}`,
		"",
		"Subcommands: /agy doctor, /agy auth, /agy auth-manual, /agy mode accept-edits|plan, /agy readonly on|off, /agy permissions on|off, /agy permission-mode ask|allow|deny, /agy bridge all|mcp|none, /agy tools [hide|show <name>|reset], /agy usage estimate|direct|off, /agy digest on|off, /agy system-prompt on|off, /agy timeout <1-1440|off>, /agy quota, /agy subagents, /agy artifacts [open <n|name>], /agy tasks [tail <id>], /agy clear",
	].join("\n");
}

function registerAgyCommand(pi: ExtensionAPI, ctx: AgyCommandCtx): void {
	pi.registerCommand("agy", {
		description:
			"Antigravity ACP provider: settings picker, doctor, session/task/artifact inspection. Usage: /agy [doctor|auth|auth-manual|mode|readonly|permissions|permission-mode|bridge|tools|usage|digest|system-prompt|timeout|quota|subagents|artifacts|tasks|clear]",
		handler: async (args, cmdCtx: ExtensionCommandContext) => {
			const ui = cmdCtx.ui;
			if (ui) activeUi = ui;
			const mode = cmdCtx.mode;
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();
			const val = parts[1]?.toLowerCase();
			ctx.fileLog.log("agy-command", { args }, "info");

			if (sub === "clear") {
				ctx.store.clear();
				ui?.notify("Cleared all antigravity session bindings.", "info");
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
				const lines = [
					"Antigravity doctor (no tokens spent)",
					"  transport:           agy acp (isolated MCP home)",
					`  bridge:              ${config.bridgeTools}${port ? ` (port ${port})` : " (not running)"}`,
					`  driver:              ${snap.state}${snap.pid ? ` pid=${snap.pid}` : ""}${snap.conversationId ? ` session=${snap.conversationId.slice(0, 8)}` : ""}`,
					`  driver stats:        spawns=${snap.stats.spawns} turns=${snap.stats.turns} reused=${snap.stats.reused} recycles=${snap.stats.recycles}${snap.stats.lastRecycleReason ? ` (last: ${snap.stats.lastRecycleReason})` : ""}`,
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
					ui?.notify(
						ctx.getMcpPort() === null
							? `bridge set to ${next.bridgeTools}. Run /reload to start the bridge server.`
							: `bridge set to ${next.bridgeTools}. Active catalog and call guard updated.`,
						"info",
					);
				} else {
					ui?.notify(
						`bridge: ${loadConfig().bridgeTools}\nusage: /agy bridge all|mcp|none`,
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
					ui?.notify("Tool visibility reset for this Pi session.", "info");
				} else if ((val === "hide" || val === "show") && name) {
					if (!pi.getAllTools().some((tool) => tool.name === name)) {
						ui?.notify(`Unknown Pi tool: ${name}`, "error");
						return;
					}
					if (val === "hide") ctx.hiddenBridgeTools.add(name);
					else ctx.hiddenBridgeTools.delete(name);
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
				const conversationId = ctx.acpDriver.snapshot().conversationId ?? undefined;
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
					const tail = await tailAgyTaskLog(task.logPath);
					if (tail === "") {
						ui?.notify(`task #${id} has no readable log.`, "warning");
						return;
					}
					const lines = tail.split("\n");
					const body = lines.length > 40 ? `...\n${lines.slice(-40).join("\n")}` : tail;
					ui?.notify(`task #${id} tail:\n${body}`, "info");
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
						}
						continue;
					}
					break;
				}
				return;
			}
			if (sub === "artifacts") {
				const conversationId = ctx.acpDriver.snapshot().conversationId ?? undefined;
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
				ui?.notify(`unknown subcommand: ${sub}\n${statusText(ctx)}`, "warning");
				return;
			}

			if (mode !== "tui" || !ui) {
				ui?.notify(statusText(ctx), "info");
				return;
			}

			await openAgyPicker(ui);
		},
	});
}

async function openAgyPicker(ui: ExtensionUIContext): Promise<void> {
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
			else if (id === "usage") pending.acp = { usageEstimate: newValue as UsageEstimate };
			else if (id === "turn-cap") pending.turnTimeoutMin = Number(newValue);
			else if (id === "digest") pending.digest = newValue === "on";
			else if (id === "system-prompt") pending.systemPrompt = newValue === "on";
		},
	});

	if (Object.keys(pending).length === 0) return;

	try {
		const next = saveConfig(pending);
		const changed = [
			pending.readOnly !== undefined ? `readOnly=${next.readOnly ? "on" : "off"}` : null,
			pending.skipPermissions !== undefined
				? `permissions=${next.skipPermissions ? "on" : "off"}`
				: null,
			pending.permissionMode !== undefined ? `permission-mode=${next.permissionMode}` : null,
			pending.bridgeTools !== undefined ? `bridge=${next.bridgeTools}` : null,
			pending.acp !== undefined ? `usage=${next.acp.usageEstimate}` : null,
			pending.turnTimeoutMin !== undefined
				? `turn-cap=${next.turnTimeoutMin === 0 ? "off" : `${next.turnTimeoutMin}m`}`
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
