# Agent Workflow Kit

Harness-native workflow tools for agent CLIs.

Goal: make supported non-Claude agent harnesses expose Claude Workflows-like orchestration through native plugins/extensions using commands, skills, CLI tool calls, script calls, and hooks where useful.

Claude Code already has native Workflows. This repo uses Claude only as the reference behavior documented in `reference/claude-workflows`; it does not ship a Claude replacement plugin.

Supported implementation packs:

- Codex: `plugins/codex-workflow-kit` with skills that call the shared CLI
- Gemini CLI: `plugins/gemini-workflow-kit`
- OpenCode: `plugins/opencode-workflow-kit`
- Grok Build: `plugins/grok-workflow-kit`
- Pi: `plugins/pi-workflow-kit` with registered commands/tools

Shared runtime package:

- `packages/core`
- `createWorkflowCommandService()` for CLI, command, skill, script-call, and extension adapters

Current parity contract:

- JavaScript workflow scripts with `agent`, `phase`, `parallel`, `pipeline`, `workflow`, `log`, and return values
- per-agent model override forwarding and event persistence
- saved workflow names from `.agent-workflow-kit/workflows/<name>.js` with `.claude/workflows/<name>.js` compatibility fallback
- append-like progress events through `workflow-events <run-id>`
- artifact paths for each persisted run (`run.json` and `events.jsonl`)
- child workflow phase records
- failed-run state stored independently from process exit status
- permission policy hooks and CLI `--permission-mode dontAsk|bypassPermissions` for dynamic workflow execution

Development gates:

```sh
bun run typecheck
bun test
```
