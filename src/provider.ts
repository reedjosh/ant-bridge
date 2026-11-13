// Pi model provider for `agy acp`: streamSimple(model, context, options) -> AssistantMessageEventStream.
//
// Each turn:
//   1. Extracts the current turn's trailing user message(s) and image blocks (`agy acp` maintains
//      its own session history via `session/load`, so only the delta prompt is sent).
//   2. Resolves the Pi model id (`antigravity/gemini-4-carbon`, etc.) and reasoning effort tier.
//   3. Resumes a parked MCP round-trip (`driver.reentry()`) or runs a fresh/resumed ACP prompt.
//   4. Streams text, thinking, edit diffs, native tool events, and parked Pi `toolUse` calls.
//   5. Persists the ACP sessionId and transcript watermark for the next turn.

import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonValue,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksBackgroundNativeCall } from "./background-watch.js";
import { CALL_PI_TOOL_NAME } from "./bridge-catalog.js";
import { loadConfig } from "./config.js";

export { CALL_PI_TOOL_NAME };
import { createExecGitOps, formatInlineDiff, TurnDiffContext } from "./diff-render.js";
import {
	toPiUsage,
	type DriverActivity,
	type DriverToolLocation,
	type TurnDriver,
	type TurnHandle,
} from "./driver-types.js";
import { toAgyEffort, type AgyModelEntry } from "./models.js";
import { SessionStore } from "./sessions.js";
import { SubagentRoster } from "./subagent-roster.js";

/** Caller-scoped tool names declared by pi-observational-memory background workers. */
export const OM_WORKER_TOOL_NAMES = new Set([
	"record_observations",
	"record_reflections",
	"drop_observations",
]);

/** True when a turn belongs to a pi-observational-memory background worker. */
export function isObservationalMemoryContext(context: TranscriptContext): boolean {
	const currentTools = getCurrentTools(context.messages);
	return currentTools.some((t) => OM_WORKER_TOOL_NAMES.has(t.name));
}

let warnedObservationalMemoryMismatch = false;

export function _resetObservationalMemoryWarnedForTesting(): void {
	warnedObservationalMemoryMismatch = false;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const COMPACTION_MARKER = "compacted into the following summary";
const BRANCH_SUMMARY_MARKER = "summary of a branch that this conversation came back from";

/** Find the start index of the current turn's contiguous trailing user-role messages
 *  (excluding compaction and branch summaries, and never crossing an already-delivered
 *  watermark). Extensions such as pr-tracker inject trailing custom_message entries
 *  (mapped to role="user" by Pi's convertToLlm) after the user's message; reading only
 *  messages[length - 1] would shadow the real user prompt. */
export function trailingUserTurnStart(messages: Message[], watermark = 0): number {
	const floor = watermark > 0 && watermark < messages.length ? Math.floor(watermark) : 0;
	let start = messages.length;
	for (let i = messages.length - 1; i >= floor; i--) {
		const m = messages[i];
		if (!m || m.role !== "user") break;
		const t = blocksToText(m.content);
		if (t.includes(COMPACTION_MARKER) || t.includes(BRANCH_SUMMARY_MARKER)) break;
		start = i;
	}
	return start;
}

/** Extract the current turn's user message(s) as a flat prompt string. */
export function extractUserPrompt(context: TranscriptContext, watermark = 0): string | null {
	const start = trailingUserTurnStart(context.messages, watermark);
	if (start >= context.messages.length) return null;
	const parts: string[] = [];
	for (let i = start; i < context.messages.length; i++) {
		const content = context.messages[i].content;
		const text =
			typeof content === "string"
				? content.trim()
				: content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text)
						.join("\n")
						.trim();
		if (text) parts.push(text);
	}
	return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Extract image blocks across the current turn's trailing user message(s). */
export function extractImages(
	context: TranscriptContext,
	watermark = 0,
): Array<{ data: string; mimeType: string }> {
	const start = trailingUserTurnStart(context.messages, watermark);
	if (start >= context.messages.length) return [];
	const images: Array<{ data: string; mimeType: string }> = [];
	for (let i = start; i < context.messages.length; i++) {
		const content = context.messages[i].content;
		if (typeof content === "string") continue;
		for (const b of content) {
			if (b.type === "image") {
				images.push({ data: b.data, mimeType: b.mimeType });
			}
		}
	}
	return images;
}

/** Synthetic prompt used when Pi retries after discarding a failed attempt. */
export const RESUME_PROMPT =
	"[The previous attempt of this turn failed and was discarded. Check your conversation history for the last step you completed, then continue the task from there. Do not repeat completed actions.]";

export const DIGEST_PREAMBLE =
	"[The following is context from the broader pi session that this Antigravity turn was not directly spawned for: compaction summaries and turns handled by other providers or pi's own tools. Your own prior turns are already in your conversation history. Use this for continuity only.]";

export const SEED_DIGEST_PREAMBLE = [
	"[The following is prior conversation history from the pi session before this fresh Antigravity",
	"conversation started (for example after /fork or a mid-session provider switch): earlier user",
	"messages, assistant turns, tool results, and any compaction summary. This fresh conversation",
	"has no prior turns of its own; use this history for continuity.]",
].join(" ");

export const SYSTEM_PROMPT_PREAMBLE =
	"[The following is the system prompt of the pi session that spawned this conversation: operating instructions plus project context (AGENTS.md files). Apply it for this whole conversation.]";

export const SYSTEM_PROMPT_END = "[END SYSTEM PROMPT]";

/** Concise MCP server instructions for `InitializeResult.instructions`
 *  (written by `agy` to `<appDataDir>/mcp/<serverName>/instructions.md`). */
export const PI_BRIDGE_INSTRUCTIONS: string = [
	"Pi Bridge exposes active Pi tools and direct MCP servers (`pi-bridge` and `pi-bridge-<server>`).",
	"",
	"- Eager tools register natively as `mcp_pi-bridge_<tool>` and `mcp_pi-bridge-<server>_<tool>`.",
	"- `agy acp` drops schemas above ~1.48 KB (such as `subagent`, `codemode`, `activate_skill`, and",
	"  larger MCP tools) from `Eager:` without registering `Lazy:` or `call_mcp_tool`, even though",
	"  every tool's `<tool>.json` schema is written to `<appDataDir>/mcp/pi-bridge*/` on disk.",
	"- To use any non-eager Pi or MCP tool, read `<appDataDir>/mcp/<serverName>/<tool>.json` for its",
	"  parameters and invoke `mcp_pi-bridge_call_pi_tool` with `{ name, arguments }` (for example",
	"  `name: \"subagent\"`, `name: \"codemode\"`, or `name: \"pi-bridge-slack/slack_read_thread\"`).",
	"- If any bridged call answers `STILL RUNNING` with a `callId`, poll `bridge_poll_result` on",
	"  `pi-bridge` until it settles before ending your turn.",
	"- Inside `codemode` scripts, MCP tools resolve to `{ content, structuredContent, isError }`",
	"  objects and `return <object>` renders as one escaped JSON line in Pi; extract readable text and",
	"  emit formatted multi-line strings with `text(...)` instead of returning raw or nested JSON",
	"  objects.",
].join("\n");

export const TOOL_PRIORITY_NOTE: string = [
	"[Tool priority: this conversation runs inside pi, not as a standalone agy session; the user only",
	"sees what surfaces in pi. Native interactive tools, for example ask_question, never reach the",
	"user. When a Pi Bridge tool covers the same purpose, always use the Pi Bridge tool; for user",
	"questions use ask_user_question. Direct Pi MCP servers appear in agy's <mcp_servers> as",
	"pi-bridge-<server> (mcp_pi-bridge-<server>_<tool> when eager); call eager tools directly so Pi",
	"renders clean <server>/<tool> rows. Because agy acp omits schemas above ~1.48 KB (including",
	"subagent, codemode, activate_skill, and larger MCP tools) without registering Lazy: or",
	"call_mcp_tool, every tool's <tool>.json schema is still written under <appDataDir>/mcp/pi-bridge*/",
	"on disk: read <appDataDir>/mcp/<serverName>/<tool>.json and invoke any non-eager tool via",
	"mcp_pi-bridge_call_pi_tool with { name, arguments }. Servers marked (codemode) in Pi's",
	"<mcp_servers> section (such as Slack, Linear, Sentry, or Figma) do not appear as separate agy MCP",
	"servers; reach them via mcp_pi-bridge_codemode (or mcp_pi-bridge_call_pi_tool with name",
	"\"codemode\" when non-eager, using searchTools / describeNamespace) and never inspect local ~/.pi",
	"MCP config files. When batching calls in codemode, extract readable text from",
	"{ content, structuredContent } results and emit formatted multi-line text via text(...) rather",
	"than returning raw or nested JSON objects. For workspace files and commands, your native",
	"read_file, edit_file, write_file, and run_command tools operate directly on the real filesystem",
	"and render in pi (including visible images on read_file). When a bridge call answers STILL",
	"RUNNING, poll bridge_poll_result before doing other work: until you poll, the result (including",
	"any image) stays undelivered to you. Delegate subagent work through Pi Bridge: when pi's tool list",
	"includes a delegation tool (for example subagent, Agent, agent_spawn, agent_wait, or",
	"subagent_run), always delegate through it (directly or via mcp_pi-bridge_call_pi_tool with name",
	"\"subagent\") and never through the native invoke_subagent, run_subagent, manage_subagents, or",
	"swarm; native invoke_subagent and swarm background workers run inside agy invisible to pi, lose",
	"access to pi-bridge* tools as soon as the parent turn ends, and never wake pi on completion (even",
	"if no pi delegation tool is listed, never leave native subagents running across turn boundaries or",
	"expect them to call pi-bridge* tools). Never call the native schedule tool and end your turn to",
	"wait for a timer or cron: ending your turn closes the active pi prompt, so a later native schedule",
	"wakeup runs with no active pi turn, drops its output, cannot call pi-bridge* tools, and races with",
	"subsequent prompts; keep polling bounded inside the active turn or use Pi Bridge tools instead.",
	"Long-running bridge calls do not fail: after ~20 seconds (120 seconds for subagent and codemode",
	"calls) the bridge answers STILL RUNNING with a callId; fetch the result with bridge_poll_result",
	"and poll until it lands.]",
].join(" ");

export const SUMMARIZATION_NO_TOOLS_NOTE = [
	"[Summarization mode: summarize strictly from the provided <conversation> text. Do NOT call any",
	"tools (no read_file, run_command, grep_search, MCP tools, or subagents); reply immediately with",
	"the requested summary text only.]",
].join(" ");

/** True for Pi's standalone compaction and branch-summary calls
 *  (completeSummarization sets cacheRetention="none" with zero tools). */
export function isStandaloneSummarizationTurn(
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): boolean {
	if (getCurrentTools(context.messages).length > 0) return false;
	const cacheRetention = (options as { cacheRetention?: string } | undefined)?.cacheRetention;
	if (cacheRetention === "none") return true;
	const sys = getCurrentSystemPrompt(context.messages);
	return /\bcontext summarization assistant\b/i.test(sys);
}

/** Assemble the full prompt on fresh turns (system prompt block + optional digest + user prompt). */
export function buildFullPrompt(
	systemPrompt: string | undefined,
	digest: string,
	prompt: string,
): string {
	const parts: string[] = [];
	if (systemPrompt) {
		parts.push(
			`${SYSTEM_PROMPT_PREAMBLE}\n\n${systemPrompt}\n\n${TOOL_PRIORITY_NOTE}\n\n${SYSTEM_PROMPT_END}`,
		);
	}
	if (digest) {
		parts.push(`${DIGEST_PREAMBLE}\n\n${digest}`);
	}
	if (prompt) {
		parts.push(prompt);
	}
	return parts.join("\n\n---\n\n");
}

function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("\n");
}

