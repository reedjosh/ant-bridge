import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule, jiti } from "./helpers/pi-loader.mjs";

const { Container, MouseRegion } = await jiti.import("@earendil-works/pi-tui");
const { mapUpdate } = await importBridgeModule("src/acp/events.ts");
const { consumeActivity } = await importBridgeModule("src/provider.ts");
const {
  PREVIEW_LINES,
  capNativeOutput,
  cleanNativeCommandOutput,
  createNativeEventEntryRenderer,
  formatNativeEventDetail,
  formatNativeEventLines,
} = await importBridgeModule("src/native-event-render.ts");

const tagTheme = {
  fg(color, text) {
    return `<${color}>${text}</${color}>`;
  },
};

const plainTheme = {
  fg(_color, text) {
    return text;
  },
};

function makeStreamAndBlocks() {
  const pushed = [];
  const stream = {
    push(evt) {
      pushed.push(evt);
    },
    end() {},
  };
  const blocks = {
    partial: {
      role: "assistant",
      content: [],
      api: "agy-bridge",
      provider: "antigravity",
      model: "gemini-4-carbon",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
    textIdx: null,
    thinkingIdx: null,
    started: false,
  };
  return { stream, blocks, pushed };
}

function mouseEvent(type, button = "left", y = 0, height = 2) {
  return {
    type,
    button,
    x: 2,
    y,
    screenX: 2,
    screenY: y,
    width: 120,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test("mapUpdate and consumeActivity extract read_file path/range and grep_search query without diffEdit", () => {
  const events = [];
  let diffCalls = 0;
  const diffCtx = {
    diffEdit() {
      diffCalls++;
      return { text: "+unexpected" };
    },
  };
  const cwd = "/tmp/ant-bridge-tui";

  // 1. read_file with relative Path and StartLine/EndLine in rawInput.
  const startMapped = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-read-1",
    name: "read_file",
    rawInput: { Path: "src/provider.ts", StartLine: 780, EndLine: 885 },
  });
  assert.equal(startMapped.kind, "tool_start");

  const { stream, blocks } = makeStreamAndBlocks();
  consumeActivity(
    stream,
    blocks,
    {
      type: "tool_done",
      name: startMapped.name,
      args: startMapped.args,
      location: startMapped.location,
      output: "Created At: 2026-11-12T13:00:00Z\nCompleted At: 2026-11-12T13:00:01Z\nShowing lines 780-885",
      toolCallId: startMapped.toolCallId,
    },
    diffCtx,
    cwd,
    { onNativeEvent: (e) => events.push(e) },
  );

  assert.equal(diffCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].path, "/tmp/ant-bridge-tui/src/provider.ts");
  assert.equal(events[0].detail, "provider.ts:780-885");
  assert.equal(events[0].diff, undefined);
  assert.equal(formatNativeEventDetail(events[0]), "provider.ts:780-885");

  // 2. read_file where rawInput lacks Path and ACP sends target in locations[0].
  const locStart = mapUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-read-2",
    title: "Running read_file",
    rawInput: {},
    locations: [{ path: "file:///tmp/ant-bridge-tui/package.json" }],
  });
  assert.equal(locStart.kind, "tool_start");
  assert.deepEqual(locStart.location, { path: "/tmp/ant-bridge-tui/package.json" });

  const locUpdate = mapUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-read-2",
    status: "in_progress",
    locations: [{ path: "/tmp/ant-bridge-tui/src/acp/events.ts", line: 64 }],
  });
  assert.equal(locUpdate.kind, "tool_update");
  assert.deepEqual(locUpdate.location, { path: "/tmp/ant-bridge-tui/src/acp/events.ts", line: 64 });

  consumeActivity(
    stream,
    blocks,
    {
      type: "tool_done",
      name: "read_file",
      args: {},
      location: locStart.location,
      toolCallId: "tc-read-2",
    },
    diffCtx,
    cwd,
    { onNativeEvent: (e) => events.push(e) },
  );
  assert.equal(diffCalls, 0);
  assert.equal(events[1].path, "/tmp/ant-bridge-tui/package.json");
  assert.equal(events[1].detail, undefined);
  assert.equal(formatNativeEventDetail(events[1]), "package.json");

  consumeActivity(
    stream,
    blocks,
    {
      type: "tool_done",
      name: "read_file",
      args: {},
      location: locUpdate.location,
      toolCallId: "tc-read-2b",
    },
    diffCtx,
    cwd,
    { onNativeEvent: (e) => events.push(e) },
  );
  assert.equal(diffCalls, 0);
  assert.equal(events[2].path, "/tmp/ant-bridge-tui/src/acp/events.ts");
  assert.equal(events[2].detail, "events.ts:64");

  // 3. grep_search extracts both SearchPath and Query without calling diffEdit.
  consumeActivity(
    stream,
    blocks,
    {
      type: "tool_done",
      name: "grep_search",
      args: { Query: "MouseRegion", SearchPath: "src" },
      output: "src/native-event-render.ts:6: MouseRegion",
      toolCallId: "tc-grep-1",
    },
    diffCtx,
    cwd,
    { onNativeEvent: (e) => events.push(e) },
  );
  assert.equal(diffCalls, 0);
  assert.equal(events[3].path, "/tmp/ant-bridge-tui/src");
  assert.equal(events[3].detail, "MouseRegion (src)");
  assert.equal(formatNativeEventDetail(events[3]), "MouseRegion (src)");

  // 4. Edit tools still run diffCtx.diffEdit when no native ACP diff is attached.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-edit-"));
  try {
    const editedPath = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(editedPath, "export const x = 1;\n");
    consumeActivity(
      stream,
      blocks,
      {
        type: "tool_done",
        name: "edit_file",
        args: { Path: editedPath },
        toolCallId: "tc-edit-1",
      },
      diffCtx,
      tmpDir,
      { onNativeEvent: (e) => events.push(e) },
    );
    assert.equal(diffCalls, 1);
    assert.equal(events[4].diff, "+unexpected");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cleanNativeCommandOutput strips agy wrapper, normalizes CRLF, and preserves exits/truncation", () => {
  const exitZero = [
    "Created At: 2026-11-12T13:13:47-07:00",
    "Completed At: 2026-11-12T13:13:50-07:00",
    "Command exited with code 0.",
    "",
    "Command output:",
    "alpha\r",
    "beta\r",
    "",
  ].join("\n");
  assert.equal(cleanNativeCommandOutput(exitZero), "alpha\nbeta");

  const silent = [
    "Created At: 2026-11-12T13:13:47-07:00",
    "Completed At: 2026-11-12T13:13:47-07:00",
    "Command exited with code 0.",
    "",
    "Command output:",
    "No output from the command.",
  ].join("\n");
  assert.equal(cleanNativeCommandOutput(silent), "");

  const nonZeroSilent = [
    "Created At: 2026-11-12T13:13:47-07:00",
    "Completed At: 2026-11-12T13:13:47-07:00",
    "Command exited with code 2.",
    "",
    "Command output:",
    "No output from the command.",
  ].join("\n");
  assert.equal(cleanNativeCommandOutput(nonZeroSilent), "[exit 2]");

  const nonZeroWithStderr = [
    "Created At: 2026-11-12T13:13:47-07:00",
    "Completed At: 2026-11-12T13:13:48-07:00",
    "Command exited with code 127.",
    "",
    "Command output:",
    "bash: unknown-cmd: command not found\r",
  ].join("\n");
  assert.equal(
    cleanNativeCommandOutput(nonZeroWithStderr),
    "bash: unknown-cmd: command not found\n[exit 127]",
  );

  const truncated = [
    "The tool's output was truncated due to being too long. " +
      "You can find the full output in a file at file:///tmp/agy-step-11/output.txt.",
    "",
    "Here is a preview with the middle of the output truncated:",
    "Created At: 2026-11-12T13:13:57-07:00",
    "Completed At: 2026-11-12T13:13:59-07:00",
    "Command exited with code 0.",
    "",
    "Command output:",
    "first line\r",
    "last line\r",
  ].join("\n");
  assert.equal(
    cleanNativeCommandOutput(truncated),
    "first line\nlast line\n[truncated -> /tmp/agy-step-11/output.txt]",
  );

  const hugeBody = Array.from({ length: 400 }, (_, i) => `row-${i + 1}-${"x".repeat(25)}`).join("\n");
  const capped = capNativeOutput(
    `Created At: 2026-11-12T13:00:00Z\nCompleted At: 2026-11-12T13:00:01Z\n` +
      `Command exited with code 0.\n\nCommand output:\n${hugeBody}`,
    1200,
  );
  const cleanedCapped = cleanNativeCommandOutput(capped);
  assert.equal(cleanedCapped.startsWith("row-1-"), true);
  assert.equal(cleanedCapped.endsWith(`row-400-${"x".repeat(25)}`), true);
  assert.equal(cleanedCapped.includes("Created At:"), false);
});

