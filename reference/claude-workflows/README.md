# Claude Workflows Reference

Claude Code already ships native Workflows.

Agent Workflow Kit does not replace or wrap Claude Workflows. Claude is the compatibility baseline used to verify behavior for other harness packs.

Reference responsibilities:

- keep black-box probe scripts for parity research
- document observed Claude behavior
- avoid custom Claude runtime, plugin, or command shims
- preserve native `/workflows`, `/deep-research`, saved workflows, stop, and resume behavior

All implementation work belongs in non-Claude harness packs.
