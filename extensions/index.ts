// ant-bridge - focused ACP model provider and Pi MCP/skill bridge.

import { spawn } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
	registerSessionResourceCleanup,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AcpPermissionRequest } from "../src/acp/connection.js";
import { AcpDriver } from "../src/acp/driver.js";
import {
	buildPiOnlyAgentMarkdown,
	PI_ONLY_AGENT_NAME,
	removeChildMcpDirsByPrefix,
	sweepStaleAcpHomes,
	type StageAcpHomeOptions,
	type StagedMcpServerEntry,
} from "../src/acp/home.js";
import { currentSessionKey, registerAgyCommand } from "../src/agy-command.js";
import { agyMissingMessage, isAgyInstalled } from "../src/agy-install.js";
import { agyConversationDir, resolveAgyBinary } from "../src/agy-paths.js";
import { createAgySetupOffer } from "../src/agy-setup.js";
import {
	agyVersionVerdict,
	checkAgyCliVersion,
	MIN_AGY_ACP_VERSION,
} from "../src/agy-version.js";
import {
	armBackgroundWatch,
	partitionRearmPlans,
	type BackgroundWatchEntry,
	type BackgroundWatchHandle,
} from "../src/background-watch.js";
import {
	bridgeCatalogFingerprint,
	bridgedPiTools,
	bridgedTranscriptTools,
	bridgeServerPrefix,
	CALL_PI_TOOL_NAME,
	childBridgeServerPrefix,
	formatCompactToolSchemas,
	normalizeCallPiToolArguments,
	partitionBridgeTools,
	PI_BRIDGE_SERVER_PREFIX,
	PI_BRIDGE_SERVER_RE,
	resolveCallPiToolTarget,
	type BridgeToolInfo,
} from "../src/bridge-catalog.js";
import { loadConfig, logsDir, type BridgeTools } from "../src/config.js";
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
import {
	capNativeOutput,
	createNativeEventEntryRenderer,
	createPollRunEntryRenderer,
	formatNativeEventDetail,
} from "../src/native-event-render.js";
import { PollRunFolder, type PollRunData } from "../src/poll-fold.js";
import {
	createStreamSimple,
	defaultEscalateAfterMs,
	formatEscalatedAck,
	formatPollAnswer,
	PI_BRIDGE_INSTRUCTIONS,
	POLL_TOOL_NAME,
	ToolRoundTrips,
	type DriverDeps,
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
	skillsFromCommands,
	type SkillLite,
} from "../src/skills.js";
import { SubagentRoster } from "../src/subagent-roster.js";
import { listAgyTasks, readDeliveredTaskIds, tailAgyTaskLog } from "../src/tasks.js";

export { registerAgyCommand } from "../src/agy-command.js";

const PROVIDER_ID = "antigravity";

let activeUi: ExtensionUIContext | null = null;
let childRunnerInstanceSeq = 0;

