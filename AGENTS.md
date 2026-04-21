# Glasstrace SDK Agent Guide

This file is the shared cross-tool policy layer for the
`glasstrace-sdk` repo. Claude-specific orchestration stays in `CLAUDE.md`.

## Scope

- Primary workstream here is `sdk`.
- This repo is public and publishes the packages
  `@glasstrace/sdk` and `@glasstrace/protocol`.
- Related workspaces:
  - `../glasstrace-product` for product/backend consumers, discoveries,
    scorecard tracking, and internal process docs
  - `../glasstrace-validation` for third-party verification and dogfood
    validation

## After This File

1. `CLAUDE.md` for the public-repo process and PR workflow
2. `docs/agent-reference/sdk-workstream.md` for SDK-specific review
   expectations
3. `../glasstrace-product/docs/discoveries/INDEX.md` and
   `../glasstrace-product/docs/project-state.md` when SDK work depends on
   product-side status or findings

## Routing Model

- `workstream = sdk`
- `review_class = brand-sensitive | standard`
- `workspace = sdk-repo | validation-workspace | product-repo-for-contract-verification`

Most SDK tasks are `brand-sensitive` because this repo is public and every
merged change becomes part of the public package history.

## Repo Map

- `packages/protocol/`: `@glasstrace/protocol`
- `packages/sdk/`: `@glasstrace/sdk`
- `tests/unit/protocol/`: protocol tests
- `tests/unit/sdk/`: SDK tests
- `.changeset/`: release metadata
- `.github/workflows/`: CI, CodeQL, release workflows

## Standard Commands

- Install: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm run test`
- Build: `npm run build`
- Lint: `npm run lint`

## Stable Working Rules

- Do not add "Generated with Claude Code" or Co-Authored-By trailers.
- Use one shell command per tool invocation; do not chain with `&&` or `;`.
- Never rebase shared branches; merge `main` into feature branches if
  needed.
- Never use `git push --force`; use `--force-with-lease` only when truly
  necessary for the public-history workflow.
- Public API changes require README impact review and a changeset in the
  same change.
- Prefer the correct best-practice solution over bandaids or workarounds.
- Never monkey-patch core APIs in the public SDK.
- Never ship observable API behavior that is not backed by real wired
  runtime code.
- For stateful features, design and test the invariants before coding.
- Adversarial review must explicitly check module boundaries: callback
  signatures, event payloads, public API returns, and cross-module data
  flow.

## Cross-Repo Rules

- Read `../glasstrace-product` freely for planning context.
- Write to `../glasstrace-product` only via an isolated worktree or other
  explicit isolated flow; do not treat the product working tree as a safe
  write target.
- Contract changes between SDK/protocol and backend follow the canary
  workflow: update here, publish canary, test in product, then publish
  stable.

## Validation Workspace

- Use `../glasstrace-validation` for third-party verification,
  reproductions, and proof against real external projects.
- Findings discovered there remain provisional until written back to the
  SDK repo, the product repo, or tracked discovery/docs artifacts.
