import type { BridgeTools } from "./config.js";

export interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters?: object;
	sourceInfo?: { path?: string; source?: string };
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
			(mode !== "mcp" || isMcpBridgeTool(tool)),
	);
}
