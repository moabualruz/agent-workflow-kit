import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  createWorkflowCommandService,
  dispatchWorkflowCommand,
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
  });
}

function toolArgs(command: WorkflowCatalogEntry) {
  const args: Record<string, any> = {
    projectRoot: tool.schema.string().optional(),
  };
  if (command.inputKey) args[command.inputKey] = tool.schema.string();
  return args;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
