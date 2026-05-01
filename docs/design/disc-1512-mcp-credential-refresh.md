# DISC-1512 — MCP Credential Refresh: Wave A SDK Design

**Status:** Draft for review
**Discovery:** DISC-1512, filed in the private `glasstrace-product` repo. Not linked — the repo is private and a relative path would be unreachable from this public-repo context.
**Upstream wave plan:** filed alongside the discovery in `glasstrace-product` (private; not linked for the same reason).
**Wave:** A (SDK)
**Branch:** `docs/disc-1512-design` (this PR) → `fix/DISC-1512-mcp-credential-refresh` (implementation)

## Summary

DISC-1512 traces a benchmark MCP-vs-dashboard mismatch to a stale credential
in `.glasstrace/mcp.json`: when a project transitions from anon to
account/dev-key, MCP-managed configs continue to use the unclaimed anon
bearer, so MCP queries are scoped to anon rows while ingestion writes
account-scoped rows. Product MCP tenant scoping is doing what it should;
the fix belongs in the SDK.

This document resolves the four kickoff design choices the upstream wave
plan requires before Wave A coding begins, partitions implementation work
between the SDK runtime and CLI surfaces, and lists the test, packaging,
and cross-repo follow-up obligations that ride with the implementation
PR.

## D1 — Effective MCP credential resolver

A single resolver, `resolveEffectiveMcpCredential(projectRoot)`, is called
from the runtime claim-transition path, `glasstrace init`, and
`glasstrace mcp add`. It lives in a new runtime-safe module
`packages/sdk/src/mcp-runtime.ts` (no `agent-detection/*` or `cli/*`
imports — see D2.b for why).

```ts
// internal — not re-exported via node-entry.ts or index.ts
type EffectiveMcpCredential =
  | { source: "env-local";   key: DevApiKey }
  | { source: "claimed-key"; key: DevApiKey }
  | { source: "anon";        key: AnonApiKey };

type ResolveWarning =
  | "malformed-env-local"
  | "claimed-key-only";

interface ResolveResult {
  effective: EffectiveMcpCredential | null;
  anonKey: AnonApiKey | null;
  warnings: ReadonlyArray<ResolveWarning>;
}
```

Precedence (highest → lowest):

1. `.env.local` `GLASSTRACE_API_KEY`, parsed via existing
   `readEnvLocalApiKey` (`packages/sdk/src/cli/scaffolder.ts:733`,
   dotenv last-wins). The value is accepted only when
   `DevApiKeySchema.safeParse(value).success` is `true` — strict regex
   validation against `^gt_dev_[a-f0-9]{48}$`. The legacy `isDevApiKey`
   helper (`scaffolder.ts:753`) is a prefix check used elsewhere as a
   fast path for "looks like a claimed key, do not overwrite"; it is not
   strict enough for the resolver. A non-empty value that fails
   `safeParse` emits the `malformed-env-local` warning and falls
   through. An empty value (`GLASSTRACE_API_KEY=`) is silently absent —
   `readEnvLocalApiKey` already returns `null` for that case.
2. `.glasstrace/claimed-key`, read by a new `readClaimedKey` co-located
   with `readAnonKey` in `packages/sdk/src/anon-key.ts`. The file
   contents are validated with `DevApiKeySchema.safeParse`. When this is
   the only credential source available (no `.env.local` dev key), the
   resolver attaches `claimed-key-only` to the warnings array so the
   caller can prompt the user to copy the key into `.env.local` for
   normal use.
3. `.glasstrace/anon_key` via existing `readAnonKey`
   (`packages/sdk/src/anon-key.ts:43`).

The resolved `anonKey` is returned alongside `effective` so D2.a's
staleness check does not have to re-read the file.

**When the resolver runs:** the resolver is called only inside the
runtime claim-transition branch of `performInit`
(`packages/sdk/src/init-client.ts:449-457`, guarded by
`if (result.claimResult)`) and inside the CLI commands `glasstrace init`
and `glasstrace mcp add`. It is **not** invoked on the steady-state init
path, on every cold start, or on every request.

**Dev-key-only project handling:** `glasstrace mcp add` proceeds when
`effective !== null`, regardless of whether a `.glasstrace/anon_key`
file is present. The marker fingerprint (D3) uses the effective
credential's hash, not specifically the anon key.

