export type ModelResolution = {
  model: string;
  requestedModel?: string;
};

export type ModelPolicy = {
  resolveModel: (model: string) => ModelResolution;
};

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
