import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const {
  ACTIVATE_SKILL_TOOL_NAME,
  parseFrontmatter,
  scanSkills,
  skillsFromCommands,
} = await importBridgeModule("src/skills.ts");
const extMod = await importBridgeModule("extensions/index.ts");
const registerExtension = extMod.default;

test("skillsFromCommands filters skill commands, strips skill: prefix, normalizes descriptions, and dedupes", () => {
  const longDesc = `   First   line\n\tsecond line   ${"x".repeat(200)}   `;
  let fallbackCalled = false;

  const result = skillsFromCommands(
    [
      {
        name: "agy",
        description: "Extension command",
        source: "extension",
        sourceInfo: { path: "/ext/agy/index.ts" },
      },
      {
        name: "review",
        description: "Prompt template",
        source: "prompt",
        sourceInfo: { path: "/prompts/review.md" },
      },
      {
        name: "skill:missing-desc",
        description: "   \n\t  ",
        source: "skill",
        sourceInfo: { path: "/skills/missing-desc/SKILL.md" },
      },
      {
        name: "skill:missing-path",
        description: "Valid description",
        source: "skill",
        sourceInfo: { path: "   " },
      },
      {
        name: "skill:alpha",
        description: longDesc,
        source: "skill",
        sourceInfo: {
          path: "/pkg/skills/alpha/SKILL.md",
          baseDir: "  /pkg/skills/alpha-resources  ",
        },
      },
      {
        name: "skill:alpha",
        description: "Duplicate alpha must lose",
        source: "skill",
        sourceInfo: { path: "/other/alpha/SKILL.md" },
      },
      {
        name: "beta",
        description: "  Standalone\n  beta   skill  ",
        source: "skill",
        sourceInfo: {
          path: "/user/skills/beta.md",
          baseDir: "   ",
        },
      },
    ],
    () => {
      fallbackCalled = true;
      return [];
    },
  );

  assert.equal(fallbackCalled, false);
  assert.equal(result.length, 2);

  assert.equal(result[0].name, "alpha");
  assert.equal(result[0].filePath, "/pkg/skills/alpha/SKILL.md");
  assert.equal(result[0].dir, "/pkg/skills/alpha-resources");
  assert.equal(result[0].description.length, 160);
  assert.equal(result[0].description.startsWith("First line second line xxx"), true);
  assert.equal(/\s{2,}/.test(result[0].description), false);

  assert.deepEqual(result[1], {
    name: "beta",
    description: "Standalone beta skill",
    filePath: "/user/skills/beta.md",
    dir: "/user/skills",
  });
});

