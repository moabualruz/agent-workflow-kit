---
name: workflow
description: Create, persist, and run an Agent Workflow Kit workflow in Antigravity.
---

# Workflow

Create, persist, and run a generated workflow through the shared CLI:

```sh
agent-workflow-kit workflow "<task>" --json
```

Use `--project-root "${AGENT_WORKFLOW_KIT_PROJECT_ROOT:-$PWD}"` when the active Antigravity workspace root is ambiguous.
