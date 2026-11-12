import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function findPiCodingAgentDist() {
  if (process.env.PI_CODING_AGENT_DIST) {
    return path.resolve(process.env.PI_CODING_AGENT_DIST);
  }
  const piBin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  let dir = path.dirname(fs.realpathSync(piBin));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "core/extensions/jiti-loader.js"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate Pi coding-agent dist from ${piBin}`);
}

function resolvePackageEntry(startDir, workspaceRelPath, pkgName) {
  const packagesRoot = path.resolve(startDir, "../..");
  const workspaceCandidate = path.join(packagesRoot, workspaceRelPath);
  if (fs.existsSync(workspaceCandidate)) return workspaceCandidate;

  let dir = startDir;
  while (true) {
    const pkgJsonPath = path.join(dir, "node_modules", pkgName, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      const exp = pkg.exports?.["."];
      const rel = typeof exp === "string" ? exp : exp?.import || exp?.default || pkg.main || "dist/index.js";
      return path.resolve(path.dirname(pkgJsonPath), rel);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve ${pkgName} from ${startDir}`);
}

const codingAgentDist = findPiCodingAgentDist();
const piExtDir = path.join(codingAgentDist, "core/extensions");
const piReq = createRequire(path.join(codingAgentDist, "index.js"));
const { createJiti } = await import(pathToFileURL(path.join(piExtDir, "jiti-loader.js")).href);

export const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": path.join(codingAgentDist, "index.js"),
    "@earendil-works/pi-agent-core": resolvePackageEntry(
      codingAgentDist,
      "agent/dist/index.js",
      "@earendil-works/pi-agent-core",
    ),
    "@earendil-works/pi-tui": resolvePackageEntry(codingAgentDist, "tui/dist/index.js", "@earendil-works/pi-tui"),
    "@earendil-works/pi-ai": path.join(piExtDir, "pi-ai-extension-view.js"),
    typebox: piReq.resolve("typebox"),
    "typebox/compile": piReq.resolve("typebox/compile"),
    "typebox/value": piReq.resolve("typebox/value"),
  },
});

export function importBridgeModule(relPath) {
  return jiti.import(path.join(repoRoot, relPath));
}
