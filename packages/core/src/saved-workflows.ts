import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowScript } from "./domain";

export type WorkflowScope = "project" | "personal";

export type SavedWorkflow = {
  scope?: WorkflowScope;
  name: string;
  script: WorkflowScript;
};

export type ResolvedWorkflowScript = {
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
  return (await resolveWorkflow(projectRoot, workflowName)).script;
}

export async function resolveWorkflow(projectRoot: string, workflowRef: string): Promise<ResolvedWorkflowScript> {
  const directPath = directWorkflowPath(projectRoot, workflowRef);
  if (directPath) {
    return {
      name: workflowNameFromPath(directPath),
      script: await loadWorkflowScript(directPath),
    };
  }

  assertWorkflowName(workflowRef);
  const workflowPath = findWorkflowFile(projectRoot, workflowRef);
  if (workflowPath) {
    return {
      name: workflowRef,
      script: await loadWorkflowScript(workflowPath),
    };
  }

  const builtIn = builtInWorkflows.get(workflowRef);
  if (builtIn) return { name: workflowRef, script: builtIn };

  throw new Error(`Unknown workflow: ${workflowRef}`);
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

function directWorkflowPath(projectRoot: string, workflowRef: string): string | undefined {
  if (!looksLikeScriptPath(workflowRef)) return undefined;
  const candidate = isAbsolute(workflowRef) ? workflowRef : resolve(projectRoot, workflowRef);
  return existsSync(candidate) ? candidate : undefined;
}

function looksLikeScriptPath(workflowRef: string): boolean {
  return workflowRef.endsWith(".js") && (workflowRef.includes("/") || workflowRef.startsWith("."));
}

function workflowNameFromPath(workflowPath: string): string {
  return basename(workflowPath).replace(/\.js$/, "");
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
