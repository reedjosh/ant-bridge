# Changelog

## 2.0.0 - 2026-11-12

Focused `ant-bridge` fork from `@estebanforge/pi-antigravity-bridge` 1.10.4:

- **ACP-only provider:** Removed legacy `stream-json` CLI engine, first-run engine picker, `AskAntigravity` tool,
  `agy_web_search` / `agy_read_url` tools, `WrapperReplay` dummy tool, shadow `bash`/`write`/`edit` tool overrides,
  hook scripts, and global `~/.gemini/config/mcp_config.json` mutations.
- **Pi 1.5 tool and codemode bridging:** Read live tool schemas and loadout descriptions dynamically via
  `getCurrentTools()` from `@earendil-works/pi-ai` and include `builtin:codemode`, `builtin:mcp`, and
  `builtin:tool-search` in `bridgeTools` (`all` and `mcp` modes) while excluding core file/shell builtins. Give
  `codemode` the same 120s escalation window as `subagent`.
- **Prompt and turn fixes:** Scan past trailing `custom_message` entries (such as `pr-tracker` status blocks) when
  extracting the latest user prompt, attached images, and context digest. Suppress redundant background-task wakeups
  when all tasks already finished during the turn.
- **Fresh-install conversation persistence:** Ensure `~/.gemini/antigravity-cli` exists before staging per-session ACP
  homes so first-run conversations persist across session cleanup.
- **Minimal dependency footprint:** Replaced `@estebanforge/pi-ask-shared` and `@estebanforge/pi-tui-dialogs` with
  native `@earendil-works/pi-tui` `SettingsList` components, leaving `@modelcontextprotocol/sdk` as the sole runtime
  dependency.
