import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverTestFiles,
  extractImports,
  buildImportGraph,
} from "../../../packages/sdk/src/import-graph.js";

describe("discoverTestFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-graph-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .test.ts files", async () => {
    fs.writeFileSync(path.join(tmpDir, "app.test.ts"), "test('works', () => {})");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("app.test.ts");
  });

  it("finds .test.tsx files", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "component.test.tsx"),
      "test('renders', () => {})",
    );

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("component.test.tsx");
  });

  it("finds .spec.ts files", async () => {
    fs.writeFileSync(path.join(tmpDir, "util.spec.ts"), "describe('util', () => {})");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("util.spec.ts");
  });

  it("finds .spec.tsx files", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "widget.spec.tsx"),
      "describe('widget', () => {})",
    );

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("widget.spec.tsx");
  });

  it("finds files in __tests__ directories", async () => {
    fs.mkdirSync(path.join(tmpDir, "__tests__"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "__tests__", "helper.ts"),
      "test('helper', () => {})",
    );

    const files = await discoverTestFiles(tmpDir);
    expect(files.some((f) => f.includes("__tests__"))).toBe(true);
  });

  it("excludes node_modules", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "pkg", "index.test.ts"),
      "test()",
    );
    fs.writeFileSync(path.join(tmpDir, "app.test.ts"), "test()");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("app.test.ts");
  });

  it("excludes .next directory", async () => {
    fs.mkdirSync(path.join(tmpDir, ".next", "cache"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".next", "cache", "test.test.ts"),
      "test()",
    );
    fs.writeFileSync(path.join(tmpDir, "app.test.ts"), "test()");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("app.test.ts");
  });

  it("globToRegExp escapes regex metacharacters in custom patterns", async () => {
    // Pattern with metacharacters: parentheses, plus signs, question marks
    fs.writeFileSync(
      path.join(tmpDir, "vitest.config.ts"),
      `export default { test: { include: ["src/(tests)/**/*.ts"] } }`,
    );
    fs.mkdirSync(path.join(tmpDir, "src", "(tests)"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "(tests)", "foo.ts"), "test()");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("src/(tests)/foo.ts");
  });

  it("discovers custom test patterns from vitest.config.ts", async () => {
    // Write a vitest config with custom include patterns
    fs.writeFileSync(
      path.join(tmpDir, "vitest.config.ts"),
      `export default { test: { include: ["e2e/**/*.ts"] } }`,
    );
    // Create a test file matching the custom pattern but not conventional names
    fs.mkdirSync(path.join(tmpDir, "e2e"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "e2e", "login.ts"), "test()");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("e2e/login.ts");
  });

  it("merges custom patterns with defaults", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "vitest.config.ts"),
      `export default { test: { include: ["e2e/**/*.ts"] } }`,
    );
    // Conventional test file
    fs.writeFileSync(path.join(tmpDir, "app.test.ts"), "test()");
    // Custom pattern file
    fs.mkdirSync(path.join(tmpDir, "e2e"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "e2e", "flow.ts"), "test()");

    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("app.test.ts");
    expect(files).toContain("e2e/flow.ts");
  });

  it("falls back to defaults when no config exists", async () => {
    fs.writeFileSync(path.join(tmpDir, "app.test.ts"), "test()");
    const files = await discoverTestFiles(tmpDir);
    expect(files).toContain("app.test.ts");
  });

  it("error case: empty project returns empty array", async () => {
    const files = await discoverTestFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("error case: non-existent directory returns empty array", async () => {
    const files = await discoverTestFiles(
      path.join(tmpDir, "nonexistent"),
    );
    expect(files).toEqual([]);
  });

  it("finds nested test files", async () => {
    fs.mkdirSync(path.join(tmpDir, "src", "utils"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "utils", "helper.test.ts"),
      "test()",
    );

    const files = await discoverTestFiles(tmpDir);
    // Use POSIX forward slashes — discoverTestFiles normalizes to POSIX
    expect(files).toContain("src/utils/helper.test.ts");
  });
});

