import { describe, expect, test } from "bun:test";
import { formatEventLine } from "../src/workflows-view";

describe("workflow event formatting", () => {
  test("prints logical model names as tiers", () => {
    expect(formatEventLine({
      type: "agent:start",
      label: "triage",
      model: "sonnet",
    })).toContain("tier=sonnet");
  });

  test("prints actual provider models as models", () => {
    expect(formatEventLine({
      type: "agent:start",
      label: "triage",
      model: "gpt-5.4",
    })).toContain("model=gpt-5.4");
  });

  test("includes requested model when aliases resolve to provider models", () => {
    expect(formatEventLine({
      type: "agent:start",
      label: "triage",
      model: "provider/fast-worker",
      requestedModel: "haiku",
    })).toContain("model=provider/fast-worker requested=haiku");
  });
});
