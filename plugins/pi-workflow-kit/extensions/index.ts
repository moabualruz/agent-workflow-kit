import {
  createAliasModelPolicy,
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  parseModelAliases,
  projectUltracodeDisplay,
  projectWorkflowDisplay,
  type UltracodeResult,
  workflowCommandCatalog,
  workflowCommandToolInputSchema,
  type WorkflowCatalogEntry,
  type WorkflowCommandInputKey,
  type WorkflowRun,
} from "../../../packages/core/src/index";

type PiCommand = {
  name: string;
  description: string;
  inputKey?: WorkflowCommandInputKey;
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
  registerMessageRenderer?: (customType: string, renderer: (entry: unknown) => string[]) => void;
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
  host?.registerMessageRenderer?.("agent-workflow-kit.workflow", renderWorkflowMessage);

  return {
    name: "pi-workflow-kit",
    commands,
    tools,
  };
}

function createPiCommands(): PiCommand[] {
  return workflowCommandCatalog.map((command) => {
    const piCommand: PiCommand = {
      name: command.name,
      description: command.description.everywhere,
      run: async (input) => present(await dispatchWorkflowCommand(service(input), command.name, input ?? {})),
    };
    if (command.inputKey) piCommand.inputKey = command.inputKey;
    return piCommand;
  });
}

function createPiTools(): PiTool[] {
  return workflowCommandCatalog.map((command) => toolDefinition(
    command.toolName,
    command.title,
    command.description.everywhere,
    schemaFor(command),
    (input) => dispatchWorkflowCommand(service(input), command.name, input),
  ));
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
      const details = present(await run(input));
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
    modelPolicy: createAliasModelPolicy(parseModelAliases(process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES)),
  });
}

function commandInput(args: unknown, key: WorkflowCommandInputKey | undefined): Record<string, unknown> | undefined {
  if (!key) return undefined;
  if (typeof args === "object" && args !== null) return args as Record<string, unknown>;
  return { [key]: args };
}

function schemaFor(command: WorkflowCatalogEntry) {
  return workflowCommandToolInputSchema(command);
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function present(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(present);
  if (isUltracodeResult(value)) {
    return {
      ...value,
      display: projectUltracodeDisplay(value),
    };
  }
  if (!isRunLike(value)) return value;
  return {
    ...value,
    display: projectWorkflowDisplay(value, []),
  };
}

function renderWorkflowMessage(entry: unknown): string[] {
  const data = isRecord(entry) && "data" in entry ? entry.data : entry;
  if (!isRecord(data)) return ["workflow result unavailable"];
  const display = isRecord(data.display) ? data.display : undefined;
  const actions = Array.isArray(display?.actions)
    ? display.actions
      .filter((action): action is { id: string; enabled: boolean } => isRecord(action) && typeof action.id === "string" && action.enabled === true)
      .map((action) => action.id)
    : [];
  return [
    [data.runId, data.name, data.status].filter(Boolean).join(" "),
    `summary: ${typeof display?.summary === "string" ? display.summary : "no progress"}`,
    `actions: ${actions.join(", ") || "none"}`,
  ];
}

function isRunLike(value: unknown): value is WorkflowRun {
  return isRecord(value) && typeof value.runId === "string" && typeof value.name === "string" && typeof value.status === "string";
}

function isUltracodeResult(value: unknown): value is UltracodeResult {
  return isRecord(value) &&
    typeof value.ultracode === "boolean" &&
    typeof value.standingOptIn === "boolean" &&
    typeof value.keywordTriggerEnabled === "boolean" &&
    isRecord(value.effort) &&
    typeof value.path === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
