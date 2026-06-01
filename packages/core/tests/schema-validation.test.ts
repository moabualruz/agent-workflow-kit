import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../src/index";

describe("validateAgainstSchema", () => {
  test("accepts a conforming object and reports nested errors otherwise", () => {
    const schema = {
      type: "object",
      required: ["items", "decision", "count"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        decision: { type: "string", enum: ["skip", "run"] },
        count: { type: "integer" },
      },
    };

    expect(validateAgainstSchema({ items: ["a"], decision: "run", count: 2 }, schema)).toEqual({ valid: true });

    const bad = validateAgainstSchema({ items: [1], decision: "maybe", count: 2.5 }, schema);
    expect(bad.valid).toBe(false);
    if (!bad.valid) {
      expect(bad.errors.some((e) => e.includes("items[0]"))).toBe(true);
      expect(bad.errors.some((e) => e.includes("decision"))).toBe(true);
      expect(bad.errors.some((e) => e.includes("count"))).toBe(true);
    }
  });

  test("required missing property is reported", () => {
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const result = validateAgainstSchema({}, schema);
    expect(result.valid).toBe(false);
  });

  test("type unions and null are honored", () => {
    const schema = { type: ["string", "null"] };
    expect(validateAgainstSchema("x", schema)).toEqual({ valid: true });
    expect(validateAgainstSchema(null, schema)).toEqual({ valid: true });
    expect(validateAgainstSchema(5, schema).valid).toBe(false);
  });

  test("additionalProperties:false rejects unknown keys", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    expect(validateAgainstSchema({ a: "ok" }, schema)).toEqual({ valid: true });
    expect(validateAgainstSchema({ a: "ok", b: 1 }, schema).valid).toBe(false);
  });

  test("object constraints apply when type is omitted", () => {
    const schema = {
      required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };

    expect(validateAgainstSchema({ name: "ok" }, schema)).toEqual({ valid: true });
    expect(validateAgainstSchema({}, schema).valid).toBe(false);
    expect(validateAgainstSchema({ name: 1 }, schema).valid).toBe(false);
    expect(validateAgainstSchema({ name: "ok", extra: true }, schema).valid).toBe(false);
  });

  test("nullable accepts null without requiring an explicit null type", () => {
    expect(validateAgainstSchema(null, { type: "string", nullable: true })).toEqual({ valid: true });
    expect(validateAgainstSchema(1, { type: "string", nullable: true }).valid).toBe(false);
  });

  test("nullable does not bypass explicit const or enum constraints", () => {
    expect(validateAgainstSchema(null, { const: null, nullable: true })).toEqual({ valid: true });
    expect(validateAgainstSchema(null, { const: "x", nullable: true }).valid).toBe(false);
    expect(validateAgainstSchema(null, { enum: [null], nullable: true })).toEqual({ valid: true });
    expect(validateAgainstSchema(null, { enum: ["x"], nullable: true }).valid).toBe(false);
  });

  test("unknown schema types reject instead of silently accepting typos", () => {
    expect(validateAgainstSchema("ok", { type: "strng" }).valid).toBe(false);
    expect(validateAgainstSchema("ok", { type: ["strng"] }).valid).toBe(false);
    expect(validateAgainstSchema("ok", { type: ["strng", "string"] })).toEqual({ valid: true });
  });

  test("schema-valued additionalProperties and tuple items are validated", () => {
    const additionalSchema = {
      type: "object",
      properties: { known: { type: "string" } },
      additionalProperties: { type: "integer" },
    };
    expect(validateAgainstSchema({ known: "ok", count: 2 }, additionalSchema)).toEqual({ valid: true });
    expect(validateAgainstSchema({ known: "ok", count: "2" }, additionalSchema).valid).toBe(false);

    const tupleSchema = { type: "array", items: [{ type: "string" }, { type: "integer" }] };
    expect(validateAgainstSchema(["a", 1], tupleSchema)).toEqual({ valid: true });
    expect(validateAgainstSchema(["a", "b"], tupleSchema).valid).toBe(false);
  });

  test("numeric and string constraints apply when type is omitted", () => {
    expect(validateAgainstSchema(5, { minimum: 1, maximum: 10 })).toEqual({ valid: true });
    expect(validateAgainstSchema(0, { minimum: 1 }).valid).toBe(false);
    expect(validateAgainstSchema(99, { maximum: 10 }).valid).toBe(false);

    expect(validateAgainstSchema("ok", { minLength: 1, maxLength: 5 })).toEqual({ valid: true });
    expect(validateAgainstSchema("", { minLength: 1 }).valid).toBe(false);
    expect(validateAgainstSchema("toolong", { maxLength: 3 }).valid).toBe(false);
  });

  test("a non-schema returns valid (no constraint)", () => {
    expect(validateAgainstSchema({ anything: true }, undefined)).toEqual({ valid: true });
  });
});
