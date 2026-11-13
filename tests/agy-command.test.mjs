import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importBridgeModule, jiti } from "./helpers/pi-loader.mjs";

const { CombinedAutocompleteProvider } = await jiti.import("@earendil-works/pi-tui");
const { AcpDriver } = await importBridgeModule("src/acp/driver.ts");
const { saveConfig } = await importBridgeModule("src/config.ts");
const { SessionStore } = await importBridgeModule("src/sessions.ts");
const { SubagentRoster } = await importBridgeModule("src/subagent-roster.ts");
const { showTasksBrowser, taskItems } = await importBridgeModule("src/tasks-ui.ts");
const extMod = await importBridgeModule("extensions/index.ts");
const registerExtension = extMod.default;
const { registerAgyCommand } = extMod;

function waitForDiskFlush(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockSetup({ store, conversationId = null, tools = [] }) {
  const commands = new Map();
  const mockPi = {
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    getAllTools() {
      return tools;
    },
  };
  const ctx = {
    entries: [],
    store,
    usingFallback: false,
    acpDriver: {
      snapshot: () => ({
        state: "idle",
        conversationId,
        stats: { spawns: 0, turns: 0, reused: 0, recycles: 0 },
        lifecycle: [],
      }),
    },
    getMcpPort: () => null,
    bridgeTools: () => tools,
    hiddenBridgeTools: new Set(),
    fileLog: { log() {} },
    roster: new SubagentRoster(),
    checkAgySetup: async () => {},
  };
  registerAgyCommand(mockPi, ctx);
  return commands.get("agy");
}

function makeCmdCtx({ sessionId, cwd = "/tmp/default-cwd", mode = "tui", ui } = {}) {
  const notifications = [];
  const customCalls = [];
  const defaultUi = {
    notify(message, type) {
      notifications.push({ message, type });
    },
    setStatus() {},
    async custom(_factory, options) {
      customCalls.push(options);
      return { type: "close" };
    },
  };
  return {
    notifications,
    customCalls,
    cmdCtx: {
      ui: ui === undefined ? defaultUi : ui,
      hasUI: ui !== null,
      mode,
      cwd,
      sessionManager: {
        getSessionId: () => sessionId,
        getCwd: () => cwd,
      },
    },
  };
}

test("/agy clear removes only the current session binding while /agy clear all wipes all bindings", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-agy-clear-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;

  try {
    const storePath = path.join(tmpDir, "antigravity-bridge", "sessions.json");
    const store = new SessionStore(storePath);
    store.set("sid:session-a@acp", { conversationId: "conv-a", lastMessageCount: 2 });
    store.set("sid:session-b@acp", { conversationId: "conv-b", lastMessageCount: 4 });
    store.set("cwd:/workspace/proj-c@acp", {
      conversationId: "conv-c",
      lastMessageCount: 1,
    });
    await waitForDiskFlush();

    const agyCmd = createMockSetup({ store });

    // Status output advertises /agy clear [all], /agy mode accept-edits, and bound conversation.
    const statusRun = makeCmdCtx({ sessionId: "session-a", mode: "rpc" });
    await agyCmd.handler("", statusRun.cmdCtx);
    assert.equal(statusRun.notifications.length, 1);
    assert.match(statusRun.notifications[0].message, /\/agy clear \[all\]/);
    assert.match(statusRun.notifications[0].message, /\/agy mode accept-edits(?!\|plan)/);
    assert.match(statusRun.notifications[0].message, /bound conversation:\s+conv-a/);

    // Clearing session-a leaves session-b and cwd fallback intact.
    const clearA = makeCmdCtx({ sessionId: "session-a" });
    await agyCmd.handler("clear", clearA.cmdCtx);
    await waitForDiskFlush();

    assert.equal(store.get("sid:session-a@acp"), null);
    assert.equal(store.get("sid:session-b@acp")?.conversationId, "conv-b");
    assert.equal(store.get("cwd:/workspace/proj-c@acp")?.conversationId, "conv-c");
    assert.equal(clearA.notifications.length, 1);
    assert.match(clearA.notifications[0].message, /Cleared/i);
    assert.match(clearA.notifications[0].message, /\/agy clear all/);

    const onDiskAfterA = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.equal("sid:session-a@acp" in onDiskAfterA, false);
    assert.equal(onDiskAfterA["sid:session-b@acp"]?.conversationId, "conv-b");
    assert.equal(onDiskAfterA["cwd:/workspace/proj-c@acp"]?.conversationId, "conv-c");

    // Repeating /agy clear on an unbound session reports none bound and still preserves others.
    const clearAgain = makeCmdCtx({ sessionId: "session-a" });
    await agyCmd.handler("clear", clearAgain.cmdCtx);
    assert.equal(clearAgain.notifications.length, 1);
    assert.match(clearAgain.notifications[0].message, /No Antigravity session bound/i);
    assert.match(clearAgain.notifications[0].message, /\/agy clear all/);
    assert.equal(store.get("sid:session-b@acp")?.conversationId, "conv-b");

    // Empty sessionId falls back to cwd:<cwd>@acp matching src/provider.ts.
    const clearCwd = makeCmdCtx({ sessionId: "", cwd: "/workspace/proj-c" });
    await agyCmd.handler("clear", clearCwd.cmdCtx);
    await waitForDiskFlush();
    assert.equal(store.get("cwd:/workspace/proj-c@acp"), null);
    assert.equal(store.get("sid:session-b@acp")?.conversationId, "conv-b");

    // Unknown second arg warns without mutating remaining bindings.
    const clearBadArg = makeCmdCtx({ sessionId: "session-b" });
    await agyCmd.handler("clear unexpected", clearBadArg.cmdCtx);
    assert.equal(clearBadArg.notifications[0]?.type, "warning");
    assert.match(clearBadArg.notifications[0]?.message ?? "", /usage: \/agy clear \[all\]/);
    assert.equal(store.get("sid:session-b@acp")?.conversationId, "conv-b");

    // /agy clear all wipes all remaining bindings.
    const clearAll = makeCmdCtx({ sessionId: "session-a" });
    await agyCmd.handler("clear all", clearAll.cmdCtx);
    await waitForDiskFlush();
    assert.equal(store.size, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, "utf8")), {});
    assert.match(clearAll.notifications[0]?.message ?? "", /Cleared all antigravity session bindings/i);

    // /agy clear --all alias also wipes all bindings.
    store.set("sid:session-d@acp", { conversationId: "conv-d", lastMessageCount: 1 });
    await waitForDiskFlush();
    const clearDashAll = makeCmdCtx({ sessionId: "session-z" });
    await agyCmd.handler("clear --all", clearDashAll.cmdCtx);
    await waitForDiskFlush();
    assert.equal(store.size, 0);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/agy tasks and /agy artifacts resolve conversationId from SessionStore on resumed sessions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-agy-resumed-"));
  const fakeHome = path.join(tmpDir, "home");
  const agentDir = path.join(tmpDir, "agent");
  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = fakeHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const convDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", "conv-resumed");
    const tasksDir = path.join(convDir, ".system_generated", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-7.log"), "resumed background task output\n", "utf8");
    fs.writeFileSync(path.join(convDir, "summary.md"), "# Resumed Artifact\n", "utf8");

    const otherConvDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", "conv-other");
    fs.mkdirSync(otherConvDir, { recursive: true });

    const store = new SessionStore(path.join(agentDir, "antigravity-bridge", "sessions.json"));
    store.set("sid:resumed-sess@acp", {
      conversationId: "conv-resumed",
      lastMessageCount: 4,
    });
    await waitForDiskFlush();

    // Driver snapshot has conversationId: null (simulating pi -c / pi -r / Herdr refresh).
    const agyCmdNullDriver = createMockSetup({ store, conversationId: null });

    const tailRun = makeCmdCtx({ sessionId: "resumed-sess" });
    await agyCmdNullDriver.handler("tasks tail 7", tailRun.cmdCtx);
    assert.equal(tailRun.notifications.length, 1);
    assert.match(tailRun.notifications[0].message, /task #7 tail:\nresumed background task output/);

    const tasksBrowserRun = makeCmdCtx({ sessionId: "resumed-sess" });
    await agyCmdNullDriver.handler("tasks", tasksBrowserRun.cmdCtx);
    assert.equal(tasksBrowserRun.customCalls.length, 1);
    assert.equal(tasksBrowserRun.customCalls[0].blocked?.message, "Antigravity tasks (1)");

    const artifactsBrowserRun = makeCmdCtx({ sessionId: "resumed-sess" });
    await agyCmdNullDriver.handler("artifacts", artifactsBrowserRun.cmdCtx);
    assert.equal(artifactsBrowserRun.customCalls.length, 1);
    assert.equal(artifactsBrowserRun.customCalls[0].blocked?.message, "Antigravity artifacts (1)");

    // SessionStore binding wins even if acpDriver.snapshot().conversationId points at another session.
    const agyCmdOtherDriver = createMockSetup({ store, conversationId: "conv-other" });
    const tailPrecedence = makeCmdCtx({ sessionId: "resumed-sess" });
    await agyCmdOtherDriver.handler("tasks tail 7", tailPrecedence.cmdCtx);
    assert.match(tailPrecedence.notifications[0]?.message ?? "", /resumed background task output/);

    // Unbound session with null driver still warns cleanly.
    const unboundRun = makeCmdCtx({ sessionId: "fresh-unbound" });
    await agyCmdNullDriver.handler("tasks", unboundRun.cmdCtx);
    assert.equal(unboundRun.notifications[0]?.type, "warning");
    assert.match(unboundRun.notifications[0]?.message ?? "", /no Antigravity conversation bound yet/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/agy getArgumentCompletions completes subcommands, arguments, and pi.getAllTools() names", async () => {
  const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-agy-comp-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  process.env.AGY_BIN = path.join(tmpAgentDir, "missing-agy");

  const mockTools = [
    { name: "mcp_slack_post", description: "Post a Slack message" },
    { name: "subagent", description: "Delegate to a worker subagent" },
    { name: "codemode", description: "Run codemode script" },
  ];

  try {
    const commands = new Map();
    const mockPi = {
      registerProvider() {},
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerTool() {},
      registerEntryRenderer() {},
      registerMessageRenderer() {},
      on() {},
      getAllTools() {
        return mockTools;
      },
      getActiveTools() {
        return mockTools.map((t) => t.name);
      },
      appendEntry() {},
      sendMessage() {},
      events: { emit() {}, on() {} },
    };

    await registerExtension(mockPi);
    const agyCmd = commands.get("agy");
    assert.equal(typeof agyCmd?.getArgumentCompletions, "function");

    const valuesOf = (prefix) => agyCmd.getArgumentCompletions(prefix)?.map((item) => item.value) ?? null;

    assert.deepEqual(valuesOf(""), [
      "doctor",
      "auth",
      "auth-manual",
      "mode",
      "readonly",
      "permissions",
      "permission-mode",
      "bridge",
      "tools",
      "usage",
      "digest",
      "system-prompt",
      "timeout",
      "quota",
      "subagents",
      "artifacts",
      "tasks",
      "clear",
    ]);

    assert.deepEqual(valuesOf("auth"), ["auth", "auth-manual"]);
    assert.deepEqual(valuesOf("perm"), ["permissions", "permission-mode"]);
    assert.equal(valuesOf("nonexistent"), null);

    assert.deepEqual(valuesOf("clear "), ["clear all"]);
    assert.deepEqual(valuesOf("mode "), ["mode accept-edits"]);
    assert.deepEqual(valuesOf("readonly "), ["readonly on", "readonly off"]);
    assert.deepEqual(valuesOf("permissions "), ["permissions on", "permissions off"]);
    assert.deepEqual(valuesOf("permission-mode "), [
      "permission-mode ask",
      "permission-mode allow",
      "permission-mode deny",
    ]);
    assert.deepEqual(valuesOf("bridge "), ["bridge all", "bridge mcp", "bridge none"]);
    assert.deepEqual(valuesOf("usage "), ["usage estimate", "usage direct", "usage off"]);
    assert.deepEqual(valuesOf("digest "), ["digest on", "digest off"]);
    assert.deepEqual(valuesOf("system-prompt "), ["system-prompt on", "system-prompt off"]);
    assert.deepEqual(valuesOf("tools "), ["tools reset", "tools hide", "tools show"]);
    assert.deepEqual(valuesOf("tasks "), ["tasks tail"]);
    assert.deepEqual(valuesOf("artifacts "), ["artifacts open"]);

    assert.deepEqual(valuesOf("bridge m"), ["bridge mcp"]);
    assert.equal(valuesOf("doctor "), null);
    assert.equal(valuesOf("clear all "), null);

    assert.deepEqual(valuesOf("tools hide "), [
      "tools hide mcp_slack_post",
      "tools hide subagent",
      "tools hide codemode",
    ]);
    assert.deepEqual(valuesOf("tools hide sub"), ["tools hide subagent"]);
    assert.deepEqual(valuesOf("tools show MCP_"), ["tools show mcp_slack_post"]);
    assert.equal(valuesOf("tools reset "), null);

    // Verify CombinedAutocompleteProvider applies multi-token completions without clobbering prior tokens.
    const provider = new CombinedAutocompleteProvider(
      [
        {
          name: "agy",
          description: agyCmd.description,
          getArgumentCompletions: agyCmd.getArgumentCompletions,
        },
      ],
      tmpAgentDir,
      null,
    );
    const ac = new AbortController();
    const line = "/agy tools hide sub";
    const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: ac.signal });
    assert.equal(suggestions?.items.length, 1);
    const applied = provider.applyCompletion(
      [line],
      0,
      line.length,
      suggestions.items[0],
      suggestions.prefix,
    );
    assert.deepEqual(applied.lines, ["/agy tools hide subagent"]);
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});

test("/agy getArgumentCompletions completes task IDs and artifact names from bound conversation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-agy-dyncomp-"));
  const fakeHome = path.join(tmpDir, "home");
  const agentDir = path.join(tmpDir, "agent");
  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  process.env.HOME = fakeHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGY_BIN = path.join(tmpDir, "missing-agy");

  try {
    saveConfig({ bridgeTools: "none" });
    const convDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", "conv-comp");
    const tasksDir = path.join(convDir, ".system_generated", "tasks");
    const mediaDir = path.join(convDir, ".tempmediaStorage");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-17.log"), "seventeen\n", "utf8");
    fs.writeFileSync(path.join(tasksDir, "task-3.log"), "three\n", "utf8");
    fs.writeFileSync(path.join(tasksDir, "notes.txt"), "ignored\n", "utf8");
    fs.writeFileSync(path.join(convDir, "summary.md"), "# Summary\n", "utf8");
    fs.writeFileSync(path.join(convDir, "summary.md.metadata.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(convDir, ".hidden.md"), "hidden\n", "utf8");
    fs.writeFileSync(path.join(mediaDir, "chart.png"), "png", "utf8");

    const storePath = path.join(agentDir, "antigravity-bridge", "sessions.json");
    const seededStore = new SessionStore(storePath);
    seededStore.set("sid:sess-comp@acp", { conversationId: "conv-comp", lastMessageCount: 2 });
    await waitForDiskFlush();

    const commands = new Map();
    const handlers = new Map();
    const mockPi = {
      registerProvider() {},
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
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

    await registerExtension(mockPi);
    const agyCmd = commands.get("agy");
    const valuesOf = (prefix) =>
      agyCmd.getArgumentCompletions(prefix)?.map((item) => item.value) ?? null;

    // Before session_start, no active session is bound.
    assert.equal(valuesOf("tasks tail "), null);
    assert.equal(valuesOf("artifacts open "), null);

    const sessionCtx = {
      hasUI: false,
      mode: "rpc",
      cwd: tmpDir,
      ui: { notify() {}, setStatus() {} },
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "sess-comp",
        getCwd: () => tmpDir,
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    for (const fn of handlers.get("session_start") ?? []) {
      await fn({ type: "session_start", reason: "startup" }, sessionCtx);
    }

    assert.deepEqual(valuesOf("tasks tail "), ["tasks tail 3", "tasks tail 17"]);
    assert.deepEqual(valuesOf("tasks tail 1"), ["tasks tail 17"]);
    assert.equal(valuesOf("tasks tail 99"), null);

    assert.deepEqual(valuesOf("artifacts open "), [
      "artifacts open chart.png",
      "artifacts open summary.md",
    ]);
    assert.deepEqual(valuesOf("artifacts open sum"), ["artifacts open summary.md"]);
    assert.equal(valuesOf("artifacts open summary.md "), null);

    // After session_shutdown, active session state is cleared cleanly.
    for (const fn of handlers.get("session_shutdown") ?? []) {
      await fn({ type: "session_shutdown" }, sessionCtx);
    }
    assert.equal(valuesOf("tasks tail "), null);
    assert.equal(valuesOf("artifacts open "), null);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("tasks browser uses plain ASCII, Enter resolves tail, and /agy tasks formats 40-line tail", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-tasks-tail-"));
  const fakeHome = path.join(tmpDir, "home");
  const agentDir = path.join(tmpDir, "agent");
  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = fakeHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const sampleTasks = [
      {
        id: 42,
        logPath: "/tmp/task-42.log",
        bytes: 2048,
        modifiedMs: new Date("2026-11-12T10:05:00Z").getTime(),
        active: true,
        livenessKnown: true,
      },
    ];
    const items = taskItems(sampleTasks);
    assert.equal(items.length, 1);
    assert.equal(/^[\x00-\x7F]*$/.test(items[0].label), true);
    assert.equal(/^[\x00-\x7F]*$/.test(items[0].description ?? ""), true);
    assert.match(items[0].label, /#42 - ACTIVE/);

    let renderedLines = [];
    const selectedAction = await showTasksBrowser(
      {
        async custom(factory) {
          return new Promise((resolve) => {
            const theme = {
              fg: (_c, s) => s,
              bold: (s) => s,
            };
            const comp = factory({ requestRender() {} }, theme, {}, resolve);
            renderedLines = comp.render(72);
            comp.handleInput("\r");
          });
        },
      },
      sampleTasks,
      true,
    );
    assert.equal(selectedAction.type, "tail");
    assert.equal(selectedAction.task.id, 42);
    const footerLine = renderedLines.find((l) => l.includes("enter tail")) ?? "";
    assert.notEqual(footerLine, "");
    assert.equal(/^[\x00-\x7F]*$/.test(footerLine), true);

    const convDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", "conv-tail-ui");
    const tasksDir = path.join(convDir, ".system_generated", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const fiftyLines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n");
    fs.writeFileSync(path.join(tasksDir, "task-9.log"), fiftyLines, "utf8");

    const store = new SessionStore(path.join(agentDir, "antigravity-bridge", "sessions.json"));
    store.set("sid:tail-ui-sess@acp", { conversationId: "conv-tail-ui", lastMessageCount: 1 });
    await waitForDiskFlush();

    const agyCmd = createMockSetup({ store });
    const notifications = [];
    const ui = {
      notify(message, type) {
        notifications.push({ message, type });
      },
      setStatus() {},
      async custom(factory) {
        return new Promise((resolve) => {
          const theme = { fg: (_c, s) => s, bold: (s) => s };
          const comp = factory({ requestRender() {} }, theme, {}, resolve);
          comp.handleInput("\r");
        });
      },
    };
    const { cmdCtx } = makeCmdCtx({ sessionId: "tail-ui-sess", ui });
    await agyCmd.handler("tasks", cmdCtx);

    assert.equal(notifications.length, 1);
    const msg = notifications[0].message;
    assert.match(msg, /^task #9 tail:\n\.\.\.\nline-11\n/);
    assert.match(msg, /\nline-50$/);
    assert.equal(msg.includes("\nline-10\n"), false);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/agy doctor reports bound conversation and concise driver stats, and /agy bridge starts MCP live", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-dyn-mcp-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  process.env.AGY_BIN = path.join(tmpDir, "missing-agy");

  try {
    saveConfig({ bridgeTools: "none" });
    const storePath = path.join(tmpDir, "antigravity-bridge", "sessions.json");
    const seeded = new SessionStore(storePath);
    seeded.set("sid:doc-sess@acp", { conversationId: "conv-doctor-123", lastMessageCount: 1 });
    await waitForDiskFlush();

    const commands = new Map();
    const handlers = new Map();
    const mockPi = {
      registerProvider() {},
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
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

    await registerExtension(mockPi);
    const agyCmd = commands.get("agy");

    const sessionCtx = {
      hasUI: false,
      mode: "rpc",
      cwd: tmpDir,
      ui: { notify() {}, setStatus() {} },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "doc-sess",
        getCwd: () => tmpDir,
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    for (const fn of handlers.get("session_start") ?? []) {
      await fn({ type: "session_start", reason: "startup" }, sessionCtx);
    }

    // Initially bridgeTools is "none": MCP server was not started on session_start.
    const docBefore = makeCmdCtx({ sessionId: "doc-sess" });
    await agyCmd.handler("doctor", docBefore.cmdCtx);
    const beforeMsg = docBefore.notifications[0]?.message ?? "";
    assert.match(beforeMsg, /bridge:\s+none \(not running\)/);
    assert.match(beforeMsg, /bound conversation:\s+conv-doctor-123/);
    assert.match(beforeMsg, /driver stats:\s+spawns=0 turns=0 recycles=0\n/);
    assert.equal(beforeMsg.includes("reused="), false);
    assert.equal(beforeMsg.includes("last:"), false);

    // Switching to /agy bridge all starts the MCP server dynamically without /reload.
    const bridgeSwitch = makeCmdCtx({ sessionId: "doc-sess" });
    await agyCmd.handler("bridge all", bridgeSwitch.cmdCtx);
    assert.equal(bridgeSwitch.notifications.length, 1);
    assert.equal(bridgeSwitch.notifications[0].message.includes("/reload"), false);
    assert.match(bridgeSwitch.notifications[0].message, /bridge set to all\./);

    const docAfter = makeCmdCtx({ sessionId: "doc-sess" });
    await agyCmd.handler("doctor", docAfter.cmdCtx);
    assert.match(docAfter.notifications[0]?.message ?? "", /bridge:\s+all \(port \d+\)/);

    for (const fn of handlers.get("session_shutdown") ?? []) {
      await fn({ type: "session_shutdown" }, sessionCtx);
    }

    // Also verify the /agy interactive picker starts MCP dynamically when switching none -> mcp.
    saveConfig({ bridgeTools: "none" });
    for (const fn of handlers.get("session_start") ?? []) {
      await fn({ type: "session_start", reason: "startup" }, sessionCtx);
    }
    const pickerNotifications = [];
    const pickerUi = {
      notify(message, type) {
        pickerNotifications.push({ message, type });
      },
      setStatus() {},
      async custom(factory) {
        return new Promise((resolve) => {
          const theme = { fg: (_c, s) => s, bold: (s) => s };
          const comp = factory({ requestRender() {} }, theme, {}, resolve);
          // Navigate to "Bridge tools" (4th item: down x3), cycle none -> all -> mcp via Enter, Esc to save.
          comp.handleInput("\x1b[B");
          comp.handleInput("\x1b[B");
          comp.handleInput("\x1b[B");
          comp.handleInput("\r");
          comp.handleInput("\r");
          comp.handleInput("\x1b");
        });
      },
    };
    const pickerCtx = makeCmdCtx({ sessionId: "doc-sess", mode: "tui", ui: pickerUi });
    await agyCmd.handler("", pickerCtx.cmdCtx);
    assert.match(pickerNotifications[0]?.message ?? "", /bridge=mcp/);

    const docAfterPicker = makeCmdCtx({ sessionId: "doc-sess" });
    await agyCmd.handler("doctor", docAfterPicker.cmdCtx);
    assert.match(docAfterPicker.notifications[0]?.message ?? "", /bridge:\s+mcp \(port \d+\)/);

    const prevFlush = SessionStore.prototype.flush;
    let flushAwaited = false;
    SessionStore.prototype.flush = async () => {
      await new Promise((r) => setTimeout(r, 15));
      flushAwaited = true;
    };
    try {
      for (const fn of handlers.get("session_shutdown") ?? []) {
        await fn({ type: "session_shutdown" }, sessionCtx);
      }
      assert.equal(flushAwaited, true);
    } finally {
      if (prevFlush === undefined) delete SessionStore.prototype.flush;
      else SessionStore.prototype.flush = prevFlush;
    }
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("message_update suppresses 0 in / 0 out and renders exact vs estimated ACP token counts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-usage-footer-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  process.env.AGY_BIN = path.join(tmpDir, "missing-agy");

  try {
    saveConfig({ bridgeTools: "none", acp: { usageEstimate: "estimate" } });

    const handlers = new Map();
    const mockPi = {
      registerProvider() {},
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

    await registerExtension(mockPi);
    const onMessageUpdate = handlers.get("message_update")?.[0];
    assert.equal(typeof onMessageUpdate, "function");

    const statuses = [];
    const uiCtx = {
      hasUI: true,
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus(key, text) {
          statuses.push({ key, text });
        },
      },
    };

    // 1. All-zero streaming frame must NOT render "ACP ~ 0 in / 0 out".
    onMessageUpdate(
      {
        message: {
          role: "assistant",
          provider: "antigravity",
          usage: { input: 0, output: 0, cacheRead: 0 },
        },
      },
      uiCtx,
    );
    assert.deepEqual(statuses, []);

    // 2. Non-zero client-side estimate renders with "~".
    onMessageUpdate(
      {
        message: {
          role: "assistant",
          provider: "antigravity",
          usage: { input: 120, output: 45, cacheRead: 0 },
        },
      },
      uiCtx,
    );
    assert.deepEqual(statuses, [{ key: "agy-usage", text: "ACP ~ 120 in / 45 out" }]);

    // 3. Exact usage with cacheRead > 0 omits "~" and renders "(+N cached)".
    onMessageUpdate(
      {
        message: {
          role: "assistant",
          provider: "antigravity",
          usage: { input: 120, output: 45, cacheRead: 80 },
        },
      },
      uiCtx,
    );
    assert.equal(statuses.at(-1)?.text, "ACP 120 in (+80 cached) / 45 out");

    // 4. Exact usage via snapshot().acp.exactUsageSeen with cacheRead === 0 omits "~" and "(+0 cached)".
    const origSnapshot = AcpDriver.prototype.snapshot;
    AcpDriver.prototype.snapshot = function () {
      const snap = origSnapshot.call(this);
      return {
        ...snap,
        acp: { ...(snap.acp ?? {}), usageSeen: true, exactUsageSeen: true },
      };
    };
    try {
      onMessageUpdate(
        {
          message: {
            role: "assistant",
            provider: "antigravity",
            usage: { input: 95, output: 30, cacheRead: 0 },
          },
        },
        uiCtx,
      );
      assert.equal(statuses.at(-1)?.text, "ACP 95 in / 30 out");
    } finally {
      AcpDriver.prototype.snapshot = origSnapshot;
    }
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const RECYCLE_RELAY_SCRIPT = `
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

async function createRecycleAcpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-catalog-recycle-"));
  const relayPath = path.join(tmpDir, "fake-acp-relay.mjs");
  const launcherPath = path.join(tmpDir, "fake-agy.sh");
  fs.writeFileSync(relayPath, RECYCLE_RELAY_SCRIPT, "utf8");
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
    initCount() {
      return received.filter((f) => f.method === "initialize").length;
    },
    waitForFrame(pred, startIndex = 0) {
      for (let i = startIndex; i < received.length; i++) {
        if (pred(received[i])) return Promise.resolve(received[i]);
      }
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    sendUpdate(sessionId, update) {
      sendToClient({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
    },
    sendServerFrame(frame) {
      sendToClient(frame);
    },
    replyPrompt(promptFrame, text = "ok") {
      const sid = promptFrame.params.sessionId;
      sendToClient({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sid,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
      sendToClient({ jsonrpc: "2.0", id: promptFrame.id, result: { stopReason: "end_turn" } });
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test(
  "beforeTurn and /agy tools hide recycle warm acpDriver on catalog changes while preserving conversationId",
  async () => {
    const h = await createRecycleAcpHarness();
    const fakeHome = path.join(h.tmpDir, "home");
    const agentDir = path.join(h.tmpDir, "agent");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const prevHome = process.env.HOME;
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const prevAgyBin = process.env.AGY_BIN;
    const prevFakePort = process.env.FAKE_ACP_PORT;
    const prevDebug = process.env.AGY_DEBUG;
    const prevSubagentChild = process.env.PI_SUBAGENT_CHILD;
    process.env.HOME = fakeHome;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.AGY_BIN = h.launcherPath;
    process.env.FAKE_ACP_PORT = String(h.port);
    process.env.AGY_DEBUG = "1";
    delete process.env.PI_SUBAGENT_CHILD;

    const allTools = [
      {
        name: "codemode",
        description: "Run codemode batch",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "builtin", path: "builtin:codemode" },
      },
      {
        name: "subagent",
        description: "Delegate to worker",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "extension", path: "/ext/subagent.ts" },
      },
      {
        name: "mcp__slack__slack_read_channel",
        description: "Read Slack channel",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "builtin", path: "builtin:mcp" },
      },
      {
        name: "mcp__linear__list_issues",
        description: "List Linear issues",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "builtin", path: "builtin:mcp" },
      },
    ];
    let activeToolNames = ["codemode", "subagent"];

    const commands = new Map();
    const handlers = new Map();
    const providers = new Map();
    const mockPi = {
      registerProvider(id, spec) {
        providers.set(id, spec);
      },
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerTool() {},
      registerEntryRenderer() {},
      registerMessageRenderer() {},
      on(event, fn) {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
      },
      getAllTools() {
        return allTools;
      },
      getActiveTools() {
        return activeToolNames;
      },
      appendEntry() {},
      sendMessage() {},
      events: { emit() {}, on() {} },
    };

    const sessionCtx = {
      hasUI: false,
      mode: "rpc",
      cwd: h.tmpDir,
      ui: { notify() {}, setStatus() {} },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "recycle-sess",
        getCwd: () => h.tmpDir,
        getEntries: () => [],
        getBranch: () => [],
      },
    };

    let mcpClient = null;
    try {
      saveConfig({ bridgeTools: "all" });
      await registerExtension(mockPi);
      const agyCmd = commands.get("agy");
      const providerSpec = providers.get("antigravity");
      const model = providerSpec.models[0];

      for (const fn of handlers.get("session_start") ?? []) {
        await fn({ type: "session_start", reason: "startup" }, sessionCtx);
      }

      // 1. Turn 1 spawns initial ACP server (initCount = 1) and binds sess-1.
      const u1 = { role: "user", content: "Turn one", timestamp: 1 };
      let idx = h.received.length;
      const t1Stream = providerSpec.streamSimple(
        model,
        { messages: [u1] },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const sNew1 = await h.waitForFrame((f) => f.method === "session/new", idx);
      assert.deepEqual(
        sNew1.params.mcpServers.map((s) => s.name),
        ["pi-bridge"],
      );
      const p1 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(p1, "reply one");
      const a1 = await t1Stream.result();
      assert.equal(a1.stopReason, "stop");
      assert.equal(h.initCount(), 1);

      // 2. Turn 2 with unchanged catalog skips recycle (initCount stays 1) and loads sess-1.
      const u2 = { role: "user", content: "Turn two", timestamp: 2 };
      idx = h.received.length;
      const t2Stream = providerSpec.streamSimple(
        model,
        { messages: [u1, a1, u2] },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const sLoad2 = await h.waitForFrame((f) => f.method === "session/load", idx);
      assert.equal(sLoad2.params.sessionId, "sess-1");
      const p2 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(p2, "reply two");
      const a2 = await t2Stream.result();
      assert.equal(a2.stopReason, "stop");
      assert.equal(h.initCount(), 1);

      // 3. Standalone summarization turn skips beforeTurn recycle even after active tools change.
      activeToolNames = ["codemode", "subagent", "mcp__slack__slack_read_channel"];
      idx = h.received.length;
      const sumStream = providerSpec.streamSimple(
        model,
        {
          messages: [
            {
              role: "system",
              content: "You are a context summarization assistant.",
              timestamp: 0,
            },
            { role: "user", content: "Summarize prior turns.", timestamp: 3 },
          ],
        },
        { cwd: h.tmpDir, sessionId: "recycle-sess", cacheRetention: "none" },
      );
      const pSum = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(pSum, "summary text");
      const sumMsg = await sumStream.result();
      assert.equal(sumMsg.stopReason, "stop");
      assert.equal(h.initCount(), 1);

      // 4. Turn 3 triggers beforeTurn recycle (initCount -> 2), preserves sess-1, and adds pi-bridge-slack.
      const u3 = { role: "user", content: "Turn three", timestamp: 4 };
      idx = h.received.length;
      const t3Stream = providerSpec.streamSimple(
        model,
        { messages: [u1, a1, u2, a2, u3] },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const sLoad3 = await h.waitForFrame((f) => f.method === "session/load", idx);
      assert.equal(h.initCount(), 2);
      assert.equal(sLoad3.params.sessionId, "sess-1");
      assert.deepEqual(
        sLoad3.params.mcpServers.map((s) => s.name),
        ["pi-bridge", "pi-bridge-slack"],
      );
      const p3 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(p3, "reply three");
      const a3 = await t3Stream.result();
      assert.equal(a3.stopReason, "stop");

      // 5. Parked reentry() continuation skips recycle when active tools change mid-turn, then recycles on Turn 5.
      const u4 = { role: "user", content: "Turn four with tool", timestamp: 5 };
      idx = h.received.length;
      const t4Stream = providerSpec.streamSimple(
        model,
        { messages: [u1, a1, u2, a2, u3, a3, u4] },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const sLoad4 = await h.waitForFrame((f) => f.method === "session/load", idx);
      const p4 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      assert.equal(h.initCount(), 2);

      const coreSrv = sLoad4.params.mcpServers[0];
      mcpClient = new Client({ name: "park-client", version: "1.0.0" });
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(coreSrv.url), {
          requestInit: {
            headers: Object.fromEntries(coreSrv.headers.map((hdr) => [hdr.name, hdr.value])),
          },
        }),
      );
      const parkedToolPromise = mcpClient.callTool({ name: "codemode", arguments: {} });
      const parkedA4 = await t4Stream.result();
      assert.equal(parkedA4.stopReason, "toolUse");
      const parkedCall = parkedA4.content.find((c) => c.type === "toolCall");
      assert.equal(parkedCall?.name, "codemode");

      // Mutate active tools while Turn 4 is parked (simulating tool_search loading Linear tools).
      activeToolNames = [
        "codemode",
        "subagent",
        "mcp__slack__slack_read_channel",
        "mcp__linear__list_issues",
      ];

      const t4Cont = providerSpec.streamSimple(
        model,
        {
          messages: [
            u1,
            a1,
            u2,
            a2,
            u3,
            a3,
            u4,
            parkedA4,
            {
              role: "toolResult",
              toolCallId: parkedCall.id,
              toolName: "codemode",
              content: [{ type: "text", text: "loaded linear" }],
              isError: false,
              timestamp: 6,
            },
          ],
        },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const parkedToolRes = await parkedToolPromise;
      assert.equal(parkedToolRes.content[0].text, "loaded linear");
      assert.equal(h.initCount(), 2);
      h.replyPrompt(p4, "reply four");
      const a4 = await t4Cont.result();
      assert.equal(a4.stopReason, "stop");
      assert.equal(h.initCount(), 2);

      // Next normal turn (Turn 5) recycles (initCount -> 3) and exposes pi-bridge-linear + pi-bridge-slack.
      const u5 = { role: "user", content: "Turn five", timestamp: 7 };
      idx = h.received.length;
      const t5Stream = providerSpec.streamSimple(
        model,
        { messages: [u1, a1, u2, a2, u3, a3, u4, a4, u5] },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const sLoad5 = await h.waitForFrame((f) => f.method === "session/load", idx);
      assert.equal(h.initCount(), 3);
      assert.equal(sLoad5.params.sessionId, "sess-1");
      assert.deepEqual(
        sLoad5.params.mcpServers.map((s) => s.name),
        ["pi-bridge", "pi-bridge-linear", "pi-bridge-slack"],
      );
      const p5 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(p5, "reply five");
      const a5 = await t5Stream.result();
      assert.equal(a5.stopReason, "stop");

      // 6. /agy tools hide immediately recycles the warm ready driver while preserving sess-1.
      const docReady = makeCmdCtx({ sessionId: "recycle-sess" });
      await agyCmd.handler("doctor", docReady.cmdCtx);
      assert.match(docReady.notifications[0]?.message ?? "", /driver:\s+ready\b/);

      const hideSubagent = makeCmdCtx({ sessionId: "recycle-sess" });
      await agyCmd.handler("tools hide subagent", hideSubagent.cmdCtx);
      assert.match(
        hideSubagent.notifications[0]?.message ?? "",
        /subagent: hidden from Antigravity/,
      );

      const docRecycled = makeCmdCtx({ sessionId: "recycle-sess" });
      await agyCmd.handler("doctor", docRecycled.cmdCtx);
      assert.match(docRecycled.notifications[0]?.message ?? "", /driver:\s+dead\b/);
      assert.match(docRecycled.notifications[0]?.message ?? "", /bound conversation:\s+sess-1/);

      // /agy tools show and /agy tools reset also sync cleanly while driver is dead.
      const showSubagent = makeCmdCtx({ sessionId: "recycle-sess" });
      await agyCmd.handler("tools show subagent", showSubagent.cmdCtx);
      const resetTools = makeCmdCtx({ sessionId: "recycle-sess" });
      await agyCmd.handler("tools reset", resetTools.cmdCtx);

      // /agy bridge none exposes mcpServers: [] on the next turn while preserving sess-1.
      const bridgeNone = makeCmdCtx({ sessionId: "recycle-sess" });
      await agyCmd.handler("bridge none", bridgeNone.cmdCtx);
      const u6 = { role: "user", content: "Turn six no bridge", timestamp: 8 };
      idx = h.received.length;
      const t6Stream = providerSpec.streamSimple(
        model,
        { messages: [u1, a1, u2, a2, u3, a3, u4, a4, u5, a5, u6] },
        { cwd: h.tmpDir, sessionId: "recycle-sess" },
      );
      const sLoad6 = await h.waitForFrame((f) => f.method === "session/load", idx);
      assert.equal(h.initCount(), 4);
      assert.equal(sLoad6.params.sessionId, "sess-1");
      assert.deepEqual(sLoad6.params.mcpServers, []);
      const p6 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(p6, "reply six");
      const a6 = await t6Stream.result();
      assert.equal(a6.stopReason, "stop");

      // Verify bridge-catalog-recycle was logged at info level.
      const logDir = path.join(agentDir, "antigravity-bridge", "logs");
      let logContent = "";
      for (let i = 0; i < 20; i++) {
        if (fs.existsSync(logDir)) {
          const logFiles = fs.readdirSync(logDir).filter((n) => n.endsWith(".ndjson"));
          logContent = logFiles
            .map((n) => fs.readFileSync(path.join(logDir, n), "utf8"))
            .join("\n");
          if (logContent.includes('"event":"bridge-catalog-recycle"')) break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.match(logContent, /"event":"bridge-catalog-recycle"/);
    } finally {
      try {
        await mcpClient?.close();
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
      if (prevDebug === undefined) delete process.env.AGY_DEBUG;
      else process.env.AGY_DEBUG = prevDebug;
      if (prevSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = prevSubagentChild;
      await h.close();
    }
    await waitForDiskFlush();
    assert.equal(fs.existsSync(h.tmpDir), false);
  },
);

test(
  "mcpServers records warm-up fingerprint, idle permissionPolicy honors skipPermissions, and mcpLog dedupes",
  async () => {
    const h = await createRecycleAcpHarness();
    const fakeHome = path.join(h.tmpDir, "home");
    const agentDir = path.join(h.tmpDir, "agent");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const prevHome = process.env.HOME;
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const prevAgyBin = process.env.AGY_BIN;
    const prevFakePort = process.env.FAKE_ACP_PORT;
    const prevDebug = process.env.AGY_DEBUG;
    const prevSubagentChild = process.env.PI_SUBAGENT_CHILD;
    process.env.HOME = fakeHome;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.AGY_BIN = h.launcherPath;
    process.env.FAKE_ACP_PORT = String(h.port);
    process.env.AGY_DEBUG = "1";
    delete process.env.PI_SUBAGENT_CHILD;

    const allTools = [
      {
        name: "codemode",
        description: "Run codemode batch",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "builtin", path: "builtin:codemode" },
      },
      {
        name: "mcp__slack__users__list",
        description: "List Slack users",
        parameters: { type: "object", properties: {} },
        sourceInfo: { source: "builtin", path: "builtin:mcp" },
      },
    ];
    let activeToolNames = ["codemode"];

    const handlers = new Map();
    const providers = new Map();
    const uiNotifications = [];
    let selectCalls = 0;
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
        return allTools;
      },
      getActiveTools() {
        return activeToolNames;
      },
      appendEntry() {},
      sendMessage() {},
      events: { emit() {}, on() {} },
    };

    const sessionCtx = {
      hasUI: true,
      mode: "tui",
      cwd: h.tmpDir,
      ui: {
        theme: { fg: (_c, s) => s, bold: (s) => s },
        notify(message, type) {
          uiNotifications.push({ message, type });
        },
        setStatus() {},
        async select() {
          selectCalls += 1;
          return undefined;
        },
      },
      isProjectTrusted: () => false,
      sessionManager: {
        getSessionId: () => "hardening-sess",
        getCwd: () => h.tmpDir,
        getEntries: () => [],
        getBranch: () => [],
      },
    };

    let mcpClient = null;
    try {
      saveConfig({ bridgeTools: "all", skipPermissions: true, permissionMode: "ask" });
      await registerExtension(mockPi);
      const providerSpec = providers.get("antigravity");
      const model = providerSpec.models[0];

      for (const fn of handlers.get("session_start") ?? []) {
        await fn({ type: "session_start", reason: "startup" }, sessionCtx);
      }

      // 1. Pre-turn standalone summarization warm-up spawns agy acp (initCount = 1) and records
      //    lastSyncedCatalogFingerprint via mcpServers().
      let idx = h.received.length;
      const sumStream = providerSpec.streamSimple(
        model,
        {
          messages: [
            {
              role: "system",
              content: "You are a context summarization assistant.",
              timestamp: 0,
            },
            { role: "user", content: "Summarize history.", timestamp: 1 },
          ],
        },
        { cwd: h.tmpDir, sessionId: "hardening-sess", cacheRetention: "none" },
      );
      const sumSessionNew = await h.waitForFrame((f) => f.method === "session/new", idx);
      assert.deepEqual(
        sumSessionNew.params.mcpServers.map((s) => s.name),
        ["pi-bridge"],
      );
      const sumPrompt = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(sumPrompt, "summary");
      const sumRes = await sumStream.result();
      assert.equal(sumRes.stopReason, "stop");
      assert.equal(h.initCount(), 1);

      // Mutate active tools BEFORE Turn 1: because mcpServers() recorded the warm-up fingerprint,
      // Turn 1's beforeTurn recycles the warm driver (initCount -> 2) and exposes pi-bridge-slack.
      activeToolNames = ["codemode", "mcp__slack__users__list"];
      const u1 = { role: "user", content: "First real turn", timestamp: 2 };
      idx = h.received.length;
      const t1Stream = providerSpec.streamSimple(
        model,
        { messages: [u1] },
        { cwd: h.tmpDir, sessionId: "hardening-sess" },
      );
      const t1New = await h.waitForFrame((f) => f.method === "session/new", idx);
      assert.equal(h.initCount(), 2);
      assert.deepEqual(
        t1New.params.mcpServers.map((s) => s.name),
        ["pi-bridge", "pi-bridge-slack"],
      );
      const p1 = await h.waitForFrame((f) => f.method === "session/prompt", idx);
      h.replyPrompt(p1, "first reply");
      const a1 = await t1Stream.result();
      assert.equal(a1.stopReason, "stop");

      // 2. Out-of-turn session/request_permission while idle honors skipPermissions=true without prompting UI.
      idx = h.received.length;
      h.sendServerFrame({
        jsonrpc: "2.0",
        id: "perm-idle-allow",
        method: "session/request_permission",
        params: {
          sessionId: t1New.params.sessionId ?? "sess-2",
          toolCall: { toolCallId: "bg-1", kind: "execute", title: "Run background check" },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject_once", kind: "reject_once", name: "Reject" },
          ],
        },
      });
      const permAllowReply = await h.waitForFrame((f) => f.id === "perm-idle-allow", idx);
      assert.deepEqual(permAllowReply.result, {
        outcome: { outcome: "selected", optionId: "allow_once" },
      });
      assert.equal(selectCalls, 0);

      // When skipPermissions=false and permissionMode="deny", idle permission requests reject cleanly.
      saveConfig({ skipPermissions: false, permissionMode: "deny" });
      idx = h.received.length;
      h.sendServerFrame({
        jsonrpc: "2.0",
        id: "perm-idle-deny",
        method: "session/request_permission",
        params: {
          sessionId: "sess-2",
          toolCall: { toolCallId: "bg-2", kind: "execute", title: "Run denied check" },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject_once", kind: "reject_once", name: "Reject" },
          ],
        },
      });
      const permDenyReply = await h.waitForFrame((f) => f.id === "perm-idle-deny", idx);
      assert.deepEqual(permDenyReply.result, {
        outcome: { outcome: "selected", optionId: "reject_once" },
      });
      assert.equal(selectCalls, 0);
      saveConfig({ skipPermissions: true, permissionMode: "ask" });

      // 3. Out-of-turn bridged tool calls return actionable guidance, notify once in readable prose,
      //    deduplicate repeats, and reset on the next turn.
      const coreSrv = t1New.params.mcpServers[0];
      const authHeaders = Object.fromEntries(coreSrv.headers.map((hdr) => [hdr.name, hdr.value]));
      mcpClient = new Client({ name: "idle-test-client", version: "1.0.0" });
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(coreSrv.url), {
          requestInit: { headers: authHeaders },
        }),
      );

      uiNotifications.length = 0;
      const idleRes1 = await mcpClient.callTool({ name: "codemode", arguments: {} });
      assert.equal(idleRes1.isError, true);
      assert.match(
        idleRes1.content[0].text,
        /no active antigravity turn; the pi tool bridge only works while an antigravity model is streaming/,
      );
      assert.match(
        idleRes1.content[0].text,
        /background native agy subagents cannot call pi-bridge\* tools/,
      );
      assert.deepEqual(uiNotifications, [
        {
          message:
            "[ant-bridge] Ignored bridged tool call (codemode) because no Antigravity turn is active.",
          type: "warning",
        },
      ]);

      // Second out-of-turn call while still idle is deduplicated in UI notifications.
      const idleRes2 = await mcpClient.callTool({ name: "codemode", arguments: {} });
      assert.equal(idleRes2.isError, true);
      assert.equal(uiNotifications.length, 1);

      // Starting Turn 2 resets outOfTurnWarned; test non-out-of-turn call-tool-fail formatting mid-turn
      // by aborting an in-flight tools/call HTTP request, then verify out-of-turn warns once again after Turn 2.
      const u2 = { role: "user", content: "Second real turn", timestamp: 3 };
      idx = h.received.length;
      const t2Stream = providerSpec.streamSimple(
        model,
        { messages: [u1, a1, u2] },
        { cwd: h.tmpDir, sessionId: "hardening-sess" },
      );
      const p2 = await h.waitForFrame((f) => f.method === "session/prompt", idx);

      const mcpUrl = new URL(coreSrv.url);
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "codemode", arguments: {} },
      });
      const rawReq = http.request({
        hostname: mcpUrl.hostname,
        port: Number(mcpUrl.port),
        path: mcpUrl.pathname,
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
        },
      });
      rawReq.on("error", () => {});
      rawReq.end(payload);

      const parkedA2 = await t2Stream.result();
      assert.equal(parkedA2.stopReason, "toolUse");
      rawReq.destroy();

      // Wait briefly for server socket close -> call-tool-fail notification.
      for (let i = 0; i < 30; i++) {
        if (uiNotifications.some((n) => n.message.startsWith("[ant-bridge] Bridge tool codemode failed:"))) {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        uiNotifications.some(
          (n) =>
            n.message ===
            "[ant-bridge] Bridge tool codemode failed: agy disconnected before the tool result arrived",
        ),
        true,
      );

      const logDir = path.join(agentDir, "antigravity-bridge", "logs");
      const countTurnEnds = () => {
        if (!fs.existsSync(logDir)) return 0;
        return fs
          .readdirSync(logDir)
          .filter((n) => n.endsWith(".ndjson"))
          .map((n) => fs.readFileSync(path.join(logDir, n), "utf8"))
          .join("\n")
          .split("\n")
          .filter((l) => l.includes('"event":"turn-end"')).length;
      };
      const turnEndsBefore = countTurnEnds();
      h.replyPrompt(p2, "second reply");
      for (let i = 0; i < 60 && countTurnEnds() <= turnEndsBefore; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const beforePostTurnIdle = uiNotifications.length;
      const idleAfterTurn2 = await mcpClient.callTool({ name: "codemode", arguments: {} });
      assert.equal(idleAfterTurn2.isError, true);
      assert.equal(uiNotifications.length, beforePostTurnIdle + 1);
      assert.equal(
        uiNotifications.at(-1)?.message,
        "[ant-bridge] Ignored bridged tool call (codemode) because no Antigravity turn is active.",
      );

      // Unauthorized request formats as clean prose without JSON.stringify.
      const unauthRes = await fetch(coreSrv.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(unauthRes.status, 403);
      assert.equal(
        uiNotifications.at(-1)?.message,
        "[ant-bridge] Rejected unauthorized MCP bridge request (/mcp).",
      );
      assert.equal(
        uiNotifications.some((n) => n.message.includes('{"')),
        false,
      );

      // Verify structured NDJSON log still records call-tool-fail entries at warn and error levels.
      let logContent = "";
      for (let i = 0; i < 20; i++) {
        if (fs.existsSync(logDir)) {
          const logFiles = fs.readdirSync(logDir).filter((n) => n.endsWith(".ndjson"));
          logContent = logFiles
            .map((n) => fs.readFileSync(path.join(logDir, n), "utf8"))
            .join("\n");
          if (logContent.includes('"event":"unauthorized"')) break;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      const parsedLogs = logContent
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => JSON.parse(l));
      const outOfTurnLogs = parsedLogs.filter(
        (e) =>
          e.event === "call-tool-fail" &&
          String(e.data?.msg ?? "").includes("no active antigravity turn"),
      );
      assert.equal(outOfTurnLogs.length, 3);
      assert.equal(
        outOfTurnLogs.every((e) => e.level === "warn"),
        true,
      );
      const disconnectLogs = parsedLogs.filter(
        (e) =>
          e.event === "call-tool-fail" &&
          String(e.data?.msg ?? "").includes("agy disconnected"),
      );
      assert.equal(disconnectLogs.length, 1);
      assert.equal(disconnectLogs[0].level, "error");
    } finally {
      try {
        await mcpClient?.close();
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
      if (prevDebug === undefined) delete process.env.AGY_DEBUG;
      else process.env.AGY_DEBUG = prevDebug;
      if (prevSubagentChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = prevSubagentChild;
      await h.close();
    }
    await waitForDiskFlush();
    assert.equal(fs.existsSync(h.tmpDir), false);
  },
);
