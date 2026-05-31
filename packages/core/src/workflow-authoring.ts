import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GeneratedWorkflow = {
  name: string;
  path: string;
};

export function saveGeneratedWorkflow(projectRoot: string, task: string): GeneratedWorkflow {
  const name = workflowNameForTask(task);
  const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
  const workflowPath = join(workflowsRoot, `${name}.js`);

  mkdirSync(workflowsRoot, { recursive: true });
  writeFileSync(workflowPath, renderGeneratedWorkflow(task));

  return { name, path: workflowPath };
}

export function workflowNameForTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return slug || "workflow";
}

function renderGeneratedWorkflow(task: string): string {
  return `const task = ${JSON.stringify(task)};

export default function ({ phase, log }) {
  phase("Workflow");
  log(\`task: \${task}\`);
  return { ok: true, task };
}
`;
}