describe("extractImports", () => {
  it("extracts ES module imports with single quotes", () => {
    const content = `import { foo } from './foo';`;
    const imports = extractImports(content);
    expect(imports).toContain("./foo");
  });

  it("extracts ES module imports with double quotes", () => {
    const content = `import { bar } from "./bar";`;
    const imports = extractImports(content);
    expect(imports).toContain("./bar");
  });

  it("extracts default imports", () => {
    const content = `import React from 'react';`;
    const imports = extractImports(content);
    expect(imports).toContain("react");
  });

  it("extracts namespace imports", () => {
    const content = `import * as utils from '../utils';`;
    const imports = extractImports(content);
    expect(imports).toContain("../utils");
  });

  it("extracts side-effect imports", () => {
    const content = `import './setup';`;
    const imports = extractImports(content);
    expect(imports).toContain("./setup");
  });

  it("extracts CommonJS requires with single quotes", () => {
    const content = `const fs = require('fs');`;
    const imports = extractImports(content);
    expect(imports).toContain("fs");
  });

  it("extracts CommonJS requires with double quotes", () => {
    const content = `const path = require("path");`;
    const imports = extractImports(content);
    expect(imports).toContain("path");
  });

  it("extracts multiple imports from file", () => {
    const content = `
import { foo } from './foo';
import bar from './bar';
const baz = require('baz');
`;
    const imports = extractImports(content);
    expect(imports).toContain("./foo");
    expect(imports).toContain("./bar");
    expect(imports).toContain("baz");
  });

  it("boundary: empty file returns empty array", () => {
    const imports = extractImports("");
    expect(imports).toEqual([]);
  });

  it("boundary: file with no imports returns empty array", () => {
    const content = `const x = 5;\nconsole.log(x);`;
    const imports = extractImports(content);
    expect(imports).toEqual([]);
  });

  it("handles dynamic imports", () => {
    const content = `const mod = await import('./dynamic');`;
    const imports = extractImports(content);
    expect(imports).toContain("./dynamic");
  });

  it("extracts multiline destructured imports", () => {
    const content = `import {\n  foo,\n  bar,\n  baz\n} from './multiline';`;
    const imports = extractImports(content);
    expect(imports).toContain("./multiline");
  });

  it("handles pathological input without excessive backtracking", () => {
    // Regression test for CodeQL js/polynomial-redos. The original regex
    // used [\w*{}\s,]+ which caused polynomial backtracking on inputs
    // with many whitespace/word characters before a non-matching suffix.
    const content = "import " + "{ ".repeat(200) + "x";
    const start = Date.now();
    extractImports(content);
    const elapsed = Date.now() - start;
    // Should complete in well under 2 seconds (linear time). The old
    // vulnerable regex could take minutes on this input. Using 2000ms
    // threshold to avoid flaky failures on slow CI runners while still
    // catching polynomial-time regressions.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("buildImportGraph", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-build-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds graph mapping test files to imports", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "app.test.ts"),
      `import { render } from './app';\nimport { screen } from '@testing-library/react';`,
    );

    const result = await buildImportGraph(tmpDir);
    expect(result.graph["app.test.ts"]).toBeDefined();
    expect(result.graph["app.test.ts"]).toContain("./app");
    expect(result.graph["app.test.ts"]).toContain("@testing-library/react");
  });

  it("includes buildHash in result", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "a.test.ts"),
      `import { x } from './x';`,
    );

    const result = await buildImportGraph(tmpDir);
    expect(result.buildHash).toBeTruthy();
    expect(typeof result.buildHash).toBe("string");
  });

  it("buildHash is deterministic", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "a.test.ts"),
      `import { x } from './x';`,
    );

    const result1 = await buildImportGraph(tmpDir);
    const result2 = await buildImportGraph(tmpDir);
    expect(result1.buildHash).toBe(result2.buildHash);
  });

  it("error case: empty project returns empty graph", async () => {
    const result = await buildImportGraph(tmpDir);
    expect(result.graph).toEqual({});
    expect(result.buildHash).toBeTruthy();
  });

  it("handles cyclic imports without infinite loop", async () => {
    // Two test files importing each other — buildImportGraph must not hang
    fs.writeFileSync(
      path.join(tmpDir, "a.test.ts"),
      `import { b } from './b.test';`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "b.test.ts"),
      `import { a } from './a.test';`,
    );

    const result = await buildImportGraph(tmpDir);
    expect(result.graph["a.test.ts"]).toContain("./b.test");
    expect(result.graph["b.test.ts"]).toContain("./a.test");
  });

  it("error case: unreadable test file is skipped", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "good.test.ts"),
      `import { x } from './x';`,
    );
    // Create a directory with same pattern - can't be read as file
    fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "sub", "bad.test.ts"),
      `import { y } from './y';`,
    );
    // Make it unreadable
    try {
      fs.chmodSync(path.join(tmpDir, "sub", "bad.test.ts"), 0o000);
      const result = await buildImportGraph(tmpDir);
      // Should still include the good file
      expect(result.graph["good.test.ts"]).toBeDefined();
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(path.join(tmpDir, "sub", "bad.test.ts"), 0o644);
    }
  });

  it("validates against ImportGraphPayloadSchema shape", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "a.test.ts"),
      `import { x } from './x';`,
    );

    const result = await buildImportGraph(tmpDir);
    expect(result).toHaveProperty("buildHash");
    expect(result).toHaveProperty("graph");
    expect(typeof result.buildHash).toBe("string");
    expect(typeof result.graph).toBe("object");
  });
});
