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
- Antigravity CLI: `plugins/antigravity-workflow-kit` with one skill per shared command

Shared runtime package:

- `packages/core`
- `createWorkflowCommandService()` for CLI, command, skill, script-call, and extension adapters
- `workflowCommandCatalog` as the single public command/tool registry
- `dispatchWorkflowCommand()` as the shared adapter boundary for CLI and native tools

Core module boundaries:

- `domain.ts`: workflow domain types and runtime interfaces
- `store.ts`: in-memory and file-backed run/event persistence
- `runtime.ts`: workflow execution semantics
- `execution-limits.ts`: per-run agent count and concurrency gates
- `workflow-authoring.ts`: generated workflow names and project workflow file writes
- `saved-workflows.ts`: saved workflow lookup and script loading
- `command-service.ts`: application service for workflow commands
- `command-catalog.ts`: public command names, tool names, descriptions, argument mapping, native tool input schema, and dispatch
- `model-policy.ts`: Claude-style model alias resolution before harness adapter calls

Current parity contract:

- JavaScript workflow scripts with `args`, `agent`, `phase`, `parallel`, `pipeline`, `workflow`, `log`, and return values
- Claude-style workflow script bodies with `export const meta`, top-level `phase()` / `agent()` calls, top-level `return`, and `workflow({ scriptPath }, args)` child calls
- per-agent model override forwarding and event persistence
- Claude-style model aliases through CLI `--model-alias alias=provider/model` or `AGENT_WORKFLOW_KIT_MODEL_ALIASES=alias=provider/model,...`, preserving `requestedModel` and resolved `model` in events
- Claude-style per-run agent limits: 16 concurrent agents and 1000 total agent calls by default
- saved workflow names from `.agent-workflow-kit/workflows/<name>.js`, project `.claude/workflows/<name>.js`, `scripts/workflows/<name>.workflow.js`, direct `.js` script paths, with personal `~/.claude/workflows/<name>.js` compatibility fallback; project files win over personal files
- `workflow "<task>"` writes `.agent-workflow-kit/workflows/<generated-name>.js` and returns that workflow name/path for later `workflow-run`
- structured workflow args through `workflow-run <workflow> --args-json '{"key":"value"}'`, exposed to scripts as `context.args`
- append-like progress events through `workflow-events <run-id>`
- artifact paths for each persisted run (`run.json` and `events.jsonl`)
- child workflow phase records
- failed-run state stored independently from process exit status
- permission policy hooks and CLI `--permission-mode dontAsk|bypassPermissions` for dynamic workflow execution

Model defaults used by smoke tests:

- OpenCode: `opus=opencode-go/deepseek-v4-pro`, `sonnet=opencode-go/qwen3.6-plus`, `haiku=opencode/deepseek-v4-flash-free`
- Pi: `opus=openai-codex/gpt-5.5`, `sonnet=openai-codex/gpt-5.3-codex`, `haiku=opencode/deepseek-v4-flash-free`
- Pi fallback-only candidates when needed: `opencode-go/deepseek-v4-pro`, `opencode-go/qwen3.6-plus`, `opencode-go/deepseek-v4-flash`, `opencode/grok-build-0.1`, `xai-auth/grok-4.3`, `xai-auth/grok-4.20-0309-reasoning`, `xai-auth/grok-4.20-0309-non-reasoning`

Development gates:

```sh
bun run typecheck
bun test
bun run install-smoke
bun run headless-smoke
```

`bun run headless-smoke` performs a dry-run command/materialization check. `bun run headless-smoke:live`
executes the harness CLIs and may consume model credits.
