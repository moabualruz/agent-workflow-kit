import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const roots: string[] = [];
const smokeFiles = [
  "plugins/codex-workflow-kit/skills/workflow-kit/SKILL.md",
  "plugins/gemini-workflow-kit/commands/workflow-run.toml",
  "plugins/opencode-workflow-kit/commands/workflow-run.md",
  "plugins/grok-workflow-kit/commands/workflow-run.md",
  "plugins/grok-workflow-kit/skills/workflow-kit/SKILL.md",
  "plugins/pi-workflow-kit/skills/workflow-kit/SKILL.md",
  "plugins/antigravity-workflow-kit/skills/workflow-run/SKILL.md",
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("file-command harness smoke blocks", () => {
  test("executable smoke blocks bound live watch commands", () => {
    for (const file of smokeFiles) {
      const smoke = extractExecutableSmoke(readFileSync(join(repoRoot, file), "utf8"));
      for (const line of smoke.split("\n")) {
        if (!line.includes("agent-workflow-kit workflows --watch")) continue;
        expect({ file, line }).toEqual(expect.objectContaining({
          line: expect.stringContaining("AGENT_WORKFLOW_KIT_WATCH_ITERATIONS=1"),
        }));
      }
    }
  });

  test("skill and command workflow surfaces execute the shared CLI path", async () => {
    for (const file of smokeFiles) {
      const smoke = extractExecutableSmoke(readFileSync(join(repoRoot, file), "utf8"));
      const projectRoot = mkdtempSync(join(tmpdir(), "awk-file-command-project-"));
      const binRoot = mkdtempSync(join(tmpdir(), "awk-file-command-bin-"));
      roots.push(projectRoot, binRoot);
      const cliShim = join(binRoot, "agent-workflow-kit");
      writeFileSync(cliShim, `#!/usr/bin/env sh\nexec bun "${join(repoRoot, "packages/cli/src/cli.ts")}" "$@"\n`);
      chmodSync(cliShim, 0o755);

      const proc = Bun.spawn(["sh", "-eu", "-c", smoke], {
        cwd: projectRoot,
        env: {
          ...process.env,
          AGENT_WORKFLOW_KIT_PROJECT_ROOT: projectRoot,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect({ file, stderr, stdout, exitCode }).toEqual(expect.objectContaining({ exitCode: 0 }));
      expect(stdout).toContain("\"name\":\"file-command-generated\"");
      expect(stdout).toContain("\"name\":\"no-write-probe\"");
      expect(stdout).toContain("\"name\":\"file-command-smoke\"");
    }
  });
});

function extractExecutableSmoke(text: string): string {
  const match = text.match(/Executable smoke:\s*```sh\n(?<script>[\s\S]*?)\n```/);
  if (!match?.groups?.script) throw new Error("missing executable smoke shell block");
  return match.groups.script;
}
