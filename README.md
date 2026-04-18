# Glasstrace SDK

> **Pre-release** — This SDK is under active development and not yet
> published to npm. APIs may change before the first stable release.

Server-side debugging SDK for AI coding agents. Captures traces,
errors, and runtime context from your Node.js application and delivers
them to coding agents through an MCP server and live dashboard.

## Quick Start

```bash
npm install @glasstrace/sdk
```

```typescript
// instrumentation.ts (Next.js / Vercel)
import { registerGlasstrace } from "@glasstrace/sdk";

registerGlasstrace({ apiKey: process.env.GLASSTRACE_API_KEY });
```

## What It Does

Glasstrace instruments your server with OpenTelemetry and captures:

- HTTP requests and responses
- Database queries (Prisma, Drizzle)
- External API calls
- Error stack traces and context

Traces are sent to the Glasstrace ingestion API, where they're
enriched with AI-generated root cause analysis and made available
through an MCP server that coding agents can query directly.

## Packages

| Package | Description |
|---------|-------------|
| [`@glasstrace/protocol`](./packages/protocol) | Shared types and wire format schemas |
| [`@glasstrace/sdk`](./packages/sdk) | Server-side SDK for Node.js |

## Framework Support

### Next.js / Vercel

```typescript
// instrumentation.ts
import { registerGlasstrace } from "@glasstrace/sdk";

registerGlasstrace({
  apiKey: process.env.GLASSTRACE_API_KEY,
});
```

### Express / Node.js

```typescript
import { registerGlasstrace } from "@glasstrace/sdk";

registerGlasstrace({
  apiKey: process.env.GLASSTRACE_API_KEY,
  environment: "production",
});
```

### Source Maps (Next.js)

Wrap your Next.js config to enable source map uploads for production
stack trace resolution:

```typescript
// next.config.ts
import { withGlasstraceConfig } from "@glasstrace/sdk";

export default withGlasstraceConfig({ reactStrictMode: true });
```

`withGlasstraceConfig()` configures three things for you:

- **Server source maps** — `experimental.serverSourceMaps` is enabled so
  Glasstrace can resolve stack traces back to your source.
- **Turbopack/webpack parity** — an empty `turbopack: {}` is seeded when
  none is set so Next 16 does not reject builds that configure `webpack`
  without a companion `turbopack` key.
- **Server-external SDK** — `@glasstrace/sdk` is added to
  `serverExternalPackages` (Next 15+) and
  `experimental.serverComponentsExternalPackages` (Next 14) so the SDK
  is loaded via Node's `require()` at runtime instead of bundled through
  webpack or Turbopack. This mirrors the pattern used by Prisma,
  `@vercel/otel`, Sentry, `sharp`, and `bcrypt`.

Monorepo users editing a forked `@glasstrace/sdk` as a workspace dep and
wanting live HMR of SDK source should remove `@glasstrace/sdk` from
`serverExternalPackages` after calling `withGlasstraceConfig()`.

### Manual Error Capture

Record errors explicitly as span events, independent of automatic
console error capture:

```typescript
import { captureError } from "@glasstrace/sdk";

try {
  await riskyOperation();
} catch (err) {
  captureError(err);
}
```

### Drizzle ORM Adapter

Attach the Glasstrace logger to capture Drizzle ORM queries as spans:

```typescript
import { GlasstraceDrizzleLogger } from "@glasstrace/sdk/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle(pool, { logger: new GlasstraceDrizzleLogger() });
```

## CLI

```bash
npx glasstrace init
```

Scaffolds instrumentation files for your project and auto-configures
MCP for any detected AI coding agents (Claude Code, Cursor, Codex,
Gemini, Windsurf). Agent detection scans for marker files and writes
native MCP configuration so agents can query traces immediately.

If an `instrumentation.ts` file already exists with an `export function
register()`, init injects `registerGlasstrace()` as the first statement
rather than overwriting the file.

**Monorepo support:** When run from a monorepo root (pnpm workspaces,
npm workspaces, Turborepo, or Lerna), init auto-detects workspace
packages and resolves the target Next.js app directory automatically.
If multiple Next.js apps are found, run init from the specific app
directory instead.

If any scaffolding step fails, all previously completed steps are
automatically rolled back so you are never left with a half-configured
project.

In CI environments (`CI=true`), only a generic
`.glasstrace/mcp.json` is written.

### Installation State Preservation

`glasstrace init` is safe to re-run. Running it over an existing install:

- **Preserves the anonymous key** at `.glasstrace/anon_key` so an account
  claim linkage is never silently invalidated.
- **Preserves a claimed developer API key** in `.env.local`
  (`GLASSTRACE_API_KEY=gt_dev_...`) so re-init cannot cost you
  authentication state.
