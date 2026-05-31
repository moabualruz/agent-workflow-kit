import type { AgentFunction } from "./domain";

type JsonSchemaLike = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
};

export const schemaDefaultAgent: AgentFunction = async (_prompt, options) => {
  if (options?.schema) return defaultForSchema(options.schema);
  return { ok: true };
};

function defaultForSchema(schema: unknown): unknown {
  if (!isSchema(schema)) return { ok: true };
  if (schema.enum?.length) return schema.enum[0];

  const type = firstType(schema.type);
  if (type === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      output[key] = defaultForSchema(value);
    }
    return output;
  }
  if (type === "array") return [];
  if (type === "string") return "";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;

  return { ok: true };
}

function firstType(type: JsonSchemaLike["type"]): string | undefined {
  if (Array.isArray(type)) return type[0];
  return type;
}

function isSchema(value: unknown): value is JsonSchemaLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
