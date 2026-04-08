# Glasstrace SDK — Public Package Development

## What This Repo Is

This is the **public** monorepo for the Glasstrace SDK. It contains two
npm packages published under the `@glasstrace` scope:

- `@glasstrace/protocol` — shared types and wire schemas (the contract
  between the SDK and the backend)
- `@glasstrace/sdk` — server-side tracing SDK for AI coding agents

Everything in this repo is public. Every commit, PR, code pattern, and
design decision reflects the Glasstrace brand. Quality is not negotiable.

## Quality Standard: Every Commit Is a Brand Statement

This repo has a **higher commit quality bar** than the private
glasstrace-product repo:

- **No iteration commits.** Work in worktrees or local branches. Only the
  final, polished state gets pushed. Squash merge all PRs.
- **No "fix review feedback" commits.** Address review comments by amending
  or squashing before push, not by stacking fixup commits.
- **Commit messages are public documentation.** They should be clear,
  professional, and useful to external contributors reading `git log`.
- **Every PR must be self-contained and understandable.** A stranger
  reading the PR should understand what changed and why.
- **README impact assessment on every change.** If a change affects the
  public API, update README.md in the same PR.
- **CHANGELOG.md is maintained via changesets.** Run `npx changeset` for
  any change that affects the public API of either package.

## Your Role

You are a quality-obsessed implementation agent. You write code that would
survive scrutiny from the most critical open-source reviewer. Before every
commit, ask: "Would I be proud to have this in my portfolio?"

## Project Structure

```
glasstrace-sdk/
  CLAUDE.md              ← you are here
  package.json           ← root workspace config (Turborepo)
  turbo.json             ← Turborepo pipeline
  tsconfig.json          ← root TypeScript config
  tsconfig.base.json     ← shared compiler options
  eslint.config.js       ← ESLint 9 flat config
  vitest.config.ts       ← Vitest config
  CONTRIBUTING.md        ← public contribution guide
  SECURITY.md            ← security policy
  CHANGELOG.md           ← public changelog
  CODE_OF_CONDUCT.md     ← community standards
  LICENSE                ← MIT
  packages/
    protocol/            ← @glasstrace/protocol (wire schemas)
    sdk/                 ← @glasstrace/sdk (tracing SDK)
  tests/
    unit/
      protocol/          ← protocol tests
      sdk/               ← SDK tests
  .github/
    workflows/
      ci.yml             ← CI pipeline
      codeql.yml         ← CodeQL security scanning
      release.yml        ← npm publishing (trusted OIDC)
```

## Build and Test Commands

- Type check: `npm run typecheck` (or `tsc -b`)
- Test: `npm run test` (or `vitest run`)
- Build: `npm run build` (or `turbo run build`)
- Lint: `npm run lint` (or `eslint .`)
- All must pass before pushing: `npm run typecheck && npm run test && npm run build && npm run lint`

## Dependency & Tooling Practices

- **Always use the current stable version** of a dependency when adding
  it. Do not pin to old versions (e.g., `^0.27.0` when `^2.3.3` is
  current). Check `npm view <pkg> version` before adding.
- **Respect the `packageManager` field** in `package.json`. If your local
  npm/node version differs from what the repo declares, fix the tooling
  (enable corepack, use the correct version), do not generate lockfiles
  with a different version and hope for the best.
- **Lockfiles must be generated with the declared npm version.** Cross-
  platform optional dependencies resolve differently across npm versions.
  A lockfile generated with npm 11 may fail `npm ci` on npm 10.
- **No bandaid fixes.** If you find yourself applying a workaround to a
  CI failure (e.g., manually adding transitive deps, editing lockfile
  names, using `npx npm@<version>` as a one-off), stop and fix the root
  cause. Workarounds are not acceptable in a public repo.
- **Verify CI compatibility before pushing.** If you add a new dependency,
  confirm it passes `npm ci` and `npm audit --audit-level=high` in CI,
  not just `npm install` locally.

## Git Conventions

- Branch naming: `{type}/{description}` (e.g., `feat/add-retry-logic`,
  `fix/session-id-derivation`)
- Commit messages: conventional commits (feat:, fix:, docs:, refactor:,
  test:, chore:)
- Always create feature branches from `main`
- **Squash merge all PRs** — one clean commit per PR on main
- Never push directly to main
- Do NOT add "Generated with Claude Code" or Co-Authored-By trailers
- Do NOT rebase — merge main into feature branches if needed
- Do NOT use git push --force — use --force-with-lease only if absolutely
  necessary

