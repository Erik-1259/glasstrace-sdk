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
npm install
```

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

## Code Style

- TypeScript strict mode
- 2-space indentation
- LF line endings
- ESM imports with `.js` extensions in relative paths

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

## Reporting Issues

- **Bugs:** Open a GitHub issue with reproduction steps
- **Security:** Email security@glasstrace.dev (see [SECURITY.md](./SECURITY.md))
- **Features:** Open a GitHub issue for discussion first
