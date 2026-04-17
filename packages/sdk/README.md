# @glasstrace/sdk

Server-side debugging SDK for AI coding agents. Captures traces,
errors, and runtime context from your Node.js application and delivers
them to coding agents through an MCP server and live dashboard.

> **Status: Pre-release** -- not yet published to npm.

See the [monorepo README](../../README.md) for the planned API.

## Init & Verification

```bash
npx glasstrace init
```

`glasstrace init` scaffolds instrumentation, configures MCP, and
verifies server-side registration of the anonymous key before
reporting success. The verification step uses `node:https` directly —
bypassing any `fetch` patching introduced by Next.js 16 — so a silent
init-hang cannot leave your installation in a broken state.

| Exit code | Meaning |
|-----------|---------|
| `0` | Scaffolding succeeded AND the server confirmed the anon key. |
| `1` | Scaffolding failed. No verification attempted. |
| `2` | Scaffolding succeeded but server verification failed. Safe to re-run. |

On a non-zero verification exit, the error message distinguishes three
classes so you can act on them:

- `fetch failed: <reason>` — transport error (DNS, TCP, TLS, timeout).
- `server rejected the key (HTTP <status>)` — 4xx/5xx status.
- `server returned malformed response` — 2xx with unparseable body.

Transport errors are retried twice (500 ms + 1500 ms backoff, 20-second
total cap). HTTP 4xx/5xx and malformed responses are surfaced
immediately. Set `GLASSTRACE_SKIP_INIT_VERIFY=1` to skip verification
for offline installs.

## License

[MIT](./LICENSE)
