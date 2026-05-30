import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-workflow-kit cli", () => {
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
});

async function runCli(args: string[]) {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
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
