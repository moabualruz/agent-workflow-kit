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
};

const DEFAULT_CONFIG: WorkflowKitConfig = {
  ultracode: false,
};

export function configPath(projectRoot: string): string {
  return join(projectRoot, ".agent-workflow-kit", "config.json");
}

export function readConfig(projectRoot: string): WorkflowKitConfig {
  const path = configPath(projectRoot);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkflowKitConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, ultracode: parsed.ultracode === true };
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

export type UltracodeResult = {
  ultracode: boolean;
  action: UltracodeAction;
  path: string;
};

// Apply an ultracode toggle action and return the resulting state.
export function setUltracode(projectRoot: string, action: UltracodeAction): UltracodeResult {
  const current = readConfig(projectRoot);
  const path = configPath(projectRoot);
  if (action === "status") return { ultracode: current.ultracode, action, path };
  const next = writeConfig(projectRoot, { ...current, ultracode: action === "on" });
  return { ultracode: next.ultracode, action, path };
}
