# DISC-1563 audit — sync `require("node:*")` ESM-reachability

**Wave:** 10 (item 10G).
**Audit date:** 2026-05-04.
**Audit branch:** `wave10/10G-require-audit`.
**Audit base commit:** `2f2e3f3` (`chore: version packages (#222)`).
**Recon artifact:** `recon-10G-DISC-1563.md` (gitignored; lives in `/tmp/recon-10G-DISC-1563.md` for the agent that produced this PR).
**Discovery:** [`DISC-1563`](https://github.com/Erik-1259/glasstrace/blob/main/docs/discoveries/DISC-1563.md) (private repo).
**Failure mode:** [`DISC-1555`](https://github.com/Erik-1259/glasstrace/blob/main/docs/discoveries/DISC-1555.md) (private repo) — tsup CJS-compatibility shim throws "Dynamic require of '<spec>' is not supported" when the SDK is loaded as an ESM module and a sync `require("node:*")` call is reached.

## Scope

- All synchronous `require("node:*")` call sites in `packages/sdk/src/` reachable from the SDK's ESM entry point (`packages/sdk/src/index.ts`).
- The chained-call shape `createRequire(import.meta.url)("node:*")` is treated as the same failure mode for preventive purposes (the lint rule below flags it; no current code uses it).
- Async `await import("node:*")` is **out of scope** — it lowers to a real ESM dynamic import in tsup's bundled output and is unaffected by the `__require` shim.

## Method

1. Anchored grep for the call shape: `git grep -nP 'require\("node:[^"]+"\)' -- 'packages/sdk/src/'`.
2. Grep for adjacent shapes that can re-enter the failure mode: `git grep -nE "createRequire|require\(.*node.*\+|import\(.*node:" -- 'packages/sdk/src/'`.
3. For each call site, read the owning function and the surrounding `try/catch`; classify the catch behavior.
4. Walk the import graph from `index.ts` and `node-entry.ts` to confirm reachability.
5. For each site, locate or note the absence of a regression test that mocks the `node:*` specifier to throw on import.

The recon artifact captures the verbatim grep output and import-graph trace.

## Inventory

Two grep matches are JSDoc/comment text, not call sites: `atomic-write.ts:551` and `runtime-state.ts:56`. The remaining seven matches are real synchronous `require("node:*")` calls:

| # | File | Line | Specifier | Owner function | Reachable from `index.ts`? | Reachable from `edge-entry.ts`? | Classification |
|---|---|---|---|---|---|---|---|
| 1 | `packages/sdk/src/atomic-write.ts` | 203 | `node:fs` | `loadFsSync()` (DISC-1555 probe) | yes (via `init-client.js -> atomic-write.js`) | no | **safe** — wrapped in try/catch that caches `null`, then surfaces a clean named `Error` on subsequent calls. Wave 8 8D (DISC-1555) confirmed correctness end-to-end. |
| 2 | `packages/sdk/src/heartbeat.ts` | 154 | `node:fs` | `checkShutdownMarker()` | yes (via `register.js -> heartbeat.js`) | no | **safe** — try/catch (line 152) returns `{ triggered: false }`, identical to the no-marker branch. |
| 3 | `packages/sdk/src/heartbeat.ts` | 156 | `node:path` | `checkShutdownMarker()` | yes | no | **safe** — same try/catch as (2). |
| 4 | `packages/sdk/src/init-client.ts` | 62 | `node:fs` | `loadFsSyncOrNull()` | yes (`loadCachedConfig` is re-exported from `index.ts:91`) | no | **safe** — try/catch returns `null`; consumers (`loadCachedConfig`) treat as no cached config. |
| 5 | `packages/sdk/src/init-client.ts` | 64 | `node:path` | `loadFsSyncOrNull()` | yes | no | **safe** — same try/catch as (4). |
| 6 | `packages/sdk/src/nudge/error-nudge.ts` | 32 | `node:fs` | `markerFileExists()` | yes (via `capture-error.js`, `console-capture.js`, `enriching-exporter.js`) | no | **safe** — try/catch returns `false`; the nudge proceeds as if the marker were absent. |
| 7 | `packages/sdk/src/nudge/error-nudge.ts` | 34 | `node:path` | `markerFileExists()` | yes | no | **safe** — same try/catch as (6). |

DISC-1563's filing-time table named only sites (1) and (4)/(5); the 500-pass review for the wave plan found that (2)/(3) (`heartbeat.ts`) and (6)/(7) (`nudge/error-nudge.ts`) had been omitted. This audit explicitly classifies all seven.

## Classification breakdown

- **safe:** 7
- **at-risk:** 0
- **fixed-in-Wave-8 (DISC-1555):** 1 — site (1), the `atomic-write.loadFsSync` probe whose Wave 8 8D fix introduced the canonical `isSyncFsAvailable()` consumer pattern. The probe itself was already safe pre-Wave-8; the fix was on the consumer side (`runtime-state.ts:77`). It is listed here because the audit's purpose is to confirm coverage, and site (1) belongs in the inventory.
- **needs-fix:** 0

The DISC-1563 wording "audit complete; no other sites at risk" applies. The audit closes DISC-1563.

## Test coverage status (per site)

| Site | ESM-unavailable test | Test file:line |
|---|---|---|
| `atomic-write.ts:203` | yes | `tests/unit/sdk/runtime-state-fs-availability.test.ts:41-92` |
| `heartbeat.ts:154,156` | **added in this PR** | `tests/unit/sdk/non-node-resilience.test.ts` (`heartbeat checkShutdownMarker without node:fs` describe block) |
| `init-client.ts:62,64` | yes | `tests/unit/sdk/non-node-resilience.test.ts` (`init-client without node:fs` describe block) |
| `nudge/error-nudge.ts:32,34` | yes | `tests/unit/sdk/non-node-resilience.test.ts` (`error-nudge without node:fs` describe block) |

Before this PR, three of the four owners had dedicated coverage; `heartbeat.checkShutdownMarker` was correct by inspection but untested. The test added in this PR pins the `{ triggered: false }` contract against an `node:fs is unavailable` simulation indistinguishable from the production tsup `__require` throw.

## Path chosen

**Path C** (recommended in plan §4.10G): preventive ESLint rule + CONTRIBUTING.md discipline entry, plus the heartbeat regression test.

The audit found zero defects, so the change set is purely preventive:

1. **Custom ESLint rule** `glasstrace/no-unguarded-node-require` — `eslint-rules/no-unguarded-node-require.js`. Flags every sync `require("node:*")` and `createRequire(import.meta.url)("node:*")` in `packages/sdk/src/`. Wired in `eslint.config.js` under a scoped plugin namespace. Each existing call site disables the rule with an `eslint-disable-next-line glasstrace/no-unguarded-node-require -- <reason>` comment that names the guard pattern in plain English. The disable comment is the audit trail; future contributors must reach for it consciously, which forces the conversation about ESM-loader compatibility.
2. **Rule unit tests** — `tests/unit/eslint/no-unguarded-node-require.test.ts`. Uses ESLint's `RuleTester`. Covers four invalid call shapes (sync `require("node:fs")`, `node:path`, `node:crypto`, `node:fs/promises`, plus `createRequire(import.meta.url)("node:fs")`) and seven valid shapes (async `import("node:*")`, non-Node specifiers, non-literal arguments, etc.). Confirms no false positives at the four shipped call sites.
3. **CONTRIBUTING.md section** — "Synchronous `require("node:*")` discipline". Explains the failure mode and the four-step author checklist (wrap in try/catch with benign fallback, add a regression test, disable the rule with a named reason, prefer async `import` when possible).
4. **Heartbeat regression test** — `tests/unit/sdk/non-node-resilience.test.ts` (added describe block). Mocks `node:fs` and `node:path` to throw on import, asserts `checkShutdownMarker` returns `{ triggered: false }` and does not throw.

## Conductor escalation

§0.D abort criterion: more than 3 at-risk sites. Found 0. **No escalation.**

## DISC IDs reserved by the wave plan

The plan reserved `DISC-1586..DISC-1590` (5 IDs) for at-risk site filings. **All five reserved IDs are unused** because the audit found zero at-risk sites. The conductor should release them back to the pool when compiling the Wave 10 tally.

## Files changed by the Path C ship

- `eslint.config.js` — registers the `glasstrace` plugin and applies `glasstrace/no-unguarded-node-require: error` to `packages/sdk/src/**/*.{ts,tsx,js,mjs,cjs}`.
- `eslint-rules/no-unguarded-node-require.js` — new file; the rule.
- `packages/sdk/src/atomic-write.ts` — adds the new rule to the existing `eslint-disable-next-line` directive at line 202; rationale comment.
- `packages/sdk/src/heartbeat.ts` — same treatment for lines 153 and 155.
- `packages/sdk/src/init-client.ts` — same treatment for lines 61 and 63.
- `packages/sdk/src/nudge/error-nudge.ts` — same treatment for lines 31 and 33.
- `tests/unit/eslint/no-unguarded-node-require.test.ts` — new file; rule unit tests.
- `tests/unit/sdk/non-node-resilience.test.ts` — adds the heartbeat ESM-unavailable describe block.
- `CONTRIBUTING.md` — adds the discipline section before "Reporting Issues".
- `audit-DISC-1563.md` — this file.

No `packages/sdk/src/` runtime behaviour changes. The published bundle is byte-identical to `1.3.2` aside from the JSDoc comment changes inside the four call sites' disable directives. Tree-shake-friendly: no new exports, no new module-load-time work.

## Changeset

Patch bump on `@glasstrace/sdk`. The published-package change is documentation-tier (JSDoc comment text inside `eslint-disable-next-line` directives — these survive the build because they sit on lines that ship in the bundled output). Test additions and lint config do not ship in the package. The bump signals that the audit closed DISC-1563 and the preventive lint rule is in place.

## Audit completion

DISC-1563's "preventive checklist or lint rule that flags new synchronous `require("node:*")` introductions" is satisfied by Path C. The discovery should be flipped to RESOLVED with a citation to this audit (single-line bookkeeping flip in glasstrace-product, not in this PR).
