import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCommandService, denyDynamicWorkflowPolicy } from "../src/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow command service", () => {
  test("runs, lists, stops, and resumes workflow state from one shared service", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async () => ({ ok: true }),
    });

    const run = await service.runSavedWorkflow("no-write-probe");
    const listed = service.listRuns();
    // Stopping an already-completed run is a no-op: a terminal result is never
    // downgraded to "stopped".
    const stopped = service.stopRun(run.runId);
    const resumed = await service.resumeRun(run.runId);
    const prior = service.getRun(run.runId);

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "completed",
      result: { ok: true },
    }));
    expect(listed).toContainEqual(expect.objectContaining({ runId: run.runId }));
    expect(stopped).toEqual(expect.objectContaining({ runId: run.runId, status: "completed" }));
    // Resume re-runs the workflow as a fresh completed run replaying the prior
    // journal; the original completed run is preserved untouched.
    expect(resumed).toEqual(expect.objectContaining({ name: "no-write-probe", status: "completed" }));
    expect(resumed.runId).not.toBe(run.runId);
    expect(prior).toEqual(expect.objectContaining({ runId: run.runId, status: "completed" }));
  });

  test("launches saved workflows with Claude-shaped async output", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-launch-output-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async () => ({ ok: true }),
    });

    const launch = await service.launchSavedWorkflow("no-write-probe", ["1024", "1025"]);

    expect(launch).toEqual(expect.objectContaining({
      status: "async_launched",
      summary: "Started workflow no-write-probe",
    }));
    expect(launch.taskId).toMatch(/^task_wf_/);
    expect(launch.runId).toMatch(/^wf_/);
    expect(launch.transcriptDir).toContain(join(".agent-workflow-kit", "runs", launch.runId!, "transcripts"));
    expect(launch.scriptPath).toBeUndefined();

    const run = service.getRun(launch.runId!);
    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      args: ["1024", "1025"],
    }));
  });

  test("runs source-string workflows through the public invocation object and persists the script", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-source-input-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });
    const source = `
export default function ({ args }) {
  return { ok: true, args };
}
`;

    const run = await service.runWorkflow({
      name: "inline-probe",
      script: source,
      args: ["from", "source"],
    });

    const scriptPath = join(projectRoot, ".agent-workflow-kit", "workflows", "inline-probe.js");
    expect(run).toEqual(expect.objectContaining({
      name: "inline-probe",
      status: "completed",
      scriptPath,
      result: { ok: true, args: ["from", "source"] },
    }));
    expect(readFileSync(scriptPath, "utf8")).toBe(source);
  });

  test("status and list project workflow progress from persisted events", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-progress-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "progress-probe.js"), `
export default async function ({ phase, agent }) {
  phase("Plan");
  await agent("plan output", { label: "planner" });
  phase("Build");
  await agent("build output", { label: "builder" });
  return { ok: true };
}
`);
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async (prompt) => `${prompt} result`,
    });

    const run = await service.runSavedWorkflow("progress-probe");
    const status = service.getRun(run.runId);
    const listed = service.listRuns().find((entry) => entry.runId === run.runId);

    expect(status.progress).toEqual(expect.objectContaining({
      runId: run.runId,
      status: "completed",
      agentTotal: 2,
      agentDone: 2,
      agentRunning: 0,
      agentFailed: 0,
    }));
    expect(status.progress?.tokenTotal).toBeGreaterThan(0);
    expect(status.progress?.phases).toEqual([
      expect.objectContaining({ title: "Plan", agentTotal: 1, agentDone: 1 }),
      expect.objectContaining({ title: "Build", agentTotal: 1, agentDone: 1 }),
    ]);
    expect(status.progress?.recentEvents.map((event) => event.type)).toContain("run:completed");
    expect(listed?.progress).toEqual(expect.objectContaining({
      runId: run.runId,
      agentTotal: 2,
    }));
  });

  test("runs ad hoc and deep-research workflows without exposing transcript text", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    // Default structural agent: generated workflows orchestrate with schema
    // calls, and the default agent returns schema-shaped defaults so the run
    // completes deterministically.
    const service = createWorkflowCommandService({ projectRoot });

    const workflow = await service.runAdHocWorkflow("inspect repo");
    const research = await service.runDeepResearch("compare workflow harnesses");

    // Generated workflows now orchestrate (plan/fan-out/synthesize and
    // gather/refute/converge); the result carries the orchestration output
    // alongside the task/question.
    expect(workflow.result).toEqual(expect.objectContaining({ ok: true, task: "inspect repo" }));
    expect(workflow.result).toHaveProperty("synthesis");
    expect(research.result).toEqual(expect.objectContaining({ ok: true, question: "compare workflow harnesses" }));
    expect(research.result).toHaveProperty("report");

    // The generated workflows actually orchestrate via agent() — not inert stubs.
    expect(service.eventsFor(workflow.runId).some((e) => e.type === "agent:start")).toBe(true);
    expect(service.eventsFor(research.runId).some((e) => e.type === "agent:start")).toBe(true);
  });

  test("generated deep-research workflow runs an adversarial verify loop with a claim-producing agent", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-deep-research-"));
    roots.push(projectRoot);

    // An agent that yields one claim per angle, then unanimously refutes — so the
    // gather→refute→converge loop runs and drops the refuted claim.
    let refuteCalls = 0;
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async (prompt) => {
        if (prompt.includes('"angles"')) return { angles: ["economic", "technical"] };
        if (prompt.includes('"claims"')) return { claims: [{ claim: "a claim", source: "src" }] };
        if (prompt.includes("REFUTE")) {
          refuteCalls += 1;
          return { refuted: true, reason: "unsupported" };
        }
        if (prompt.includes('"sourceLedger"')) {
          return {
            answer: "no supported claims",
            sourceLedger: [],
            claimLedger: [],
            contradictionChecks: [{ claim: "a claim", result: "unsupported" }],
            claimConfidenceTable: [],
            rejectedClaims: [{ claim: "a claim", reason: "unsupported" }],
          };
        }
        return "final report text";
      },
    });

    const research = await service.runDeepResearch("impact of X");

    expect(research.status).toBe("completed");
    const result = research.result as { angles: string[]; confirmedClaims: unknown[]; report: unknown };
    expect(result.angles).toEqual(["economic", "technical"]);
    // The single deduped claim was refuted by the panel, so nothing is confirmed.
    expect(result.confirmedClaims).toEqual([]);
    expect(refuteCalls).toBeGreaterThanOrEqual(3); // a 3-reviewer panel ran
    expect(result.report).toEqual(expect.objectContaining({
      sourceLedger: [],
      claimConfidenceTable: [],
      rejectedClaims: [{ claim: "a claim", reason: "unsupported" }],
    }));
  });

  test("generated deep-research report includes a source ledger and claim confidence table", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-deep-research-report-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async (prompt) => {
        if (prompt.includes('"angles"')) return { angles: ["technical"] };
        if (prompt.includes('"claims"')) return { claims: [{ claim: "workflow parity needs evidence ledgers", source: "source-1" }] };
        if (prompt.includes("REFUTE")) return { refuted: false, reason: "supported" };
        if (prompt.includes('"sourceLedger"')) {
          return {
            answer: "Workflow parity needs evidence ledgers [source-1].",
            sourceLedger: [{ source: "source-1", claims: ["workflow parity needs evidence ledgers"] }],
            claimLedger: [{ claim: "workflow parity needs evidence ledgers", source: "source-1", status: "confirmed" }],
            contradictionChecks: [{ claim: "workflow parity needs evidence ledgers", result: "not contradicted" }],
            claimConfidenceTable: [{ claim: "workflow parity needs evidence ledgers", confidence: "high", source: "source-1" }],
            rejectedClaims: [],
          };
        }
        return {};
      },
    });

    const research = await service.runDeepResearch("workflow parity evidence");
    const result = research.result as { report: { sourceLedger: unknown[]; claimConfidenceTable: unknown[] } };

    expect(research.status).toBe("completed");
    expect(result.report.sourceLedger).toContainEqual(expect.objectContaining({
      source: "source-1",
      claims: ["workflow parity needs evidence ledgers"],
    }));
    expect(result.report.claimConfidenceTable).toContainEqual(expect.objectContaining({
      claim: "workflow parity needs evidence ledgers",
      confidence: "high",
      source: "source-1",
    }));
  });

  test("generated deep-research loops past the first round while fresh claims keep arriving (loop-until-dry)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-deep-research-dry-"));
    roots.push(projectRoot);

    // Each gather call yields a unique claim (round-stamped), so claims keep
    // arriving and the loop must NOT break on the first round. All are refuted,
    // so it eventually dries out and terminates.
    let gatherCalls = 0;
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async (prompt) => {
        if (prompt.includes('"angles"')) return { angles: ["only-angle"] };
        if (prompt.includes('"claims"')) {
          gatherCalls += 1;
          // Stop producing new claims after a few rounds so the loop dries out.
          if (gatherCalls > 3) return { claims: [] };
          return { claims: [{ claim: "claim-" + gatherCalls, source: "s" }] };
        }
        if (prompt.includes("REFUTE")) return { refuted: true, reason: "x" };
        if (prompt.includes('"sourceLedger"')) {
          return {
            answer: "report",
            sourceLedger: [],
            claimLedger: [],
            contradictionChecks: [],
            claimConfidenceTable: [],
            rejectedClaims: [],
          };
        }
        return "report";
      },
    });

    const research = await service.runDeepResearch("topic Y");
    const result = research.result as { rounds: number };

    expect(research.status).toBe("completed");
    // More than one gather round ran (the old code broke after round 1).
    expect(gatherCalls).toBeGreaterThan(1);
    expect(result.rounds).toBeGreaterThan(1);
  });

  test("ad hoc workflow persists a generated workflow that workflow-run can invoke", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const generated = await service.runAdHocWorkflow("inspect repo");
    const workflow = (generated.args as any).workflow;

    expect(workflow).toEqual({
      name: "inspect-repo",
      path: join(projectRoot, ".agent-workflow-kit", "workflows", "inspect-repo.js"),
    });
    expect(existsSync(workflow.path)).toBe(true);

    const rerun = await service.runSavedWorkflow(workflow.name);

    expect(rerun).toEqual(expect.objectContaining({
      name: "inspect-repo",
      status: "completed",
    }));
    expect(rerun.result).toEqual(expect.objectContaining({ ok: true, task: "inspect repo" }));
  });

  test("applies permission policy before running saved workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      permissionPolicy: denyDynamicWorkflowPolicy,
    });

    const run = await service.runSavedWorkflow("no-write-probe");

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution denied by permission policy",
    }));
  });

  test("passes workflow preview metadata to permission policy before execution", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-permission-preview-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    const scriptPath = join(workflowsRoot, "preview-probe.js");
    writeFileSync(scriptPath, "export default async function () { return { ok: true }; }\n");
    let preview: unknown;
    const service = createWorkflowCommandService({
      projectRoot,
      permissionPolicy: {
        authorizeDynamicWorkflow(request) {
          preview = request;
          return { allowed: true };
        },
      },
    });
    const args = ["alpha", { limit: 2 }];

    const run = await service.runSavedWorkflow("preview-probe", args);

    expect(run.status).toBe("completed");
    expect(preview).toEqual(expect.objectContaining({
      name: "preview-probe",
      scriptPath,
      args,
      argsPreview: "[\"alpha\",{\"limit\":2}]",
    }));
  });

  test("passes source origin, agent estimate, and worktree hints to permission policy", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-permission-preview-"));
    roots.push(projectRoot);
    let preview: unknown;
    const service = createWorkflowCommandService({
      projectRoot,
      permissionPolicy: {
        authorizeDynamicWorkflow(request) {
          preview = request;
          return { allowed: true };
        },
      },
    });

    await service.runWorkflow({
      name: "preview-source",
      script: `
export default async function ({ agent }) {
  await agent("inspect", { isolation: "worktree" });
  return agent("summarize");
}
`,
    });

    expect(preview).toEqual(expect.objectContaining({
      name: "preview-source",
      origin: "source",
      generated: false,
      agentCountEstimate: 2,
      isolationHints: ["worktree"],
      writeHints: ["worktree"],
    }));
  });

  test("marks generated ad hoc workflows in permission preview metadata", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-permission-preview-"));
    roots.push(projectRoot);
    let preview: unknown;
    const service = createWorkflowCommandService({
      projectRoot,
      permissionPolicy: {
        authorizeDynamicWorkflow(request) {
          preview = request;
          return { allowed: true };
        },
      },
    });

    await service.runAdHocWorkflow("inspect generated preview");

    expect(preview).toEqual(expect.objectContaining({
      name: "inspect-generated-preview",
      origin: "saved",
      generated: true,
      agentCountEstimate: expect.any(Number),
    }));
  });

  test("default agent returns schema-shaped values for structural workflow runs", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "schema-default.js"), `
export default async function ({ agent }) {
  return agent("schema default", {
    schema: {
      type: "object",
      required: ["items", "decision", "count", "ok"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        decision: { type: "string", enum: ["skip", "run"] },
        count: { type: "integer" },
        ok: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            note: { type: "string" }
          }
        }
      }
    }
  });
}
`);
    const service = createWorkflowCommandService({ projectRoot });

    const run = await service.runSavedWorkflow("schema-default");

    expect(run.result).toEqual({
      items: [],
      decision: "skip",
      count: 0,
      ok: false,
      nested: { note: "" },
    });
  });

  test("ad hoc run records scriptPath and resume re-runs by it", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-scriptpath-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const run = await service.runAdHocWorkflow("inspect repo");
    expect(run.status).toBe("completed");
    expect(run.scriptPath).toBe(join(projectRoot, ".agent-workflow-kit", "workflows", "inspect-repo.js"));

    service.stopRun(run.runId);
    const resumed = await service.resumeRun(run.runId);
    expect(resumed.status).toBe("completed");
    expect(resumed.runId).not.toBe(run.runId);
    expect(resumed.result).toEqual(expect.objectContaining({ ok: true, task: "inspect repo" }));
  });

  test("slug-colliding prompts write distinct workflow files (no silent overwrite)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-slug-collision-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    // Two different prompts that slug to the same base name.
    const a = await service.runAdHocWorkflow("inspect repo");
    const b = await service.runAdHocWorkflow("inspect repo!!!");

    const pathA = (a.args as any).workflow.path as string;
    const pathB = (b.args as any).workflow.path as string;

    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    // Distinct files — the second did not clobber the first.
    expect(pathA).not.toBe(pathB);
    expect(a.result).toEqual(expect.objectContaining({ task: "inspect repo" }));
    expect(b.result).toEqual(expect.objectContaining({ task: "inspect repo!!!" }));
  });

  test("regenerating the same prompt reuses the same workflow file", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-slug-reuse-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const a = await service.runAdHocWorkflow("inspect repo");
    const b = await service.runAdHocWorkflow("inspect repo");

    expect((a.args as any).workflow.path).toBe((b.args as any).workflow.path);
  });

  test("resume warns when the workflow file changed since the original run", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-hash-"));
    roots.push(projectRoot);
    const scriptPath = join(projectRoot, "hashy.js");
    writeFileSync(scriptPath, `
export default function ({ phase }) {
  phase("One");
  return { v: 1 };
}
`);
    const service = createWorkflowCommandService({ projectRoot });
    const run = await service.runSavedWorkflow(scriptPath);
    expect(run.status).toBe("completed");

    // Edit the workflow body, then resume the prior run.
    writeFileSync(scriptPath, `
export default function ({ phase }) {
  phase("One");
  return { v: 2 };
}
`);
    await service.resumeRun(run.runId);

    const types = service.eventsFor(run.runId).map((event) => event.type);
    expect(types).toContain("run:script-changed");
  });

  test("resume flags an empty-journal full re-run", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-empty-"));
    roots.push(projectRoot);
    const scriptPath = join(projectRoot, "nojournal.js");
    // No agent() calls → no replayable journal entries.
    writeFileSync(scriptPath, `
export default function ({ phase }) {
  phase("Only");
  return { ok: true };
}
`);
    const service = createWorkflowCommandService({ projectRoot });
    const run = await service.runSavedWorkflow(scriptPath);

    await service.resumeRun(run.runId);

    const types = service.eventsFor(run.runId).map((event) => event.type);
    expect(types).toContain("run:resume-empty-journal");
  });
});