**Public API surface:** `EffectiveMcpCredential`, `ResolveResult`, and
the resolver function are not re-exported from `node-entry.ts` or
`index.ts`. Internal only.

## D2 — Refresh policy: runtime vs CLI split

### D2.a — Staleness signal

A managed MCP config is "stale and SDK-owned" when both:

1. `effective.source !== "anon"` — the project has moved off anon.
2. `mcpConfigMatches(currentFileContent, generateMcpConfig(agent, MCP_ENDPOINT, anonKeyOnDisk))` is `true` — the file content is canonically-JSON-equivalent to the SDK-shaped output for the anon key currently on disk. The comparison is text-level, not byte-level: `mcpConfigMatches` (`scaffolder.ts:862-877`) parses both sides, sorts keys via `canonicalize`, then compares, so reformatted or reordered SDK-shaped configs are still recognised.

If both hold → rewrite with the effective credential. Otherwise →
preserve and emit a one-line warning naming the file. The existing
`mcpConfigMatches` helper (`scaffolder.ts:862-877`) already does
canonical-JSON structural comparison via `canonicalize`, so reformatted
or reordered SDK-shaped configs are still recognised. To make
`mcpConfigMatches` and `canonicalize` importable from runtime code
without crossing the runtime/CLI boundary, both functions are extracted
into `packages/sdk/src/mcp-runtime.ts`. `cli/scaffolder.ts` re-exports
them for one release to keep call-site churn bounded; the shim is
tagged for removal at the next stable release.

### D2.b — Runtime path (`init-client.ts`, claim transition)

Constraints: zero new imports from `agent-detection/*` or `cli/*` into
the runtime path. The runtime SDK is loaded into user processes at app
boot, and pulling `agent-detection` (which itself imports filesystem
scanners) into that bundle would inflate cold-start cost for a code
path that only matters at the moment of an account claim. A static
import-graph guard (see Test Plan) backstops this constraint.

1. `writeClaimedKey` returns `{ persisted: "env-local" | "claimed-key" | "none" }`. Caller switches with an exhaustive `never` check. Single existing call site at `init-client.ts:451`.
2. When `persisted !== "none"`, the caller invokes
   `refreshGenericMcpConfigAtRuntime(projectRoot, effective, anonKeyOnDisk)`,
   which returns:

   ```ts
   type RuntimeRefreshAction =
     | "rewrote"
     | "preserved"           // file exists but does not match SDK-shaped anon output
     | "absent"              // .glasstrace/mcp.json does not exist
     | "skipped-anon-source" // effective.source === "anon" — no work to do
     | "skipped-not-persisted"; // never reached in practice; caller gates
   ```

3. The helper:
   - Reads `.glasstrace/mcp.json`. On `ENOENT` → return `"absent"`. On other read error → log redacted, return `"preserved"`.
   - If the file matches SDK-shaped anon → write the replacement using inlined `node:fs/promises.writeFile` followed by `chmod 0o600`. `writeMcpConfig` from `agent-detection/inject.ts` is intentionally not imported — it would cross the runtime/CLI boundary. The inlined permissions match `agent-detection/inject.ts:62,76` exactly.
   - The marker file (D3) is updated **only after** a successful rewrite. On `"absent" | "preserved" | "skipped-*"`, the marker is not touched.
4. The entire refresh call is wrapped in its own try/catch in
   `performInit`. Refresh failure does not lose `claimResult`; on
   failure, a single redacted stderr line is emitted and the function
   still returns `{ claimResult }` so the caller can continue its
   normal post-claim flow.
5. The success nudge ("MCP config refreshed for the new credential") is
   deduplicated **per process** via a module-level flag. Cross-process
   dedup (the same user running `mcp add` in another terminal moments
   later) is explicitly out of scope.

### D2.c — CLI path (`init`, `mcp add`)

`cli/*` already imports `agent-detection/*`, so the per-agent refresh
helper lives in `cli/scaffolder.ts` as a new exported function
`refreshAllManagedMcpConfigs(projectRoot, resolveResult, agents)`. For
each detected agent, it applies the D2.a staleness rule and rewrites or
preserves accordingly. The marker is updated after a successful rewrite
of any managed config.

### D2.d — `registerViaCli` constraint

`packages/sdk/src/cli/mcp-add.ts:51-128` passes the bearer to vendor
CLIs (Claude, Gemini) as a process argument. Because process arguments
are visible via `ps`/proc on multi-user hosts, a `DevApiKey` must never
flow through this path. Two-layer enforcement:

