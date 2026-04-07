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

### Drizzle ORM Adapter

```typescript
import { GlasstraceDrizzleLogger } from "@glasstrace/sdk/drizzle";
```

## CLI

```bash
npx glasstrace init
```

Scaffolds instrumentation files for your project and auto-configures
MCP for any detected AI coding agents (Claude Code, Cursor, Codex,
Gemini, Windsurf). Agent detection scans for marker files and writes
native MCP configuration so agents can query traces immediately.

In CI environments (`CI=true`), only a generic
`.glasstrace/mcp.json` is written.

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `GLASSTRACE_API_KEY` | Yes | Your project API key (`gt_dev_...`) |
| `GLASSTRACE_ENV` | No | Environment name (auto-detected if not set) |

## Contributing

Contributions are welcome. Please open an issue to discuss significant
changes before submitting a pull request.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup
instructions.

## License

[MIT](./LICENSE)
