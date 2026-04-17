import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  runValidate,
  hasGlasstraceImport,
  hasRegisterGlasstraceImport,
} from "../../../../packages/sdk/src/cli/validate.js";

let tempDirs: string[] = [];

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-validate-test-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("hasGlasstraceImport", () => {
  it("detects any import from @glasstrace/sdk", () => {
    expect(
      hasGlasstraceImport(
        'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      ),
    ).toBe(true);
  });

  it("returns false when no @glasstrace/sdk reference is present", () => {
    expect(hasGlasstraceImport('import { foo } from "bar";')).toBe(false);
  });
});

describe("hasRegisterGlasstraceImport", () => {
  it("detects registerGlasstrace as a sole import specifier", () => {
    expect(
      hasRegisterGlasstraceImport(
        'import { registerGlasstrace } from "@glasstrace/sdk";',
      ),
    ).toBe(true);
  });

  it("detects registerGlasstrace among multiple specifiers", () => {
    expect(
      hasRegisterGlasstraceImport(
        'import { withGlasstraceConfig, registerGlasstrace } from "@glasstrace/sdk";',
      ),
    ).toBe(true);
  });

  it("returns false when only other specifiers are imported from the SDK", () => {
    expect(
      hasRegisterGlasstraceImport(
        'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      ),
    ).toBe(false);
  });

  it("returns false when the SDK is not imported at all", () => {
    expect(hasRegisterGlasstraceImport("// no imports")).toBe(false);
  });
});

describe("runValidate", () => {
  it("returns exit code 0 and empty issues when no artifacts exist", () => {
    const projectRoot = createTmpProject();
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.summary[0]).toMatch(/consistent/);
  });

  it("reports glasstrace-dir-without-register-import when .glasstrace/ exists but instrumentation is missing the import", () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      "export function register() { /* no-op */ }\n",
    );
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "glasstrace-dir-without-register-import",
    );
  });

  it("reports the same issue when instrumentation.ts is missing entirely", () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "glasstrace-dir-without-register-import",
    );
  });

  it("reports sdk-import-without-glasstrace-dir when instrumentation still references the SDK after dir removal", () => {
    const projectRoot = createTmpProject();
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
    );
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "sdk-import-without-glasstrace-dir",
    );
  });

  it("reports mcp-marker-without-configs when marker exists but no MCP configs", () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    fs.writeFileSync(
      path.join(projectRoot, ".glasstrace", "mcp-connected"),
      JSON.stringify({ keyHash: "sha256:abc", configuredAt: "2026-04-17" }),
    );
    // Also satisfy the register import so we isolate the MCP issue.
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
    );
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "mcp-marker-without-configs",
    );
  });

  it("reports mcp-configs-without-marker when .mcp.json exists but marker does not", () => {
    const projectRoot = createTmpProject();
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { glasstrace: { type: "http" } } }),
    );
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "mcp-configs-without-marker",
    );
  });

  it("returns multiple issues when multiple inconsistencies are present", () => {
    const projectRoot = createTmpProject();
    // .glasstrace exists but instrumentation has no register import
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      "export function register() { /* no-op */ }\n",
    );
    // and MCP config exists without a marker
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { glasstrace: {} } }),
    );
    const result = runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("glasstrace-dir-without-register-import");
    expect(codes).toContain("mcp-configs-without-marker");
  });

  it("every issue includes a non-empty fix suggestion", () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    const result = runValidate({ projectRoot });
    for (const issue of result.issues) {
      expect(issue.fix.length).toBeGreaterThan(0);
    }
  });
});