1. **Compile-time:** `registerViaCli`'s `credential` parameter is typed
   `AnonApiKey`, the discriminated-union branch from D1. Call sites
   pass `effective.key` only when `effective.source === "anon"`.
2. **Runtime guard:** a new `isAnonApiKey(value): boolean` helper is
   added next to `isDevApiKey` in `cli/scaffolder.ts`, implemented as
   `AnonApiKeySchema.safeParse(value).success`. `registerViaCli`
   early-returns `false` if the guard fails. This defends against
   accidental `string`-typed call paths that erase the brand.

When the effective credential is a `DevApiKey`, `mcpAdd` skips
`registerViaCli` entirely and falls through to the file-config branch
(`mcp-add.ts:232-269`), which uses `writeMcpConfig` at `0o600`. Codex's
CLI path is unchanged because Codex never embeds the bearer — it writes
`bearer_token_env_var = "GLASSTRACE_API_KEY"` and reads the actual
token from the environment.

### D2.e — Failure semantics summary

| Trigger | Outcome |
|---|---|
| Claim succeeds, `persisted = "env-local"` | Runtime helper refreshes `.glasstrace/mcp.json` if SDK-shaped; agent-specific configs deferred to next CLI run; one nudge to stderr |
| Claim succeeds, `persisted = "claimed-key"` | Same; nudge tells user to copy `claimed-key` into `.env.local` so Codex can pick it up |
| Claim succeeds, `persisted = "none"` | **No MCP refresh.** `claimResult` still returned |
| Claim succeeds, refresh helper throws | `claimResult` still returned; single redacted stderr line |
| `mcp add` after claim, marker mismatch | User told to re-run with `--force`; `--force` rewrites all SDK-shaped agent configs |
| `mcp add` runs and effective credential is a `DevApiKey` | `registerViaCli` rejected at compile-time and at runtime; file-config path takes over |

## D3 — `.glasstrace/mcp-connected` marker v2

Today the marker is `{ keyHash, configuredAt }` (`scaffolder.ts:940-944`)
where `keyHash` is `identityFingerprint(anonKey)`
(`scaffolder.ts:13`, `sha256:<hex>`). v1 detects rotation of one anon
key but cannot detect the DISC-1512 case, where the marker hashes the
anon key correctly while the project has moved to an account
credential.

**v2 schema:**

```jsonc
{
  "version": 2,
  "credentialSource": "env-local" | "claimed-key" | "anon",
  "credentialHash": "<identityFingerprint output, e.g. \"sha256:<64 hex chars>\">",
  "configuredAt": "<ISO 8601>"
}
```

**Reader rules (deterministic, conservative on unknowns):**

- `version === undefined` → v1: treat as `credentialSource = "anon"`, `credentialHash = keyHash`. Format compatibility is automatic — v1's `keyHash` is itself produced by `identityFingerprint` (`scaffolder.ts:921`), so the `sha256:<hex>` prefix and length match the v2 contract without any conversion.
- `version === 2` → v2 reader.
- `version > 2` → unknown future version: treat as not-configured, force re-run on next `mcp add`. A unit test asserts this.
- Parse failure (corrupted JSON) → treat as not-configured, overwrite on next refresh. Mirrors existing behavior at `scaffolder.ts:932-934`.

**Writer rule:** v2 markers must not include the legacy `keyHash`
field. v1 readers ignore unknown fields, so dropping it is
forward-safe.

