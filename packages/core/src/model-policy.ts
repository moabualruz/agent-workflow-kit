export type ModelResolution = {
  model: string;
  requestedModel?: string;
  effort?: string;
};

export type ModelPolicy = {
  resolveModel: (model: string) => ModelResolution;
};

export const CODEX_LOGICAL_MODEL_TIERS = ["fable", "opus", "sonnet", "haiku"] as const;
const LOGICAL_TIER_EFFORT: Record<string, string> = {
  fable: "xhigh",
  opus: "high",
  sonnet: "high",
  haiku: "medium",
};
const DEFAULT_CODEX_LOGICAL_MODEL_ALIASES = {
  fable: "gpt-5.6-sol",
  opus: "gpt-5.6-sol",
  sonnet: "gpt-5.6-terra",
  haiku: "gpt-5.6-luna",
};

export function defaultCodexModelAliases(): Record<string, string> {
  // Retain the one-value override for existing callers while making the default
  // routing match the logical quality and cost tiers.
  const model = process.env.AGENT_WORKFLOW_KIT_CODEX_LOGICAL_MODEL?.trim();
  if (model) return Object.fromEntries(CODEX_LOGICAL_MODEL_TIERS.map((tier) => [tier, model]));
  return { ...DEFAULT_CODEX_LOGICAL_MODEL_ALIASES };
}

export function createAliasModelPolicy(aliases: Record<string, string>): ModelPolicy {
  return {
    resolveModel(model: string): ModelResolution {
      const resolved = aliases[model]?.trim();
      if (!resolved || resolved === model) return { model };
      return {
        model: resolved,
        requestedModel: model,
        ...(LOGICAL_TIER_EFFORT[model] ? { effort: LOGICAL_TIER_EFFORT[model] } : {}),
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
