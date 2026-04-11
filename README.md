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

### Removing Glasstrace

```bash
npx glasstrace uninit
```

Reverses every step of `glasstrace init`: unwraps `withGlasstraceConfig`
from `next.config`, removes `registerGlasstrace()` from
`instrumentation.ts` (or deletes the file if it was created by init),
cleans up `.env.local` entries, `.gitignore` entries, MCP configs, and
agent info sections.

Flags:
- `--dry-run` -- Preview what would be removed without making changes

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
