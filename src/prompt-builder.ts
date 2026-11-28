// Prompt, context digest, and late-result formatting for the Antigravity ACP provider.

import {
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { ToolMode } from "./config.js";

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
	"  parameters and invoke `mcp_pi-bridge_call_pi_tool` (or `mcp_pi-bridge-s*_call_pi_tool` in",
	"  child sessions) with `{ name, arguments }` (for example `name: \"subagent\"`,",
	"  `name: \"codemode\"`, or `name: \"pi-bridge-slack/slack_read_thread\"`).",
	"- Launch `subagent` runs asynchronously (`async: true`, the default, especially for",
	"  `workflow: \"parallel\"`) and end your turn immediately without calling `bg_wait` or polling:",
	"  the main thread stays free for user chat while subagents run, and Pi wakes the session when",
	"  they finish. Use `async: false` only when blocking the turn is explicitly required.",
	"- Never run background tasks, daemons, or subagents natively inside Antigravity (no `run_command`",
	"  with `IsDaemon: true`, low `WaitMsBeforeAsync`, or commands expected to exceed 10s; no",
	"  `manage_task`, `define_subagent`, `invoke_subagent`, `run_subagent`, `manage_subagents`,",
	"  `send_message`, `run_workflow`, `swarm`, or `schedule`). Keep `run_command` to quick",
	"  synchronous commands (`WaitMsBeforeAsync: 10000`) and delegate any long-running, background,",
	"  or parallel work (builds, test suites, pulls, watches) to Pi's `subagent` (`async: true`).",
	"- If any bridged call answers `STILL RUNNING` with a `callId`, poll `bridge_poll_result` on",
	"  `pi-bridge` until it settles before ending your turn.",
	"- Inside `codemode` scripts, MCP tools resolve to `{ content, structuredContent, isError }`",
	"  objects and `return <object>` renders as one escaped JSON line in Pi; extract readable text and",
	"  emit formatted multi-line strings with `text(...)` instead of returning raw or nested JSON",
	"  objects.",
].join("\n");

export const TOOL_PRIORITY_NOTE: string = [
	"[Tool priority: this conversation runs inside pi, not as a standalone agy session; the user only",
	"sees what surfaces in pi. NEVER call native ask_question: ACP cannot deliver answers to it,",
	"so it blocks the conversation and replays the same question on later turns. For questions use",
	"Pi's ask_user_question if available; otherwise ask in plain text and end your turn. When a Pi",
	"Bridge tool covers the same purpose, always use it. Direct Pi MCP servers appear in agy's <mcp_servers> as",
	"pi-bridge-<server> (mcp_pi-bridge-<server>_<tool> when eager); call eager tools directly so Pi",
	"renders clean <server>/<tool> rows. Because agy acp omits schemas above ~1.48 KB (including",
	"subagent, codemode, activate_skill, and larger MCP tools) without registering Lazy: or",
	"call_mcp_tool, every tool's <tool>.json schema is still written under <appDataDir>/mcp/pi-bridge*/",
	"on disk: read <appDataDir>/mcp/<serverName>/<tool>.json and invoke any non-eager tool via",
	"mcp_pi-bridge_call_pi_tool (or mcp_pi-bridge-s*_call_pi_tool in child sessions) with",
	"{ name, arguments }. Servers marked (codemode) in Pi's",
	"<mcp_servers> section (such as Slack, Linear, Sentry, or Figma) do not appear as separate agy MCP",
	"servers; reach them via mcp_pi-bridge_codemode (or mcp_pi-bridge_call_pi_tool with name",
	"\"codemode\" when non-eager, using searchTools / describeNamespace) and never inspect local ~/.pi",
	"MCP config files. When batching calls in codemode, extract readable text from",
	"{ content, structuredContent } results and emit formatted multi-line text via text(...) rather",
	"than returning raw or nested JSON objects. For workspace files and commands, your native",
	"read_file, edit_file, write_file, and run_command tools operate directly on the real filesystem",
	"and render in pi (including visible images on read_file). Use run_command ONLY for short",
	"synchronous commands that finish within WaitMsBeforeAsync: 10000; NEVER run background tasks or",
	"daemons natively in agy (no IsDaemon: true, no low WaitMsBeforeAsync like 500, no manage_task",
	"polling, and never leave a detached task-* running across turns). For any long-running,",
	"asynchronous, or parallel command or job (builds, npm ci, docker pull, full test suites, watches,",
	"or multi-step work), delegate to a Pi subagent via mcp_pi-bridge_call_pi_tool with name",
	"\"subagent\" (async: true) instead of backgrounding run_command in agy. When a bridge call answers STILL",
	"RUNNING, poll bridge_poll_result before doing other work: until you poll, the result (including",
	"any image) stays undelivered to you. Delegate subagent work through Pi Bridge: when pi's tool list",
	"includes a delegation tool (for example subagent, Agent, agent_spawn, agent_wait, or",
	"subagent_run), always delegate through it (directly or via mcp_pi-bridge_call_pi_tool with name",
	"\"subagent\") and never through the native define_subagent, invoke_subagent, run_subagent,",
	"manage_subagents, send_message, run_workflow, or swarm; native invoke_subagent and swarm",
	"background workers run inside agy invisible to pi, lose",
	"access to pi-bridge* tools as soon as the parent turn ends, and never wake pi on completion (even",
	"if no pi delegation tool is listed, never leave native subagents running across turn boundaries or",
	"expect them to call pi-bridge* tools). Keep subagent launches asynchronous (async: true, the",
	"default, especially for parallel workflows) and return control immediately without calling",
	"bg_wait or polling so the user can keep chatting on the main thread until pi natively wakes the",
	"session on completion; pass async: false only when blocking is explicitly required. Never call",
	"the native schedule tool and end your turn to",
	"wait for a timer or cron: ending your turn closes the active pi prompt, so a later native schedule",
	"wakeup runs with no active pi turn, drops its output, cannot call pi-bridge* tools, and races with",
	"subsequent prompts; keep polling bounded inside the active turn or use Pi Bridge tools instead.",
	"Long-running bridge calls do not fail: after ~20 seconds (120 seconds for subagent and codemode",
	"calls) the bridge answers STILL RUNNING with a callId; fetch the result with bridge_poll_result",
	"and poll until it lands.]",
].join(" ");

