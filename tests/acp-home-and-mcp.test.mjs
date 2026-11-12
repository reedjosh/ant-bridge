import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { removeStagedAcpHome, stageAcpHome } = await importBridgeModule("src/acp/home.ts");
const { TOKEN_HEADER, startMcpServer } = await importBridgeModule("src/mcp-server.ts");

test("stageAcpHome creates and symlinks antigravity-cli on a fresh install and filters pi-bridge MCP entries", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-home-"));
  try {
    const geminiHome = path.join(tmp, "gemini");
    const stagingDir = path.join(tmp, "staging");
    fs.mkdirSync(path.join(geminiHome, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(geminiHome, "config", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "pi-bridge": { url: "http://127.0.0.1:9999/mcp" },
          "pi-bridge-12345": { url: "http://127.0.0.1:9998/mcp" },
          "custom-server": { command: "echo", args: ["ok"] },
        },
      }),
    );

    const staged = stageAcpHome({ geminiHome, stagingDir, pid: process.pid });
    const appDataLink = path.join(staged, "antigravity-cli");
    assert.equal(fs.lstatSync(appDataLink).isSymbolicLink(), true);

    // Conversations written via the staged home must survive cleanup.
    fs.mkdirSync(path.join(appDataLink, "brain", "conv-123"), { recursive: true });
    fs.writeFileSync(path.join(appDataLink, "brain", "conv-123", "note.md"), "persisted");

    const stagedMcp = JSON.parse(fs.readFileSync(path.join(staged, "config", "mcp_config.json"), "utf8"));
    assert.deepEqual(Object.keys(stagedMcp.mcpServers), ["custom-server"]);

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
