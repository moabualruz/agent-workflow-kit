Enable, disable, or report Agent Workflow Kit ultracode mode.

CLI fallback:

```sh
agent-workflow-kit ultracode on --json
agent-workflow-kit ultracode off --json
agent-workflow-kit ultracode status --json
```

Ultracode is an explicit, persisted project toggle (`.agent-workflow-kit/config.json`). Only enable it when the user asks. Return the resulting ultracode state only.