test("skillsFromCommands invokes fallback only when no valid skill commands exist", () => {
  const fallbackSkills = [
    {
      name: "fallback-skill",
      description: "From fallback scanner",
      filePath: "/fallback/SKILL.md",
      dir: "/fallback",
    },
  ];

  let calls = 0;
  const fromNonSkillOnly = skillsFromCommands(
    [
      {
        name: "agy",
        description: "Extension command",
        source: "extension",
        sourceInfo: { path: "/ext/index.ts" },
      },
    ],
    () => {
      calls++;
      return fallbackSkills;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(fromNonSkillOnly, fallbackSkills);

  assert.deepEqual(skillsFromCommands([]), []);
});

test("parseFrontmatter and scanSkills handle YAML block scalars and strip surrounding quotes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-skills-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;

  try {
    const homeDir = path.join(tmpDir, "home");
    const piSkills = path.join(homeDir, ".pi", "agent", "skills");
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });

    const writeSkill = (base, relDir, content) => {
      const dir = path.join(base, relDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
    };

    writeSkill(
      piSkills,
      "folded-strip",
      [
        "---",
        "name: 'folded-strip'",
        "description: >-",
        "  Query Andromeda datasets",
        "  across multiple clusters.",
        "---",
        "# Folded Strip",
      ].join("\n"),
    );

    writeSkill(
      piSkills,
      "folded-clip",
      [
        "---",
        "name: folded-clip",
        "description: >",
        "  Folded block description",
        "  second line.",
        "---",
        "# Folded Clip",
      ].join("\n"),
    );

    writeSkill(
      piSkills,
      "literal-block",
      [
        "---",
        "name: literal-block",
        "description: |-",
        "  First literal line.",
        "  Second literal line.",
        "---",
        "# Literal",
      ].join("\n"),
    );

    writeSkill(
      piSkills,
      "literal-clip",
      [
        "---",
        'name: "literal-clip"',
        "description: |",
        "  Alpha line.",
        "  Beta line.",
        "---",
        "# Literal Clip",
      ].join("\n"),
    );

    const longQuoted = `"Alert-first workflow with \\"quoted\\" token ${"z".repeat(180)}"`;
    writeSkill(
      piSkills,
      "double-quoted",
      ["---", "name: double-quoted", `description: ${longQuoted}`, "---", "# Quoted"].join("\n"),
    );

    writeSkill(
      piSkills,
      "single-quoted",
      [
        "---",
        "name: single-quoted",
        "description: 'Living docs (user''s shared pages and specs)'",
        "---",
        "# Single Quoted",
      ].join("\n"),
    );

    writeSkill(
      piSkills,
      "empty-block",
      ["---", "name: empty-block", "description: >-", "---", "# Empty"].join("\n"),
    );

    writeSkill(
      path.join(projectDir, ".agents", "skills"),
      "proj-skill",
      [
        "---",
        "name: proj-skill",
        "description: >",
        "  Project-scoped skill description.",
        "---",
        "# Project Skill",
      ].join("\n"),
    );

    const directLiteral = parseFrontmatter(
      ["---", "name: 'lit'", "description: |-", "  Line A", "  Line B", "---"].join("\n"),
    );
    assert.deepEqual(directLiteral, { name: "lit", description: "Line A\nLine B" });

    const untrustedCatalog = scanSkills(undefined, homeDir);
    const byName = new Map(untrustedCatalog.map((s) => [s.name, s]));

    assert.equal(byName.has("empty-block"), false);
    assert.equal(
      byName.get("folded-strip")?.description,
      "Query Andromeda datasets across multiple clusters.",
    );
    assert.equal(byName.get("folded-clip")?.description, "Folded block description second line.");
    assert.equal(byName.get("literal-block")?.description, "First literal line. Second literal line.");
    assert.equal(byName.get("literal-clip")?.description, "Alpha line. Beta line.");

    const dq = byName.get("double-quoted")?.description ?? "";
    assert.equal(dq.startsWith('Alert-first workflow with "quoted" token '), true);
    assert.equal(dq.startsWith('"'), false);
    assert.equal(dq.length, 160);

    assert.equal(
      byName.get("single-quoted")?.description,
      "Living docs (user's shared pages and specs)",
    );
    assert.equal(byName.has("proj-skill"), false);

    const trustedCatalog = scanSkills(projectDir, homeDir);
    assert.equal(
      trustedCatalog.find((s) => s.name === "proj-skill")?.description,
      "Project-scoped skill description.",
    );
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test(
  "pi-bridge resolves skills dynamically from pi.getCommands() and falls back to trusted activeSessionCwd",
  async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-bridge-live-skills-"));
  const fakeHome = path.join(tmpDir, "home");
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "trusted-proj");
  const pkgSkillDir = path.join(tmpDir, "pkg-skill");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi", "skills", "fallback-proj"), { recursive: true });
  fs.mkdirSync(pkgSkillDir, { recursive: true });

  const pkgSkillFile = path.join(pkgSkillDir, "SKILL.md");
  fs.writeFileSync(pkgSkillFile, "---\nname: pkg-live\ndescription: Live package skill\n---\n# Body 1", "utf8");

  const projSkillFile = path.join(projectDir, ".pi", "skills", "fallback-proj", "SKILL.md");
  fs.writeFileSync(
    projSkillFile,
    "---\nname: fallback-proj\ndescription: >-\n  Project fallback skill\n---\n# Project Body",
    "utf8",
  );

  let capturedMcpServer = null;
  const tcpServer = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          sock.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.4" } },
            }) + "\n",
          );
        } else if (msg.method === "session/new") {
          capturedMcpServer = msg.params?.mcpServers?.[0] ?? null;
          sock.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { sessionId: "conv-skills-1", configOptions: [] },
            }) + "\n",
          );
        } else if (msg.method === "session/set_config_option") {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } }) + "\n");
        } else if (msg.method === "session/prompt") {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\n");
        }
      }
    });
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const tcpPort = tcpServer.address().port;

  const launcherPath = path.join(tmpDir, "fake-agy.mjs");
  fs.writeFileSync(
    launcherPath,
    [
      "#!/usr/bin/env node",
      'import net from "node:net";',
      "if (process.argv[2] === 'models') { process.exit(1); }",
      "if (process.argv[2] === '--version') { console.log('1.5.4'); process.exit(0); }",
      `const sock = net.connect(${tcpPort}, "127.0.0.1");`,
      "process.stdin.pipe(sock);",
      "sock.pipe(process.stdout);",
      "sock.on('close', () => process.exit(0));",
    ].join("\n"),
    { mode: 0o755 },
  );

  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevAgyBin = process.env.AGY_BIN;
  process.env.HOME = fakeHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGY_BIN = launcherPath;

  let liveCommands = [
    {
      name: "skill:pkg-live",
      description: "Live package skill v1",
      source: "skill",
      sourceInfo: { path: pkgSkillFile, baseDir: pkgSkillDir },
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
      return [];
    },
    getActiveTools() {
      return [];
    },
    getCommands() {
      return liveCommands;
    },
    appendEntry() {},
    sendMessage() {},
    events: { emit() {}, on() {} },
  };

  let mcpClient = null;
  try {
    await registerExtension(mockPi);

    const sessionCtx = {
      hasUI: false,
      mode: "rpc",
      cwd: projectDir,
      ui: { notify() {}, setStatus() {} },
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "sess-skills",
        getCwd: () => projectDir,
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    for (const fn of handlers.get("session_start") ?? []) {
      await fn({ type: "session_start", reason: "startup" }, sessionCtx);
    }

    // Run one quick turn to capture the live pi-bridge MCP URL and auth header.
    const providerSpec = providers.get("antigravity");
    const stream = providerSpec.streamSimple(
      providerSpec.models[0],
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { cwd: projectDir, sessionId: "sess-skills" },
    );
    for await (const _ev of stream) {
      // Drain stream events.
    }

    assert.equal(Boolean(capturedMcpServer?.url), true);
    mcpClient = new Client({ name: "skills-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(capturedMcpServer.url), {
      requestInit: {
        headers: Object.fromEntries(capturedMcpServer.headers.map((h) => [h.name, h.value])),
      },
    });
    await mcpClient.connect(transport);

    // 1. Live skill from pi.getCommands() wins without touching fallback scan.
    const list1 = await mcpClient.listTools();
    const activate1 = list1.tools.find((t) => t.name === ACTIVATE_SKILL_TOOL_NAME);
    assert.deepEqual(activate1?.inputSchema?.properties?.name?.enum, ["pkg-live"]);
    assert.match(activate1?.description ?? "", /- pkg-live: Live package skill v1/);

    const call1 = await mcpClient.callTool({
      name: ACTIVATE_SKILL_TOOL_NAME,
      arguments: { name: "pkg-live" },
    });
    assert.equal(call1.isError, false);
    assert.match(call1.content[0].text, /# Body 1/);
    assert.equal(call1.content[0].text.includes(`[skill resources dir: ${pkgSkillDir}]`), true);

    // 2. Updating pi.getCommands() (e.g. after /reload) updates tools/list and tools/call live.
    const reloadedDir = path.join(tmpDir, "reloaded-skill");
    const reloadedFile = path.join(reloadedDir, "SKILL.md");
    fs.mkdirSync(reloadedDir, { recursive: true });
    fs.writeFileSync(reloadedFile, "---\nname: reloaded\ndescription: Added on reload\n---\n# Reloaded Body", "utf8");
    liveCommands = [
      {
        name: "skill:reloaded",
        description: "Added on reload",
        source: "skill",
        sourceInfo: { path: reloadedFile },
      },
    ];

    const list2 = await mcpClient.listTools();
    const activate2 = list2.tools.find((t) => t.name === ACTIVATE_SKILL_TOOL_NAME);
    assert.deepEqual(activate2?.inputSchema?.properties?.name?.enum, ["reloaded"]);

    const call2 = await mcpClient.callTool({
      name: ACTIVATE_SKILL_TOOL_NAME,
      arguments: { name: "reloaded" },
    });
    assert.equal(call2.isError, false);
    assert.match(call2.content[0].text, /# Reloaded Body/);

    // 3. Empty pi.getCommands() falls back to scanSkills(activeSessionCwd) for trusted project.
    liveCommands = [];
    const list3 = await mcpClient.listTools();
    const activate3 = list3.tools.find((t) => t.name === ACTIVATE_SKILL_TOOL_NAME);
    assert.deepEqual(activate3?.inputSchema?.properties?.name?.enum, ["fallback-proj"]);
    assert.match(activate3?.description ?? "", /- fallback-proj: Project fallback skill/);

    await mcpClient.close();
    mcpClient = null;

    for (const fn of handlers.get("session_shutdown") ?? []) {
      await fn({ type: "session_shutdown" }, sessionCtx);
    }
  } finally {
    if (mcpClient) await mcpClient.close().catch(() => {});
    await new Promise((resolve) => tcpServer.close(resolve));
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevAgyBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgyBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
