# Contributing to Glasstrace SDK

Thank you for your interest in contributing. This document covers
the development setup and workflow for the glasstrace-sdk monorepo.

## Prerequisites

- Node.js >= 20 (22 recommended)
- npm 10+

## Getting Started

```bash
git clone https://github.com/Erik-1259/glasstrace-sdk.git
cd glasstrace-sdk
npm ci
```

`npm ci` performs a clean, reproducible install directly from
`package-lock.json` and never mutates it. Use it for every
non-dependency-changing install — fresh clones, git worktrees,
scratch sandboxes — so the lockfile stays stable across contributors.

See [Modifying Dependencies](#modifying-dependencies) below if you need
to add, remove, or upgrade a package.

## Development Workflow

```bash
# Type check all packages
npm run typecheck

# Run tests
npm run test

# Build all packages
npm run build

# Lint
npm run lint
```

## Project Structure

```
packages/
  protocol/   @glasstrace/protocol — shared types and wire schemas
  sdk/        @glasstrace/sdk — server-side tracing SDK
```

## Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run typecheck && npm run test && npm run build`
4. Commit with a descriptive message
5. Open a pull request against `main`

## Changesets

This project uses [changesets](https://github.com/changesets/changesets)
for versioning. If your change affects the public API of either package:

```bash
npx changeset
```

Follow the prompts to describe the change and its semver impact.

## Modifying Dependencies

When you intentionally add, remove, or upgrade a package, use
`npm install` — not `npm ci` — so the lockfile is updated. Almost
always, the dependency belongs to a specific workspace
(`packages/sdk` or `packages/protocol`), not to the root. Scope
every command with `-w <workspace>`:

```bash
# Add, pin, or upgrade in a workspace
npm install <pkg> -w packages/sdk
npm install <pkg>@<version> -w packages/sdk

# Remove from a workspace
npm uninstall <pkg> -w packages/sdk
```

Use the unscoped root form (`npm install <pkg>`) only when the
dependency truly belongs to the root `devDependencies` (build
tooling shared across the monorepo — `turbo`, `typescript`,
`vitest`, `eslint`). When in doubt, scope to a workspace.

Two rules to avoid lockfile drift (see DISC-1317):

1. **Run from the canonical checkout directory**, not from a git
   worktree. `npm install` falls back to the directory basename
   for the lockfile's root `name` if `package.json` omits one;
   running it from a worktree used to rewrite the root entry to
   the worktree directory name. This repo now declares
   `"name": "glasstrace-sdk"` in root `package.json` to harden
   against that, but running from the canonical directory remains
   the safer default.

2. **Use the npm version declared in `packageManager`.** Different
   npm versions can rewrite optional transitive dependency entries
   in incompatible ways. Enable [corepack](https://nodejs.org/api/corepack.html)
   once (`corepack enable`) and npm will match the declared version
   automatically.

Commit the resulting `package-lock.json` change in the same PR as
the `package.json` change. CI runs a lockfile-drift guard
(`git diff --exit-code package-lock.json` after `npm ci`) that
catches any commit whose lockfile disagrees with a clean install.

## Code Style

- TypeScript strict mode
- 2-space indentation
- LF line endings
- ESM imports with `.js` extensions in relative paths

Tier-1 surfaces — wire schemas, session-ID derivation, state-machine
tables, capped constants — carry a `@drift-check` JSDoc tag pointing at
their authoritative source. See `DRIFT.md`.

## Tests

Tests use [Vitest](https://vitest.dev/) and live in the top-level
`tests/` directory:

```
tests/
  unit/
    protocol/   protocol package tests
    sdk/        SDK tests
```

## Reviewing Dependabot PRs

Dependabot automatically opens pull requests for dependency updates.
Minor and patch bumps are grouped; major bumps get individual PRs.

### Rules

- **Never auto-merge major version bumps.** Major bumps often contain
  breaking changes that require migration work.
- **Always check the changelog** of the bumped package before merging.
  Look for breaking changes, deprecated APIs, and new requirements.
- **Run the full CI suite** — the compatibility test job (`compat`)
  validates that the packages still work when installed with minimum
  supported peer dependency versions.

### Critical dependencies to watch

These dependencies directly affect the SDK's public API or build
output. Major bumps require extra scrutiny:

| Dependency | Why it matters |
|---|---|
| `typescript` | Major bumps change type-checking behavior and can break consumer builds |
| `zod` | Major bumps change schema API — the protocol package's entire surface is Zod schemas |
| `@opentelemetry/api` | API changes affect the SDK's span processing and export pipeline |
| `@opentelemetry/sdk-trace-base` | Internal SDK dependency for span processor/exporter |
| `tsup` | Build output format changes can break consumers' bundlers |

### Review checklist for major bumps

1. Read the package's migration guide or changelog
2. Check if our code uses any deprecated or removed APIs
3. Verify peer dependency ranges still make sense (e.g., if Zod
   releases v5, decide whether to support v4 + v5 or v5 only)
4. Run `npm run typecheck && npm run test && npm run build` locally
5. If CI passes, test a manual `npm pack` install in a scratch project
6. Update peer dependency ranges in `packages/*/package.json` if needed

## Validating the SDK against a real consumer project

Before publishing, validate a candidate build against a real consumer
project the same way npm will install it: from a packed tarball, never
through `npm link` or a path-based `file:` dependency. Linked workspaces
share a single `node_modules`, which hides peer-resolution bugs and
duplicate-dependency hazards that a real install would expose.

The recommended workflow uses `npm pack` and a sibling consumer project:

```bash
# 1. Build the SDK from a clean checkout.
npm ci
npm run build

# 2. Pack each workspace you want to validate. `--pack-destination`
#    keeps the tarballs out of the working tree.
mkdir -p /tmp/glasstrace-tarballs
npm pack -w packages/protocol --pack-destination /tmp/glasstrace-tarballs
npm pack -w packages/sdk --pack-destination /tmp/glasstrace-tarballs

# 3. In the consumer project, install the tarballs. Install the
#    protocol tarball first if the SDK depends on a not-yet-published
#    protocol version.
cd /path/to/consumer-project
npm install /tmp/glasstrace-tarballs/glasstrace-protocol-*.tgz
npm install /tmp/glasstrace-tarballs/glasstrace-sdk-*.tgz

# 4. Run the consumer's tests / dev server / build to confirm the
#    candidate build works end-to-end.
```

When you are done validating, restore the consumer's `package.json`
and lockfile so the tarball install does not leak into a commit:

```bash
cd /path/to/consumer-project
git checkout -- package.json package-lock.json
npm ci
```

Two notes on common pitfalls:

1. **Do not use `npm link`** for SDK validation. Symlinked workspaces
   resolve peer dependencies against the SDK's own `node_modules`, so
   peer-version mismatches that a real consumer would hit are silently
   masked.

2. **Tarball file names include the version**. After a `version` bump
   the prior tarball is stale; either delete the destination directory
   between packs or refer to the new file name explicitly.

## Reporting Issues

- **Bugs:** Open a GitHub issue with reproduction steps
- **Security:** Email security@glasstrace.dev (see [SECURITY.md](./SECURITY.md))
- **Features:** Open a GitHub issue for discussion first
