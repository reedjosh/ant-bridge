import assert from "node:assert/strict";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const {
  PI_BRIDGE_SERVER_PREFIX,
  PI_BRIDGE_SERVER_RE,
  bridgeCatalogFingerprint,
  bridgeServerPrefix,
  bridgedPiTools,
  parseMcpBridgeToolName,
  partitionBridgeTools,
} = await importBridgeModule("src/bridge-catalog.ts");

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
  { name: "bridge_poll_result", sourceInfo: { path: "/ext/ant-bridge/index.ts", source: "local" } },
  { name: "activate_skill", sourceInfo: { path: "/ext/ant-bridge/index.ts", source: "local" } },
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

test("PI_BRIDGE_SERVER_PREFIX and PI_BRIDGE_SERVER_RE match pi-bridge and namespace server names", () => {
  assert.equal(PI_BRIDGE_SERVER_PREFIX, "pi-bridge");
  for (const valid of ["pi-bridge", "pi-bridge-12345", "pi-bridge-slack", "pi-bridge-Google-Workspace-2"]) {
    assert.equal(PI_BRIDGE_SERVER_RE.test(valid), true, `expected ${valid} to match`);
  }
  for (const invalid of ["", "pi-bridge-", "pi-bridge_slack", "pi-bridge/slack", "other-server"]) {
    assert.equal(PI_BRIDGE_SERVER_RE.test(invalid), false, `expected ${invalid} not to match`);
  }
});

test("parseMcpBridgeToolName normalizes mcp__<ns>__<tool> names and falls back to mcp route", () => {
  assert.equal(parseMcpBridgeToolName("codemode"), null);
  assert.equal(parseMcpBridgeToolName("read_mcp_resource"), null);
  assert.equal(parseMcpBridgeToolName("mcp_single_sep"), null);
  assert.equal(parseMcpBridgeToolName("mcp__bad.ns__tool"), null);

  assert.deepEqual(parseMcpBridgeToolName("mcp__slack__search_messages"), {
    rawNamespace: "slack",
    routeName: "slack",
    serverName: "pi-bridge-slack",
    shortToolName: "search_messages",
  });

  assert.deepEqual(parseMcpBridgeToolName("mcp__Google_Workspace__list_events"), {
    rawNamespace: "Google_Workspace",
    routeName: "google-workspace",
    serverName: "pi-bridge-google-workspace",
    shortToolName: "list_events",
  });

  assert.deepEqual(parseMcpBridgeToolName("mcp__---__ping"), {
    rawNamespace: "---",
    routeName: "mcp",
    serverName: "pi-bridge-mcp",
    shortToolName: "ping",
  });

  assert.deepEqual(parseMcpBridgeToolName("mcp_____ping"), {
    rawNamespace: "_",
    routeName: "mcp",
    serverName: "pi-bridge-mcp",
    shortToolName: "ping",
  });

  // Non-greedy split keeps embedded "__" inside shortToolName rather than the namespace.
  assert.deepEqual(parseMcpBridgeToolName("mcp__slack__users__list"), {
    rawNamespace: "slack",
    routeName: "slack",
    serverName: "pi-bridge-slack",
    shortToolName: "users__list",
  });

  assert.deepEqual(parseMcpBridgeToolName("mcp__github__repos__pulls__get"), {
    rawNamespace: "github",
    routeName: "github",
    serverName: "pi-bridge-github",
    shortToolName: "repos__pulls__get",
  });
});

test("bridgeServerPrefix isolates PI_SUBAGENT_CHILD=1 by PID and threads serverPrefix cleanly", () => {
  assert.equal(bridgeServerPrefix({}, 4242), "pi-bridge");
  assert.equal(bridgeServerPrefix({ PI_SUBAGENT_CHILD: "0" }, 4242), "pi-bridge");
  assert.equal(bridgeServerPrefix({ PI_SUBAGENT_CHILD: "1" }, 4242), "pi-bridge-s4242");

  const childPrefix = bridgeServerPrefix({ PI_SUBAGENT_CHILD: "1" }, 4242);
  assert.equal(PI_BRIDGE_SERVER_RE.test(childPrefix), true);
  assert.equal(PI_BRIDGE_SERVER_RE.test(`${childPrefix}-slack`), true);

  assert.deepEqual(parseMcpBridgeToolName("mcp__slack__users__list", childPrefix), {
    rawNamespace: "slack",
    routeName: "slack",
    serverName: "pi-bridge-s4242-slack",
    shortToolName: "users__list",
  });

  const tools = [
    { name: "codemode" },
    { name: "mcp__slack__users__list" },
    { name: "mcp__linear__issues_list" },
  ];
  const partitioned = partitionBridgeTools(tools, childPrefix);
  assert.deepEqual(
    partitioned.coreTools.map((t) => t.name),
    ["codemode"],
  );
  assert.deepEqual(
    partitioned.namespaces.map((ns) => ({
      routeName: ns.routeName,
      serverName: ns.serverName,
      exposed: ns.tools.map((t) => t.exposedName),
    })),
    [
      { routeName: "linear", serverName: "pi-bridge-s4242-linear", exposed: ["issues_list"] },
      { routeName: "slack", serverName: "pi-bridge-s4242-slack", exposed: ["users__list"] },
    ],
  );

  const fpParent = bridgeCatalogFingerprint(tools, ["skill:pdf"]);
  const fpChild1 = bridgeCatalogFingerprint(tools, ["skill:pdf"], childPrefix);
  const fpChild2 = bridgeCatalogFingerprint([...tools].reverse(), ["skill:pdf"], childPrefix);
  assert.notEqual(fpChild1, fpParent);
  assert.equal(fpChild1, fpChild2);
});

