Run the requested Agent Workflow Kit workflow.

Use plugin tools when available. CLI fallback:

```sh
agent-workflow-kit workflow-run no-write-probe --json
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-resume <run-id> --json
agent-workflow-kit workflow-stop <run-id> --json
agent-workflow-kit workflows --json
agent-workflow-kit deep-research "<question>" --json
```

Return only run id, status, and artifact path.
