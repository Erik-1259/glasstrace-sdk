import { describe, it, expect } from "vitest";
import { isHelpInvocation } from "../../../../packages/sdk/src/cli/init.js";

// DISC-1566: `glasstrace --help` and `glasstrace init --help` were
// running init's mutating path because the dispatcher routed any
// argv-2 starting with `-` to init. The fix short-circuits help
// detection BEFORE subcommand routing. These tests pin the detection
// helper directly; the dispatcher's behavior is exercised at module
// load via `process.argv` but is not directly testable from inside
// vitest because the dispatcher runs in the if-isDirectExecution
// block which is gated on `process.argv[1]`.
describe("isHelpInvocation (DISC-1566)", () => {
  it("returns true for `--help` alone", () => {
    expect(isHelpInvocation(["--help"])).toBe(true);
  });

  it("returns true for `-h` alone", () => {
    expect(isHelpInvocation(["-h"])).toBe(true);
  });

  it("returns true when help follows a subcommand: `init --help`", () => {
    expect(isHelpInvocation(["init", "--help"])).toBe(true);
  });

  it("returns true when help follows `mcp add`: `mcp add --help`", () => {
    expect(isHelpInvocation(["mcp", "add", "--help"])).toBe(true);
  });

  it("returns true for the composite case `init --yes --help`", () => {
    // The user asked for help; help is what they get. The `--yes`
    // is ignored.
    expect(isHelpInvocation(["init", "--yes", "--help"])).toBe(true);
  });

  it("returns true when `-h` is positioned anywhere in the slice", () => {
    expect(isHelpInvocation(["init", "-h", "--yes"])).toBe(true);
    expect(isHelpInvocation(["mcp", "add", "-h"])).toBe(true);
  });

  it("returns false for empty argv (bare `glasstrace` invocation)", () => {
    expect(isHelpInvocation([])).toBe(false);
  });

  it("returns false for `init` alone", () => {
    expect(isHelpInvocation(["init"])).toBe(false);
  });

  it("returns false for `init --yes` (no help flag)", () => {
    expect(isHelpInvocation(["init", "--yes"])).toBe(false);
  });

  it("returns false for `mcp add --force` (similar-shape but not help)", () => {
    expect(isHelpInvocation(["mcp", "add", "--force"])).toBe(false);
  });

  it("does not match substring matches like `--helper` or `--help-me`", () => {
    // Pin exact-match semantics so a future flag named `--helper`
    // cannot accidentally short-circuit init.
    expect(isHelpInvocation(["--helper"])).toBe(false);
    expect(isHelpInvocation(["--help-me"])).toBe(false);
    expect(isHelpInvocation(["init", "--helpfile"])).toBe(false);
  });

  it("does not match `-help` (single-dash long form is not a help flag)", () => {
    // Standard CLI conventions: `--help` (long) or `-h` (short). A
    // single-dash `-help` is non-canonical and we do not treat it as
    // help; it will fall through to subcommand routing as before.
    expect(isHelpInvocation(["-help"])).toBe(false);
  });
});
