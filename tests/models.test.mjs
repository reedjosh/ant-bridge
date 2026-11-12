import assert from "node:assert/strict";
import test from "node:test";
import { importBridgeModule, jiti } from "./helpers/pi-loader.mjs";

const {
  AGY_EFFORT_ORDER,
  FALLBACK_MODELS,
  entriesFromRaw,
  slugify,
  toAgyEffort,
  toPiModel,
} = await importBridgeModule("src/models.ts");
const { clampThinkingLevel, getSupportedThinkingLevels } = await jiti.import("@earendil-works/pi-ai");

const LIVE_CATALOG_SAMPLE = [
  "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)",
  "gemini-4-carbon-high\tGemini 4 Carbon (High)",
  "gemini-4-carbon-low\tGemini 4 Carbon (Low)",
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "gemini-4-argon-high\tGemini 4 Argon (High)",
  "gemini-4-argon-low\tGemini 4 Argon (Low)",
  "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
  "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
  "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
  "gemini-pro-orchestrator\tOrchestrator",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
  "claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)",
  "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
  "claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)",
  "claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)",
  "claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "Fetching models...",
  "-xhigh\tFlag injection attempt",
].join("\n");

test("entriesFromRaw collapses 4-tier gemini-4-hydrogen, strips collapsed tier labels, and keeps single labels", () => {
  assert.deepEqual(AGY_EFFORT_ORDER, ["low", "medium", "high", "xhigh"]);

  const entries = entriesFromRaw(LIVE_CATALOG_SAMPLE);
  assert.deepEqual(entries, [
    {
      full: "gemini-4-carbon",
      id: "gemini-4-carbon",
      label: "Gemini 4 Carbon",
      efforts: ["low", "medium", "high"],
    },
    {
      full: "gemini-4-argon",
      id: "gemini-4-argon",
      label: "Gemini 4 Argon",
      efforts: ["low", "medium", "high"],
    },
    {
      full: "gemini-4-hydrogen",
      id: "gemini-4-hydrogen",
      label: "Gemini 4 Hydrogen",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      full: "gemini-pro-orchestrator",
      id: "gemini-pro-orchestrator",
      label: "Orchestrator",
    },
    {
      full: "gemini-3.8-flash",
      id: "gemini-3-8-flash",
      label: "Gemini 3.8 Flash",
      efforts: ["low", "medium", "high"],
    },
    {
      full: "claude-opus-5-5",
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      efforts: ["low", "medium", "high"],
    },
    {
      full: "claude-sonnet-5-5",
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      efforts: ["low", "medium", "high"],
    },
  ]);

  assert.equal(entries.some((e) => e.full === "gemini-4-hydrogen-xhigh"), false);
});

test("entriesFromRaw omits label on legacy single-column input and preserves non-collapsed col 2 labels", () => {
  const legacy = entriesFromRaw(
    [
      "gemini-4-hydrogen-xhigh",
      "gemini-4-hydrogen-low",
      "gemini-pro-orchestrator",
    ].join("\n"),
  );
  assert.deepEqual(legacy, [
    {
      full: "gemini-4-hydrogen",
      id: "gemini-4-hydrogen",
      efforts: ["low", "xhigh"],
    },
    {
      full: "gemini-pro-orchestrator",
      id: "gemini-pro-orchestrator",
    },
  ]);
  assert.equal("label" in legacy[0], false);
  assert.equal("label" in legacy[1], false);
  assert.equal(toPiModel(legacy[0]).name, "gemini-4-hydrogen");
  assert.equal(toPiModel(legacy[1]).name, "gemini-pro-orchestrator");

  const uncollapsed = entriesFromRaw(
    [
      "gemini-4-carbon-high  Gemini 4 Carbon (High)",
      "acme-future-low\tAcme Future (Low)",
      "acme-future-xhigh\tAcme Future (XHigh)",
    ].join("\n"),
  );
  assert.deepEqual(uncollapsed, [
    {
      full: "gemini-4-carbon-high",
      id: "gemini-4-carbon-high",
      label: "Gemini 4 Carbon (High)",
    },
    {
      full: "acme-future-low",
      id: "acme-future-low",
      label: "Acme Future (Low)",
    },
    {
      full: "acme-future-xhigh",
      id: "acme-future-xhigh",
      label: "Acme Future (XHigh)",
    },
  ]);
});

