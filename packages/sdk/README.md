# @glasstrace/sdk

Server-side debugging SDK for AI coding agents. Captures traces,
errors, and runtime context from your Node.js application and delivers
them to coding agents through an MCP server and live dashboard.

> **Status: Pre-release** -- not yet published to npm.

See the [monorepo README](../../README.md) for the full API overview,
including the [Coexistence with Other OTel Tools](../../README.md#coexistence-with-other-otel-tools)
section which documents automatic span-processor attachment onto a
pre-registered OTel provider (Sentry, Datadog, Next.js 16 production)
and manual integration via `createGlasstraceSpanProcessor()`.

## License

[MIT](./LICENSE)
