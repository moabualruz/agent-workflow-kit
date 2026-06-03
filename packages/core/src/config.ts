import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Project-level Agent Workflow Kit config, persisted under
// .agent-workflow-kit/config.json. Today it carries the explicit ultracode
// toggle; it is the home for future opt-in settings.
export type WorkflowKitConfig = {
  // When true, harness skills treat workflow authoring as a standing opt-in
  // (author + run a workflow per substantive task, bias to adversarial verify).
  // Off by default — ultracode is always an explicit, deliberate choice.
  ultracode: boolean;
  // Keyword trigger behavior is separate from standing opt-in. Claude renamed the
  // trigger to "ultracode"; this kit exposes the configured trigger state without
  // pretending it is the same as session effort.
  ultracodeKeywordTriggerEnabled: boolean;
  // This CLI cannot set model reasoning effort. "orchestration-only" records that
  // workflow orchestration is enabled while model effort remains harness-owned.
  ultracodeEffortMode: UltracodeEffortMode;
  // When true, dynamic workflow commands fail closed before script execution.
  // This mirrors Claude's disableWorkflows control at the kit/project level.
  disableWorkflows: boolean;
};

export type UltracodeEffortMode = "off" | "orchestration-only";
export type UltracodeOrchestrationStatus = "enabled" | "disabled";
export type WorkflowDisableReason = "managed policy" | "environment" | "user config" | "project config" | "session override";

export type WorkflowDisableControls = {
  managedDisableWorkflows?: boolean | undefined;
  homeRoot?: string | undefined;
  sessionDisableWorkflows?: boolean | undefined;
  env?: Record<string, string | undefined> | undefined;
};

const DEFAULT_CONFIG: WorkflowKitConfig = {
  ultracode: false,
  ultracodeKeywordTriggerEnabled: false,
  ultracodeEffortMode: "off",
  disableWorkflows: false,
};

export function configPath(projectRoot: string): string {
  return join(projectRoot, ".agent-workflow-kit", "config.json");
}

export function readConfig(projectRoot: string): WorkflowKitConfig {
  const path = configPath(projectRoot);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkflowKitConfig>;
    const ultracode = parsed.ultracode === true;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      ultracode,
      ultracodeKeywordTriggerEnabled: parsed.ultracodeKeywordTriggerEnabled === undefined
        ? ultracode
        : parsed.ultracodeKeywordTriggerEnabled === true,
      ultracodeEffortMode: parseUltracodeEffortMode(parsed.ultracodeEffortMode, ultracode),
      disableWorkflows: parsed.disableWorkflows === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(projectRoot: string, config: WorkflowKitConfig): WorkflowKitConfig {
  const path = configPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export type UltracodeAction = "on" | "off" | "status";
export type WorkflowDisableAction = "on" | "off" | "status";

export type UltracodeResult = {
  ultracode: boolean;
  standingOptIn: boolean;
  keywordTriggerEnabled: boolean;
  effortMode: UltracodeEffortMode;
  effort: {
    modelEffort: "unsupported";
    orchestration: UltracodeOrchestrationStatus;
  };
  disabledReason?: WorkflowDisableReason | undefined;
  action: UltracodeAction;
  path: string;
};

export type WorkflowDisableResult = {
  disableWorkflows: boolean;
  action: WorkflowDisableAction;
  path: string;
};

// Apply an ultracode toggle action and return the resulting state.
export function setUltracode(
  projectRoot: string,
  action: UltracodeAction,
  controls: WorkflowDisableControls = {},
): UltracodeResult {
  const current = readConfig(projectRoot);
  const path = configPath(projectRoot);
  if (action === "status") return ultracodeResult(projectRoot, current, action, path, controls);
  const enabled = action === "on";
  const next = writeConfig(projectRoot, {
    ...current,
    ultracode: enabled,
    ultracodeKeywordTriggerEnabled: enabled,
    ultracodeEffortMode: enabled ? "orchestration-only" : "off",
  });
  return ultracodeResult(projectRoot, next, action, path, controls);
}

export function setWorkflowsDisabled(projectRoot: string, action: WorkflowDisableAction): WorkflowDisableResult {
  const current = readConfig(projectRoot);
  const path = configPath(projectRoot);
  if (action === "status") return { disableWorkflows: current.disableWorkflows, action, path };
  const next = writeConfig(projectRoot, { ...current, disableWorkflows: action === "on" });
  return { disableWorkflows: next.disableWorkflows, action, path };
}

export function workflowDisableReason(
  projectRoot: string,
  controlsOrEnv: WorkflowDisableControls | Record<string, string | undefined> = {},
): WorkflowDisableReason | undefined {
  const controls = normalizeDisableControls(controlsOrEnv);
  const env = controls.env ?? process.env;
  if (controls.managedDisableWorkflows) return "managed policy";
  if (isTruthyDisableFlag(env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS) || isTruthyDisableFlag(env.CLAUDE_CODE_DISABLE_WORKFLOWS)) {
    return "environment";
  }
  if (controls.homeRoot && readConfig(controls.homeRoot).disableWorkflows) return "user config";
  if (readConfig(projectRoot).disableWorkflows) return "project config";
  if (controls.sessionDisableWorkflows) return "session override";
  return undefined;
}

function parseUltracodeEffortMode(value: unknown, ultracode: boolean): UltracodeEffortMode {
  if (value === "orchestration-only") return "orchestration-only";
  if (value === "off") return "off";
  return ultracode ? "orchestration-only" : "off";
}

function ultracodeResult(
  projectRoot: string,
  config: WorkflowKitConfig,
  action: UltracodeAction,
  path: string,
  controls: WorkflowDisableControls,
): UltracodeResult {
  const disabledReason = workflowDisableReason(projectRoot, controls);
  const orchestration = config.ultracode && !disabledReason ? "enabled" : "disabled";
  return {
    ultracode: config.ultracode,
    standingOptIn: config.ultracode,
    keywordTriggerEnabled: config.ultracodeKeywordTriggerEnabled && !disabledReason,
    effortMode: config.ultracodeEffortMode,
    effort: {
      modelEffort: "unsupported",
      orchestration,
    },
    ...(disabledReason ? { disabledReason } : {}),
    action,
    path,
  };
}

function normalizeDisableControls(
  value: WorkflowDisableControls | Record<string, string | undefined>,
): WorkflowDisableControls {
  if (Object.keys(value).length === 0) return {};
  if (
    "managedDisableWorkflows" in value ||
    "homeRoot" in value ||
    "sessionDisableWorkflows" in value ||
    "env" in value
  ) {
    return value as WorkflowDisableControls;
  }
  return { env: value as Record<string, string | undefined> };
}

function isTruthyDisableFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
