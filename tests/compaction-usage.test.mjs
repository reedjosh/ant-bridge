import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule, jiti } from "./helpers/pi-loader.mjs";

const { isContextOverflow } = await jiti.import("@earendil-works/pi-ai");
const { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, shouldCompact } =
  await jiti.import("@earendil-works/pi-coding-agent");
const { AcpDriver } = await importBridgeModule("src/acp/driver.ts");
const { entriesFromRaw, toPiModel } = await importBridgeModule("src/models.ts");
const {
  createStreamSimple,
  SEED_DIGEST_PREAMBLE,
  SUMMARIZATION_NO_TOOLS_NOTE,
  TOOL_PRIORITY_NOTE,
  ToolRoundTrips,
} = await importBridgeModule("src/provider.ts");
const { SessionStore } = await importBridgeModule("src/sessions.ts");

const RELAY_SCRIPT = `
import net from "node:net";

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
  for (const line of queued.splice(0)) sock.write(line + "\\n");
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
process.stdin.on("end", () => sock.end());
`;

async function createFakeAcpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-compact-test-"));
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
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

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
    replyPrompt(promptFrame, stopReason = "end_turn", usage = undefined) {
      sendToClient({
        jsonrpc: "2.0",
        id: promptFrame.id,
        result: { stopReason, ...(usage ? { usage } : {}) },
      });
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

test(
  "multi-batch PromptResponse.usage normalizes input and cacheRead so Pi never false-compacts early",
  async () => {
    const h = await createFakeAcpHarness();
    const driver = new AcpDriver({
      bin: h.launcherPath,
      binArgs: ["acp"],
      extraEnv: { FAKE_ACP_PORT: String(h.port) },
    });
    try {
      const { entries, model } = makeModelAndEntries();
      const store = new SessionStore(path.join(h.tmpDir, "sessions.json"));
      const streamSimple = createStreamSimple({
        entries,
        store,
        acpDriver: driver,
        roundTrips: new ToolRoundTrips(),
      });

      // Turn 1: exact numbers from production premature compaction (18 tool batches = 19 inferences).
      const turn1Promise = streamSimple(
        model,
        { messages: [{ role: "user", content: "Inspect codebase", timestamp: 1 }] },
        { cwd: h.tmpDir, sessionId: "pi-usage" },
      ).result();

      const prompt1 = await h.waitForFrame((f) => f.method === "session/prompt");
      const sid = prompt1.params.sessionId;
      for (let b = 1; b <= 18; b++) {
        h.sendUpdate(sid, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `step ${b}` },
        });
        h.sendUpdate(sid, {
          sessionUpdate: "tool_call",
          toolCallId: `tc-${b}`,
          name: "read_file",
          rawInput: { Path: `/repo/file-${b}.ts` },
        });
        h.sendUpdate(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: `tc-${b}`,
          status: "completed",
          rawOutput: "ok",
        });
      }
      h.sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Done inspecting." },
      });
      h.replyPrompt(prompt1, "end_turn", {
        inputTokens: 143_887,
        outputTokens: 21_155,
        cachedReadTokens: 1_555_689,
        totalTokens: 1_720_731,
      });

      const msg1 = await turn1Promise;
      assert.equal(msg1.stopReason, "stop");
      assert.equal(msg1.usage.input, 7_573);
      assert.equal(msg1.usage.cacheRead, 81_879);
      assert.equal(msg1.usage.output, 21_155);
      assert.equal(msg1.usage.totalTokens, 110_607);
      assert.equal(
        msg1.usage.input + msg1.usage.cacheRead + msg1.usage.output,
        msg1.usage.totalTokens,
      );
      assert.equal(isContextOverflow(msg1, model.contextWindow), false);
      assert.equal(
        shouldCompact(
          calculateContextTokens(msg1.usage),
          model.contextWindow,
          DEFAULT_COMPACTION_SETTINGS,
        ),
        false,
      );

      // Turn 2: exact numbers from follow-up resumed turn (11 tool batches = 12 inferences).
      const idx2 = h.received.length;
      const turn2Promise = streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "Inspect codebase", timestamp: 1 },
            msg1,
            { role: "user", content: "Check remaining files", timestamp: 2 },
          ],
        },
        { cwd: h.tmpDir, sessionId: "pi-usage" },
      ).result();

      const prompt2 = await h.waitForFrame((f) => f.method === "session/prompt", idx2);
      for (let b = 1; b <= 11; b++) {
        h.sendUpdate(sid, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `next ${b}` },
        });
        h.sendUpdate(sid, {
          sessionUpdate: "tool_call",
          toolCallId: `tc2-${b}`,
          name: "read_file",
          rawInput: { Path: `/repo/more-${b}.ts` },
        });
        h.sendUpdate(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: `tc2-${b}`,
          status: "completed",
          rawOutput: "ok",
        });
      }
      h.sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Checked remaining files." },
      });
      h.replyPrompt(prompt2, "end_turn", {
        inputTokens: 39_953,
        outputTokens: 6_379,
        cachedReadTokens: 1_873_232,
        totalTokens: 1_919_564,
      });

      const msg2 = await turn2Promise;
      assert.equal(msg2.usage.input, 3_330);
      assert.equal(msg2.usage.cacheRead, 156_103);
      assert.equal(msg2.usage.output, 6_379);
      assert.equal(msg2.usage.totalTokens, 165_812);
      assert.equal(isContextOverflow(msg2, model.contextWindow), false);
      assert.equal(
        shouldCompact(
          calculateContextTokens(msg2.usage),
          model.contextWindow,
          DEFAULT_COMPACTION_SETTINGS,
        ),
        false,
      );

      // Turn 3: 1-batch turn keeps exact usage, and usage_update occupancy caps merged batches.
      const idx3 = h.received.length;
      const turn3Promise = streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "Inspect codebase", timestamp: 1 },
            msg1,
            { role: "user", content: "Check remaining files", timestamp: 2 },
            msg2,
            { role: "user", content: "Quick summary", timestamp: 3 },
          ],
        },
        { cwd: h.tmpDir, sessionId: "pi-usage" },
      ).result();

      const prompt3 = await h.waitForFrame((f) => f.method === "session/prompt", idx3);
      h.sendUpdate(sid, { sessionUpdate: "usage_update", used: 170_000 });
      h.sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Summary ready." },
      });
      h.replyPrompt(prompt3, "end_turn", {
        inputTokens: 120_000,
        outputTokens: 500,
        cachedReadTokens: 1_400_000,
        totalTokens: 1_520_500,
      });

      const msg3 = await turn3Promise;
      assert.equal(msg3.usage.totalTokens, 170_000);
      assert.equal(msg3.usage.input + msg3.usage.cacheRead <= 170_000, true);
      assert.equal(isContextOverflow(msg3, model.contextWindow), false);

      // Genuine per-inference overflow (> 1.0M contextWindow) still triggers isContextOverflow.
      const idx4 = h.received.length;
      const turn4Promise = streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "Inspect codebase", timestamp: 1 },
            msg3,
            { role: "user", content: "Huge prompt", timestamp: 4 },
          ],
        },
        { cwd: h.tmpDir, sessionId: "pi-usage" },
      ).result();
      const prompt4 = await h.waitForFrame((f) => f.method === "session/prompt", idx4);
      h.sendUpdate(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Truncated." },
      });
      h.replyPrompt(prompt4, "end_turn", {
        inputTokens: 25_000,
        outputTokens: 200,
        cachedReadTokens: 990_000,
        totalTokens: 1_015_200,
      });
      const msg4 = await turn4Promise;
      assert.equal(isContextOverflow(msg4, model.contextWindow), true);
    } finally {
      await driver.close("shutdown");
      await h.close();
    }
  },
);

