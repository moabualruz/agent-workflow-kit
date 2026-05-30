import { createWorkflowCommandService } from "../../../packages/core/src/index";

type PiCommand = {
  name: string;
  description: string;
  inputKey?: "task" | "workflow" | "runId" | "question";
  run: (input?: Record<string, unknown>) => unknown | Promise<unknown>;
};

type PiTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
};

type PiHost = {
  registerCommand?: (name: string, command: { description: string; handler: (args?: string) => unknown | Promise<unknown> }) => void;
  registerTool?: (tool: PiTool) => void;
};

export default function workflowKitExtension(host?: PiHost) {
  const commands = createPiCommands();
  const tools = createPiTools();

  for (const command of commands) {
    host?.registerCommand?.(command.name, {
      description: command.description,
      handler: (args) => command.run(commandInput(args, command.inputKey)),
    });
  }
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
      inputKey: "task",
      run: (input) => service(input).runAdHocWorkflow(requireText(input?.task, "workflow requires task")),
    },
    {
      name: "workflow-run",
      description: "Run a saved Agent Workflow Kit workflow.",
      inputKey: "workflow",
      run: (input) => service(input).runSavedWorkflow(requireText(input?.workflow, "workflow-run requires workflow")),
    },
    {
      name: "workflow-status",
      description: "Read workflow run status from persisted state.",
      inputKey: "runId",
      run: (input) => service(input).getRun(requireText(input?.runId, "workflow-status requires runId")),
    },
    {
      name: "workflow-events",
      description: "Read workflow progress events from persisted state.",
      inputKey: "runId",
      run: (input) => service(input).eventsFor(requireText(input?.runId, "workflow-events requires runId")),
    },
    {
      name: "workflow-resume",
      description: "Resume a stopped workflow record without deleting artifacts.",
      inputKey: "runId",
      run: (input) => service(input).resumeRun(requireText(input?.runId, "workflow-resume requires runId")),
    },
    {
      name: "workflow-stop",
      description: "Stop a workflow record while keeping it resumable.",
      inputKey: "runId",
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
      inputKey: "question",
      run: (input) => service(input).runDeepResearch(requireText(input?.question, "deep-research requires question")),
    },
  ];
}

function createPiTools(): PiTool[] {
  return [
    toolDefinition(
      "workflow_run",
      "Workflow Run",
      "Run a saved workflow.",
      schema(["workflow"], { workflow: stringSchema(), projectRoot: stringSchema() }),
      (input) => service(input).runSavedWorkflow(requireText(input.workflow, "workflow_run requires workflow")),
    ),
    toolDefinition(
      "workflow_status",
      "Workflow Status",
      "Read workflow status.",
      schema(["runId"], { runId: stringSchema(), projectRoot: stringSchema() }),
      (input) => service(input).getRun(requireText(input.runId, "workflow_status requires runId")),
    ),
    toolDefinition(
      "workflow_events",
      "Workflow Events",
      "Read workflow progress events.",
      schema(["runId"], { runId: stringSchema(), projectRoot: stringSchema() }),
      (input) => service(input).eventsFor(requireText(input.runId, "workflow_events requires runId")),
    ),
    toolDefinition(
      "workflow_resume",
      "Workflow Resume",
      "Resume a workflow.",
      schema(["runId"], { runId: stringSchema(), projectRoot: stringSchema() }),
      (input) => service(input).resumeRun(requireText(input.runId, "workflow_resume requires runId")),
    ),
    toolDefinition(
      "workflow_stop",
      "Workflow Stop",
      "Stop a workflow.",
      schema(["runId"], { runId: stringSchema(), projectRoot: stringSchema() }),
      (input) => service(input).stopRun(requireText(input.runId, "workflow_stop requires runId")),
    ),
    toolDefinition(
      "workflows",
      "Workflows",
      "List workflow runs.",
      schema([], { projectRoot: stringSchema() }),
      (input) => service(input).listRuns(),
    ),
    toolDefinition(
      "deep_research",
      "Deep Research",
      "Run deep research.",
      schema(["question"], { question: stringSchema(), projectRoot: stringSchema() }),
      (input) => service(input).runDeepResearch(requireText(input.question, "deep_research requires question")),
    ),
  ];
}

function toolDefinition(
  name: string,
  label: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (input: Record<string, unknown>) => unknown | Promise<unknown>,
): PiTool {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, input) {
      const details = await run(input);
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

function service(input?: Record<string, unknown>) {
  return createWorkflowCommandService({
    projectRoot: readText(input?.projectRoot) ?? process.cwd(),
  });
}

function commandInput(args: unknown, key: PiCommand["inputKey"]): Record<string, unknown> | undefined {
  if (!key) return undefined;
  if (typeof args === "object" && args !== null) return args as Record<string, unknown>;
  return { [key]: args };
}

function schema(required: string[], properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema() {
  return { type: "string" };
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
