import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { AcpDriver } = await importBridgeModule("src/acp/driver.ts");
const { entriesFromRaw, toPiModel } = await importBridgeModule("src/models.ts");
const { createStreamSimple, ToolRoundTrips } = await importBridgeModule("src/provider.ts");
const { SessionStore } = await importBridgeModule("src/sessions.ts");

const RELAY_SCRIPT = `
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
  while (queued.length > 0) {
    sock.write(queued.shift() + "\\n");
  }
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-steer-test-"));
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
  let onSessionNew = null;
  let onSessionLoad = null;

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
      if (onSessionNew) {
        const handler = onSessionNew;
        onSessionNew = null;
        handler(msg, sock);
      } else {
        sessionCounter += 1;
        sendToClient(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: { sessionId: `sess-${sessionCounter}`, configOptions: [] },
          },
          sock,
        );
      }
    } else if (msg.method === "session/load") {
      if (onSessionLoad) {
        const handler = onSessionLoad;
        onSessionLoad = null;
        handler(msg, sock);
      } else {
        sendToClient({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } }, sock);
      }
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
    sock.on("close", () => {
      sockets.delete(sock);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  function waitForFrame(pred, startIndex = 0) {
    for (let i = startIndex; i < received.length; i++) {
      if (pred(received[i])) return Promise.resolve(received[i]);
    }
    return new Promise((resolve) => {
      waiters.push({ pred, resolve });
    });
  }

  function sendUpdate(sessionId, update) {
    sendToClient({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  function replyPrompt(promptFrame, stopReason = "end_turn", usage = undefined) {
    sendToClient({
      jsonrpc: "2.0",
      id: promptFrame.id,
      result: { stopReason, ...(usage ? { usage } : {}) },
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
    sendToClient,
    interceptNextSessionNew(fn) {
      onSessionNew = fn;
    },
    interceptNextSessionLoad(fn) {
      onSessionLoad = fn;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function makeModelAndEntries() {
  const entries = entriesFromRaw("gemini-4-carbon-high  Gemini 4 Carbon (High)\n");
  const model = toPiModel(entries[0], ["text", "image"]);
  return { entries, model };
}

function promptTextFromFrame(frame) {
  const blocks = frame?.params?.prompt ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

test(
  "immediate steer sends session/cancel, settles as stop, skips background arm, and resumes with steer delta",
  async () => {
  const h = await createFakeAcpHarness();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(h.tmpDir, "agent-dir");

  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    const { entries, model } = makeModelAndEntries();
    const store = new SessionStore(path.join(h.tmpDir, "sessions.json"));
    const roundTrips = new ToolRoundTrips(driver);
    const bgArmed = [];
    const outcomes = [];
    driver.onTurnEnd = (o) => outcomes.push(o);

    const streamSimple = createStreamSimple({
      entries,
      store,
      acpDriver: driver,
      roundTrips,
      onNativeBackground: (info) => bgArmed.push(info),
    });

    const context1 = {
      messages: [{ role: "user", content: "Refactor the entire codebase", timestamp: 1 }],
    };
    const stream1 = streamSimple(model, context1, { cwd: h.tmpDir, sessionId: "pi-1" });

    const prompt1 = await h.waitForFrame((f) => f.method === "session/prompt");
    const sessionId = prompt1.params.sessionId;
    assert.equal(sessionId, "sess-1");
    assert.match(promptTextFromFrame(prompt1), /Refactor the entire codebase/);

    // Complete a background-shaped native tool first so nativeBackgroundSeen is true,
    // then stream text with toolCalls.size === 0 before steering.
    h.sendUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "bg-1",
      name: "run_command",
      rawInput: { CommandLine: "npm run watch", WaitMsBeforeAsync: 500 },
    });
    h.sendUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "bg-1",
      status: "completed",
      rawOutput: "backgrounded",
    });
    h.sendUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Working on refactor..." },
    });

    // Wait for stream1 to emit text_delta so we know the chunk reached the driver.
    const iter1 = stream1[Symbol.asyncIterator]();
    let sawTextDelta = false;
    while (!sawTextDelta) {
      const step = await iter1.next();
      if (step.done) break;
      if (step.value.type === "text_delta") sawTextDelta = true;
    }
    assert.equal(sawTextDelta, true);

    const frameIdxBeforeSteer = h.received.length;
    assert.equal(driver.interruptForSteer(), true);
    // Idempotent when called twice on the same turn.
    assert.equal(driver.interruptForSteer(), true);

    const cancelFrame = await h.waitForFrame(
      (f) => f.method === "session/cancel",
      frameIdxBeforeSteer,
    );
    assert.equal(cancelFrame.params.sessionId, "sess-1");

    h.replyPrompt(prompt1, "cancelled");
    const msg1 = await stream1.result();

    assert.equal(msg1.stopReason, "stop");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "OK");
    assert.equal(outcomes[0].aborted, false);
    assert.equal(outcomes[0].steered, true);
    assert.equal(outcomes[0].conversationId, "sess-1");
    // Steered turn must NOT arm the post-turn background watcher.
    assert.deepEqual(bgArmed, []);

    // SessionStore bound sess-1 and advanced lastMessageCount to 1.
    const saved = store.get("sid:pi-1@acp");
    assert.deepEqual(saved, {
      conversationId: "sess-1",
      lastStepIdx: -1,
      lastMessageCount: 1,
    });

    // Subsequent Pi turn appends the interrupted assistant message and the steer message.
    const frameIdxTurn2 = h.received.length;
    const context2 = {
      messages: [
        ...context1.messages,
        msg1,
        { role: "user", content: "Stop, only update src/foo.ts", timestamp: 2 },
      ],
    };
    const stream2 = streamSimple(model, context2, { cwd: h.tmpDir, sessionId: "pi-1" });

    const load2 = await h.waitForFrame((f) => f.method === "session/load", frameIdxTurn2);
    assert.equal(load2.params.sessionId, "sess-1");

    const prompt2 = await h.waitForFrame((f) => f.method === "session/prompt", frameIdxTurn2);
    assert.equal(prompt2.params.sessionId, "sess-1");
    assert.equal(promptTextFromFrame(prompt2), "Stop, only update src/foo.ts");

    h.sendUpdate("sess-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Updated src/foo.ts only." },
    });
    h.replyPrompt(prompt2, "end_turn");

    const msg2 = await stream2.result();
    assert.equal(msg2.stopReason, "stop");
    assert.equal(outcomes[1].steered, undefined);
    assert.deepEqual(store.get("sid:pi-1@acp"), {
      conversationId: "sess-1",
      lastStepIdx: -1,
      lastMessageCount: 3,
    });
  } finally {
    await driver.close("shutdown");
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    await h.close();
  }
});

test("tool grace waits for fast edit_file completion and expires promptly on slow run_command", async () => {
  const h = await createFakeAcpHarness();
  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    // Part A: in-flight edit_file delays session/cancel until tool_done arrives.
    const handle1 = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      prompt: "Edit target.ts",
    });

    const prompt1 = await h.waitForFrame((f) => f.method === "session/prompt");
    const sid1 = prompt1.params.sessionId;
    h.sendUpdate(sid1, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      name: "edit_file",
      rawInput: { Path: path.join(h.tmpDir, "target.ts") },
    });

    const firstAct = await handle1.next();
    assert.equal(firstAct?.type, "usage");
    const toolStartAct = await handle1.next();
    assert.equal(toolStartAct?.type, "tool_start");
    assert.equal(toolStartAct?.name, "edit_file");

    const idxBeforeSteer1 = h.received.length;
    assert.equal(driver.interruptForSteer({ toolGraceMs: 2_000 }), true);

    await new Promise((r) => setTimeout(r, 35));
    assert.equal(
      h.received.slice(idxBeforeSteer1).some((f) => f.method === "session/cancel"),
      false,
    );

    // Completing edit_file triggers session/cancel immediately without waiting 2000ms.
    const doneAt = Date.now();
    h.sendUpdate(sid1, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: "completed",
      rawOutput: "edited",
    });
    const cancel1 = await h.waitForFrame((f) => f.method === "session/cancel", idxBeforeSteer1);
    assert.equal(cancel1.params.sessionId, sid1);
    assert.equal(Date.now() - doneAt < 500, true);

    h.replyPrompt(prompt1, "cancelled");
    const out1 = await handle1.outcome;
    assert.equal(out1.status, "OK");
    assert.equal(out1.aborted, false);
    assert.equal(out1.steered, true);

    // Part B: slow run_command that never finishes cancels once toolGraceMs elapses.
    const idxTurn2 = h.received.length;
    const handle2 = await driver.run({
      cwd: h.tmpDir,
      conversationId: sid1,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      prompt: "Run slow suite",
    });

    const prompt2 = await h.waitForFrame((f) => f.method === "session/prompt", idxTurn2);
    h.sendUpdate(sid1, {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-slow",
      name: "run_command",
      rawInput: { CommandLine: "sleep 60" },
    });

    let act2 = await handle2.next();
    while (act2 && act2.type !== "tool_start") {
      act2 = await handle2.next();
    }
    assert.equal(act2?.type, "tool_start");

    const steerStart = Date.now();
    const idxBeforeSteer2 = h.received.length;
    assert.equal(driver.interruptForSteer({ toolGraceMs: 60 }), true);
    assert.equal(
      h.received.slice(idxBeforeSteer2).some((f) => f.method === "session/cancel"),
      false,
    );

    const cancel2 = await h.waitForFrame((f) => f.method === "session/cancel", idxBeforeSteer2);
    const elapsed = Date.now() - steerStart;
    assert.equal(cancel2.params.sessionId, sid1);
    assert.equal(elapsed >= 45, true);

    h.replyPrompt(prompt2, "cancelled");
    const out2 = await handle2.outcome;
    assert.equal(out2.status, "OK");
    assert.equal(out2.aborted, false);
    assert.equal(out2.steered, true);
  } finally {
    await driver.close("shutdown");
    await h.close();
  }
});

test("Esc abort after interruptForSteer wins with aborted=true and stopReason=aborted", async () => {
  const h = await createFakeAcpHarness();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(h.tmpDir, "agent-dir");

  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    const { entries, model } = makeModelAndEntries();
    const store = new SessionStore(path.join(h.tmpDir, "sessions.json"));
    const roundTrips = new ToolRoundTrips(driver);
    const outcomes = [];
    driver.onTurnEnd = (o) => outcomes.push(o);

    const streamSimple = createStreamSimple({
      entries,
      store,
      acpDriver: driver,
      roundTrips,
    });

    const ac = new AbortController();
    const stream = streamSimple(
      model,
      { messages: [{ role: "user", content: "Long task", timestamp: 1 }] },
      { cwd: h.tmpDir, sessionId: "pi-esc", signal: ac.signal },
    );

    const promptFrame = await h.waitForFrame((f) => f.method === "session/prompt");
    const idxBeforeSteer = h.received.length;

    // Steer first, then user presses Esc before the server finishes canceling.
    assert.equal(driver.interruptForSteer(), true);
    await h.waitForFrame((f) => f.method === "session/cancel", idxBeforeSteer);

    ac.abort();
    h.replyPrompt(promptFrame, "cancelled");

    const finalMsg = await stream.result();
    assert.equal(finalMsg.stopReason, "aborted");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].aborted, true);
    assert.equal(outcomes[0].steered, undefined);
    // Aborted fresh turn does not commit an unbound session watermark.
    assert.equal(store.get("sid:pi-esc@acp"), null);
  } finally {
    await driver.close("shutdown");
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    await h.close();
  }
});

test("parked MCP turn refuses interruptForSteer and sends no session/cancel", async () => {
  const h = await createFakeAcpHarness();
  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    const handle = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      prompt: "Call a bridged Pi tool",
    });

    const promptFrame = await h.waitForFrame((f) => f.method === "session/prompt");
    const idxBeforePark = h.received.length;

    // Simulate ToolRoundTrips parking the turn on a bridged MCP call.
    handle.pushExternal({
      type: "bridge_call",
      callId: "call-1",
      name: "ask_user_question",
      args: { question: "Proceed?" },
    });

    assert.equal(driver.interruptForSteer(), false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      h.received.slice(idxBeforePark).some((f) => f.method === "session/cancel"),
      false,
    );

    // Unpark and finish cleanly.
    driver.kickIdle();
    h.replyPrompt(promptFrame, "end_turn");
    const outcome = await handle.outcome;
    assert.equal(outcome.status, "OK");
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.steered, undefined);
  } finally {
    await driver.close("shutdown");
    await h.close();
  }
});

test("pre-promptStarted steer lets session/new and session/load send prompt before session/cancel", async () => {
  const h = await createFakeAcpHarness();
  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
  });

  try {
    // Case A: interruptForSteer while session/new is still in flight.
    let releaseNew;
    const sessionNewArrived = new Promise((resolve) => {
      h.interceptNextSessionNew((msg, sock) => {
        releaseNew = () => {
          h.sendToClient(
            { jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-pre-1", configOptions: [] } },
            sock,
          );
        };
        resolve(msg);
      });
    });

    const handle1 = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      prompt: "Initial user question",
    });

    await sessionNewArrived;
    assert.equal(driver.interruptForSteer(), true);
    assert.equal(
      h.received.some((f) => f.method === "session/cancel"),
      false,
    );

    releaseNew();
    const prompt1 = await h.waitForFrame((f) => f.method === "session/prompt");
    const cancel1 = await h.waitForFrame((f) => f.method === "session/cancel");

    const prompt1Idx = h.received.indexOf(prompt1);
    const cancel1Idx = h.received.indexOf(cancel1);
    assert.equal(prompt1Idx >= 0 && cancel1Idx > prompt1Idx, true);
    assert.equal(promptTextFromFrame(prompt1), "Initial user question");
    assert.equal(cancel1.params.sessionId, "sess-pre-1");

    h.replyPrompt(prompt1, "cancelled");
    const out1 = await handle1.outcome;
    assert.equal(out1.status, "OK");
    assert.equal(out1.aborted, false);
    assert.equal(out1.steered, true);
    assert.equal(out1.conversationId, "sess-pre-1");

    // Case B: interruptForSteer while session/load is still in flight.
    const idxTurn2 = h.received.length;
    let releaseLoad;
    const sessionLoadArrived = new Promise((resolve) => {
      h.interceptNextSessionLoad((msg, sock) => {
        releaseLoad = () => {
          h.sendToClient({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } }, sock);
        };
        resolve(msg);
      });
    });

    const handle2 = await driver.run({
      cwd: h.tmpDir,
      conversationId: "sess-pre-1",
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      prompt: "Follow-up user question",
    });

    await sessionLoadArrived;
    assert.equal(driver.interruptForSteer(), true);
    assert.equal(
      h.received.slice(idxTurn2).some((f) => f.method === "session/cancel"),
      false,
    );

    releaseLoad();
    const prompt2 = await h.waitForFrame((f) => f.method === "session/prompt", idxTurn2);
    const cancel2 = await h.waitForFrame((f) => f.method === "session/cancel", idxTurn2);

    const prompt2Idx = h.received.indexOf(prompt2, idxTurn2);
    const cancel2Idx = h.received.indexOf(cancel2, idxTurn2);
    assert.equal(prompt2Idx >= 0 && cancel2Idx > prompt2Idx, true);
    assert.equal(promptTextFromFrame(prompt2), "Follow-up user question");

    h.replyPrompt(prompt2, "cancelled");
    const out2 = await handle2.outcome;
    assert.equal(out2.status, "OK");
    assert.equal(out2.aborted, false);
    assert.equal(out2.steered, true);
  } finally {
    await driver.close("shutdown");
    await h.close();
  }
});

test("steer safety-net kills unresponsive server and settles steered=true without aborting", async () => {
  const h = await createFakeAcpHarness();
  const driver = new AcpDriver({
    bin: process.execPath,
    binArgs: [h.relayPath, "acp"],
    extraEnv: { FAKE_ACP_PORT: String(h.port) },
    cancelSafetyMs: 60,
  });

  try {
    const handle = await driver.run({
      cwd: h.tmpDir,
      model: "gemini-4-carbon",
      effort: "high",
      mode: "accept-edits",
      skipPermissions: true,
      prompt: "Stuck server prompt",
    });

    const promptFrame = await h.waitForFrame((f) => f.method === "session/prompt");
    const sid = promptFrame.params.sessionId;
    h.sendUpdate(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Partial before hang" },
    });
    await handle.next();
    await handle.next();

    assert.equal(driver.interruptForSteer(), true);
    await h.waitForFrame((f) => f.method === "session/cancel");
    // Server never replies to session/prompt; cancelSafetyMs tears down and settles as steered.
    const outcome = await handle.outcome;
    assert.equal(outcome.status, "OK");
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.steered, true);
    assert.equal(outcome.conversationId, sid);
    assert.equal(outcome.response, "Partial before hang");
  } finally {
    await driver.close("shutdown");
    await h.close();
  }
});

test("extension input handler interrupts only active non-parked antigravity steer events", async () => {
  const h = await createFakeAcpHarness();
  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  const prevFakePort = process.env.FAKE_ACP_PORT;
  const prevDebug = process.env.AGY_DEBUG;
  const fakeHome = path.join(h.tmpDir, "fake-home");
  const agentDir = path.join(h.tmpDir, "ext-agent-dir");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGY_BIN = h.launcherPath;
  process.env.FAKE_ACP_PORT = String(h.port);
  process.env.AGY_DEBUG = "1";

  const mockTools = [
    {
      name: "mcp_slack_post",
      description: "Post message",
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
  ];
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
      return mockTools;
    },
    getActiveTools() {
      return ["mcp_slack_post"];
    },
    appendEntry() {},
    sendMessage() {},
    events: { emit() {}, on() {} },
  };

  let mcpClient = null;
  try {
    const mod = await importBridgeModule("extensions/index.ts");
    await mod.default(mockPi);

    for (const fn of handlers.get("session_start") ?? []) {
      await fn(
        { type: "session_start", reason: "startup" },
        {
          hasUI: false,
          mode: "rpc",
          ui: {},
          isProjectTrusted: () => false,
          sessionManager: { getEntries: () => [], getBranch: () => [] },
        },
      );
    }

    const inputHandler = handlers.get("input")?.[0];
    assert.equal(typeof inputHandler, "function");

    const providerSpec = providers.get("antigravity");
    const model = providerSpec.models[0];
    const userMsg = { role: "user", content: "Streaming turn", timestamp: 1 };
    const stream1 = providerSpec.streamSimple(
      model,
      { messages: [userMsg] },
      { cwd: h.tmpDir, sessionId: "ext-1" },
    );

    const sessionNewFrame = await h.waitForFrame((f) => f.method === "session/new");
    const promptFrame = await h.waitForFrame((f) => f.method === "session/prompt");

    // Park the turn on a real MCP round-trip so roundTrips.pendingIds.length === 1.
    const bridgeServer = sessionNewFrame.params.mcpServers[0];
    assert.equal(Boolean(bridgeServer?.url), true);
    mcpClient = new Client({ name: "steer-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(bridgeServer.url), {
      requestInit: {
        headers: Object.fromEntries(bridgeServer.headers.map((hdr) => [hdr.name, hdr.value])),
      },
    });
    await mcpClient.connect(transport);
    const toolCallPromise = mcpClient.callTool({ name: "mcp_slack_post", arguments: {} });

    const parkedMsg = await stream1.result();
    assert.equal(parkedMsg.stopReason, "toolUse");
    const toolCallBlock = parkedMsg.content.find((c) => c.type === "toolCall");
    assert.equal(toolCallBlock?.name, "mcp_slack_post");

    const idxWhileParked = h.received.length;
    // While roundTrips.pendingIds.length > 0, steer input must NOT cancel the ACP session.
    assert.equal(
      await inputHandler(
        { type: "input", text: "Steer while parked", source: "interactive", streamingBehavior: "steer" },
        { model: { provider: "antigravity" } },
      ),
      undefined,
    );
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      h.received.slice(idxWhileParked).some((f) => f.method === "session/cancel"),
      false,
    );

    // Deliver toolResult to resolve roundTrips and unpark the active ACP turn.
    const streamCont = providerSpec.streamSimple(
      model,
      {
        messages: [
          userMsg,
          parkedMsg,
          {
            role: "toolResult",
            toolCallId: toolCallBlock.id,
            toolName: "mcp_slack_post",
            content: [{ type: "text", text: "posted" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      { cwd: h.tmpDir, sessionId: "ext-1" },
    );
    const toolRes = await toolCallPromise;
    assert.equal(toolRes.content[0].text, "posted");

    const idxBeforeInput = h.received.length;
    // Non-steer and non-antigravity inputs must remain no-ops.
    assert.equal(
      await inputHandler(
        { type: "input", text: "Queued follow-up", source: "interactive", streamingBehavior: "followUp" },
        { model: { provider: "antigravity" } },
      ),
      undefined,
    );
    assert.equal(
      await inputHandler(
        { type: "input", text: "Other provider steer", source: "interactive", streamingBehavior: "steer" },
        { model: { provider: "anthropic" } },
      ),
      undefined,
    );
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(
      h.received.slice(idxBeforeInput).some((f) => f.method === "session/cancel"),
      false,
    );

    // Matching antigravity steer with roundTrips.pendingIds empty dispatches session/cancel.
    const res = await inputHandler(
      { type: "input", text: "Steer now", source: "interactive", streamingBehavior: "steer" },
      { model: { provider: "antigravity" } },
    );
    assert.equal(res, undefined);

    const cancelFrame = await h.waitForFrame((f) => f.method === "session/cancel", idxBeforeInput);
    assert.equal(cancelFrame.params.sessionId, promptFrame.params.sessionId);

    h.replyPrompt(promptFrame, "cancelled");
    const finalMsg = await streamCont.result();
    assert.equal(finalMsg.stopReason, "stop");

    // Allow async NDJSON appendFile to flush.
    const logDir = path.join(agentDir, "antigravity-bridge", "logs");
    let logContent = "";
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(logDir)) {
        const logFiles = fs.readdirSync(logDir).filter((n) => n.endsWith(".ndjson"));
        logContent = logFiles.map((n) => fs.readFileSync(path.join(logDir, n), "utf8")).join("\n");
        if (logContent.includes('"event":"steer-interrupt"')) break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.match(logContent, /"event":"steer-interrupt"/);
  } finally {
    try {
      await mcpClient?.close();
    } catch {
      // Ignore transport close race on shutdown.
    }
    const shutdownHandlers = handlers.get("session_shutdown") ?? [];
    for (const fn of shutdownHandlers) {
      await fn({}, { hasUI: false, ui: {} });
    }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    if (prevFakePort === undefined) delete process.env.FAKE_ACP_PORT;
    else process.env.FAKE_ACP_PORT = prevFakePort;
    if (prevDebug === undefined) delete process.env.AGY_DEBUG;
    else process.env.AGY_DEBUG = prevDebug;
    await h.close();
  }
});