export default async function (pi: ExtensionAPI): Promise<void> {
	let assignedChildInstanceSeq: number | undefined;
	const primaryServerPrefix = (): string => {
		if (process.env.PI_SUBAGENT_CHILD === "1") {
			assignedChildInstanceSeq ??= ++childRunnerInstanceSeq;
			return bridgeServerPrefix(process.env, process.pid, assignedChildInstanceSeq);
		}
		return bridgeServerPrefix(process.env, process.pid, 1);
	};
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

	const mcpFailures = new Set([
		"http-error",
		"call-tool-fail",
		"transport-error",
		"handleRequest-error",
		"request-error",
		"request-handler-error",
		"unauthorized",
	]);
	let outOfTurnWarned = false;
	let logClosed = false;
	const fileLog = createDailyLogger({ dir: logsDir() });
	const rawFileLog = fileLog.log.bind(fileLog);
	fileLog.log = (event, data, level) => {
		if (event === "turn-start") {
			logClosed = false;
			outOfTurnWarned = false;
		}
		if (logClosed) return;
		rawFileLog(event, data, level);
		if (level !== "warn") return;
		if (
			event.startsWith("abort:") ||
			event === "connection-exited" ||
			event === "turn-end" ||
			mcpFailures.has(event)
		) {
			return;
		}
		const d = (data ?? {}) as Record<string, unknown>;
		let text: string;
		if (event === "round-trip-fail") {
			text = `Bridge tool call failed: ${String(d.name ?? "tool")} (${String(d.reason ?? "unknown")})`;
		} else if (event === "stall" || event.startsWith("stall:")) {
			text = "Antigravity stalled with no output; the turn was stopped";
		} else if (event === "timeout" || event.startsWith("timeout:")) {
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
	let activeSessionCtx: ExtensionContext | null = null;
	let activeSessionCwd: string | undefined;
	let activeSessionKey: string | undefined;
	let activeSessionId: string | undefined;
	let mcpStartPromise: Promise<number | null> | null = null;
	let mcpEpoch = 0;
	let lastSyncedCatalogFingerprint: string | null = null;
	const hiddenBridgeTools = new Set<string>();
	const getBridgeTools = () => {
		const cfg = loadConfig();
		return bridgedPiTools(
			pi.getAllTools(),
			pi.getActiveTools(),
			cfg.bridgeTools,
			hiddenBridgeTools,
			cfg.toolMode,
		);
	};
	const buildStagedMcpMap = (
		handle: McpServerHandle,
		tools: BridgeToolInfo[],
		serverPrefix: string,
	): Record<string, StagedMcpServerEntry> => {
		const { namespaces } = partitionBridgeTools(tools, serverPrefix);
		const map: Record<string, StagedMcpServerEntry> = {
			[serverPrefix]: {
				url: `http://127.0.0.1:${handle.port}/mcp`,
				headers: { [TOKEN_HEADER]: handle.token },
			},
		};
		for (const ns of namespaces) {
			map[ns.serverName] = {
				url: `http://127.0.0.1:${handle.port}/mcp/ns/${ns.routeName}`,
				headers: { [TOKEN_HEADER]: handle.token },
			};
		}
		return map;
	};
	const resolveIsolateHome = (
		handle: McpServerHandle | null,
		tools: BridgeToolInfo[],
		serverPrefix: string,
	): boolean | StageAcpHomeOptions => {
		const cfg = loadConfig();
		if (cfg.toolMode !== "pi-only" || cfg.bridgeTools === "none" || !handle) {
			return true;
		}
		return {
			perSession: true,
			extraMcpServers: buildStagedMcpMap(handle, tools, serverPrefix),
			agentDefinition: {
				name: PI_ONLY_AGENT_NAME,
				content: buildPiOnlyAgentMarkdown(formatCompactToolSchemas(tools, serverPrefix)),
			},
		};
	};
	const resolveCustomAgent = (handle: McpServerHandle | null): string | undefined => {
		const cfg = loadConfig();
		return cfg.toolMode === "pi-only" && cfg.bridgeTools !== "none" && handle
			? PI_ONLY_AGENT_NAME
			: undefined;
	};
	const resolveSkills = (): SkillLite[] =>
		skillsFromCommands(
			typeof pi.getCommands === "function" ? pi.getCommands() : [],
			() => scanSkills(activeSessionCwd),
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

	const resolvePermissionPolicy = (): "auto" | "deny" => {
		const cfg = loadConfig();
		return cfg.skipPermissions || cfg.permissionMode === "allow" ? "auto" : "deny";
	};
	const handlePermissionRequest = async (
		req: AcpPermissionRequest,
	): Promise<string | undefined> => {
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
	};

	const createAcpPair = (opts: {
		getServerPrefix: () => string;
		getHandle: () => McpServerHandle | null;
		getTools: () => BridgeToolInfo[];
		getSkills: () => SkillLite[];
		getLastFp: () => string | null;
		setLastFp: (fp: string) => void;
		childPrefix?: string;
	}): { driver: AcpDriver; roundTrips: ToolRoundTrips } => {
		const driver = new AcpDriver({
			bin: binary,
			binArgs: ["acp"],
			isolateHome: () =>
				resolveIsolateHome(opts.getHandle(), opts.getTools(), opts.getServerPrefix()),
			agent: () => resolveCustomAgent(opts.getHandle()),
			usageEstimate: () => loadConfig().acp.usageEstimate,
			permissionPolicy: resolvePermissionPolicy,
			onPermissionRequest: handlePermissionRequest,
			log: acpLog,
			mcpServers: () => {
				const cfg = loadConfig();
				if (cfg.bridgeTools === "none") {
					if (opts.getLastFp() === null) opts.setLastFp("none");
					return [];
				}
				const handle = opts.getHandle();
				if (!handle) return [];
				const serverPrefix = opts.getServerPrefix();
				const tools = opts.getTools();
				const { namespaces } = partitionBridgeTools(tools, serverPrefix);
				if (opts.getLastFp() === null) {
					opts.setLastFp(
						bridgeCatalogFingerprint(
							tools,
							[...opts.getSkills().map((s) => `skill:${s.name}`), `toolMode:${cfg.toolMode}`],
							serverPrefix,
						),
					);
				}
				// In pi-only mode, bridged MCP servers are registered via staged config/mcp_config.json
				// so the custom agent can dispatch them via call_mcp_tool (session/new.mcpServers must be empty).
				if (cfg.toolMode === "pi-only") return [];
				return [
					{
						name: serverPrefix,
						type: "http",
						url: `http://127.0.0.1:${handle.port}/mcp`,
						headers: [{ name: TOKEN_HEADER, value: handle.token }],
					},
					...namespaces.map((ns) => ({
						name: ns.serverName,
						type: "http" as const,
						url: `http://127.0.0.1:${handle.port}/mcp/ns/${ns.routeName}`,
						headers: [{ name: TOKEN_HEADER, value: handle.token }],
					})),
				];
			},
		});
		const rt = new ToolRoundTrips(
			driver,
			(s, d, level) =>
				fileLog.log(s, d, level ?? (s === "round-trip-fail" ? "warn" : "debug")),
			{ escalateAfterMs: (name) => defaultEscalateAfterMs(name, loadConfig().escalateLongTools) },
		);
		driver.onTurnEnd = (outcome: TurnOutcome) => {
			fileLog.log(
				"turn-end",
				{
					status: outcome.status,
					error: outcome.error?.slice(0, 500),
					aborted: outcome.aborted,
					...(opts.childPrefix ? { childPrefix: opts.childPrefix } : {}),
					...(outcome.steered ? { steered: true } : {}),
				},
				outcome.status === "OK" ? "info" : "warn",
			);
			rt.failAll(FAIL_REASON_TURN_END);
			if (outcome.conversationId) rt.stampConversation(outcome.conversationId);
		};
		return { driver, roundTrips: rt };
	};

	const { driver: acpDriver, roundTrips } = createAcpPair({
		getServerPrefix: primaryServerPrefix,
		getHandle: () => mcpHandle,
		getTools: getBridgeTools,
		getSkills: resolveSkills,
		getLastFp: () => lastSyncedCatalogFingerprint,
		setLastFp: (fp) => {
			lastSyncedCatalogFingerprint = fp;
		},
	});
	const roster = new SubagentRoster();

	pi.registerEntryRenderer<NativeDisplayEvent>(
		"agy-native-event",
		createNativeEventEntryRenderer(),
	);

	pi.registerEntryRenderer<PollRunData>("agy-poll-run", createPollRunEntryRenderer());

	let pendingNativeTools = 0;
	const activeNativeToolIds = new Set<string>();
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
		if (PI_BRIDGE_SERVER_RE.test(event.mcpServer ?? "")) {
			if (
				event.status !== "started" &&
				event.toolCallId &&
				activeNativeToolIds.delete(event.toolCallId)
			) {
				pendingNativeTools = Math.max(0, pendingNativeTools - 1);
				if (pendingNativeTools === 0) activeUi?.setStatus("agy-native", undefined);
			}
			return;
		}
		if (event.status === "started") {
			if (event.toolCallId) activeNativeToolIds.add(event.toolCallId);
			pendingNativeTools++;
			const detail = formatNativeEventDetail(event);
			const snippet = detail
				? ` ${detail.length > 60 ? `${detail.slice(0, 57)}...` : detail}`
				: "";
			const ellipsis = snippet.endsWith("...") ? "" : "...";
			const count = pendingNativeTools > 1 ? ` (${pendingNativeTools})` : "";
			setDimStatus("agy-native", `agy ${event.name}${snippet}${ellipsis}${count}`);
			return;
		}
		if (event.toolCallId) activeNativeToolIds.delete(event.toolCallId);
		pendingNativeTools = Math.max(0, pendingNativeTools - 1);
		if (pendingNativeTools === 0) activeUi?.setStatus("agy-native", undefined);
		pi.appendEntry<NativeDisplayEvent>("agy-native-event", {
			...event,
			output: capNativeOutput(event.output),
			diff: event.diff?.slice(0, 12000),
			command: event.command?.slice(0, 500),
		});
	};

	pi.on("input", (event, ctx) => {
		if (
			event.streamingBehavior !== "steer" ||
			ctx.model?.provider !== PROVIDER_ID ||
			roundTrips.pendingIds.length > 0
		) {
			return;
		}
		const interrupted = acpDriver.interruptForSteer();
		if (interrupted) {
			fileLog.log(
				"steer-interrupt",
				{ sessionId: acpDriver.snapshot().conversationId ?? null },
				"info",
			);
		}
	});

	let lastUsageStatus = "";
	pi.on("message_update", (event, ctx) => {
		if (
			!ctx.hasUI ||
			event.message.role !== "assistant" ||
			event.message.provider !== PROVIDER_ID ||
			loadConfig().acp.usageEstimate === "off"
		) {
			return;
		}
		const { input = 0, output = 0, cacheRead = 0 } = event.message.usage ?? {};
		if (input === 0 && output === 0 && cacheRead === 0) {
			return;
		}
		const exact = Boolean(acpDriver.snapshot().acp?.exactUsageSeen || cacheRead > 0);
		const label = exact
			? `ACP ${input} in${cacheRead > 0 ? ` (+${cacheRead} cached)` : ""} / ${output} out`
			: `ACP ~ ${input} in / ${output} out`;
		const status = ctx.ui.theme.fg("dim", label);
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
	pi.on("turn_start", () => {
		outOfTurnWarned = false;
		// Any previous turn's native background-task watcher only exists to wake
		// an idle Pi session; stop and settle it once a new turn takes over so a
		// task killed or handled in the new turn cannot emit a stale wake later.
		for (const [conversationId, slot] of backgroundWatchers.entries()) {
			slot.handle.stop();
			if (!slot.settled) {
				slot.settled = true;
				appendWatchSettled(conversationId, slot.armedAt, []);
			}
		}
		backgroundWatchers.clear();
	});
	pi.on("agent_end", (event, ctx) => {
		clearUsageStatus(event, ctx);
		pendingNativeTools = 0;
		activeNativeToolIds.clear();
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

	const syncSessionContext = (ctx: ExtensionContext): void => {
		activeSessionCtx = ctx;
		if (typeof ctx.isProjectTrusted === "function") {
			activeSessionCwd = ctx.isProjectTrusted() ? ctx.cwd : undefined;
		}
		activeSessionKey = currentSessionKey(ctx);
		const sid = ctx.sessionManager?.getSessionId?.();
		activeSessionId = sid && sid.length > 0 ? sid : undefined;
	};

	const syncBridgeCatalog = async (reason: string): Promise<void> => {
		const serverPrefix = primaryServerPrefix();
		const cfg = loadConfig();
		const nextFp =
			cfg.bridgeTools === "none"
				? "none"
				: bridgeCatalogFingerprint(
						getBridgeTools(),
						[...resolveSkills().map((s) => `skill:${s.name}`), `toolMode:${cfg.toolMode}`],
						serverPrefix,
					);
		if (acpDriver.state === "idle" || acpDriver.state === "dead") {
			lastSyncedCatalogFingerprint = nextFp;
		} else if (
			lastSyncedCatalogFingerprint !== null &&
			nextFp !== lastSyncedCatalogFingerprint &&
			acpDriver.state !== "running" &&
			!acpDriver.activeHandle
		) {
			fileLog.log("bridge-catalog-recycle", { reason }, "info");
			await acpDriver.close("recycle", reason);
			lastSyncedCatalogFingerprint = nextFp;
		} else if (lastSyncedCatalogFingerprint === null) {
			lastSyncedCatalogFingerprint = nextFp;
		}
	};

	const mcpLog = (s: string, d?: unknown) => {
		const rec =
			typeof d === "object" && d !== null && !Array.isArray(d)
				? (d as Record<string, unknown>)
				: undefined;
		const detail =
			typeof rec?.msg === "string" ? rec.msg : typeof d === "string" ? d : "";
		const toolName =
			typeof rec?.name === "string" && rec.name.length > 0 ? rec.name : "tool";
		const routineAbort =
			s === "call-tool-fail" &&
			(detail.includes(FAIL_REASON_TURN_END) || detail.includes(FAIL_REASON_SHUTDOWN));
		const outOfTurn =
			s === "call-tool-fail" && detail.includes("no active antigravity turn");
		const level = !mcpFailures.has(s)
			? s === "call-tool" || s === "call-tool-ok"
				? "info"
				: "debug"
			: routineAbort
				? "debug"
				: outOfTurn
					? "warn"
					: s === "call-tool-fail"
						? "error"
						: "warn";
		fileLog.log(s, d, level);
		if (routineAbort || !mcpFailures.has(s)) return;
		let msg: string;
		if (outOfTurn) {
			if (outOfTurnWarned) return;
			outOfTurnWarned = true;
			msg = `[ant-bridge] Ignored bridged tool call (${toolName}) because no Antigravity turn is active.`;
		} else if (s === "call-tool-fail") {
			msg = `[ant-bridge] Bridge tool ${toolName} failed: ${detail || "unknown error"}`;
		} else if (s === "unauthorized") {
			const url = typeof rec?.url === "string" && rec.url ? ` (${rec.url})` : "";
			msg = `[ant-bridge] Rejected unauthorized MCP bridge request${url}.`;
		} else {
			const summary = detail || (typeof rec?.url === "string" ? rec.url : "");
			msg = `[ant-bridge] MCP bridge ${s.replace(/-/g, " ")}${summary ? `: ${summary}` : ""}`;
		}
		if (activeSessionCtx?.hasUI) activeSessionCtx.ui.notify(msg, "warning");
		else if (activeUi) activeUi.notify(msg, "warning");
		else console.error(msg);
	};

	const toMcpInputSchema = (parameters: object | undefined): object => {
		let inputSchema: object = { type: "object", properties: {}, additionalProperties: true };
		try {
			if (parameters) inputSchema = JSON.parse(JSON.stringify(parameters)) as object;
		} catch {
			// Keep permissive fallback schema.
		}
		return inputSchema;
	};

	const toolNotExposedResult = (name: string) => ({
		content: [
			{
				type: "text",
				text: `Pi tool ${name} is not active or not exposed to Antigravity`,
			},
		],
		isError: true,
	});

	const createBridgeMcpHandlers = (opts: {
		getBridgeTools: () => BridgeToolInfo[];
		getLiveDescriptions?: () => ReadonlyMap<string, string>;
		resolveSkills: () => SkillLite[];
		roundTrips: ToolRoundTrips;
		serverPrefix: () => string;
	}) => {
		const listToolsForBridge = (route = PI_BRIDGE_SERVER_PREFIX) => {
			const liveDescriptions = opts.getLiveDescriptions?.() ?? new Map<string, string>();
			const { coreTools, namespaces } = partitionBridgeTools(
				opts.getBridgeTools(),
				opts.serverPrefix(),
			);
			if (route.startsWith("ns:")) {
				const routeName = route.slice(3);
				const ns = namespaces.find((entry) => entry.routeName === routeName);
				if (!ns) return [];
				return ns.tools.map((item) => ({
					name: item.exposedName,
					description:
						liveDescriptions.get(item.piName) ?? item.tool.description ?? item.exposedName,
					inputSchema: toMcpInputSchema(item.tool.parameters),
				}));
			}
			if (route !== PI_BRIDGE_SERVER_PREFIX) return [];
			const tools = coreTools.map((t) => ({
				name: t.name,
				description: liveDescriptions.get(t.name) ?? t.description ?? t.name,
				inputSchema: toMcpInputSchema(t.parameters),
			}));
			if (loadConfig().bridgeTools !== "none") {
				const skills = opts.resolveSkills();
				if (skills.length > 0) {
					tools.push({
						name: ACTIVATE_SKILL_TOOL_NAME,
						description: `Activate a pi Agent Skill by name. Catalog:\n${catalogSummary(skills)}`,
						inputSchema: activateSkillSchema(skills) as object,
					});
				}
			}
			tools.push({
				name: CALL_PI_TOOL_NAME,
				description: [
					"Invoke any Pi or bridged MCP tool by name (for non-eager tools in",
					"mcp/pi-bridge*/<tool>.json, such as subagent or codemode).",
				].join(" "),
				inputSchema: {
					type: "object",
					properties: {
						name: {
							type: "string",
							description: "Tool name or <server>/<tool>",
						},
						arguments: {
							type: "object",
							description: "Tool arguments object",
							additionalProperties: true,
						},
					},
					required: ["name"],
				},
			});
			tools.push({
				name: POLL_TOOL_NAME,
				description: [
					"Fetch the result of a long-running bridge tool call that answered STILL RUNNING with a callId.",
					"Poll again if it still reports running; the result or an error arrives here.",
				].join(" "),
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

		const onToolCallForBridge = (
			callId: string,
			name: string,
			args: Record<string, unknown>,
			signal: AbortSignal,
			route = PI_BRIDGE_SERVER_PREFIX,
		) => {
			if (route.startsWith("ns:")) {
				const routeName = route.slice(3);
				const { namespaces } = partitionBridgeTools(
					opts.getBridgeTools(),
					opts.serverPrefix(),
				);
				const ns = namespaces.find((entry) => entry.routeName === routeName);
				const item = ns?.tools.find(
					(entry) => entry.exposedName === name || entry.piName === name,
				);
				if (!item) return Promise.resolve(toolNotExposedResult(name));
				return opts.roundTrips.onToolCall(callId, item.piName, args, signal).then((r) => {
					if (!("escalated" in r)) return r;
					mcpLog("call-tool-escalated", { name: item.piName, callId: r.callId });
					return formatEscalatedAck(r);
				});
			}
			if (route !== PI_BRIDGE_SERVER_PREFIX) return Promise.resolve(toolNotExposedResult(name));
			if (name === POLL_TOOL_NAME) {
				const wanted = typeof args.callId === "string" ? args.callId : "";
				mcpLog("poll-tool", { callId: wanted });
				const view = opts.roundTrips.poll(wanted);
				if (view && view.state !== "running") opts.roundTrips.markDelivered(wanted);
				return Promise.resolve(formatPollAnswer(wanted, view));
			}
			if (name === CALL_PI_TOOL_NAME) {
				if (loadConfig().bridgeTools === "none") {
					const raw = typeof args.name === "string" ? args.name.trim() : "";
					return Promise.resolve(toolNotExposedResult(raw || CALL_PI_TOOL_NAME));
				}
				const rawTarget = typeof args.name === "string" ? args.name : "";
				const resolved = resolveCallPiToolTarget(
					rawTarget,
					opts.getBridgeTools(),
					opts.serverPrefix(),
				);
				if (resolved.kind === "recursive") {
					return Promise.resolve({
						content: [{ type: "text", text: "Error: call_pi_tool cannot invoke itself" }],
						isError: true,
					});
				}
				if (resolved.kind === "ambiguous") {
					const choices = resolved.candidates.join(", ");
					return Promise.resolve({
						content: [
							{
								type: "text",
								text: `Tool "${resolved.requested}" exists on multiple MCP servers; specify one of: ${choices}`,
							},
						],
						isError: true,
					});
				}
				if (resolved.kind === "not_found") {
					return Promise.resolve(toolNotExposedResult(resolved.requested || "(none given)"));
				}
				const rawNested = args.arguments !== undefined ? args.arguments : args.args;
				const targetParams = resolved.kind === "tool" ? resolved.tool.parameters : undefined;
				const parsedArgs = normalizeCallPiToolArguments(rawNested, targetParams);
				if (!parsedArgs.ok) {
					return Promise.resolve({
						content: [{ type: "text", text: `Error: ${parsedArgs.error}` }],
						isError: true,
					});
				}
				if (resolved.kind === "self") {
					return onToolCallForBridge(
						callId,
						resolved.name,
						parsedArgs.args,
						signal,
						PI_BRIDGE_SERVER_PREFIX,
					);
				}
				return opts.roundTrips
					.onToolCall(callId, resolved.piName, parsedArgs.args, signal)
					.then((r) => {
						if (!("escalated" in r)) return r;
						mcpLog("call-tool-escalated", { name: resolved.piName, callId: r.callId });
						return formatEscalatedAck(r);
					});
			}
			if (name !== ACTIVATE_SKILL_TOOL_NAME) {
				const { coreTools } = partitionBridgeTools(
					opts.getBridgeTools(),
					opts.serverPrefix(),
				);
				if (!coreTools.some((tool) => tool.name === name)) {
					return Promise.resolve(toolNotExposedResult(name));
				}
				return opts.roundTrips.onToolCall(callId, name, args, signal).then((r) => {
					if (!("escalated" in r)) return r;
					mcpLog("call-tool-escalated", { name, callId: r.callId });
					return formatEscalatedAck(r);
				});
			}
			const wanted = typeof args.name === "string" ? args.name : "";
			const skills = loadConfig().bridgeTools !== "none" ? opts.resolveSkills() : [];
			const skill = findSkillByName(skills, wanted);
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

		return { listTools: listToolsForBridge, onToolCall: onToolCallForBridge };
	};

	const { listTools, onToolCall: bridgeOnToolCall } = createBridgeMcpHandlers({
		getBridgeTools,
		getLiveDescriptions: () => {
			const liveDescriptions = new Map<string, string>();
			try {
				const branch = activeSessionCtx?.sessionManager?.getBranch?.() ?? [];
				const msgs = branch
					.filter((e): e is typeof e & { type: "message" } => e.type === "message")
					.map((e) => e.message);
				for (const t of getCurrentTools(msgs)) {
					if (t.description) liveDescriptions.set(t.name, t.description);
				}
			} catch {
				// Fall back to static tool descriptions.
			}
			return liveDescriptions;
		},
		resolveSkills,
		roundTrips,
		serverPrefix: primaryServerPrefix,
	});

	const CHILD_IDLE_CLOSE_MS = 60_000;
	let childSeq = 0;
	let primaryActiveKey: string | undefined;
	let unregisterSessionCleanup: (() => void) | undefined;
	interface ChildSessionRuntime {
		key: string;
		serverPrefix: string;
		getDeps: (context: TranscriptContext, cwd: string) => DriverDeps;
		dispose: (reason?: string) => Promise<void>;
	}
	const childRuntimes = new Map<string, ChildSessionRuntime>();

	const createChildRuntime = (
		key: string,
		opts?: { ephemeral?: boolean },
	): ChildSessionRuntime => {
		const serverPrefix = childBridgeServerPrefix(process.pid, ++childSeq);
		let latestTools: BridgeToolInfo[] = [];
		let latestSkills: SkillLite[] = [];
		let lastChildFp: string | null = null;
		let childMcpHandle: McpServerHandle | null = null;
		let childMcpStartPromise: Promise<number | null> | null = null;
		let disposed = false;
		let idleTimer: NodeJS.Timeout | undefined;

		const clearIdleTimer = (): void => {
			if (!idleTimer) return;
			clearTimeout(idleTimer);
			idleTimer = undefined;
		};

		const { driver: childDriver, roundTrips: childRoundTrips } = createAcpPair({
			getServerPrefix: () => serverPrefix,
			getHandle: () => childMcpHandle,
			getTools: () => latestTools,
			getSkills: () => latestSkills,
			getLastFp: () => lastChildFp,
			setLastFp: (fp) => {
				lastChildFp = fp;
			},
			childPrefix: serverPrefix,
		});

		const childHandlers = createBridgeMcpHandlers({
			getBridgeTools: () => latestTools,
			resolveSkills: () => latestSkills,
			roundTrips: childRoundTrips,
			serverPrefix: () => serverPrefix,
		});

		const ensureChildMcpServer = async (): Promise<number | null> => {
			if (disposed) return null;
			if (childMcpHandle) return childMcpHandle.port;
			if (childMcpStartPromise) return childMcpStartPromise;
			childMcpStartPromise = (async () => {
				const r = await startMcpServer(
					{
						listTools: childHandlers.listTools,
						onToolCall: childHandlers.onToolCall,
						instructions: PI_BRIDGE_INSTRUCTIONS,
					},
					{ log: mcpLog },
				);
				if (r.ok && r.handle) {
					if (disposed) {
						await r.handle.close();
						return null;
					}
					childMcpHandle = r.handle;
					return r.handle.port;
				}
				return null;
			})().finally(() => {
				childMcpStartPromise = null;
			});
			return childMcpStartPromise;
		};

		const closeProcesses = async (reason: string): Promise<void> => {
			clearIdleTimer();
			lastChildFp = null;
			const h = childMcpHandle;
			childMcpHandle = null;
			await childDriver.close("recycle", reason);
			childRoundTrips.failAll(FAIL_REASON_SHUTDOWN);
			await h?.close();
			removeChildMcpDirsByPrefix(serverPrefix);
		};

		const dispose = async (reason = "child session disposed"): Promise<void> => {
			if (disposed) return;
			disposed = true;
			childRuntimes.delete(key);
			await closeProcesses(reason);
		};

		const armIdleClose = (): void => {
			clearIdleTimer();
			if (disposed || childDriver.activeHandle || childDriver.state === "running") return;
			if (opts?.ephemeral) {
				void dispose("ephemeral turn finished");
				return;
			}
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				if (!disposed && !childDriver.activeHandle && childDriver.state !== "running") {
					void closeProcesses("child session idle");
				}
			}, CHILD_IDLE_CLOSE_MS);
			idleTimer.unref?.();
		};

		return {
			key,
			serverPrefix,
			dispose,
			getDeps: (context: TranscriptContext, cwd: string): DriverDeps => ({
				driver: childDriver,
				roundTrips: childRoundTrips,
				beforeTurn: async () => {
					clearIdleTimer();
					const cfg = loadConfig();
					const bridgeMode = cfg.bridgeTools;
					latestTools = bridgedTranscriptTools(
						getCurrentTools(context.messages),
						bridgeMode,
						cfg.toolMode,
					);
					const sys = getCurrentSystemPrompt(context.messages);
					latestSkills =
						bridgeMode !== "none" && sys.includes("<available_skills>")
							? scanSkills(cwd)
							: [];
					if (
						bridgeMode !== "none" &&
						(latestTools.length > 0 || latestSkills.length > 0)
					) {
						await ensureChildMcpServer();
					}
					const nextFp =
						bridgeMode === "none"
							? "none"
							: bridgeCatalogFingerprint(
									latestTools,
									[...latestSkills.map((s) => `skill:${s.name}`), `toolMode:${cfg.toolMode}`],
									serverPrefix,
								);
					if (childDriver.state === "idle" || childDriver.state === "dead") {
						lastChildFp = nextFp;
					} else if (
						lastChildFp !== null &&
						nextFp !== lastChildFp &&
						childDriver.state !== "running" &&
						!childDriver.activeHandle
					) {
						await childDriver.close("recycle", "child bridge tool catalog updated");
						lastChildFp = nextFp;
					} else if (lastChildFp === null) {
						lastChildFp = nextFp;
					}
				},
				onTurnFinished: () => {
					armIdleClose();
				},
				log: fileLog.log.bind(fileLog),
			}),
		};
	};

	const streamSimple = createStreamSimple({
		entries,
		store,
		acpDriver,
		roundTrips,
		beforeTurn: () => {
			outOfTurnWarned = false;
			return syncBridgeCatalog("bridge tool catalog updated");
		},
		onNativeEvent,
		onNativeBackground: (info) => armConversationWatcher(info.conversationId, info.turnStartMs),
		onTurnFinished: () => {
			if (!acpDriver.activeHandle) primaryActiveKey = undefined;
			if (pendingNativeTools > 0 || activeNativeToolIds.size > 0) {
				pendingNativeTools = 0;
				activeNativeToolIds.clear();
				activeUi?.setStatus("agy-native", undefined);
			}
			closePollRun();
		},
		roster,
		resolveSessionDeps: (key, context, options, isSummarization) => {
			const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			const primaryBusy = acpDriver.activeHandle !== null || acpDriver.state === "running";
			const optSid = (options as { sessionId?: string } | undefined)?.sessionId;
			const explicitForeignSession = Boolean(
				activeSessionId && optSid && optSid !== activeSessionId,
			);
			const concurrentForeignSession =
				primaryBusy && primaryActiveKey !== undefined && key !== primaryActiveKey;
			const isPrimaryKey = !explicitForeignSession && !concurrentForeignSession;
			// Summarization must not queue behind a parked parent or child turn:
			// Pi waits for the summary before delivering that turn's tool result.
			if (isSummarization && (primaryBusy || !isPrimaryKey || childRuntimes.has(key))) {
				const ephKey = `ephemeral:${++childSeq}@acp`;
				const rt = createChildRuntime(ephKey, { ephemeral: true });
				childRuntimes.set(ephKey, rt);
				return rt.getDeps(context, cwd);
			}
			if (isPrimaryKey) {
				primaryActiveKey = key;
				return undefined;
			}
			let rt = childRuntimes.get(key);
			if (!rt) {
				rt = createChildRuntime(key);
				childRuntimes.set(key, rt);
			}
			return rt.getDeps(context, cwd);
		},
		log: fileLog.log.bind(fileLog),
	});

	pi.registerProvider(PROVIDER_ID, {
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

	const ensureMcpServer = async (): Promise<number | null> => {
		if (mcpHandle) return mcpHandle.port;
		if (mcpStartPromise) return mcpStartPromise;
		const startEpoch = mcpEpoch;
		mcpStartPromise = (async () => {
			const r = await startMcpServer(
				{ listTools, onToolCall: bridgeOnToolCall, instructions: PI_BRIDGE_INSTRUCTIONS },
				{ log: mcpLog },
			);
			if (r.ok && r.handle) {
				if (startEpoch !== mcpEpoch) {
					await r.handle.close();
					return null;
				}
				mcpHandle = r.handle;
				return r.handle.port;
			}
			console.error(`[ant-bridge] MCP tool bridge disabled: ${r.reason}`);
			return null;
		})().finally(() => {
			mcpStartPromise = null;
		});
		return mcpStartPromise;
	};

	registerAgyCommand(pi, {
		entries,
		store,
		usingFallback,
		acpDriver,
		getMcpPort: () => mcpHandle?.port ?? null,
		ensureMcpServer,
		syncBridgeCatalog,
		getActiveSessionKey: () => activeSessionKey,
		onSessionContext: syncSessionContext,
		bridgeTools: getBridgeTools,
		hiddenBridgeTools,
		fileLog,
		roster,
		setActiveUi: (ui) => {
			activeUi = ui;
		},
		checkAgySetup,
	});

	pi.on("session_start", async (_event, ctx) => {
		logClosed = false;
		outOfTurnWarned = false;
		backgroundWatchDisposed = false;
		if (ctx.hasUI) activeUi = ctx.ui;
		syncSessionContext(ctx);
		if (!unregisterSessionCleanup && typeof registerSessionResourceCleanup === "function") {
			unregisterSessionCleanup = registerSessionResourceCleanup((sessionId) => {
				if (!sessionId) return;
				const childKey = `sid:${sessionId}@acp`;
				if (childKey === activeSessionKey) return;
				const rt = childRuntimes.get(childKey);
				if (rt) void rt.dispose("child session cleanup");
			});
		}

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
		if (bridgeMode !== "none") {
			await ensureMcpServer();
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		clearUsageStatus(event, ctx);
		pendingNativeTools = 0;
		activeNativeToolIds.clear();
		outOfTurnWarned = false;
		if (ctx.hasUI) ctx.ui.setStatus("agy-native", undefined);
		backgroundWatchDisposed = true;
		for (const slot of backgroundWatchers.values()) slot.handle.stop();
		backgroundWatchers.clear();

		activeUi = null;
		activeSessionCtx = null;
		activeSessionCwd = undefined;
		activeSessionKey = undefined;
		activeSessionId = undefined;
		primaryActiveKey = undefined;
		lastSyncedCatalogFingerprint = null;
		unregisterSessionCleanup?.();
		unregisterSessionCleanup = undefined;
		const activeChildren = [...childRuntimes.values()];
		childRuntimes.clear();
		mcpEpoch++;
		const h = mcpHandle;
		mcpHandle = null;
		await Promise.all([
			acpDriver.close("recycle", "session shutdown"),
			...activeChildren.map((rt) => rt.dispose("session shutdown")),
		]);
		roundTrips.failAll(FAIL_REASON_SHUTDOWN);
		await h?.close();
		hiddenBridgeTools.clear();
		await store.flush();
		logClosed = true;
		await fileLog.flush();
	});
}
