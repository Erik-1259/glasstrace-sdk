# @glasstrace/sdk

Server-side debugging SDK for AI coding agents. Captures traces,
errors, and runtime context from your Node.js application and delivers
them to coding agents through an MCP server and live dashboard.

> **Status:** Stable, published as [`@glasstrace/sdk`](https://www.npmjs.com/package/@glasstrace/sdk) on npm.
>
> ```bash
> npm install @glasstrace/sdk
> ```
>
> See [CHANGELOG.md](https://github.com/Erik-1259/glasstrace-sdk/blob/main/packages/sdk/CHANGELOG.md)
> for the release history.

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
call `captureCorrelationId` from a Next.js `middleware.ts` (or
`proxy.ts` on Next 16+, or any custom server request hook that runs
inside the request's OTel context):

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

## Capturing error response bodies

When debugging a 4xx or 5xx, the response body is often the most useful
signal — it carries the validation message, the tRPC error envelope, or
the upstream error code. The SDK can attach the body to the span as
`glasstrace.error.response_body`, but only under a strict three-gate
policy designed to prevent accidental leakage of customer data:

1. **Account opt-in.** The capture is gated on the
   `errorResponseBodies` flag in your account's capture configuration,
   which the SDK fetches at init time. The flag defaults to `false`, so
   no body is ever attached unless your account has explicitly enabled
   it.
2. **HTTP error status.** The body is only attached when the span's
   HTTP status is in `[400..599]`. A successful response (2xx/3xx)
   never leaks even if an upstream adapter populated the internal
   attribute.
3. **Adapter-supplied body.** The exporter does not read response
   bodies itself. An adapter (e.g., a future tRPC handler wrapper) sets
   the body on `glasstrace.internal.response_body`; the exporter
   promotes it to the public `glasstrace.error.response_body` attribute
   only when the gates above pass.

Before promotion, the body is sanitized to redact common secret
patterns — Bearer tokens, JWT-shaped tokens, Glasstrace API keys
(`gt_dev_*` / `gt_anon_*`), AWS access-key prefixes (`AKIA…` /
`ASIA…`), and generic `apikey`/`secret`/`password`/`token` key-value
pairs — and truncated to 4096 UTF-8 bytes with a `...[truncated]`
marker appended when truncation fires. Truncation respects codepoint
boundaries so multi-byte characters are never split mid-sequence.

If your account does not enable the flag, the SDK ships zero response
body data. If your account enables the flag but a span never carries
the internal attribute (no adapter set it), the public attribute is
still absent. The default is "off, twice".

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

`@glasstrace/sdk` ships four public entries:

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
- **`@glasstrace/sdk/trpc`** — tRPC middleware-chain instrumentation.
  See "tRPC middleware instrumentation" below.

The source-map and import-graph helpers previously reachable from the
`@glasstrace/sdk` root specifier have moved to `@glasstrace/sdk/node`
to narrow the root surface. Update imports:

```ts
// Before
import { uploadSourceMapsAuto } from "@glasstrace/sdk";
// After
import { uploadSourceMapsAuto } from "@glasstrace/sdk/node";
```

### `/node` surface by symbol

The `@glasstrace/sdk/node` subpath is Node-only by design: the
package's conditional exports resolve `./node` under the Node
condition only, so any non-Node runtime (workerd, Vercel Edge, the
browser) fails at module resolution rather than at evaluation. Most
symbols additionally depend on a Node built-in module (`node:fs`,
`node:path`, `node:crypto`, `node:child_process`) or on the
`@vercel/blob` optional peer dependency. A handful — the pure
constant `PRESIGNED_THRESHOLD_BYTES`, the type-only exports, and the
pure string helper `extractImports` — have no direct Node dependency
of their own; they live under `/node` for API cohesion with the
upload and import-graph flows they belong to. The source-file JSDoc
on each symbol names its specific dependency (or notes "pure" /
"erases at runtime"); the table below summarizes the `/node` surface
and the recommended call site.

| Symbol | Kind | Node dependency | Edge-safe alternative |
|---|---|---|---|
| `discoverSourceMapFiles` | function | `node:fs`, `node:path` | — (call from a build script / `next.config.ts`) |
| `collectSourceMaps` | function | `node:fs`, `node:path` | — (call from a build script / `next.config.ts`) |
| `computeBuildHash` | function | `node:child_process` (git), `node:crypto`, `node:fs` | Pass a pre-computed build hash directly to `uploadSourceMaps` |
| `uploadSourceMaps` | function | `node:fs` (when given `SourceMapFileInfo[]`) | — (upstream discovery is Node-only) |
| `PRESIGNED_THRESHOLD_BYTES` | constant | — (pure value) | — (consume alongside the Node-only upload helpers) |
| `uploadSourceMapsPresigned` | function | `node:fs`, `@vercel/blob` | — (call from a build script / `next.config.ts`) |
| `uploadSourceMapsAuto` | function | `node:fs`, `@vercel/blob` (optional) | — (call from a build script / `next.config.ts`) |
| `SourceMapFileInfo` | type | — (erases at runtime) | — (produced/consumed by Node-only functions) |
| `SourceMapEntry` | type | — (erases at runtime) | — (produced/consumed by Node-only functions) |
| `BlobUploader` | type | — (erases at runtime) | — (produced/consumed by Node-only functions) |
| `AutoUploadOptions` | type | — (erases at runtime) | — (produced/consumed by Node-only functions) |
| `discoverTestFiles` | function | `node:fs`, `node:path` | — (call from a build script / CI job) |
| `extractImports` | function | — (pure string processing) | — (kept under `/node` for API cohesion with `buildImportGraph`) |
| `buildImportGraph` | function | `node:fs`, `node:path`, `node:crypto` | — (call from a build script / CI job) |

Type exports erase at runtime and are technically safe to import from
edge code, but every runtime function that produces or consumes them is
Node-only, so the practical signal is the same: reach for these from
your build pipeline, not from a request handler.

#### Why is X Node-only?

Two mechanisms together produce the runtime split:

1. **Conditional exports in `packages/sdk/package.json`** make
   `@glasstrace/sdk/node` resolvable only under Node's `node` export
   condition. Workerd, Vercel Edge, browsers, and any other runtime
   that does not set the `node` condition fail at module resolution
   rather than at evaluation. That is what keeps any given symbol off
   the edge surface once it lives under `/node`.
2. **The edge-bundle gate** (`packages/sdk/scripts/check-edge-bundle.mjs`)
   then guarantees the *opposite* direction: the main edge bundle
   (`dist/edge-entry.*`) is scanned for any reference to the Node
   `process` global or any Node built-in specifier (`node:fs`, bare
   `fs`, `fs/promises`, and so on), and the build fails if any are
   found. So a symbol that reaches for `process` or a Node built-in
   cannot accidentally end up on the edge side.

The gate is scope-aware about shadowing — a local binding named
`process` does not trip it — but it is deliberately not
control-flow-aware: a `process.env.X` read or a static `require("fs")`
keeps a symbol on the Node-only side even when the read is wrapped in
`typeof process !== "undefined"` or in a `try { ... } catch` guard. A
`typeof` guard means "this module reaches for `process`", and an
edge-safe module should not reach for `process` at all.

This is by design. Per the SDK-033 strict-gate policy, the contract
"this bundle passes the gate" must imply "this bundle is safe in any
edge runtime", and that implication only holds if the gate refuses
guards rather than trusting them. If you need a symbol that is currently
on the Node-only side to become edge-safe, the right move is to remove
the `process` and Node built-in reaches from the symbol's transitive
closure, not to add a runtime guard.

## tRPC middleware instrumentation

The `@glasstrace/sdk/trpc` subpath exposes `tracedMiddleware`, a thin
wrapper that turns a user-supplied tRPC middleware function into a
span-emitting middleware function. Each invocation opens a child span
named `options.name` under the active OTel context (typically the HTTP
server span), so middleware steps land as children of the HTTP span
without manual context plumbing. Errors thrown from the middleware
body are recorded via `span.recordException` and propagate unchanged;
short-circuit `{ ok: false, error }` results mark the span `ERROR`
without recording an exception.

`@trpc/server` is declared as an optional peer dependency
(`^10.0.0 || ^11.0.0`); projects that do not use tRPC pay no runtime
cost because the subpath is excluded from the root barrel and is
tree-shakeable.

```ts
// trpc.ts — your project
import { initTRPC, TRPCError } from "@trpc/server";
import { tracedMiddleware } from "@glasstrace/sdk/trpc";

interface MyContext { session?: { userId: string }; tier?: string }
const t = initTRPC.context<MyContext>().create();

const isAuthed = t.middleware(
  tracedMiddleware({ name: "isAuthed" }, async ({ ctx, next }) => {
    if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
    return next({ ctx: { ...ctx, session: ctx.session } });
  }),
);

const isPro = t.middleware(
  tracedMiddleware({ name: "isPro" }, async ({ ctx, next }) => {
    if (ctx.tier !== "pro") throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  }),
);

export const proProcedure = t.procedure.use(isAuthed).use(isPro);
```

The wrapped function preserves the original middleware's call-site type,
so tRPC's procedure-builder context narrowing flows through unchanged.
The existing `glasstrace.trpc.procedure` attribute (set on the parent
HTTP span) is not duplicated on the middleware child spans — middleware
spans carry only `trpc.path`, `trpc.type`, and any caller-supplied
`options.attributes`. Caller-supplied attributes are forwarded as-is;
the SDK does not redact them, so callers must avoid placing tokens or
credentials in `options.attributes`.

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
