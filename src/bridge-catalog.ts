import type { BridgeTools } from "./config.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { path?: string; source?: string };
}

/** Core file/shell builtins that duplicate agy's native workspace tools (`read_file`,
 *  `run_command`, `edit_file`, `write_file`). In Pi 1.5+, `sourceInfo.source === "builtin"`
 *  also covers built-in extensions (`builtin:codemode`, `builtin:mcp`, `builtin:tool-search`,
 *  `builtin:llama`), which must remain bridged so agy can reach Pi's MCP servers and codemode. */
const CORE_BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const CORE_BUILTIN_PATHS = new Set([...CORE_BUILTIN_TOOLS].map((name) => `builtin:${name}`));

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

/** The bridge has one live HTTP endpoint. Catalog and dispatch must both use
 * the CURRENT Pi active set: /mcp and pi.setActiveTools() can change it mid-session.
 * A stale tools/call must not bypass a disabled Pi tool. */
export function bridgedPiTools(
	all: BridgeToolInfo[], active: readonly string[], mode: BridgeTools, hidden: ReadonlySet<string>,
): BridgeToolInfo[] {
	if (mode === "none") return [];
	const enabled = new Set(active);
	return all.filter((tool) =>
		enabled.has(tool.name) && !hidden.has(tool.name) &&
		// Never bridge the bridge's own tools. agy has native web tools, so
		// our quota-burning one-shot wrappers must not tempt it through MCP.
		tool.name !== "AskAntigravity" && tool.name !== "antigravity" &&
		tool.name !== "agy_web_search" && tool.name !== "agy_read_url" &&
		tool.name !== "bridge_poll_result" && tool.name !== "activate_skill" &&
		(mode === "mcp" ? isMcpBridgeTool(tool) : !isCoreBuiltin(tool)),
	);
}
