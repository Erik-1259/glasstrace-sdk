/**
 * Init wiring tests for the DISC-1127 static discovery file.
 *
 * These tests target the helpers and summary lines added to `runInit`:
 *
 *   - `gitignoreExcludesDiscoveryFile` recognizes common exclusion
 *     patterns for `public/.well-known/glasstrace.json` (and the
 *     SvelteKit `static/.well-known/glasstrace.json` equivalent).
 *   - Negation rules (`!.well-known/...`) are respected.
 *   - Comments and blank lines do not trigger false matches.
 */
import { describe, it, expect } from "vitest";
import { gitignoreExcludesDiscoveryFile } from "../../../../packages/sdk/src/cli/init.js";

describe("gitignoreExcludesDiscoveryFile", () => {
  it("returns false for an empty .gitignore", () => {
    expect(gitignoreExcludesDiscoveryFile("", "public")).toBe(false);
  });

  it("returns false for a .gitignore with only unrelated entries", () => {
    const content = "node_modules/\ndist/\n.env.local\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const content = "# private\n\n# .well-known/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(false);
  });

  it("detects exact path exclusion for public layout", () => {
    expect(
      gitignoreExcludesDiscoveryFile(
        "public/.well-known/glasstrace.json\n",
        "public",
      ),
    ).toBe(true);
  });

  it("detects exact path exclusion for static layout", () => {
    expect(
      gitignoreExcludesDiscoveryFile(
        "static/.well-known/glasstrace.json\n",
        "static",
      ),
    ).toBe(true);
  });

  it("detects parent-directory exclusion (public/.well-known/)", () => {
    expect(
      gitignoreExcludesDiscoveryFile("public/.well-known/\n", "public"),
    ).toBe(true);
  });

  it("detects top-level .well-known/ exclusion", () => {
    expect(gitignoreExcludesDiscoveryFile(".well-known/\n", "public")).toBe(true);
  });

  it("detects static-root parent exclusion (public/)", () => {
    // Ignoring the static root directory itself transitively excludes
    // the discovery file nested under it. Users who ignore `public/`
    // wholesale must see a warning because the file will be missing in
    // deployed builds.
    expect(gitignoreExcludesDiscoveryFile("public/\n", "public")).toBe(true);
    expect(gitignoreExcludesDiscoveryFile("public\n", "public")).toBe(true);
  });

  it("detects static-root parent exclusion (static/) for SvelteKit", () => {
    expect(gitignoreExcludesDiscoveryFile("static/\n", "static")).toBe(true);
    expect(gitignoreExcludesDiscoveryFile("static\n", "static")).toBe(true);
  });

  it("detects leading-slash anchored paths", () => {
    expect(
      gitignoreExcludesDiscoveryFile(
        "/public/.well-known/glasstrace.json\n",
        "public",
      ),
    ).toBe(true);
  });

  it("detects any-depth wildcard patterns (**/.well-known/)", () => {
    expect(
      gitignoreExcludesDiscoveryFile("**/.well-known/\n", "public"),
    ).toBe(true);
  });

  it("respects file-level negation that matches a file-level ignore", () => {
    const content =
      "public/.well-known/glasstrace.json\n" +
      "!public/.well-known/glasstrace.json\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(false);
  });

  it("file-level negation cannot lift a parent-directory ignore (git semantics)", () => {
    // Per `gitignore(5)`: "It is not possible to re-include a file if a
    // parent directory of that file is excluded." The warning must still
    // fire even though a `!file` line appears later.
    const content =
      ".well-known/\n!public/.well-known/glasstrace.json\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(true);
  });

  it("file-level negation cannot lift an ignored static-root parent", () => {
    const content = "public/\n!public/.well-known/glasstrace.json\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(true);
  });

  it("parent-level negation does lift an ignored parent (same scope)", () => {
    const content = ".well-known/\n!public/.well-known/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(false);
  });

  it("scope-2 negation cannot re-include from a scope-1 ignored static root", () => {
    // `public/` is a broader ignore than `!public/.well-known/`, and git
    // does not descend into ignored parents to honor nested negations.
    // The warning must still fire.
    const content = "public/\n!public/.well-known/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(true);
  });

  it("root-level negation does not lift a distinct .well-known ignore", () => {
    // `.well-known/` matches `public/.well-known/` (any-depth). `!public/`
    // re-includes the `public/` dir itself, but the `.well-known/` rule
    // still matches `public/.well-known/`, so the file remains ignored.
    // `git check-ignore -v` confirms the ignore is still in effect.
    const content = ".well-known/\n!public/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(true);
  });

  it("same-scope negation lifts a scope-1 ignore", () => {
    const content = "public/\n!public/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(false);
  });

  it("directory-level negation does not lift a file-level ignore", () => {
    // `git check-ignore` still reports the file as ignored when a
    // file-specific ignore pattern appears before a broader directory
    // negation — the directory negation matches the directory path, not
    // the file path, so it does not override the file-specific rule.
    const content =
      "public/.well-known/glasstrace.json\n!public/.well-known/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(true);
  });

  it("root-level .well-known negation does not lift a file-level ignore", () => {
    const content = "public/.well-known/glasstrace.json\n!.well-known/\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(true);
  });

  it("file-level negation lifts a file-level ignore", () => {
    // The scope-3 negation matches the file path directly, so it does
    // override the earlier file-specific ignore.
    const content =
      "public/.well-known/glasstrace.json\n" +
      "!public/.well-known/glasstrace.json\n";
    expect(gitignoreExcludesDiscoveryFile(content, "public")).toBe(false);
  });

  it("does not match unrelated similarly-named paths", () => {
    expect(
      gitignoreExcludesDiscoveryFile("well-known/\n", "public"),
    ).toBe(false);
    expect(
      gitignoreExcludesDiscoveryFile("other/.well-known/\n", "public"),
    ).toBe(false);
  });
});
