# Agent Workflow Kit

[![Release](https://img.shields.io/github/v/release/moabualruz/agent-workflow-kit?sort=semver)](https://github.com/moabualruz/agent-workflow-kit/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](package.json)

Claude Workflows-style orchestration for agent CLIs that do not have native workflow support.

Agent Workflow Kit gives Codex, Gemini CLI, OpenCode, Grok Build, Pi, and Antigravity a shared workflow command set while leaving Claude Code on its native Workflows implementation. It is a standalone open-source toolkit: one TypeScript core, one CLI, and thin harness-native plugin, extension, skill, or command packs.

## Why Use It

- Write one persistent JavaScript workflow and run it from multiple agent harnesses.
- Keep workflow state on disk with `run.json` and `events.jsonl` artifacts.
- Use familiar commands: `workflow`, `workflow-run`, `workflow-status`, `workflow-events`, `workflow-resume`, `workflow-stop`, `workflows`, `deep-research`, and `ultracode`.
- Preserve Claude-style workflow behavior where it matters: phases, agents, barrier-free pipelines, error-isolated parallel fan-out, child workflows, structured args, model aliases, permission modes, journal-replay resume, and live cancellation.
- Avoid protocol-server coupling. The project ships skills, commands, script calls, native tool handlers, and a CLI only.

## Supported Harnesses

| Harness | Pack | Surface | Auto-invoke? |
|---|---|---|---|
| Claude Code | Native reference only | Uses Claude Code Workflows directly; no replacement plugin is shipped | Native |
| Codex | `plugins/codex-workflow-kit` | Skill that calls the shared CLI | Yes (skill) |
| Gemini CLI | `plugins/gemini-workflow-kit` | Command files | No (manual) |
| OpenCode | `plugins/opencode-workflow-kit` | Native plugin + command files | Yes (plugin tools) / manual (commands) |
| Grok Build | `plugins/grok-workflow-kit` | Command files **and** a skill | Yes (skill) / manual (commands) |
| Pi | `plugins/pi-workflow-kit` | Skill, registered commands + tools | Yes (skill) |
| Antigravity CLI | `plugins/antigravity-workflow-kit` | One skill per shared command | Yes (skill) |

## Quick Start

Agent Workflow Kit currently installs from a cloned checkout because one repository contains several harness-specific packs.

```sh
git clone https://github.com/moabualruz/agent-workflow-kit.git
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

## Two Install Paths: Commands vs Skills

Each harness pack ships its surfaces in two flavors, and you choose how much autonomy to grant:

- **Commands (manual)** — slash-commands you invoke explicitly (`/workflow`, `/deep-research`, `/ultracode`). The agent never starts a workflow or turns on ultracode on its own; nothing auto-fires. Choose this when you want the kit available but fully under your control. Gemini and OpenCode ship command files, and Grok ships them alongside its skill; every command maps 1:1 to a shared CLI call.
- **Skills (auto-invoke)** — skills carry trigger descriptions, so the agent may invoke them on its own when your request matches (e.g. you say "workflow"/"orchestrate" or ultracode is on). Choose this when you want the agent to reach for workflows proactively. Codex, Pi, Antigravity, and Grok ship skills. OpenCode additionally registers every command as a model-callable plugin tool, so its native-plugin surface is auto-invokable too.

Both paths call the same CLI and produce identical runs; the only difference is **who pulls the trigger**. To get the manual experience on a skills-based harness, install only the command files (skip the skills), or simply don't enable ultracode and invoke commands explicitly. Ultracode itself is always an explicit toggle (`agent-workflow-kit ultracode on`) regardless of path — see [Ultracode](#ultracode--multi-phase-orchestration).

### Harness UX Reality

The shared workflow UX is intentionally CLI-first and file-backed. Every harness can call the same command set and inspect the same run artifacts; only hosts with native extension APIs can render or approve more than that.

| Harness | Current UX |
|---|---|
| Codex | Skill-driven CLI calls; inspect progress with `workflow-status` / `workflow-events` |
| Gemini CLI | Command-file CLI calls; reload/install behavior is owned by Gemini |
| OpenCode | Native plugin tools plus command files; dynamic workflow execution asks OpenCode permission `agent-workflow-kit.workflow` and can be configured as `allow`, `ask`, or `deny` |
| Grok Build | Skill and command-file CLI calls; inspect progress with the shared CLI |
| Pi | Registered commands/tools plus a skill; tool calls return structured details, but rich session UI is host-owned |
| Antigravity CLI | Skill-driven CLI calls, one skill per shared command |

Agent Workflow Kit does not yet ship Claude-style live task panels or in-session progress trees for every harness. The matched surface today is command parity, persisted run state, progress projection, permission policy, transcript artifacts, and native tool registration where the host exposes it.

## First Workflow

Generate a persistent workflow from a task prompt and run it:

```sh
agent-workflow-kit workflow "review the pull request and summarize risks" --json
```

The generated workflow file is saved under `.agent-workflow-kit/workflows/` (its name and path are recorded on the run's `args.workflow`). Run it again later by name:

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

Machine-readable run output includes `runId`, `name`, `status`, `args`, `result` or `error`, `artifacts.root`, `artifacts.runJson`, `artifacts.eventsJsonl`, and `artifacts.transcriptDir`. Human `workflow-status` output summarizes result/error, progress, `run.json`, and transcript location without dumping raw transcript text.

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

## Workflow Semantics

The runtime mirrors Claude Workflows so the same workflow body behaves the same way here:

- **`agent(prompt, options?)`** runs one subagent. Every call is recorded in the run journal with its `requestedModel`, resolved `model`, prompt, result, and token estimate. Calls pass through the agent execution gate, which counts them for observability — no concurrency cap is imposed (the host harness owns real limits).
- **`parallel(thunks)`** is a barrier: it awaits every thunk before returning. A thunk that throws (or whose agent errors) resolves to `null` in the result array — the call itself never rejects — so callers can `.filter(Boolean)` instead of wrapping each thunk in `try/catch`.
- **`pipeline(items, ...stages)`** runs each item through all stages independently, with **no barrier between stages**: item A can be in stage 3 while item B is still in stage 1. Wall-clock is the slowest single-item chain, not the sum of the slowest stage per step. Each stage receives `(previousResult, originalItem, index)`. A stage that throws drops that item to `null` and skips its remaining stages.
- **`workflow(request, args?)`** runs a child workflow inline; it is recorded as a child phase and shares the parent's agent counter (the call-counting gate), execution-order sequence, abort signal, budget, and replay journal. Its `agent()` calls join the parent's single cross-scope replay stream, so resume invalidates one global prefix across parent and child alike.
- **Host-owned limits by default.** Agent Workflow Kit does not cap concurrency, agent count, tokens, or time unless the caller explicitly supplies a runtime limit policy such as `--max-agent-calls` / `--max-concurrent-agents`. `parallel()` fires all its thunks at once by default; the harness decides real concurrency. `budget` is **observability only** (read `budget.spent()` / `budget.remaining()` to self-pace) and never blocks or throws.

### Resume

`workflow-resume <run-id>` re-runs the workflow with the original run's args and replays the **longest unchanged prefix** of `agent()` calls from that run's journal. Calls are sequenced in global execution order across every scope — including child `workflow()` calls — so the prefix is a single stream, not one per scope. Each replayed call is matched by stable key + `(prompt, resolvedModel)`; a match returns the cached result instantly (recorded as an `agent:cached` event) without touching the adapter, and re-applies the original call's token estimate so `budget.spent()` is replay-stable. The first call that differs — a changed prompt, a changed model, or a new call inserted anywhere — and everything after it in execution order runs live. An identical script with identical args is a 100% cache hit. If the workflow file changed since the original run, resume still proceeds but records a `run:script-changed` warning; an empty journal records `run:resume-empty-journal` (a full live re-run).

### Stop

`workflow-stop <run-id>` flips the persisted status to `stopped` and, if the run is still in flight in the same runtime, fires its abort signal. The runtime checks the signal before each gated agent call, so a live run unwinds at the next `agent()` boundary and is persisted as `stopped` rather than `failed`. Live cancellation works when stop and run share a runtime — inside one session or a long-running host adapter; a one-shot CLI `workflow-run` that has already exited leaves only the persisted record to stop.

### Background execution

The runtime exposes `runDetached`, which returns the initial `running` handle immediately and executes the workflow in the background, writing the terminal status and a `run:notify` event to the store — pollable with `workflow-status` / `workflow-events`. This is meant for long-running host adapters that stay alive; a one-shot CLI process must remain alive for the background work to finish, so the CLI runs synchronously. A standalone CLI cannot inject a completion notification back into a live conversation or render the in-session `/workflows` progress tree — it matches the data model (phase groups, per-agent events, `log()` lines), not the host's live render.

<!-- AGENT_WORKFLOW_KIT_ULTRACODE_START -->
## Ultracode & multi-phase orchestration

Authoring and running a workflow spins up many subagents and spends real tokens. Author a workflow only when the user typed "workflow"/"workflows", asked for multi-agent orchestration, when the **ultracode** standing opt-in or keyword trigger applies, when a skill or command instructed it, or when the user named a saved workflow. Otherwise act directly or offer a workflow and let the user opt in.

**Ultracode** has three separate meanings in this kit. The standing opt-in is the persisted project behavior (`agent-workflow-kit ultracode on|off|status`, stored in `.agent-workflow-kit/config.json`) that author-runs a workflow for substantive tasks by default. The keyword trigger is recorded separately as `ultracodeKeywordTriggerEnabled` and is disabled when workflows are disabled. Model effort is host-owned: this standalone CLI reports model effort as unsupported and records `ultracodeEffortMode: "orchestration-only"` when orchestration is enabled. Turn ultracode on only when the user asks; when off, revert to the opt-in gate.

For larger work, decompose into a **sequence** of workflows (understand -> design -> implement -> review), inspecting each run with `workflow-status` / `workflow-events` between phases rather than one giant run.
<!-- AGENT_WORKFLOW_KIT_ULTRACODE_END -->

Full guidance lives in [`docs/ultracode.md`](docs/ultracode.md).

### Alignment with Claude Code

Agent Workflow Kit tracks [Claude Code's dynamic workflows + ultracode](https://code.claude.com/docs/en/workflows) ([announcement](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)) as its compatibility target. Feature-by-feature:

| Claude Code | Agent Workflow Kit | Status |
|---|---|---|
| `agent(prompt, opts)` with `schema`, `model`, `agentType`, `label`, `phase` | Same options; schema is validated with bounded retry over a JSON Schema **subset** (type/enum/const/required/properties/items + numeric/string/array bounds; `anyOf`/`oneOf`/`allOf`/`$ref`/`pattern`/`format` are not enforced — layer Ajv for full coverage) | ✅ Matches (subset) |
| `parallel()` barrier — failed thunk → `null`, never rejects | Same; abort re-raises so `stop()` halts a run | ✅ Matches |
| `pipeline()` — no barrier between stages, `(prev, item, index)` | Same | ✅ Matches |
| `workflow()` child workflows, one level of nesting | Same; grandchild `workflow()` throws | ✅ Matches |
| `budget` — read `spent()` / `remaining()` to self-pace | Same shape; optional explicit token limit can stop a run | ✅ Matches (see note) |
| Resume by prefix replay (`resumeFromRunId` / `scriptPath`) | Same; one global execution-order prefix across parent and child scopes, budget-stable replay, script-change warning | ✅ Matches |
| `phase()` / `log()` progress, persisted run + event log | Same; `run.json` + `events.jsonl` | ✅ Matches |
| Generated workflow authors a real plan (fan-out + verify) | `workflow` and `deep-research` orchestrate (plan→fan-out→synthesize; gather→refute→converge) | ✅ Matches |
| Ultracode: standing opt-in, author-per-task, verify-until-converge | Explicit `ultracode` toggle drives the same behavior in skills | ✅ Behavior; toggle is explicit |
| Concurrency cap `min(16, cores-2)`, 1000-agent lifetime cap | Host-owned by default; optional explicit runtime policy can fail closed with limit events | ⚠️ Configurable |
| xhigh reasoning-effort signal | Host model setting; a CLI cannot set it | ⛔ Out of scope |
| In-session live `/workflows` progress tree | Poll `workflow-status` / `workflow-events` instead | ⛔ Out of scope (data model matched) |
| `<task-notification>` injected into a live turn | `run:notify` event on a detached run; harness polls | ⛔ Out of scope |

Note on `budget`: Agent Workflow Kit keeps `budget.spent()` / `budget.remaining()` readable inside workflows. Host harnesses still own real provider limits by default; pass explicit CLI/runtime limits when you want local fail-closed policy.

## Workflow Discovery

`workflow-run <name-or-path>` resolves a workflow in this order:

1. a direct `.js` script path (absolute, or relative to the project root, when the reference looks like a path)
2. `.agent-workflow-kit/workflows/<name>.js`
3. `.claude/workflows/<name>.js`
4. `scripts/workflows/<name>.workflow.js`
5. personal `~/.claude/workflows/<name>.js` fallback
6. bundled built-in workflows (for example `no-write-probe`)

Project files win over the personal fallback so repositories can keep deterministic workflow behavior.

## Command Reference

| Command | Purpose |
|---|---|
| `workflow "<task>"` | Generate a persistent workflow under `.agent-workflow-kit/workflows/` and run it |
| `workflow-run <name-or-path>` | Execute a saved workflow name or direct JavaScript file path |
| `workflow-status <run-id>` | Read the persisted run status and result |
| `workflow-events <run-id>` | Stream the append-like workflow event log |
| `workflow-resume <run-id>` | Re-run a workflow, replaying the unchanged agent prefix from its journal |
| `workflow-stop <run-id>` | Cancel a workflow run, aborting it if still in flight |
| `workflows` | List persisted workflow runs |
| `deep-research "<topic>"` | Generate a gather/refute/converge research workflow and return a structured report with source ledger, claim ledger, contradiction checks, confidence table, and rejected claims |
| `ultracode <on\|off\|status>` | Explicitly enable, disable, or report ultracode mode (persisted to project config) |

Common flags:

| Flag | Purpose |
|---|---|
| `--project-root <path>` | Use another project as the workflow root |
| `--args-json '<json>'` | Pass any JSON value into `context.args` and Claude-style `args` (`object`, `array`, `string`, `number`, `boolean`, or `null`) |
| `--permission-mode <mode>` | One of `default`, `acceptEdits`, `plan`, `bypassPermissions`, or `dontAsk` (unknown values error with the allowed list). `plan`/`dontAsk` deny dynamic execution (fail closed); `default`/`acceptEdits`/`bypassPermissions` allow it |
| `--disable-workflows` | Disable dynamic workflow execution for this CLI session |
| `--resume-from-run-id <run-id>` | Run `workflow-run` through the same invocation path while replaying the prior run journal |
| `--model-alias alias=provider/model` | Resolve Claude-style aliases such as `opus`, `sonnet`, or `haiku` |
| `--session-model <model>` | Model inherited by `agent()` calls that omit `opts.model` |
| `--token-budget <n>` | Informational output-token target readable via `budget.*` (not enforced) |
| `--max-agent-calls <n>` | Fail closed when a run would exceed the explicit agent call limit |
| `--max-concurrent-agents <n>` | Fail closed when local concurrent agent execution would exceed the explicit limit |
| `--max-child-workflow-depth <n>` | Fail closed when child workflow nesting exceeds the explicit depth |
| `--max-estimated-tokens <n>` | Track estimated output tokens against an explicit local limit |
| `--stop-on-estimated-token-limit` | Stop the run when the estimated-token limit is exceeded instead of only recording a limit event |
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
| Pi | `opencode-go/deepseek-v4-pro` | `opencode-go/qwen3.6-plus` | `opencode/deepseek-v4-flash-free` |

Pi may use OpenCode or Grok models as fallback candidates when needed. OpenCode defaults stay limited to OpenCode Zen/OpenCode Go, subscription-allowed, and free models.

## Persistence And Artifacts

Each run is stored under:

```text
.agent-workflow-kit/runs/<run-id>/
├── run.json
├── events.jsonl
└── transcripts/
    └── <agent-call>.json
```

`run.json` holds final status, result, error, original args, progress summary, and artifact paths. `events.jsonl` records phases, logs, agent starts, agent completions, replayed (`agent:cached`) calls, permission decisions, child workflow records, limit events, failures, resume markers, and stop signals. `transcripts/` stores one compact JSON transcript per live or cached agent call.

## Security Model

- No external protocol servers are shipped by this repository.
- Dynamic workflow execution is mediated by the permission policy.
- Dynamic workflow execution can be disabled by managed policy, environment (`AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS=1` or `CLAUDE_CODE_DISABLE_WORKFLOWS=1`), user config, project config, or the session flag `--disable-workflows`; higher-priority controls win.
- `plan` and `dontAsk` fail closed for dynamic execution.
- `bypassPermissions` is explicit and visible in command history.
- OpenCode native tools additionally call `context.ask` for `agent-workflow-kit.workflow`; configure that permission as `allow`, `ask`, or `deny` in `opencode.json`.
- Workflow state is local to the project root unless `--project-root` points elsewhere.
- Generated runtime data lives under `.agent-workflow-kit/`, which is ignored by git.
- **Workflow files are trusted code.** Both plain `.js` workflows (run via `import()`) and Claude-style bodies (run via `node:vm`) execute with the privileges of the process. The `node:vm` layer is a determinism aid — it shadows `Date.now()`/`Math.random()`/`new Date()` so honest bodies can't accidentally break resume replay — **not** a security sandbox; it does not contain hostile code. Only run workflow files you trust, exactly as you would any script in the repo.

## Architecture

The shared runtime lives in `packages/core`:

| Module | Responsibility |
|---|---|
| `domain.ts` | Workflow domain types and runtime interfaces |
| `store.ts` | In-memory and file-backed run/event persistence |
| `runtime.ts` | Workflow execution semantics |
| `execution-limits.ts` | Optional local execution-limit policy for agent calls, concurrency, child workflow depth, and estimated tokens |
| `workflow-authoring.ts` | Generated workflow names and project workflow file writes |
| `saved-workflows.ts` | Saved workflow lookup and script loading |
| `command-service.ts` | Application service for workflow commands |
| `command-catalog.ts` | Public command/tool registry, argument mapping, and native input schemas |
| `model-policy.ts` | Model alias resolution before harness adapter calls |
| `permissions.ts` | Permission modes and dynamic-workflow authorization policies |
| `config.ts` | Project/user config, workflow disable hierarchy, and explicit ultracode toggle |
| `progress.ts` | Progress projection from persisted run events |
| `schema-validation.ts` | Zero-dependency JSON Schema subset validator for `agent()` schemas |
| `workflow-meta.ts` | Pure-literal `meta` block parser for Claude-style workflow bodies |

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

Current release: see the release badge and [GitHub Releases](https://github.com/moabualruz/agent-workflow-kit/releases).

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
