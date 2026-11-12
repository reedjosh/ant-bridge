import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule, jiti } from "./helpers/pi-loader.mjs";

const { CombinedAutocompleteProvider } = await jiti.import("@earendil-works/pi-tui");
const { SessionStore } = await importBridgeModule("src/sessions.ts");
const { SubagentRoster } = await importBridgeModule("src/subagent-roster.ts");
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
    store.set("sid:session-a@acp", { conversationId: "conv-a", lastStepIdx: 1, lastMessageCount: 2 });
    store.set("sid:session-b@acp", { conversationId: "conv-b", lastStepIdx: 3, lastMessageCount: 4 });
    store.set("cwd:/workspace/proj-c@acp", {
      conversationId: "conv-c",
      lastStepIdx: 0,
      lastMessageCount: 1,
    });
    await waitForDiskFlush();

    const agyCmd = createMockSetup({ store });

    // Status output advertises /agy clear [all].
    const statusRun = makeCmdCtx({ sessionId: "session-a", mode: "rpc" });
    await agyCmd.handler("", statusRun.cmdCtx);
    assert.equal(statusRun.notifications.length, 1);
    assert.match(statusRun.notifications[0].message, /\/agy clear \[all\]/);

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
    store.set("sid:session-d@acp", { conversationId: "conv-d", lastStepIdx: 0, lastMessageCount: 1 });
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
      lastStepIdx: 2,
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
