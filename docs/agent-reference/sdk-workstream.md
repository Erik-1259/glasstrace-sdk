# SDK Workstream Reference

This document defines the stricter review bar for the public
`glasstrace-sdk` repo.

## Purpose

This repo is public. Every merged commit, PR, code pattern, and public
document reflects the Glasstrace brand.

## Public Package Quality Bar

- No iteration-quality public commits.
- No casual fixup history on the public branch.
- Commit messages, README changes, and public-facing text should read like
  deliberate external documentation.
- Public API changes require README review and a changeset in the same
  change.

## Wave Planning Stack

- Use `docs/agent-reference/wave-planning-core.md` as the base template
  for wave-based execution.
- Apply `docs/agent-reference/high-integrity-briefing.md` for SDK briefs
  that assert architectural, packaging, or runtime facts; in practice this
  should be the default.
- Apply `docs/agent-reference/sdk-public-overlay.md` for every SDK wave.
  That turns the common `100`-review baseline into `500` total review
  passes and adds README/changeset/public-package checks.

## Engineering Rules

- Do not apply bandaids or duct-tape workarounds. Step back and find the
  proper best-practice solution.
- Never monkey-patch core APIs in the public SDK.
- Never ship observable behavior whose return values depend on unwired or
  future-wave code.
- Design stateful features and their invariants before implementation; the
  first commit should reflect the correct design, not a review-discovered
  approximation.

## Review Emphasis

- Adversarial review must include explicit module-boundary passes:
  callback signatures, event payloads, public API return values, and
  cross-module data flow.
- Public API review includes backward compatibility, runtime truthfulness,
  documentation accuracy, and package contents.

## Briefing and Recon

- SDK briefs should be evidence-backed rather than memory-backed.
- Architectural claims in briefs should be grounded in reconnaissance
  artifacts before authoring, not after review cycles have started.

## Release and Contract Rules

- Contract changes between SDK/protocol and the Product backend may publish a
  canary for consumer evidence. The implementing SDK release change owns its
  acceptance and stable-publication decision; a Product process checkpoint or
  `TEST-NNN` status is not the authority.
- For an inbound or otherwise immediately active contract, that release change
  must prove compatibility with the deployed counterpart or preserve an
  explicitly backward-compatible/default-off path until the counterpart is
  compatible. Product-owned evidence may supplement the proof, but the
  compatibility requirement itself is not optional.
- Stable-direct release still requires the SDK-owned packed-candidate
  real-consumer installation check in `CONTRIBUTING.md`; removing Product or
  TEST authority does not waive artifact-level release acceptance.
- Any producer behavior that can emit a new wire shape must remain inactive
  until a compatible receiver is deployed. Enforce that receiver-first order
  through the implementing runtime's default-off capability contract; it is a
  binding technical dependency, not authority granted by a TEST result.
- `changeset` metadata should match the actual release intent; do not rely
  on misunderstood `linked` semantics to co-bump packages automatically.
- For metadata-only `package.json` edits, be careful with lockfile drift
  across platforms; do not casually run `npm install` if it changes the
  dependency graph representation unnecessarily.

## Validation Workspace Use

- Use `../glasstrace-validation` to verify SDK behavior against real or
  third-party projects.
- Move important findings back into tracked SDK or product artifacts rather
  than leaving them only in the validation workspace.
