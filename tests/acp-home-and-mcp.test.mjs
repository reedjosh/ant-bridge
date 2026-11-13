import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { AcpConnection } = await importBridgeModule("src/acp/connection.ts");
const { mapUpdate } = await importBridgeModule("src/acp/events.ts");
const {
  acpHomeDir,
  acpHomeStagingDir,
  removeStagedAcpHome,
  stageAcpHome,
  sweepStaleAcpHomes,
} = await importBridgeModule("src/acp/home.ts");
const { saveConfig } = await importBridgeModule("src/config.ts");
const { TOKEN_HEADER, startMcpServer } = await importBridgeModule("src/mcp-server.ts");
const { PI_BRIDGE_INSTRUCTIONS } = await importBridgeModule("src/provider.ts");
const { default: registerExtension } = await importBridgeModule("extensions/index.ts");

test(
  "stageAcpHome stages persistent acp-home in place, refreshes config idempotently, and cleans up explicitly",
  () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-home-"));
  try {
    const geminiHome = path.join(tmp, "gemini");
    const geminiHome2 = path.join(tmp, "gemini-alt");
    const stagingDir = path.join(tmp, "state");
    fs.mkdirSync(path.join(geminiHome, "config", "rules"), { recursive: true });
    fs.writeFileSync(path.join(geminiHome, "GEMINI.md"), "initial instructions");
    fs.writeFileSync(path.join(geminiHome, "config", "settings.json"), '{"v":1}');
    fs.writeFileSync(path.join(geminiHome, "config", "obsolete.json"), '{"old":true}');
    fs.writeFileSync(path.join(geminiHome, "config", "rules", "rule.md"), "be concise");
    fs.writeFileSync(
      path.join(geminiHome, "config", "mcp_config.json"),
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          "pi-bridge": { url: "http://127.0.0.1:9999/mcp" },
          "pi-bridge-12345": { url: "http://127.0.0.1:9998/mcp" },
          "pi-bridge-slack": { url: "http://127.0.0.1:9997/mcp/ns/slack" },
          "pi-bridge-claude-in-chrome": { url: "http://127.0.0.1:9997/mcp/ns/claude-in-chrome" },
          "custom-server": { command: "echo", args: ["ok"] },
        },
      }),
    );

    const staged = stageAcpHome({ geminiHome, stagingDir });
    assert.equal(staged, acpHomeDir(stagingDir));
    assert.equal(acpHomeStagingDir(stagingDir), path.join(stagingDir, "acp-homes"));
    assert.equal(fs.statSync(staged).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(staged, "config")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(staged, "config", "mcp_config.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(geminiHome, "antigravity-cli")).mode & 0o777, 0o700);

    const appDataLink = path.join(staged, "antigravity-cli");
    const firstLinkStat = fs.lstatSync(appDataLink);
    assert.equal(firstLinkStat.isSymbolicLink(), true);
    assert.equal(
      path.resolve(path.dirname(appDataLink), fs.readlinkSync(appDataLink)),
      path.resolve(path.join(geminiHome, "antigravity-cli")),
    );

    // Conversations written via the staged home must live in ~/.gemini/antigravity-cli.
    fs.mkdirSync(path.join(appDataLink, "brain", "conv-123"), { recursive: true });
    fs.writeFileSync(path.join(appDataLink, "brain", "conv-123", "note.md"), "persisted");

    const stagedMcp = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8"));
    assert.equal(stagedMcp.theme, "dark");
    assert.deepEqual(Object.keys(stagedMcp.mcpServers), ["custom-server"]);
    assert.equal(fs.readFileSync(path.join(staged, "GEMINI.md"), "utf8"), "initial instructions");
    assert.equal(fs.readFileSync(path.join(staged, "config", "settings.json"), "utf8"), '{"v":1}');
    assert.equal(fs.readFileSync(path.join(staged, "config", "rules", "rule.md"), "utf8"), "be concise");
    assert.equal(
      fs.readdirSync(path.join(staged, "config")).some((name) => name.endsWith(".tmp")),
      false,
    );

    // Refreshing in place keeps the same acp-home and antigravity-cli symlink while syncing changes.
    fs.writeFileSync(path.join(geminiHome, "GEMINI.md"), "updated instructions");
    fs.writeFileSync(path.join(geminiHome, "config", "settings.json"), '{"v":2}');
    fs.unlinkSync(path.join(geminiHome, "config", "obsolete.json"));
    fs.writeFileSync(
      path.join(geminiHome, "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "pi-bridge-99999": { url: "http://127.0.0.1:7777/mcp" },
          "second-server": { command: "true", args: [] },
        },
      }),
    );

    const restaged = stageAcpHome({ geminiHome, parentDir: stagingDir });
    assert.equal(restaged, staged);
    assert.equal(fs.lstatSync(appDataLink).ino, firstLinkStat.ino);
    const refreshedMcp = JSON.parse(
      fs.readFileSync(path.join(restaged, "config", "mcp_config.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(refreshedMcp.mcpServers), ["second-server"]);
    assert.equal(fs.readFileSync(path.join(restaged, "GEMINI.md"), "utf8"), "updated instructions");
    assert.equal(fs.readFileSync(path.join(restaged, "config", "settings.json"), "utf8"), '{"v":2}');
    assert.equal(fs.existsSync(path.join(restaged, "config", "obsolete.json")), false);
    assert.equal(fs.readFileSync(path.join(restaged, "config", "rules", "rule.md"), "utf8"), "be concise");
    assert.equal(fs.readFileSync(path.join(appDataLink, "brain", "conv-123", "note.md"), "utf8"), "persisted");

    // Switching geminiHome atomically re-points antigravity-cli and removes stale GEMINI.md.
    fs.mkdirSync(path.join(geminiHome2, "config"), { recursive: true });
    const switched = stageAcpHome({ geminiHome: geminiHome2, parentDir: stagingDir });
    assert.equal(switched, staged);
    assert.equal(
      path.resolve(path.dirname(appDataLink), fs.readlinkSync(appDataLink)),
      path.resolve(path.join(geminiHome2, "antigravity-cli")),
    );
    assert.equal(fs.existsSync(path.join(switched, "GEMINI.md")), false);

    // Atomic mcp_config.json write unlinks temp file if renameSync fails.
    const blockedMcpPath = path.join(switched, "config", "mcp_config.json");
    fs.unlinkSync(blockedMcpPath);
    fs.mkdirSync(path.join(blockedMcpPath, "blocker"), { recursive: true });
    assert.throws(() => stageAcpHome({ geminiHome: geminiHome2, parentDir: stagingDir }));
    assert.equal(
      fs.readdirSync(path.join(switched, "config")).some((name) => name.endsWith(".tmp")),
      false,
    );

    removeStagedAcpHome(staged);
    assert.equal(fs.existsSync(staged), false);
    assert.equal(
      fs.readFileSync(path.join(geminiHome, "antigravity-cli", "brain", "conv-123", "note.md"), "utf8"),
      "persisted",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test(
  "AcpConnection teardown preserves persistent acp-home and antigravity-cli/brain links across restarts",
  async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-conn-home-"));
  try {
    const geminiHome = path.join(tmp, "gemini");
    const stateDir = path.join(tmp, "bridge-state");
    fs.mkdirSync(path.join(geminiHome, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(geminiHome, "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "pi-bridge": { url: "http://127.0.0.1:9999/mcp" },
          "kept-one": { command: "echo", args: ["1"] },
        },
      }),
    );

    const fakeAcpScript = path.join(tmp, "fake-acp.mjs");
    fs.writeFileSync(
      fakeAcpScript,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const idx = process.argv.indexOf("--gemini-dir");',
        'const geminiDir = idx >= 0 ? process.argv[idx + 1] : "";',
        'process.on("SIGTERM", () => process.exit(0));',
        'process.stdin.setEncoding("utf8");',
        'let buf = "";',
        'process.stdin.on("data", (chunk) => {',
        "  buf += chunk;",
        '  const lines = buf.split("\\n");',
        '  buf = lines.pop() ?? "";',
        "  for (const line of lines) {",
        "    if (!line.trim()) continue;",
        "    const msg = JSON.parse(line);",
        '    if (msg.method === "initialize") {',
        '      const brainDir = path.join(geminiDir, "antigravity-cli", "brain", "conv-persist");',
        "      fs.mkdirSync(brainDir, { recursive: true });",
        '      const artFile = path.join(brainDir, "artifact.md");',
        "      if (!fs.existsSync(artFile)) fs.writeFileSync(artFile, \"artifact-from-agy\");",
        "      process.stdout.write(",
        "        JSON.stringify({",
        '          jsonrpc: "2.0",',
        "          id: msg.id,",
        '          result: { protocolVersion: 1, agentInfo: { name: "fake-agy", version: "1.5.4" } },',
        '        }) + "\\n",',
        "      );",
        "    }",
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    const runConnectionCycle = async () => {
      let resolveExit;
      const exited = new Promise((r) => {
        resolveExit = r;
      });
      const conn = new AcpConnection({
        cwd: tmp,
        bin: process.execPath,
        binArgs: [fakeAcpScript],
        isolateHome: { geminiHome, parentDir: stateDir },
        log: () => {},
        onUpdate: () => {},
        onExit: () => resolveExit(),
      });
      await conn.start();
      conn.kill();
      await exited;
    };

    await runConnectionCycle();

    const stagedHome = acpHomeDir(stateDir);
    const artifactViaStagedHome = path.join(
      stagedHome,
      "antigravity-cli",
      "brain",
      "conv-persist",
      "artifact.md",
    );
    const artifactUrl = pathToFileURL(artifactViaStagedHome).href;

    // After connection teardown (/reload or restart), file:// links into acp-home/antigravity-cli/brain survive.
    assert.equal(fs.existsSync(stagedHome), true);
    assert.equal(fs.readFileSync(fileURLToPath(artifactUrl), "utf8"), "artifact-from-agy");

    fs.writeFileSync(
      path.join(geminiHome, "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "pi-bridge-54321": { url: "http://127.0.0.1:8888/mcp" },
          "kept-two": { command: "echo", args: ["2"] },
        },
      }),
    );

    await runConnectionCycle();

    const updatedMcp = JSON.parse(
      fs.readFileSync(path.join(stagedHome, "config", "mcp_config.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(updatedMcp.mcpServers), ["kept-two"]);
    assert.equal(fs.readFileSync(fileURLToPath(artifactUrl), "utf8"), "artifact-from-agy");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sweepStaleAcpHomes cleans dead-PID acp-homes/* and agy-mcp-* while preserving live PIDs and acp-home", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-sweep-"));
  try {
    const geminiHome = path.join(tmp, "gemini");
    const stateDir = path.join(tmp, "antigravity-bridge");
    const persistentHome = stageAcpHome({ geminiHome, parentDir: stateDir });
    const transcriptPath = path.join(
      persistentHome,
      "antigravity-cli",
      "brain",
      "conv-keep",
      "transcript.jsonl",
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{"step_index":0}\n');

    const legacyHomes = acpHomeStagingDir(stateDir);
    const deadHome = path.join(legacyHomes, "acp-home-11111-dead");
    const liveHome = path.join(legacyHomes, "acp-home-22222-live");
    const selfHome = path.join(legacyHomes, `acp-home-${process.pid}-self`);
    fs.mkdirSync(deadHome, { recursive: true });
    fs.mkdirSync(liveHome, { recursive: true });
    fs.mkdirSync(selfHome, { recursive: true });

    const deadMcp = path.join(stateDir, "agy-mcp-11111");
    const liveMcp = path.join(stateDir, "agy-mcp-22222");
    const selfMcp = path.join(stateDir, `agy-mcp-${process.pid}`);
    const unrelatedDir = path.join(stateDir, "agy-mcp-notapid");
    fs.mkdirSync(deadMcp, { recursive: true });
    fs.mkdirSync(liveMcp, { recursive: true });
    fs.mkdirSync(selfMcp, { recursive: true });
    fs.mkdirSync(unrelatedDir, { recursive: true });

    sweepStaleAcpHomes(stateDir, (pid) => pid === 22222);

    assert.equal(fs.existsSync(deadHome), false);
    assert.equal(fs.existsSync(deadMcp), false);
    assert.equal(fs.existsSync(liveHome), true);
    assert.equal(fs.existsSync(selfHome), true);
    assert.equal(fs.existsSync(liveMcp), true);
    assert.equal(fs.existsSync(selfMcp), true);
    assert.equal(fs.existsSync(unrelatedDir), true);
    assert.equal(fs.existsSync(legacyHomes), true);
    assert.equal(fs.existsSync(persistentHome), true);

    // Once all legacy acp-homes entries are gone, sweep removes empty acp-homes too.
    removeStagedAcpHome(selfHome);
    sweepStaleAcpHomes(stateDir, () => false);

    assert.equal(fs.existsSync(liveHome), false);
    assert.equal(fs.existsSync(liveMcp), false);
    assert.equal(fs.existsSync(legacyHomes), false);
    assert.equal(fs.existsSync(selfMcp), true);
    assert.equal(fs.existsSync(unrelatedDir), true);
    assert.equal(fs.existsSync(persistentHome), true);
    assert.equal(fs.readFileSync(transcriptPath, "utf8"), '{"step_index":0}\n');

    // Passing an acp-homes directory directly sweeps dead-PID entries inside it.
    const directHomes = path.join(tmp, "direct", "acp-homes");
    const directDead = path.join(directHomes, "acp-home-44444-dead");
    const directLive = path.join(directHomes, "acp-home-33333-live");
    fs.mkdirSync(directDead, { recursive: true });
    fs.mkdirSync(directLive, { recursive: true });

    sweepStaleAcpHomes(directHomes, (pid) => pid === 33333);
    assert.equal(fs.existsSync(directDead), false);
    assert.equal(fs.existsSync(directLive), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("startMcpServer enforces x-bridge-token and serves tools/list and tools/call over loopback HTTP", async () => {
  const started = await startMcpServer({
    listTools: () => [
      {
        name: "echo_tool",
        description: "Echo input",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
    onToolCall: async (_callId, name, args) => ({
      content: [{ type: "text", text: `${name}:${args.message}` }],
    }),
  });

  assert.equal(started.ok, true);
  const { handle } = started;
  const url = `http://127.0.0.1:${handle.port}/mcp`;

  try {
    const unauth = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauth.status, 403);

    const client = new Client({ name: "ant-bridge-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { [TOKEN_HEADER]: handle.token } },
    });
    await client.connect(transport);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      ["echo_tool"],
    );

    const res = await client.callTool({ name: "echo_tool", arguments: { message: "hello" } });
    assert.equal(res.content[0].text, "echo_tool:hello");

    await client.close();
  } finally {
    await handle.close();
  }
});

test(
  "startMcpServer routes /mcp, /mcp/pi-bridge, and /mcp/ns/<ns>, resolves instructions, and fast-fails server/discover",
  async () => {
    const listCalls = [];
    const toolCalls = [];
    const instructionCalls = [];

    const started = await startMcpServer({
      instructions: (route) => {
        instructionCalls.push(route);
        if (route === "pi-bridge") return "Core bridge instructions";
        if (route === "ns:slack") return "Slack namespace instructions";
        return "   ";
      },
      listTools: (route) => {
        listCalls.push(route);
        if (route === "ns:slack") {
          return [
            {
              name: "search",
              description: "Search Slack",
              inputSchema: { type: "object", properties: { q: { type: "string" } } },
            },
          ];
        }
        return [
          {
            name: "core_ping",
            description: "Ping core",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      },
      onToolCall: async (_callId, name, args, _signal, route) => {
        toolCalls.push({ name, args, route });
        return {
          content: [{ type: "text", text: `${route}:${name}:${JSON.stringify(args)}` }],
          isError: false,
        };
      },
    });

    assert.equal(started.ok, true);
    const { handle } = started;
    const base = `http://127.0.0.1:${handle.port}`;
    const authHeaders = {
      [TOKEN_HEADER]: handle.token,
      "content-type": "application/json",
    };

    try {
      // Pre-auth /.well-known/ returns 404 even on GET without x-bridge-token.
      const wellKnown = await fetch(`${base}/.well-known/oauth-protected-resource`);
      assert.equal(wellKnown.status, 404);
      assert.deepEqual(await wellKnown.json(), { error: "not found" });

      // Unknown routes return 404 {"error":"not found"}.
      for (const badPath of [
        "/unknown",
        "/mcp/other",
        "/mcp/ns/",
        "/mcp/ns/UPPER",
        "/mcp/ns/foo_bar",
        "/mcp/ns/a/b",
        "/mcp/ns/..",
      ]) {
        const badRes = await fetch(`${base}${badPath}`, {
          method: "POST",
          headers: authHeaders,
          body: "{}",
        });
        assert.equal(badRes.status, 404, `expected 404 for ${badPath}`);
        assert.deepEqual(await badRes.json(), { error: "not found" });
      }

      // server/discover fast-fails without instantiating Server (no instructions resolution).
      const beforeInstrCount = instructionCalls.length;
      const discoverWithId = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "server/discover" }),
      });
      assert.equal(discoverWithId.status, 200);
      assert.match(discoverWithId.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await discoverWithId.json(), {
        jsonrpc: "2.0",
        id: 42,
        error: { code: -32601, message: "Method not found" },
      });

      const discoverZeroId = await fetch(`${base}/mcp/ns/slack`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover" }),
      });
      assert.equal(discoverZeroId.status, 200);
      assert.deepEqual(await discoverZeroId.json(), {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32601, message: "Method not found" },
      });

      const discoverNoId = await fetch(`${base}/mcp/pi-bridge`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "server/discover" }),
      });
      assert.equal(discoverNoId.status, 200);
      assert.deepEqual(await discoverNoId.json(), {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: "Method not found" },
      });
      assert.equal(instructionCalls.length, beforeInstrCount);

      // Connect MCP client to /mcp/pi-bridge -> route "pi-bridge", serverName "pi-bridge".
      const coreClient = new Client({ name: "test-core", version: "1.0.0" });
      await coreClient.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp/pi-bridge`), {
          requestInit: { headers: { [TOKEN_HEADER]: handle.token } },
        }),
      );
      assert.equal(coreClient.getServerVersion()?.name, "pi-bridge");
      assert.equal(coreClient.getInstructions(), "Core bridge instructions");
      const coreListed = await coreClient.listTools();
      assert.deepEqual(
        coreListed.tools.map((t) => t.name),
        ["core_ping"],
      );
      const coreCalled = await coreClient.callTool({ name: "core_ping", arguments: {} });
      assert.equal(coreCalled.content[0].text, "pi-bridge:core_ping:{}");
      await coreClient.close();

      // Connect MCP client to /mcp/ns/slack -> route "ns:slack", serverName "pi-bridge-slack".
      const slackClient = new Client({ name: "test-slack", version: "1.0.0" });
      await slackClient.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp/ns/slack`), {
          requestInit: { headers: { [TOKEN_HEADER]: handle.token } },
        }),
      );
      assert.equal(slackClient.getServerVersion()?.name, "pi-bridge-slack");
      assert.equal(slackClient.getInstructions(), "Slack namespace instructions");
      const slackListed = await slackClient.listTools();
      assert.deepEqual(
        slackListed.tools.map((t) => t.name),
        ["search"],
      );
      const slackCalled = await slackClient.callTool({
        name: "search",
        arguments: { q: "deploy" },
      });
      assert.equal(slackCalled.content[0].text, 'ns:slack:search:{"q":"deploy"}');
      await slackClient.close();

      // Blank instructions resolve to undefined on /mcp/ns/empty-instr.
      const quietClient = new Client({ name: "test-quiet", version: "1.0.0" });
      await quietClient.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp/ns/empty-instr`), {
          requestInit: { headers: { [TOKEN_HEADER]: handle.token } },
        }),
      );
      assert.equal(quietClient.getServerVersion()?.name, "pi-bridge-empty-instr");
      assert.equal(quietClient.getInstructions(), undefined);
      await quietClient.close();

      assert.deepEqual(listCalls, ["pi-bridge", "ns:slack"]);
      assert.deepEqual(toolCalls, [
        { name: "core_ping", args: {}, route: "pi-bridge" },
        { name: "search", args: { q: "deploy" }, route: "ns:slack" },
      ]);
    } finally {
      await handle.close();
    }
  },
);

test("startMcpServer accepts static string instructions", async () => {
  const started = await startMcpServer({
    instructions: "Static bridge guidance",
    listTools: () => [],
    onToolCall: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
  });
  assert.equal(started.ok, true);
  const { handle } = started;
  try {
    const client = new Client({ name: "test-static", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { [TOKEN_HEADER]: handle.token } },
      }),
    );
    assert.equal(client.getServerVersion()?.name, "pi-bridge");
    assert.equal(client.getInstructions(), "Static bridge guidance");
    await client.close();
  } finally {
    await handle.close();
  }
});

test("mapUpdate tags native mcp_pi-bridge* tools and call_mcp_tool targeting pi-bridge* servers", () => {
  // Eagerly registered namespace MCP tool: mcp_pi-bridge-<ns>_<tool>
  const eagerStart = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-ns-1",
    name: "mcp_pi-bridge-claude-in-chrome_read_page",
    rawInput: { arguments: { tabId: 3 } },
  });
  assert.equal(eagerStart.kind, "tool_start");
  assert.equal(eagerStart.name, "read_page");
  assert.equal(eagerStart.mcpServer, "pi-bridge-claude-in-chrome");
  assert.deepEqual(eagerStart.args, { tabId: 3 });

  const eagerDone = mapUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-ns-1",
    status: "completed",
    name: "mcp_pi-bridge-claude-in-chrome_read_page",
    content: [{ type: "content", content: { type: "text", text: "page body" } }],
  });
  assert.equal(eagerDone.kind, "tool_done");
  assert.equal(eagerDone.mcpServer, "pi-bridge-claude-in-chrome");

  // Unrelated native MCP server stays untagged without _meta.
  const externalMcp = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-ext-1",
    name: "mcp_github_list_issues",
    rawInput: {},
  });
  assert.equal(externalMcp.mcpServer, undefined);

  // Lazily invoked call_mcp_tool targeting pi-bridge* via ServerName / serverName / server.
  const lazyStart = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-lazy-1",
    name: "call_mcp_tool",
    rawInput: { ServerName: "pi-bridge-slack", ToolName: "search", Arguments: { q: "incident" } },
  });
  assert.equal(lazyStart.kind, "tool_start");
  assert.equal(lazyStart.name, "call_mcp_tool");
  assert.equal(lazyStart.mcpServer, "pi-bridge-slack");

  const lazyDoneCamel = mapUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-lazy-1",
    status: "completed",
    name: "call_mcp_tool",
    rawInput: { arguments: { serverName: "pi-bridge", toolName: "codemode" } },
    rawOutput: "done",
  });
  assert.equal(lazyDoneCamel.kind, "tool_done");
  assert.equal(lazyDoneCamel.mcpServer, "pi-bridge");

  const lazyFailedShort = mapUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-lazy-2",
    status: "failed",
    title: "Running call_mcp_tool",
    rawInput: { server: "pi-bridge-linear" },
    rawOutput: "boom",
  });
  assert.equal(lazyFailedShort.kind, "tool_error");
  assert.equal(lazyFailedShort.mcpServer, "pi-bridge-linear");

  const lazyProgress = mapUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-lazy-3",
    status: "in_progress",
    name: "call_mcp_tool",
    rawInput: { ServerName: "pi-bridge-github" },
  });
  assert.equal(lazyProgress.kind, "tool_update");
  assert.equal(lazyProgress.mcpServer, "pi-bridge-github");

  // call_mcp_tool targeting non-bridge server or non-call_mcp_tool with server arg stays undefined.
  const nonBridgeLazy = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-lazy-ext",
    name: "call_mcp_tool",
    rawInput: { ServerName: "external-mcp", ToolName: "ping" },
  });
  assert.equal(nonBridgeLazy.mcpServer, undefined);

  const unrelatedWithServerArg = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-other",
    name: "edit_file",
    rawInput: { Path: "a.ts", server: "pi-bridge" },
  });
  assert.equal(unrelatedWithServerArg.mcpServer, undefined);
});

const EXT_RELAY_SCRIPT = `
import net from "node:net";

if (process.argv[2] === "models") {
  process.stdout.write("gemini-4-carbon-high  Gemini 4 Carbon (High)\\n");
  process.exit(0);
}
if (process.argv[2] === "--version") {
  process.stdout.write("1.5.4\\n");
  process.exit(0);
}

const port = Number(process.env.FAKE_ACP_PORT);
const sock = net.createConnection({ host: "127.0.0.1", port });
sock.setEncoding("utf8");
process.stdin.setEncoding("utf8");

let connected = false;
const queued = [];
let stdinBuf = "";

process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  const lines = stdinBuf.split("\\n");
  stdinBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (connected) sock.write(line + "\\n");
    else queued.push(line);
  }
});

sock.on("connect", () => {
  connected = true;
  while (queued.length > 0) sock.write(queued.shift() + "\\n");
});

let sockBuf = "";
sock.on("data", (chunk) => {
  sockBuf += chunk;
  const lines = sockBuf.split("\\n");
  sockBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    process.stdout.write(line + "\\n");
  }
});

sock.on("close", () => process.exit(0));
sock.on("error", () => process.exit(1));
`;

async function createExtensionAcpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-mcp-ns-int-"));
  const relayPath = path.join(tmpDir, "fake-acp-relay.mjs");
  const launcherPath = path.join(tmpDir, "fake-agy.sh");
  fs.writeFileSync(relayPath, EXT_RELAY_SCRIPT, "utf8");
  fs.writeFileSync(
    launcherPath,
    `#!/bin/sh\nexec "${process.execPath}" "${relayPath}" "$@"\n`,
    { mode: 0o755 },
  );

  const received = [];
  const waiters = [];
  const sockets = new Set();
  let activeSocket = null;
  let sessionCounter = 0;

  function sendToClient(frame, sock = activeSocket) {
    if (!sock || sock.destroyed) return;
    sock.write(JSON.stringify(frame) + "\n");
  }

  function handleClientFrame(msg, sock) {
    received.push(msg);
    if (msg.method === "initialize") {
      sendToClient(
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: 1, agentInfo: { name: "fake-agy", version: "1.5.4" } },
        },
        sock,
      );
    } else if (msg.method === "session/new") {
      sessionCounter += 1;
      sendToClient(
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: `sess-${sessionCounter}`, configOptions: [] },
        },
        sock,
      );
    } else if (msg.method === "session/load" || msg.method === "session/set_config_option") {
      sendToClient({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } }, sock);
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve(msg);
      }
    }
  }

  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sockets.add(sock);
    activeSocket = sock;
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        handleClientFrame(JSON.parse(line), sock);
      }
    });
    sock.on("close", () => sockets.delete(sock));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    tmpDir,
    launcherPath,
    port,
    received,
    waitForFrame(pred, startIndex = 0) {
      for (let i = startIndex; i < received.length; i++) {
        if (pred(received[i])) return Promise.resolve(received[i]);
      }
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    sendUpdate(sessionId, update) {
      sendToClient({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    },
    replyPrompt(promptFrame, stopReason = "end_turn") {
      sendToClient({ jsonrpc: "2.0", id: promptFrame.id, result: { stopReason } });
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test(
  "extension exposes pi-bridge + pi-bridge-slack, partitions tools, routes tools/call, and suppresses pi-bridge-slack",
  async () => {
    const h = await createExtensionAcpHarness();
    const fakeHome = path.join(h.tmpDir, "home");
    const agentDir = path.join(h.tmpDir, "agent");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const prevHome = process.env.HOME;
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const prevAgyBin = process.env.AGY_BIN;
    const prevFakePort = process.env.FAKE_ACP_PORT;
    process.env.HOME = fakeHome;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.AGY_BIN = h.launcherPath;
    process.env.FAKE_ACP_PORT = String(h.port);

    const mockTools = [
      {
        name: "codemode",
        description: "Execute codemode batch script",
        parameters: { type: "object", properties: { code: { type: "string" } } },
        sourceInfo: { source: "builtin", path: "builtin:codemode" },
      },
      {
        name: "subagent",
        description: "Delegate work to subagent",
        parameters: { type: "object", properties: { task: { type: "string" } } },
        sourceInfo: { source: "extension", path: "/ext/subagent.ts" },
      },
      {
        name: "mcp__slack__slack_read_channel",
        description: "Read Slack channel messages",
        parameters: {
          type: "object",
          properties: { channel: { type: "string" } },
          required: ["channel"],
        },
        sourceInfo: { source: "builtin", path: "builtin:mcp" },
      },
    ];

    const handlers = new Map();
    const providers = new Map();
    const appendedEntries = [];
    const statusUpdates = [];
    const mockPi = {
      registerProvider(id, spec) {
        providers.set(id, spec);
      },
      registerCommand() {},
      registerTool() {},
      registerEntryRenderer() {},
      registerMessageRenderer() {},
      on(event, fn) {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
      getAllTools() {
        return mockTools;
      },
      getActiveTools() {
        return mockTools.map((t) => t.name);
      },
      getCommands() {
        return [
          {
            name: "skill:demo",
            description: "Demo skill",
            source: "skill",
            sourceInfo: { path: path.join(h.tmpDir, "SKILL.md") },
          },
        ];
      },
      appendEntry(customType, data) {
        appendedEntries.push({ customType, data });
      },
      sendMessage() {},
      events: { emit() {}, on() {} },
    };

    let coreClient = null;
    let slackClient = null;
    const sessionCtx = {
      hasUI: true,
      mode: "tui",
      cwd: h.tmpDir,
      ui: {
        theme: { fg: (_c, s) => s, bold: (s) => s },
        notify() {},
        setStatus(key, text) {
          statusUpdates.push({ key, text });
        },
      },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "mcp-ns-sess",
        getCwd: () => h.tmpDir,
        getEntries: () => [],
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "system",
              content: "",
              toolsAdded: [
                {
                  name: "mcp__slack__slack_read_channel",
                  description: "Live Slack channel reader",
                },
              ],
            },
          },
        ],
      },
    };

    try {
      saveConfig({ bridgeTools: "all" });
      await registerExtension(mockPi);

      for (const fn of handlers.get("session_start") ?? []) {
        await fn({ type: "session_start", reason: "startup" }, sessionCtx);
      }

      const providerSpec = providers.get("antigravity");
      const model = providerSpec.models[0];
      const userMsg = { role: "user", content: "Read Slack #general", timestamp: 1 };
      const stream1 = providerSpec.streamSimple(
        model,
        { messages: [userMsg] },
        { cwd: h.tmpDir, sessionId: "mcp-ns-sess" },
      );

      const sessionNewFrame = await h.waitForFrame((f) => f.method === "session/new");
      const promptFrame = await h.waitForFrame((f) => f.method === "session/prompt");

      // (1) mcpServers exposes pi-bridge (/mcp) and pi-bridge-slack (/mcp/ns/slack).
      const mcpServers = sessionNewFrame.params.mcpServers;
      assert.deepEqual(
        mcpServers.map((s) => s.name),
        ["pi-bridge", "pi-bridge-slack"],
      );
      const coreSrv = mcpServers[0];
      const slackSrv = mcpServers[1];
      assert.match(coreSrv.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.match(slackSrv.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/ns\/slack$/);
      assert.equal(coreSrv.type, "http");
      assert.equal(slackSrv.type, "http");

      const authHeaders = Object.fromEntries(coreSrv.headers.map((hdr) => [hdr.name, hdr.value]));

      // (2) /mcp lists core tools + bridge_poll_result without mcp__slack__* and serves instructions.
      coreClient = new Client({ name: "core-client", version: "1.0.0" });
      await coreClient.connect(
        new StreamableHTTPClientTransport(new URL(coreSrv.url), {
          requestInit: { headers: authHeaders },
        }),
      );
      assert.equal(coreClient.getServerVersion()?.name, "pi-bridge");
      assert.equal(coreClient.getInstructions(), PI_BRIDGE_INSTRUCTIONS);
      const coreToolsList = (await coreClient.listTools()).tools.map((t) => t.name);
      assert.equal(coreToolsList.includes("codemode"), true);
      assert.equal(coreToolsList.includes("subagent"), true);
      assert.equal(coreToolsList.includes("activate_skill"), true);
      assert.equal(coreToolsList.includes("bridge_poll_result"), true);
      assert.equal(
        coreToolsList.some((n) => n.includes("slack")),
        false,
      );
      const rejectedOnCore = await coreClient.callTool({
        name: "mcp__slack__slack_read_channel",
        arguments: { channel: "C123" },
      });
      assert.equal(rejectedOnCore.isError, true);

      // (3) /mcp/ns/slack lists ONLY slack_read_channel and routes tools/call to Pi's mcp__slack__slack_read_channel.
      slackClient = new Client({ name: "slack-client", version: "1.0.0" });
      await slackClient.connect(
        new StreamableHTTPClientTransport(new URL(slackSrv.url), {
          requestInit: { headers: authHeaders },
        }),
      );
      assert.equal(slackClient.getServerVersion()?.name, "pi-bridge-slack");
      assert.equal(slackClient.getInstructions(), PI_BRIDGE_INSTRUCTIONS);
      const slackToolsList = await slackClient.listTools();
      assert.deepEqual(
        slackToolsList.tools.map((t) => t.name),
        ["slack_read_channel"],
      );
      assert.equal(slackToolsList.tools[0].description, "Live Slack channel reader");

      const rejectedOnSlack = await slackClient.callTool({
        name: "unknown_slack_tool",
        arguments: {},
      });
      assert.equal(rejectedOnSlack.isError, true);

      const callPromise = slackClient.callTool({
        name: "slack_read_channel",
        arguments: { channel: "C123" },
      });

      const parkedMsg = await stream1.result();
      assert.equal(parkedMsg.stopReason, "toolUse");
      const toolCall = parkedMsg.content.find((c) => c.type === "toolCall");
      assert.equal(toolCall?.name, "mcp__slack__slack_read_channel");
      assert.deepEqual(toolCall?.arguments, { channel: "C123" });

      const streamCont = providerSpec.streamSimple(
        model,
        {
          messages: [
            userMsg,
            parkedMsg,
            {
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: "mcp__slack__slack_read_channel",
              content: [{ type: "text", text: "deploy succeeded in #general" }],
              isError: false,
              timestamp: 2,
            },
          ],
        },
        { cwd: h.tmpDir, sessionId: "mcp-ns-sess" },
      );

      const slackResult = await callPromise;
      assert.equal(slackResult.isError, false);
      assert.equal(slackResult.content[0].text, "deploy succeeded in #general");

      // (4) onNativeEvent suppresses pi-bridge-slack (both eager and lazy call_mcp_tool), while keeping native tools.
      const sessId = promptFrame.params.sessionId;
      h.sendUpdate(sessId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-slack-eager",
        name: "mcp_pi-bridge-slack_slack_read_channel",
        rawInput: { arguments: { channel: "C123" } },
      });
      h.sendUpdate(sessId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-slack-eager",
        status: "completed",
        name: "mcp_pi-bridge-slack_slack_read_channel",
        rawOutput: "suppressed",
      });
      h.sendUpdate(sessId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-slack-lazy",
        name: "call_mcp_tool",
        rawInput: { ServerName: "pi-bridge-slack", ToolName: "slack_read_channel" },
      });
      h.sendUpdate(sessId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-slack-lazy",
        status: "completed",
        name: "call_mcp_tool",
        rawInput: { ServerName: "pi-bridge-slack", ToolName: "slack_read_channel" },
        rawOutput: "suppressed lazy",
      });
      h.sendUpdate(sessId, {
        sessionUpdate: "tool_call",
        toolCallId: "tc-native-read",
        name: "read_file",
        rawInput: { Path: "README.md" },
      });
      h.sendUpdate(sessId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-native-read",
        status: "completed",
        name: "read_file",
        rawOutput: "file contents",
      });

      h.replyPrompt(promptFrame, "end_turn");
      const finalMsg = await streamCont.result();
      assert.equal(finalMsg.stopReason, "stop");

      const nativeEntries = appendedEntries.filter((e) => e.customType === "agy-native-event");
      assert.equal(nativeEntries.length, 1);
      assert.equal(nativeEntries[0].data.name, "read_file");
      assert.equal(
        statusUpdates.some((s) => s.key === "agy-native" && (s.text ?? "").includes("slack")),
        false,
      );
    } finally {
      try {
        await coreClient?.close();
      } catch {}
      try {
        await slackClient?.close();
      } catch {}
      for (const fn of handlers.get("session_shutdown") ?? []) {
        await fn({ type: "session_shutdown" }, sessionCtx);
      }
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevAgyBin === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = prevAgyBin;
      if (prevFakePort === undefined) delete process.env.FAKE_ACP_PORT;
      else process.env.FAKE_ACP_PORT = prevFakePort;
      await h.close();
    }
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fs.existsSync(h.tmpDir), false);
  },
);
