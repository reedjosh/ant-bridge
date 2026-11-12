// Discover models from `agy models` and project them into pi's Model shape so
// they appear in the /model picker as antigravity/<slug>.
//
// agy prints TWO columns per line: "<slug>\t<display label>". --model takes
// ONLY the slug (col 1); col 2 becomes the human display label in pi's /model
// picker (with the trailing tier tag stripped when tiers collapse). Verified:
//   gemini-4-hydrogen-xhigh   Gemini 4 Hydrogen (XHigh)   (+ -high/-medium/-low)
//   gemini-4-carbon-high      Gemini 4 Carbon (High)      (+ -medium, -low)
//   gemini-pro-orchestrator   Orchestrator                (single fixed slug)
//   claude-opus-5-5-high      Claude Opus 5.5 (High)      (+ -medium, -low)
//
// Gemini AND Claude models are collapsed to a BASE slug (gemini-3.8-flash,
// claude-sonnet-5-5) and exposed with a thinking-effort toggle whose levels
// match exactly the tiers agy offers that base (verified: Pro rejects medium;
// Claude 5.5 accepts low/medium/high). The picked level is sent as agy
// --effort; a bare base slug is INVALID on its own (agy: "requires --effort"),
// so effort is always passed. Only unverified families keep agy's exact slug
// with no toggle, so an unknown future family degrades safely; the retired
// gpt-oss family is dropped outright (HIDDEN_FAMILY_RE). Google's Antigravity
// subscription bills all of these through agy.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { bridgeStateDir } from "./agy-paths.js";

const DISCOVERY_TIMEOUT_MS = 8_000;

/** Stdout ceiling for `agy models`. Real output is a few KB of ASCII slugs;
 *  anything past 1 MiB is a runaway process. Fail closed to "" so the
 *  fallback catalog engages instead of letting the buffer grow without
 *  limit. The check counts decoded string length (UTF-16 code units), not
 *  raw bytes - a deliberate proxy, since the margin between a few KB of
 *  real output and 1 MiB dwarfs any encoding difference. */
export const MODELS_OUTPUT_CAP_BYTES = 1024 * 1024;

/** Reasoning-effort tiers agy accepts via --effort / ACP thought_level. */
export type AgyEffort = "low" | "medium" | "high" | "xhigh";

/** low < medium < high < xhigh, for sorting/clamping. */
const EFFORT_RANK: Record<AgyEffort, number> = { low: 0, medium: 1, high: 2, xhigh: 3 };

/** pi thinking-effort order mirrors agy's, for clamping. */
export const AGY_EFFORT_ORDER: readonly AgyEffort[] = ["low", "medium", "high", "xhigh"];

/** Map pi's thinking level onto one of the tiers `efforts` the base actually
 *  supports, clamping to the nearest available. agy rejects an effort tier a
 *  base doesn't list (e.g. medium on Pro, xhigh on 3-tier bases), so we never
 *  emit one. Shared by the provider turns AND the AskAntigravity delegation
 *  tool (thinking/effort params): one vocabulary, one clamp. When pi sends no
 *  level we fall to the first available tier. */
export function toAgyEffort(
	reasoning: ThinkingLevel | undefined,
	efforts: readonly AgyEffort[],
): AgyEffort {
	let candidate: AgyEffort;
	switch (reasoning) {
		case "minimal":
		case "low":
			candidate = "low";
			break;
		case "medium":
			candidate = "medium";
			break;
		case "high":
			candidate = "high";
			break;
		case "xhigh":
		case "max":
			candidate = "xhigh";
			break;
		default:
			candidate = efforts[0] ?? "low";
	}
	if (efforts.includes(candidate)) return candidate;
	const i = AGY_EFFORT_ORDER.indexOf(candidate);
	for (let j = i; j < AGY_EFFORT_ORDER.length; j++) {
		if (efforts.includes(AGY_EFFORT_ORDER[j])) return AGY_EFFORT_ORDER[j];
	}
	for (let j = i - 1; j >= 0; j--) {
		if (efforts.includes(AGY_EFFORT_ORDER[j])) return AGY_EFFORT_ORDER[j];
	}
	return efforts[0] ?? "low";
}

/** Split an agy slug into (base, tier). tier is null when the slug has no
 *  -xhigh/-high/-medium/-low suffix - a shape only fixed or unverified slugs
 *  produce (e.g. gemini-pro-orchestrator), and those stay whole. */