test("partitionBridgeTools separates coreTools, sorts namespaces, and resolves shortToolName collisions", () => {
  const catalog = [
    { name: "codemode" },
    { name: "mcp__zendesk__get_ticket" },
    { name: "mcp__foo_bar__run" },
    { name: "mcp__foo-bar__run" },
    { name: "mcp__foo_bar__status" },
    { name: "subagent" },
    { name: "mcp__alpha__ping" },
  ];

  const partitioned = partitionBridgeTools(catalog);
  assert.deepEqual(
    partitioned.coreTools.map((t) => t.name),
    ["codemode", "subagent"],
  );
  assert.deepEqual(
    partitioned.namespaces.map((ns) => ({ routeName: ns.routeName, serverName: ns.serverName })),
    [
      { routeName: "alpha", serverName: "pi-bridge-alpha" },
      { routeName: "foo-bar", serverName: "pi-bridge-foo-bar" },
      { routeName: "zendesk", serverName: "pi-bridge-zendesk" },
    ],
  );

  const fooBar = partitioned.namespaces.find((ns) => ns.routeName === "foo-bar");
  assert.deepEqual(
    fooBar.tools.map((item) => ({ piName: item.piName, exposedName: item.exposedName })),
    [
      { piName: "mcp__foo_bar__run", exposedName: "mcp__foo_bar__run" },
      { piName: "mcp__foo-bar__run", exposedName: "mcp__foo-bar__run" },
      { piName: "mcp__foo_bar__status", exposedName: "status" },
    ],
  );

  const alpha = partitioned.namespaces.find((ns) => ns.routeName === "alpha");
  assert.deepEqual(
    alpha.tools.map((item) => ({ piName: item.piName, exposedName: item.exposedName })),
    [{ piName: "mcp__alpha__ping", exposedName: "ping" }],
  );
});

test("bridgeCatalogFingerprint returns deterministic SHA-256 hex invariant to input ordering", () => {
  const toolsA = [
    { name: "codemode", description: "desc 1" },
    { name: "mcp__slack__search", description: "s1" },
    { name: "mcp__github__list_prs", description: "g1" },
  ];
  const toolsB = [
    { name: "mcp__github__list_prs", description: "different description" },
    { name: "codemode", description: "different core description" },
    { name: "mcp__slack__search", description: "s2" },
  ];

  const fpDefault = bridgeCatalogFingerprint(toolsA);
  assert.match(fpDefault, /^[0-9a-f]{64}$/);
  assert.equal(fpDefault, bridgeCatalogFingerprint(toolsB, []));

  const fpWithExtras1 = bridgeCatalogFingerprint(toolsA, ["skill:pdf", "skill:docx"]);
  const fpWithExtras2 = bridgeCatalogFingerprint(toolsB, ["skill:docx", "skill:pdf"]);
  assert.equal(fpWithExtras1, fpWithExtras2);
  assert.notEqual(fpWithExtras1, fpDefault);

  const fpAddedTool = bridgeCatalogFingerprint([...toolsA, { name: "subagent" }], ["skill:pdf", "skill:docx"]);
  assert.notEqual(fpAddedTool, fpWithExtras1);

  const fpCollision = bridgeCatalogFingerprint([
    { name: "mcp__foo_bar__run" },
    { name: "mcp__foo-bar__run" },
  ]);
  const fpSingle = bridgeCatalogFingerprint([{ name: "mcp__foo_bar__run" }]);
  assert.notEqual(fpCollision, fpSingle);
});
