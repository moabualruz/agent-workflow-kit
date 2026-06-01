// Hand-rolled JSON Schema validator covering the subset Agent Workflow Kit uses:
// type (incl. unions), enum, required, properties, items, and the basic numeric/
// string constraints. Zero external dependencies, matching the thin-core ethos.
// For full JSON Schema compliance, an adapter can layer Ajv on top instead.

export type JsonSchemaLike = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike | JsonSchemaLike[];
  additionalProperties?: boolean | JsonSchemaLike;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  nullable?: boolean;
};

export type SchemaValidationResult = { valid: true } | { valid: false; errors: string[] };

export function validateAgainstSchema(value: unknown, schema: unknown): SchemaValidationResult {
  if (!isSchema(schema)) return { valid: true };
  const errors: string[] = [];
  walk(value, schema, "$", errors);
  return errors.length ? { valid: false, errors } : { valid: true };
}

function walk(value: unknown, schema: JsonSchemaLike, path: string, errors: string[]): void {
  if (value === null && schema.nullable === true && schema.const === undefined && schema.enum === undefined) return;

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
      errors.push(`${path}: value is not one of ${JSON.stringify(schema.enum)}`);
    }
    return;
  }

  const types = normalizeTypes(schema.type);
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path}: expected type ${types.join("|")}, got ${describe(value)}`);
    return;
  }

  const hasObjectConstraints = Boolean(
    schema.required?.length ||
    Object.keys(schema.properties ?? {}).length ||
    schema.additionalProperties !== undefined,
  );
  const hasArrayConstraints = Boolean(schema.items || schema.minItems !== undefined || schema.maxItems !== undefined);
  const hasNumberConstraints = schema.minimum !== undefined || schema.maximum !== undefined;
  const hasStringConstraints = schema.minLength !== undefined || schema.maxLength !== undefined;
  // When `type` is omitted, infer the constrained type from the constraint keys
  // so numeric/string/object/array bounds still apply.
  const effectiveType = types.find((type) => matchesType(value, type))
    ?? (hasObjectConstraints ? "object" : undefined)
    ?? (hasArrayConstraints ? "array" : undefined)
    ?? (hasNumberConstraints ? "number" : undefined)
    ?? (hasStringConstraints ? "string" : undefined);

  if (effectiveType === "object") {
    if (!isRecord(value)) {
      errors.push(`${path}: expected type object, got ${describe(value)}`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required property missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) walk(value[key], sub, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) errors.push(`${path}.${key}: additional property not allowed`);
      }
    } else if (isSchema(schema.additionalProperties)) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) walk(value[key], schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }

  if (effectiveType === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected type array, got ${describe(value)}`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items`);
    }
    if (Array.isArray(schema.items)) {
      schema.items.forEach((itemSchema, i) => {
        if (i < value.length) walk(value[i], itemSchema, `${path}[${i}]`, errors);
      });
    } else if (schema.items) {
      const itemSchema = schema.items;
      value.forEach((item, i) => walk(item, itemSchema, `${path}[${i}]`, errors));
    }
  }

  if (effectiveType === "number" || effectiveType === "integer") {
    // An inferred numeric type (no explicit `type`) is only reached here when no
    // declared type matched, so a wrong-typed value must error rather than
    // silently skip the bounds checks — mirroring the object/array branches.
    if (typeof value !== "number") {
      errors.push(`${path}: expected type ${effectiveType}, got ${describe(value)}`);
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (effectiveType === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected type string, got ${describe(value)}`);
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
}

function normalizeTypes(type: JsonSchemaLike["type"]): string[] {
  if (type === undefined) return [];
  return Array.isArray(type) ? type : [type];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isSchema(value: unknown): value is JsonSchemaLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return ak.length === bk.length && ak.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}