const TIER_RE = /^(.+)-(xhigh|high|medium|low)$/;

/** Trailing tier tag in `agy models` col 2, e.g. " (XHigh)" or " (Medium)".
 *  Stripped when tier variants collapse into one base entry. */
const LABEL_TIER_SUFFIX_RE = /\s*\((?:xhigh|high|medium|low)\)\s*$/i;

/** agy emits clean slug ids (gemini-3.6-flash-high). Validate col1 of each
 *  line so a banner / auth / "Fetching models..." line can't register as a
 *  model, and a leading-dash token (e.g. "-high") can't reach agy's flag
 *  parser as --model. First char must be alphanumeric; the slug must contain
 *  at least one hyphen (every real agy slug does: family-version-name), which
 *  also drops a prose banner word split out of col1 ("Available"). */
const MODEL_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9._-]*$/;

/** Model families VERIFIED to accept base-slug + --effort. Only these collapse
 *  to a base slug with a thinking toggle. Any other family stays as agy's exact
 *  qualified slug (always valid on its own), so an unknown or fixed-thinking
 *  family degrades safely instead of forcing an unsupported --effort. Add a
 *  family here only after confirming base+--effort is accepted for it.
 *  Claude 5.5 verified live 2026-10: base+--effort accepted; a bare base is
 *  rejected ("requires --effort"). */
const EFFORT_CAPABLE_FAMILIES: readonly RegExp[] = [/^gemini-/, /^claude-/];

/** Families dropped outright, even while `agy models` still lists them: the
 *  fixed-thinking single slug loses to the cheaper effort-tiered options and
 *  its removal upstream is already announced, so we stop offering it now. */
const HIDDEN_FAMILY_RE = /^gpt-oss-/;

export interface AgyModelEntry {
	/** Exact agy --model string to pass: a base slug ("gemini-3.8-flash") when
	 *  effort-driven, else agy's full qualified slug (unverified family). */
	full: string;
	/** pi model id, e.g. "gemini-3-8-flash". */
	id: string;
	/** Human display label from `agy models` col 2 (tier suffix stripped when
	 *  collapsed, e.g. "Gemini 4 Hydrogen"; kept verbatim for single entries,
	 *  e.g. "Orchestrator"). Omitted when raw input has no second column. */
	label?: string;
	/** Present iff this is an effort-driven base slug. Lists the tiers agy
	 *  accepts for it; pi's thinking toggle picks among them and we always pass
	 *  --effort. Absent => fixed model, never pass --effort. */
	efforts?: AgyEffort[];
}

/** Spawn a read-only agy listing subcommand and return its raw stdout text.
 *  Returns "" on any failure (non-zero exit, spawn error, watchdog timeout,
 *  or output cap). Bounded by timeoutMs (default DISCOVERY_TIMEOUT_MS) so a
 *  hung agy (auth prompt, network stall) can't block the caller, and by
 *  capBytes (default MODELS_OUTPUT_CAP_BYTES) so a runaway agy can't grow
 *  the buffer without limit. Shared by the model catalog (spawned ONCE per
 *  load, provider + tool catalog), the agent roster, and the quota fetch
 *  (which passes its own 30s budget: /usage answers in ~10s live). */
export async function spawnAgyRaw(
	binary: string,
	args: string[],
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
	capBytes: number = MODELS_OUTPUT_CAP_BYTES,
): Promise<string> {
	try {
		return await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, args, {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			proc.stdout?.setEncoding("utf8");
			let out = "";
			let done = false;
			let capped = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(watchdog);
				resolve(v);
			};
			proc.stdout?.on("data", (d: string) => {
				if (capped) return;
				if (out.length + d.length > capBytes) {
					capped = true;
					try {
						proc.kill("SIGKILL");
					} catch {
						/* already gone */
					}
					finish("");
					return;
				}
				out += d;
			});
			proc.on("error", (err) => {
				clearTimeout(watchdog);
				reject(err);
			});
			proc.on("close", (code) => finish(code === 0 ? out : ""));
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				finish("");
			}, timeoutMs);
		});
	} catch {
		return "";
	}
}

/** Spawn `agy models`: the model catalog listing. */
export async function spawnAgyModelsRaw(binary: string): Promise<string> {
	return spawnAgyRaw(binary, ["models"]);
}

