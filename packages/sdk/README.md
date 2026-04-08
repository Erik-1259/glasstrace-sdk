# @glasstrace/sdk

Server-side debugging SDK for AI coding agents. Captures traces,
errors, and runtime context from your Node.js application and delivers
them to coding agents through an MCP server and live dashboard.

> **Status: Pre-release** -- not yet published to npm.

See the [monorepo README](../../README.md) for the planned API.

### Large Build Support

For builds exceeding 4.5MB, the SDK automatically uses presigned uploads
via Vercel Blob storage. Install the optional dependency:

```bash
npm install @vercel/blob
```

No configuration changes needed — the SDK detects build size and routes
to the appropriate upload method automatically.

## License

[MIT](./LICENSE)
