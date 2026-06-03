import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";
import {
  createAliasModelPolicy,
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  parseModelAliases,
  workflowCommandCatalog,
  workflowCommandToolInputs,
  type PermissionPolicy,
  type WorkflowPermissionRequest,
  type WorkflowCatalogEntry,
  type WorkflowCommandToolInputKind,
} from "../../../packages/core/src/index";

const WORKFLOW_PERMISSION = "agent-workflow-kit.workflow";

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
            service(readOptionalString(args.projectRoot), context.directory ?? projectRoot, context),
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

function service(projectRoot: string | undefined, fallbackRoot: string, context: ToolContext) {
  return createWorkflowCommandService({
    projectRoot: projectRoot?.trim() || fallbackRoot,
    modelPolicy: createAliasModelPolicy(parseModelAliases(process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES)),
    permissionPolicy: permissionPolicyForOpenCode(context),
  });
}

function toolArgs(command: WorkflowCatalogEntry) {
  return Object.fromEntries(workflowCommandToolInputs(command).map((input) => [
    input.name,
    input.required ? toolSchemaFor(input.kind) : toolSchemaFor(input.kind).optional(),
  ]));
}

function toolSchemaFor(kind: WorkflowCommandToolInputKind) {
  if (kind === "json") return tool.schema.unknown();
  if (kind === "boolean") return tool.schema.boolean();
  return tool.schema.string();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function permissionPolicyForOpenCode(context: Partial<Pick<ToolContext, "ask">>): PermissionPolicy | undefined {
  if (typeof context.ask !== "function") return undefined;
  return {
    async authorizeDynamicWorkflow(request) {
      try {
        await context.ask!(permissionAskInputFor(request));
        return { allowed: true };
      } catch (error) {
        return {
          allowed: false,
          reason: `OpenCode permission denied: ${errorMessage(error)}`,
        };
      }
    },
  };
}

function permissionAskInputFor(request: WorkflowPermissionRequest) {
  return {
    permission: WORKFLOW_PERMISSION,
    patterns: permissionPatternsFor(request),
    always: [WORKFLOW_PERMISSION],
    metadata: permissionMetadataFor(request),
  };
}

function permissionPatternsFor(request: WorkflowPermissionRequest): string[] {
  return [
    `workflow:${request.name}`,
    ...(request.scriptPath ? [`script:${request.scriptPath}`] : []),
    ...(request.origin ? [`origin:${request.origin}`] : []),
    ...request.writeHints.map((hint) => `write:${hint}`),
  ];
}

function permissionMetadataFor(request: WorkflowPermissionRequest): Record<string, unknown> {
  return {
    name: request.name,
    argsPreview: request.argsPreview,
    generated: request.generated,
    isolationHints: request.isolationHints,
    writeHints: request.writeHints,
    ...(request.scriptPath ? { scriptPath: request.scriptPath } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    ...(request.agentCountEstimate !== undefined ? { agentCountEstimate: request.agentCountEstimate } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
