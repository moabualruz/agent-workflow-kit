# Agent Workflow Kit

Harness-native workflow tools for agent CLIs.

Goal: make supported non-Claude agent harnesses expose Claude Workflows-like orchestration through their native plugin, extension, command, skill, or MCP surfaces.

Claude Code already has native Workflows. This repo uses Claude only as the reference behavior documented in `reference/claude-workflows`; it does not ship a Claude replacement plugin.

Supported implementation packs:

- Codex: `plugins/codex-workflow-kit`
- Gemini CLI: `plugins/gemini-workflow-kit`
- OpenCode: `plugins/opencode-workflow-kit`
- Grok Build: `plugins/grok-workflow-kit`
- Pi: `plugins/pi-workflow-kit`

Shared runtime package:

- `packages/core`

Current parity contract:

- JavaScript workflow scripts with `agent`, `phase`, `parallel`, `pipeline`, `workflow`, `log`, and return values
- saved workflow names
- append-like progress events
- child workflow phase records
- failed-run state stored independently from process exit status
- permission policy hooks for dynamic workflow execution

Development gates:

```sh
bun run typecheck
bun test
```
