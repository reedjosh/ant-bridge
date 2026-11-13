// pi Agent Skills catalog + activate_skill bridge.
//
// The MCP bridge exposes ONE `activate_skill` tool to agy whose JSON-schema
// enum is the catalog; the description carries each skill's one-liner so agy
// can tell when a skill applies. Calling it returns the full SKILL.md plus the
// bundled resource dir. Nothing is appended to the prompt: agy sees the
// catalog in tools/list on every spawn, including after pi compaction.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

export interface SkillLite {
	name: string;
	description: string;
	/** Absolute path to SKILL.md. */
	filePath: string;
	/** Absolute directory containing SKILL.md and bundled resources. */
	dir: string;
}

export interface SkillCommandLike {
	name?: string;
	description?: string;
	source?: string;
	sourceInfo?: {
		path?: string;
		baseDir?: string;
	};
}

/** Build the skill catalog from Pi's live `pi.getCommands()` entries, falling
 *  back to `fallback()` when no valid skill commands are present. */
export function skillsFromCommands(
	commands: readonly SkillCommandLike[],
	fallback?: () => SkillLite[],
): SkillLite[] {
	const seen = new Set<string>();
	const out: SkillLite[] = [];
	for (const c of commands ?? []) {
		if (!c || c.source !== "skill") continue;
		const filePath = typeof c.sourceInfo?.path === "string" ? c.sourceInfo.path : "";
		if (!filePath.trim()) continue;
		const rawName = typeof c.name === "string" ? c.name : "";
		const name = (rawName.startsWith("skill:") ? rawName.slice("skill:".length) : rawName).trim();
		if (!name || seen.has(name)) continue;
		const normalizedDesc =
			typeof c.description === "string" ? c.description.replace(/\s+/g, " ").trim() : "";
		if (!normalizedDesc) continue;
		const baseDir = typeof c.sourceInfo?.baseDir === "string" ? c.sourceInfo.baseDir.trim() : "";
		seen.add(name);
		out.push({
			name,
			description: normalizedDesc.slice(0, 160),
			filePath,
			dir: baseDir || path.dirname(filePath),
		});
	}
	return out.length > 0 ? out : (fallback?.() ?? []);
}

function stripYamlQuotes(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\nrt])/g, (_m, ch: string) => {
			if (ch === "n") return "\n";
			if (ch === "r") return "\r";
			if (ch === "t") return "\t";
			return ch;
		});
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

/** Parse `name:` / `description:` out of SKILL.md YAML frontmatter, including
 *  block scalars (`>`, `>-`, `|`, `|-`) and quoted strings. */
export function parseFrontmatter(raw: string): { name?: string; description?: string } {
	const cleaned = raw.replace(/^\uFEFF/, "");
	const m = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: { name?: string; description?: string } = {};
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = lines[i].match(/^(name|description):[ \t]*(.*)$/);
		if (!kv) continue;
		const key = kv[1] as "name" | "description";
		if (out[key]) continue;
		const rest = kv[2].trim();

		const cont: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const next = lines[j];
			if (next.trim() === "" || /^[ \t]+/.test(next)) {
				cont.push(next);
				j++;
			} else {
				break;
			}
		}
		while (cont.length > 0 && cont[0].trim() === "") cont.shift();
		while (cont.length > 0 && cont[cont.length - 1].trim() === "") cont.pop();

		const blockMatch = rest.match(/^([>|])([+-]?\d*)?(?:\s+#.*)?$/);
		let value = "";
		if (blockMatch) {
			if (cont.length > 0) {
				const style = blockMatch[1];
				const nonEmpty = cont.filter((l) => l.trim().length > 0);
				const minIndent = Math.min(
					...nonEmpty.map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0),
				);
				const dedented = cont.map((l) => (l.length >= minIndent ? l.slice(minIndent) : ""));
				if (style === "|") {
					value = dedented.join("\n");
				} else {
					const paragraphs: string[] = [];
					let cur: string[] = [];
					for (const dl of dedented) {
						if (dl.trim() === "") {
							if (cur.length > 0) {
								paragraphs.push(cur.join(" "));
								cur = [];
							}
						} else {
							cur.push(dl.trim());
						}
					}
					if (cur.length > 0) paragraphs.push(cur.join(" "));
					value = paragraphs.join("\n");
				}
			}
		} else if (rest === "") {
			if (cont.length > 0) {
				value = stripYamlQuotes(cont.map((l) => l.trim()).filter(Boolean).join(" ")).trim();
			}
		} else if (cont.length > 0) {
			const joined = [rest, ...cont.map((l) => l.trim()).filter(Boolean)].join(" ");
			value = stripYamlQuotes(joined).trim();
		} else {
			value = stripYamlQuotes(rest).trim();
		}

		if (value) out[key] = value;
		i = j - 1;
	}
	return out;
}

