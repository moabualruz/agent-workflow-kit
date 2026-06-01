import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore, createWorkflowRuntime, type WorkflowScript } from "../src/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("file workflow store", () => {
  test("persists run.json and append-only events.jsonl under project state root", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-file-store-"));
    roots.push(projectRoot);
    const store = createFileStore({ projectRoot });
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => ({ ok: true }),
    });
    const script: WorkflowScript = async ({ phase, agent }) => {
      phase("Probe");
      return agent("return ok");
    };

    const run = await runtime.run({ name: "no-write-probe", script });

    const runDir = join(projectRoot, ".agent-workflow-kit", "runs", run.runId);
    expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))).toEqual(expect.objectContaining({
      runId: run.runId,
      name: "no-write-probe",
      status: "completed",
      artifacts: {
        root: runDir,
        runJson: join(runDir, "run.json"),
        eventsJsonl: join(runDir, "events.jsonl"),
      },
      result: { ok: true },
    }));
    const artifacts = run.artifacts;
    if (!artifacts) throw new Error("expected file-backed run artifacts");
    expect(artifacts).toEqual({
      root: runDir,
      runJson: join(runDir, "run.json"),
      eventsJsonl: join(runDir, "events.jsonl"),
    });
    expect(existsSync(artifacts.runJson)).toBe(true);
    expect(existsSync(artifacts.eventsJsonl)).toBe(true);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      "run:started",
      "phase",
      "agent:start",
      "agent:done",
      "run:completed",
    ]);
  });

  test("lists and loads persisted runs", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-file-store-"));
    roots.push(projectRoot);
    const store = createFileStore({ projectRoot });
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => ({ ok: true }),
    });

    const run = await runtime.run({ name: "no-write-probe", script: async () => ({ ok: true }) });

    expect(store.getRun(run.runId)).toEqual(expect.objectContaining({ status: "completed" }));
    expect(store.listRuns()).toContainEqual(expect.objectContaining({ runId: run.runId }));
  });

  test("records stopped and resumed states without deleting run artifacts", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-file-store-"));
    roots.push(projectRoot);
    const store = createFileStore({ projectRoot });
    // A still-running run is the legitimate target of stop(); create one directly
    // so it is not already terminal when stopped.
    const run = store.createRun("no-write-probe");

    const stopped = store.stop(run.runId);
    const resumed = store.resume(run.runId);

    expect(stopped.status).toBe("stopped");
    expect(resumed.status).toBe("stopped");
    expect(store.eventsFor(run.runId).map((event) => event.type)).toContain("run:stopped");
    expect(store.eventsFor(run.runId).map((event) => event.type)).toContain("run:resumed");
    expect(readFileSync(join(projectRoot, ".agent-workflow-kit", "runs", run.runId, "run.json"), "utf8")).toContain("stopped");
  });

  test("stop() never downgrades an already-completed run", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-file-store-"));
    roots.push(projectRoot);
    const store = createFileStore({ projectRoot });
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => ({ ok: true }),
    });
    const run = await runtime.run({ name: "no-write-probe", script: async () => ({ ok: true }) });
    expect(run.status).toBe("completed");

    // A stop() that races a just-finished run (or a user stopping a done run)
    // must keep the completed result, not relabel it "stopped".
    const stopped = store.stop(run.runId);
    expect(stopped.status).toBe("completed");
    expect(store.getRun(run.runId).status).toBe("completed");
  });
});