test("formatNativeEventLines renders 5-line collapsed tail/diff previews and full expanded output", () => {
  assert.equal(PREVIEW_LINES, 5);

  const silentLines = formatNativeEventLines(
    {
      name: "run_command",
      status: "completed",
      command: "mkdir -p build",
      output:
        "Created At: 2026-11-12T13:00:00Z\nCompleted At: 2026-11-12T13:00:00Z\n" +
        "Command exited with code 0.\n\nCommand output:\nNo output from the command.",
    },
    false,
    { expanded: false },
    plainTheme,
  );
  assert.deepEqual(silentLines, ["ok run_command mkdir -p build"]);

  const eightLineOutput = [
    "Created At: 2026-11-12T13:00:00Z",
    "Completed At: 2026-11-12T13:00:02Z",
    "Command exited with code 0.",
    "",
    "Command output:",
    ...Array.from({ length: 8 }, (_, i) => `out-${i + 1}`),
  ].join("\n");

  const cmdEvent = {
    name: "run_command",
    status: "completed",
    command: "npm test",
    output: eightLineOutput,
  };

  const collapsedCmd = formatNativeEventLines(
    cmdEvent,
    false,
    {
      expanded: false,
      keyHint: (id, desc) => `[${id}:${desc}]`,
    },
    tagTheme,
  );
  assert.deepEqual(collapsedCmd, [
    "<success>ok</success> <toolTitle>run_command</toolTitle> <muted>npm test</muted>",
    "<muted>... (3 earlier lines, click or </muted>[app.tools.expand:to expand]<muted>)</muted>",
    "<toolOutput>out-4</toolOutput>",
    "<toolOutput>out-5</toolOutput>",
    "<toolOutput>out-6</toolOutput>",
    "<toolOutput>out-7</toolOutput>",
    "<toolOutput>out-8</toolOutput>",
  ]);

  const expandedCmd = formatNativeEventLines(cmdEvent, true, { expanded: true }, plainTheme);
  assert.deepEqual(expandedCmd, [
    "ok run_command npm test",
    "out-1",
    "out-2",
    "out-3",
    "out-4",
    "out-5",
    "out-6",
    "out-7",
    "out-8",
  ]);

  const diffEvent = {
    name: "edit_file",
    status: "completed",
    path: "/tmp/ant-bridge-tui/src/provider.ts",
    diff: [
      " context-1",
      "-old-2",
      "+new-3",
      " context-4",
      "+new-5",
      "+new-6",
      " context-7",
    ].join("\n"),
    output: "Updated file",
  };

  const collapsedDiff = formatNativeEventLines(diffEvent, false, { expanded: false }, tagTheme);
  assert.deepEqual(collapsedDiff, [
    "<success>ok</success> <toolTitle>edit_file</toolTitle> <muted>provider.ts</muted>",
    "<toolDiffContext> context-1</toolDiffContext>",
    "<toolDiffRemoved>-old-2</toolDiffRemoved>",
    "<toolDiffAdded>+new-3</toolDiffAdded>",
    "<toolDiffContext> context-4</toolDiffContext>",
    "<toolDiffAdded>+new-5</toolDiffAdded>",
    "<muted>... (2 more lines, click or </muted><dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
  ]);

  const expandedDiff = formatNativeEventLines(diffEvent, true, { expanded: true }, tagTheme);
  assert.deepEqual(expandedDiff, [
    "<success>ok</success> <toolTitle>edit_file</toolTitle> <muted>provider.ts</muted>",
    "<dim>/tmp/ant-bridge-tui/src/provider.ts</dim>",
    "<toolDiffContext> context-1</toolDiffContext>",
    "<toolDiffRemoved>-old-2</toolDiffRemoved>",
    "<toolDiffAdded>+new-3</toolDiffAdded>",
    "<toolDiffContext> context-4</toolDiffContext>",
    "<toolDiffAdded>+new-5</toolDiffAdded>",
    "<toolDiffAdded>+new-6</toolDiffAdded>",
    "<toolDiffContext> context-7</toolDiffContext>",
    "<toolOutput>Updated file</toolOutput>",
  ]);
});

