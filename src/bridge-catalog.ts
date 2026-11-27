import crypto from "node:crypto";
import type { BridgeTools, ToolMode } from "./config.js";

export const PI_BRIDGE_SERVER_PREFIX = "pi-bridge";
export const PI_BRIDGE_SERVER_RE = /^pi-bridge(?:-[a-zA-Z0-9-]+)?$/;
export const CALL_PI_TOOL_NAME = "call_pi_tool";

const MCP_BRIDGE_TOOL_RE = /^mcp__([a-zA-Z0-9_-]+?)__(.+)$/;

/** Compute the MCP server prefix, isolating Pi child subagent processes by PID and instance. */
export function bridgeServerPrefix(
	env: NodeJS.ProcessEnv = process.env,
	pid: number = process.pid,
	instanceSeq: number = 1,
): string {
	if (env.PI_SUBAGENT_CHILD !== "1") return PI_BRIDGE_SERVER_PREFIX;
	return instanceSeq > 1 ? `pi-bridge-s${pid}-i${instanceSeq}` : `pi-bridge-s${pid}`;
}

/** Compute an isolated MCP server prefix for an in-process child session (`async: false`). */
export function childBridgeServerPrefix(
	pid: number = process.pid,
	childSeq: number = 1,
): string {
	return `pi-bridge-s${pid}-c${childSeq}`;
}

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { path?: string; source?: string };
}

export interface ParsedMcpBridgeTool {
	rawNamespace: string;
	routeName: string;
	serverName: string;
	shortToolName: string;
}

export interface PartitionedNamespaceTool {
	piName: string;
	exposedName: string;
	tool: BridgeToolInfo;
}

export interface PartitionedBridgeNamespace {
	routeName: string;
	serverName: string;
	tools: PartitionedNamespaceTool[];
}

export interface PartitionedBridgeTools {
	coreTools: BridgeToolInfo[];
	namespaces: PartitionedBridgeNamespace[];
}

/** Core file/shell builtins that duplicate agy's native workspace tools (`read_file`,
 *  `run_command`, `edit_file`, `write_file`). In Pi 1.5+, `sourceInfo.source === "builtin"`
 *  also covers built-in extensions (`builtin:codemode`, `builtin:mcp`, `builtin:tool-search`,
 *  `builtin:llama`), which must remain bridged so agy can reach Pi's MCP servers and codemode. */
const CORE_BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const CORE_BUILTIN_PATHS = new Set([...CORE_BUILTIN_TOOLS].map((name) => `builtin:${name}`));

