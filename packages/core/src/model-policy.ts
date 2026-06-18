export type ModelResolution = {
  model: string;
  requestedModel?: string;
};

export type ModelPolicy = {
  resolveModel: (model: string) => ModelResolution;
};

export const CODEX_LOGICAL_MODEL_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
const DEFAULT_CODEX_LOGICAL_MODEL = "gpt-5.5";

export function defaultCodexModelAliases(): Record<string, string> {
  const model = process.env.AGENT_WORKFLOW_KIT_CODEX_LOGICAL_MODEL?.trim() || DEFAULT_CODEX_LOGICAL_MODEL;
  return Object.fromEntries(CODEX_LOGICAL_MODEL_TIERS.map((tier) => [tier, model]));
}

export function createAliasModelPolicy(aliases: Record<string, string>): ModelPolicy {
  return {
    resolveModel(model: string): ModelResolution {
      const resolved = aliases[model]?.trim();
      if (!resolved || resolved === model) return { model };
      return {
        model: resolved,
        requestedModel: model,
      };
    },
  };
}

export function parseModelAliases(value: string | undefined): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!value?.trim()) return aliases;

  for (const entry of value.split(",")) {
    const [alias, ...modelParts] = entry.split("=");
    const model = modelParts.join("=").trim();
    if (!alias?.trim() || !model) throw new Error("model alias entries must be alias=model");
    aliases[alias.trim()] = model;
  }

  return aliases;
}