test(
  "standalone summarization isolates SessionStore and post-compaction turn resets ACP session",
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-summary-iso-"));
    const savedEnv = {
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      AGY_SYSTEM_PROMPT: process.env.AGY_SYSTEM_PROMPT,
      AGY_DIGEST: process.env.AGY_DIGEST,
    };
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    delete process.env.AGY_SYSTEM_PROMPT;
    delete process.env.AGY_DIGEST;

    try {
      const requests = [];
      const nativeEvents = [];
      const bgWatches = [];
      let nextConvSeq = 0;

      const fakeDriver = {
        async run(req) {
          requests.push(req);
          nextConvSeq += 1;
          const convId = req.conversationId ?? `acp-conv-${nextConvSeq}`;
          const isSummaryCall = req.prompt.includes(SUMMARIZATION_NO_TOOLS_NOTE);
          const activities = isSummaryCall
            ? [
                {
                  type: "tool_start",
                  name: "run_command",
                  args: { CommandLine: "ls -la", IsDaemon: true },
                  toolCallId: "stray-1",
                },
                {
                  type: "tool_done",
                  name: "run_command",
                  args: { CommandLine: "ls -la", IsDaemon: true },
                  output: "stray output",
                  toolCallId: "stray-1",
                },
                { type: "text", delta: "## Goal\nShip v2.2 cleanly." },
              ]
            : [{ type: "text", delta: `Reply on ${convId}` }];
          let idx = 0;
          return {
            id: `turn-${nextConvSeq}`,
            async next() {
              return idx < activities.length ? activities[idx++] : null;
            },
            outcome: Promise.resolve({
              conversationId: convId,
              status: "OK",
              response: isSummaryCall ? "## Goal\nShip v2.2 cleanly." : `Reply on ${convId}`,
              finished: true,
              aborted: false,
            }),
            pushExternal() {},
          };
        },
        reentry() {
          return null;
        },
        async close() {},
        snapshot() {
          return {
            state: "ready",
            conversationId: `acp-conv-${nextConvSeq}`,
            stats: { spawns: 1, turns: nextConvSeq, reused: 0, recycles: 0, recycleReasons: {} },
            lifecycle: [],
            engine: "acp",
          };
        },
      };

      const { entries, model } = makeModelAndEntries();
      const store = new SessionStore(path.join(tmpDir, "sessions.json"));
      const streamSimple = createStreamSimple({
        entries,
        store,
        acpDriver: fakeDriver,
        roundTrips: new ToolRoundTrips(),
        onNativeEvent: (ev) => nativeEvents.push(ev),
        onNativeBackground: (bg) => bgWatches.push(bg),
      });

      // Step 1: normal turn 1 binds sid:live-sess@acp -> acp-conv-1.
      const turn1 = await streamSimple(
        model,
        {
          messages: [
            { role: "system", content: "Project system instructions.", timestamp: 0 },
            { role: "user", content: "Start working on v2.2", timestamp: 1 },
          ],
        },
        { cwd: tmpDir, sessionId: "live-sess" },
      ).result();
      assert.equal(turn1.stopReason, "stop");
      assert.equal(store.get("sid:live-sess@acp")?.conversationId, "acp-conv-1");

      // Step 2: Pi's completeSummarization runs with cacheRetention="none" and the same sessionId.
      const summaryMsg = await streamSimple(
        model,
        {
          messages: [
            {
              role: "system",
              content: "You are a context summarization assistant. Do not continue the conversation.",
              timestamp: 0,
            },
            {
              role: "user",
              content: "<conversation>\n[User]: Start working on v2.2\n</conversation>\n\nSummarize.",
              timestamp: 2,
            },
          ],
        },
        { cwd: tmpDir, sessionId: "live-sess", cacheRetention: "none" },
      ).result();

      assert.equal(summaryMsg.stopReason, "stop");
      assert.equal(requests[1].conversationId, null);
      assert.equal(requests[1].contextBlock, undefined);
      assert.equal(requests[1].prompt.includes(SUMMARIZATION_NO_TOOLS_NOTE), true);
      assert.equal(requests[1].prompt.includes(TOOL_PRIORITY_NOTE), false);
      assert.equal(nativeEvents.length, 0);
      assert.equal(bgWatches.length, 0);
      assert.equal(
        summaryMsg.content.some((b) => b.type === "thinking"),
        false,
      );
      // SessionStore still points to acp-conv-1 right after summarization finishes.
      assert.equal(store.get("sid:live-sess@acp")?.conversationId, "acp-conv-1");

      // Step 3: Next user turn after compaction carries Pi's compaction summary message.
      // Provider retires acp-conv-1, starts fresh acp-conv-3 seeded once with the compacted summary
      // and kept recent turns, and persists compactionHash.
      const compactedMessages = [
        { role: "system", content: "Project system instructions.", timestamp: 0 },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "The conversation history before this point was compacted into the following summary:\n\n" +
                "<summary>\n## Goal\nShip v2.2 cleanly.\n</summary>",
            },
          ],
          timestamp: 3,
        },
        { role: "user", content: "Kept recent user request", timestamp: 4 },
        {
          role: "assistant",
          provider: "antigravity",
          content: [{ type: "text", text: "Kept recent assistant reply." }],
          timestamp: 5,
        },
        { role: "user", content: "Continue after compaction", timestamp: 6 },
      ];

      const postCompact1 = await streamSimple(
        model,
        { messages: compactedMessages },
        { cwd: tmpDir, sessionId: "live-sess" },
      ).result();
      assert.equal(postCompact1.stopReason, "stop");
      assert.equal(requests[2].conversationId, null);
      assert.ok(requests[2].contextBlock);
      assert.ok(requests[2].contextBlock.text.startsWith(`${SEED_DIGEST_PREAMBLE}\n\n`));
      assert.match(requests[2].contextBlock.text, /\[pi compaction summary\]\n## Goal\nShip v2\.2 cleanly\./);
      assert.match(
        requests[2].contextBlock.text,
        /\[assistant turn from antigravity\]\nKept recent assistant reply\./,
      );
      assert.match(requests[2].prompt, /Project system instructions\./);
      assert.match(requests[2].prompt, /Continue after compaction/);

      const postSaved = store.get("sid:live-sess@acp");
      assert.equal(postSaved?.conversationId, "acp-conv-3");
      assert.equal(typeof postSaved?.compactionHash, "string");

      // Step 4: Subsequent turn under the same compaction summary resumes acp-conv-3 cleanly.
      const followUpMessages = [
        ...compactedMessages,
        postCompact1,
        { role: "user", content: "Run final validation", timestamp: 7 },
      ];
      await streamSimple(
        model,
        { messages: followUpMessages },
        { cwd: tmpDir, sessionId: "live-sess" },
      ).result();
      assert.equal(requests[3].conversationId, "acp-conv-3");
      assert.equal(requests[3].contextBlock, undefined);
      assert.equal(requests[3].prompt, "Run final validation");

      // Step 5: A second compaction later produces a new summary hash and resets again cleanly.
      const secondCompactedMessages = [
        { role: "system", content: "Project system instructions.", timestamp: 0 },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "The conversation history before this point was compacted into the following summary:\n\n" +
                "<summary>\n## Goal\nShip v2.3 next.\n</summary>",
            },
          ],
          timestamp: 8,
        },
        { role: "user", content: "Start v2.3 work", timestamp: 9 },
      ];
      await streamSimple(
        model,
        { messages: secondCompactedMessages },
        { cwd: tmpDir, sessionId: "live-sess" },
      ).result();
      assert.equal(requests[4].conversationId, null);
      assert.ok(requests[4].contextBlock);
      assert.match(requests[4].contextBlock.text, /Ship v2\.3 next\./);
      assert.equal(store.get("sid:live-sess@acp")?.conversationId, "acp-conv-5");
      assert.notEqual(store.get("sid:live-sess@acp")?.compactionHash, postSaved?.compactionHash);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);
