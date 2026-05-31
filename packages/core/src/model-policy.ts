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
