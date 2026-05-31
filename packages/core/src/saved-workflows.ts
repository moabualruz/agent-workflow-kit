import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowScript } from "./domain";

export type WorkflowScope = "project" | "personal";

export type SavedWorkflow = {
  scope?: WorkflowScope;
  name: string;
  script: WorkflowScript;
};

export function createMemoryWorkflowRegistry() {
  const entries = new Map<string, Required<SavedWorkflow>>();

  return {
    save(workflow: SavedWorkflow): void {
      const scope = workflow.scope ?? "project";
      entries.set(`${scope}:${workflow.name}`, { ...workflow, scope });
    },

    resolve(request: { name: string }): Required<SavedWorkflow> {
      const project = entries.get(`project:${request.name}`);
      if (project) return project;

      const personal = entries.get(`personal:${request.name}`);
      if (personal) return personal;

      throw new Error(`Saved workflow not found: ${request.name}`);
    },
  };
}

export async function resolveWorkflowScript(projectRoot: string, workflowName: string): Promise<WorkflowScript> {
  assertWorkflowName(workflowName);
  const workflowPath = findWorkflowFile(projectRoot, workflowName);
  if (workflowPath) return loadWorkflowScript(workflowPath);

  const builtIn = builtInWorkflows.get(workflowName);
  if (builtIn) return builtIn;

  throw new Error(`Unknown workflow: ${workflowName}`);
}

const builtInWorkflows = new Map<string, WorkflowScript>([
  [
    "no-write-probe",
    async ({ phase, agent, log }) => {
      phase("Probe");
      log("no-write probe entered");
      return agent("Return exact JSON {\"ok\":true}");
    },
  ],
]);

function findWorkflowFile(projectRoot: string, workflowName: string): string | undefined {
  const candidates = [
    join(projectRoot, ".agent-workflow-kit", "workflows", `${workflowName}.js`),
    join(projectRoot, ".claude", "workflows", `${workflowName}.js`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function loadWorkflowScript(workflowPath: string): Promise<WorkflowScript> {
  const module = await import(pathToFileURL(workflowPath).href);
  const script = module.default ?? module.workflow;
  if (typeof script !== "function") throw new Error(`Saved workflow must export a function: ${workflowPath}`);
  return script as WorkflowScript;
}

function assertWorkflowName(workflowName: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(workflowName)) throw new Error(`Invalid workflow name: ${workflowName}`);
}