function stripCompactionWrapping(t: string): string {
	const open = t.indexOf("<summary>");
	const close = t.lastIndexOf("</summary>");
	if (open >= 0 && close > open) return t.slice(open + "<summary>".length, close).trim();
	return t.trim();
}

/** Deterministic 16-hex-char SHA-256 tag of the latest Pi compaction summary in messages, if any. */
export function latestCompactionHash(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const t = blocksToText(m.content);
		if (t.includes(COMPACTION_MARKER)) {
			const summary = stripCompactionWrapping(t);
			return createHash("sha256").update(summary).digest("hex").slice(0, 16);
		}
	}
	return undefined;
}

export interface DigestOptions {
	ownProvider?: string;
	includeOwnAssistant?: boolean;
	maxChars?: number;
}

/** Build a delta or seed digest of Pi-side context (compaction summary + prior turns). */
export function buildContextDigest(
	messages: Message[],
	watermark: number,
	opts: DigestOptions = {},
): string {
	const own = opts.ownProvider ?? "antigravity";
	const includeOwn = opts.includeOwnAssistant === true || own === "";
	const maxChars = opts.maxChars ?? 8000;
	if (messages.length === 0) return "";

	let summaryPart: string | null = null;
	const deltaParts: string[] = [];

	let lastCompactionIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const t = blocksToText(m.content);
		if (t.includes(COMPACTION_MARKER)) {
			lastCompactionIdx = i;
			summaryPart = `[pi compaction summary]\n${stripCompactionWrapping(t)}`;
			break;
		}
	}

	const effectiveWatermark = watermark > messages.length ? 0 : Math.max(0, Math.floor(watermark));
	let start = effectiveWatermark;
	if (lastCompactionIdx >= 0) start = Math.max(start, lastCompactionIdx + 1);
	const trailingStart = trailingUserTurnStart(messages, effectiveWatermark);
	const end = trailingStart < messages.length ? trailingStart : Math.max(0, messages.length - 1);
	for (let i = start; i < end; i++) {
		const m = messages[i];
		if (m.role === "assistant") {
			if (!includeOwn && m.provider === own) continue;
			const t = blocksToText(m.content).trim();
			if (!t) continue;
			deltaParts.push(`[assistant turn from ${m.provider}]\n${t}`);
		} else if (m.role === "user") {
			const t = blocksToText(m.content);
			if (t.includes(COMPACTION_MARKER)) continue;
			if (!t.trim()) continue;
			deltaParts.push(`[earlier user message]\n${t}`);
		} else if (m.role === "toolResult") {
			const t = blocksToText(m.content).trim();
			deltaParts.push(
				`[tool result: ${m.toolName}${m.isError ? " (error)" : ""}]\n${t || "(no text output)"}`,
			);
		}
	}

	const SEP = "\n\n";
	const MARKER = "[truncated]";
	let delta = deltaParts.join(SEP);
	if (maxChars > 0) {
		const budget = Math.max(0, maxChars - (summaryPart ? summaryPart.length + SEP.length : 0));
		if (delta.length > budget) {
			const kept: string[] = [];
			let used = 0;
			for (let i = deltaParts.length - 1; i >= 0; i--) {
				const cost = deltaParts[i].length + (kept.length > 0 ? SEP.length : 0);
				if (used + cost > budget) break;
				kept.unshift(deltaParts[i]);
				used += cost;
			}
			if (kept.length > 0) {
				delta = `${MARKER}\n${kept.join(SEP)}`;
			} else {
				const room = Math.max(0, budget - MARKER.length - 1);
				delta = room > 0 ? `${MARKER}\n${deltaParts[deltaParts.length - 1].slice(-room)}` : "";
			}
		}
	}

	return [summaryPart, delta]
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.join(SEP);
}

function newAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Session key scoped with `@acp` for backward compatibility with existing sessions.json stores. */
function sessionKey(options: SimpleStreamOptions | undefined, cwd: string): string {
	const sid = (options as { sessionId?: string } | undefined)?.sessionId;
	const base = sid && sid.length > 0 ? `sid:${sid}` : `cwd:${cwd}`;
	return `${base}@acp`;
}

export interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
}

export interface NativeDisplayEvent {
	name: string;
	mcpServer?: string;
	toolCallId?: string;
	status: "started" | "completed" | "failed";
	callId?: string;
	path?: string;
	detail?: string;
	command?: string;
	output?: string;
	diff?: string;
}

export interface StreamSimpleDeps {
	entries: AgyModelEntry[];
	store: SessionStore;
	driver?: TurnDriver;
	acpDriver?: TurnDriver;
	roundTrips?: ToolRoundTrips;
	beforeTurn?: () => Promise<void>;
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	onNativeBackground?: (info: { conversationId: string; turnStartMs: number }) => void;
	onTurnFinished?: () => void;
	roster?: SubagentRoster;
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

const BRIDGE_TIMEOUT_MS = 480_000;
const MAX_PARK_TOMBSTONES = 64;

export interface BridgeContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface BridgeCallResultShape {
	content: BridgeContentBlock[];
	isError: boolean;
}

export interface BridgeEscalation {
	escalated: true;
	callId: string;
	name: string;
}

export const POLL_TOOL_NAME = "bridge_poll_result";
export const ESCALATE_AFTER_MS = 20_000;
export const DELEGATION_ESCALATE_MS = 120_000;
export const ESCALATED_TIMEOUT_MS = 1_800_000;

const DELEGATION_NAME_RE = /subagent|delegate|^agent(_|$)|^codemode$/i;

export function defaultEscalateAfterMs(
	name: string,
	extraLongNames: readonly string[] = [],
): number {
	return DELEGATION_NAME_RE.test(name) || extraLongNames.includes(name)
		? DELEGATION_ESCALATE_MS
		: ESCALATE_AFTER_MS;
}

export interface PollView {
	state: "running" | "done" | "failed";
	name: string;
	text?: string;
	isError?: boolean;
	reason?: string;
	images?: Array<{ data: string; mimeType: string }>;
	delivered?: boolean;
	conversationId?: string;
}

export class EscalationRegistry {
	#calls = new Map<string, PollView>();

	#trim(): void {
		while (this.#calls.size > MAX_PARK_TOMBSTONES) {
			const settled = [...this.#calls.entries()].filter(([, e]) => e.state !== "running");
			const victim = (settled.find(([, e]) => e.delivered) ?? settled[0])?.[0];
			if (victim === undefined) break;
			this.#calls.delete(victim);
		}
	}

	escalate(callId: string, name: string): void {
		this.#calls.set(callId, { name, state: "running" });
		this.#trim();
	}

	settleDone(
		callId: string,
		text: string,
		isError: boolean,
		images: Array<{ data: string; mimeType: string }> = [],
	): void {
		const e = this.#calls.get(callId);
		if (!e) return;
		e.state = "done";
		e.text = text;
		e.isError = isError;
		if (images.length > 0) e.images = images;
		this.#trim();
	}

	settleFailed(callId: string, reason: string): void {
		const e = this.#calls.get(callId);
		if (!e) return;
		e.state = "failed";
		e.reason = reason;
		this.#trim();
	}

	poll(callId: string): PollView | undefined {
		const e = this.#calls.get(callId);
		return e ? { ...e } : undefined;
	}

	markDelivered(callId: string): boolean {
		const e = this.#calls.get(callId);
		if (!e || e.state === "running") return false;
		e.delivered = true;
		return true;
	}

	claimUndelivered(callId: string): (PollView & { callId: string }) | undefined {
		const e = this.#calls.get(callId);
		if (!e || e.state !== "done" || e.delivered) return undefined;
		e.delivered = true;
		return { ...e, callId };
	}

	claimAllUndelivered(): Array<PollView & { callId: string }> {
		const out: Array<PollView & { callId: string }> = [];
		for (const [callId, e] of this.#calls) {
			if (e.state === "done" && !e.delivered) {
				e.delivered = true;
				out.push({ ...e, callId });
			}
		}
		return out;
	}

	unclaim(callId: string): void {
		const e = this.#calls.get(callId);
		if (e && e.state === "done") e.delivered = false;
	}

