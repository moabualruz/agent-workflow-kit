---
name: workflow
description: Run an ad hoc Agent Workflow Kit workflow in Antigravity.
---

# Workflow

Run an ad hoc no-write workflow through the shared CLI:

```sh
agent-workflow-kit workflow "<task>" --json
```

Use `--project-root "${AGENT_WORKFLOW_KIT_PROJECT_ROOT:-$PWD}"` when the active Antigravity workspace root is ambiguous.
