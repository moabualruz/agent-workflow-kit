import type { WorkflowCommandService } from "./command-service";
import type { WorkflowArgs } from "./domain";
import { requireInputText } from "./errors";

export type WorkflowCommandInputKey = "task" | "workflow" | "runId" | "question";
export type WorkflowCommandArgumentMode = "first" | "join";

export type WorkflowCommandSpec = {
  name: string;
  toolName: string;
  title: string;
  inputKey?: WorkflowCommandInputKey;
  argumentMode?: WorkflowCommandArgumentMode;
  acceptsArgs?: boolean;
  description: {
    everywhere: string;
  };
  dispatch: (service: WorkflowCommandService, input: Record<string, unknown>) => unknown | Promise<unknown>;
};

export const workflowCommandCatalog: readonly WorkflowCommandSpec[] = [
  {
    name: "workflow",
    toolName: "workflow",
    title: "Workflow",
    inputKey: "task",
    argumentMode: "join",
    description: {
      everywhere: "Run an ad hoc no-write workflow for a task.",
    },
    dispatch: (service, input) => service.runAdHocWorkflow(requireInputText(input.task, "workflow requires task")),
  },
  {
    name: "workflow-run",
    toolName: "workflow_run",
    title: "Workflow Run",
    inputKey: "workflow",
    argumentMode: "first",
    acceptsArgs: true,
    description: {
      everywhere: "Run a saved Agent Workflow Kit workflow.",
    },
    dispatch: (service, input) => service.runSavedWorkflow(
      requireInputText(input.workflow, "workflow-run requires workflow"),
      readWorkflowArgs(input.args),
    ),
  },
  {
    name: "workflow-status",
    toolName: "workflow_status",
    title: "Workflow Status",
    inputKey: "runId",
    argumentMode: "first",
    description: {
      everywhere: "Read workflow run status from persisted state.",
    },
    dispatch: (service, input) => service.getRun(requireInputText(input.runId, "workflow-status requires runId")),
  },
  {
    name: "workflow-events",
    toolName: "workflow_events",
    title: "Workflow Events",
    inputKey: "runId",
    argumentMode: "first",
    description: {
      everywhere: "Read workflow progress events from persisted state.",
    },
    dispatch: (service, input) => service.eventsFor(requireInputText(input.runId, "workflow-events requires runId")),
  },
  {
    name: "workflow-resume",
    toolName: "workflow_resume",
    title: "Workflow Resume",
    inputKey: "runId",
    argumentMode: "first",
    description: {
      everywhere: "Resume a stopped workflow record without deleting artifacts.",
    },
    dispatch: (service, input) => service.resumeRun(requireInputText(input.runId, "workflow-resume requires runId")),
  },
  {
    name: "workflow-stop",
    toolName: "workflow_stop",
    title: "Workflow Stop",
    inputKey: "runId",
    argumentMode: "first",
    description: {
      everywhere: "Stop a workflow record while keeping it resumable.",
    },
    dispatch: (service, input) => service.stopRun(requireInputText(input.runId, "workflow-stop requires runId")),
  },
  {
    name: "workflows",
    toolName: "workflows",
    title: "Workflows",
    description: {
      everywhere: "List persisted workflow runs without transcript spam.",
    },
    dispatch: (service) => service.listRuns(),
  },
  {
    name: "deep-research",
    toolName: "deep_research",
    title: "Deep Research",
    inputKey: "question",
    argumentMode: "join",
    description: {
      everywhere: "Run the bundled deep-research workflow.",
    },
    dispatch: (service, input) => service.runDeepResearch(requireInputText(input.question, "deep-research requires question")),
  },
] as const;

export type WorkflowCommandName = WorkflowCommandSpec["name"];
export type WorkflowToolName = WorkflowCommandSpec["toolName"];
export type WorkflowCatalogEntry = WorkflowCommandSpec;

export const workflowCommandNames = workflowCommandCatalog.map((command) => command.name);
export const workflowToolNames = workflowCommandCatalog.map((command) => command.toolName);

export function findWorkflowCommandSpec(name: string | undefined): WorkflowCatalogEntry | undefined {
  return workflowCommandCatalog.find((command) => command.name === name);
}

export async function dispatchWorkflowCommand(
  service: WorkflowCommandService,
  commandName: WorkflowCommandName,
  input: Record<string, unknown> = {},
): Promise<any> {
  const spec = findWorkflowCommandSpec(commandName);
  if (!spec) throw new Error(`Unknown workflow command: ${commandName}`);
  return spec.dispatch(service, input);
}

export function inputForCliArguments(spec: WorkflowCatalogEntry, positional: string[]): Record<string, unknown> {
  if (!spec.inputKey) return {};
  if (spec.argumentMode === "join") return { [spec.inputKey]: positional.join(" ").trim() };
  return { [spec.inputKey]: positional[0] ?? "" };
}

function readWorkflowArgs(value: unknown): WorkflowArgs {
  if (value === undefined) return {};
  if (isPlainRecord(value)) return value;
  throw new Error("workflow-run args must be a JSON object");
}

function isPlainRecord(value: unknown): value is WorkflowArgs {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
