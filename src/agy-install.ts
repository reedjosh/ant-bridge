import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface AgyInstallCommand {
	command: string;
	args: string[];
}

function executableSuffixes(platform: NodeJS.Platform): string[] {
	return platform === "win32" ? [".EXE"] : [""];
}

/** True when the `agy` CLI binary can be found as a file path or on PATH. */
export function isAgyInstalled(
	binRef: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (binRef.includes("/") || (platform === "win32" && binRef.includes("\\"))) {
		try {
			return fs.statSync(binRef).isFile();
		} catch {
			return false;
		}
	}
	let suffixes = executableSuffixes(platform);
	if (platform === "win32" && path.extname(binRef).toLowerCase() === ".exe") {
		suffixes = ["", ...suffixes];
	}
	return (env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.some((dir) =>
			suffixes.some((suffix) => {
				try {
					return fs.statSync(path.join(dir, binRef) + suffix).isFile();
				} catch {
					return false;
				}
			}),
		);
}

export function agyMissingMessage(): string {
	return "The `agy` CLI is not installed. Install it from https://antigravity.google/product/antigravity-cli and sign in to use Antigravity models.";
}

export function agyInstallCommand(platform: NodeJS.Platform = process.platform): AgyInstallCommand {
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				"irm https://antigravity.google/cli/install.ps1 | iex",
			],
		};
	}
	return {
		command: "bash",
		args: ["-c", "set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash"],
	};
}

export function agyAuthenticationMessage(): string {
	return "Run `agy` in your terminal and complete the Google sign-in. Restart pi afterwards.";
}

type InstallRunner = (
	command: AgyInstallCommand,
	timeoutMs: number,
) => Promise<{ code: number | null; output: string }>;

const defaultRunner: InstallRunner = ({ command, args }, timeoutMs) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let output = "";
		let settled = false;
		const append = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-64_000);
		};
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			reject(err);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", fail);
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			resolve({ code, output: output.trim() });
		});
		const watchdog = setTimeout(() => {
			try {
				if (child.pid && process.platform === "win32") {
					const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
						stdio: "ignore",
						windowsHide: true,
					});
					killer.on("error", () => {});
					killer.unref();
				} else if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// The process may have exited between the deadline and kill.
			}
			fail(new Error("Antigravity CLI installer exceeded 10 minutes"));
		}, timeoutMs);
	});

export async function installAgyCli(opts: {
	platform?: NodeJS.Platform;
	run?: InstallRunner;
	verify?: () => boolean | Promise<boolean>;
	timeoutMs?: number;
} = {}): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	try {
		const result = await (opts.run ?? defaultRunner)(
			agyInstallCommand(opts.platform),
			opts.timeoutMs ?? 10 * 60_000,
		);
		if (result.code !== 0) {
			return {
				ok: false,
				error: result.output || `installer exited with code ${result.code ?? "unknown"}`,
			};
		}
		const verify = opts.verify ?? (() => isAgyInstalled(process.env.AGY_BIN || "agy"));
		if (!(await verify())) {
			return {
				ok: false,
				error:
					"installer finished, but agy is not available in this pi process; open a new terminal, run `agy --version`, then restart pi",
			};
		}
		return { ok: true, output: result.output };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
