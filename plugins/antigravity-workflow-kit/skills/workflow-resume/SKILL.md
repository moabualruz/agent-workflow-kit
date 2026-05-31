---
name: workflow-resume
description: Resume an Agent Workflow Kit run record in Antigravity.
---

# Workflow Resume

Resume a stopped workflow record without deleting artifacts:

```sh
agent-workflow-kit workflow-resume <run-id> --json
```

Read `workflow-events` after resume to verify the `run:resumed` event.
