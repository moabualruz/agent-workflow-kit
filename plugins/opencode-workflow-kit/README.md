# OpenCode Workflow Kit

OpenCode plugin pack for Agent Workflow Kit.

Native surfaces:

- npm/local plugin using `@opencode-ai/plugin`
- Markdown commands under `commands/`
- plugin tools for stateful workflow operations
- hooks for permission and session events

## Permissions

OpenCode resolves permissions to `allow`, `ask`, or `deny`. This plugin exposes the normal custom tool names (`workflow`, `workflow_run`, `workflow_status`, `workflow_events`, `workflow_resume`, `workflow_stop`, `workflows`, `deep_research`, `ultracode`) and also asks the host for the dynamic workflow execution permission `agent-workflow-kit.workflow` before a workflow body runs.

Example `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "workflow": "ask",
    "workflow_run": "ask",
    "agent-workflow-kit.workflow": {
      "*": "ask",
      "workflow:no-write-probe": "allow",
      "write:worktree": "ask"
    }
  }
}
```

Use `deny` for `workflow`, `workflow_run`, or `agent-workflow-kit.workflow` to block generated or saved workflow execution.
