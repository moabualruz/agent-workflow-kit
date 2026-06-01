# Ultracode & Multi-Phase Orchestration

Canonical guidance shared across every harness pack. Keep the marked block below
in sync with the per-pack SKILL/command copies.

<!-- AGENT_WORKFLOW_KIT_ULTRACODE_START -->
## Ultracode & multi-phase orchestration

Authoring and running a workflow spins up many subagents and spends real tokens. Author a workflow only when the user typed "workflow"/"workflows", asked for multi-agent orchestration, when **ultracode** is on, when a skill or command instructed it, or when the user named a saved workflow. Otherwise act directly or offer a workflow and let the user opt in.

**Ultracode** is an explicit, persisted project toggle (`agent-workflow-kit ultracode on|off|status`, stored in `.agent-workflow-kit/config.json`) — never ambient. When on, it makes that opt-in standing: author and run a workflow for every substantive task by default, biasing toward adversarial verification (refute -> vote -> converge) over a single pass. A standalone CLI cannot set a host model's reasoning-effort signal; ultracode here is behavior, not a model toggle. Turn it on only when the user asks; when off, revert to the opt-in gate.

For larger work, decompose into a **sequence** of workflows (understand -> design -> implement -> review), inspecting each run with `workflow-status` / `workflow-events` between phases rather than one giant run.
<!-- AGENT_WORKFLOW_KIT_ULTRACODE_END -->

Example sequence:

```sh
# 1. understand
agent-workflow-kit workflow "map how subsystem X works" --json
# inspect the run, then drive the next phase
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-events <run-id> --json

# 2. design → 3. implement → 4. review, each its own workflow / workflow-run
agent-workflow-kit workflow "design the change to X based on the findings" --json
```