## Publishing

- Versioning uses [changesets](https://github.com/changesets/changesets)
- Canary releases: `workflow_dispatch` on release.yml
- Stable releases: `workflow_dispatch` restricted to main branch
- Publishing uses npm trusted publishing (OIDC) — no NPM_TOKEN needed
- All publishes include provenance attestation

## Post-PR Process (MANDATORY)

Every PR must complete this full process before being marked ready.
This repo has a **stricter process** than glasstrace-product because
every merged PR becomes a public commit.

### Step 1: Pre-Push Quality Gate

Before pushing, ALL of these must pass with zero errors:
```
npm run typecheck
npm run test
npm run build
npm run lint
```

No exceptions. No "pre-existing errors" exemption. If something is
broken, fix it or don't push.

### Step 2: Adversarial Self-Review — 500 rounds

Significantly more thorough than glasstrace-product's 30 rounds because
this is a public repo and every commit is a brand statement.

There are 50 unique review angles organized in 7 categories below.
Perform 500 total review passes — approximately 10 passes per angle,
each examining a different part of the diff through that lens. The
goal is comprehensive coverage: every file, every function, every
edge case examined from multiple perspectives.

**Correctness (1-8):**
1. Error paths — trace every error path, correct codes?
2. Edge cases — empty, null, overflow, boundary
3. Default values — sensible? documented?
4. Return values — correct types in all paths?
5. State transitions — lifecycle correct?
6. Public API surface — is anything exposed that shouldn't be?
7. Backward compatibility — does this break existing users?
8. Documentation accuracy — do JSDoc comments match behavior?

**Security (9-16):**
9. Injection — any user input reaches unsafe operations?
10. Data leakage — secrets, tokens, internal paths exposed?
11. Input validation — all external input validated?
12. Dependency safety — new deps reviewed for supply chain risk?
13. Prototype pollution — object spread from untrusted sources?
14. Timing attacks — constant-time comparisons where needed?
15. Error messages — do they reveal internal details?
16. Package contents — does the published package include only intended files?

**Type Safety (17-22):**
17. Unsafe casts — any `as` that could mask bugs?
18. Any types — explicit or implicit `any`?
19. Null safety — nullable values checked?
20. Generic constraints — properly bounded?
21. Export types — are public types correctly exported?
22. Branded types — are IDs and keys properly branded?

**Test Quality (23-30):**
23. Coverage — every public API method tested?
24. Error paths tested — every throw/reject has a test?
25. Edge cases tested — boundary conditions?
26. Test isolation — no shared mutable state?
27. Assertion quality — specific, not just toBeDefined?
28. Integration scenarios — cross-module interactions?
29. Regression tests — would this catch a revert?
30. Example code — do README examples actually work?

**Public Readiness (31-40):**
31. README — does it need updating?
32. CHANGELOG — does this need a changeset?
33. JSDoc — are all public APIs documented?
34. Examples — do code examples compile and run?
35. Migration — does this require a migration guide?
36. Semver — is the version bump correct (patch/minor/major)?
37. Bundle size — does this significantly increase package size?
38. Tree shaking — are exports tree-shakeable?
39. CJS/ESM — does dual format work correctly?
40. Node version — compatible with engines field (>=20)?

**Code Quality (41-46):**
41. Lint clean — zero warnings, zero errors
42. Import hygiene — no unused, no circular
43. Naming — clear, consistent, professional
44. Duplication — any copy-paste?
45. Complexity — can this be simpler?
46. Comments — explain why, not what

**Architecture (47-50):**
47. Module boundaries — clean interfaces?
48. Dependency direction — no circular deps?
49. Consistency — matches patterns in the rest of the codebase?
50. Future-proof — will this need changing soon?

### Step 3: Push and Create Draft PR

- `git push -u origin {branch}`
- `gh pr create --draft --title "{type}: {description}" --body "{summary}"`
- PR description must be clear enough for an external contributor to review

### Step 4: Wait for CI + Codex Review

- Comment `@codex review` on the PR
- Poll `gh api repos/Erik-1259/glasstrace-sdk/pulls/{NUMBER}/reviews`
  every 30 seconds for up to 10 minutes
- Do NOT proceed until review arrives or timeout

### Step 5: Address ALL Review Comments

- Every comment must be addressed — no skipping
- Valid fixes: amend the commit (not a new fixup commit), force-push
  with lease if needed
- Valid but out of scope: file a discovery in glasstrace-product
  (see "Filing Discoveries" below)

### Step 6: Resolve Threads and Verify CI

- Resolve all review threads via GraphQL `resolveReviewThread`
- ALL CI checks must be green
- Mark PR ready only when everything is clean

### Step 7: Final Polish Check

Before reporting the PR as ready, re-read the entire diff one more time.
Ask: "Is this the quality I want representing the Glasstrace brand?"

## Reading glasstrace-product (planning context)

The SDK session MAY freely read glasstrace-product files for planning
and context. Reading does not cause conflicts — only writing does.

**What to read and when:**

| When | Read |
|---|---|
| Planning SDK work | `../glasstrace-product/docs/discoveries/INDEX.md` — scan for OPEN and ACCEPTED discoveries with `Affects: glasstrace-sdk` or SDK-related keywords (DISC-347, DISC-377, etc.). OPEN = not yet triaged. ACCEPTED = reviewed and approved for action. Both are actionable. |
| Understanding schemas | `../glasstrace-product/shared/types/*.ts` — the Zod schemas that define the wire contract |
| Checking project state | `../glasstrace-product/docs/project-state.md` — SDK section shows what's merged, what's pending |
| Design decisions | `../glasstrace-product/docs/component-designs/sdk.md` — the SDK component design |
| Cross-references | `../glasstrace-product/docs/component-designs/CROSS-REFERENCES.md` — how SDK interfaces with ingestion, MCP, extension |
| Quality data | `../glasstrace-product/docs/quality-scorecard.md` — current ODC/Rayleigh state, trend indicators |
| Task briefs | `../glasstrace-product/docs/task-briefs/*.md` — any SDK-related task briefs |

**When NOT to read:**
- During adversarial reviews (use methodology embedded in this CLAUDE.md)
- For discovery file templates (use templates embedded in this CLAUDE.md)
- For ODC classification (use mapping embedded in this CLAUDE.md)

**Rule: READ freely, WRITE only via sub-agent worktree** (see Filing
Discoveries below).

## Filing Discoveries (write via sub-agent)

This repo does NOT have its own discovery system. All discoveries are
tracked in the private `glasstrace-product` repo at
`../glasstrace-product/docs/discoveries/`.

When you find an issue that needs tracking, spawn a sub-agent with
these instructions. The SDK session does NOT read or write to
glasstrace-product directly — the sub-agent handles everything using
a git worktree to avoid interfering with any active work.

**Sub-agent prompt template:**

> You are filing a discovery in the glasstrace-product repo located at
> `/Users/erik/SoftwareDevelopment/glasstrace-product`.
>
> IMPORTANT: Do NOT checkout or modify the main working tree — another
> session may be using it. Use a git worktree instead.
>
> Steps:
> 1. Fetch latest main:
>    `git -C /Users/erik/SoftwareDevelopment/glasstrace-product fetch origin main`
> 2. Find the highest DISC-NNN ID:
>    `ls /Users/erik/SoftwareDevelopment/glasstrace-product/docs/discoveries/ | grep DISC- | sort -t- -k2 -n | tail -1`
> 3. Determine next ID (highest + 1)
> 4. Create a worktree for the discovery branch:
>    `git -C /Users/erik/SoftwareDevelopment/glasstrace-product worktree add /tmp/disc-{next ID} -b disc/DISC-{next ID} origin/main`
> 5. Write the discovery file at `/tmp/disc-{next ID}/docs/discoveries/DISC-{next ID}.md`
>    using the template provided below
> 6. Include `**Found by:** SDK session` and `**Affects:** glasstrace-sdk`
> 7. Commit from the worktree:
>    `git -C /tmp/disc-{next ID} add docs/discoveries/DISC-{next ID}.md`
>    `git -C /tmp/disc-{next ID} commit -m "docs: file DISC-{next ID} from SDK session"`
> 8. Push:
>    `git -C /tmp/disc-{next ID} push -u origin disc/DISC-{next ID}`
> 9. Create PR:
>    `gh pr create --repo Erik-1259/glasstrace --head disc/DISC-{next ID} --draft --title "docs: DISC-{next ID} — {short title}" --body "{summary}"`
> 10. Clean up worktree:
>     `git -C /Users/erik/SoftwareDevelopment/glasstrace-product worktree remove /tmp/disc-{next ID}`
> 11. Report back the DISC ID and PR number
>
> Discovery content: {paste the finding details here}

**Why this design works:**

- **Worktree instead of checkout** — glasstrace-product's working tree
  may have uncommitted changes or be on a feature branch from an active
  session. `git worktree add` creates a completely isolated copy from
  `origin/main` without touching the working tree at all.
- **`origin/main` instead of local main** — local main might be behind
  remote. Fetching then branching from `origin/main` ensures the
  discovery is based on the latest merged state.
- **`--repo` flag on `gh pr create`** — the sub-agent runs from `/tmp`,
  not inside glasstrace-product, so `gh` can't auto-detect the repo.
- **Worktree cleanup** — stale worktrees cause Vitest to pick up old
  test files. Always remove after push.
- **Verified 2026-04-04** — full sequence tested end-to-end including
  with dirty working tree and dry-run PR creation.

### Discovery File Template

Use either format. The sub-agent writes this file in glasstrace-product.

**Format A (bullet list):**

```markdown
# Discovery: DISC-NNN

- **Date:** YYYY-MM-DD
- **Found by:** SDK session
- **Category:** [see category list below]
- **Summary:** One paragraph describing the finding.
- **Impact:** What parts of the system are affected.
- **Suggested resolution:** How to fix it.
- **Affected types:** List of affected types, or None.
- **Affects:** glasstrace-sdk
- **Status:** OPEN
```

**Format B (extended):**

```markdown
<!-- version: 1 -->
# DISC-NNN: Short descriptive title

**Date:** YYYY-MM-DD
**Status:** OPEN
**Priority:** P0 | P1 | P2 | P3
**Category:** [see category list below]
**Source:** SDK session
**Affects:** glasstrace-sdk

## Summary

[Description of the finding.]

## Suggested Resolution

[How to fix it.]
```

### Discovery Categories

| Category | Description |
|---|---|
| `spec_correction` | Spec says X but actual behavior is Y |
| `spec_accuracy` | Product spec contains an inaccuracy |
| `implementation_constraint` | Technical limitation blocks an approach |
| `dependency_surprise` | Library doesn't work as assumed |
| `performance_observation` | Slower/larger/more expensive than expected |
| `design_correction` | Design says X but implementation requires Y |
| `design_gap` | Required capability the design omitted |
| `version_mismatch` | Document versions have drifted |
| `bug` | Existing code has a defect |
| `security` | Vulnerability, exposure, or insufficient hardening |
| `implementation_gap` | Required behavior not yet implemented |
| `schema_gap` | Missing type, field, or constraint |
| `documentation_gap` | Missing or incomplete documentation |
| `code_quality` | Works but has maintainability/readability issues |
| `test_quality` | Tests have gaps, flakiness, or weak coverage |
| `test_coverage` | Insufficient test coverage for a module |
| `enhancement` | Improvement beyond current requirements |
| `timing_bug` | Race condition, ordering, or time-dependent defect |

---

## Quality Monitoring (ODC + Rayleigh)

Quality metrics for both this repo and glasstrace-product are tracked in
a unified scorecard at `../glasstrace-product/docs/quality-scorecard.md`.
SDK sessions contribute data points to the same Rayleigh curve. This
section contains the full methodology so you can classify findings
without reading cross-repo files.

### ODC Defect Type Mapping

This mapping is fixed — do not change it between sessions or trends
become incomparable.

| ODC Defect Type | Glasstrace Categories | Description |
|---|---|---|
| **Function** | `implementation_gap`, `design_gap`, `spec_correction`, `spec_accuracy` | Missing or incorrect capability |
| **Assignment** | `code_quality` | Variable initialization, data structure, constant errors |
| **Checking** | `security`, `implementation_constraint` | Validation, assertion, boundary checking failures |
| **Interface** | `schema_gap`, `design_correction` | Module boundary, API contract, type mismatches |
| **Timing** | `timing_bug` | Race conditions, ordering, synchronization errors |
| **Build/Package** | `dependency_surprise`, `version_mismatch` | Build config, dependency, deployment issues |
| **Algorithm** | `bug`, `enhancement`, `performance_observation` | Logic errors, incorrect computation, optimization |
| **Documentation** | `documentation_gap`, `test_quality`, `test_coverage` | Missing/incorrect docs, test gaps |

### ODC Qualifiers

| Qualifier | Meaning |
|---|---|
| **Missing** | Required behavior/check/type not present |
| **Incorrect** | Behavior exists but produces wrong result |
| **Extraneous** | Unnecessary code that could cause confusion or bugs |

### ODC Triggers (how found)

| Trigger | Maps To |
|---|---|
| **Design conformance** | Adversarial architecture reviews |
| **Logic coverage** | Adversarial correctness reviews (error paths, return values) |
| **Simple path** | Unit test failures, basic smoke tests |
| **Complex path** | Integration tests, cross-package tests |
| **Side effects** | Adversarial edge case reviews (concurrent, overflow, null) |
| **Rare situation** | Dogfooding, production incidents |
| **Stress** | Performance benchmarks, load testing |

### Defect Phase Tracking

Each finding is tagged with where it was **introduced** and where it
was **found**. Escape rate = found in a later phase than introduced.

| Phase | ID | Examples |
|---|---|---|
| Design | 1 | API design decisions, type schema gaps |
| Implementation | 2 | Code bugs, missing validation, type unsafety |
| Integration | 3 | Cross-package mismatches, CI failures |
| Deployment | 4 | npm publish issues, bundling errors |
| Production | 5 | User-reported bugs, runtime failures |

**Escape rate formula:** `escaped = count(found_phase > introduced_phase) / total`

### Severity Scale

| Severity | ODC Impact | Priority | Definition |
|---|---|---|---|
| Critical | High | P0 | Exploitable security hole, data loss, crash |
| Major | High | P1 | Significant correctness/security issue, workaround exists |
| Minor | Medium | P2 | Moderate quality issue, no immediate user impact |
| Trivial | Low | P3 | Style, naming, minor improvement |

### Session Summary Format

After each review session or wave, compile this data for the
glasstrace-product maintenance agent to add to the quality scorecard:

```markdown
**SDK Session: YYYY-MM-DD**
- Review method: [adversarial / Codex / manual]
- Scope: [what was reviewed]
- Total findings: N
- Valid: N | False positive: N | FP rate: N%
- Fixed: N | Filed as DISC: N (list IDs)
- P0: N | P1: N | P2: N | P3: N
- ODC distribution: Function: N, Assignment: N, Checking: N, Interface: N,
  Timing: N, Build/Package: N, Algorithm: N, Documentation: N
- Provenance: [which agents, which PRs]
```

This summary is included in the discovery PR to glasstrace-product so
the maintenance agent can ingest it into the scorecard.

### Rayleigh Model Context

The Rayleigh model predicts total defects and time to peak discovery
rate: `f(t) = (N/σ²) × t × e^(-t²/2σ²)`. Requires 5+ data points
(sessions) to fit. Each SDK session adds one data point to the shared
curve. Zero Bug Bounce = open defect count reaches 0 and stays at 0
for ≥2 consecutive sessions.

### What Counts as a Finding

A finding is any issue identified during review that describes a real
or potential defect. Style preferences, cosmetic suggestions, and
questions are NOT findings. A finding is valid if the code actually has
the issue at review time. False positives are findings where the code
handles the case correctly.

### Provenance Rule

Every number must trace to a DISC-NNN, PR comment, or named review
session. If a number cannot be traced to a specific source, do not
record it.

## Relationship to glasstrace-product

This public repo and the private `glasstrace-product` repo are related:

- **glasstrace-product consumes `@glasstrace/protocol` from npm** for
  SDK-facing types used by the backend (e.g., `SdkInitResponse` in
  ingestion)
- **Contract changes** (wire format between SDK and backend) start here,
  get published as a canary, tested in glasstrace-product, then published
  stable
- **SDK-only changes** are done entirely in this repo
- **Backend-only changes** are done entirely in glasstrace-product

### Contract Change Workflow

1. Update `@glasstrace/protocol` in this repo
2. Run `npx changeset` to describe the change
3. Publish a canary release via workflow_dispatch
4. In glasstrace-product: `npm install @glasstrace/protocol@canary`
5. Run glasstrace-product integration tests
6. If green: publish stable from this repo, update glasstrace-product
   to stable version

## Constraints

- Never commit secrets, credentials, or internal process docs
- Never reference glasstrace-product's internal docs in public commits
- All public-facing text (README, CONTRIBUTING, comments) should be
  professional and brand-appropriate
- When in doubt about whether something should be public, err on the
  side of not including it
