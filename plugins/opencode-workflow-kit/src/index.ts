import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  createAliasModelPolicy,
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  parseModelAliases,
  workflowCommandCatalog,
  workflowCommandToolInputs,
  type WorkflowCatalogEntry,
  type WorkflowCommandToolInputKind,
} from "../../../packages/core/src/index";

export const server: Plugin = async (input) => {
  const projectRoot = input.directory || process.cwd();

  return {
    tool: Object.fromEntries(workflowCommandCatalog.map((command) => [
      command.toolName,
      tool({
        description: command.description.everywhere,
        args: toolArgs(command),
        async execute(args, context) {
          return stringify(await dispatchWorkflowCommand(
            service(readOptionalString(args.projectRoot), context.directory ?? projectRoot),
            command.name,
            args,
          ));
        },
      }),
    ])),
  };
};

export const workflowKitPlugin = {
  name: "opencode-workflow-kit",
  server,
};

export default workflowKitPlugin;

function service(projectRoot: string | undefined, fallbackRoot: string) {
  return createWorkflowCommandService({
    projectRoot: projectRoot?.trim() || fallbackRoot,
    modelPolicy: createAliasModelPolicy(parseModelAliases(process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES)),
  });
}

function toolArgs(command: WorkflowCatalogEntry) {
  return Object.fromEntries(workflowCommandToolInputs(command).map((input) => [
    input.name,
    input.required ? toolSchemaFor(input.kind) : toolSchemaFor(input.kind).optional(),
  ]));
}

function toolSchemaFor(kind: WorkflowCommandToolInputKind) {
  if (kind === "object") return tool.schema.record(tool.schema.string(), tool.schema.unknown());
  if (kind === "boolean") return tool.schema.boolean();
  return tool.schema.string();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
