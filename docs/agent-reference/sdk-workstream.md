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

- Contract changes between SDK/protocol and product backend follow the
  canary workflow: update here, publish canary, install in
  `../glasstrace-product`, run tests there, then publish stable.
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
