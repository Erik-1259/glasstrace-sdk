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

## Reporting Issues

- **Bugs:** Open a GitHub issue with reproduction steps
- **Security:** Email security@glasstrace.dev (see [SECURITY.md](./SECURITY.md))
- **Features:** Open a GitHub issue for discussion first
