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

## Initialize

```bash
npx glasstrace init
```

The `init` command scaffolds the files Glasstrace needs and merges into
your existing setup rather than overwriting.

### Instrumentation file precedence

Init picks the first matching location:

1. An existing `src/instrumentation.{ts,js,mjs}` — the user has already
   committed to this location, so merge there.
2. An existing `instrumentation.{ts,js,mjs}` at the project root — same
   rationale.
3. A new `src/instrumentation.ts` when the project contains a `src/`
   directory at its root (the common Next.js convention).
4. A new `instrumentation.ts` at the project root.

Next.js only loads instrumentation from one of the two locations —
scaffolding to the wrong one silently prevents the SDK from starting,
so the layout is resolved automatically.

### Merge into existing instrumentation

When an instrumentation file already exists, init merges instead of
overwriting:

- If the file exports a `register()` function, init inserts
  `registerGlasstrace()` as the first statement of the existing body
  and imports `registerGlasstrace` at the top of the file.
- If the file has no `register()` function (for example, it only
  contains a top-level Sentry import), init appends a new
  `export async function register()` that calls `registerGlasstrace()`.
- If `registerGlasstrace()` is already present, init is a no-op.

Before modifying an existing file, init prompts for confirmation. Pass
`--force` (or `--yes`) to skip the prompt in automated environments.

### Both-layout conflict

If both `instrumentation.ts` (root) and `src/instrumentation.ts` exist,
init exits non-zero without modifying either file. Next.js's loader
behavior is undefined when both are present — it loads one and ignores
the other. Merge your code into `src/instrumentation.ts`, delete the
root file, then re-run init.

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

## Server Action detection (Next.js)

Next.js does not emit a dedicated OTel span for Server Actions. The SDK
applies a post-hoc heuristic at enrichment time: any `POST` to a page
route (not `/api/*`, not `/_next/*`) is almost always a Server Action
invocation in idiomatic App Router code. When the heuristic matches,
the SDK adds the attribute:

```
glasstrace.next.action.detected = true
```

The attribute is labeled `detected` rather than `confirmed` because rare
false-positives are possible (legacy form POSTs, hand-rolled page-route
POST handlers). The heuristic cannot identify *which* Server Action
ran — that requires the `Next-Action` request header, which the
Glasstrace browser extension captures.

### Correlating a trace with browser extension data

