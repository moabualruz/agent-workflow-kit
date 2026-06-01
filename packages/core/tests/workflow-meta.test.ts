import { describe, expect, test } from "bun:test";
import { parseWorkflowMeta, phaseModelMap } from "../src/index";

describe("parseWorkflowMeta", () => {
  test("parses a valid pure-literal meta with phases and models", () => {
    const source = `export const meta = {
  name: "release-check",
  description: "Review release readiness",
  model: "sonnet",
  phases: [
    { title: "Review", model: "opus" },
    { title: "Fix", detail: "apply" }
  ]
};
phase("Review");
return { ok: true };`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.name).toBe("release-check");
      expect(result.meta.model).toBe("sonnet");
      expect(phaseModelMap(result.meta).get("Review")).toBe("opus");
      expect(phaseModelMap(result.meta).has("Fix")).toBe(false);
    }
  });

  test("rejects non-literal meta: variable reference", () => {
    const source = `const n = "x";\nexport const meta = { name: n, description: "d" };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
  });

  test("rejects non-literal meta: spread", () => {
    const source = `export const meta = { ...base, name: "x" };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("spread");
  });

  test("rejects non-literal meta: template string", () => {
    const source = "export const meta = { name: `x`, description: \"d\" };\nreturn {};";
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("template");
  });

  test("rejects non-literal meta: function call", () => {
    const source = `export const meta = { name: makeName(), description: "d" };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("function call");
  });

  test("rejects non-literal meta: member call bypass", () => {
    const source = `export const meta = { name: ["x"].join(""), description: "d" };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
  });

  test("rejects non-literal meta: parenthesized call bypass", () => {
    const source = `export const meta = { name: (makeName)(), description: "d" };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
  });

  test("allows punctuation inside string values (no false-positive on '(' / '...' )", () => {
    const source = `export const meta = {
  name: "report",
  description: "Summarize findings (and risks)... thoroughly",
  whenToUse: "use when the user says foo(bar) or mentions ..."
};
return {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.description).toBe("Summarize findings (and risks)... thoroughly");
      expect(result.meta.whenToUse).toBe("use when the user says foo(bar) or mentions ...");
    }
  });

  test("parses meta strings whose closing quote follows an escaped backslash", () => {
    const source = String.raw`export const meta = {
  name: "escaped-backslash",
  description: "path\\",
  whenToUse: "quoted value"
};
return {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.description).toBe("path\\");
    }
  });

  test("still rejects a real spread even when strings contain dots", () => {
    const source = `export const meta = { description: "a...b", ...base };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("spread");
  });

  test("still rejects a real call even when strings contain parens", () => {
    const source = `export const meta = { name: "n(x)", description: build() };\nreturn {};`;
    const result = parseWorkflowMeta(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("function call");
  });

  test("missing meta block is reported", () => {
    const result = parseWorkflowMeta(`phase("X");\nreturn {};`);
    expect(result.ok).toBe(false);
  });
});
