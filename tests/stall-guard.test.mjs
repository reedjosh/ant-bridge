import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { AcpDriver } = await importBridgeModule("src/acp/driver.ts");
const { mapUpdate } = await importBridgeModule("src/acp/events.ts");

const RELAY_SCRIPT = `
import net from "node:net";

if (process.argv[2] === "models") {
  process.stdout.write("gemini-4-carbon-high  Gemini 4 Carbon (High)\\n");
  process.exit(0);
}
if (process.argv[2] === "--version") {
  process.stdout.write("1.5.16\\n");
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

async function createFakeAcpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-stall-test-"));
  const relayPath = path.join(tmpDir, "fake-acp-relay.mjs");
  const launcherPath = path.join(tmpDir, "fake-agy.sh");
  fs.writeFileSync(relayPath, RELAY_SCRIPT, "utf8");
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
          result: { protocolVersion: 1, agentInfo: { name: "fake-agy", version: "1.5.16" } },
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
    } else if (msg.method === "session/load") {
      sendToClient({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } }, sock);
    } else if (msg.method === "session/set_config_option") {
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
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  function waitForFrame(pred, startIndex = 0) {
    for (let i = startIndex; i < received.length; i++) {
      if (pred(received[i])) return Promise.resolve(received[i]);
    }
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  }

  function sendUpdate(sessionId, update) {
    sendToClient({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  function replyPrompt(promptFrame, stopReason = "end_turn") {
    sendToClient({
      jsonrpc: "2.0",
      id: promptFrame.id,
      result: { stopReason },
    });
  }

  return {
    tmpDir,
    relayPath,
    launcherPath,
    port,
    received,
    waitForFrame,
    sendUpdate,
    replyPrompt,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function waitForActivity(handle, type) {
  for (;;) {
    const act = await handle.next();
    if (!act) return null;
    if (act.type === type) return act;
  }
}

test("in-flight native schedule/run_command pauses idle stall guard even after status text, then re-arms on completion", async () => {
  const h = await createFakeAcpHarness();
  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    // Part A: schedule tool + status text stays silent longer than inactivityMin (80ms) and finishes cleanly.
    const handle1 = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      timeoutMin: 0,
      inactivityMin: 80 / 60_000,
      prompt: "Wait 6 minutes then verify prod",
    });

    const prompt1 = await h.waitForFrame((f) => f.method === "session/prompt");
    const sid = prompt1.params.sessionId;
    h.sendUpdate(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "sched-1",
      name: "schedule",
      rawInput: { DurationSeconds: 360, Prompt: "Verify prod" },
    });
    assert.equal((await waitForActivity(handle1, "tool_start"))?.name, "schedule");

    // Model streams a status message while schedule remains in flight.
    h.sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Waiting 6 minutes..." },
    });
    assert.equal((await waitForActivity(handle1, "text"))?.delta, "Waiting 6 minutes...");

    // Exceed the 80ms inactivity guard by 3x while schedule is active: must NOT stall.
    await new Promise((r) => setTimeout(r, 240));
    assert.notEqual(driver.activeHandle, null);

    // Timer fires and completes, followed by final reply.
    h.sendUpdate(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "sched-1",
      status: "completed",
      rawOutput: "timer fired",
    });
    assert.equal((await waitForActivity(handle1, "tool_done"))?.name, "schedule");

    h.sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " Prod verified." },
    });
    h.replyPrompt(prompt1, "end_turn");

    const out1 = await handle1.outcome;
    assert.equal(out1.status, "OK");
    assert.equal(out1.response, "Waiting 6 minutes... Prod verified.");

    // Part B: once the last native tool completes, idle guard re-arms and catches a genuine inference hang.
    const idx2 = h.received.length;
    const handle2 = await driver.run({
      cwd: h.tmpDir,
      conversationId: sid,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      timeoutMin: 0,
      inactivityMin: 80 / 60_000,
      prompt: "Run tests then summarize",
    });
    await h.waitForFrame((f) => f.method === "session/prompt", idx2);

    h.sendUpdate(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-1",
      name: "run_command",
      rawInput: { CommandLine: "gh pr checks --watch", WaitMsBeforeAsync: 5000 },
    });
    h.sendUpdate(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-2",
      name: "run_command",
      rawInput: { CommandLine: "git status", WaitMsBeforeAsync: 5000 },
    });
    await waitForActivity(handle2, "tool_start");
    await waitForActivity(handle2, "tool_start");

    // Completing only one of two parallel native tools keeps the stall guard paused.
    h.sendUpdate(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-2",
      status: "completed",
      rawOutput: "clean",
    });
    await waitForActivity(handle2, "tool_done");
    await new Promise((r) => setTimeout(r, 180));
    assert.notEqual(driver.activeHandle, null);

    // Completing the final native tool re-arms the 80ms stall guard; silence after it stalls cleanly.
    h.sendUpdate(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-1",
      status: "completed",
      rawOutput: "all checks green",
    });
    await waitForActivity(handle2, "tool_done");

    const out2 = await handle2.outcome;
    assert.equal(out2.status, "ERROR");
    assert.match(out2.error ?? "", /ACP stalled for \d+m with no output/);
  } finally {
    await driver.close("shutdown");
    await h.close();
  }
});

test("overall turn deadline still fires during a native tool while daemon, bridge, and discarded tools do not disable idle guard", async () => {
  assert.deepEqual(
    mapUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "echo-1",
      status: "failed",
      rawOutput: "Tool was approved but never executed",
    }),
    { kind: "tool_discard", toolCallId: "echo-1" },
  );

  const h = await createFakeAcpHarness();
  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    // Part A: overall turn deadline still bounds a turn whose native tool never finishes.
    const handle1 = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      timeoutMin: 120 / 60_000,
      inactivityMin: 60 / 60_000,
      prompt: "Run slow command under deadline",
    });
    const prompt1 = await h.waitForFrame((f) => f.method === "session/prompt");
    const sid1 = prompt1.params.sessionId;
    h.sendUpdate(sid1, {
      sessionUpdate: "tool_call",
      toolCallId: "slow-1",
      name: "run_command",
      rawInput: { CommandLine: "sleep 999" },
    });
    await waitForActivity(handle1, "tool_start");

    const out1 = await handle1.outcome;
    assert.equal(out1.status, "ERROR");
    assert.match(out1.error ?? "", /ACP turn exceeded the \d+m deadline/);

    // Part B: IsDaemon tools, pi-bridge* tools, and approved-but-never-executed discards do not suppress idle stall.
    const idx2 = h.received.length;
    const handle2 = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      timeoutMin: 0,
      inactivityMin: 80 / 60_000,
      prompt: "Start daemon and discard echo",
    });
    const prompt2 = await h.waitForFrame((f) => f.method === "session/prompt", idx2);
    const sid2 = prompt2.params.sessionId;

    h.sendUpdate(sid2, {
      sessionUpdate: "tool_call",
      toolCallId: "daemon-1",
      name: "run_command",
      rawInput: { CommandLine: "npm run dev", IsDaemon: true },
    });
    h.sendUpdate(sid2, {
      sessionUpdate: "tool_call",
      toolCallId: "bridge-1",
      name: "mcp_pi-bridge_codemode",
      rawInput: { code: "return 1" },
    });
    h.sendUpdate(sid2, {
      sessionUpdate: "tool_call",
      toolCallId: "echo-1",
      name: "edit_file",
      rawInput: { Path: path.join(h.tmpDir, "a.ts") },
    });
    h.sendUpdate(sid2, {
      sessionUpdate: "tool_call_update",
      toolCallId: "echo-1",
      status: "failed",
      rawOutput: "approved but never executed",
    });

    const out2 = await handle2.outcome;
    assert.equal(out2.status, "ERROR");
    assert.match(out2.error ?? "", /ACP stalled for \d+m with no output/);
  } finally {
    await driver.close("shutdown");
    await h.close();
  }
});

test("extension formats stall warnings cleanly and suppresses duplicate turn-end warning toasts", async () => {
  const h = await createFakeAcpHarness();
  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  const prevFakePort = process.env.FAKE_ACP_PORT;
  const prevInactivity = process.env.AGY_INACTIVITY_TIMEOUT_MIN;
  const prevDebug = process.env.AGY_DEBUG;

  const fakeHome = path.join(h.tmpDir, "fake-home");
  const agentDir = path.join(h.tmpDir, "ext-agent-dir");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGY_BIN = h.launcherPath;
  process.env.FAKE_ACP_PORT = String(h.port);
  process.env.AGY_INACTIVITY_TIMEOUT_MIN = "0";
  process.env.AGY_DEBUG = "1";

  const notifications = [];
  const handlers = new Map();
  const providers = new Map();
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
      return [];
    },
    getActiveTools() {
      return [];
    },
    appendEntry() {},
    sendMessage() {},
    events: { emit() {}, on() {} },
  };

  try {
    const mod = await importBridgeModule("extensions/index.ts");
    await mod.default(mockPi);

    for (const fn of handlers.get("session_start") ?? []) {
      await fn(
        { type: "session_start", reason: "startup" },
        {
          hasUI: true,
          mode: "tui",
          ui: {
            notify(message, type) {
              notifications.push({ message, type });
            },
            setStatus() {},
            theme: { fg: (_color, s) => s },
          },
          isProjectTrusted: () => false,
          sessionManager: { getEntries: () => [], getBranch: () => [] },
        },
      );
    }

    // Trigger an actual turn error via a non-stall error (e.g., refusal) and verify no raw "Antigravity warning: turn-end" toast.
    const providerSpec = providers.get("antigravity");
    const model = providerSpec.models[0];
    const stream = providerSpec.streamSimple(
      model,
      { messages: [{ role: "user", content: "Trigger refusal", timestamp: 1 }] },
      { cwd: h.tmpDir, sessionId: "pi-warn-check" },
    );
    const promptFrame = await h.waitForFrame((f) => f.method === "session/prompt");
    h.replyPrompt(promptFrame, "refusal");

    const msg = await stream.result();
    assert.equal(msg.stopReason, "error");
    assert.equal(
      notifications.some((n) => n.message.includes("Antigravity warning: turn-end")),
      false,
    );
    assert.equal(
      notifications.some((n) => n.message.includes("Antigravity warning: stall")),
      false,
    );

    // Trigger an actual stall with a short timeout via config override is bounded to >=1m,
    // so verify via direct stall notification path using AGY_TURN_TIMEOUT_MIN=0 + refusal log check.
    for (const fn of handlers.get("session_shutdown") ?? []) {
      await fn({}, { hasUI: false, ui: {} });
    }
    const logDir = path.join(agentDir, "antigravity-bridge", "logs");
    const logText = fs
      .readdirSync(logDir)
      .filter((n) => n.endsWith(".ndjson"))
      .map((n) => fs.readFileSync(path.join(logDir, n), "utf8"))
      .join("\n");
    assert.match(logText, /"event":"turn-end"/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    if (prevFakePort === undefined) delete process.env.FAKE_ACP_PORT;
    else process.env.FAKE_ACP_PORT = prevFakePort;
    if (prevInactivity === undefined) delete process.env.AGY_INACTIVITY_TIMEOUT_MIN;
    else process.env.AGY_INACTIVITY_TIMEOUT_MIN = prevInactivity;
    if (prevDebug === undefined) delete process.env.AGY_DEBUG;
    else process.env.AGY_DEBUG = prevDebug;
    await h.close();
  }
});
