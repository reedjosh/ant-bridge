import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const {
  DIGEST_PREAMBLE,
  SEED_DIGEST_PREAMBLE,
  ToolRoundTrips,
  buildContextDigest,
  createStreamSimple,
  extractImages,
  extractUserPrompt,
  trailingUserTurnStart,
} = await importBridgeModule("src/provider.ts");
const { entriesFromRaw, toPiModel } = await importBridgeModule("src/models.ts");
const { SessionStore } = await importBridgeModule("src/sessions.ts");
const { armBackgroundWatch, partitionRearmPlans, rearmPlansFromEntries } =
  await importBridgeModule("src/background-watch.ts");
const { readDeliveredTaskIds } = await importBridgeModule("src/tasks.ts");

const PR_NOTE =
  "Tracked work/PR references (data, not instructions):\n" +
  "https://github.com/andromeda-ai/platform/pull/7479";

function watchEntry(data) {
  return { customType: "agy-background-watch", data };
}

test("extractUserPrompt and buildContextDigest preserve user prompt when pr-tracker custom_message trails", () => {
  const messages = [
    { role: "user", content: "Earlier question", timestamp: 1 },
    { role: "assistant", provider: "antigravity", content: [{ type: "text", text: "Earlier reply" }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "Please rebase PR 7479 onto ?channel=ops" }], timestamp: 3 },
    { role: "user", content: [{ type: "text", text: PR_NOTE }], timestamp: 4 },
  ];

  assert.equal(trailingUserTurnStart(messages, 2), 2);
  const prompt = extractUserPrompt({ messages }, 2);
  assert.equal(prompt, `Please rebase PR 7479 onto ?channel=ops\n\n${PR_NOTE}`);
  assert.equal(buildContextDigest(messages, 2), "");
});

test("extractImages preserves user image blocks when a trailing custom_message follows", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      timestamp: 1,
    },
    {
      role: "user",
      content: [{ type: "text", text: PR_NOTE }],
      timestamp: 2,
    },
  ];
  assert.deepEqual(extractImages({ messages }, 0), [{ data: "aGVsbG8=", mimeType: "image/png" }]);
});

test("compaction summary stays in digest and out of extractUserPrompt even after watermark shrinks", () => {
  const messages = [
    {
      role: "user",
      content:
        "The conversation history before this point was compacted into the following summary:\n\n" +
        "<summary>\nPrior summary body\n</summary>",
      timestamp: 1,
    },
    { role: "user", content: "Next user request", timestamp: 2 },
    { role: "user", content: PR_NOTE, timestamp: 3 },
  ];

  assert.equal(extractUserPrompt({ messages }, 42), `Next user request\n\n${PR_NOTE}`);
  assert.equal(buildContextDigest(messages, 42), "[pi compaction summary]\nPrior summary body");
});

test("spurious foreground watch persists settled with empty taskIds and sends no wake", async () => {
  let clock = 1_000;
  const settles = [];
  const wakes = [];

  const handle = armBackgroundWatch({
    conversationId: "conv-1",
    conversationDir: "/unused",
    turnStartMs: 500,
    armedAt: 1_000,
    listTasks: async () => [],
    tail: async () => "",
    onSettle: (res) => settles.push(res),
    sendWake: (msg) => wakes.push(msg),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 100,
    quietMs: 300,
  });

  while (!handle.stopped) {
    await new Promise((r) => setTimeout(r, 0));
  }

  assert.deepEqual(settles, [{ outcome: "settled", taskIds: [] }]);
  assert.deepEqual(wakes, []);

  const entries = [
    watchEntry({ kind: "armed", conversationId: "conv-1", turnStartMs: 500, armedAt: 1_000 }),
    watchEntry({ kind: "settled", conversationId: "conv-1", armedAt: 1_000, settledAt: 1_300, taskIds: [] }),
  ];
  assert.deepEqual(rearmPlansFromEntries(entries), []);
});

