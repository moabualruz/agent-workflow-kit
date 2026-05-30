import { createWorkflowCommandService } from "../../../packages/core/src/index";

type PiCommand = {
  name: string;
  description: string;
  run: (input?: Record<string, unknown>) => unknown | Promise<unknown>;
};

type PiTool = {
  name: string;
  description: string;
  run: (input?: Record<string, unknown>) => unknown | Promise<unknown>;
};

type PiHost = {
  registerCommand?: (command: PiCommand) => void;
  registerTool?: (tool: PiTool) => void;
};

export default function workflowKitExtension(host?: PiHost) {
  const commands = createPiCommands();
  const tools = createPiTools();

  for (const command of commands) host?.registerCommand?.(command);
  for (const tool of tools) host?.registerTool?.(tool);

  return {
    name: "pi-workflow-kit",
    commands,
    tools,
  };
}

function createPiCommands(): PiCommand[] {
  return [
    {
      name: "workflow",
      description: "Run an ad hoc no-write workflow for a task.",
      run: (input) => service(input).runAdHocWorkflow(requireText(input?.task, "workflow requires task")),
    },
    {
      name: "workflow-run",
      description: "Run a saved Agent Workflow Kit workflow.",
      run: (input) => service(input).runSavedWorkflow(requireText(input?.workflow, "workflow-run requires workflow")),
    },
    {
      name: "workflow-status",
      description: "Read workflow run status from persisted state.",
      run: (input) => service(input).getRun(requireText(input?.runId, "workflow-status requires runId")),
    },
    {
      name: "workflow-resume",
      description: "Resume a stopped workflow record without deleting artifacts.",
      run: (input) => service(input).resumeRun(requireText(input?.runId, "workflow-resume requires runId")),
    },
    {
      name: "workflow-stop",
      description: "Stop a workflow record while keeping it resumable.",
      run: (input) => service(input).stopRun(requireText(input?.runId, "workflow-stop requires runId")),
    },
    {
      name: "workflows",
      description: "List persisted workflow runs without transcript spam.",
      run: (input) => service(input).listRuns(),
    },
    {
      name: "deep-research",
      description: "Run the bundled deep-research workflow.",
      run: (input) => service(input).runDeepResearch(requireText(input?.question, "deep-research requires question")),
    },
  ];
}

function createPiTools(): PiTool[] {
  return [
    { name: "workflow_run", description: "Run a saved workflow.", run: (input) => service(input).runSavedWorkflow(requireText(input?.workflow, "workflow_run requires workflow")) },
    { name: "workflow_status", description: "Read workflow status.", run: (input) => service(input).getRun(requireText(input?.runId, "workflow_status requires runId")) },
    { name: "workflow_resume", description: "Resume a workflow.", run: (input) => service(input).resumeRun(requireText(input?.runId, "workflow_resume requires runId")) },
    { name: "workflow_stop", description: "Stop a workflow.", run: (input) => service(input).stopRun(requireText(input?.runId, "workflow_stop requires runId")) },
    { name: "workflows", description: "List workflow runs.", run: (input) => service(input).listRuns() },
    { name: "deep_research", description: "Run deep research.", run: (input) => service(input).runDeepResearch(requireText(input?.question, "deep_research requires question")) },
  ];
}

function service(input?: Record<string, unknown>) {
  return createWorkflowCommandService({
    projectRoot: readText(input?.projectRoot) ?? process.cwd(),
  });
}

function requireText(value: unknown, message: string): string {
  const text = readText(value);
  if (!text) throw new Error(message);
  return text;
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
