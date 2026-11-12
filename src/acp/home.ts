import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeStateDir } from "../agy-paths.js";
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

function linkDirectory(source: string, target: string): void {
	fs.symlinkSync(source, target, "junction");
}

export function acpHomeStagingDir(): string {
	return path.join(bridgeStateDir(), "acp-homes");
}

/** Isolate `agy acp` from any stale `pi-bridge*` entries in ~/.gemini/config/mcp_config.json
 *  while linking ~/.gemini/antigravity-cli so OAuth credentials and brain conversations persist. */
export function stageAcpHome(opts: { geminiHome?: string; parentDir?: string } = {}): string {
	const geminiHome = opts.geminiHome ?? path.join(os.homedir(), ".gemini");
	const globalConfigDir = path.join(geminiHome, "config");
	const globalMcpPath = path.join(globalConfigDir, "mcp_config.json");
	let config: Record<string, unknown> = { mcpServers: {} };
	try {
		config = record(readGlobalMcpConfig(globalMcpPath), globalMcpPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(
				`Cannot isolate inherited MCP config ${globalMcpPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	const servers = record(config.mcpServers ?? {}, `${globalMcpPath} mcpServers`);
	const filtered = Object.fromEntries(
		Object.entries(servers).filter(([name]) => !/^pi-bridge(?:-\d+)?$/.test(name)),
	);

	const parentDir = opts.parentDir ?? acpHomeStagingDir();
	fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
	const staged = fs.mkdtempSync(path.join(parentDir, `acp-home-${process.pid}-`));
	try {
		fs.mkdirSync(path.join(staged, "config"), { mode: 0o700 });
		fs.writeFileSync(
			path.join(staged, "config", "mcp_config.json"),
			JSON.stringify({ ...config, mcpServers: filtered }),
			{ mode: 0o600 },
		);

		// Ensure the persistent antigravity-cli directory exists before symlinking so a brand-new
		// install never writes conversations or auth state inside the ephemeral staged directory.
		const appData = path.join(geminiHome, "antigravity-cli");
		fs.mkdirSync(appData, { recursive: true, mode: 0o700 });
		linkDirectory(appData, path.join(staged, "antigravity-cli"));

		const instructions = path.join(geminiHome, "GEMINI.md");
		if (fs.existsSync(instructions)) fs.copyFileSync(instructions, path.join(staged, "GEMINI.md"));
		if (fs.existsSync(globalConfigDir)) {
			for (const entry of fs.readdirSync(globalConfigDir, { withFileTypes: true })) {
				if (entry.name === "mcp_config.json") continue;
				const source = path.join(globalConfigDir, entry.name);
				const target = path.join(staged, "config", entry.name);
				let stat: fs.Stats | fs.Dirent = entry;
				if (entry.isSymbolicLink()) {
					try {
						stat = fs.statSync(source);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw err;
					}
				}
				if (stat.isDirectory()) linkDirectory(source, target);
				else if (stat.isFile()) fs.copyFileSync(source, target);
			}
		}
		return staged;
	} catch (err) {
		fs.rmSync(staged, { recursive: true, force: true });
		throw err;
	}
}

export function sweepStaleAcpHomes(
	baseDir: string = acpHomeStagingDir(),
	alive: (pid: number) => boolean = isPidAlive,
): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(baseDir);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = /^acp-home-(\d+)-/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		if (pid === process.pid || alive(pid)) continue;
		removeStagedAcpHome(path.join(baseDir, name));
	}
}

export function removeStagedAcpHome(staged: string): void {
	if (!path.basename(staged).startsWith("acp-home-")) return;
	try {
		if (!fs.lstatSync(staged).isDirectory()) return;
		fs.rmSync(staged, { recursive: true, force: true });
	} catch {
		// Connection teardown is best-effort; startup sweeps crash leftovers.
	}
}
