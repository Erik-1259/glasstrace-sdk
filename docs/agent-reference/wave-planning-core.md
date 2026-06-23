# Wave Planning Core

This is the shared base template for multi-agent or wave-based execution.
Use it for both `glasstrace-product` and `glasstrace-sdk`.

## Layering Model

1. Start with this core template.
2. If `review_class = brand-sensitive` or the brief makes architectural,
   infrastructure, contract, or user-flow claims, add
   `docs/agent-reference/high-integrity-briefing.md`.
3. If `workstream = sdk`, add the SDK-only public-repo overlay.

## Planning Phase

1. Read current repo state and the relevant project/discovery indexes.
2. Categorize work into `ready-to-implement`, `needs-brief`,
   `needs-triage`, or `blocked`.
3. Map file conflicts before launching agents.
4. Group work into waves where items inside a wave have zero file
   dependencies on one another.
5. Sequence later waves on earlier-wave merges or accepted briefs.
6. Pre-allocate IDs, branch ownership, or write zones when discoveries or
   shared docs are likely to collide.

## Wave Design Pattern

- Wave 1 maximizes parallelism: independent briefs, triage, or isolated
  implementations.
- Later waves depend on earlier-wave merges and may split into sub-waves
  when file zones overlap.
- Human checkpoints happen between waves: merge PRs, approve or reject
  briefs, resolve conflicts, and re-order remaining work.
- After each wave, run the maintenance/documentation pass before starting
  the next one.

## File Conflict Analysis

Before assigning work, write down the file zones and owners:

```text
| File Zone | Touched By |
|-----------|------------|
| shared contracts / schema | |
| routes / handlers | |
| package-specific modules | |
| docs/task-briefs/ | |
| docs/discoveries/ | |
| release metadata / package manifests | |
```

If two items materially overlap, they do not belong in the same wave.

Re-derive this table from the briefs and the current source, naming every
file each item touches — including shared contract constants, event/lifecycle
modules, and the README. Do not assert "file-disjoint" or "fully parallel"
from memory: a single shared file (a constants module, the README) is enough
to break parallelism. Where two same-wave items share a file, sequence them or
merge the base branch in at the second merge rather than running both in
parallel against it.

## Existing-Surfaces Sweep

Before implementing a change that touches a closed enum, an exhaustive
mapping (e.g. a value keyed by a union type), a hard-coded count, or any
behavior that a comment, docstring, or README describes, sweep every
existing surface that encodes the OLD behavior and list each as an explicit
edit in the implementation plan:

- runtime assertions that pin an exact set or count (an equality check
  against a literal array, an "exports exactly N keys" test) — a type check
  will NOT catch these, so they fail the pre-push test gate mid-run;
- test helpers whose technique depends on the prior internal shape;
- JSDoc, inline comments, and README prose that state the prior behavior.

Reason about the change by tracing it through every surface that asserts the
old behavior, not only the new code path. A test or documentation plan that
is purely additive will either fail the gate or ship documentation that
contradicts the runtime.

## Post-PR Baseline

Every branch in a wave must satisfy this common baseline before it is
considered ready:

1. Run the repo-equivalent pre-push quality gate: typecheck, tests, build,
   and lint.
2. Run `100` adversarial review passes as structured coverage, not filler.
   Revisit the diff through multiple lenses until every file, claim,
   interface, test, and user-facing change has been examined repeatedly.
3. Classify real findings for ODC/quality-scorecard tracking.
4. Fix valid findings and file discoveries for the important non-fixes.
5. Request Codex review and wait for it before marking ready.
6. Address every valid review comment.
7. Do not leave the branch as a pile of review-fixup commits. Amend or
   squash cleanup where practical so the final ready state reads as a
   deliberate change.
8. Resolve review threads and verify CI.
9. Perform a final polish pass over the full diff before marking ready.

## Adversarial Review Coverage

The `100` baseline should cover, at minimum:

- correctness and edge cases
- security and unsafe assumptions
- contracts, interfaces, and cross-module data flow
- tests and regression risks
- documentation, copy, and user-visible behavior
- operational behavior: migrations, deploy assumptions, package/build
  output, and rollback risk

The goal is repeated coverage from distinct lenses, not `100` low-signal
comments.

## Quality Data Collection

During each wave, the conductor keeps a running tally:

```text
| Source | Total | Valid | FP | Fixed | Filed DISC | P0 | P1 | P2 | P3 |
|--------|-------|-------|----|-------|------------|----|----|----|----|
| Agent / PR | | | | | | | | | |
| Codex | | | | | | | | | |
| Total | | | | | | | | | |
```

At wave completion, summarize:

1. total findings and validity breakdown
2. ODC distribution
3. severity distribution
4. action breakdown: fixed, filed, discarded
5. provenance: which agents and which PRs

## Batch PR Guidance

- Batch only when the changes tell one coherent story and belong together
  in review.
- Do not batch unrelated work simply to reduce PR count.
- If a batched PR would blur ownership, release intent, or user-facing
  impact, split it.

## Recon and Claim Truthfulness

If a brief or PR asserts facts about architecture, infra, routes, auth,
pricing, exports, runtime semantics, or deployment behavior, apply the
high-integrity overlay rather than relying on memory or prose alone.
