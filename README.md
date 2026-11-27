# ant-bridge

ACP model provider and loopback MCP bridge for Pi (`@earendil-works/pi-coding-agent` >= 1.5).

`ant-bridge` connects Pi to `agy` over stdio JSON-RPC (`agy acp`) and registers models under the `antigravity`
provider. It serves Pi extensions, MCP tools, codemode, subagents, and skills over a local `127.0.0.1` HTTP MCP server
(`pi-bridge` and per-server `pi-bridge-<server>` routes). It does not add extra Pi tools, wrap core file or shell
tools, or write to shared global MCP config files.

## Prerequisites

1. Pi >= 1.5 (`pi --version`).
2. `agy` >= 1.5.3 on `PATH` and signed in. Run `agy --version` to verify, and run `agy` once if you need to sign in.

## Install and update

Install from GitHub with Pi's package manager:

```sh
pi install git:github.com/reedjosh/ant-bridge
```

Update installed extensions to the latest commit, or update `ant-bridge` on its own:

```sh
pi update --extensions
# or update only ant-bridge:
pi update git:github.com/reedjosh/ant-bridge
```

## Usage

Switch models inside Pi:

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

`agy acp` runs file reads, edits, search, and shell commands in its own runtime. `ant-bridge` excludes core Pi file and
shell builtins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) from the bridge so tools never appear twice.

Active Pi extension tools bridge onto `pi-bridge`. This includes `builtin:codemode`, `builtin:mcp`,
`builtin:tool-search`, `pi-subagents`, and PR tracking tools. Direct Pi MCP tools (`mcp__<server>__<tool>`) bridge onto
per-server `pi-bridge-<server>` routes over `127.0.0.1` HTTP. Each session authenticates requests with a random
`x-bridge-token` header.

When the active tool catalog changes between turns, `ant-bridge` restarts `agy acp` and reloads the bound session with
`session/load`. This happens after `tool_search` loads deferred tools, `/mcp` changes server state, `/agy bridge` or
`/agy tools` updates scope, or `/reload` runs. `agy` picks up the new routes and schemas without losing conversation
history.

Pi Agent Skills bridge through `activate_skill` on `pi-bridge`. `ant-bridge` reads skills live from `pi.getCommands()`
so package, settings, project, and `/reload` changes appear right away, with a filesystem `scanSkills` fallback.

Streaming turns show live token counts in the Pi status bar. When ACP reports native usage, the footer shows
`ACP <in> in (+<cached> cached) / <out> out`. For client-side estimates, it shows `ACP ~ <in> in / <out> out`. The
footer stays hidden while all counts are zero.

Bridged calls that outlast their foreground window return a `STILL RUNNING` handle instead of timing out. The window is
120s for `subagent` and `codemode`, and 20s for other bridged tools. `agy` then polls `bridge_poll_result` until the
call finishes.

Each `agy acp` subprocess runs with a staged `HOME` under `<agentDir>/antigravity-bridge/acp-home/`. Its
`antigravity-cli` state directory symlinks to `~/.gemini/antigravity-cli`, which isolates MCP config while keeping
conversation state across restarts.

### MCP server exposure

Pi 1.5 controls how servers in `~/.pi/agent/mcp.json`, `.pi/mcp.json`, or `/mcp` reach the model:

- `"exposure": "direct"` (recommended for daily servers): Pi declares each tool directly, and `ant-bridge` exposes the
  server on its own `pi-bridge-<server>` route. Eager tools appear as `mcp_pi-bridge-<server>_<tool>`, and large
  catalogs marked `Lazy:` run through `call_mcp_tool`. Calls render as `<server>/<tool>` rows in Pi. You can also
  promote individual tools on a large server with `"toolExposure"`.
- `"exposure": "codemode"` (Pi default): Pi does not declare individual MCP tools. `agy` reaches them through
  `codemode` (`searchTools`, `describeNamespace`, `tools.mcp__<server>__<tool>`) to batch or filter calls in one
  script.
- `"exposure": "deferred"`: Tools stay undeclared until `tool_search` loads them into Pi's active catalog. On the next
  turn, `ant-bridge` restarts `agy acp`, reloads the bound session, and exposes the loaded tools on
  `pi-bridge-<server>`.

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "exposure": "direct"
    }
  }
}
```

## Commands

Run `/agy` inside Pi to open the settings picker (or print status in non-TUI modes), or pass a subcommand:

| Command | Description |
| --- | --- |
| `/agy` | Open the settings picker (`bridgeTools`, timeouts, permission mode, usage estimate, digest). |
| `/agy doctor` | Check the `agy` binary version, active `bound conversation`, driver stats (`spawns`, `turns`, `recycles`), and loopback MCP server status. |
| `/agy bridge all\|mcp\|none` | Update bridged tool scope live. Switching from `none` to `all` or `mcp` starts the loopback `pi-bridge` server without `/reload`. |
| `/agy tools [hide\|show <name>\|reset]` | Inspect or toggle which Pi tools `pi-bridge` exposes, with tab completion over `pi.getAllTools()`. |
| `/agy tasks [tail <id>]` | Browse background task logs in the bound conversation directory (`Enter` tails the last 40 lines, `r` rescans), with tab completion on task IDs. |
| `/agy artifacts [open <n\|name>]` | Browse or open artifacts in the bound conversation directory, with tab completion on artifact filenames. |
| `/agy quota` | Show model quota status from `agy usage`. |
| `/agy clear [all]` | Clear the conversation binding for the current Pi session, or pass `all` to clear persisted bindings across every Pi session. |

Configuration and session bindings live under `~/.pi/agent/antigravity-bridge/` (or
`$PI_CODING_AGENT_DIR/antigravity-bridge/`).

## Development

```sh
npm install
npm test
```

Peer packages (`@earendil-works/*` and `typebox`) resolve from the host Pi installation and stay out of `node_modules`.

## License

MIT. See [LICENSE](./LICENSE).
