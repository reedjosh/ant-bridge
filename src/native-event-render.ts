// Entry renderers and output cleaner for `agy-native-event` and `agy-poll-run` transcript items.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	MouseRegion,
	stripTerminalSequences,
	Text,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { PollRunData } from "./poll-fold.js";
import type { NativeDisplayEvent } from "./provider.js";

export const PREVIEW_LINES = 5;

const POLL_TOOL_NAME = "bridge_poll_result";

export type NativeThemeColor =
	| "error"
	| "success"
	| "toolTitle"
	| "muted"
	| "dim"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "toolOutput";

export interface NativeRenderTheme {
	fg(color: NativeThemeColor, text: string): string;
}

export interface NativeEntryRenderOptions {
	expanded: boolean;
	keyHint?: (keybinding: "app.tools.expand", description: string) => string;
}

export interface NativeCustomEntry {
	data?: NativeDisplayEvent;
}

export interface PollRunCustomEntry {
	data?: PollRunData;
}

interface EntryExpandState {
	localExpanded?: boolean;
	lastGlobalExpanded: boolean;
}

function unwrapFileUri(rawPath: string): string {
	const cleaned = rawPath.replace(/[.,;]+$/, "");
	if (!cleaned.startsWith("file://")) return cleaned;
	try {
		return fileURLToPath(cleaned);
	} catch {
		return cleaned.replace(/^file:\/\//, "");
	}
}

/** Normalize line endings and strip `agy`'s `run_command` / native-tool metadata wrapper.
 *  Preserves non-zero exit codes (`[exit N]`) and truncation pointers (`[truncated -> path]`),
 *  and collapses `"No output from the command."` to empty string when exit code is 0. */
export function cleanNativeCommandOutput(raw: string | undefined): string {
	if (!raw) return "";
	let text = raw.replace(/\r\n?/g, "\n");
	let hadHeader = false;
	let truncatedNote: string | undefined;
	let exitNote: string | undefined;

	const truncMatch =
		/^The tool's output was truncated[^\n]*(?:\n+Here is a preview[^\n]*:?)?\n*/.exec(text);
	if (truncMatch) {
		hadHeader = true;
		const header = truncMatch[0];
		const fileMatch = /\bin a file at\s+(\S+)/.exec(header);
		truncatedNote = fileMatch
			? `[truncated -> ${unwrapFileUri(fileMatch[1]!)}]`
			: "[truncated]";
		text = text.slice(header.length);
	}

	const createdMatch = /^Created At:[^\n]*\n?/.exec(text);
	if (createdMatch) {
		hadHeader = true;
		text = text.slice(createdMatch[0].length);
	}

	const completedMatch = /^Completed At:[^\n]*\n?/.exec(text);
	if (completedMatch) {
		hadHeader = true;
		text = text.slice(completedMatch[0].length);
	}

	const exitMatch = /^Command exited with code (-?\d+)\.?[ \t]*\n?/.exec(text);
	if (exitMatch) {
		hadHeader = true;
		const code = Number(exitMatch[1]);
		if (Number.isFinite(code) && code !== 0) {
			exitNote = `[exit ${code}]`;
		}
		text = text.slice(exitMatch[0].length);
	}

	const cmdOutputMatch = /^\n*Command output:[ \t]*\n?/.exec(text);
	if (cmdOutputMatch) {
		hadHeader = true;
		text = text.slice(cmdOutputMatch[0].length);
	} else if (hadHeader) {
		text = text.replace(/^\n+/, "");
	}

	if (text.trim() === "No output from the command.") {
		text = "";
	} else {
		text = text.replace(/\n+$/, "");
		if (text.trim().length === 0) text = "";
	}

	const parts: string[] = [];
	if (text.length > 0) parts.push(text);
	if (exitNote) parts.push(exitNote);
	if (truncatedNote) parts.push(truncatedNote);
	return parts.join("\n");
}

/** Bound persisted native output while preserving both the leading `agy` header and tail lines. */
export function capNativeOutput(raw: string | undefined, maxChars = 8000): string | undefined {
	if (raw === undefined || raw.length <= maxChars) return raw;
	const half = Math.floor(maxChars / 2);
	const headBreak = raw.lastIndexOf("\n", half);
	const head = headBreak > 256 ? raw.slice(0, headBreak) : raw.slice(0, half);
	const tailStart = raw.length - half;
	const tailBreak = raw.indexOf("\n", tailStart);
	const tail =
		tailBreak !== -1 && tailBreak < raw.length - 1 ? raw.slice(tailBreak + 1) : raw.slice(tailStart);
	return `${head}\n...[middle omitted]...\n${tail}`;
}

function firstSingleLine(value: string | undefined): string | undefined {
	const line = value?.split(/\r?\n/, 1)[0]?.trim();
	return line && line.length > 0 ? line : undefined;
}

/** Concise one-line target summary shown next to the tool name in the header. */
export function formatNativeEventDetail(event: NativeDisplayEvent | undefined): string | undefined {
	if (!event) return undefined;
	const detail = firstSingleLine(event.detail);
	if (detail) {
		if (detail.startsWith(":") && event.path) {
			return `${path.basename(event.path) || event.path}${detail}`;
		}
		return detail;
	}
	if (event.path) {
		return path.basename(event.path) || event.path;
	}
	return firstSingleLine(event.command);
}

function colorDiffLine(line: string, theme: NativeRenderTheme): string {
	const color = line.startsWith("+")
		? "toolDiffAdded"
		: line.startsWith("-")
			? "toolDiffRemoved"
			: "toolDiffContext";
	return theme.fg(color, line);
}

function formatExpandHint(
	hidden: number,
	direction: "earlier" | "more",
	options: NativeEntryRenderOptions,
	theme: NativeRenderTheme,
): string {
	const unit = hidden === 1 ? "line" : "lines";
	const rawHint = options.keyHint?.("app.tools.expand", "to expand");
	const plainHint = rawHint ? stripTerminalSequences(rawHint).trim() : "";
	const expandHint =
		rawHint && plainHint.length > 0 && plainHint !== "to expand"
			? rawHint
			: `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", " to expand")}`;
	return (
		theme.fg("muted", `... (${hidden} ${direction} ${unit}, click or `) +
		expandHint +
		theme.fg("muted", ")")
	);
}

/** Build styled transcript lines for a native event in collapsed or expanded state. */
export function formatNativeEventLines(
	event: NativeDisplayEvent | undefined,
	expanded: boolean,
	options: NativeEntryRenderOptions,
	theme: NativeRenderTheme,
): string[] {
	const detail = formatNativeEventDetail(event);
	const status =
		event?.status === "failed" ? theme.fg("error", "x") : theme.fg("success", "ok");
	const title = theme.fg("toolTitle", event?.name ?? "Antigravity");
	const suffix = detail ? ` ${theme.fg("muted", detail.slice(0, 160))}` : "";
	const lines = [`${status} ${title}${suffix}`];

	const normalizedDiff = event?.diff ? event.diff.replace(/\r\n?/g, "\n").replace(/\n+$/, "") : "";
	const diffLines = normalizedDiff.length > 0 ? normalizedDiff.split("\n") : [];
	const cleanedOutput = cleanNativeCommandOutput(event?.output);
	const outputLines = cleanedOutput.length > 0 ? cleanedOutput.split("\n") : [];

	if (expanded) {
		if (event?.path) lines.push(theme.fg("dim", event.path));
		for (const line of diffLines) {
			lines.push(colorDiffLine(line, theme));
		}
		for (const line of outputLines) {
			lines.push(theme.fg("toolOutput", line));
		}
		return lines;
	}

	if (diffLines.length > 0) {
		for (const line of diffLines.slice(0, PREVIEW_LINES)) {
			lines.push(colorDiffLine(line, theme));
		}
		if (diffLines.length > PREVIEW_LINES) {
			lines.push(
				formatExpandHint(diffLines.length - PREVIEW_LINES, "more", options, theme),
			);
		}
	}

	if (outputLines.length > 0 && event?.status === "failed") {
		if (outputLines.length > PREVIEW_LINES) {
			lines.push(
				formatExpandHint(outputLines.length - PREVIEW_LINES, "earlier", options, theme),
			);
		}
		for (const line of outputLines.slice(-PREVIEW_LINES)) {
			lines.push(theme.fg("toolOutput", line));
		}
	}

	return lines;
}

/** Build styled transcript lines for a folded poll run in collapsed or expanded state. */
export function formatPollRunLines(
	run: PollRunData | undefined,
	expanded: boolean,
	options: NativeEntryRenderOptions,
	theme: NativeRenderTheme,
): string[] {
	const count = run?.count ?? 0;
	const stateSuffix = run?.state === "failed" ? ", failed" : "";
	const label = `Poll ${run?.target ?? "bridge call"} (x${count}${stateSuffix})`;
	let hint = "";
	if (!expanded && run) {
		const rawKey = options.keyHint?.("app.tools.expand", "");
		const plainKey = rawKey ? stripTerminalSequences(rawKey).trim() : "";
		const keyLabel = plainKey.length > 0 ? plainKey : "ctrl+o";
		hint = ` ${theme.fg("dim", `(click or ${keyLabel})`)}`;
	}
	const lines = [
		`[poll] ${theme.fg("toolTitle", POLL_TOOL_NAME)} ${theme.fg("muted", label)}${hint}`,
	];
	if (expanded && run) {
		const time = (iso: string): string => new Date(iso).toLocaleTimeString();
		const unit = count === 1 ? "poll" : "polls";
		lines.push(theme.fg("dim", `${count} ${unit}, ${time(run.firstAt)} -> ${time(run.lastAt)}`));
	}
	return lines;
}

function createExpandableEntryRenderer<TEntry extends object>(
	renderLines: (
		entry: TEntry,
		expanded: boolean,
		options: NativeEntryRenderOptions,
		theme: NativeRenderTheme,
	) => string[],
): (
	entry: TEntry,
	options: NativeEntryRenderOptions,
	theme: NativeRenderTheme,
) => Component {
	const states = new WeakMap<object, EntryExpandState>();

	return (entry, options, theme) => {
		let state = states.get(entry);
		if (!state) {
			state = { lastGlobalExpanded: options.expanded };
			states.set(entry, state);
		} else if (state.lastGlobalExpanded !== options.expanded) {
			state.localExpanded = undefined;
			state.lastGlobalExpanded = options.expanded;
		}

		const currentExpanded = (): boolean => state.localExpanded ?? state.lastGlobalExpanded;
		const renderText = (expanded: boolean): string =>
			renderLines(entry, expanded, options, theme).join("\n");

		const text = new Text(renderText(currentExpanded()), 0, 0);
		return new MouseRegion(text, (mouseEvent: TuiMouseEvent): TuiMouseEventResult | undefined => {
			if (mouseEvent.type !== "click" || mouseEvent.button !== "left") {
				return undefined;
			}
			const next = !currentExpanded();
			state.localExpanded = next;
			text.setText(renderText(next));
			text.invalidate();
			return { handled: true };
		});
	};
}

/** Create a custom-entry renderer wrapped in `MouseRegion` for per-entry left-click toggling. */
export function createNativeEventEntryRenderer(): (
	entry: NativeCustomEntry,
	options: NativeEntryRenderOptions,
	theme: NativeRenderTheme,
) => Component {
	return createExpandableEntryRenderer((entry, expanded, options, theme) =>
		formatNativeEventLines(entry.data, expanded, options, theme),
	);
}

/** Create a custom-entry renderer for `agy-poll-run` rows with per-entry left-click toggling. */
export function createPollRunEntryRenderer(): (
	entry: PollRunCustomEntry,
	options: NativeEntryRenderOptions,
	theme: NativeRenderTheme,
) => Component {
	return createExpandableEntryRenderer((entry, expanded, options, theme) =>
		formatPollRunLines(entry.data, expanded, options, theme),
	);
}