	stampConversation(conversationId: string): void {
		for (const e of this.#calls.values()) {
			if (e.state === "running") e.conversationId ??= conversationId;
		}
	}
}

export function formatEscalatedAck(e: BridgeEscalation): BridgeCallResultShape {
	return {
		content: [
			{
				type: "text",
				text: [
					`STILL RUNNING: the pi tool "${e.name}" has not finished yet.`,
					`Call ${POLL_TOOL_NAME} with callId "${e.callId}" to get the result. Poll again if it still reports running; you may do other work between polls.`,
					"Do NOT end your turn while this call is unresolved: keep polling until it reports done or failed. Ending the turn strands the result.",
				].join("\n"),
			},
		],
		isError: false,
	};
}

export function formatPollAnswer(
	callId: string,
	view: PollView | undefined,
): BridgeCallResultShape {
	if (!view) {
		return {
			content: [
				{
					type: "text",
					text: `Error: no escalated bridge call "${callId}". It either finished within the first seconds (its result is in your original tool result) or the callId is wrong.`,
				},
			],
			isError: true,
		};
	}
	if (view.state === "running") {
		return {
			content: [
				{
					type: "text",
					text: `STILL RUNNING: "${view.name}" (callId ${callId}) has not finished. Poll again later.`,
				},
			],
			isError: false,
		};
	}
	if (view.state === "failed") {
		return {
			content: [
				{
					type: "text",
					text: `Error: bridge call "${view.name}" (callId ${callId}) failed: ${view.reason}`,
				},
			],
			isError: true,
		};
	}
	return {
		content: [
			...(view.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
			{ type: "text", text: view.text || "(no output)" },
		],
		isError: view.isError ?? false,
	};
}

interface PendingRoundTrip {
	name: string;
	resolve: (r: BridgeCallResultShape | BridgeEscalation) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
	escalated?: boolean;
	escalateTimer?: NodeJS.Timeout;
	onAbort: () => void;
	signal: AbortSignal;
}

export class ToolRoundTrips {
	#pending = new Map<string, PendingRoundTrip>();
	#dead = new Map<string, { name: string; reason: string }>();
	#escalations = new EscalationRegistry();
	#escalateAfterMs: number | ((name: string) => number);
	#getDriver: () => TurnDriver;
	#log: (s: string, d?: unknown, level?: "debug" | "info" | "warn" | "error") => void;

	constructor(
		driver: TurnDriver | (() => TurnDriver),
		log?: (s: string, d?: unknown, level?: "debug" | "info" | "warn" | "error") => void,
		opts: { escalateAfterMs?: number | ((name: string) => number) } = {},
	) {
		this.#getDriver = typeof driver === "function" ? driver : () => driver;
		this.#log = log ?? (() => {});
		this.#escalateAfterMs = opts.escalateAfterMs ?? defaultEscalateAfterMs;
	}

	get pendingIds(): string[] {
		return [...this.#pending.keys()];
	}

	get deadIds(): string[] {
		return [...this.#dead.keys()];
	}

	consumeDead(toolCallId: string): { name: string; reason: string } | undefined {
		const dead = this.#dead.get(toolCallId);
		if (!dead) return undefined;
		this.#dead.delete(toolCallId);
		return dead;
	}

	poll(callId: string): PollView | undefined {
		return this.#escalations.poll(callId);
	}

	markDelivered(callId: string): boolean {
		return this.#escalations.markDelivered(callId);
	}

	claimUndelivered(callId: string): (PollView & { callId: string }) | undefined {
		return this.#escalations.claimUndelivered(callId);
	}

	claimAllUndelivered(): Array<PollView & { callId: string }> {
		return this.#escalations.claimAllUndelivered();
	}

	unclaim(callId: string): void {
		this.#escalations.unclaim(callId);
	}

	stampConversation(conversationId: string): void {
		this.#escalations.stampConversation(conversationId);
	}

	failAll(reason: string): void {
		for (const id of [...this.#pending.keys()]) {
			const entry = this.#pending.get(id);
			if (entry?.escalated) continue;
			this.#fail(id, reason);
		}
	}

	#fail(callId: string, reason: string): void {
		const entry = this.#pending.get(callId);
		if (!entry) return;
		this.#pending.delete(callId);
		clearTimeout(entry.timer);
		if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
		entry.signal.removeEventListener("abort", entry.onAbort);
		this.#dead.set(callId, { name: entry.name, reason });
		while (this.#dead.size > MAX_PARK_TOMBSTONES) {
			const oldest = this.#dead.keys().next().value;
			if (oldest === undefined) break;
			this.#dead.delete(oldest);
		}
		if (entry.escalated) this.#escalations.settleFailed(callId, reason);
		entry.reject(new Error(reason));
		this.#getDriver().kickIdle();
		this.#log("round-trip-fail", { callId, name: entry.name, reason });
	}

	onToolCall = (
		callId: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<BridgeCallResultShape | BridgeEscalation> => {
		const handle = this.#getDriver().activeHandle;
		if (!handle) {
			return Promise.reject(
				new Error(
					"no active antigravity turn; the pi tool bridge only works while an antigravity model is streaming " +
						"(parent turn already ended; background native agy subagents cannot call pi-bridge* tools)",
				),
			);
		}
		return new Promise<BridgeCallResultShape | BridgeEscalation>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#fail(callId, `pi tool round-trip timed out after ${BRIDGE_TIMEOUT_MS / 1000}s`);
			}, BRIDGE_TIMEOUT_MS);
			const onAbort = () => this.#fail(callId, "agy disconnected before the tool result arrived");
			signal.addEventListener("abort", onAbort, { once: true });
			const entry: PendingRoundTrip = { name, resolve, reject, timer, onAbort, signal };
			const escalateAfterMs =
				typeof this.#escalateAfterMs === "function"
					? this.#escalateAfterMs(name)
					: this.#escalateAfterMs;
			if (escalateAfterMs > 0) {
				entry.escalateTimer = setTimeout(() => {
					const e = this.#pending.get(callId);
					if (!e) return;
					e.escalated = true;
					clearTimeout(e.timer);
					e.timer = setTimeout(() => {
						this.#fail(
							callId,
							`escalated bridge call timed out after ${ESCALATED_TIMEOUT_MS / 60_000} minutes`,
						);
					}, ESCALATED_TIMEOUT_MS);
					this.#escalations.escalate(callId, e.name);
					resolve({ escalated: true, callId, name: e.name });
				}, escalateAfterMs);
			}
			this.#pending.set(callId, entry);
			handle.pushExternal({ type: "bridge_call", callId, name, args });
		});
	};

	resolve(
		toolCallId: string,
		text: string,
		isError: boolean,
		images: Array<{ data: string; mimeType: string }> = [],
	): boolean {
		const entry = this.#pending.get(toolCallId);
		if (!entry) return false;
		this.#pending.delete(toolCallId);
		clearTimeout(entry.timer);
		if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
		entry.signal.removeEventListener("abort", entry.onAbort);
		if (entry.escalated) {
			this.#escalations.settleDone(toolCallId, text, isError, images);
		} else {
			entry.resolve({
				content: [
					...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
					{ type: "text", text },
				],
				isError,
			});
		}
		this.#getDriver().kickIdle();
		this.#log("round-trip-resolved", { callId: toolCallId, name: entry.name, isError });
		return true;
	}
}

function extractResultImages(content: unknown): Array<{ data: string; mimeType: string }> {
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(b): b is { type: "image"; data: string; mimeType: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "image",
		)
		.map((b) => ({ data: b.data, mimeType: b.mimeType }))
		.filter((i) => typeof i.mimeType === "string" && typeof i.data === "string" && i.data.length > 0);
}

export function collectToolResults(
	messages: Message[],
	pendingIds: readonly string[],
): Array<{
	toolCallId: string;
	text: string;
	isError: boolean;
	images: Array<{ data: string; mimeType: string }>;
}> {
	if (pendingIds.length === 0) return [];
	const pending = new Set(pendingIds);
	const out: Array<{
		toolCallId: string;
		text: string;
		isError: boolean;
		images: Array<{ data: string; mimeType: string }>;
	}> = [];
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const id = (m as { toolCallId?: string }).toolCallId;
		if (!id || !pending.has(id)) continue;
		out.push({
			toolCallId: id,
			text: blocksToText(m.content).trim(),
			isError: m.isError === true,
			images: extractResultImages(m.content),
		});
	}
	return out;
}

export interface LateToolResult {
	callId?: string;
	name: string;
	reason: string;
	text: string;
	isError: boolean;
	images?: Array<{ data: string; mimeType: string }>;
}