**Mismatch rule:** consumed by `mcp add` and the existing nudge
system. If the resolver's `effective.source` and `credentialHash` do
not match the marker's, treat MCP as unconfigured. The user-visible
message names the source change in plain English ("project moved from
anon to account credential — refreshing MCP config") and never prints
raw keys or hashes.

## D4 — Codex `bearer_token_env_var` invariant

The Codex branch of `generateMcpConfig` continues to emit
`bearer_token_env_var = "GLASSTRACE_API_KEY"` and never embeds a
token in TOML (`packages/sdk/src/agent-detection/configs.ts:46-60`).
Wave A must not change Codex's TOML output. Two follow-on points:

1. The `mcp-add.ts` Codex CLI path
   (`packages/sdk/src/cli/mcp-add.ts:78-105`) keeps its post-`codex mcp add`
   patch that ensures `bearer_token_env_var` is present. That behaviour
   is what makes Codex *not* go stale on claim transition, and it is
   the model to generalize to other agents in a separate, post-Wave-A
   PR. Out of scope here so the credential-refresh fix is not gated on
   multi-agent env-var support.
2. `writeClaimedKey` writes `GLASSTRACE_API_KEY=<dev key>` to
   `.env.local` with `0o600`
   (`packages/sdk/src/init-client.ts:332`). Wave A relies on that; the
   logic is not duplicated. If the env-var write fails and the SDK
   falls back to `.glasstrace/claimed-key`, Codex will not auto-pick
   up the key — that limitation is unchanged from `main` and is not a
   DISC-1512 regression.

## File Conflict Analysis

| File | Touched By |
|---|---|
| `packages/sdk/src/init-client.ts` | Change `writeClaimedKey` return shape; gate runtime refresh on `persisted`; wrap refresh in own try/catch |
| `packages/sdk/src/anon-key.ts` | Add `readClaimedKey` peer of `readAnonKey` |
| `packages/sdk/src/mcp-runtime.ts` *(new, runtime-safe)* | `mcpConfigMatches` + `canonicalize` (extracted from `cli/scaffolder.ts`); `resolveEffectiveMcpCredential` + `ResolveResult` types; `refreshGenericMcpConfigAtRuntime` with inlined `fs.writeFile`/`chmod 0o600` |
| `packages/sdk/src/cli/scaffolder.ts` | Re-export `mcpConfigMatches`/`canonicalize` from `mcp-runtime.ts` for one release (tagged for removal); add `refreshAllManagedMcpConfigs`; add `isAnonApiKey` helper; extend `scaffoldMcpMarker` to v2 |
| `packages/sdk/src/cli/init.ts` | Replace `readAnonKey` call sites in MCP setup with the resolver; route per-agent refresh through `refreshAllManagedMcpConfigs` |
| `packages/sdk/src/cli/mcp-add.ts` | Use resolver; marker mismatch check; constrain `registerViaCli` to `AnonApiKey` + runtime `isAnonApiKey` guard; rewrite JSDoc at `:44-50` |
| `packages/sdk/src/agent-detection/configs.ts` | Rename third parameter `anonKey` → `bearer` (cosmetic; function not re-exported) |
| `packages/sdk/src/agent-detection/inject.ts` | Audit `writeMcpConfig` failure paths so config content is never leaked into error messages |

If Wave A splits across PRs, the resolver and `mcp-runtime.ts` land
first. Two workers must not edit `init-client.ts`, `cli/init.ts`, or
`cli/mcp-add.ts` in parallel — they share credential-source semantics.

## Test Plan

### New unit tests

- Resolver precedence: `.env.local` dev / `.glasstrace/claimed-key` dev / anon-only / no-credential `null`.
- Resolver strict validation: `GLASSTRACE_API_KEY=gt_dev_short` (or non-hex) emits `malformed-env-local` and falls through; not promoted as dev key.
- Resolver warnings: `claimed-key-only` surfaces when only claim-key file exists; empty `.env.local` value silently absent (no warning).
- `readClaimedKey`: present-valid, present-invalid (fails `DevApiKeySchema`), absent, FS error.
- `writeClaimedKey` return contract: each `persisted` variant produced under simulated I/O conditions.
- Marker v1 read: existing `{ keyHash, configuredAt }` interpreted as `credentialSource: "anon"`, `credentialHash = keyHash`.
- Marker v2 read/write round-trip.
- Marker `version > 2`: treated as not-configured (force re-run).
- Marker corrupted JSON: treated as not-configured.
- Runtime helper: each `RuntimeRefreshAction` branch has a dedicated test.
- Runtime helper does **not** invoke `detectAgents`. Spy or mock-injection used.
- `registerViaCli` runtime guard: anon → proceed, dev-typed string → reject.
- `isAnonApiKey`: positive and negative cases.
- Idempotency: two consecutive `performInit` calls with `claimResult` produce one stderr nudge and one disk write (the second is a content no-op).
- Stderr redaction: full claim-transition flow with simulated I/O failures captures stderr; assert no `gt_dev_*` or `gt_anon_*` fragment appears.
- Codex invariant: `generateMcpConfig({ name: "codex" }, …)` output contains `bearer_token_env_var` and does not contain any `gt_dev_*` / `gt_anon_*` substring.

### New integration test

- `tests/integration/agent-mcp-autoconfig.test.ts` is extended with a claim-transition scenario: write SDK-shaped `mcp.json` for an anon key, simulate claim, assert the file is rewritten with the dev credential and the marker upgrades to v2; with a hand-edited `mcp.json`, assert preservation.

### New import-graph guard test

`tests/unit/sdk/runtime-bundle.test.ts` enforces the runtime/CLI
boundary. Method:

- Build a `ts.Program` from the repo's `tsconfig.json` via the TypeScript compiler API (already a dev dependency).
- Starting from `packages/sdk/src/init-client.ts` and `packages/sdk/src/mcp-runtime.ts`, walk every `ImportDeclaration` and dynamic `import()` `CallExpression` node.
- Resolve each via `program.getResolvedModuleFromFile` and recurse to closure.
- Assert no resolved module path matches `^.*/packages/sdk/src/(agent-detection|cli)/`.
- **Self-verification:** the test ships with a small inline fixture that contains a deliberately forbidden import. The test runs the same closure-walk against the fixture and asserts the violation is detected. If the fixture check is silent, the production assertion is presumed broken and the test fails. This prevents a future refactor from neutering the guard without anyone noticing.

## PR Deliverables Checklist

| Item | Notes |
|---|---|
| `.changeset/*.md` patch entry | "fix: refresh managed MCP config on account claim transition (DISC-1512)" |
| README §"Account Claim Flow" updates | ~5 lines on auto-refresh behavior + hand-edited preservation |
| Codex restart nudge on claim | One stderr line when a Codex config is detected at claim time |
| JSDoc rewrite at `mcp-add.ts:44-50` | "anon keys only, by design — see `registerViaCli` precondition" |
| Audit `writeMcpConfig` failure messages | Verify no config-content leakage; add explicit test |
| `npm pack --dry-run` verification | Confirm `packages/sdk/src/mcp-runtime.ts` appears in the published tarball before merge |
| 500-pass adversarial review (per `docs/agent-reference/sdk-public-overlay.md`) | Implementation PR; this design PR has 300 passes across three rounds |

## Acknowledged Limitations

| Item | Why accepted |
|---|---|
| Compare-then-write TOCTOU on managed configs | Same window as existing `decideMcpConfigAction`; not introduced by Wave A |
| Manual `.glasstrace/anon_key` rotation breaks D2.a equality, causing spurious "preserve" | Outside DISC-1512 scope; documented in helper JSDoc |
| `claimResult` repetition by backend | Helper is content-idempotent; per-process stderr dedup mitigates UX impact |
| Stale `.glasstrace/claimed-key` from a revoked previous account | Resolver cannot distinguish stale-but-shape-valid from valid; warning surfaced via `claimed-key-only` |
| Wave plan and recon line numbers may drift | Re-verify before implementation; not a defect |

## Cross-Repo Follow-Ups

These do not block this design PR. They are filed against the upstream
private repo so the wave plan and recon stay accurate as the SDK
implementation proceeds.

| Item | Target | Owner | When |
|---|---|---|---|
| Update wave plan File-Conflict Analysis to match this design's table | `glasstrace-product/docs/wave-plans/2026-04-30-disc-1512-mcp-credential-scope-plan.md` | SDK conductor | At Wave A implementation PR open, via sub-agent worktree per CLAUDE.md "Filing Discoveries" |
| Tighten recon claim 9 wording on env-var bearer extensibility | `glasstrace-product/docs/wave-plans/2026-04-30-disc-1512-mcp-credential-scope-plan.recon.md` | SDK conductor | Same |
| Forward-compat note on v1 marker `keyHash` field | `glasstrace-product/docs/discoveries/DISC-1512.md` cross-reference | SDK conductor | Same |

## Review Provenance

This design has been through three rounds of adversarial review (100
passes each) before being submitted for Codex review:

| Round | Findings | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| 1 | 21 | 1 | 6 | 10 | 4 |
| 2 | 11 | 0 | 2 | 7 | 2 |
| 3 | 8 | 0 | 1 | 4 | 3 |
| **Total** | **40** | 1 | 9 | 21 | 9 |

The single P0 (review 1) was a structural defect in the original D2
("compare against prior credential" — unimplementable because the prior
credential is not stored). It was resolved by D2.a's revised
"compare against SDK-shaped current-anon output" rule. All other
findings have been folded into this document or deferred to the
PR Deliverables Checklist or Acknowledged Limitations sections above.
