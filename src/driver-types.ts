// Turn-driver contract implemented by `AcpDriver` (`src/acp/driver.ts`).

export type DriverState = "idle" | "starting" | "ready" | "running" | "dead";

export interface DriverProfile {
	cwd: string;
	model: string;
	effort?: string;
	mode: string;
	skipPermissions: boolean;
}

export interface DriverTurnRequest extends DriverProfile {
	/** Existing ACP sessionId to resume via `session/load` (falls back to `session/new`). */
	conversationId?: string | null;
	prompt: string;
	/** Image blocks forwarded as typed ACP content blocks. */
	images?: Array<{ data: string; mimeType: string }>;
	/** Pi-side context delivered as a native `embeddedContext` resource block. */
	contextBlock?: { uri: string; text: string };
	signal?: AbortSignal;
	/** Overall turn cap in minutes (0 disables). */
	timeoutMin?: number;
	/** Inactivity cap in minutes (0 disables). */
	inactivityMin?: number;
}

export type AgyUsage = {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
};

/** Map agy usage onto pi-ai's Usage (cost stays zero: subscription quota). */
export function toPiUsage(
	u: AgyUsage | undefined,
	piUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): void {
	if (!u) return;
	piUsage.input = u.input_tokens ?? piUsage.input;
	piUsage.output = u.output_tokens ?? piUsage.output;
	piUsage.cacheRead = u.cache_read_tokens ?? piUsage.cacheRead;
	piUsage.totalTokens = u.total_tokens ?? piUsage.input + piUsage.output;
}

export type DriverActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; tokens?: number; delta?: string }
	| {
			type: "tool_start";
			name: string;
			args: Record<string, unknown>;
			mcpServer?: string;
			toolCallId?: string;
	  }
	| {
			type: "tool_done";
			name: string;
			args: Record<string, unknown>;
			mcpServer?: string;
			toolCallId?: string;
			output?: string;
			durationSeconds?: number;
			diff?: { path: string; oldText?: string; newText: string };
	  }
	| {
			type: "tool_error";
			name: string;
			message: string;
			mcpServer?: string;
			toolCallId?: string;
	  }
	| { type: "usage"; usage: AgyUsage }
	| { type: "bridge_call"; callId: string; name: string; args: Record<string, unknown> };

export interface TurnOutcome {
	conversationId?: string;
	status: "OK" | "ERROR" | "UNKNOWN";
	response: string;
	error?: string;
	usage?: AgyUsage;
	finished: boolean;
	aborted: boolean;
}

export interface TurnHandle {
	id: string;
	/** Resolves when the turn settles. */
	outcome: Promise<TurnOutcome>;
	/** Pull the next activity. Resolves null once the activity stream closes. */
	next(): Promise<DriverActivity | null>;
	/** Inject a synthetic activity (bridge inbox). No-op after settle. */
	pushExternal(activity: DriverActivity): void;
}

export interface DriverSnapshot {
	state: DriverState;
	pid?: number;
	conversationId?: string;
	stats: {
		spawns: number;
		turns: number;
		reused: number;
		recycles: number;
		lastRecycleReason?: string;
		recycleReasons: Record<string, number>;
	};
	lifecycle: string[];
	engine?: "acp";
	acp?: {
		sessionId?: string;
		prompts: number;
		sessionsCreated: number;
		sessionsLoaded: number;
		kills: number;
		serverVersion?: string;
		reconnects: number;
		agentName?: string;
		agentTitle?: string;
		usageSeen: boolean;
	};
}

export interface TurnDriver {
	readonly state: DriverState;
	readonly activeHandle: TurnHandle | null;
	run(request: DriverTurnRequest): Promise<TurnHandle>;
	/** Re-attach to the active turn (Pi toolUse continuation). */
	reentry(): TurnHandle | null;
	/** Resume turn timers after a parked bridge round-trip settles. */
	kickIdle(): void;
	set onTurnEnd(fn: ((outcome: TurnOutcome) => void) | undefined);
	snapshot(): DriverSnapshot;
	close(reason: "recycle" | "shutdown", cause?: string): Promise<void>;
}
