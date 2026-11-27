import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { loadConfig, saveConfig } = await importBridgeModule("src/config.ts");
const {
  bridgedPiTools,
  bridgedTranscriptTools,
  formatCompactToolSchemas,
} = await importBridgeModule("src/bridge-catalog.ts");
const {
  PI_ONLY_AGENT_NAME,
  buildPiOnlyAgentMarkdown,
  removeStagedAcpHome,
  stageAcpHome,
} = await importBridgeModule("src/acp/home.ts");
const { AcpConnection } = await importBridgeModule("src/acp/connection.ts");
const {
  DELEGATION_ESCALATE_MS,
  PI_ONLY_TOOL_PRIORITY_NOTE,
  TOOL_PRIORITY_NOTE,
  buildFullPrompt,
  defaultEscalateAfterMs,
} = await importBridgeModule("src/provider.ts");

test("loadConfig and saveConfig support toolMode with hybrid default and AGY_TOOL_MODE override", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-toolmode-cfg-"));
  const cfgPath = path.join(tmp, "config.json");
  const prevEnv = process.env.AGY_TOOL_MODE;
  delete process.env.AGY_TOOL_MODE;
  try {
    assert.equal(loadConfig(cfgPath).toolMode, "hybrid");
    const saved = saveConfig({ toolMode: "pi-only" }, cfgPath);
    assert.equal(saved.toolMode, "pi-only");
    assert.equal(loadConfig(cfgPath).toolMode, "pi-only");

    process.env.AGY_TOOL_MODE = "hybrid";
    assert.equal(loadConfig(cfgPath).toolMode, "hybrid");

    process.env.AGY_TOOL_MODE = "pi-only";
    assert.equal(loadConfig(cfgPath).toolMode, "pi-only");
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_TOOL_MODE;
    else process.env.AGY_TOOL_MODE = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("bridgedPiTools and bridgedTranscriptTools include core file/shell builtins in pi-only mode", () => {
  const all = [
    { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
    { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
    { name: "edit", sourceInfo: { path: "builtin:edit", source: "builtin" } },
    { name: "write", sourceInfo: { path: "builtin:write", source: "builtin" } },
    { name: "codemode", sourceInfo: { path: "builtin:codemode", source: "builtin" } },
    { name: "subagent", sourceInfo: { path: "npm:pi-subagents", source: "npm" } },
  ];
  const active = all.map((t) => t.name);

  assert.deepEqual(
    bridgedPiTools(all, active, "all", new Set(), "hybrid").map((t) => t.name),
    ["codemode", "subagent"],
  );
  assert.deepEqual(
    bridgedPiTools(all, active, "all", new Set(), "pi-only").map((t) => t.name),
    ["read", "bash", "edit", "write", "codemode", "subagent"],
  );
  assert.deepEqual(
    bridgedTranscriptTools(all, "all", "hybrid").map((t) => t.name),
    ["codemode", "subagent"],
  );
  assert.deepEqual(
    bridgedTranscriptTools(all, "all", "pi-only").map((t) => t.name),
    ["read", "bash", "edit", "write", "codemode", "subagent"],
  );
});

test("formatCompactToolSchemas prioritizes core builtins and groups namespaced servers", () => {
  const tools = [
    {
      name: "subagent",
      description: "Launch a child agent",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    },
    {
      name: "read",
      description: "Read file contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" } },
        required: ["path"],
      },
    },
    {
      name: "mcp__linear__get_issue",
      description: "Fetch a Linear issue",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ];
  const text = formatCompactToolSchemas(tools, "pi-bridge");
  assert.ok(text.includes('Server "pi-bridge":'));
  assert.ok(text.includes("- read(path: string, offset?: number): Read file contents"));
  assert.ok(text.includes('Server "pi-bridge-linear":'));
  assert.ok(text.includes("- get_issue(id: string): Fetch a Linear issue"));
  assert.ok(text.indexOf("- read(") < text.indexOf("- subagent("));
});

test("stageAcpHome supports perSession isolation with extraMcpServers and pi-only custom agent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-pionly-home-"));
  try {
    const geminiHome = path.join(tmp, "gemini");
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(path.join(geminiHome, "config", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(geminiHome, "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "pi-bridge": { url: "http://127.0.0.1:9999/stale" },
          "user-server": { url: "https://example.com/mcp" },
        },
      }),
    );
    fs.writeFileSync(path.join(geminiHome, "config", "agents", "other.md"), "# global\n");

    const agentMd = buildPiOnlyAgentMarkdown('Server "pi-bridge":\n  - read(path: string)');
    const staged = stageAcpHome({
      geminiHome,
      parentDir: stateDir,
      perSession: true,
      extraMcpServers: {
        "pi-bridge": { url: "http://127.0.0.1:43210/mcp", headers: { "x-bridge-token": "tok" } },
      },
      agentDefinition: { name: PI_ONLY_AGENT_NAME, content: agentMd },
    });

    assert.ok(path.basename(staged).startsWith(`acp-home-${process.pid}-`));
    assert.equal(
      fs.realpathSync(path.join(staged, "antigravity-cli")),
      fs.realpathSync(path.join(geminiHome, "antigravity-cli")),
    );

    const mcpCfg = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8"));
    assert.deepEqual(mcpCfg.mcpServers["pi-bridge"], {
      url: "http://127.0.0.1:43210/mcp",
      headers: { "x-bridge-token": "tok" },
    });
    assert.deepEqual(mcpCfg.mcpServers["user-server"], { url: "https://example.com/mcp" });

    const stagedAgent = fs.readFileSync(
      path.join(staged, "config", "agents", `${PI_ONLY_AGENT_NAME}.md`),
      "utf8",
    );
    assert.ok(stagedAgent.includes("tools: []"));
    assert.ok(stagedAgent.includes("inheritMcp: true"));
    assert.ok(stagedAgent.includes("- read(path: string)"));
    assert.equal(fs.existsSync(path.join(staged, "config", "agents", "other.md")), false);

    removeStagedAcpHome(staged);
    assert.equal(fs.existsSync(staged), false);
    assert.equal(fs.existsSync(path.join(geminiHome, "config", "agents", "other.md")), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("defaultEscalateAfterMs grants bash/powershell 120s and buildFullPrompt switches note in pi-only mode", () => {
  assert.equal(defaultEscalateAfterMs("bash"), DELEGATION_ESCALATE_MS);
  assert.equal(defaultEscalateAfterMs("powershell"), DELEGATION_ESCALATE_MS);

  assert.equal(/[^\x20-\x7E]/.test(PI_ONLY_TOOL_PRIORITY_NOTE), false);
  assert.doesNotMatch(PI_ONLY_TOOL_PRIORITY_NOTE, /  /);

  const hybridPrompt = buildFullPrompt("Rules.", "", "Hi", "hybrid");
  assert.ok(hybridPrompt.includes(TOOL_PRIORITY_NOTE));
  assert.equal(hybridPrompt.includes(PI_ONLY_TOOL_PRIORITY_NOTE), false);

  const piOnlyPrompt = buildFullPrompt("Rules.", "", "Hi", "pi-only");
  assert.ok(piOnlyPrompt.includes(PI_ONLY_TOOL_PRIORITY_NOTE));
  assert.equal(piOnlyPrompt.includes(TOOL_PRIORITY_NOTE), false);
});

test("AcpConnection forwards dynamic --agent and removes per-session staged home on exit", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-pionly-conn-"));
  const geminiHome = path.join(tmp, "gemini");
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(geminiHome, "config"), { recursive: true });
  const argsOut = path.join(tmp, "argv.json");
  const fakeServer = path.join(tmp, "fake-acp.mjs");
  fs.writeFileSync(
    fakeServer,
    [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      `fs.writeFileSync(${JSON.stringify(argsOut)}, JSON.stringify(process.argv.slice(2)));`,
      "const rl = readline.createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      "  const msg = JSON.parse(line);",
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "1.5.18" } } }) + "\\n");',
      "  }",
      "});",
    ].join("\n"),
  );

  let exited;
  const exitDone = new Promise((r) => {
    exited = r;
  });

  try {
    const conn = new AcpConnection({
      cwd: tmp,
      bin: process.execPath,
      binArgs: [fakeServer],
      isolateHome: () => ({
        geminiHome,
        parentDir: stateDir,
        perSession: true,
        agentDefinition: {
          name: PI_ONLY_AGENT_NAME,
          content: buildPiOnlyAgentMarkdown(),
        },
      }),
      agent: () => PI_ONLY_AGENT_NAME,
      log: () => {},
      onUpdate: () => {},
      onExit: () => exited(),
    });
    await conn.start();
    const argv = JSON.parse(fs.readFileSync(argsOut, "utf8"));
    const geminiIdx = argv.indexOf("--gemini-dir");
    assert.ok(geminiIdx >= 0);
    const stagedDir = argv[geminiIdx + 1];
    assert.ok(fs.existsSync(stagedDir));
    const agentIdx = argv.indexOf("--agent");
    assert.equal(argv[agentIdx + 1], PI_ONLY_AGENT_NAME);

    conn.kill();
    await exitDone;
    assert.equal(fs.existsSync(stagedDir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
