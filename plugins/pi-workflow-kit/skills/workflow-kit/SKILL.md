---
name: workflow-kit
description: Use Agent Workflow Kit workflow commands in Pi.
---

# Workflow Kit

Use registered commands and tools to run workflows. Fallback to the shared CLI:

```sh
agent-workflow-kit workflow-run no-write-probe --json
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-resume <run-id> --json
agent-workflow-kit workflow-stop <run-id> --json
agent-workflow-kit workflows --json
agent-workflow-kit deep-research "<question>" --json
```

Persist run metadata with the host session APIs when available.