To correlate a server-captured trace with extension-side action data,
call `captureCorrelationId` from a Next.js `middleware.ts` (or any
custom server request hook that runs inside the request's OTel context):

```ts
// middleware.ts
import { captureCorrelationId } from "@glasstrace/sdk";
import { NextResponse } from "next/server";

export function middleware(req: Request) {
  captureCorrelationId(req);
  return NextResponse.next();
}
```

`captureCorrelationId` reads the `x-gt-cid` header from an incoming
request and sets it as `glasstrace.correlation.id` on the currently
active span. It accepts either a Fetch-API `Request` / `NextRequest`
or a Node `IncomingMessage`. The helper is defensive: no active span,
missing header, or malformed input are all silent no-ops — it never
throws from a request hook.

### Installation nudge

When the heuristic fires and the span has no
`glasstrace.correlation.id` attribute (i.e. the extension was not
active for that request), the SDK writes a single stderr nudge per
process recommending the browser extension:

```
[glasstrace] Detected a Next.js Server Action trace. Install the
Glasstrace browser extension to capture the Server Action identifier
for precise action-level debugging. https://glasstrace.dev/ext
```

Silence the nudge by setting:

```
GLASSTRACE_SUPPRESS_ACTION_NUDGE=1
```

The nudge never fires in production (detected via `NODE_ENV` or
`VERCEL_ENV`) unless `GLASSTRACE_FORCE_ENABLE=true` is also set.

## Browser-extension discovery

`glasstrace init` writes a small static file at
`public/.well-known/glasstrace.json` (or `static/.well-known/glasstrace.json`
on SvelteKit) so the Glasstrace browser extension can discover your
project's anonymous key without a runtime HTTP handler. The file
contains only a schema version and the project's anonymous key — it
is public metadata, not a secret, and should be committed to source
control alongside the rest of your project.

The SDK no longer requires `createDiscoveryHandler` to be wired into
your server. If you previously registered the handler (for example,
inside `middleware.ts` or `proxy.ts` on Next.js), you can remove the
handler code and the extension will read the static file instead.

### Migration: removing the runtime discovery handler

**Next.js 15 and earlier (`middleware.ts`):**

```ts
// Before: middleware.ts
import { createDiscoveryHandler } from "@glasstrace/sdk";
import { NextResponse } from "next/server";

const discoveryHandler = createDiscoveryHandler(/* getAnonKey */, /* getSessionId */);

export async function middleware(req: Request) {
  const response = await discoveryHandler(req);
  if (response !== null) return response;
  return NextResponse.next();
}
```

```ts
// After: middleware.ts (only the non-Glasstrace logic remains)
import { NextResponse } from "next/server";

export function middleware(_req: Request) {
  return NextResponse.next();
}
```

**Next.js 16 and later (`proxy.ts`):**

Next.js 16 replaces `middleware.ts` with `proxy.ts`. If your project
invoked the discovery handler from `middleware.ts`, migrate it to the
new file convention and drop the handler in the same edit:

```ts
// Before: proxy.ts (Next 16+)
import { createDiscoveryHandler } from "@glasstrace/sdk";
import { NextResponse } from "next/server";

const discoveryHandler = createDiscoveryHandler(/* getAnonKey */, /* getSessionId */);

export async function proxy(req: Request) {
  const response = await discoveryHandler(req);
  if (response !== null) return response;
  return NextResponse.next();
}
```

```ts
// After: proxy.ts (Next 16+)
import { NextResponse } from "next/server";

export function proxy(_req: Request) {
  return NextResponse.next();
}
```

If `proxy.ts` no longer does anything else, you can delete it entirely.

`createDiscoveryHandler` was removed from the public API in `v1.0.0`.
The runtime handler is installed automatically in anonymous + development
mode — there is nothing to wire up yourself. Run `npx glasstrace init`
after upgrading to generate the static file; the extension reads the
file directly and no longer needs the runtime handler.

## Subpath exports

`@glasstrace/sdk` ships three public entries:

- **`@glasstrace/sdk`** — primary import site. Use from
  `instrumentation.ts` (runtime instrumentation) and `next.config.ts`
  (via `withGlasstraceConfig`). The Node-only build-time helpers that
  previously lived here (source-map upload, import-graph construction)
  were moved to `@glasstrace/sdk/node` in this release so the root
  specifier no longer drags `fs` / `path` / `@vercel/blob` into the
  closure. The remaining root surface is intended for Node / serverful
  runtimes; workloads running strictly on workerd or Vercel Edge
  should import from the internal edge-entry bundle — not currently
  exposed as a public entry — or ask for a public `/edge` subpath.
- **`@glasstrace/sdk/node`** — Node-only build-time tooling
  (source-map uploading, import-graph construction). Use from
  `next.config.ts` / build scripts. Resolves only under the Node
  condition; non-Node runtimes (workerd, edge-light) fail cleanly at
  module resolution rather than at evaluation.
- **`@glasstrace/sdk/drizzle`** — Drizzle ORM adapter.

The source-map and import-graph helpers previously reachable from the
`@glasstrace/sdk` root specifier have moved to `@glasstrace/sdk/node`
to narrow the root surface. Update imports:

```ts
// Before
import { uploadSourceMapsAuto } from "@glasstrace/sdk";
// After
import { uploadSourceMapsAuto } from "@glasstrace/sdk/node";
```

## Security

The SDK transmits your API key exclusively via the `Authorization: Bearer`
header on every outbound request. The key is never included in JSON request
bodies, which eliminates exposure through proxy access logs, WAF logging,
CDN request-logging, and application-level middleware that captures request
bodies for debugging. This applies to all SDK-originated requests:
`/v1/sdk/init`, `/v1/source-maps`, and the presigned upload flow
(`/v1/source-maps/presign`, `/v1/source-maps/manifest`). The
[`no-api-key-in-body` regression tests](https://github.com/Erik-1259/glasstrace-sdk/blob/main/tests/unit/sdk/no-api-key-in-body.test.ts)
enforce this invariant continuously.

## License

[MIT](./LICENSE)
