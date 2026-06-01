import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCommandService, readConfig, setUltracode } from "../src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ultracode config toggle", () => {
  test("defaults to off and persists explicit on/off", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);

    expect(readConfig(projectRoot).ultracode).toBe(false);
    expect(setUltracode(projectRoot, "status").ultracode).toBe(false);

    const on = setUltracode(projectRoot, "on");
    expect(on.ultracode).toBe(true);
    expect(existsSync(on.path)).toBe(true);
    expect(JSON.parse(readFileSync(on.path, "utf8")).ultracode).toBe(true);
    expect(readConfig(projectRoot).ultracode).toBe(true);

    expect(setUltracode(projectRoot, "off").ultracode).toBe(false);
    expect(readConfig(projectRoot).ultracode).toBe(false);
  });

  test("status does not create config and does not flip the flag", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);

    const result = setUltracode(projectRoot, "status");
    expect(result.ultracode).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });

  test("service ultracode command toggles and validates the action", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    expect(service.ultracode("on")).toEqual(expect.objectContaining({ ultracode: true, action: "on" }));
    expect(service.ultracode("status")).toEqual(expect.objectContaining({ ultracode: true, action: "status" }));
    expect(service.ultracode("off")).toEqual(expect.objectContaining({ ultracode: false, action: "off" }));
    expect(() => service.ultracode("nonsense")).toThrow("ultracode requires one of: on, off, status");
  });
});
