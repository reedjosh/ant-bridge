// Persisted map: pi session key -> agy conversation id + message watermark.
//
// agy holds its own conversation history in the DB keyed by conversation id.
// To resume a multi-turn pi conversation, we thread the same agy id across
// streamSimple calls and track the pi-side message count watermark.
//
// The key is options.sessionId when pi provides it, else the cwd (single-
// conversation-per-process fallback). Stored at
// ~/.pi/agent/antigravity-bridge/sessions.json with atomic rename.

import fs from "node:fs";
import path from "node:path";
import { bridgeStateDir } from "./agy-paths.js";
import { isPidAlive } from "./mcp-server.js";

let tmpSeq = 0;
const pathChains = new Map<string, Promise<void>>();

function defaultStorePath(): string {
	return path.join(bridgeStateDir(), "sessions.json");
}

function deepestExistingAncestor(dirPath: string): string {
	let cur = path.resolve(dirPath);
	while (!fs.existsSync(cur)) {
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return cur;
}

export interface AgySession {
	conversationId: string;
	/** pi context.messages length captured at the start of the last agy turn.
	 *  Used by the provider to compute a delta digest of pi-side context agy
	 *  was not spawned for (compaction summaries, other-provider turns). 0 on a
	 *  fresh or pre-watermark session. Optional for backward compat with older
	 *  persisted sessions that predate the watermark. */
	lastMessageCount?: number;
	/** Hash of the latest Pi compaction summary seen when this conversation was
	 *  bound or updated. When Pi compacts the session, the hash changes (or
	 *  appears), signaling provider.ts to start a fresh ACP session seeded with
	 *  the compacted summary instead of resuming the uncompacted ACP session. */
	compactionHash?: string;
}

type StoreMap = Record<string, AgySession>;

/** Narrow untrusted parsed JSON into a clean StoreMap, validating each entry's
 *  shape instead of trusting the whole structure (the cast previously let a
 *  hand-edited or corrupt file plant wrong-typed fields into the cache).
 *  Drops any entry whose `conversationId` isn't a string; falls back to 0 when
 *  `lastMessageCount` is missing or not a finite number; ignores legacy keys
 *  such as `lastStepIdx`. Returns {} for non-object input. */
function narrowStoreMap(parsed: unknown): StoreMap {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const clean: StoreMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const conversationId = (value as { conversationId?: unknown }).conversationId;
		if (typeof conversationId !== "string") continue;
		const mc = (value as { lastMessageCount?: unknown }).lastMessageCount;
		const ch = (value as { compactionHash?: unknown }).compactionHash;
		clean[key] = {
			conversationId,
			lastMessageCount: typeof mc === "number" && Number.isFinite(mc) ? mc : 0,
			...(typeof ch === "string" && ch.length > 0 ? { compactionHash: ch } : {}),
		};
	}
	return clean;
}

/** Atomic-write JSON session store. Writes are serialized through a promise
 *  chain so concurrent turns or same-process instances can't interleave renames.
 *
 *  Multi-process safety: persist() re-reads the file fresh and overlays only
 *  the keys this instance has dirtied since load, so two pi processes editing
 *  different sessions never clobber each other. (Whole-file overwrite from a
 *  stale in-memory snapshot was the previous behavior - last writer won.) */
export class SessionStore {
	private readonly path: string;
	private cache: StoreMap = {};
	private readonly dirty = new Set<string>();
	private readonly removed = new Set<string>();
	private writeChain: Promise<void> = Promise.resolve();

	constructor(storePath: string = defaultStorePath()) {
		this.path = storePath;
		this.load();
	}

