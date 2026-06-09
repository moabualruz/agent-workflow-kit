# Hermes Native Reference Implementation Plan

> **For Hermes:** Use focused implementation plus verification; this is a documentation and contract-test change, not a runtime feature.

**Goal:** Record Hermes Agent as native-reference-only so this repo does not imply a Hermes implementation pack is required.

**Architecture:** Keep Agent Workflow Kit focused on harnesses that need a shared workflow command surface. Treat Hermes Agent like Claude Code: native orchestration exists, so this repo documents it as a reference target and avoids shipping replacement shims.

**Tech Stack:** Markdown docs, Bun tests, TypeScript contract tests.

---

## Research Summary

- Repo README defines Agent Workflow Kit as orchestration for agent CLIs without native workflow support.
- Repo already treats Claude Code as native-reference-only because Claude Code has native Workflows.
- Hermes Agent docs describe native orchestration surfaces: `delegate_task` for short isolated subagent fan-out, `/background` for non-blocking prompts, Kanban for durable multi-profile collaboration, cron for scheduled runs, and skills for reusable procedures.
- Repo contract tests scan shipped files for forbidden protocol-server wording. New docs must avoid adding that vocabulary.

Sources:

- `README.md`
- `reference/claude-workflows/README.md`
- `tests/repo-contract.test.ts`
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills

## Task 1: Add Hermes Agent to README as native-reference-only

**Objective:** Make the support matrix answer the user question directly.

**Files:**

- Modify: `README.md`

**Steps:**

1. Update the opening description to say Claude Code stays on native Workflows and Hermes Agent stays on native orchestration surfaces.
2. Add a `Hermes Agent` row to `Supported Harnesses` with `Native reference only` pack status.
3. Keep Quick Start install commands limited to implementation packs.
4. Update the no-install paragraph to name both Claude Code and Hermes Agent.
5. Add a Hermes Agent row to `Harness UX Reality` describing native Hermes Agent surfaces.

**Verification:** `bun test tests/repo-contract.test.ts` should pass.

## Task 2: Add Hermes reference documentation

**Objective:** Preserve the decision in a reference doc without creating a pack.

**Files:**

- Create: `reference/hermes-agent-workflows/README.md`
- Modify: `reference/claude-workflows/README.md`

**Steps:**

1. Create a Hermes Agent reference README documenting native orchestration and no replacement pack.
2. List reference responsibilities: document observed behavior, preserve native Hermes behavior, avoid custom runtime/plugin/skill/command/tool shims.
3. Update the Claude reference final line from `non-Claude harness packs` to `non-native-reference harness packs`.

**Verification:** Contract tests should assert the Hermes reference README exists and plugin directories do not.

## Task 3: Update contract tests

**Objective:** Make the repo enforce the native-reference-only decision.

**Files:**

- Modify: `tests/repo-contract.test.ts`
- Modify: `tests/install-smoke-contract.test.ts`

**Steps:**

1. Rename implementation-pack test wording from `non-Claude` to `implementation harness`.
2. Generalize the Claude reference-only test to cover both Claude Code and Hermes Agent.
3. Assert no likely Hermes pack directories exist.
4. Assert the README contains a native-reference-only row for Hermes Agent.
5. Rename command-shim and install-smoke wording so it does not imply every non-Claude harness needs a pack.

**Verification:** Run targeted contract tests.

## Task 4: Verify and push

**Objective:** Ship a clean branch.

**Steps:**

1. Run `bun run typecheck`.
2. Run `bun test`.
3. Review `git diff --stat` and `git diff`.
4. Commit with conventional docs/test message.
5. Push branch to origin.

**Expected result:** Branch `docs/hermes-native-reference` pushed with README docs, reference docs, and passing tests.
