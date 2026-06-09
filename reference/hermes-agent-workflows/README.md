# Hermes Agent Workflows Reference

Hermes Agent already ships native orchestration support.

Agent Workflow Kit does not replace or wrap Hermes Agent workflows. Hermes Agent is recorded as a native reference harness; no Agent Workflow Kit implementation pack is shipped for it.

Reference responsibilities:

- document observed Hermes Agent behavior
- keep black-box probe scripts for parity research when needed
- avoid custom Hermes Agent runtime, plugin, skill, command, or tool shims
- preserve native Hermes Agent orchestration behavior as observed

Native Hermes Agent surfaces to preserve:

- `delegate_task` for short isolated subagent fan-out
- `/background` for non-blocking ad hoc prompts
- Kanban for durable multi-profile collaboration
- cron for scheduled runs
- skills for reusable procedures

All implementation work belongs in non-native-reference harness packs.
