import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-workflow-kit cli", () => {
  test("workflow command runs an ad hoc no-write workflow", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli(["workflow", "inspect repo", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.name).toBe("workflow");
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({ ok: true, task: "inspect repo" });
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

    expect(result.exitCode).toBe(0);
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

  test("reads run status from persisted state", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const status = await runCli(["workflow-status", run.runId, "--project-root", projectRoot, "--json"]);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(expect.objectContaining({
      runId: run.runId,
      status: "completed",
    }));
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

  test("stops and resumes persisted workflow records", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);
    const run = JSON.parse((await runCli(["workflow-run", "no-write-probe", "--project-root", projectRoot, "--json"])).stdout);

    const stopped = await runCli(["workflow-stop", run.runId, "--project-root", projectRoot, "--json"]);
    const resumed = await runCli(["workflow-resume", run.runId, "--project-root", projectRoot, "--json"]);

    expect(stopped.exitCode).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual(expect.objectContaining({ runId: run.runId, status: "stopped" }));
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual(expect.objectContaining({ runId: run.runId, status: "stopped" }));
  });

  test("deep-research command writes a workflow run with artifact-safe summary", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-cli-"));
    roots.push(projectRoot);

    const result = await runCli(["deep-research", "compare workflow harnesses", "--project-root", projectRoot, "--json"]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.name).toBe("deep-research");
    expect(payload.status).toBe("completed");
    expect(payload.artifacts).toEqual({
      root: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId),
      runJson: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId, "run.json"),
      eventsJsonl: join(projectRoot, ".agent-workflow-kit", "runs", payload.runId, "events.jsonl"),
    });
    expect(existsSync(payload.artifacts.runJson)).toBe(true);
    expect(existsSync(payload.artifacts.eventsJsonl)).toBe(true);
    expect(payload.result).toEqual({ ok: true, question: "compare workflow harnesses" });
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
