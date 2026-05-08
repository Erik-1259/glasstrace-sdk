---
"@glasstrace/sdk": minor
---

fix(sdk): CLI `--help` no longer mutates the project; static-discovery
write failure now exits non-zero (Wave 15A — DISC-1565 + DISC-1566)

## DISC-1566 — `glasstrace --help` runs init and mutates the project

Before this release, the CLI dispatcher routed any argv-2 starting
with `-` to init's mutating path. So `glasstrace --help`,
`glasstrace init --help`, and `glasstrace mcp add --help` all
silently ran init / mcp-add against the user's project — modifying
`instrumentation.ts`, `next.config`, `.env.local`, `.gitignore`,
agent-instruction files, and creating `.cursor/`, `AGENTS.md`,
`GEMINI.md` — without printing any help output.

This release adds an explicit help-flag short-circuit BEFORE
subcommand routing. Help invocations now print help text and exit
cleanly; the project is never mutated.

Detected variants:
- `glasstrace --help`
- `glasstrace -h`
- `glasstrace init --help`
- `glasstrace init -h`
- `glasstrace mcp add --help`
- composite invocations like `glasstrace init --yes --help` (the
  `--yes` is ignored — the user asked for help)

`-help` (single-dash long form, non-canonical) is intentionally NOT
treated as a help flag and falls through to subcommand routing as
before.

## DISC-1565 — `glasstrace init` reports success while failing to write static discovery file

Two fixes:

1. **Bin now points at the CJS build.** The `bin` field used to point
   at `dist/cli/init.js` (ESM). In ESM, `require` is undefined, so
   the `atomic-write.ts` lazy-loader's `require("node:fs")` threw
   a ReferenceError; that was caught and surfaced as
   `node:fs is unavailable in this environment;
   atomicWriteFileSync cannot be used here.` The `bin` now points
   at `dist/cli/init.cjs`, where `require` is the built-in. The
   static-discovery file is written successfully under the
   packaged-CLI runtime. The CJS bundle was already emitted by tsup;
   this change is bin-only.

2. **Defensive: partial-success exits non-zero.** Even with the
   primary fix, a discovery-file write may still fail for legitimate
   reasons (permissions, full disk, read-only filesystem). Init now
   tracks the write outcome and returns exit code `1` when the
   write fails. The dispatcher's success message
   ("Glasstrace initialized successfully!") is gated on
   `exitCode === 0`, so the misleading success line is suppressed
   on partial-success. CI and scripts wrapping `glasstrace init`
   see the failure via exit code without having to grep stderr.

## Behavior changes (semver-minor)

- **Exit code semantics:** `glasstrace init` now exits `1` when the
  static-discovery file write fails. Previously: exited `0` with a
  warning. **Affected:** users / CI scripts that interpret
  `glasstrace init` exit code. If you intentionally accept
  discovery-file write failures (e.g., environments without a
  writable static root), wrap the invocation:
  `glasstrace init || true`.
- **Output gating:** the `Glasstrace initialized successfully!`
  stderr line is now gated on `exitCode === 0`; it does not print
  on partial-success. **Affected:** any script grepping for that
  exact string. Prefer reading exit code instead.
- **`--help` behavior:** `glasstrace --help` etc. now print help and
  exit `0` without mutating the project. **Affected:** unlikely —
  any script depending on the prior bug to install Glasstrace via
  `glasstrace --help` should switch to `glasstrace init --yes`.

These are minor-bumped because they change observable CLI behavior
even though no exported API changed.

## Tests

13 new tests across two new files:

- `cli-help-dispatch.test.ts` (12 tests) — pin `isHelpInvocation`
  semantics across all six help-flag variants, the composite case,
  and the false-positive guards (`--helper`, `--help-me`,
  single-dash `-help`).
- `init-discovery-file-failure.test.ts` (1 test) — `runInit` returns
  exitCode `1` when `writeDiscoveryFile` reports `action: "failed"`;
  warning text preserved; error not double-pushed.

Pre-push gate: typecheck + lint + 2112 tests passing (up from 2099)
+ build (postbuild stamp gate passes for `1.6.1`-current).
