// Bridge MCP tool round-trip parking, escalation registry, and result collection.

import type { JsonValue, Message } from "@earendil-works/pi-ai";
import { CALL_PI_TOOL_NAME } from "./bridge-catalog.js";
import { blocksToText } from "./prompt-builder.js";

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

const DELEGATION_NAME_RE = /subagent|delegate|^agent(_|$)|^codemode$|^bash$|^powershell$/i;

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