test("MouseRegion entry renderer toggles per-entry on left click and syncs with global Ctrl+O", async () => {
  const renderer = createNativeEventEntryRenderer();
  const entry = {
    customType: "agy-native-event",
    data: {
      name: "run_command",
      status: "completed",
      command: "seq 1 7",
      output:
        "Created At: 2026-11-12T13:00:00Z\nCompleted At: 2026-11-12T13:00:01Z\n" +
        "Command exited with code 0.\n\nCommand output:\n1\n2\n3\n4\n5\n6\n7",
    },
  };

  const comp = renderer(entry, { expanded: false }, plainTheme);
  assert.equal(comp instanceof MouseRegion, true);

  const host = new Container();
  host.addChild(comp);

  const initialLines = host.render(120).map((l) => l.trimEnd());
  assert.equal(initialLines.length, 7);
  assert.match(initialLines[1], /\.\.\. \(2 earlier lines, click or ctrl\+o to expand\)/);
  assert.deepEqual(initialLines.slice(2), ["3", "4", "5", "6", "7"]);

  // Press and right-click are ignored so drag-selection and context actions still work.
  assert.equal(host.handleMouse(mouseEvent("press", "left", 0, initialLines.length)), undefined);
  assert.equal(host.handleMouse(mouseEvent("click", "right", 0, initialLines.length)), undefined);

  // Left-click expands this individual entry.
  const clickExpand = host.handleMouse(mouseEvent("click", "left", 0, initialLines.length));
  assert.equal(clickExpand?.handled, true);
  const expandedLines = host.render(120).map((l) => l.trimEnd());
  assert.deepEqual(expandedLines, ["ok run_command seq 1 7", "1", "2", "3", "4", "5", "6", "7"]);

  // Rebuild with unchanged global expanded=false preserves local click expansion.
  const rebuiltSameGlobal = renderer(entry, { expanded: false }, plainTheme);
  assert.deepEqual(
    rebuiltSameGlobal.render(120).map((l) => l.trimEnd()),
    ["ok run_command seq 1 7", "1", "2", "3", "4", "5", "6", "7"],
  );

  // Global Ctrl+O toggle (false -> true -> false) resets local override and syncs cleanly.
  const globalExpanded = renderer(entry, { expanded: true }, plainTheme);
  assert.equal(globalExpanded.render(120).length, 8);

  const globalCollapsed = renderer(entry, { expanded: false }, plainTheme);
  const syncedLines = globalCollapsed.render(120).map((l) => l.trimEnd());
  assert.equal(syncedLines.length, 7);
  assert.match(syncedLines[1], /\.\.\. \(2 earlier lines/);

  // Second left-click toggles expanded -> collapsed directly on the component.
  globalCollapsed.handleMouse(mouseEvent("click", "left", 0, 7));
  assert.equal(globalCollapsed.render(120).length, 8);
  globalCollapsed.handleMouse(mouseEvent("click", "left", 0, 8));
  assert.equal(globalCollapsed.render(120).length, 7);

  // Verify extensions/index.ts wires the MouseRegion renderer for agy-native-event.
  const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-ext-render-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  try {
    const extMod = await importBridgeModule("extensions/index.ts");
    const entryRenderers = new Map();
    await extMod.default({
      registerProvider() {},
      registerCommand() {},
      registerTool() {},
      registerEntryRenderer(customType, fn) {
        entryRenderers.set(customType, fn);
      },
      registerMessageRenderer() {},
      on() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      appendEntry() {},
      sendMessage() {},
      events: { emit() {}, on() {} },
    });
    const wired = entryRenderers.get("agy-native-event");
    assert.equal(typeof wired, "function");
    const rendered = wired(entry, { expanded: false }, plainTheme);
    assert.equal(rendered instanceof MouseRegion, true);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});
