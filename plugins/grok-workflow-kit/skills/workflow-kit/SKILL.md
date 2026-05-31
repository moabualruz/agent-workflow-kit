---
name: workflow-kit
description: Use Agent Workflow Kit workflow commands in Grok Build.
---

# Workflow Kit

Use plugin commands, CLI tool calls, or script calls to run workflows. Keep intermediate transcripts in artifacts.

CLI fallback:

```sh
agent-workflow-kit workflow "<task>" --json
agent-workflow-kit workflow-run no-write-probe --json
agent-workflow-kit workflow-run <workflow> --args-json '{"key":"value"}' --json
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-events <run-id> --json
agent-workflow-kit workflow-resume <run-id> --json
agent-workflow-kit workflow-stop <run-id> --json
agent-workflow-kit workflows --json
agent-workflow-kit deep-research "<question>" --json
```

Saved workflow scripts read structured args from `context.args`.
Generated workflow runs return `result.workflow.name` and `result.workflow.path` for later `workflow-run`.

Executable smoke:

```sh
run_json="$(agent-workflow-kit workflow-run no-write-probe --json)"
run_id="$(printf '%s' "$run_json" | bun -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync(0, "utf8")); console.log(data.runId);')"
printf '%s\n' "$run_json"
agent-workflow-kit workflow-status "$run_id" --json
agent-workflow-kit workflow-events "$run_id" --json
agent-workflow-kit workflow-resume "$run_id" --json
agent-workflow-kit workflow-stop "$run_id" --json
agent-workflow-kit workflows --json
agent-workflow-kit deep-research "file-command-smoke" --json
```
