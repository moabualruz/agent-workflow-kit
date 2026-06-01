# Agent Workflow Kit

[![Release](https://img.shields.io/github/v/release/moabualruz/agent-workflow-kit?sort=semver)](https://github.com/moabualruz/agent-workflow-kit/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](package.json)

Claude Workflows-style orchestration for agent CLIs that do not have native workflow support.

Agent Workflow Kit gives Codex, Gemini CLI, OpenCode, Grok Build, Pi, and Antigravity a shared workflow command set while leaving Claude Code on its native Workflows implementation. It is a standalone open-source toolkit: one TypeScript core, one CLI, and thin harness-native plugin, extension, skill, or command packs.

## Why Use It

- Write one persistent JavaScript workflow and run it from multiple agent harnesses.
- Keep workflow state on disk with `run.json` and `events.jsonl` artifacts.
- Use familiar commands: `workflow`, `workflow-run`, `workflow-status`, `workflow-events`, `workflow-resume`, `workflow-stop`, `workflows`, and `deep-research`.
- Preserve Claude-style workflow behavior where it matters: phases, agents, parallel work, pipelines, child workflows, structured args, model aliases, and permission modes.
- Avoid protocol-server coupling. The project ships skills, commands, script calls, native tool handlers, and a CLI only.

## Supported Harnesses

| Harness | Pack | Surface |
|---|---|---|
| Claude Code | Native reference only | Uses Claude Code Workflows directly; no replacement plugin is shipped |
| Codex | `plugins/codex-workflow-kit` | Codex plugin skill that calls the shared CLI |
| Gemini CLI | `plugins/gemini-workflow-kit` | Gemini extension commands |
| OpenCode | `plugins/opencode-workflow-kit` | OpenCode native plugin and command files |
| Grok Build | `plugins/grok-workflow-kit` | Command files that call the shared CLI |
| Pi | `plugins/pi-workflow-kit` | Pi commands, skills, prompt templates, and registered tools |
| Antigravity CLI | `plugins/antigravity-workflow-kit` | One skill per shared command |

## Quick Start

Agent Workflow Kit currently installs from a cloned checkout because one repository contains several harness-specific packs.

```sh
git clone --branch v0.1.0 https://github.com/moabualruz/agent-workflow-kit.git
cd agent-workflow-kit
bun install
bun link --global
```

Install the pack for the harnesses you use:

```sh
codex plugin marketplace add .
codex plugin add codex-workflow-kit@agent-workflow-kit

gemini extensions install plugins/gemini-workflow-kit --consent --skip-settings

opencode plugin "$PWD/plugins/opencode-workflow-kit" --global --force

grok plugin install "$PWD/plugins/grok-workflow-kit" --trust

pi install "$PWD/plugins/pi-workflow-kit"

agy plugin install plugins/antigravity-workflow-kit
```

Claude Code needs no install from this repo. It already owns native Workflows, and this project treats Claude behavior as the compatibility target.

## First Workflow

Create a persistent workflow from a task prompt:

```sh
agent-workflow-kit workflow "review the pull request and summarize risks" --json
```

Run it later by name:

```sh
agent-workflow-kit workflow-run review-the-pull-request-and-summarize-risks --json
```

Run a hand-written workflow file with structured input:

```sh
agent-workflow-kit workflow-run scripts/workflows/release-check.workflow.js \
  --args-json '{"target":"v0.2.0","mode":"review-only"}' \
  --json
```

Inspect the run:

```sh
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-events <run-id>
```

## Workflow File Shape

Workflows can be normal JavaScript modules:

```js
export default async function reviewAndFix({ args, agent, phase, parallel, log }) {
  phase("Review");
  const findings = await agent(`Review ${args.target} for defects`, { model: "sonnet" });

  phase("Fix Plan");
  const [tests, docs] = await parallel([
    () => agent("Find the smallest test plan", { model: "haiku" }),
    () => agent("Find documentation updates", { model: "haiku" }),
  ]);

  log("Review complete");
  return { findings, tests, docs };
}
```

Claude-style saved workflow bodies are also supported:

```js
export const meta = {
  name: "release-check",
  description: "Review release readiness",
  phases: [{ title: "Check" }]
};

phase("Check");
const result = await agent(`Check release ${args.target}`, { model: "sonnet" });
return { result };
```

## Workflow Discovery

`workflow-run <name>` resolves workflow files in this order:

1. `.agent-workflow-kit/workflows/<name>.js`
2. `.claude/workflows/<name>.js`
3. `scripts/workflows/<name>.workflow.js`
4. direct `.js` script paths
5. personal `~/.claude/workflows/<name>.js` fallback

Project files win over personal files so repositories can keep deterministic workflow behavior.

## Command Reference

| Command | Purpose |
|---|---|
| `workflow "<task>"` | Generate and save a persistent workflow under `.agent-workflow-kit/workflows/` |
| `workflow-run <name-or-path>` | Execute a saved workflow name or direct JavaScript file path |
| `workflow-status <run-id>` | Read the persisted run status and result |
| `workflow-events <run-id>` | Stream the append-like workflow event log |
| `workflow-resume <run-id>` | Resume a resumable workflow run |
| `workflow-stop <run-id>` | Request cancellation for a workflow run |
| `workflows` | List saved project workflows |
| `deep-research "<topic>"` | Generate a research workflow for a topic |

Common flags:

| Flag | Purpose |
|---|---|
| `--project-root <path>` | Use another project as the workflow root |
| `--args-json '<json>'` | Pass structured args into `context.args` and Claude-style `args` |
| `--permission-mode dontAsk` | Deny dynamic workflow execution unless explicitly allowed |
| `--permission-mode bypassPermissions` | Allow dynamic workflow execution |
| `--model-alias alias=provider/model` | Resolve Claude-style aliases such as `opus`, `sonnet`, or `haiku` |
| `--json` | Print machine-readable output |

## Model Alias Policy

The core keeps `requestedModel` and resolved `model` in workflow events. Aliases can be provided per command:

```sh
agent-workflow-kit workflow-run release-check \
  --model-alias sonnet=opencode-go/qwen3.6-plus \
  --model-alias haiku=opencode/deepseek-v4-flash-free \
  --json
```

Or through the environment:

```sh
export AGENT_WORKFLOW_KIT_MODEL_ALIASES="sonnet=opencode-go/qwen3.6-plus,haiku=opencode/deepseek-v4-flash-free"
```

Smoke-test defaults:

| Harness | `opus` | `sonnet` | `haiku` |
|---|---|---|---|
| OpenCode | `opencode-go/deepseek-v4-pro` | `opencode-go/qwen3.6-plus` | `opencode/deepseek-v4-flash-free` |
| Pi | `openai-codex/gpt-5.5` | `openai-codex/gpt-5.3-codex` | `opencode/deepseek-v4-flash-free` |

Pi may use OpenCode or Grok models as fallback candidates when needed. OpenCode defaults stay limited to OpenCode Zen/OpenCode Go, subscription-allowed, and free models.

## Persistence And Artifacts

Each run is stored under:

```text
.agent-workflow-kit/runs/<run-id>/
├── run.json
└── events.jsonl
```

`run.json` holds final status, result, error, and artifact paths. `events.jsonl` records phases, agent starts, agent completions, permission decisions, child workflow records, failures, and cancellation signals.

## Security Model

- No external protocol servers are shipped by this repository.
- Dynamic workflow execution is mediated by the permission policy.
- `dontAsk` fails closed for dynamic execution.
- `bypassPermissions` is explicit and visible in command history.
- Workflow state is local to the project root unless `--project-root` points elsewhere.
- Generated runtime data lives under `.agent-workflow-kit/`, which is ignored by git.

## Architecture

The shared runtime lives in `packages/core`:

| Module | Responsibility |
|---|---|
| `domain.ts` | Workflow domain types and runtime interfaces |
| `store.ts` | In-memory and file-backed run/event persistence |
| `runtime.ts` | Workflow execution semantics |
| `execution-limits.ts` | Per-run agent count and concurrency gates |
| `workflow-authoring.ts` | Generated workflow names and project workflow file writes |
| `saved-workflows.ts` | Saved workflow lookup and script loading |
| `command-service.ts` | Application service for workflow commands |
| `command-catalog.ts` | Public command/tool registry, argument mapping, and native input schemas |
| `model-policy.ts` | Model alias resolution before harness adapter calls |

Adapters stay thin: CLI, skills, commands, and native plugin handlers all dispatch through the shared command catalog.

## Development

```sh
bun install
bun run typecheck
bun test
bun run install-smoke
bun run headless-smoke
```

`bun run headless-smoke` performs a dry-run command and materialization check. `bun run headless-smoke:live` executes harness CLIs and may consume model credits.

## Release Status

Current release: `v0.1.0`.

The repository is usable as a local install today. APIs and harness pack shapes may change before `v1.0.0`, but the core contract is intentionally small: persistent workflows, shared commands, file-backed events, explicit permissions, and harness-native adapters.

## Contributing

Contributions are welcome for new harness packs, better install automation, parity probes, and documentation. Keep new behavior in `packages/core` when multiple harnesses need it; keep harness directories as thin adapters. Do not add external protocol servers to this repo.

Before opening a PR, run:

```sh
bun run typecheck
bun test
bun run install-smoke
```

## License

MIT. See [LICENSE](LICENSE).