	private sweepStaleTemps(): void {
		const dir = path.dirname(this.path);
		const prefix = `${path.basename(this.path)}.`;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (!name.startsWith(prefix)) continue;
			const match = /^(\d+)(?:\.\d+)?\.tmp$/.exec(name.slice(prefix.length));
			if (!match) continue;
			const pid = Number(match[1]);
			if (!Number.isSafeInteger(pid) || pid <= 0) continue;
			if (pid === process.pid || isPidAlive(pid)) continue;
			try {
				fs.unlinkSync(path.join(dir, name));
			} catch {
				// Ignore concurrent sweep or permission errors.
			}
		}
	}

	private load(): void {
		this.sweepStaleTemps();
		try {
			const raw = fs.readFileSync(this.path, "utf8");
			this.cache = narrowStoreMap(JSON.parse(raw));
		} catch {
			// missing or corrupt - start empty. The first set() will create it.
			this.cache = {};
		}
	}

	private enqueue(task: (anchor: string, dirExisted: boolean) => Promise<void>): void {
		const resolvedDir = path.resolve(path.dirname(this.path));
		const anchor = deepestExistingAncestor(resolvedDir);
		const dirExisted = anchor === resolvedDir;
		const key = path.resolve(this.path);
		const prev = pathChains.get(key) ?? this.writeChain;
		const next = prev
			.then(() => task(anchor, dirExisted))
			.catch(() => {
				/* swallow; next write retries */
			});
		this.writeChain = next;
		const tracked = next.finally(() => {
			if (pathChains.get(key) === tracked) {
				pathChains.delete(key);
			}
		});
		pathChains.set(key, tracked);
	}

	get(key: string): AgySession | null {
		const s = this.cache[key];
		if (!s || typeof s.conversationId !== "string") return null;
		return {
			conversationId: s.conversationId,
			lastMessageCount: s.lastMessageCount ?? 0,
			...(s.compactionHash ? { compactionHash: s.compactionHash } : {}),
		};
	}

	/** Update one session and persist atomically (temp file + rename). The
	 *  write is queued; callers can await flush() when durability is needed. */
	set(key: string, session: AgySession): void {
		const mc = session.lastMessageCount;
		const ch = session.compactionHash;
		this.cache[key] = {
			conversationId: session.conversationId,
			lastMessageCount: typeof mc === "number" && Number.isFinite(mc) ? mc : 0,
			...(typeof ch === "string" && ch.length > 0 ? { compactionHash: ch } : {}),
		};
		this.dirty.add(key);
		this.removed.delete(key);
		this.enqueue((anchor, dirExisted) => this.persist(anchor, dirExisted));
	}

	/** Drop one session binding and persist the deletion. Used when the driver
	 *  recreated the conversation under us: the record's watermark claims
	 *  history the new conversation never saw, and its bound id keeps the
	 *  sysPrompt gate closed. Dropping resets the watermark to 0 AND re-arms
	 *  the gate on the next turn (issue #1). The write is queued. */
	delete(key: string): void {
		delete this.cache[key];
		this.dirty.delete(key);
		this.removed.add(key);
		this.enqueue((anchor, dirExisted) => this.persist(anchor, dirExisted));
	}

	private async persist(anchor: string, dirExisted: boolean): Promise<void> {
		const dir = path.dirname(this.path);
		if (!dirExisted) {
			if (!fs.existsSync(anchor)) return;
			await fs.promises.mkdir(dir, { recursive: true });
		}

		// Re-read the current file so we merge against the latest on-disk state,
		// not our possibly-stale in-memory snapshot. Overlay only OUR dirty keys
		// so a concurrent process's writes to other keys survive.
		let disk: StoreMap = {};
		try {
			const raw = await fs.promises.readFile(this.path, "utf8");
			disk = narrowStoreMap(JSON.parse(raw));
		} catch {
			/* missing or corrupt - start from empty */
		}
		const merged: StoreMap = { ...disk };
		for (const key of this.dirty) {
			merged[key] = this.cache[key];
		}
		for (const key of this.removed) {
			delete merged[key];
		}

		const tmp = `${this.path}.${process.pid}.${++tmpSeq}.tmp`;
		try {
			await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", {
				mode: 0o600,
			});
			await fs.promises.rename(tmp, this.path);
		} catch (err) {
			try {
				await fs.promises.unlink(tmp);
			} catch {
				/* nothing to clean */
			}
			throw err;
		}
		this.dirty.clear();
		// Mirror dirty: once the deletion is durable, stop re-asserting it. A
		// later unrelated persist must not destroy a record another process
		// wrote for that key after our delete landed.
		this.removed.clear();
	}

	/** Wipe all session bindings (forces fresh agy conversations on every
	 *  active session). Used by the /agy clear command. */
	clear(): void {
		this.cache = {};
		this.dirty.clear();
		this.removed.clear();
		this.enqueue(async (anchor, dirExisted) => {
			if (!dirExisted) {
				if (!fs.existsSync(anchor)) return;
				await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
			}
			const tmp = `${this.path}.${process.pid}.${++tmpSeq}.tmp`;
			try {
				await fs.promises.writeFile(tmp, "{}\n", { mode: 0o600 });
				await fs.promises.rename(tmp, this.path);
			} catch (err) {
				try {
					await fs.promises.unlink(tmp);
				} catch {
					/* nothing to clean */
				}
				throw err;
			}
		});
	}

	/** Resolves once all queued writes on this store instance have settled. */
	flush(): Promise<void> {
		return this.writeChain.catch(() => {});
	}

	/** Count persisted session bindings (for status display). */
	get size(): number {
		return Object.keys(this.cache).length;
	}
}