export const PI_ONLY_TOOL_PRIORITY_NOTE: string = [
	"[Tool priority (pi-only mode): this conversation runs inside pi with native agy write, edit,",
	"shell, subagent, schedule, and question tools disabled. Use call_mcp_tool({ ServerName,",
	"ToolName, Arguments }) for workspace text/code reads, edits, writes, shell commands, extensions,",
	"MCP tools, subagents, and skills through Pi Bridge (`pi-bridge` and `pi-bridge-<server>`).",
	"Native read_file is kept ONLY for viewing image files (PNG, JPEG, WebP, GIF, screenshots) or",
	".system_generated/ files that agy offloaded from a call_mcp_tool response (such as media_0.*",
	"or output.txt); do not use read_file for ordinary workspace source files. Never call native",
	"manage_task. For user questions use Pi's ask_user_question if available; otherwise ask in plain",
	"text and end your turn. Servers marked (codemode) in Pi's <mcp_servers> section are reached",
	"through call_mcp_tool on `pi-bridge` with ToolName `codemode` (searchTools / describeNamespace);",
	"inside codemode scripts, extract readable text from { content, structuredContent } results and",
	"emit formatted multi-line text via text(...) rather than raw JSON. Keep subagent launches",
	"asynchronous (async: true, the default) and end your turn without calling bg_wait or polling;",
	"Pi wakes the session when subagents finish. Long-running bridge calls do not fail: after ~20",
	"seconds (120 seconds for bash, powershell, subagent, and codemode calls) the bridge answers",
	"STILL RUNNING with a callId; fetch the result with call_mcp_tool(pi-bridge, bridge_poll_result,",
	"{ callId }) until it lands.]",
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
	toolMode: ToolMode = "hybrid",
): string {
	const parts: string[] = [];
	const priorityNote = toolMode === "pi-only" ? PI_ONLY_TOOL_PRIORITY_NOTE : TOOL_PRIORITY_NOTE;
	if (systemPrompt) {
		parts.push(
			`${SYSTEM_PROMPT_PREAMBLE}\n\n${systemPrompt}\n\n${priorityNote}\n\n${SYSTEM_PROMPT_END}`,
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

export function blocksToText(content: unknown): string {
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
	const end = trailingStart;
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