// The rest of this module mirrors pi's own skill discovery (pi docs
// "docs/skills.md - Locations") so the bridge's activate_skill catalog
// matches the [Skills] list pi shows in its system prompt:
//
// - Global: ~/.pi/agent/skills (pi style) and ~/.agents/skills (agents style,
//   the cross-harness standard).
// - Project: .pi/skills (pi style) and .agents/skills in cwd + ancestors up
//   to the git repo root (agents style).
// - Both styles discover every directory holding a SKILL.md, recursively;
//   grouping folders (no SKILL.md) are descended into and a skill's contents
//   are freeform (no descent past its SKILL.md).
// - pi style also treats root .md files as individual skills; agents style
//   ignores root .md but picks up frontmatter .md files inside grouping
//   folders.
// - Skills without a description are not loaded (same as pi).
// - Name collisions keep the first skill found, pi global dirs before
//   project dirs.

export type SkillStyle = "pi" | "agents";

export interface SkillLocation {
	dir: string;
	style: SkillStyle;
}

const MAX_DEPTH = 16; // symlink-loop insurance; real catalogs nest 1-2 levels

/** Ordered skill locations for a session: pi global dirs, then project dirs
 *  (project `.agents/skills` walks cwd ancestors up to the git root). */
export function skillLocations(projectDir?: string, home: string = os.homedir()): SkillLocation[] {
	const agentDir =
		home === os.homedir() && process.env.PI_CODING_AGENT_DIR?.trim()
			? process.env.PI_CODING_AGENT_DIR.trim()
			: path.join(home, ".pi", "agent");
	const out: SkillLocation[] = [
		{ dir: path.join(agentDir, "skills"), style: "pi" },
		{ dir: path.join(home, ".agents", "skills"), style: "agents" },
	];
	if (!projectDir) return out;
	out.push({ dir: path.join(projectDir, ".pi", "skills"), style: "pi" });
	let dir = path.resolve(projectDir);
	for (;;) {
		out.push({ dir: path.join(dir, ".agents", "skills"), style: "agents" });
		if (path.dirname(dir) === dir || fs.existsSync(path.join(dir, ".git"))) break;
		dir = path.dirname(dir);
	}
	return out;
}

function readSkillFile(file: string, fallbackName: string): SkillLite | null {
	let raw = "";
	try {
		// Strip a UTF-8 BOM so editors that add one do not break the `---` anchor.
		raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	} catch {
		return null;
	}
	const fm = parseFrontmatter(raw);
	const description = (fm.description ?? "").trim();
	// pi does not load skills without a description.
	if (!description) return null;
	return {
		name: fm.name?.trim() || fallbackName,
		description: description.replace(/\s+/g, " ").slice(0, 160),
		filePath: file,
		dir: path.dirname(file),
	};
}

function scanLocation(loc: SkillLocation): SkillLite[] {
	const walk = (dir: string, depth: number): SkillLite[] => {
		if (depth > MAX_DEPTH) return [];
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const found: SkillLite[] = [];
		for (const entry of entries) {
			// Hidden entries are harness internals (e.g. ~/.agents/skills/.system);
			// pi's own [Skills] list never includes them.
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			let isDir: boolean;
			try {
				isDir = entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(full).isDirectory());
			} catch {
				continue;
			}
			if (isDir) {
				if (fs.existsSync(path.join(full, "SKILL.md"))) {
					const skill = readSkillFile(path.join(full, "SKILL.md"), entry.name);
					if (skill) found.push(skill);
				} else {
					found.push(...walk(full, depth + 1));
				}
				continue;
			}
			if (!entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
			const standalone = loc.style === "pi" ? depth === 0 : depth > 0;
			if (!standalone) continue;
			const skill = readSkillFile(full, entry.name.replace(/\.md$/, ""));
			if (skill) found.push(skill);
		}
		return found;
	};
	return walk(loc.dir, 0);
}

/** pi-faithful skill catalog: every skill pi itself would load, deduped by
 *  name (first wins). `home` is injectable for tests. */
export function scanSkills(projectDir?: string, home: string = os.homedir()): SkillLite[] {
	const seen = new Set<string>();
	const out: SkillLite[] = [];
	for (const loc of skillLocations(projectDir, home)) {
		for (const skill of scanLocation(loc)) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			out.push(skill);
		}
	}
	return out;
}

export function findSkillByName(skills: SkillLite[], name: string): SkillLite | undefined {
	return skills.find((s) => s.name === name);
}

/** One-liner list for the tool description: `- name: description`. */
export function catalogSummary(skills: SkillLite[]): string {
	return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/** Full body handed to agy when it activates a skill. */
export function readSkillBody(skill: SkillLite): string {
	try {
		return fs.readFileSync(skill.filePath, "utf8");
	} catch (err) {
		return `failed to read skill: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** JSON schema for the activate_skill bridge tool. */
export function activateSkillSchema(skills: SkillLite[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			name: {
				type: "string",
				enum: skills.map((s) => s.name),
				description: "Skill name from the catalog in this tool's description.",
			},
		},
		required: ["name"],
	};
}
