import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

test("extension registers antigravity provider and /agy command without registering any Pi tools", async () => {
  const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-ext-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

  try {
    const mod = await importBridgeModule("extensions/index.ts");
    const registerExtension = mod.default;

    const providers = new Map();
    const commands = new Map();
    const tools = [];
    const entryRenderers = new Set();
    const messageRenderers = new Set();
    const handlers = new Map();

    const mockPi = {
      registerProvider(id, spec) {
        providers.set(id, spec);
      },
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerTool(spec) {
        tools.push(spec);
      },
      registerEntryRenderer(customType) {
        entryRenderers.add(customType);
      },
      registerMessageRenderer(customType) {
        messageRenderers.add(customType);
      },
      on(event, fn) {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
      getAllTools() {
        return [];
      },
      getActiveTools() {
        return [];
      },
      appendEntry() {},
      sendMessage() {},
      events: { emit() {}, on() {} },
    };

    await registerExtension(mockPi);

    assert.equal(providers.has("antigravity"), true);
    const providerSpec = providers.get("antigravity");
    assert.equal(typeof providerSpec.streamSimple, "function");
    assert.equal(Array.isArray(providerSpec.models), true);
    assert.equal(providerSpec.models.length > 0, true);

    assert.equal(commands.has("agy"), true);
    assert.deepEqual(tools, []);
    assert.equal(entryRenderers.has("agy-native-event"), true);
    assert.equal(entryRenderers.has("agy-poll-run"), true);
    assert.equal(messageRenderers.size, 0);
    assert.equal(handlers.has("session_start"), true);
    assert.equal(handlers.has("session_shutdown"), true);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});
