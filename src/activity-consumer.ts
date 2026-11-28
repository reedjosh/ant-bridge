// Streaming activity consumer, native tool detail formatting, and AssistantMessage block helpers.

import type {
	AssistantMessage,
	AssistantMessageEventStream,
	JsonValue,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksBackgroundNativeCall } from "./background-watch.js";
import { CALL_PI_TOOL_NAME } from "./bridge-catalog.js";
import { formatInlineDiff, type TurnDiffContext } from "./diff-render.js";
import { toPiUsage, type DriverActivity, type DriverToolLocation } from "./driver-types.js";
import type { SubagentRoster } from "./subagent-roster.js";
import type { ToolRoundTrips } from "./tool-roundtrips.js";

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

export interface ActivityFeatures {
	roundTrips?: ToolRoundTrips;
	onNativeEvent?: (event: NativeDisplayEvent) => void;
	onBackgroundArg?: (args: Record<string, unknown>) => void;
	roster?: SubagentRoster;
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
}

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

export function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
}

export function appendText(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureTextOpen(stream, b);
	textAt(b.partial, b.textIdx!).text += delta;
	stream.push({ type: "text_delta", contentIndex: b.textIdx!, delta, partial: b.partial });
}

export function appendThinking(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureThinkingOpen(stream, b);
	thinkingAt(b.partial, b.thinkingIdx!).thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: b.thinkingIdx!, delta, partial: b.partial });
}

export function ensureTextOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx !== null) return;
	closeThinking(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "text", text: "" });
	b.textIdx = b.partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex: b.textIdx, partial: b.partial });
}

export function ensureThinkingOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx !== null) return;
	closeText(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "thinking", thinking: "" });
	b.thinkingIdx = b.partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: b.thinkingIdx, partial: b.partial });
}

export function closeText(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx === null) return;
	const idx = b.textIdx;
	b.textIdx = null;
	stream.push({ type: "text_end", contentIndex: idx, content: textAt(b.partial, idx).text, partial: b.partial });
}

export function closeThinking(stream: AssistantMessageEventStream, b: BlockState): void {
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

export function finalize(
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
