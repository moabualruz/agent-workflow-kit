import {
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  workflowCommandCatalog,
  type WorkflowCatalogEntry,
  type WorkflowCommandInputKey,
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
  return workflowCommandCatalog.map((command) => {
    const piCommand: PiCommand = {
      name: command.name,
      description: command.description.everywhere,
      run: (input) => dispatchWorkflowCommand(service(input), command.name, input ?? {}),
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

function commandInput(args: unknown, key: WorkflowCommandInputKey | undefined): Record<string, unknown> | undefined {
  if (!key) return undefined;
  if (typeof args === "object" && args !== null) return args as Record<string, unknown>;
  return { [key]: args };
}

function schemaFor(command: WorkflowCatalogEntry) {
  const required = command.inputKey ? [command.inputKey] : [];
  const properties: Record<string, unknown> = { projectRoot: stringSchema() };
  if (command.inputKey) properties[command.inputKey] = stringSchema();
  return schema(required, properties);
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

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
