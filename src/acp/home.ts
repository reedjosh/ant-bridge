import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeStateDir } from "../agy-paths.js";
import { PI_BRIDGE_SERVER_RE } from "../bridge-catalog.js";
import { isPidAlive } from "../mcp-server.js";

type McpConfig = { mcpServers: Record<string, unknown> };

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return value as Record<string, unknown>;
}

/** Tolerant read of global mcp_config.json: strips a UTF-8 BOM and treats a
 *  fresh-install 0-byte file as empty config. Missing files throw ENOENT. */
export function readGlobalMcpConfig(file: string): McpConfig {
	const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	const parsed = raw.trim() === "" ? { mcpServers: {} } : JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("mcp_config.json is not an object");
	}
	return parsed as McpConfig;
}

let tmpSeq = 0;

function writeFileAtomic(target: string, content: string, mode: number): void {
	const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
	try {
		fs.writeFileSync(tmp, content, { mode });
		if (process.platform !== "win32") fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Best-effort cleanup of temp file.
		}
		throw err;
	}
}

function copyFileAtomic(source: string, target: string): void {
	try {
		if (fs.lstatSync(target).isDirectory()) {
			fs.rmSync(target, { recursive: true, force: true });
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
	try {
		fs.copyFileSync(source, tmp);
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Best-effort cleanup of temp file.
		}
		throw err;
	}
}

function ensureDirectoryLink(source: string, target: string): void {
	const resolvedSource = path.resolve(source);
	try {
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink()) {
			const existing = fs.readlinkSync(target);
			if (path.resolve(path.dirname(target), existing) === resolvedSource) {
				return;
			}
		} else if (stat.isDirectory()) {
			fs.rmSync(target, { recursive: true, force: true });
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
	try {
		fs.symlinkSync(resolvedSource, tmp, "junction");
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Best-effort cleanup of temp symlink.
		}
		throw err;
	}
}

function removeEntry(entryPath: string): void {
	try {
		if (fs.lstatSync(entryPath).isDirectory()) {
			fs.rmSync(entryPath, { recursive: true, force: true });
		} else {
			fs.unlinkSync(entryPath);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

export function acpHomeDir(baseDir: string = bridgeStateDir()): string {
	return path.join(baseDir, "acp-home");
}

export function acpHomeStagingDir(baseDir: string = bridgeStateDir()): string {
	return path.join(baseDir, "acp-homes");
}

export interface StageAcpHomeOptions {
	geminiHome?: string;
	parentDir?: string;
	stagingDir?: string;
}

/** Isolate `agy acp` from any stale `pi-bridge*` entries in ~/.gemini/config/mcp_config.json
 *  while linking ~/.gemini/antigravity-cli so OAuth credentials, brain conversations, and
 *  artifact/transcript file:// links persist across reloads and restarts. */
export function stageAcpHome(opts: StageAcpHomeOptions = {}): string {
	const geminiHome = opts.geminiHome ?? path.join(os.homedir(), ".gemini");
	const globalConfigDir = path.join(geminiHome, "config");
	const globalMcpPath = path.join(globalConfigDir, "mcp_config.json");
	let config: Record<string, unknown> = { mcpServers: {} };
	try {
		config = record(readGlobalMcpConfig(globalMcpPath), globalMcpPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`Cannot isolate inherited MCP config ${globalMcpPath}: ${detail}`);
		}
	}
	const servers = record(config.mcpServers ?? {}, `${globalMcpPath} mcpServers`);
	const filtered = Object.fromEntries(
		Object.entries(servers).filter(([name]) => !PI_BRIDGE_SERVER_RE.test(name)),
	);

	const baseDir = opts.parentDir ?? opts.stagingDir ?? bridgeStateDir();
	const staged = acpHomeDir(baseDir);
	const stagedConfigDir = path.join(staged, "config");
	fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
	fs.mkdirSync(stagedConfigDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		fs.chmodSync(staged, 0o700);
		fs.chmodSync(stagedConfigDir, 0o700);
	}

	writeFileAtomic(
		path.join(stagedConfigDir, "mcp_config.json"),
		JSON.stringify({ ...config, mcpServers: filtered }),
		0o600,
	);

	// Ensure the persistent antigravity-cli directory exists before symlinking so a brand-new
	// install always writes conversations and auth state inside ~/.gemini/antigravity-cli.
	const appData = path.join(geminiHome, "antigravity-cli");
	fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
	sweepStaleChildMcpDirs(path.join(appData, "mcp"));
	ensureDirectoryLink(appData, path.join(staged, "antigravity-cli"));

	const instructions = path.join(geminiHome, "GEMINI.md");
	const stagedInstructions = path.join(staged, "GEMINI.md");
	let hasInstructions = false;
	try {
		hasInstructions = fs.statSync(instructions).isFile();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (hasInstructions) {
		copyFileAtomic(instructions, stagedInstructions);
	} else {
		removeEntry(stagedInstructions);
	}

	const keepConfigEntries = new Set<string>(["mcp_config.json"]);
	if (fs.existsSync(globalConfigDir)) {
		for (const entry of fs.readdirSync(globalConfigDir, { withFileTypes: true })) {
			if (entry.name === "mcp_config.json") continue;
			const source = path.join(globalConfigDir, entry.name);
			const target = path.join(stagedConfigDir, entry.name);
			let stat: fs.Stats | fs.Dirent = entry;
			if (entry.isSymbolicLink()) {
				try {
					stat = fs.statSync(source);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw err;
				}
			}
			if (stat.isDirectory()) {
				ensureDirectoryLink(source, target);
				keepConfigEntries.add(entry.name);
			} else if (stat.isFile()) {
				copyFileAtomic(source, target);
				keepConfigEntries.add(entry.name);
			}
		}
	}
	for (const existing of fs.readdirSync(stagedConfigDir)) {
		if (keepConfigEntries.has(existing) || /\.\d+\.\d+\.tmp$/.test(existing)) continue;
		removeEntry(path.join(stagedConfigDir, existing));
	}

	return staged;
}

function sweepLegacyAcpHomesDir(homesDir: string, alive: (pid: number) => boolean): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(homesDir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === "acp-home") continue;
		const match = /^acp-home-(\d+)-/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
		removeStagedAcpHome(path.join(homesDir, name));
	}
}

export function sweepStaleChildMcpDirs(
	mcpDir: string,
	alive: (pid: number) => boolean = isPidAlive,
): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(mcpDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = /^pi-bridge-s(\d+)(?:-|$)/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
		const target = path.join(mcpDir, name);
		try {
			if (!fs.lstatSync(target).isDirectory()) continue;
			fs.rmSync(target, { recursive: true, force: true });
		} catch {
			// Best-effort sweep of dead child subagent MCP schema directory.
		}
	}
}

export function sweepStaleAcpHomes(
	stateDir: string = bridgeStateDir(),
	alive: (pid: number) => boolean = isPidAlive,
): void {
	if (path.basename(stateDir) === "acp-homes") {
		sweepLegacyAcpHomesDir(stateDir, alive);
		return;
	}

	const legacyHomesDir = acpHomeStagingDir(stateDir);
	sweepLegacyAcpHomesDir(legacyHomesDir, alive);
	try {
		fs.rmdirSync(legacyHomesDir);
	} catch {
		// Missing or still holds live acp-home-* entries.
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(stateDir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === "acp-home") continue;
		const match = /^agy-mcp-(\d+)$/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
		const target = path.join(stateDir, name);
		try {
			if (!fs.lstatSync(target).isDirectory()) continue;
			fs.rmSync(target, { recursive: true, force: true });
		} catch {
			// Best-effort sweep of legacy 1.x per-PID MCP directory.
		}
	}
}

export function removeStagedAcpHome(staged: string): void {
	const name = path.basename(staged);
	if (name !== "acp-home" && !name.startsWith("acp-home-")) return;
	try {
		if (!fs.lstatSync(staged).isDirectory()) return;
		fs.rmSync(staged, { recursive: true, force: true });
	} catch {
		// Explicit cleanup and startup sweeps are best-effort.
	}
}
