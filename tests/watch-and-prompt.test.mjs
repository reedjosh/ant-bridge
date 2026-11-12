import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { buildContextDigest, extractImages, extractUserPrompt, trailingUserTurnStart } =
  await importBridgeModule("src/provider.ts");
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
