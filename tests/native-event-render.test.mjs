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
  createPollRunEntryRenderer,
  formatNativeEventDetail,
  formatNativeEventLines,
  formatPollRunLines,
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

  // Verify extensions/index.ts wires MouseRegion renderers and live agy-native target status.
  const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-ext-render-"));
  const fakeHome = path.join(tmpAgentDir, "home");
  fs.mkdirSync(path.join(tmpAgentDir, "antigravity-bridge"), { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(
    path.join(tmpAgentDir, "antigravity-bridge", "config.json"),
    JSON.stringify({ bridgeTools: "none" }),
  );
  const fakeRelay = path.join(tmpAgentDir, "fake-agy.mjs");
  const fakeLauncher = path.join(tmpAgentDir, "fake-agy.sh");
  fs.writeFileSync(
    fakeRelay,
    [
      'if (process.argv[2] === "models") {',
      '  process.stdout.write("gemini-4-carbon-high  Gemini 4 Carbon (High)\\n");',
      "  process.exit(0);",
      "}",
      'if (process.argv[2] === "--version") {',
      '  process.stdout.write("1.5.4\\n");',
      "  process.exit(0);",
      "}",
      'process.stdin.setEncoding("utf8");',
      'let buf = "";',
      'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
      'process.stdin.on("data", (chunk) => {',
      "  buf += chunk;",
      '  const lines = buf.split("\\n");',
      '  buf = lines.pop() ?? "";',
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const msg = JSON.parse(line);",
      '    if (msg.method === "initialize") {',
      "      const agentInfo = { name: \"mock\", version: \"1.5.4\" };",
      '      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo } });',
      '    } else if (msg.method === "session/new") {',
      '      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-status", configOptions: [] } });',
      '    } else if (msg.method === "session/set_config_option") {',
      '      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });',
      '    } else if (msg.method === "session/prompt") {',
      "      const sid = msg.params.sessionId;",
      "      const upd = (update) =>",
      '        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update } });',
      '      const rInput = { Path: "src/provider.ts", StartLine: 10, EndLine: 20 };',
      '      upd({ sessionUpdate: "tool_call", toolCallId: "t1", name: "read_file", rawInput: rInput });',
      '      const cInput = { CommandLine: "a".repeat(70) };',
      '      upd({ sessionUpdate: "tool_call", toolCallId: "t2", name: "run_command", rawInput: cInput });',
      '      upd({ sessionUpdate: "tool_call", toolCallId: "t3", name: "list_resources", rawInput: { x: 1 } });',
      '      upd({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "ok" });',
      '      upd({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", rawOutput: "ok" });',
      '      upd({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed", rawOutput: "ok" });',
      '      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });',
      '      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });',
      "    }",
      "  }",
      "});",
    ].join("\n"),
  );
  fs.writeFileSync(
    fakeLauncher,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeRelay}" "$@"\n`,
    { mode: 0o755 },
  );

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  const prevAgyBin = process.env.AGY_BIN;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  process.env.HOME = fakeHome;
  process.env.AGY_BIN = fakeLauncher;
  const handlers = new Map();
  const providers = new Map();
  const nativeStatuses = [];
  try {
    const extMod = await importBridgeModule("extensions/index.ts");
    const entryRenderers = new Map();
    await extMod.default({
      registerProvider(id, spec) {
        providers.set(id, spec);
      },
      registerCommand() {},
      registerTool() {},
      registerEntryRenderer(customType, fn) {
        entryRenderers.set(customType, fn);
      },
      registerMessageRenderer() {},
      on(event, fn) {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
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

    const wiredPoll = entryRenderers.get("agy-poll-run");
    assert.equal(typeof wiredPoll, "function");
    const pollEntry = {
      customType: "agy-poll-run",
      data: {
        target: "git_commit",
        count: 2,
        state: "done",
        firstAt: "2026-11-12T20:00:00.000Z",
        lastAt: "2026-11-12T20:00:04.000Z",
      },
    };
    const renderedPoll = wiredPoll(pollEntry, { expanded: false }, plainTheme);
    assert.equal(renderedPoll instanceof MouseRegion, true);
    assert.equal(renderedPoll.render(120).length, 1);
    assert.equal(renderedPoll.handleMouse(mouseEvent("click", "left", 0, 1))?.handled, true);
    assert.equal(renderedPoll.render(120).length, 2);

    const mockUi = {
      theme: plainTheme,
      setStatus(key, text) {
        if (key === "agy-native") nativeStatuses.push(text);
      },
      notify() {},
    };
    for (const fn of handlers.get("session_start") ?? []) {
      await fn(
        { type: "session_start", reason: "startup" },
        {
          hasUI: true,
          mode: "rpc",
          ui: mockUi,
          isProjectTrusted: () => false,
          sessionManager: { getEntries: () => [], getBranch: () => [] },
        },
      );
    }

    const providerSpec = providers.get("antigravity");
    const stream = providerSpec.streamSimple(
      providerSpec.models[0],
      { messages: [{ role: "user", content: "Check status", timestamp: 1 }] },
      { cwd: tmpAgentDir, sessionId: "status-1" },
    );
    const resMsg = await stream.result();
    assert.equal(resMsg.stopReason, "stop");
    assert.deepEqual(nativeStatuses.slice(0, 4), [
      "agy read_file provider.ts:10-20...",
      `agy run_command ${"a".repeat(57)}... (2)`,
      "agy list_resources... (3)",
      undefined,
    ]);
  } finally {
    for (const fn of handlers.get("session_shutdown") ?? []) {
      await fn({}, { hasUI: false, ui: {} });
    }
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});

test("createPollRunEntryRenderer toggles poll rows on left click and syncs with global Ctrl+O", () => {
  const firstAt = "2026-11-12T20:00:00.000Z";
  const lastAt = "2026-11-12T20:00:08.000Z";
  const expectedFirst = new Date(firstAt).toLocaleTimeString();
  const expectedLast = new Date(lastAt).toLocaleTimeString();

  assert.deepEqual(formatPollRunLines(undefined, false, { expanded: false }, plainTheme), [
    "[poll] bridge_poll_result Poll bridge call (x0)",
  ]);

  assert.deepEqual(
    formatPollRunLines(
      { target: "codemode", count: 2, state: "failed", firstAt, lastAt },
      false,
      { expanded: false, keyHint: () => "ctrl+e " },
      tagTheme,
    ),
    [
      "[poll] <toolTitle>bridge_poll_result</toolTitle> " +
        "<muted>Poll codemode (x2, failed)</muted> <dim>(click or ctrl+e)</dim>",
    ],
  );

  assert.deepEqual(
    formatPollRunLines(
      { target: "subagent", count: 1, state: "done", firstAt, lastAt },
      true,
      { expanded: true },
      plainTheme,
    ),
    [
      "[poll] bridge_poll_result Poll subagent (x1)",
      `1 poll, ${expectedFirst} -> ${expectedLast}`,
    ],
  );

  const renderer = createPollRunEntryRenderer();
  const entry = {
    customType: "agy-poll-run",
    data: { target: "git_commit", count: 4, state: "done", firstAt, lastAt },
  };
  const otherEntry = {
    customType: "agy-poll-run",
    data: { target: "slack_search", count: 2, state: "running", firstAt, lastAt },
  };

  const comp = renderer(entry, { expanded: false }, plainTheme);
  assert.equal(comp instanceof MouseRegion, true);

  const host = new Container();
  host.addChild(comp);

  const collapsedLines = host.render(120).map((l) => l.trimEnd());
  assert.deepEqual(collapsedLines, [
    "[poll] bridge_poll_result Poll git_commit (x4) (click or ctrl+o)",
  ]);

  // Press and right-click are ignored so text selection and context actions work.
  assert.equal(host.handleMouse(mouseEvent("press", "left", 0, 1)), undefined);
  assert.equal(host.handleMouse(mouseEvent("click", "right", 0, 1)), undefined);

  // Left-click expands this poll entry while leaving sibling poll entries collapsed.
  assert.equal(host.handleMouse(mouseEvent("click", "left", 0, 1))?.handled, true);
  assert.deepEqual(
    host.render(120).map((l) => l.trimEnd()),
    [
      "[poll] bridge_poll_result Poll git_commit (x4)",
      `4 polls, ${expectedFirst} -> ${expectedLast}`,
    ],
  );
  assert.deepEqual(
    renderer(otherEntry, { expanded: false }, plainTheme)
      .render(120)
      .map((l) => l.trimEnd()),
    ["[poll] bridge_poll_result Poll slack_search (x2) (click or ctrl+o)"],
  );

  // Rebuild with unchanged global expanded=false preserves local click expansion.
  const rebuiltSameGlobal = renderer(entry, { expanded: false }, plainTheme);
  assert.equal(rebuiltSameGlobal.render(120).length, 2);

  // Global Ctrl+O toggle (false -> true -> false) resets local override and syncs cleanly.
  const globalExpanded = renderer(entry, { expanded: true }, plainTheme);
  assert.equal(globalExpanded.render(120).length, 2);

  const globalCollapsed = renderer(entry, { expanded: false }, plainTheme);
  assert.deepEqual(
    globalCollapsed.render(120).map((l) => l.trimEnd()),
    ["[poll] bridge_poll_result Poll git_commit (x4) (click or ctrl+o)"],
  );

  // Direct left-click toggles expanded -> collapsed.
  globalCollapsed.handleMouse(mouseEvent("click", "left", 0, 1));
  assert.equal(globalCollapsed.render(120).length, 2);
  globalCollapsed.handleMouse(mouseEvent("click", "left", 0, 2));
  assert.equal(globalCollapsed.render(120).length, 1);
});
