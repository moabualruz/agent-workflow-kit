Show Agent Workflow Kit workflow progress events.

CLI fallback:

```sh
agent-workflow-kit workflow-events <run-id> --json
agent-workflow-kit workflow-events <run-id> --follow
```

Use `--follow` for event-driven updates until terminal status; with `--json`, it prints JSONL.

Return only progress events and artifact path.