export function buildLateResultPrompt(late: LateToolResult[], userPrompt?: string): string {
	const blocks = late.map((r) =>
		[
			`pi tool "${r.name}": ${r.reason}.`,
			r.isError ? "The tool reported an error:" : "Result:",
			r.text.trim() || "(no output)",
		].join("\n"),
	);
	const header = "Late tool delivery: treat the following as the results of your earlier tool calls.";
	const body = [header, ...blocks].join("\n\n");
	return userPrompt ? `${body}\n\n${userPrompt}` : body;
}

export interface DriverDeps {
	driver: TurnDriver;
	roundTrips: ToolRoundTrips;
	beforeTurn?: () => Promise<void>;
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	onNativeBackground?: (info: { conversationId: string; turnStartMs: number }) => void;
	onTurnFinished?: () => void;
	roster?: SubagentRoster;
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

export interface ActivityFeatures {
	roundTrips?: ToolRoundTrips;
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	onBackgroundArg?: (args: Record<string, unknown>) => void;
	roster?: SubagentRoster;
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

const parkedTurnBgState = new Map<string, { turnStartMs: number; nativeBackgroundSeen: boolean }>();

function emitToolUse(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	id: string,
	name: string,
	args: Record<string, JsonValue>,
): void {
	const partial = blocks.partial;
	closeThinking(stream, blocks);
	closeText(stream, blocks);
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
	partial.content.push(toolCall);
	const contentIndex = partial.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
	partial.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: partial });
	stream.end();
}

const ACP_EDIT_TOOLS = new Set(["edit_file", "create_file", "write_to_file", "write_file"]);

const NON_EDIT_PATH_KEYS = [
	"Path",
	"path",
	"file_path",
	"FilePath",
	"AbsolutePath",
	"absolute_path",
	"TargetFile",
	"target_file",
	"DirectoryPath",
	"directory_path",
	"SearchPath",
	"search_path",
	"SearchDirectory",
	"search_directory",
	"TargetDirectory",
	"target_directory",
	"Directory",
	"directory",
] as const;

const START_LINE_KEYS = ["StartLine", "start_line", "startLine", "offset"] as const;
const END_LINE_KEYS = ["EndLine", "end_line", "endLine"] as const;
const LIMIT_LINE_KEYS = ["limit", "Limit"] as const;

const QUERY_KEYS = [
	"Query",
	"query",
	"Pattern",
	"pattern",
	"SearchQuery",
	"search_query",
	"glob",
	"Glob",
	"Url",
	"url",
] as const;

function callIdArg(args: Record<string, unknown>): string | undefined {
	const v = args.callId;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function acpEditFileArg(args: Record<string, unknown>): string | undefined {
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === "string" && v.trim() && /file|path/i.test(k)) return v;
	}
	return undefined;
}

function firstStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

function firstPositiveIntArg(
	args: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	for (const k of keys) {
		const v = args[k];
		if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
	}
	return undefined;
}

function resolveToolPath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath) return undefined;
	let cleaned = rawPath.trim();
	if (!cleaned) return undefined;
	if (cleaned.startsWith("file://")) {
		try {
			cleaned = fileURLToPath(cleaned);
		} catch {
			cleaned = cleaned.replace(/^file:\/\//, "");
		}
	}
	if (path.isAbsolute(cleaned) || !cwd) return cleaned;
	return path.resolve(cwd, cleaned);
}

function extractCommandArg(args: Record<string, unknown>): string | undefined {
	return ["CommandLine", "command_line", "command"]
		.map((k) => args[k])
		.find((v): v is string => typeof v === "string" && v.length > 0);
}

function extractLineRangeSuffix(
	args: Record<string, unknown>,
	location: DriverToolLocation | undefined,
	includeLocationLine: boolean,
): string | undefined {
	const start = firstPositiveIntArg(args, START_LINE_KEYS);
	const end = firstPositiveIntArg(args, END_LINE_KEYS);
	const limit = firstPositiveIntArg(args, LIMIT_LINE_KEYS);
	if (start !== undefined && end !== undefined) {
		return start === end ? `:${start}` : `:${start}-${end}`;
	}
	if (start !== undefined && limit !== undefined) {
		return limit <= 1 ? `:${start}` : `:${start}-${start + limit - 1}`;
	}
	if (start !== undefined) return `:${start}-`;
	if (end !== undefined) return `:1-${end}`;
	if (includeLocationLine && location?.line !== undefined && location.line > 0) {
		return `:${location.line}`;
	}
	return undefined;
}

function extractToolDetail(
	name: string,
	args: Record<string, unknown>,
	targetPath: string | undefined,
	location: DriverToolLocation | undefined,
): string | undefined {
	const isEditTool = ACP_EDIT_TOOLS.has(name);
	const base = targetPath ? path.basename(targetPath) || targetPath : undefined;
	const lineSuffix = extractLineRangeSuffix(args, location, !isEditTool);
	if (lineSuffix) return base ? `${base}${lineSuffix}` : lineSuffix;
	if (isEditTool) return undefined;
	const query = firstStringArg(args, QUERY_KEYS);
	if (query) {
		const singleLineQuery = query.split(/\r?\n/, 1)[0]!.trim();
		const domain = firstStringArg(args, ["domain", "Domain"]);
		if (base) return `${singleLineQuery} (${base})`;
		if (domain) return `${singleLineQuery} (${domain})`;
		return singleLineQuery;
	}
	return undefined;
}

