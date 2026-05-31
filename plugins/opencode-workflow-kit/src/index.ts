import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  createAliasModelPolicy,
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  parseModelAliases,
  workflowCommandCatalog,
  type WorkflowCatalogEntry,
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
  const args: Record<string, any> = {
    projectRoot: tool.schema.string().optional(),
  };
  if (command.inputKey) args[command.inputKey] = tool.schema.string();
  if (command.acceptsArgs) args.args = tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional();
  return args;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