- **Preserves the config cache** at `.glasstrace/config` — re-init does
  not touch the cache, and the runtime uses atomic write-then-rename
  semantics so a mid-write crash cannot leave it corrupted.
- **Prompts before overwriting manually-edited MCP config files.** If
  the existing `.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`,
  or `.codex/config.toml` differs from the template init would write,
  init asks for confirmation. Pass `--force` to skip the prompt.

### Validating Install State

```bash
npx glasstrace init --validate
```

Checks that the Glasstrace installation artifacts are in a consistent
state without making any changes. Reports any of the following and
exits non-zero:

- `.glasstrace/` exists but `instrumentation.ts` is missing the
  `registerGlasstrace` import
- `.glasstrace/` is missing but `instrumentation.ts` still imports
  from `@glasstrace/sdk`
- The `.glasstrace/mcp-connected` marker exists but no MCP config
  files are present
- MCP config files exist but the marker is missing

Each finding includes a suggested fix command.

### Removing Glasstrace

```bash
npx glasstrace uninit
```

Reverses every step of `glasstrace init`: unwraps `withGlasstraceConfig`
from `next.config`, removes `registerGlasstrace()` from
`instrumentation.ts` (or deletes the file if it was created by init),
cleans up `.env.local` entries, `.gitignore` entries, MCP configs, and
agent info sections.

Before cleanup, uninit writes a `.glasstrace/shutdown-requested` marker
so a running SDK heartbeat can drain and exit cleanly on its next tick
instead of continuing to buffer traces after the files have been
removed.

If `.env.local` contains a claimed developer key (`gt_dev_*`), uninit
requires explicit confirmation before removing it to avoid silently
losing your authentication state. Pass `--force` to skip the
confirmation.

Flags:
- `--dry-run` -- Preview what would be removed without making changes
- `--force` -- Skip interactive confirmation for dev-key removal

### Uninstalling the package

When you run `npm uninstall @glasstrace/sdk`, a `preuninstall` script
prints a warning reminding you to run `npx @glasstrace/sdk uninit`
first. Package-manager lifecycle scripts are unreliable across
environments (pnpm, yarn, and CI containers), so the warning is
informational only; Glasstrace does not attempt automatic cleanup
during `npm uninstall`. For a clean removal:

```bash
npx glasstrace uninit
npm uninstall @glasstrace/sdk
```

### MCP Registration

```bash
npx glasstrace mcp add
```

Explicitly registers the Glasstrace MCP server with detected AI coding
agents. While `glasstrace init` writes file-based MCP configs, this
command also attempts native CLI registration for agents that support
it. Re-run after key rotation or to add newly installed agents.

Flags:
- `--dry-run` -- Preview what would be configured without making changes
- `--force` -- Reconfigure even if already set up (useful after key rotation)

### Large Build Support

For builds at or above 4.5MB, the SDK automatically uses presigned uploads
via Vercel Blob storage. Install the optional dependency:

```bash
npm install @vercel/blob
```

No configuration changes needed — the SDK detects build size and routes
to the appropriate upload method automatically.

### Account Claim Transition

When an anonymous key is linked to a Glasstrace account, the SDK
automatically detects this during initialization and logs migration
instructions to stderr with the new API key.

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `GLASSTRACE_API_KEY` | No | Your project API key (`gt_dev_...`). Anonymous mode without it. |
| `GLASSTRACE_ENV` | No | Environment name (auto-detected if not set) |

## Edge Runtime / Non-Node Environments

The SDK can be bundled for non-Node targets without failing on
unresolvable `node:` imports. Node.js built-in modules (`node:crypto`,
`node:fs`, `node:path`) are loaded dynamically at call time, not at
import time. Bundlers like esbuild and webpack can externalize `node:*`
modules and the SDK will degrade gracefully at runtime.

In non-Node environments, the SDK degrades gracefully:

- **Session IDs** use a deterministic FNV-1a hash instead of SHA-256
- **Key persistence** falls back to ephemeral in-memory storage
- **Config caching** is skipped (defaults are used)
- **`registerGlasstrace`** detects the non-Node environment and
  returns a no-op

Server-only utilities (`collectSourceMaps`, `buildImportGraph`) still
require Node.js and should be excluded from browser bundles via your
bundler's externalization config.

## Bundle Size

The SDK bundles OpenTelemetry and Zod internally so consumers get a
zero-dependency install. No separate `@opentelemetry/api` or `zod`
installation is needed.

## OTel Migration

As of v0.7, `@opentelemetry/api` is bundled into the SDK and no longer
needs to be installed separately. Existing installations remain
compatible -- the OTel API uses `Symbol.for` for singleton coordination,
so multiple copies coexist safely.

## Contributing

Contributions are welcome. Please open an issue to discuss significant
changes before submitting a pull request.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup
instructions.

## License

[MIT](./LICENSE)
