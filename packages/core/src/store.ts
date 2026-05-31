import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowArtifacts, WorkflowEvent, WorkflowRun } from "./domain";
import { stringifyError } from "./errors";

export type MemoryStore = ReturnType<typeof createMemoryStore>;
export type FileStore = ReturnType<typeof createFileStore>;

export function createMemoryStore() {
  const runs = new Map<string, WorkflowRun>();
  const events = new Map<string, WorkflowEvent[]>();

  return {
    createRun(name: string): WorkflowRun {
      const run: WorkflowRun = {
        runId: `wf_${randomUUID().slice(0, 12)}`,
        name,
        status: "running",
      };
      runs.set(run.runId, run);
      events.set(run.runId, [{ runId: run.runId, type: "run:started" }]);
      return run;
    },

    append(event: WorkflowEvent): void {
      events.get(event.runId)?.push(event);
    },

    complete(runId: string, result: unknown): WorkflowRun {
      const run = getRun(runs, runId);
      run.status = "completed";
      run.result = result;
      events.get(runId)?.push({ runId, type: "run:completed", result });
      return { ...run };
    },

    fail(runId: string, error: unknown): WorkflowRun {
      const run = getRun(runs, runId);
      run.status = "failed";
      run.error = stringifyError(error);
      events.get(runId)?.push({ runId, type: "run:failed", error: run.error });
      return { ...run };
    },

    eventsFor(runId: string): WorkflowEvent[] {
      return [...(events.get(runId) ?? [])];
    },
  };
}

export function createFileStore(options: { projectRoot: string }) {
  const runsRoot = join(options.projectRoot, ".agent-workflow-kit", "runs");
  mkdirSync(runsRoot, { recursive: true });

  return {
    createRun(name: string): WorkflowRun {
      const runId = `wf_${randomUUID().slice(0, 12)}`;
      const run: WorkflowRun = {
        runId,
        name,
        status: "running",
        artifacts: artifactPaths(runsRoot, runId),
      };
      mkdirSync(runDir(runsRoot, run.runId), { recursive: true });
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId: run.runId, type: "run:started" });
      return run;
    },

    append(event: WorkflowEvent): void {
      appendEvent(runsRoot, event);
    },

    complete(runId: string, result: unknown): WorkflowRun {
      const run = readRun(runsRoot, runId);
      run.status = "completed";
      run.result = result;
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId, type: "run:completed", result });
      return { ...run };
    },

    fail(runId: string, error: unknown): WorkflowRun {
      const run = readRun(runsRoot, runId);
      run.status = "failed";
      run.error = stringifyError(error);
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId, type: "run:failed", error: run.error });
      return { ...run };
    },

    eventsFor(runId: string): WorkflowEvent[] {
      const eventPath = join(runDir(runsRoot, runId), "events.jsonl");
      if (!existsSync(eventPath)) return [];
      return readFileSync(eventPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkflowEvent);
    },

    getRun(runId: string): WorkflowRun {
      return readRun(runsRoot, runId);
    },

    listRuns(): WorkflowRun[] {
      if (!existsSync(runsRoot)) return [];
      return readdirSync(runsRoot)
        .filter((entry) => existsSync(join(runsRoot, entry, "run.json")))
        .map((entry) => readRun(runsRoot, entry))
        .sort((a, b) => a.runId.localeCompare(b.runId));
    },

    stop(runId: string): WorkflowRun {
      const run = readRun(runsRoot, runId);
      run.status = "stopped";
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId, type: "run:stopped" });
      return { ...run };
    },

    resume(runId: string): WorkflowRun {
      const run = readRun(runsRoot, runId);
      appendEvent(runsRoot, { runId, type: "run:resumed" });
      return { ...run };
    },
  };
}

function getRun(runs: Map<string, WorkflowRun>, runId: string): WorkflowRun {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown run id: ${runId}`);
  return run;
}

function runDir(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

function writeRun(runsRoot: string, run: WorkflowRun): void {
  mkdirSync(runDir(runsRoot, run.runId), { recursive: true });
  writeFileSync(join(runDir(runsRoot, run.runId), "run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

function readRun(runsRoot: string, runId: string): WorkflowRun {
  const run = JSON.parse(readFileSync(join(runDir(runsRoot, runId), "run.json"), "utf8")) as WorkflowRun;
  return { ...run, artifacts: run.artifacts ?? artifactPaths(runsRoot, runId) };
}

function appendEvent(runsRoot: string, event: WorkflowEvent): void {
  mkdirSync(runDir(runsRoot, event.runId), { recursive: true });
  appendFileSync(join(runDir(runsRoot, event.runId), "events.jsonl"), `${JSON.stringify(event)}\n`);
}

function artifactPaths(runsRoot: string, runId: string): WorkflowArtifacts {
  const root = runDir(runsRoot, runId);
  return {
    root,
    runJson: join(root, "run.json"),
    eventsJsonl: join(root, "events.jsonl"),
  };
}