// --- catalog cache ----------------------------------------------------------
//
// `agy models` can take seconds (OAuth refresh, cold start) and its output
// rarely changes. We persist it to ~/.pi/agent/antigravity-bridge/models-
// cache.json with a short TTL so reloads serve instantly and only re-spawn in
// the background when stale. Only successful (non-empty) output is cached, so
// a broken agy is never sticky.

export const MODELS_CACHE_TTL_MS = 5 * 60_000;

function defaultModelsCachePath(): string {
	return path.join(bridgeStateDir(), "models-cache.json");
}

interface ModelsCache {
	raw: string;
	savedAt: number;
}

/** Read and validate the models cache. Returns null when missing or corrupt. */
function readModelsCache(cachePath: string = defaultModelsCachePath()): ModelsCache | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			typeof (parsed as ModelsCache).raw === "string" &&
			typeof (parsed as ModelsCache).savedAt === "number"
		) {
			return parsed as ModelsCache;
		}
	} catch {
		/* missing or corrupt: treat as no cache */
	}
	return null;
}

/** Atomically persist the raw catalog text (temp + rename, mode 0o600).
 *  Best-effort: a write failure just means the next load re-spawns. */
function writeModelsCache(raw: string, cachePath: string = defaultModelsCachePath()): void {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	const tmp = `${cachePath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify({ raw, savedAt: Date.now() }, null, 2) + "\n", {
			mode: 0o600,
		});
		fs.renameSync(tmp, cachePath);
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
	}
}

/** Fire-and-forget refresh of the models cache. Called on a stale-cache load so
 *  the next load sees fresh data without this one having to wait on agy. */
export function refreshModelsInBackground(
	binary: string,
	cachePath: string = defaultModelsCachePath(),
): void {
	void spawnAgyModelsRaw(binary)
		.then((raw) => {
			if (raw) writeModelsCache(raw, cachePath);
		})
		.catch(() => {
			/* best effort: leave the stale cache in place */
		});
}

/** Load the raw `agy models` text for catalog derivation, optimized for load
 *  time:
 *    - Fresh cache (< MODELS_CACHE_TTL_MS): return it, no spawn.
 *    - Stale cache (>= TTL): return it instantly, refresh in the background.
 *    - No cache: spawn once (blocks), persist. First-ever load only.
 *
 *  pi registers providers with a static model list, so a background refresh only
 *  updates the cache for the NEXT load; the current session keeps whatever this
 *  returned. The provider falls back to FALLBACK_MODELS when the raw yields no
 *  Gemini entries (agy missing/auth-failed). */
export async function loadModelCatalogRaw(
	binary: string,
	cachePath: string = defaultModelsCachePath(),
): Promise<string> {
	const cache = readModelsCache(cachePath);
	if (cache) {
		if (Date.now() - cache.savedAt < MODELS_CACHE_TTL_MS) return cache.raw;
		refreshModelsInBackground(binary, cachePath);
		return cache.raw;
	}
	// No cache: populate it. Blocks once; later loads hit the cache above.
	const raw = await spawnAgyModelsRaw(binary);
	if (raw) writeModelsCache(raw, cachePath);
	return raw;
}

/** Parse raw `agy models` text into the provider's model entries.
 *
 *  Effort-driven bases (>= 2 tier variants in the catalog, verified
 *  effort-capable family) collapse to one BASE-slug entry carrying the tiers
 *  they accept. Models with 0 or 1 tier variants keep agy's exact qualified
 *  slug: without a verified effort-capable family match, --effort is never
 *  risked. Hidden families are dropped outright. Insertion order of
 *  first-seen bases is preserved. */
export function entriesFromRaw(raw: string): AgyModelEntry[] {
	// agy prints TWO columns: "<slug>\t<display label>". --model takes only col 1;
	// col 2 (everything after col 1 whitespace, trimmed) becomes `label`. A
	// bare-slug line (no whitespace) yields an empty col 2 and omits `label`,
	// preserving compatibility with legacy one-column input.
	const groups = new Map<string, { items: Array<{ slug: string; col2: string }>; tiers: Set<AgyEffort> }>();
	for (const rawLine of raw.split("\n")) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		const wsMatch = /\s+/.exec(trimmed);
		const slug = wsMatch ? trimmed.slice(0, wsMatch.index) : trimmed;
		const col2 = wsMatch ? trimmed.slice(wsMatch.index + wsMatch[0].length).trim() : "";
		if (!slug || !MODEL_LINE_RE.test(slug)) continue;
		if (HIDDEN_FAMILY_RE.test(slug)) continue;
		const m = TIER_RE.exec(slug);
		const base = m ? (m[1] as string) : slug;
		const tier = m ? (m[2] as AgyEffort) : null;
		let g = groups.get(base);
		if (!g) {
			g = { items: [], tiers: new Set<AgyEffort>() };
			groups.set(base, g);
		}
		g.items.push({ slug, col2 });
		if (tier) g.tiers.add(tier);
	}
	const entries: AgyModelEntry[] = [];
	for (const [base, g] of groups) {
		const efforts = [...g.tiers].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
		if (efforts.length >= 2 && EFFORT_CAPABLE_FAMILIES.some((re) => re.test(base))) {
			const rawLabel = g.items.find((it) => it.col2.length > 0)?.col2 ?? "";
			const label = rawLabel.replace(LABEL_TIER_SUFFIX_RE, "").trim();
			entries.push({ full: base, id: slugify(base), ...(label ? { label } : {}), efforts });
		} else {
			for (const { slug, col2 } of g.items) {
				entries.push({ full: slug, id: slugify(slug), ...(col2 ? { label: col2 } : {}) });
			}
		}
	}
	return entries.filter((e) => e.id.length > 0);
}

/** Run `agy models`, return parsed model entries. Returns [] on any failure
 *  (non-fatal  -  the provider falls back to a hardcoded set). */
export async function discoverAgyModels(binary: string): Promise<AgyModelEntry[]> {
	return entriesFromRaw(await spawnAgyModelsRaw(binary));
}

/** "Gemini 3.6 Flash (Medium)" -> "gemini-3-6-flash-medium".
 *  Lowercase, non-alphanumerics -> "-", collapsed, trimmed. */
export function slugify(full: string): string {
	return full
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Build the thinkingLevelMap for an effort-driven base: hide "off", "minimal",
 *  and "max" always (agy has no no-thinking mode and tops out at xhigh), map
 *  each supported tier in low/medium/high/xhigh to itself (pi-ai's
 *  getSupportedThinkingLevels treats xhigh and max as opt-in where undefined
 *  is hidden, so supported tiers need a non-null string), and hide any tier
 *  absent from `efforts` with null. */
function thinkingLevelMapFor(efforts: readonly AgyEffort[]): ThinkingLevelMap {
	return {
		off: null,
		minimal: null,
		low: efforts.includes("low") ? "low" : null,
		medium: efforts.includes("medium") ? "medium" : null,
		high: efforts.includes("high") ? "high" : null,
		xhigh: efforts.includes("xhigh") ? "xhigh" : null,
		max: null,
	};
}

/** Project an agy entry to pi's Model shape. `input` advertises accepted
 *  inputs; both engines accept images (ACP native content blocks,
 *  stream-json staged files), so callers pass ["text", "image"] uniformly. */
export function toPiModel(entry: AgyModelEntry, input: Array<"text" | "image"> = ["text"]): Model<Api> {
	const effortDriven = !!entry.efforts && entry.efforts.length > 0;
	return {
		id: entry.id,
		name: entry.label ?? entry.full,
		api: "agy-bridge" as Api,
		provider: "antigravity",
		// baseUrl/apiKey are not used (streamSimple intercepts everything), but
		// pi requires non-empty values. The "agy-bridge" api string is a custom
		// sentinel that no built-in provider claims, so it can never collide.
		baseUrl: "agy-bridge://antigravity",
		// reasoning=true only for effort-driven bases => pi shows the toggle.
		// Unverified families get no toggle: --effort support is unknown, so
		// none is ever sent.
		reasoning: effortDriven,
		...(effortDriven ? { thinkingLevelMap: thinkingLevelMapFor(entry.efforts!) } : {}),
		// Input advertising comes from the caller: both engines deliver
		// user-attached images now.
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Gemini long context. agy doesn't expose the real per-model window in
		// `agy models`; 1M is the documented Gemini ceiling.
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

/** Fallback catalog used when `agy models` fails at load (binary missing,
 *  auth not yet done, network stall). Keeps the picker populated so the user
 *  can still select a model and get a clear runtime error instead of an empty
 *  list. Update these when agy ships new Gemini versions. */
export const FALLBACK_MODELS: AgyModelEntry[] = [
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
];


