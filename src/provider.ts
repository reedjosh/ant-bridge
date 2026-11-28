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
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	appendText,
	appendThinking,
	closeText,
	closeThinking,
	consumeActivity,
	ensureStarted,
	ensureTextOpen,
	finalize,
	type ActivityFeatures,
	type BlockState,
	type NativeDisplayEvent,
} from "./activity-consumer.js";
import { CALL_PI_TOOL_NAME } from "./bridge-catalog.js";
import { loadConfig } from "./config.js";
import { createExecGitOps, TurnDiffContext } from "./diff-render.js";
import { toPiUsage, type TurnDriver, type TurnHandle } from "./driver-types.js";
import { toAgyEffort, type AgyModelEntry } from "./models.js";
import {
	buildContextDigest,
	buildFullPrompt,
	buildLateResultPrompt,
	DIGEST_PREAMBLE,
	extractImages,
	extractUserPrompt,
	isObservationalMemoryContext,
	isStandaloneSummarizationTurn,
	latestCompactionHash,
	RESUME_PROMPT,
	SEED_DIGEST_PREAMBLE,
	SUMMARIZATION_NO_TOOLS_NOTE,
	SYSTEM_PROMPT_END,
	SYSTEM_PROMPT_PREAMBLE,
	trailingUserTurnStart,
	type LateToolResult,
} from "./prompt-builder.js";
import { SessionStore } from "./sessions.js";
import { SubagentRoster } from "./subagent-roster.js";
import { collectToolResults, POLL_TOOL_NAME, ToolRoundTrips } from "./tool-roundtrips.js";