export function consumeActivity(
	stream: AssistantMessageEventStream,
	blocks: BlockState,
	activity: DriverActivity,
	diffCtx: TurnDiffContext,
	cwd: string,
	feats: ActivityFeatures,
): "parked" | "continue" {
	const partial = blocks.partial;
	feats.roster?.fold(activity);
	switch (activity.type) {
		case "text":
			appendText(stream, blocks, activity.delta);
			return "continue";
		case "thought":
			if (typeof activity.delta === "string" && activity.delta.length > 0) {
				appendThinking(stream, blocks, activity.delta);
			}
			return "continue";
		case "usage":
			toPiUsage(activity.usage, partial.usage);
			return "continue";
		case "tool_start": {
			const isEditTool = ACP_EDIT_TOOLS.has(activity.name);
			const rawPath = isEditTool
				? (acpEditFileArg(activity.args) ?? activity.location?.path)
				: (firstStringArg(activity.args, NON_EDIT_PATH_KEYS) ?? activity.location?.path);
			const targetPath = resolveToolPath(rawPath, cwd);
			const detail = extractToolDetail(
				activity.name,
				activity.args,
				targetPath,
				activity.location,
			);
			const command = extractCommandArg(activity.args);
			if (feats.onNativeEvent) {
				try {
					feats.onNativeEvent({
						name: activity.name,
						mcpServer: activity.mcpServer,
						...(activity.toolCallId ? { toolCallId: activity.toolCallId } : {}),
						status: "started",
						...(targetPath ? { path: targetPath } : {}),
						...(detail ? { detail } : {}),
						...(command ? { command } : {}),
						callId: callIdArg(activity.args),
					});
				} catch {
					// UI failure must not fail generation.
				}
			}
			if (looksBackgroundNativeCall(activity.args)) feats.onBackgroundArg?.(activity.args);
			return "continue";
		}
		case "tool_done": {
			const d = activity.diff;
			const isEditTool = ACP_EDIT_TOOLS.has(activity.name);
			const rawEditFile = isEditTool
				? (acpEditFileArg(activity.args) ?? activity.location?.path)
				: undefined;
			const rawTargetPath = isEditTool
				? rawEditFile
				: (firstStringArg(activity.args, NON_EDIT_PATH_KEYS) ?? activity.location?.path);
			const file = d?.path ?? resolveToolPath(rawTargetPath, cwd);
			let diffText = d ? formatInlineDiff(d.oldText ?? "", d.newText) : undefined;
			if (!d && isEditTool && file) {
				let disk = "";
				try {
					disk = fs.readFileSync(file, "utf8");
				} catch {
					// Deleted or unreadable file degrades to summary.
				}
				diffText = diffCtx.diffEdit(file, disk).text;
			}
			const detail = extractToolDetail(activity.name, activity.args, file, activity.location);
			const command = extractCommandArg(activity.args);
			let displayed = false;
			try {
				if (feats.onNativeEvent) {
					feats.onNativeEvent({
						name: activity.name,
						mcpServer: activity.mcpServer,
						...(activity.toolCallId ? { toolCallId: activity.toolCallId } : {}),
						status: "completed",
						path: file,
						...(detail ? { detail } : {}),
						command,
						output: activity.output,
						diff: diffText,
						callId: callIdArg(activity.args),
					});
					displayed = true;
				}
			} catch {
				// Renderer failure must not fail the turn.
			}
			if (displayed) return "continue";
			if ((isEditTool || d) && file) {
				appendThinking(stream, blocks, `[agy edit: ${path.basename(file)}]\n`);
				if (diffText) appendThinking(stream, blocks, `${diffText}\n`);
			} else {
				appendThinking(stream, blocks, `[agy tool: ${activity.name}]\n`);
			}
			return "continue";
		}
		case "tool_error": {
			const args = activity.args ?? {};
			const isEditTool = ACP_EDIT_TOOLS.has(activity.name);
			const rawPath = isEditTool
				? (acpEditFileArg(args) ?? activity.location?.path)
				: (firstStringArg(args, NON_EDIT_PATH_KEYS) ?? activity.location?.path);
			const targetPath = resolveToolPath(rawPath, cwd);
			const detail = extractToolDetail(activity.name, args, targetPath, activity.location);
			const command = extractCommandArg(args);
			if (feats.onNativeEvent) {
				try {
					feats.onNativeEvent({
						name: activity.name,
						mcpServer: activity.mcpServer,
						...(activity.toolCallId ? { toolCallId: activity.toolCallId } : {}),
						status: "failed",
						...(targetPath ? { path: targetPath } : {}),
						...(detail ? { detail } : {}),
						...(command ? { command } : {}),
						output: activity.message,
					});
					return "continue";
				} catch {
					// Fall back to thinking label.
				}
			}
			appendThinking(stream, blocks, `[agy tool: ${activity.name} failed: ${activity.message}]\n`);
			return "continue";
		}
		case "bridge_call":
			emitToolUse(
				stream,
				blocks,
				activity.callId,
				activity.name,
				activity.args as Record<string, JsonValue>,
			);
			return "parked";
	}
}