test("toAgyEffort resolves xhigh/max to xhigh when available and clamps down to high on 3-tier models", () => {
  const fourTier = ["low", "medium", "high", "xhigh"];
  assert.equal(toAgyEffort(undefined, fourTier), "low");
  assert.equal(toAgyEffort("minimal", fourTier), "low");
  assert.equal(toAgyEffort("low", fourTier), "low");
  assert.equal(toAgyEffort("medium", fourTier), "medium");
  assert.equal(toAgyEffort("high", fourTier), "high");
  assert.equal(toAgyEffort("xhigh", fourTier), "xhigh");
  assert.equal(toAgyEffort("max", fourTier), "xhigh");

  const threeTier = ["low", "medium", "high"];
  assert.equal(toAgyEffort(undefined, threeTier), "low");
  assert.equal(toAgyEffort("minimal", threeTier), "low");
  assert.equal(toAgyEffort("low", threeTier), "low");
  assert.equal(toAgyEffort("medium", threeTier), "medium");
  assert.equal(toAgyEffort("high", threeTier), "high");
  assert.equal(toAgyEffort("xhigh", threeTier), "high");
  assert.equal(toAgyEffort("max", threeTier), "high");

  const sparsePro = ["low", "high"];
  assert.equal(toAgyEffort("medium", sparsePro), "high");
  assert.equal(toAgyEffort("xhigh", sparsePro), "high");
  assert.equal(toAgyEffort("max", sparsePro), "high");

  const topHeavy = ["high", "xhigh"];
  assert.equal(toAgyEffort(undefined, topHeavy), "high");
  assert.equal(toAgyEffort("low", topHeavy), "high");
  assert.equal(toAgyEffort("xhigh", topHeavy), "xhigh");
  assert.equal(toAgyEffort("max", topHeavy), "xhigh");
});

test("toPiModel sets display name and thinkingLevelMap compatible with pi-ai getSupportedThinkingLevels", () => {
  const entries = entriesFromRaw(LIVE_CATALOG_SAMPLE);
  const hydrogen = toPiModel(entries.find((e) => e.id === "gemini-4-hydrogen"), ["text", "image"]);
  const carbon = toPiModel(entries.find((e) => e.id === "gemini-4-carbon"), ["text", "image"]);
  const orchestrator = toPiModel(entries.find((e) => e.id === "gemini-pro-orchestrator"), ["text", "image"]);
  const sparse = toPiModel({ full: "gemini-3.1-pro", id: "gemini-3-1-pro", efforts: ["low", "high"] });

  assert.equal(hydrogen.name, "Gemini 4 Hydrogen");
  assert.equal(hydrogen.reasoning, true);
  assert.deepEqual(hydrogen.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  });
  assert.deepEqual(getSupportedThinkingLevels(hydrogen), ["low", "medium", "high", "xhigh"]);
  assert.equal(clampThinkingLevel(hydrogen, "xhigh"), "xhigh");
  assert.equal(clampThinkingLevel(hydrogen, "max"), "xhigh");

  assert.equal(carbon.name, "Gemini 4 Carbon");
  assert.equal(carbon.reasoning, true);
  assert.deepEqual(carbon.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  });
  assert.deepEqual(getSupportedThinkingLevels(carbon), ["low", "medium", "high"]);
  assert.equal(clampThinkingLevel(carbon, "xhigh"), "high");

  assert.equal(sparse.name, "gemini-3.1-pro");
  assert.deepEqual(getSupportedThinkingLevels(sparse), ["low", "high"]);

  assert.equal(orchestrator.name, "Orchestrator");
  assert.equal(orchestrator.reasoning, false);
  assert.equal(orchestrator.thinkingLevelMap, undefined);
  assert.deepEqual(getSupportedThinkingLevels(orchestrator), ["off"]);
});

test("FALLBACK_MODELS includes 4-tier gemini-4-hydrogen and human labels matching discovered entries", () => {
  const hydrogen = FALLBACK_MODELS.find((e) => e.id === "gemini-4-hydrogen");
  assert.deepEqual(hydrogen, {
    full: "gemini-4-hydrogen",
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    efforts: ["low", "medium", "high", "xhigh"],
  });

  const discoveredById = new Map(entriesFromRaw(LIVE_CATALOG_SAMPLE).map((e) => [e.id, e]));
  for (const fallback of FALLBACK_MODELS) {
    assert.equal(fallback.id, slugify(fallback.full));
    assert.equal(typeof fallback.label, "string");
    assert.equal(fallback.label.length > 0, true);
    assert.notEqual(fallback.label, fallback.full);
    const model = toPiModel(fallback, ["text", "image"]);
    assert.equal(model.name, fallback.label);
    assert.deepEqual(fallback, discoveredById.get(fallback.id));
  }
});
