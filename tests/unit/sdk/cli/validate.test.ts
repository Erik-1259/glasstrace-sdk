import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import {
  runValidate,
  hasGlasstraceImport,
  hasRegisterGlasstraceImport,
} from "../../../../packages/sdk/src/cli/validate.js";

const TEST_ANON_KEY =
  "gt_anon_000102030405060708090a0b0c0d0e0f1011121314151617";

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
  it("detects any import from @glasstrace/sdk", async () => {
    expect(
      hasGlasstraceImport(
        'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      ),
    ).toBe(true);
  });

  it("returns false when no @glasstrace/sdk reference is present", async () => {
    expect(hasGlasstraceImport('import { foo } from "bar";')).toBe(false);
  });
});

describe("hasRegisterGlasstraceImport", () => {
  it("detects registerGlasstrace as a sole import specifier", async () => {
    expect(
      hasRegisterGlasstraceImport(
        'import { registerGlasstrace } from "@glasstrace/sdk";',
      ),
    ).toBe(true);
  });

  it("detects registerGlasstrace among multiple specifiers", async () => {
    expect(
      hasRegisterGlasstraceImport(
        'import { withGlasstraceConfig, registerGlasstrace } from "@glasstrace/sdk";',
      ),
    ).toBe(true);
  });

  it("returns false when only other specifiers are imported from the SDK", async () => {
    expect(
      hasRegisterGlasstraceImport(
        'import { withGlasstraceConfig } from "@glasstrace/sdk";',
      ),
    ).toBe(false);
  });

  it("returns false when the SDK is not imported at all", async () => {
    expect(hasRegisterGlasstraceImport("// no imports")).toBe(false);
  });
});

describe("runValidate", () => {
  it("returns exit code 0 and empty issues when no artifacts exist", async () => {
    const projectRoot = createTmpProject();
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(0);
    expect(result.issues).toEqual([]);
    expect(result.summary[0]).toMatch(/consistent/);
  });

  it("reports glasstrace-dir-without-register-import when .glasstrace/ exists but instrumentation is missing the import", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      "export function register() { /* no-op */ }\n",
    );
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "glasstrace-dir-without-register-import",
    );
  });

  it("reports the same issue when instrumentation.ts is missing entirely", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "glasstrace-dir-without-register-import",
    );
  });

  it("reports sdk-import-without-glasstrace-dir when instrumentation still references the SDK after dir removal", async () => {
    const projectRoot = createTmpProject();
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
    );
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "sdk-import-without-glasstrace-dir",
    );
  });

  it("reports mcp-marker-without-configs when marker exists but no MCP configs", async () => {
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
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "mcp-marker-without-configs",
    );
  });

  it("reports mcp-configs-without-marker when .mcp.json exists but marker does not", async () => {
    const projectRoot = createTmpProject();
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { glasstrace: { type: "http" } } }),
    );
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(
      "mcp-configs-without-marker",
    );
  });

  it("returns multiple issues when multiple inconsistencies are present", async () => {
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
    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("glasstrace-dir-without-register-import");
    expect(codes).toContain("mcp-configs-without-marker");
  });

  it("every issue includes a non-empty fix suggestion", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    const result = await runValidate({ projectRoot });
    for (const issue of result.issues) {
      expect(issue.fix.length).toBeGreaterThan(0);
    }
  });

  // Issue class 5: marker records a credential whose identity does not
  // match the project's currently-effective MCP credential. Catches the
  // DISC-1512 case where ingestion has moved to account/dev-key but the
  // managed MCP helper still embeds an anon bearer.

  it("does not flag mcp-helper-stale-credential when marker matches the resolver", async () => {
    const projectRoot = createTmpProject();
    const glassDir = path.join(projectRoot, ".glasstrace");
    fs.mkdirSync(glassDir);
    fs.writeFileSync(path.join(glassDir, "anon_key"), TEST_ANON_KEY);

    const anonHash = `sha256:${createHash("sha256").update(TEST_ANON_KEY).digest("hex")}`;
    fs.writeFileSync(
      path.join(glassDir, "mcp-connected"),
      JSON.stringify({
        version: 2,
        credentialSource: "anon",
        credentialHash: anonHash,
        configuredAt: "2026-05-01T00:00:00Z",
      }),
    );
    // Satisfy other classes so we isolate the new check.
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
    );
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { glasstrace: {} } }),
    );

    const result = await runValidate({ projectRoot });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("mcp-helper-stale-credential");
  });

  it("flags mcp-helper-stale-credential when .env.local has a dev key but marker still records anon", async () => {
    const projectRoot = createTmpProject();
    const glassDir = path.join(projectRoot, ".glasstrace");
    fs.mkdirSync(glassDir);
    fs.writeFileSync(path.join(glassDir, "anon_key"), TEST_ANON_KEY);

    const devKey = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(
      path.join(projectRoot, ".env.local"),
      `GLASSTRACE_API_KEY=${devKey}\n`,
    );

    const anonHash = `sha256:${createHash("sha256").update(TEST_ANON_KEY).digest("hex")}`;
    fs.writeFileSync(
      path.join(glassDir, "mcp-connected"),
      JSON.stringify({
        version: 2,
        credentialSource: "anon",
        credentialHash: anonHash,
        configuredAt: "2026-05-01T00:00:00Z",
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
    );
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { glasstrace: {} } }),
    );

    const result = await runValidate({ projectRoot });
    expect(result.exitCode).toBe(1);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("mcp-helper-stale-credential");

    // Suggested fix mentions `mcp add --force`.
    const issue = result.issues.find(
      (i) => i.code === "mcp-helper-stale-credential",
    );
    expect(issue?.fix).toMatch(/mcp add --force/);
  });

  it("does not flag mcp-helper-stale-credential when marker is absent", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    fs.writeFileSync(
      path.join(projectRoot, ".glasstrace", "anon_key"),
      TEST_ANON_KEY,
    );
    fs.writeFileSync(
      path.join(projectRoot, "instrumentation.ts"),
      'import { registerGlasstrace } from "@glasstrace/sdk";\nexport function register() { registerGlasstrace(); }\n',
    );

    const result = await runValidate({ projectRoot });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("mcp-helper-stale-credential");
  });
});
