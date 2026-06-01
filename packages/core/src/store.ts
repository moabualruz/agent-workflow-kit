import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentJournalEntry, WorkflowArgs, WorkflowArtifacts, WorkflowEvent, WorkflowRun } from "./domain";
import { stringifyError } from "./errors";

export type MemoryStore = ReturnType<typeof createMemoryStore>;
export type FileStore = ReturnType<typeof createFileStore>;

export function createMemoryStore() {
  const runs = new Map<string, WorkflowRun>();
  const events = new Map<string, WorkflowEvent[]>();

  return {
    createRun(name: string, args?: WorkflowArgs, scriptPath?: string): WorkflowRun {
      const run: WorkflowRun = {
        runId: `wf_${randomUUID().slice(0, 12)}`,
        name,
        status: "running",
        ...(args ? { args } : {}),
        ...(scriptPath ? { scriptPath } : {}),
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
      // Never downgrade an already-terminal stopped/failed run.
      if (run.status === "stopped" || run.status === "failed") return { ...run };
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

  // Abort controllers for in-flight runs so stop() can cancel a live run, not
  // just flip its persisted status.
  const aborts = new Map<string, AbortController>();

  return {
    createRun(name: string, args?: WorkflowArgs, scriptPath?: string): WorkflowRun {
      const runId = `wf_${randomUUID().slice(0, 12)}`;
      const run: WorkflowRun = {
        runId,
        name,
        status: "running",
        artifacts: artifactPaths(runsRoot, runId),
        ...(args ? { args } : {}),
        ...(scriptPath ? { scriptPath } : {}),
      };
      mkdirSync(runDir(runsRoot, run.runId), { recursive: true });
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId: run.runId, type: "run:started" });
      return run;
    },

    registerAbort(runId: string): AbortSignal {
      const controller = new AbortController();
      aborts.set(runId, controller);
      return controller.signal;
    },

    clearAbort(runId: string): void {
      aborts.delete(runId);
    },

    append(event: WorkflowEvent): void {
      appendEvent(runsRoot, event);
    },

    complete(runId: string, result: unknown): WorkflowRun {
      const run = readRun(runsRoot, runId);
      // Never downgrade a run that already reached a terminal stopped/failed
      // state (e.g. a stop() that landed while the script was resolving).
      if (run.status === "stopped" || run.status === "failed") return { ...run };
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
      const events: WorkflowEvent[] = [];
      // Skip an unparseable line rather than throwing: a crash mid-append can
      // leave a torn final JSONL line, and one bad line must not make the whole
      // run un-inspectable. Degrade to the readable prefix.
      for (const line of readFileSync(eventPath, "utf8").split("\n")) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as WorkflowEvent);
        } catch {
          // torn or partial write — ignore this line
        }
      }
      return events;
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
      // Never downgrade a run that already reached a terminal completed/failed
      // state — a stop() racing a just-finished run (or a user stopping an
      // already-done run) must not relabel a real result as "stopped". Mirrors
      // the terminal guard in complete(). Also closes the detached-run abort
      // race where complete() wins but a later stop() would otherwise overwrite.
      if (run.status === "completed" || run.status === "failed") return { ...run };
      // Cancel the live run if one is in flight; the runtime observes the abort
      // signal between agent calls and unwinds.
      aborts.get(runId)?.abort();
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

    // Replay journal for resume: ordered agent results from a prior run keyed by
    // call order. Only completed agent calls (those carrying a result) are
    // replayable; a failed call is not cached so resume re-executes from there.
    agentJournal(runId: string): AgentJournalEntry[] {
      const eventPath = join(runDir(runsRoot, runId), "events.jsonl");
      if (!existsSync(eventPath)) return [];
      const entries: AgentJournalEntry[] = [];
      let fallbackSeq = 0;
      for (const line of readFileSync(eventPath, "utf8").split("\n")) {
        if (!line) continue;
        // A torn final line must degrade to the readable prefix, not abort the
        // whole resume — skip an unparseable line instead of throwing.
        let event: WorkflowEvent;
        try {
          event = JSON.parse(line) as WorkflowEvent;
        } catch {
          continue;
        }
        if (event.type !== "agent:done" || event.key === undefined || event.error !== undefined) continue;
        fallbackSeq += 1;
        // Last write wins per stable key (a replayed-then-rerun call keeps the
        // newest result); entries are matched on key, not array position. `seq`
        // carries the recorded global execution order; a pre-seq journal falls
        // back to append order, which is monotonic and preserves prefix ordering.
        entries.push({
          key: event.key,
          seq: event.seq ?? fallbackSeq,
          prompt: event.prompt ?? "",
          model: event.model,
          result: event.result,
          tokens: event.tokens,
        });
      }
      return entries;
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