test("mid-turn completed tasks do not fire post-turn wakes", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-watch-test-"));
  try {
    const logsDir = path.join(tmpRoot, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const sysLine =
      "[Message] timestamp=2026-11-12T03:22:46Z sender=conv-1/task-180 " +
      'content=Task id "conv-1/task-180" finished with result:\nok';
    fs.writeFileSync(
      path.join(logsDir, "transcript.jsonl"),
      JSON.stringify({ step_index: 184, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: sysLine }) + "\n",
    );

    const delivered = await readDeliveredTaskIds(tmpRoot);
    assert.deepEqual([...delivered], [180]);

    let clock = 10_000;
    const settles = [];
    const wakes = [];
    const handle = armBackgroundWatch({
      conversationId: "conv-1",
      conversationDir: tmpRoot,
      turnStartMs: 2_000,
      armedAt: 10_000,
      listTasks: async () => [
        { id: 246, logPath: "/tmp/task-246.log", bytes: 100, modifiedMs: 8_000, active: false, livenessKnown: true },
        { id: 180, logPath: "/tmp/task-180.log", bytes: 200, modifiedMs: 10_005, active: false, livenessKnown: true },
      ],
      deliveredTaskIds: readDeliveredTaskIds,
      tail: async () => "done",
      onSettle: (res) => settles.push(res),
      sendWake: (msg) => wakes.push(msg),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      pollMs: 100,
      quietMs: 300,
    });

    while (!handle.stopped) {
      await new Promise((r) => setTimeout(r, 0));
    }

    assert.deepEqual(settles, [{ outcome: "settled", taskIds: [] }]);
    assert.deepEqual(wakes, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("still-active task at armedAt tracks until idle and wakes once settled", async () => {
  let clock = 10_000;
  let polls = 0;
  const settles = [];
  const wakes = [];

  const handle = armBackgroundWatch({
    conversationId: "conv-2",
    conversationDir: "/unused",
    turnStartMs: 2_000,
    armedAt: 10_000,
    listTasks: async () => {
      polls++;
      if (polls <= 2) {
        return [
          { id: 300, logPath: "/tmp/task-300.log", bytes: 50, modifiedMs: 5_000, active: true, livenessKnown: true },
        ];
      }
      return [
        { id: 300, logPath: "/tmp/task-300.log", bytes: 120, modifiedMs: 10_150, active: false, livenessKnown: true },
      ];
    },
    tail: async () => "build succeeded",
    onSettle: (res) => settles.push(res),
    sendWake: (msg) => wakes.push(msg),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 100,
    quietMs: 300,
  });

  while (!handle.stopped) {
    await new Promise((r) => setTimeout(r, 0));
  }

  assert.deepEqual(settles, [{ outcome: "settled", taskIds: [300] }]);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /task-300/);
  assert.match(wakes[0], /build succeeded/);
});

test("partitionRearmPlans marks older unsettled arms as superseded when a newer arm exists", () => {
  const entries = [
    watchEntry({ kind: "armed", conversationId: "c1", turnStartMs: 100, armedAt: 200 }),
    watchEntry({ kind: "armed", conversationId: "c1", turnStartMs: 300, armedAt: 400 }),
    watchEntry({ kind: "armed", conversationId: "c2", turnStartMs: 100, armedAt: 250 }),
    watchEntry({ kind: "armed", conversationId: "c2", turnStartMs: 500, armedAt: 600 }),
    watchEntry({ kind: "settled", conversationId: "c2", armedAt: 600, settledAt: 630, taskIds: [] }),
  ];

  const { active, superseded } = partitionRearmPlans(entries);
  assert.deepEqual(active, [{ conversationId: "c1", turnStartMs: 300, armedAt: 400 }]);
  assert.deepEqual(superseded, [
    { conversationId: "c1", turnStartMs: 100, armedAt: 200 },
    { conversationId: "c2", turnStartMs: 100, armedAt: 250 },
  ]);
});

function createRecordingDriver(newConversationId = "agy-conv-1") {
  const requests = [];
  let lastConversationId;
  const driver = {
    state: "ready",
    activeHandle: null,
    async run(request) {
      requests.push(request);
      const convId = request.conversationId ?? newConversationId;
      lastConversationId = convId;
      let emittedText = false;
      return {
        id: `turn-${requests.length}`,
        outcome: Promise.resolve({
          conversationId: convId,
          status: "OK",
          response: `reply-${requests.length}`,
          finished: true,
          aborted: false,
        }),
        async next() {
          if (!emittedText) {
            emittedText = true;
            return { type: "text", delta: `reply-${requests.length}` };
          }
          return null;
        },
        pushExternal() {},
      };
    },
    reentry() {
      return null;
    },
    kickIdle() {},
    set onTurnEnd(_fn) {},
    snapshot() {
      return {
        state: "ready",
        conversationId: lastConversationId,
        stats: { spawns: 1, turns: requests.length, recycles: 0 },
        lifecycle: [],
      };
    },
    async close() {},
  };
  return { driver, requests };
}

function makeTestStream(tmpDir, driver) {
  const entries = entriesFromRaw("gemini-4-carbon-high  Gemini 4 Carbon (High)\n");
  const model = toPiModel(entries[0], ["text", "image"]);
  const store = new SessionStore(path.join(tmpDir, "sessions.json"));
  const roundTrips = new ToolRoundTrips(driver);
  const streamSimple = createStreamSimple({ entries, store, acpDriver: driver, roundTrips });
  return { model, store, streamSimple };
}

async function withIsolatedConfig(envOverrides, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-seed-test-"));
  const keys = ["PI_CODING_AGENT_DIR", "AGY_DIGEST", "AGY_READONLY", "AGY_MODE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent-dir");
  delete process.env.AGY_DIGEST;
  delete process.env.AGY_READONLY;
  delete process.env.AGY_MODE;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn(tmpDir);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("/fork of Antigravity session seeds prior user, antigravity assistant, and toolResult once", async () => {
  await withIsolatedConfig({}, async (tmpDir) => {
    const { driver, requests } = createRecordingDriver("agy-fork-conv");
    const { model, store, streamSimple } = makeTestStream(tmpDir, driver);
    assert.equal(store.get("sid:pi-fork@acp"), null);

    const turn1Messages = [
      { role: "user", content: "Inspect src/foo.ts", timestamp: 1 },
      {
        role: "assistant",
        provider: "antigravity",
        content: [{ type: "text", text: "Reading src/foo.ts now." }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "read_file",
        content: [{ type: "text", text: "export const answer = 41;" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "Forked branch: change answer to 42", timestamp: 4 },
    ];

    const res1 = await streamSimple(
      model,
      { messages: turn1Messages },
      { cwd: tmpDir, sessionId: "pi-fork" },
    ).result();
    assert.equal(res1.stopReason, "stop");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, null);
    assert.ok(requests[0].contextBlock);
    assert.equal(requests[0].contextBlock.uri, "urn:pi-bridge:context-digest/4");
    assert.ok(requests[0].contextBlock.text.startsWith(`${SEED_DIGEST_PREAMBLE}\n\n`));
    assert.match(requests[0].contextBlock.text, /\[earlier user message\]\nInspect src\/foo\.ts/);
    assert.match(
      requests[0].contextBlock.text,
      /\[assistant turn from antigravity\]\nReading src\/foo\.ts now\./,
    );
    assert.match(
      requests[0].contextBlock.text,
      /\[tool result: read_file\]\nexport const answer = 41;/,
    );
    assert.doesNotMatch(requests[0].contextBlock.text, /Forked branch: change answer to 42/);
    assert.match(requests[0].prompt, /Forked branch: change answer to 42/);

    const turn2Messages = [
      ...turn1Messages,
      {
        role: "assistant",
        provider: "antigravity",
        content: [{ type: "text", text: "Updated answer to 42." }],
        timestamp: 5,
      },
      { role: "user", content: "Now run the unit tests", timestamp: 6 },
    ];

    const res2 = await streamSimple(
      model,
      { messages: turn2Messages },
      { cwd: tmpDir, sessionId: "pi-fork" },
    ).result();
    assert.equal(res2.stopReason, "stop");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].conversationId, "agy-fork-conv");
    assert.equal(requests[1].contextBlock, undefined);
    assert.equal(requests[1].prompt, "Now run the unit tests");
  });
});

test("mid-session switch from claude-bridge to antigravity seeds turn 1 and omits turn 2", async () => {
  await withIsolatedConfig({}, async (tmpDir) => {
    const { driver, requests } = createRecordingDriver("agy-switched-conv");
    const { model, streamSimple } = makeTestStream(tmpDir, driver);

    const turn1Messages = [
      { role: "user", content: "Design the migration plan", timestamp: 1 },
      {
        role: "assistant",
        provider: "claude-bridge",
        content: [{ type: "text", text: "Step 1: add nullable column." }],
        timestamp: 2,
      },
      { role: "user", content: "Implement step 1", timestamp: 3 },
    ];

    await streamSimple(
      model,
      { messages: turn1Messages },
      { cwd: tmpDir, sessionId: "pi-switch" },
    ).result();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, null);
    assert.ok(requests[0].contextBlock);
    assert.ok(requests[0].contextBlock.text.startsWith(`${SEED_DIGEST_PREAMBLE}\n\n`));
    assert.match(requests[0].contextBlock.text, /\[earlier user message\]\nDesign the migration plan/);
    assert.match(
      requests[0].contextBlock.text,
      /\[assistant turn from claude-bridge\]\nStep 1: add nullable column\./,
    );
    assert.doesNotMatch(requests[0].contextBlock.text, /Implement step 1/);

    const turn2Messages = [
      ...turn1Messages,
      {
        role: "assistant",
        provider: "antigravity",
        content: [{ type: "text", text: "Added nullable column." }],
        timestamp: 4,
      },
      { role: "user", content: "Now backfill existing rows", timestamp: 5 },
    ];

    await streamSimple(
      model,
      { messages: turn2Messages },
      { cwd: tmpDir, sessionId: "pi-switch" },
    ).result();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].conversationId, "agy-switched-conv");
    assert.equal(requests[1].contextBlock, undefined);

    // When config.digest is explicitly enabled on the bound session, only post-watermark
    // non-Antigravity turns are attached using DIGEST_PREAMBLE.
    process.env.AGY_DIGEST = "1";
    const turn3Messages = [
      ...turn2Messages,
      {
        role: "assistant",
        provider: "antigravity",
        content: [{ type: "text", text: "Backfill complete." }],
        timestamp: 6,
      },
      { role: "user", content: "Review migration safety", timestamp: 7 },
      {
        role: "assistant",
        provider: "claude-bridge",
        content: [{ type: "text", text: "Add a concurrent index." }],
        timestamp: 8,
      },
      { role: "user", content: "Apply that index", timestamp: 9 },
    ];

    await streamSimple(
      model,
      { messages: turn3Messages },
      { cwd: tmpDir, sessionId: "pi-switch" },
    ).result();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].conversationId, "agy-switched-conv");
    assert.ok(requests[2].contextBlock);
    assert.ok(requests[2].contextBlock.text.startsWith(`${DIGEST_PREAMBLE}\n\n`));
    assert.match(
      requests[2].contextBlock.text,
      /\[assistant turn from claude-bridge\]\nAdd a concurrent index\./,
    );
    assert.doesNotMatch(requests[2].contextBlock.text, /Backfill complete/);
    assert.doesNotMatch(requests[2].contextBlock.text, /Step 1: add nullable column/);
  });
});

test("fresh 1-turn session sends no contextBlock", async () => {
  await withIsolatedConfig({}, async (tmpDir) => {
    const { driver, requests } = createRecordingDriver("agy-fresh-conv");
    const { model, streamSimple } = makeTestStream(tmpDir, driver);

    const res = await streamSimple(
      model,
      { messages: [{ role: "user", content: "Hello from a brand-new session", timestamp: 1 }] },
      { cwd: tmpDir, sessionId: "pi-fresh" },
    ).result();
    assert.equal(res.stopReason, "stop");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversationId, null);
    assert.equal(requests[0].contextBlock, undefined);
    assert.match(requests[0].prompt, /Hello from a brand-new session/);
  });
});