export { CALL_PI_TOOL_NAME };
export * from "./activity-consumer.js";
export * from "./prompt-builder.js";
export * from "./tool-roundtrips.js";

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
export function sessionKey(options: SimpleStreamOptions | undefined, cwd: string): string {
	const sid = (options as { sessionId?: string } | undefined)?.sessionId;
	const base = sid && sid.length > 0 ? `sid:${sid}` : `cwd:${cwd}`;
	return `${base}@acp`;
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
	resolveSessionDeps?: (
		key: string,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		isSummarization: boolean,
	) => DriverDeps | undefined;
	log?: (event: string, data?: unknown, level?: "debug" | "info" | "warn" | "error") => void;
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

const parkedTurnBgState = new Map<string, { turnStartMs: number; nativeBackgroundSeen: boolean }>();

async function runTurnDriver(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	entries: AgyModelEntry[],
	store: SessionStore,
	deps: DriverDeps,
	recoveryBlocks?: BlockState,
): Promise<void> {
	const partial = recoveryBlocks?.partial ?? newAssistant(model);
	const blocks: BlockState = recoveryBlocks ?? { partial, textIdx: null, thinkingIdx: null, started: false };

	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const config = loadConfig();
	const entry = entries.find((e) => e.id === model.id) ?? null;
	const agyModel = entry?.full ?? model.id;
	const effort = entry?.efforts?.length ? toAgyEffort(options?.reasoning, entry.efforts) : undefined;

	const baseRunOpts = {
		cwd,
		model: agyModel,
		effort,
		mode: config.mode,
		skipPermissions: config.skipPermissions,
		timeoutMin: config.turnTimeoutMin,
		inactivityMin: config.inactivityTimeoutMin,
		signal: options?.signal,
	};

	if (isStandaloneSummarizationTurn(context, options)) {
		const userPrompt = extractUserPrompt(context, 0);
		if (!userPrompt) {
			deps.log?.("turn-error", { reason: "no-user-message" }, "error");
			deps.onTurnFinished?.();
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
				...baseRunOpts,
				conversationId: null,
				prompt: promptParts.join("\n\n---\n\n"),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.log?.("turn-error", { reason: "driver-start-failed", error: msg }, "error");
			deps.onTurnFinished?.();
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
			deps.onTurnFinished?.();
			finalize(stream, blocks, "aborted", "Operation aborted");
			return;
		}
		if (summaryOutcome.status === "ERROR") {
			deps.onTurnFinished?.();
			finalize(stream, blocks, "error", summaryOutcome.error ?? "agy turn failed");
			return;
		}
		if (blocks.textIdx === null && summaryOutcome.response) {
			appendText(stream, blocks, summaryOutcome.response);
		}
		if (blocks.textIdx === null && blocks.thinkingIdx === null) {
			ensureTextOpen(stream, blocks);
		}
		deps.onTurnFinished?.();
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
	const storedToolMode = rawExisting?.toolMode ?? "hybrid";
	const resetForToolMode = Boolean(
		!isContinuation && rawExisting?.conversationId && storedToolMode !== config.toolMode,
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
	} else if (resetForToolMode) {
		store.delete(key);
		deps.log?.(
			"session-reset-tool-mode",
			{
				previousConversation: rawExisting?.conversationId,
				previousToolMode: storedToolMode,
				toolMode: config.toolMode,
			},
			"info",
		);
	}
	const existing = resetForCompaction || resetForToolMode ? null : rawExisting;
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
			((hasBoundSession && (lastRole === "toolResult" || lastRole === "assistant")) ||
				(!hasBoundSession && Boolean(currentCompactionHash)));
		const compactedResume = resume && !hasBoundSession && Boolean(currentCompactionHash);
		const prompt = compactedResume
			? "Continue the unfinished task from the compacted context and latest results. " +
				"Do not wait for a new user message."
			: resume
				? RESUME_PROMPT
				: userPrompt;
		if (resume) deps.log?.("resume-turn", { conversation: existing?.conversationId, compactedResume }, "info");
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
		if (late.length === 0 && (!resume || !hasBoundSession)) {
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
				: buildFullPrompt(sysPrompt, "", prompt ?? "", config.toolMode);
		try {
			await deps.beforeTurn?.();
			handle = await deps.driver.run({
				...baseRunOpts,
				conversationId: redeliveryConversation ?? existing?.conversationId ?? null,
				prompt: fullPrompt,
				images: runImages.length > 0 ? runImages : undefined,
				contextBlock: digest
					? {
							uri: `urn:pi-bridge:context-digest/${messageCount}`,
							text: `${digestPreamble}\n\n${digest}`,
						}
					: undefined,
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
					...(config.toolMode === "pi-only" ? { toolMode: "pi-only" } : {}),
				});
			}
		}
		return;
	}
	parkedTurnBgState.delete(key);

	let outcome = await handle.outcome;
	if (outcome.retryInFreshSession && !isContinuation && !recoveryBlocks) {
		// No prompt or tools ran in the blocked session. Reuse the open stream,
		// seed the transcript once, and deliver the latest reply to a fresh session.
		store.delete(key);
		deps.log?.("session-reset-native-question", { previousConversation: outcome.conversationId }, "warn");
		return runTurnDriver(stream, model, context, options, entries, store, deps, blocks);
	}
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
					...baseRunOpts,
					conversationId: conv,
					prompt: buildLateResultPrompt(more),
					images: moreImages.length > 0 ? moreImages : undefined,
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

	// Reentry still uses the old ACP context. Leave its summary hash and toolMode
	// unchanged so the next fresh prompt rotates instead of skipping the seed.
	const deliveredCompactionHash = active ? existing?.compactionHash : currentCompactionHash;
	const deliveredToolMode = active ? (existing?.toolMode ?? config.toolMode) : config.toolMode;
	if (outcome.pendingNativeQuestion) {
		store.delete(key);
		deps.log?.("session-unbound-native-question", { conversation: outcome.conversationId }, "warn");
	} else if (outcome.conversationId) {
		if (existing?.conversationId && outcome.conversationId !== existing.conversationId) {
			store.delete(key);
		} else if (outcome.status === "OK" && !outcome.aborted) {
			store.set(key, {
				conversationId: outcome.conversationId,
				lastMessageCount: messageCount,
				...(deliveredCompactionHash ? { compactionHash: deliveredCompactionHash } : {}),
				...(deliveredToolMode === "pi-only" ? { toolMode: "pi-only" } : {}),
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
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const key = sessionKey(options, cwd);
		const isSummarization = isStandaloneSummarizationTurn(context, options);
		const sessionDeps = deps.resolveSessionDeps?.(key, context, options, isSummarization);
		if (sessionDeps) {
			void runTurnDriver(stream, model, context, options, entries, store, sessionDeps);
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
