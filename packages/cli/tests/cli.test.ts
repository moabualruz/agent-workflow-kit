import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-workflow-kit cli", () => {
  test("workflow command runs an ad hoc workflow", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli(["workflow", "inspect repo", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    // Generate-then-run: the saved workflow file is what executes, so the run is
    // named for the generated workflow and returns the generated script result.
    expect(payload.name).toBe("inspect-repo");
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual(expect.objectContaining({ ok: true, task: "inspect repo" }));
  });

  test("workflow command persists generated workflow script for workflow-run", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const generated = await runCli(["workflow", "inspect repo", "--project-root", projectRoot, "--json"]);

    expect(generated.exitCode).toBe(0);
    const generatedPayload = JSON.parse(generated.stdout);
    // The generated workflow file is recorded on the run args and persisted to
    // disk so workflow-run can invoke it by name later.
    expect(generatedPayload.args.workflow).toEqual({
      name: "inspect-repo",
      path: join(projectRoot, ".agent-workflow-kit", "workflows", "inspect-repo.js"),
    });
    expect(existsSync(generatedPayload.args.workflow.path)).toBe(true);

    const rerun = await runCli(["workflow-run", generatedPayload.args.workflow.name, "--project-root", projectRoot, "--json"]);

    expect(rerun.exitCode).toBe(0);
    const rerunPayload = JSON.parse(rerun.stdout);
    expect(rerunPayload).toEqual(expect.objectContaining({ name: "inspect-repo", status: "completed" }));
    expect(rerunPayload.result).toEqual(expect.objectContaining({ ok: true, task: "inspect repo" }));
  });

  test("runs no-write-probe and prints machine-readable status", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({ ok: true });
    expect(readFileSync(join(projectRoot, ".agent-workflow-kit", "runs", payload.runId, "run.json"), "utf8")).toContain("completed");
  });

  test("permission-mode dontAsk records a denied workflow run as structured output", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli([
      "workflow-run",
      "no-write-probe",
      "--permission-mode",
      "dontAsk",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution denied by permission policy",
    }));
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("permission:denied");
    expect(readFileSync(payload.artifacts.runJson, "utf8")).toContain("\"status\": \"failed\"");
  });

  test("workflow-run executes project saved workflow files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "project-saved.js"), `
export default function ({ phase, log }) {
  phase("CLI Saved File");
  log("cli saved workflow entered");
  return { source: "cli-project" };
}
`);

    const result = await runCli(["workflow-run", "project-saved", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      name: "project-saved",
      status: "completed",
      result: { source: "cli-project" },
    }));
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("CLI Saved File");
  });

  test("workflow-run forwards structured args to saved workflow files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "args-probe.js"), `
export default function ({ args }) {
  return { args };
}
`);

    const result = await runCli([
      "workflow-run",
      "args-probe",
      "--args-json",
      "{\"tenantId\":\"tenant-1\"}",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      name: "args-probe",
      status: "completed",
      result: { args: { tenantId: "tenant-1" } },
    }));
  });

  test("workflow-run forwards list args from --args-json to saved workflow files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "list-args.js"), `
export default function ({ args }) {
  return { args };
}
`);

    const result = await runCli([
      "workflow-run",
      "list-args",
      "--args-json",
      "[\"1024\",\"1025\"]",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      name: "list-args",
      status: "completed",
      result: { args: ["1024", "1025"] },
    }));
  });

  test("workflow-run fails closed when environment disables workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli([
      "workflow-run",
      "no-write-probe",
      "--project-root",
      projectRoot,
      "--json",
    ], {
      AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS: "1",
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution disabled by environment",
    }));
  });

  test("workflow-run fails closed when the CLI session disables workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli([
      "workflow-run",
      "no-write-probe",
      "--disable-workflows",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution disabled by session override",
    }));
  });

  test("workflow-run executes direct workflow script paths", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const scriptPath = join(projectRoot, "cli-direct-path.js");
    writeFileSync(scriptPath, `
export default function ({ phase, log }) {
  phase("CLI Direct Path");
  log("cli direct path workflow entered");
  return { source: "cli-script-path" };
}
`);

    const result = await runCli(["workflow-run", scriptPath, "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      name: "cli-direct-path",
      status: "completed",
      result: { source: "cli-script-path" },
    }));
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("CLI Direct Path");
  });

  test("reads run status from persisted state", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const status = await runCli(["workflow-status", run.runId, "--project-root", projectRoot, "--json"]);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(expect.objectContaining({
      runId: run.runId,
      status: "completed",
      progress: expect.objectContaining({
        runId: run.runId,
        status: "completed",
        agentTotal: 1,
        agentDone: 1,
        phases: [expect.objectContaining({ title: "Probe", agentTotal: 1, agentDone: 1 })],
      }),
    }));
  });

  test("human workflow-status output surfaces progress and transcript location", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const status = await runCli(["workflow-status", run.runId, "--project-root", projectRoot]);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("progress: 1/1 agents done");
    expect(status.stdout).toContain("transcripts:");
    expect(status.stdout).toContain(join(projectRoot, ".agent-workflow-kit", "runs", run.runId, "transcripts"));
  });

  test("workflow-status --tree renders phase and agent drilldown", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const status = await runCli(["workflow-status", run.runId, "--project-root", projectRoot, "--tree"]);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`${run.runId} no-write-probe completed`);
    expect(status.stdout).toContain("actions: save");
    expect(status.stdout).toContain("phases:");
    expect(status.stdout).toContain("Probe 1/1 agents done");
    expect(status.stdout).toContain("#1");
    expect(status.stdout).toContain("completed");
    expect(status.stdout).toContain("Return exact JSON");
  });

  test("human ultracode output renders status summary and actions", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    await runCli(["ultracode", "on", "--project-root", projectRoot, "--json"]);

    const status = await runCli(["ultracode", "status", "--project-root", projectRoot]);

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Ultracode enabled");
    expect(status.stdout).toContain("summary: standing opt-in enabled");
    expect(status.stdout).toContain("actions: disable, inspect-config");
    expect(status.stdout).toContain(".agent-workflow-kit/config.json");
  });

  test("reads workflow events from persisted state", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const events = await runCli(["workflow-events", run.runId, "--project-root", projectRoot, "--json"]);

    expect(events.exitCode).toBe(0);
    expect(JSON.parse(events.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: run.runId, type: "run:started" }),
      expect.objectContaining({ runId: run.runId, type: "phase", title: "Probe" }),
      expect.objectContaining({ runId: run.runId, type: "run:completed" }),
    ]));
  });

  test("workflow-run --stream emits event lines without corrupting JSON stdout", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "stream-probe.js"), `
export default async function ({ phase, log, agent }) {
  phase("Streaming");
  log("stream-step");
  await agent("stream prompt", { label: "stream-agent" });
  return { streamed: true };
}
`);

    const result = await runCli(["workflow-run", "stream-probe", "--stream", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(expect.objectContaining({
      name: "stream-probe",
      status: "completed",
      result: { streamed: true },
    }));
    expect(result.stderr).toContain("run:started");
    expect(result.stderr).toContain("phase Streaming");
    expect(result.stderr).toContain("log stream-step");
    expect(result.stderr).toContain("agent:start");
    expect(result.stderr).toContain("label=stream-agent");
    expect(result.stderr).toContain("prompt=stream prompt");
    expect(result.stderr).toContain("run:completed");
  });

  test("workflow-events --follow streams JSONL events until terminal status", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const runId = "wf_followprobe";
    const runRoot = join(projectRoot, ".agent-workflow-kit", "runs", runId);
    const transcriptDir = join(runRoot, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    const artifacts = {
      root: runRoot,
      runJson: join(runRoot, "run.json"),
      eventsJsonl: join(runRoot, "events.jsonl"),
      transcriptDir,
    };
    writeFileSync(artifacts.runJson, `${JSON.stringify({
      runId,
      name: "follow-probe",
      status: "running",
      artifacts,
    }, null, 2)}\n`);
    writeFileSync(artifacts.eventsJsonl, `${JSON.stringify({ runId, type: "run:started", timestamp: "2026-06-03T00:00:00.000Z" })}\n`);

    setTimeout(() => {
      appendFileSync(artifacts.eventsJsonl, `${JSON.stringify({ runId, type: "log", message: "halfway", timestamp: "2026-06-03T00:00:00.050Z" })}\n`);
      appendFileSync(artifacts.eventsJsonl, `${JSON.stringify({ runId, type: "run:completed", result: { ok: true }, timestamp: "2026-06-03T00:00:00.100Z" })}\n`);
      writeFileSync(artifacts.runJson, `${JSON.stringify({
        runId,
        name: "follow-probe",
        status: "completed",
        artifacts,
        result: { ok: true },
      }, null, 2)}\n`);
    }, 30);

    const result = await runCli(["workflow-events", runId, "--follow", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ runId, type: "run:started" }),
      expect.objectContaining({ runId, type: "log", message: "halfway" }),
      expect.objectContaining({ runId, type: "run:completed" }),
    ]);
  });

  test("lists persisted workflows without transcript spam", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const list = await runCli(["workflows", "--project-root", projectRoot, "--json"]);

    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toContainEqual(expect.objectContaining({
      runId: run.runId,
      name: "no-write-probe",
      status: "completed",
    }));
  });

  test("human workflows output renders scan-friendly rows with progress and actions", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const list = await runCli(["workflows", "--project-root", projectRoot]);

    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("RUN ID");
    expect(list.stdout).toContain("STATUS");
    expect(list.stdout).toContain(run.runId);
    expect(list.stdout).toContain("no-write-probe");
    expect(list.stdout).toContain("1/1 agents done");
    expect(list.stdout).toContain("save");
    expect(list.stdout).not.toContain("transcripts/");
  });

  test("workflows --watch refreshes persisted run rows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const runId = "wf_watchprobe";
    const runRoot = join(projectRoot, ".agent-workflow-kit", "runs", runId);
    const transcriptDir = join(runRoot, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    const artifacts = {
      root: runRoot,
      runJson: join(runRoot, "run.json"),
      eventsJsonl: join(runRoot, "events.jsonl"),
      transcriptDir,
    };
    writeFileSync(artifacts.runJson, `${JSON.stringify({
      runId,
      name: "watch-probe",
      status: "running",
      artifacts,
    }, null, 2)}\n`);
    writeFileSync(artifacts.eventsJsonl, `${JSON.stringify({ runId, type: "run:started", timestamp: "2026-06-03T00:00:00.000Z" })}\n`);

    setTimeout(() => {
      writeFileSync(artifacts.runJson, `${JSON.stringify({
        runId,
        name: "watch-probe",
        status: "completed",
        artifacts,
        result: { ok: true },
      }, null, 2)}\n`);
      writeFileSync(
        artifacts.eventsJsonl,
        [
          JSON.stringify({ runId, type: "run:started", timestamp: "2026-06-03T00:00:00.000Z" }),
          JSON.stringify({ runId, type: "run:completed", result: { ok: true }, timestamp: "2026-06-03T00:00:00.100Z" }),
          "",
        ].join("\n"),
      );
    }, 30);

    const list = await runCli(["workflows", "--watch", "--project-root", projectRoot], {
      AGENT_WORKFLOW_KIT_WATCH_INTERVAL_MS: "80",
      AGENT_WORKFLOW_KIT_WATCH_ITERATIONS: "2",
    });

    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("watch: workflows refreshing every 80ms");
    expect(list.stdout).toContain("running");
    expect(list.stdout).toContain("completed");
    expect(list.stdout).not.toContain("static snapshot");
  });

  test("stops a persisted workflow record and resume re-runs it with journal replay", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const stopped = await runCli(["workflow-stop", run.runId, "--project-root", projectRoot, "--json"]);
    const resumed = await runCli(["workflow-resume", run.runId, "--project-root", projectRoot, "--json"]);

    expect(stopped.exitCode).toBe(0);
    // Stopping an already-completed run is a no-op: its terminal result is not
    // downgraded to "stopped".
    expect(JSON.parse(stopped.stdout)).toEqual(expect.objectContaining({ runId: run.runId, status: "completed" }));

    // Resume re-runs the workflow (a fresh run id) and completes, replaying the
    // unchanged agent() prefix from the prior run's journal.
    expect(resumed.exitCode).toBe(0);
    const resumedPayload = JSON.parse(resumed.stdout);
    expect(resumedPayload.status).toBe("completed");
    expect(resumedPayload.name).toBe("no-write-probe");

    // The prior run's resume marker is recorded on its own event log.
    const priorEvents = await runCli(["workflow-events", run.runId, "--project-root", projectRoot, "--json"]);
    expect(JSON.parse(priorEvents.stdout)).toContainEqual(
      expect.objectContaining({ runId: run.runId, type: "run:resumed" }),
    );
  });

  test("resume re-runs a path-launched workflow by its recorded scriptPath", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    // A script OUTSIDE the four name-search directories: only the recorded
    // scriptPath can resolve it on resume.
    const scriptPath = join(projectRoot, "outside-dir.js");
    writeFileSync(scriptPath, `
export default function ({ phase }) {
  phase("Outside");
  return { source: "outside" };
}
`);

    const run = JSON.parse((await runCli(["workflow-run", scriptPath, "--project-root", projectRoot, "--json"])).stdout);
    expect(run.status).toBe("completed");
    expect(run.scriptPath).toBe(scriptPath);

    const stopped = await runCli(["workflow-stop", run.runId, "--project-root", projectRoot, "--json"]);
    expect(stopped.exitCode).toBe(0);

    const resumed = await runCli(["workflow-resume", run.runId, "--project-root", projectRoot, "--json"]);
    expect(resumed.exitCode).toBe(0);
    const resumedPayload = JSON.parse(resumed.stdout);
    expect(resumedPayload.status).toBe("completed");
    expect(resumedPayload.result).toEqual({ source: "outside" });
  });

  test("workflow-run can resume through the same invocation surface with --resume-from-run-id", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const first = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const resumed = await runCli([
      "workflow-run",
      "no-write-probe",
      "--resume-from-run-id",
      first.runId,
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(resumed.exitCode).toBe(0);
    const payload = JSON.parse(resumed.stdout);
    expect(payload.status).toBe("completed");
    expect(payload.runId).not.toBe(first.runId);
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("\"type\":\"agent:cached\"");
  });

  test("permission-mode accepts the full mode enum and rejects unknown values", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    for (const mode of ["default", "acceptEdits", "bypassPermissions"]) {
      const ok = await runCli(["workflow-run", "no-write-probe", "--permission-mode", mode, "--project-root", projectRoot, "--json"]);
      expect(ok.exitCode).toBe(0);
      expect(JSON.parse(ok.stdout).status).toBe("completed");
    }

    for (const mode of ["plan", "dontAsk"]) {
      const denied = await runCli(["workflow-run", "no-write-probe", "--permission-mode", mode, "--project-root", projectRoot, "--json"]);
      expect(denied.exitCode).toBe(1);
      expect(JSON.parse(denied.stdout).status).toBe("failed");
    }

    const bad = await runCli(["workflow-run", "no-write-probe", "--permission-mode", "nonsense", "--project-root", projectRoot, "--json"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("Expected one of");
  });

  test("human output surfaces failure reason and renders events without raw JSON", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    // A failed run (denied) must show its error in non-JSON output.
    const failed = await runCli(["workflow-run", "no-write-probe", "--permission-mode", "dontAsk", "--project-root", projectRoot]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("error:");
    expect(failed.stdout).toContain("denied");

    // Events render as readable lines (#index type ...), not a raw JSON dump.
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);
    const events = await runCli(["workflow-events", run.runId, "--project-root", projectRoot]);
    expect(events.exitCode).toBe(0);
    expect(events.stdout).toContain("phase");
    expect(events.stdout).not.toContain("{\"runId\"");
  });

  test("deep-research command writes a workflow run with artifact-safe summary", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli(["deep-research", "compare workflow harnesses", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    // Generate-then-run: deep-research generates a research workflow named for
    // the question and executes it.
    expect(payload.name).toBe("compare-workflow-harnesses");
    expect(payload.status).toBe("completed");
    expect(payload.artifacts).toEqual({
      root: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId),
      runJson: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId, "run.json"),
      eventsJsonl: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId, "events.jsonl"),
      transcriptDir: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId, "transcripts"),
    });
    expect(existsSync(payload.artifacts.runJson)).toBe(true);
    expect(existsSync(payload.artifacts.eventsJsonl)).toBe(true);
    expect(existsSync(payload.artifacts.transcriptDir)).toBe(true);
    expect(payload.result).toEqual(expect.objectContaining({ ok: true, question: "compare workflow harnesses" }));
  });

  test("model aliases resolve through persisted workflow events", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "model-alias.js"), `
export default async function ({ agent }) {
  return agent("model probe", { model: "haiku" });
}
`);

    const result = await runCli([
      "workflow-run",
      "model-alias",
      "--model-alias",
      "haiku=provider/fast-worker",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const events = readFileSync(payload.artifacts.eventsJsonl, "utf8");
    expect(events).toContain("\"requestedModel\":\"haiku\"");
    expect(events).toContain("\"model\":\"provider/fast-worker\"");
  });

  test("model aliases can be inherited from the harness environment", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "env-model-alias.js"), `
export default async function ({ agent }) {
  return agent("model probe", { model: "sonnet" });
}
`);

    const result = await runCli([
      "workflow-run",
      "env-model-alias",
      "--project-root",
      projectRoot,
      "--json",
    ], {
      AGENT_WORKFLOW_KIT_MODEL_ALIASES: "sonnet=provider/balanced-worker",
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const events = readFileSync(payload.artifacts.eventsJsonl, "utf8");
    expect(events).toContain("\"requestedModel\":\"sonnet\"");
    expect(events).toContain("\"model\":\"provider/balanced-worker\"");
  });

  test("--token-budget reaches the workflow budget as an informational target", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "budget-probe.js"), `
export default async function ({ budget }) {
  return { total: budget.total };
}
`);

    const result = await runCli(["workflow-run", "budget-probe", "--token-budget", "5000", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toEqual({ total: 5000 });
  });

  test("--max-agent-calls applies an explicit runtime limit", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "limit-probe.js"), `
export default async function ({ agent }) {
  await agent("first");
  return agent("second");
}
`);

    const result = await runCli(["workflow-run", "limit-probe", "--max-agent-calls", "1", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("failed");
    expect(payload.error).toContain("Agent call limit exceeded");
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("\"type\":\"agent:limit\"");
  });

  test("--max-estimated-tokens can stop a workflow when token estimates exceed policy", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli([
      "workflow-run",
      "no-write-probe",
      "--max-estimated-tokens",
      "1",
      "--stop-on-estimated-token-limit",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("failed");
    expect(payload.error).toContain("Estimated token limit exceeded");
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("\"type\":\"agent:limit\"");
  });

  test("--max-child-workflow-depth can block child workflow execution", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "child-depth-probe.js"), `
export default async function ({ workflow }) {
  const child = async ({ agent }) => agent("child");
  return workflow({ name: "child", script: child });
}
`);

    const result = await runCli([
      "workflow-run",
      "child-depth-probe",
      "--max-child-workflow-depth",
      "0",
      "--project-root",
      projectRoot,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.status).toBe("failed");
    expect(payload.error).toContain("Child workflow depth limit exceeded");
    expect(readFileSync(payload.artifacts.eventsJsonl, "utf8")).toContain("\"type\":\"workflow:limit\"");
  });

  test("--session-model is inherited by agent() calls that omit a model", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "session-probe.js"), `
export default async function ({ agent }) {
  return agent("no model here");
}
`);

    const result = await runCli(["workflow-run", "session-probe", "--session-model", "sess/default", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    const events = readFileSync(payload.artifacts.eventsJsonl, "utf8");
    expect(events).toContain("\"model\":\"sess/default\"");
  });

  test("--token-budget rejects non-positive values", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const result = await runCli(["workflow-run", "no-write-probe", "--token-budget", "nope", "--project-root", projectRoot, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--token-budget requires a positive number");
  });

  test("--agent-timeout-ms fails fast without --real-agents", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const result = await runCli(["workflow-run", "no-write-probe", "--agent-timeout-ms", "1000", "--project-root", projectRoot, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--agent-timeout-ms requires --real-agents");
  });

  test("--default-agent-type fails fast without --real-agents", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const result = await runCli(["workflow-run", "no-write-probe", "--default-agent-type", "codex", "--project-root", projectRoot, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--default-agent-type requires --real-agents");
  });

  test("AGENT_WORKFLOW_KIT_DEFAULT_AGENT_TYPE fails fast without --real-agents", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const result = await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"], {
      AGENT_WORKFLOW_KIT_DEFAULT_AGENT_TYPE: "codex",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--default-agent-type requires --real-agents");
  });

  test("throws when --agent-timeout-ms is set but --real-agents is absent, regardless of flag order", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    // Timeout flag before the command, still no --real-agents: the after-loop guard must catch it regardless of order.
    const result = await runCli(["--agent-timeout-ms", "2000", "workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--agent-timeout-ms requires --real-agents");
  });
});

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}