/** Bridge-local pseudo-tools registered on the MCP endpoint itself (never Pi round-trips). */
const SELF_TOOLS = new Set(["bridge_poll_result", CALL_PI_TOOL_NAME, "activate_skill"]);
const TRANSCRIPT_MCP_HELPER_TOOLS = new Set([
	"codemode",
	"tool_search",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

function isCoreBuiltin(tool: BridgeToolInfo): boolean {
	if (tool.sourceInfo?.source !== "builtin") return false;
	const p = tool.sourceInfo.path;
	return p ? CORE_BUILTIN_PATHS.has(p) : CORE_BUILTIN_TOOLS.has(tool.name);
}

function isMcpBridgeTool(tool: BridgeToolInfo): boolean {
	const src = tool.sourceInfo?.source ?? "";
	const p = tool.sourceInfo?.path ?? "";
	return (
		/pi-mcp-adapter/.test(src) ||
		p === "builtin:mcp" ||
		p === "builtin:codemode" ||
		p === "builtin:tool-search"
	);
}

/** Filter Pi's live active tool catalog for exposure over the MCP bridge. */
export function bridgedPiTools(
	all: BridgeToolInfo[],
	active: readonly string[],
	mode: BridgeTools,
	hidden: ReadonlySet<string>,
	toolMode: ToolMode = "hybrid",
): BridgeToolInfo[] {
	if (mode === "none") return [];
	const enabled = new Set(active);
	return all.filter(
		(tool) =>
			enabled.has(tool.name) &&
			!hidden.has(tool.name) &&
			!SELF_TOOLS.has(tool.name) &&
			(mode === "mcp" ? isMcpBridgeTool(tool) : toolMode === "pi-only" || !isCoreBuiltin(tool)),
	);
}

/** Filter transcript tool declarations (`getCurrentTools(messages)`, where `sourceInfo` is
 *  stripped) for an in-process child session's isolated MCP bridge. */
export function bridgedTranscriptTools(
	tools: BridgeToolInfo[],
	mode: BridgeTools,
	toolMode: ToolMode = "hybrid",
): BridgeToolInfo[] {
	if (mode === "none") return [];
	return tools.filter(
		(tool) =>
			!SELF_TOOLS.has(tool.name) &&
			(toolMode === "pi-only" || !CORE_BUILTIN_TOOLS.has(tool.name)) &&
			(mode === "mcp"
				? MCP_BRIDGE_TOOL_RE.test(tool.name) || TRANSCRIPT_MCP_HELPER_TOOLS.has(tool.name)
				: true),
	);
}

function summarizeSchemaParams(parameters: object | undefined): string {
	const schema = parameters as
		| { properties?: Record<string, { type?: unknown }>; required?: unknown }
		| undefined;
	const props = schema?.properties;
	if (!props || typeof props !== "object") return "";
	const reqSet = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((r): r is string => typeof r === "string")
			: [],
	);
	const parts: string[] = [];
	for (const [key, def] of Object.entries(props)) {
		const rawType = def && typeof def === "object" ? def.type : undefined;
		const typeStr =
			typeof rawType === "string"
				? rawType
				: Array.isArray(rawType)
					? rawType.filter((t): t is string => typeof t === "string").join("|")
					: "any";
		parts.push(`${key}${reqSet.has(key) ? "" : "?"}: ${typeStr}`);
	}
	return parts.join(", ");
}

function oneLineSummary(desc: string | undefined, maxLen = 100): string {
	if (!desc) return "";
	const first = desc.replace(/\s+/g, " ").trim();
	if (first.length <= maxLen) return first;
	return `${first.slice(0, maxLen - 3).trimEnd()}...`;
}

/** Format a compact parameter reference for bridged Pi tools grouped by MCP server.
 *  Used in `pi-only` mode so the model can invoke `call_mcp_tool` on turn 1 without
 *  needing to read schema files from disk first. */
export function formatCompactToolSchemas(
	tools: BridgeToolInfo[],
	serverPrefix: string = PI_BRIDGE_SERVER_PREFIX,
	maxChars = 6_000,
): string {
	const { coreTools, namespaces } = partitionBridgeTools(tools, serverPrefix);
	const lines: string[] = [
		"Call tools with call_mcp_tool({ ServerName, ToolName, Arguments }).",
	];
	let used = lines[0]!.length;

	const pushLine = (line: string): boolean => {
		if (used + line.length + 1 > maxChars) return false;
		lines.push(line);
		used += line.length + 1;
		return true;
	};

	const formatEntry = (name: string, tool: BridgeToolInfo): string => {
		const params = summarizeSchemaParams(tool.parameters);
		const summary = oneLineSummary(tool.description);
		return summary ? `  - ${name}(${params}): ${summary}` : `  - ${name}(${params})`;
	};

	// Prioritize core workspace builtins first so read/edit/write/bash never get truncated.
	const orderedCore = [
		...coreTools.filter((t) => CORE_BUILTIN_TOOLS.has(t.name)),
		...coreTools.filter((t) => !CORE_BUILTIN_TOOLS.has(t.name)),
	];
	if (orderedCore.length > 0 || true) {
		pushLine(`Server "${serverPrefix}":`);
		for (const tool of orderedCore) {
			if (!pushLine(formatEntry(tool.name, tool))) break;
		}
		pushLine(
			"  - bridge_poll_result(callId: string): Fetch result of a STILL RUNNING bridged tool call",
		);
		pushLine("  - activate_skill(name: string): Load instructions for an available Pi skill");
	}

	for (const ns of namespaces) {
		if (!pushLine(`Server "${ns.serverName}":`)) break;
		for (const item of ns.tools) {
			if (!pushLine(formatEntry(item.exposedName, item.tool))) break;
		}
	}

	return lines.join("\n");
}

/** Parse a `mcp__<namespace>__<tool>` Pi tool name into its bridge route and server identifiers. */
export function parseMcpBridgeToolName(
	piToolName: string,
	serverPrefix: string = PI_BRIDGE_SERVER_PREFIX,
): ParsedMcpBridgeTool | null {
	const match = MCP_BRIDGE_TOOL_RE.exec(piToolName);
	if (!match) return null;
	const rawNamespace = match[1]!;
	const shortToolName = match[2]!;
	const routeName =
		rawNamespace
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "mcp";
	return {
		rawNamespace,
		routeName,
		serverName: `${serverPrefix}-${routeName}`,
		shortToolName,
	};
}

/** Partition bridged Pi tools into `pi-bridge` core tools and sorted per-namespace groups. */
export function partitionBridgeTools(
	tools: BridgeToolInfo[],
	serverPrefix: string = PI_BRIDGE_SERVER_PREFIX,
): PartitionedBridgeTools {
	const coreTools: BridgeToolInfo[] = [];
	const groups = new Map<
		string,
		{
			serverName: string;
			entries: Array<{ shortToolName: string; tool: BridgeToolInfo }>;
		}
	>();

	for (const tool of tools) {
		const parsed = parseMcpBridgeToolName(tool.name, serverPrefix);
		if (!parsed) {
			coreTools.push(tool);
			continue;
		}
		let group = groups.get(parsed.routeName);
		if (!group) {
			group = { serverName: parsed.serverName, entries: [] };
			groups.set(parsed.routeName, group);
		}
		group.entries.push({ shortToolName: parsed.shortToolName, tool });
	}

	const sortedRoutes = [...groups.keys()].sort();
	const namespaces: PartitionedBridgeNamespace[] = sortedRoutes.map((routeName) => {
		const group = groups.get(routeName)!;
		const shortCounts = new Map<string, number>();
		for (const entry of group.entries) {
			shortCounts.set(entry.shortToolName, (shortCounts.get(entry.shortToolName) ?? 0) + 1);
		}
		return {
			routeName,
			serverName: group.serverName,
			tools: group.entries.map((entry) => ({
				piName: entry.tool.name,
				exposedName:
					(shortCounts.get(entry.shortToolName) ?? 0) > 1
						? entry.tool.name
						: entry.shortToolName,
				tool: entry.tool,
			})),
		};
	});

	return { coreTools, namespaces };
}

/** Deterministic SHA-256 hex digest over sorted `serverName:exposedName` entries and `extraTokens`. */
export function bridgeCatalogFingerprint(
	tools: BridgeToolInfo[],
	extraTokens: readonly string[] = [],
	serverPrefix: string = PI_BRIDGE_SERVER_PREFIX,
): string {
	const { coreTools, namespaces } = partitionBridgeTools(tools, serverPrefix);
	const toolEntries = coreTools.map((tool) => `${serverPrefix}:${tool.name}`);
	for (const ns of namespaces) {
		for (const item of ns.tools) {
			toolEntries.push(`${ns.serverName}:${item.exposedName}`);
		}
	}
	toolEntries.sort();
	const sortedExtras = [...extraTokens].sort();
	return crypto
		.createHash("sha256")
		.update(JSON.stringify({ tools: toolEntries, extraTokens: sortedExtras }))
		.digest("hex");
}

export type ResolvedCallPiToolTarget =
	| { kind: "self"; name: "bridge_poll_result" | "activate_skill" }
	| { kind: "tool"; piName: string; tool: BridgeToolInfo }
	| { kind: "ambiguous"; requested: string; candidates: string[] }
	| { kind: "recursive" }
	| { kind: "not_found"; requested: string };

/** Resolve any tool identifier passed to `call_pi_tool` into its canonical Pi or bridge target. */
export function resolveCallPiToolTarget(
	rawName: string,
	tools: BridgeToolInfo[],
	serverPrefix: string = PI_BRIDGE_SERVER_PREFIX,
): ResolvedCallPiToolTarget {
	const requested = rawName.trim();
	if (!requested) return { kind: "not_found", requested };

	const corePrefixes =
		serverPrefix === PI_BRIDGE_SERVER_PREFIX
			? [PI_BRIDGE_SERVER_PREFIX]
			: [serverPrefix, PI_BRIDGE_SERVER_PREFIX];
	let unwrappedCore = requested;
	for (const srv of corePrefixes) {
		if (requested.startsWith(`${srv}/`) || requested.startsWith(`${srv}:`)) {
			unwrappedCore = requested.slice(srv.length + 1);
			break;
		}
		if (requested.startsWith(`mcp_${srv}_`)) {
			unwrappedCore = requested.slice(`mcp_${srv}_`.length);
			break;
		}
	}

	if (unwrappedCore === CALL_PI_TOOL_NAME) return { kind: "recursive" };
	if (unwrappedCore === "bridge_poll_result" || unwrappedCore === "activate_skill") {
		return { kind: "self", name: unwrappedCore };
	}

	const { coreTools, namespaces } = partitionBridgeTools(tools, serverPrefix);
	const coreMatch = coreTools.find((t) => t.name === requested || t.name === unwrappedCore);
	if (coreMatch) return { kind: "tool", piName: coreMatch.name, tool: coreMatch };

	for (const ns of namespaces) {
		for (const item of ns.tools) {
			if (item.piName === requested) {
				return { kind: "tool", piName: item.piName, tool: item.tool };
			}
		}
	}

	for (const ns of namespaces) {
		const srvNames = new Set([ns.serverName, `${PI_BRIDGE_SERVER_PREFIX}-${ns.routeName}`]);
		for (const srv of srvNames) {
			const mcpPrefix = `mcp_${srv}_`;
			if (requested.startsWith(mcpPrefix)) {
				const rest = requested.slice(mcpPrefix.length);
				const item = ns.tools.find((entry) => entry.exposedName === rest || entry.piName === rest);
				if (item) return { kind: "tool", piName: item.piName, tool: item.tool };
			}
		}
	}

	const sepIdx = requested.search(/[/:]/);
	if (sepIdx > 0) {
		const prefix = requested.slice(0, sepIdx);
		const rest = requested.slice(sepIdx + 1);
		const ns = namespaces.find(
			(entry) =>
				entry.serverName === prefix ||
				entry.routeName === prefix ||
				`${PI_BRIDGE_SERVER_PREFIX}-${entry.routeName}` === prefix,
		);
		const item = ns?.tools.find((entry) => entry.exposedName === rest || entry.piName === rest);
		if (item) return { kind: "tool", piName: item.piName, tool: item.tool };
	}

	const bareMatches: Array<{ serverName: string; item: PartitionedNamespaceTool }> = [];
	for (const ns of namespaces) {
		for (const item of ns.tools) {
			if (item.exposedName === requested) {
				bareMatches.push({ serverName: ns.serverName, item });
			}
		}
	}
	if (bareMatches.length === 1) {
		const only = bareMatches[0]!;
		return { kind: "tool", piName: only.item.piName, tool: only.item.tool };
	}
	if (bareMatches.length > 1) {
		return {
			kind: "ambiguous",
			requested,
			candidates: bareMatches.map((m) => `${m.serverName}/${m.item.exposedName}`),
		};
	}

	return { kind: "not_found", requested };
}

/** Normalize `call_pi_tool` `arguments` (object or JSON object string) and strip stray `toolSummary`. */
export function normalizeCallPiToolArguments(
	rawArgs: unknown,
	toolParameters?: object,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	if (rawArgs === undefined || rawArgs === null) return { ok: true, args: {} };
	let parsed: unknown = rawArgs;
	if (typeof rawArgs === "string") {
		const trimmed = rawArgs.trim();
		if (!trimmed) return { ok: true, args: {} };
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { ok: false, error: "call_pi_tool arguments must be a JSON object" };
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "call_pi_tool arguments must be a JSON object" };
	}
	const copy: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	if ("toolSummary" in copy) {
		const props = (toolParameters as { properties?: Record<string, unknown> } | undefined)
			?.properties;
		if (!props || !("toolSummary" in props)) {
			delete copy.toolSummary;
		}
	}
	return { ok: true, args: copy };
}
