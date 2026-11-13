import crypto from "node:crypto";
import type { BridgeTools } from "./config.js";

export const PI_BRIDGE_SERVER_PREFIX = "pi-bridge";
export const PI_BRIDGE_SERVER_RE = /^pi-bridge(?:-[a-zA-Z0-9-]+)?$/;

const MCP_BRIDGE_TOOL_RE = /^mcp__([a-zA-Z0-9_-]+?)__(.+)$/;

/** Compute the MCP server prefix, isolating Pi child subagent processes by PID. */
export function bridgeServerPrefix(
	env: NodeJS.ProcessEnv = process.env,
	pid: number = process.pid,
): string {
	return env.PI_SUBAGENT_CHILD === "1" ? `pi-bridge-s${pid}` : PI_BRIDGE_SERVER_PREFIX;
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
const SELF_TOOLS = new Set(["bridge_poll_result", "activate_skill"]);

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
): BridgeToolInfo[] {
	if (mode === "none") return [];
	const enabled = new Set(active);
	return all.filter(
		(tool) =>
			enabled.has(tool.name) &&
			!hidden.has(tool.name) &&
			!SELF_TOOLS.has(tool.name) &&
			(mode === "mcp" ? isMcpBridgeTool(tool) : !isCoreBuiltin(tool)),
	);
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
