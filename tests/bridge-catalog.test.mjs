import assert from "node:assert/strict";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { bridgedPiTools } = await importBridgeModule("src/bridge-catalog.ts");

const ALL_TOOLS = [
  { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
  { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
  { name: "edit", sourceInfo: { path: "builtin:edit", source: "builtin" } },
  { name: "write", sourceInfo: { path: "builtin:write", source: "builtin" } },
  { name: "grep", sourceInfo: { path: "builtin:grep", source: "builtin" } },
  { name: "find", sourceInfo: { path: "builtin:find", source: "builtin" } },
  { name: "ls", sourceInfo: { path: "builtin:ls", source: "builtin" } },
  { name: "powershell", sourceInfo: { path: "builtin:powershell", source: "builtin" } },
  { name: "codemode", sourceInfo: { path: "builtin:codemode", source: "builtin" } },
  { name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
  { name: "mcp__slack__search", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
  { name: "read_mcp_resource", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
  { name: "pr_work", sourceInfo: { path: "/ext/pr-tracker/index.ts", source: "local" } },
  { name: "subagent", sourceInfo: { path: "/ext/pi-subagents/index.ts", source: "npm:pi-subagents" } },
  {
    name: "AskAntigravity",
    sourceInfo: { path: "/ext/agy/index.ts", source: "npm:@estebanforge/pi-antigravity-bridge" },
  },
];

const ACTIVE = ALL_TOOLS.map((t) => t.name);

test("mode=all bridges Pi 1.5 builtin extensions while excluding core file/shell builtins", () => {
  const names = bridgedPiTools(ALL_TOOLS, ACTIVE, "all", new Set()).map((t) => t.name);
  assert.deepEqual(names, [
    "codemode",
    "tool_search",
    "mcp__slack__search",
    "read_mcp_resource",
    "pr_work",
    "subagent",
  ]);
});

test("mode=mcp bridges Pi 1.5 builtin MCP, codemode, and tool_search without non-MCP extensions", () => {
  const names = bridgedPiTools(ALL_TOOLS, ACTIVE, "mcp", new Set()).map((t) => t.name);
  assert.deepEqual(names, ["codemode", "tool_search", "mcp__slack__search", "read_mcp_resource"]);
});

test("mode=none and hidden tool overrides suppress matching tools", () => {
  assert.deepEqual(bridgedPiTools(ALL_TOOLS, ACTIVE, "none", new Set()), []);
  const names = bridgedPiTools(ALL_TOOLS, ACTIVE, "all", new Set(["pr_work"])).map((t) => t.name);
  assert.deepEqual(names, ["codemode", "tool_search", "mcp__slack__search", "read_mcp_resource", "subagent"]);
});

test("legacy pathless builtin fixtures still exclude core tools by name", () => {
  const legacy = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "bash", sourceInfo: { source: "builtin" } },
    { name: "subagent", sourceInfo: { source: "npm:pi-subagents" } },
  ];
  const names = bridgedPiTools(legacy, ["read", "bash", "subagent"], "all", new Set()).map((t) => t.name);
  assert.deepEqual(names, ["subagent"]);
});
