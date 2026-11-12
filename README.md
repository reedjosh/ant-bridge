# ant-bridge

ACP model provider and loopback MCP/skill bridge for Pi (`@earendil-works/pi-coding-agent` >= 1.5).

`ant-bridge` connects Pi to the `agy` CLI over stdio JSON-RPC (`agy acp`), registers models under the `antigravity`
provider, and exposes Pi's extension, MCP, codemode, subagent, and skill surfaces over a per-session `127.0.0.1`
Streamable HTTP MCP server (`pi-bridge`). It does not register extra Pi tools, wrap core file/shell tools, or write to
shared global MCP config files.

## Prerequisites

1. Pi >= 1.5 (`pi --version`).
2. `agy` >= 1.5.3 on `PATH` and signed in (`agy --version`, then `agy` once to sign in if needed).

## Install and update

Install directly from GitHub via Pi's package manager:

```sh
pi install git:github.com/reedjosh/ant-bridge
```

Update to the latest commit at any time:

```sh
pi update
```

If you previously installed `@estebanforge/pi-antigravity-bridge`, remove it first so two extensions do not register
the same `antigravity` provider:

```sh
pi remove npm:@estebanforge/pi-antigravity-bridge
```

## Usage

Switch models interactively inside Pi:

```text
/model antigravity/gemini-4-carbon
```

Or set a default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "antigravity",
  "defaultModel": "gemini-4-carbon"
}
```

## How tool bridging works

- **Workspace tools stay native:** `agy acp` executes file reads/edits, search, and shell commands directly in its own
  runtime. Core Pi file/shell builtins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) are excluded from the
  MCP bridge so tools are never duplicated.
- **Pi 1.5 extension and MCP tools bridge automatically:** Active Pi extension tools (including `builtin:codemode`,
  `builtin:mcp`, `builtin:tool-search`, `pi-subagents`, and PR tracking tools) are served over a loopback `127.0.0.1`
  MCP endpoint (`pi-bridge`) authenticated with a per-session random header token (`x-bridge-token`).
- **Skills:** Pi Agent Skills are exposed via `activate_skill` on `pi-bridge`.
- **Long-running tool escalation:** Calls that exceed their foreground window (120s for `subagent` and `codemode`, 20s
  for other bridged tools) return a `STILL RUNNING` handle that resolves via `bridge_poll_result` without hitting
  transport timeouts.
- **Session persistence:** Each `agy acp` subprocess runs with a staged `HOME` under
  `<agentDir>/antigravity-bridge/acp-homes/` whose `antigravity-cli` state directory symlinks back to
  `~/.gemini/antigravity-cli`, isolating MCP configuration per session while preserving conversation state across
  restarts.

## Commands

Run `/agy` inside Pi to open the settings picker, or pass a subcommand:

- `/agy` or `/agy settings` - interactive configuration picker (`bridgeTools`, timeouts, permission mode, digest).
- `/agy doctor` - check `agy` binary version, authentication, active session binding, and loopback MCP server status.
- `/agy tools` - inspect which Pi tools are exposed over `pi-bridge` (`default` or `hide` per tool).
- `/agy tasks` - inspect background task logs in the bound conversation directory.
- `/agy artifacts` - browse artifacts written in the bound conversation directory.
- `/agy quota` - display model quota status from `agy usage`.
- `/agy clear` - clear the conversation binding for the current Pi session so the next turn starts fresh.

Configuration and session bindings are stored under `~/.pi/agent/antigravity-bridge/` (or
`$PI_CODING_AGENT_DIR/antigravity-bridge/`).

## Development

```sh
npm install
npm test
```

Peer packages (`@earendil-works/*` and `typebox`) are resolved from the host Pi installation and intentionally omitted
from `node_modules`.

## License

MIT. Forked from `@estebanforge/pi-antigravity-bridge` 1.10.4 and focused down to an ACP-only provider and Pi 1.5
loopback MCP bridge.
