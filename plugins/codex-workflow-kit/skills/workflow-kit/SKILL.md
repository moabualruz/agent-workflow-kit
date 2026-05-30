---
name: workflow-kit
description: Run, inspect, resume, and stop Agent Workflow Kit workflows from Codex.
---

# Workflow Kit

Use this skill when the user asks for workflow orchestration, `/workflow`, `/workflows`, `/workflow-run`, `/workflow-status`, `/workflow-events`, `/workflow-resume`, `/workflow-stop`, or `/deep-research`.

Use the shared CLI or script calls directly:

```sh
agent-workflow-kit workflow-run no-write-probe --json
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-events <run-id> --json
agent-workflow-kit workflow-resume <run-id> --json
agent-workflow-kit workflow-stop <run-id> --json
agent-workflow-kit workflows --json
agent-workflow-kit deep-research "<question>" --json
```

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

Return run ids and artifact paths, not full intermediate transcripts.
