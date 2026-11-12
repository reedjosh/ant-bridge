import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importBridgeModule } from "./helpers/pi-loader.mjs";

const { loadConfig, saveConfig } = await importBridgeModule("src/config.ts");
const { isPidAlive } = await importBridgeModule("src/mcp-server.ts");
const { SessionStore } = await importBridgeModule("src/sessions.ts");

function tmpFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function acquireDeadPid() {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  let candidate = res.pid ?? 999_991;
  while (candidate === process.pid || isPidAlive(candidate)) {
    candidate += 1;
  }
  return candidate;
}

test("concurrent SessionStore writes in the same PID keep all keys and leave zero .tmp files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-sessions-concurrent-"));
  try {
    const storePath = path.join(tmpDir, "sessions.json");
    const storeA = new SessionStore(storePath);
    const storeB = new SessionStore(storePath);

    storeA.set("sid:alpha@acp", {
      conversationId: "conv-alpha",
      lastMessageCount: 2,
      compactionHash: "hash-alpha",
    });
    storeB.set("sid:beta@acp", {
      conversationId: "conv-beta",
      lastMessageCount: 5,
    });
    storeA.set("sid:gamma@acp", {
      conversationId: "conv-gamma",
      lastMessageCount: 1,
    });

    await Promise.all([storeA.flush(), storeB.flush()]);

    assert.deepEqual(tmpFilesIn(tmpDir), []);

    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.deepEqual(onDisk, {
      "sid:alpha@acp": {
        conversationId: "conv-alpha",
        lastMessageCount: 2,
        compactionHash: "hash-alpha",
      },
      "sid:beta@acp": {
        conversationId: "conv-beta",
        lastMessageCount: 5,
      },
      "sid:gamma@acp": {
        conversationId: "conv-gamma",
        lastMessageCount: 1,
      },
    });

    const reloaded = new SessionStore(storePath);
    assert.deepEqual(reloaded.get("sid:alpha@acp"), {
      conversationId: "conv-alpha",
      lastMessageCount: 2,
      compactionHash: "hash-alpha",
    });
    assert.deepEqual(reloaded.get("sid:beta@acp"), {
      conversationId: "conv-beta",
      lastMessageCount: 5,
    });
    assert.deepEqual(reloaded.get("sid:gamma@acp"), {
      conversationId: "conv-gamma",
      lastMessageCount: 1,
    });

    storeB.clear();
    await storeB.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, "utf8")), {});
    assert.deepEqual(tmpFilesIn(tmpDir), []);

    // Failed rename (target replaced by a directory) unlinks its temp file in both persist and clear.
    const blockedPath = path.join(tmpDir, "blocked-dir");
    fs.mkdirSync(blockedPath);
    const blockedStore = new SessionStore(blockedPath);
    blockedStore.set("sid:fail@acp", { conversationId: "conv-fail", lastMessageCount: 1 });
    await blockedStore.flush();
    assert.deepEqual(tmpFilesIn(tmpDir), []);

    blockedStore.clear();
    await blockedStore.flush();
    assert.deepEqual(tmpFilesIn(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("legacy lastStepIdx is stripped on SessionStore load, runtime set, and persist", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-sessions-legacy-"));
  try {
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "sid:legacy-1@acp": {
            conversationId: "conv-leg-1",
            lastStepIdx: 12,
            lastMessageCount: 4,
            compactionHash: "compact-1",
          },
          "sid:legacy-2@acp": {
            conversationId: "conv-leg-2",
            lastStepIdx: 0,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const store = new SessionStore(storePath);
    const leg1 = store.get("sid:legacy-1@acp");
    const leg2 = store.get("sid:legacy-2@acp");

    assert.deepEqual(leg1, {
      conversationId: "conv-leg-1",
      lastMessageCount: 4,
      compactionHash: "compact-1",
    });
    assert.equal("lastStepIdx" in leg1, false);

    assert.deepEqual(leg2, {
      conversationId: "conv-leg-2",
      lastMessageCount: 0,
    });
    assert.equal("lastStepIdx" in leg2, false);

    // Passing a legacy lastStepIdx field at runtime is also ignored in cache and on disk.
    store.set("sid:runtime@acp", {
      conversationId: "conv-runtime",
      lastStepIdx: 99,
      lastMessageCount: 7,
    });
    assert.deepEqual(store.get("sid:runtime@acp"), {
      conversationId: "conv-runtime",
      lastMessageCount: 7,
    });
    assert.equal("lastStepIdx" in store.get("sid:runtime@acp"), false);

    await store.flush();

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.deepEqual(persisted, {
      "sid:legacy-1@acp": {
        conversationId: "conv-leg-1",
        lastMessageCount: 4,
        compactionHash: "compact-1",
      },
      "sid:legacy-2@acp": {
        conversationId: "conv-leg-2",
        lastMessageCount: 0,
      },
      "sid:runtime@acp": {
        conversationId: "conv-runtime",
        lastMessageCount: 7,
      },
    });
    for (const entry of Object.values(persisted)) {
      assert.equal("lastStepIdx" in entry, false);
    }
    assert.deepEqual(tmpFilesIn(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("SessionStore load sweeps dead-PID .tmp files while preserving live-PID and unrelated .tmp files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-sessions-sweep-"));
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  try {
    const liveOtherPid = sleeper.pid;
    assert.equal(typeof liveOtherPid, "number");
    assert.notEqual(liveOtherPid, process.pid);
    assert.equal(isPidAlive(liveOtherPid), true);

    const deadPid = acquireDeadPid();
    assert.equal(isPidAlive(deadPid), false);

    const storePath = path.join(tmpDir, "sessions.json");
    const deadLegacy = `${storePath}.${deadPid}.tmp`;
    const deadSeq1 = `${storePath}.${deadPid}.1.tmp`;
    const deadSeq42 = `${storePath}.${deadPid}.42.tmp`;
    const selfLegacy = `${storePath}.${process.pid}.tmp`;
    const selfSeq = `${storePath}.${process.pid}.9.tmp`;
    const liveOtherLegacy = `${storePath}.${liveOtherPid}.tmp`;
    const liveOtherSeq = `${storePath}.${liveOtherPid}.3.tmp`;
    const unrelatedDead = path.join(tmpDir, `config.json.${deadPid}.1.tmp`);

    for (const f of [
      deadLegacy,
      deadSeq1,
      deadSeq42,
      selfLegacy,
      selfSeq,
      liveOtherLegacy,
      liveOtherSeq,
      unrelatedDead,
    ]) {
      fs.writeFileSync(f, "partial\n", "utf8");
    }

    const store = new SessionStore(storePath);
    assert.equal(store.size, 0);

    assert.equal(fs.existsSync(deadLegacy), false);
    assert.equal(fs.existsSync(deadSeq1), false);
    assert.equal(fs.existsSync(deadSeq42), false);

    assert.equal(fs.existsSync(selfLegacy), true);
    assert.equal(fs.existsSync(selfSeq), true);
    assert.equal(fs.existsSync(liveOtherLegacy), true);
    assert.equal(fs.existsSync(liveOtherSeq), true);
    assert.equal(fs.existsSync(unrelatedDead), true);
  } finally {
    sleeper.kill("SIGKILL");
    await new Promise((resolve) => {
      if (sleeper.exitCode !== null || sleeper.signalCode !== null) resolve();
      else sleeper.once("exit", () => resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("saveConfig writes atomically with sequenced temp names and leaves zero .tmp files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ant-config-atomic-"));
  const savedEnv = {
    AGY_MODE: process.env.AGY_MODE,
    AGY_READONLY: process.env.AGY_READONLY,
    AGY_DIGEST: process.env.AGY_DIGEST,
  };
  delete process.env.AGY_MODE;
  delete process.env.AGY_READONLY;
  delete process.env.AGY_DIGEST;

  try {
    const cfgPath = path.join(tmpDir, "config.json");
    saveConfig({ mode: "plan", digest: true }, cfgPath);
    saveConfig({ readOnly: true, escalateLongTools: ["custom_tool"] }, cfgPath);

    assert.deepEqual(tmpFilesIn(tmpDir), []);

    const loaded = loadConfig(cfgPath);
    assert.equal(loaded.mode, "plan");
    assert.equal(loaded.digest, true);
    assert.equal(loaded.readOnly, true);
    assert.deepEqual(loaded.escalateLongTools, ["custom_tool"]);

    // Rename failure (directory target) unlinks temp file before rethrowing.
    const blockedCfg = path.join(tmpDir, "blocked-config");
    fs.mkdirSync(blockedCfg);
    assert.throws(() => saveConfig({ mode: "plan" }, blockedCfg));
    assert.deepEqual(tmpFilesIn(tmpDir), []);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