async function runTurnDriver(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	entries: AgyModelEntry[],
	store: SessionStore,
	deps: DriverDeps,
): Promise<void> {
	const partial = newAssistant(model);
	const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const config = loadConfig();
	const entry = entries.find((e) => e.id === model.id) ?? null;
	const agyModel = entry?.full ?? model.id;
	const effort = entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined;

	if (isStandaloneSummarizationTurn(context, options)) {
		const userPrompt = extractUserPrompt(context, 0);
		if (!userPrompt) {
			deps.log?.("turn-error", { reason: "no-user-message" }, "error");
			finalize(stream, blocks, "error", "No user message to send to agy.");
			return;
		}
		const sysPrompt = getCurrentSystemPrompt(context.messages) || undefined;
		const promptParts: string[] = [];
		if (sysPrompt) {
			promptParts.push(`${SYSTEM_PROMPT_PREAMBLE}\n\n${sysPrompt}\n\n${SYSTEM_PROMPT_END}`);
		}
		promptParts.push(SUMMARIZATION_NO_TOOLS_NOTE);
		promptParts.push(userPrompt);
		let summaryHandle: TurnHandle;
		try {
			summaryHandle = await deps.driver.run({
				cwd,
				model: agyModel,
				effort,
				mode: config.mode,
				skipPermissions: config.skipPermissions,
				timeoutMin: config.turnTimeoutMin,
				inactivityMin: config.inactivityTimeoutMin,
				conversationId: null,
				prompt: promptParts.join("\n\n---\n\n"),
				signal: options?.signal,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.log?.("turn-error", { reason: "driver-start-failed", error: msg }, "error");
			finalize(stream, blocks, "error", `agy failed to start: ${msg}`);
			return;
		}
		ensureStarted(stream, blocks);
		const summaryDiffCtx = new TurnDiffContext({ toplevel: () => null, showHead: () => null });
		const summaryFeats: ActivityFeatures = {
			onNativeEvent: () => {},
			log: deps.log,
		};
		for (;;) {
			const activity = await summaryHandle.next();
			if (!activity) break;
			if (activity.type === "bridge_call") continue;
			consumeActivity(stream, blocks, activity, summaryDiffCtx, cwd, summaryFeats);
		}
		const summaryOutcome = await summaryHandle.outcome;
		if (summaryOutcome.aborted) {
			finalize(stream, blocks, "aborted", "Operation aborted");
			return;
		}
		if (summaryOutcome.status === "ERROR") {
			finalize(stream, blocks, "error", summaryOutcome.error ?? "agy turn failed");
			return;
		}
		if (blocks.textIdx === null && summaryOutcome.response) {
			appendText(stream, blocks, summaryOutcome.response);
		}
		if (blocks.textIdx === null && blocks.thinkingIdx === null) {
			ensureTextOpen(stream, blocks);
		}
		finalize(stream, blocks, "stop");
		return;
	}

	const key = sessionKey(options, cwd);
	const rawExisting = store.get(key);
	const currentCompactionHash = latestCompactionHash(context.messages);
	const messageCount = context.messages.length;

	const results = collectToolResults(context.messages, deps.roundTrips.pendingIds);
	const isContinuation = results.length > 0;
	const resetForCompaction = Boolean(
		!isContinuation &&
			rawExisting?.conversationId &&
			currentCompactionHash &&
			currentCompactionHash !== rawExisting.compactionHash,
	);
	if (resetForCompaction) {
		store.delete(key);
		deps.log?.(
			"session-reset-compaction",
			{
				previousConversation: rawExisting?.conversationId,
				compactionHash: currentCompactionHash,
			},
			"info",
		);
	}
	const existing = resetForCompaction ? null : rawExisting;
	const escalatedNames = results
		.map((r) => deps.roundTrips.poll(r.toolCallId)?.name)
		.filter((n): n is string => Boolean(n));
	for (const r of results) {
		deps.roundTrips.resolve(r.toolCallId, r.text, r.isError, r.images);
	}

	const late: LateToolResult[] = [];
	if (!isContinuation) {
		for (const r of collectToolResults(context.messages, deps.roundTrips.deadIds)) {
			const dead = deps.roundTrips.consumeDead(r.toolCallId);
			if (dead) {
				late.push({
					name: dead.name,
					reason: dead.reason,
					text: r.text,
					isError: r.isError,
					images: r.images.length > 0 ? r.images : undefined,
				});
			}
		}
		if (late.length > 0) {
			deps.log?.(
				"late-result",
				{ tools: late.map((l) => l.name), freshConversation: !existing?.conversationId },
				"info",
			);
		}
	} else if (deps.roundTrips.deadIds.length > 0) {
		deps.log?.("late-result-deferred", { count: deps.roundTrips.deadIds.length }, "info");
	}

	let redeliveryConversation: string | undefined;
	const collectStranded = (): LateToolResult[] =>
		deps.roundTrips.claimAllUndelivered().map((view) => {
			redeliveryConversation ??= view.conversationId;
			deps.log?.("escalated-redelivery", { tool: view.name, callId: view.callId }, "info");
			return {
				callId: view.callId,
				name: view.name,
				reason: "you never received this result: you ended your turn without calling bridge_poll_result",
				text: view.text ?? "(no output)",
				isError: view.isError ?? false,
				images: view.images,
			};
		});

	let handle: TurnHandle | undefined;
	const active = isContinuation ? deps.driver.reentry() : null;
	if (active) {
		handle = active;
	} else {
		late.push(...collectStranded());
		if (isContinuation && late.length === 0) {
			if (escalatedNames.length === 0) {
				deps.log?.("turn-error", { reason: "tool-result-no-active-turn" }, "warn");
				finalize(stream, blocks, "error", "tool result arrived but no antigravity turn is running");
				return;
			}
			appendText(
				stream,
				blocks,
				`[bridge] ${escalatedNames.join(", ")} finished; the result is available via ${POLL_TOOL_NAME}.`,
			);
			finalize(stream, blocks, "stop");
			return;
		}
		if (
			isContinuation &&
			late.length > 0 &&
			redeliveryConversation === undefined &&
			!existing?.conversationId
		) {
			for (const l of late) if (l.callId) deps.roundTrips.unclaim(l.callId);
			appendText(
				stream,
				blocks,
				`[bridge] ${escalatedNames.join(", ")} finished, but no conversation is bound to re-deliver into; the result stays available via ${POLL_TOOL_NAME}.`,
			);
			finalize(stream, blocks, "stop");
			return;
		}

		const hasBoundSession = Boolean(existing?.conversationId);
		const watermark = hasBoundSession ? (existing?.lastMessageCount ?? 0) : 0;
		const userPrompt = extractUserPrompt(context, watermark);
		const images = extractImages(context, watermark);
		const lastRole = context.messages[context.messages.length - 1]?.role;
		const resume =
			!userPrompt &&
			images.length === 0 &&
			late.length === 0 &&
			hasBoundSession &&
			(lastRole === "toolResult" || lastRole === "assistant");
		const prompt = resume ? RESUME_PROMPT : userPrompt;
		if (resume) deps.log?.("resume-turn", { conversation: existing?.conversationId }, "error");
		if (!prompt && images.length === 0 && late.length === 0) {
			deps.log?.("turn-error", { reason: "no-user-message" }, "error");
			finalize(stream, blocks, "error", "No user message to send to agy.");
			return;
		}

		// Fresh ACP sessions (/fork or mid-session provider switch) get a one-shot
		// seed of prior transcript history, including prior Antigravity turns that
		// the new session has never seen. Bound sessions stay cache-clean unless
		// config.digest is enabled.
		let digest = "";
		let digestPreamble = DIGEST_PREAMBLE;
		if (late.length === 0 && !resume) {
			if (!hasBoundSession) {
				digest = buildContextDigest(context.messages, 0, {
					ownProvider: "",
					includeOwnAssistant: true,
					maxChars: 32_000,
				});
				digestPreamble = SEED_DIGEST_PREAMBLE;
			} else if (config.digest) {
				digest = buildContextDigest(context.messages, watermark);
			}
		}
		const gateOpen = config.systemPrompt && !hasBoundSession;
		const sysPrompt = gateOpen ? getCurrentSystemPrompt(context.messages) || undefined : undefined;
		const runImages = [...images, ...late.flatMap((l) => l.images ?? [])];
		const fullPrompt =
			late.length > 0
				? buildLateResultPrompt(late, prompt || undefined)
				: buildFullPrompt(sysPrompt, "", prompt ?? "");
		try {
			await deps.beforeTurn?.();
			handle = await deps.driver.run({
				cwd,
				model: agyModel,
				effort,
				mode: config.mode,
				skipPermissions: config.skipPermissions,
				timeoutMin: config.turnTimeoutMin,
				inactivityMin: config.inactivityTimeoutMin,
				conversationId: redeliveryConversation ?? existing?.conversationId ?? null,
				prompt: fullPrompt,
				images: runImages.length > 0 ? runImages : undefined,
				contextBlock: digest
					? {
							uri: `urn:pi-bridge:context-digest/${messageCount}`,
							text: `${digestPreamble}\n\n${digest}`,
						}
					: undefined,
				signal: options?.signal,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			for (const l of late) if (l.callId) deps.roundTrips.unclaim(l.callId);
			deps.log?.("turn-error", { reason: "driver-start-failed", error: msg }, "error");
			finalize(stream, blocks, "error", `agy failed to start: ${msg}`);
			return;
		}
	}

	ensureStarted(stream, blocks);
	const diffCtx = new TurnDiffContext(createExecGitOps());
	const priorBg = active ? parkedTurnBgState.get(key) : undefined;
	if (!active) parkedTurnBgState.delete(key);
	const turnStartMs = priorBg?.turnStartMs ?? Date.now();
	let nativeBackgroundSeen = priorBg?.nativeBackgroundSeen ?? false;
	const feats: ActivityFeatures = {
		roundTrips: deps.roundTrips,
		onNativeEvent: deps.onNativeEvent,
		onBackgroundArg: () => {
			nativeBackgroundSeen = true;
		},
		roster: deps.roster,
		log: deps.log,
	};

	const drainTurn = async (h: TurnHandle): Promise<"parked" | undefined> => {
		for (;;) {
			const activity = await h.next();
			if (!activity) break;
			if (consumeActivity(stream, blocks, activity, diffCtx, cwd, feats) === "parked") {
				return "parked";
			}
		}
	};
	if ((await drainTurn(handle)) === "parked") {
		parkedTurnBgState.set(key, { turnStartMs, nativeBackgroundSeen });
		if (!existing) {
			const parkedConv = deps.driver.snapshot().conversationId;
			if (parkedConv) {
				store.set(key, {
					conversationId: parkedConv,
					lastMessageCount: messageCount,
					...(currentCompactionHash ? { compactionHash: currentCompactionHash } : {}),
				});
			}
		}
		return;
	}
	parkedTurnBgState.delete(key);

	let outcome = await handle.outcome;
	if (isContinuation && outcome.status === "OK" && !outcome.aborted && !outcome.steered) {
		const more = collectStranded();
		if (more.length > 0) {
			const conv =
				redeliveryConversation ?? outcome.conversationId ?? existing?.conversationId ?? null;
			deps.log?.(
				"escalated-redelivery-turn",
				{ tools: more.map((s) => s.name), conversation: conv },
				"info",
			);
			const moreImages = more.flatMap((s) => s.images ?? []);
			try {
				const lateHandle = await deps.driver.run({
					cwd,
					model: agyModel,
					effort,
					mode: config.mode,
					skipPermissions: config.skipPermissions,
					timeoutMin: config.turnTimeoutMin,
					inactivityMin: config.inactivityTimeoutMin,
					conversationId: conv,
					prompt: buildLateResultPrompt(more),
					images: moreImages.length > 0 ? moreImages : undefined,
					signal: options?.signal,
				});
				if ((await drainTurn(lateHandle)) === "parked") {
					parkedTurnBgState.set(key, { turnStartMs, nativeBackgroundSeen });
					return;
				}
				outcome = await lateHandle.outcome;
			} catch (err) {
				for (const l of more) if (l.callId) deps.roundTrips.unclaim(l.callId);
				deps.log?.(
					"turn-error",
					{
						reason: "redelivery-start-failed",
						error: err instanceof Error ? err.message : String(err),
					},
					"error",
				);
			}
		}
	}

	if (outcome.conversationId) {
		if (existing?.conversationId && outcome.conversationId !== existing.conversationId) {
			store.delete(key);
		} else if (outcome.status === "OK" && !outcome.aborted) {
			store.set(key, {
				conversationId: outcome.conversationId,
				lastMessageCount: messageCount,
				...(currentCompactionHash ? { compactionHash: currentCompactionHash } : {}),
			});
		}
	}
	if (outcome.aborted) {
		deps.onTurnFinished?.();
		finalize(stream, blocks, "aborted", "Operation aborted");
		return;
	}
	if (outcome.status === "ERROR") {
		deps.onTurnFinished?.();
		finalize(stream, blocks, "error", outcome.error ?? "agy turn failed");
		return;
	}
	if (blocks.textIdx === null && outcome.response) {
		appendText(stream, blocks, outcome.response);
	}
	if (blocks.textIdx === null && blocks.thinkingIdx === null) {
		ensureTextOpen(stream, blocks);
	}
	if (nativeBackgroundSeen && outcome.conversationId && !outcome.steered) {
		deps.onNativeBackground?.({ conversationId: outcome.conversationId, turnStartMs });
		deps.log?.("native-background-arm", { conversation: outcome.conversationId, turnStartMs }, "info");
	}
	deps.onTurnFinished?.();
	finalize(stream, blocks, "stop");
}

export function createStreamSimple(
	deps: StreamSimpleDeps,
): (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	const { entries, store, roundTrips } = deps;

	return function streamSimple(model, context, options) {
		const stream = createAssistantMessageEventStream();

		if (isObservationalMemoryContext(context)) {
			if (!warnedObservationalMemoryMismatch) {
				warnedObservationalMemoryMismatch = true;
				deps.log?.(
					"turn-warning",
					{
						reason: "observational-memory-unsupported",
						message:
							"Observational memory background workers cannot run against Antigravity models (caller-scoped tools unsupported). Configure a dedicated model under 'observational-memory.model' in settings.json.",
					},
					"warn",
				);
			}
			const partial = newAssistant(model);
			const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };
			finalize(stream, blocks, "stop");
			return stream;
		}

		const config = loadConfig();
		const selected = deps.acpDriver ?? deps.driver;
		if (config.readOnly || config.mode === "plan") {
			const partial = newAssistant(model);
			const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };
			if (config.readOnly) {
				deps.log?.("turn-error", { reason: "readonly-refused" }, "warn");
				finalize(
					stream,
					blocks,
					"error",
					"readOnly cannot be enforced on provider turns: the agy CLI has no review-only enforcement. Enforce read-only in the host, then run /agy readonly off.",
				);
				return stream;
			}
			deps.log?.("turn-error", { reason: "plan-refused" }, "warn");
			finalize(
				stream,
				blocks,
				"error",
				"Plan mode cannot be enforced on ACP provider turns. Run /agy mode accept-edits and enforce review-only in the host.",
			);
			return stream;
		}
		if (selected && roundTrips) {
			void runTurnDriver(stream, model, context, options, entries, store, {
				driver: selected,
				roundTrips,
				beforeTurn: deps.beforeTurn,
				onNativeEvent: deps.onNativeEvent,
				onNativeBackground: deps.onNativeBackground,
				onTurnFinished: deps.onTurnFinished,
				roster: deps.roster,
				log: deps.log,
			});
		} else {
			const partial = newAssistant(model);
			const blocks: BlockState = { partial, textIdx: null, thinkingIdx: null, started: false };
			deps.log?.("turn-error", { reason: "driver-not-configured" }, "warn");
			finalize(stream, blocks, "error", "antigravity driver not configured");
		}
		return stream;
	};
}

function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
}

function appendText(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureTextOpen(stream, b);
	textAt(b.partial, b.textIdx!).text += delta;
	stream.push({ type: "text_delta", contentIndex: b.textIdx!, delta, partial: b.partial });
}

function appendThinking(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureThinkingOpen(stream, b);
	thinkingAt(b.partial, b.thinkingIdx!).thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: b.thinkingIdx!, delta, partial: b.partial });
}

function ensureTextOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx !== null) return;
	closeThinking(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "text", text: "" });
	b.textIdx = b.partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex: b.textIdx, partial: b.partial });
}

function ensureThinkingOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx !== null) return;
	closeText(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "thinking", thinking: "" });
	b.thinkingIdx = b.partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: b.thinkingIdx, partial: b.partial });
}

function closeText(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx === null) return;
	const idx = b.textIdx;
	b.textIdx = null;
	stream.push({ type: "text_end", contentIndex: idx, content: textAt(b.partial, idx).text, partial: b.partial });
}

function closeThinking(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx === null) return;
	const idx = b.thinkingIdx;
	b.thinkingIdx = null;
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: thinkingAt(b.partial, idx).thinking,
		partial: b.partial,
	});
}

function textAt(p: AssistantMessage, idx: number): { type: "text"; text: string } {
	return p.content[idx] as { type: "text"; text: string };
}

function thinkingAt(p: AssistantMessage, idx: number): { type: "thinking"; thinking: string } {
	return p.content[idx] as { type: "thinking"; thinking: string };
}

function finalize(
	stream: AssistantMessageEventStream,
	b: BlockState,
	reason: "stop" | "error" | "aborted",
	message?: string,
): void {
	closeText(stream, b);
	closeThinking(stream, b);
	if (reason === "stop") {
		b.partial.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: b.partial });
	} else {
		b.partial.stopReason = reason;
		if (message) b.partial.errorMessage = message;
		stream.push({ type: "error", reason, error: b.partial });
	}
	stream.end();
}
