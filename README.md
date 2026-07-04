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

### Boundary-masked error detection

When an HTTP request handler surfaces an error signal on its span
(via `span.setStatus(ERROR)`, OTel's `recordException()`, or by
setting `exception.*` span attributes) but returns an HTTP 200
response — a common pattern when frameworks catch errors and
render fallback pages — the SDK promotes the trace's inferred
`status_code` to 500 (or, when the span carries a numeric
`error.type` attribute in the 400-599 range, to that parsed value)
so the error is visible to error-based queries like
`get_latest_error`. Promotion fires when ALL of:

1. The HTTP server span has either `status.code === ERROR`, an
   `exception` event, or `exception.*` attributes.
2. `http.status_code` is in `{200, 0, undefined}`.
3. The span's status is not explicitly `OK`.

When promotion fires, the SDK also sets
`glasstrace.http.boundary_masked: true` as an audit attribute and
emits the `core:error_boundary_detected` lifecycle event
(`{ spanId, inferredStatus, exceptionMessage? }`).

**Suppression options** (for graceful-degradation patterns where you
want to keep the 200 status):

- Avoid calling `recordException()` for intentional graceful errors
  — these aren't unhandled exceptions, so the heuristic naturally
  excludes them.
- Set the OTel span status to `OK` (instead of leaving it at
  `ERROR`/`UNSET`) — this clears the heuristic's trigger condition.

The SDK deliberately does not document spoofing `http.status_code`
to a non-trigger value as a suppression mechanism; that pattern
corrupts downstream telemetry semantics.

**Same-span scope.** Today the heuristic only fires when the HTTP
server span itself carries the exception signal. The case where an
exception lives in a child span (e.g., a database query span) and
the parent HTTP span returns 200 with no exception event is not
yet covered; it requires descendant-traversal in the exporter and
is tracked as a follow-up.

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

`withGlasstraceConfig()` configures four things for you:

- **Server source maps** — `experimental.serverSourceMaps` is enabled so
  Glasstrace can resolve stack traces back to your source.
- **Turbopack/webpack parity** — an empty `turbopack: {}` is seeded when
  none is set so Next 16 does not reject builds that configure `webpack`
  without a companion `turbopack` key.
- **Server-external SDK** — `@glasstrace/sdk` is added to
  `serverExternalPackages` (Next 15+) so the SDK is loaded via Node's
  `require()` at runtime instead of bundled through webpack or
  Turbopack for RSC / Route Handler paths. This mirrors the pattern
  used by Prisma, `@vercel/otel`, Sentry, `sharp`, and `bcrypt`.
- **Node-builtin webpack externals** — on webpack server compilations,
  `node:*` and bare Node built-ins (`fs`, `path`, `child_process`,
  `zlib`, etc.) are marked as `commonjs` externals. This is the
  authoritative fix for `next dev --webpack` `UnhandledSchemeError`
  failures on the instrumentation path.

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

### Prisma Value Capture

Capture specific boolean and numeric result columns onto your traces so
an agent debugging a failure can see the value a query actually returned
— not just that the query ran. Apply the adapter as a Prisma client
extension:

```typescript
import { PrismaClient } from "@prisma/client";
import { prismaAdapter } from "@glasstrace/sdk";

const prisma = new PrismaClient().$extends(
  prismaAdapter({
    allow: [{ model: "Poll", column: "muted" }],
  }),
);
```

For an eligible operation the adapter opens a single `db.<Model>.<op>`
span and records each allowlisted column on it as a value-fidelity
scalar (`muted` → `mutedFlag`).

Capture numeric columns with an `as` intent on the allow entry — the
scalar key is the column with the intent's suffix appended (not doubled
if the column already ends in it), and the value is strict-validated by
type:

```typescript
prismaAdapter({
  allow: [
    { model: "Poll", column: "muted" },                    // boolean → mutedFlag
    { model: "Upload", column: "size", as: "bytes" },      // number  → sizeBytes
    { model: "Request", column: "durationMs", as: "ms" },  // number  → durationMs
  ],
});
```

`as` is one of `"flag"` (default, boolean), `"value"` / `"amount"` /
`"ms"` / `"bytes"` / `"ratio"` (finite number; `ms` is a bounded delta,
not a wall-clock timestamp), or `"id"` (a pseudonymized identifier — see
below). A value whose type does not match its intent is dropped, never
captured.

Numeric intents capture native JavaScript `number` columns (Prisma
`Int` / `Float`). A Prisma `Decimal` (a Decimal.js object) or `BigInt`
is not a native `number`, so it is safely omitted rather than lossily
converted — convert it to a `number` in your own code first if you need
to capture it (mind the precision trade-off for money).

The `"id"` intent captures an identifier column (`*Id`) as a stable,
opaque `gthid_<hex>` token — the raw id is hashed under a per-account key
and never reaches the wire. It is captured only when an operator has set
your account to full-fidelity capture **and** the per-account key is
provisioned. Without full-fidelity capture the intent is simply off (no
scalar, no counter); under full-fidelity capture with a missing key (or a
non-string/number id) the column is dropped and a count-only `unhashed_id`
omission is recorded so the misconfiguration stays visible. Use it to
correlate the same entity across traces without exposing the raw id.

The adapter is **passive and default-deny**:

- It never executes, mutates, or alters a query — the original result
  and any error pass through unchanged.
- Nothing is captured unless a column is explicitly listed in `allow`
  **and** value capture is enabled for your account. With an empty or
  unset `allow`, it captures nothing and adds no spans.
- Booleans and numbers are captured by their `as` intent; identifiers
  are captured only as pseudonymized `gthid_` tokens under full-fidelity
  capture, never raw. Categorical columns are not captured, and
  `findMany` / list queries are not captured.
- It has no dependency on `@prisma/client` and is safe to import in any
  runtime; on a runtime with no active request span it captures
  nothing.

To project onto a span you own from a custom adapter, use the
lower-level `capture` primitive:

```typescript
import { capture } from "@glasstrace/sdk";

const span = tracer.startSpan("db.Poll.findUnique");
try {
  const row = await runQuery();
  if (row) capture("mutedFlag", row.muted, { span });
  return row;
} finally {
  span.end();
}
```

`capture` validates the value against the scalar allowlist (a `*Flag`
key requires a boolean), is gated by your account's capture
configuration, and never throws.

### Middleware-Ownership Tracing

Wrap a Next.js `middleware.ts` (or any Web Fetch-shaped middleware
function) so the resulting span is tagged with the originating
request's path. The product-side trace summary uses the
`glasstrace.causal.middleware_for_request` attribute to link the
middleware span back to the owning HTTP request trace, even when the
middleware runs in the Edge Runtime where AsyncLocalStorage parents
are not available.

```typescript
// middleware.ts
import { tracedRequestMiddleware } from "@glasstrace/sdk/middleware";
import { NextResponse, type NextRequest } from "next/server";

export const middleware = tracedRequestMiddleware(
  { name: "auth-middleware" },
  async (req: NextRequest) => {
    if (!req.cookies.get("session")) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
    return NextResponse.next();
  },
);

export const config = { matcher: ["/dashboard/:path*"] };
```

The wrapper is included in the SDK's edge bundle. It uses only the
OpenTelemetry API and emits the originating path as a span attribute
— no `node:async_hooks`, no `process` reads — so the same import
works in both Node and Edge runtimes.

> **Privacy note.** The path emitted to
> `glasstrace.causal.middleware_for_request` is the raw URL pathname
> (clamped to 2048 characters with a trailing ellipsis for unusually
> long URLs). Pathnames in real applications can carry user-controlled
> data (user IDs, email addresses, document slugs, opaque keys). Apart
> from that length clamp, the SDK does NOT redact or sanitize the
> pathname — that is the caller's responsibility per general HTTP best
> practice ("do not put secrets in URLs"). If your application places sensitive identifiers in path
> positions, either rewrite to header/body parameters before the SDK
> sees them, or accept that the path will appear in trace evidence
> the same way it appears in your own server logs.

### Post-Response Async Tracing

Wrap callbacks scheduled via Next.js `after()`, queue dispatchers, or
webhook fire-and-forget so the resulting async span carries a causal
link back to the originating request trace.

```typescript
// app/api/orders/route.ts
import { withAsyncCausality } from "@glasstrace/sdk/async-context";
import { after } from "next/server";

export async function POST(req: Request) {
  const result = await processRequest(req);
  after(
    withAsyncCausality(
      { name: "send-confirmation-email" },
      async () => sendEmail(result.userId),
    ),
  );
  return Response.json({ ok: true });
}
```

The wrapper captures the active OpenTelemetry `SpanContext` at call
time, then emits a span when the continuation runs that carries:

- An OpenTelemetry `Link` to the originating trace (visible in
  standard OTel-aware UIs as a "follows from" relationship), and
- The `glasstrace.causal.post_response_async` attribute carrying the
  originating trace ID, plus
  `glasstrace.causal.affects_http_status = false` and
  `glasstrace.causal.affects_http_duration = false` documenting that
  the async work does NOT participate in the root request's outcome.

When the wrapper is invoked outside any active request span (for
example, captured at module top-level), the callback still runs but
no causal evidence is emitted — missing evidence is preferable to
guessed evidence.

### tRPC Batch Member Tracing

When tRPC's HTTP-batch link bundles multiple procedures into a
single HTTP request (e.g.,
`GET /api/trpc/polls.get,polls.comments.list?batch=1`), the SDK
collapses the batch into one root HTTP server span. The new opt-in
`wrapBatchedHttpHandler` adds per-member span attribution so each
procedure's middleware span is labeled with its position in the
batch:

```ts
import { wrapBatchedHttpHandler, tracedMiddleware } from "@glasstrace/sdk/trpc";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

const handler = (req: Request) =>
  fetchRequestHandler({ endpoint: "/api/trpc", req, router });

// app/api/trpc/[trpc]/route.ts
export const POST = wrapBatchedHttpHandler(handler);
export const GET = wrapBatchedHttpHandler(handler);
```

When `tracedMiddleware` (also from `@glasstrace/sdk/trpc`) is in
the procedure chain, each member span gains:

- `glasstrace.trpc.batch.member_index` (number) — zero-based
  positional index in the batch. Load-bearing for batches that
  include the same procedure name more than once.
- `glasstrace.trpc.batch.member_procedures` (string array) — the
  full ordered list of procedure names in the batch.

If your tRPC handler is mounted at a non-default base path (e.g.
`/api/v2/trpc/`), pass it explicitly:

```ts
export const POST = wrapBatchedHttpHandler(handler, {
  basePath: "/api/v2/trpc/",
});
```

**Out of scope (today):**

- Per-member duration / status / DB attribution at the agent-facing
  query layer — still requires companion product-side ingestion +
  MCP projection work; tracked as an open follow-up.
- The root HTTP server span's `glasstrace.trpc.procedure` attribute
  remains the comma-joined member list (unchanged from prior
  releases).

Apps NOT using `wrapBatchedHttpHandler`, and apps NOT using
`tracedMiddleware`, see no trace-shape change.

## Coexistence with Other OTel Tools

Glasstrace coexists with any tool that owns the OpenTelemetry
`TracerProvider` — Sentry, Datadog, New Relic, Next.js 16 production
builds, or a custom setup. If another provider is already registered
when `registerGlasstrace()` runs, the SDK automatically attaches its
span processor onto that provider. No manual wiring is required.

### Automatic Attachment (default)

```typescript
// instrumentation.ts
import { registerGlasstrace } from "@glasstrace/sdk";

export async function register() {
  registerGlasstrace();

  // Dynamic imports run after registerGlasstrace(). This is the
  // recommended order: hoisted ES module imports of Sentry, Datadog,
  // etc. would register their provider before registerGlasstrace()
  // runs, which still works (auto-attach) but this order keeps the
  // provider-claim logic deterministic.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@sentry/nextjs");
    await import("../sentry.server.config");
  }
}
```

When Glasstrace detects a pre-registered provider, it:

1. Checks whether its span processor is already attached (idempotent).
2. Uses the provider's `addSpanProcessor()` public API when available.
3. Falls back to injecting into the provider's processor list for
   OTel SDK v2 (which removed `addSpanProcessor()`).
4. Emits an informational log message identifying the auto-attach path.

### Manual Integration (recommended for Sentry)

For the cleanest setup with Sentry, pass
`createGlasstraceSpanProcessor()` directly into Sentry's config:

```typescript
import * as Sentry from "@sentry/nextjs";
import {
  registerGlasstrace,
  createGlasstraceSpanProcessor,
} from "@glasstrace/sdk";

Sentry.init({
  dsn: "...",
  openTelemetrySpanProcessors: [createGlasstraceSpanProcessor()],
});

registerGlasstrace();
```

`registerGlasstrace()` is still required — the processor handles span
transport, but `registerGlasstrace()` owns init, config sync, session
management, anonymous key generation, the discovery endpoint, and
health reporting.

### Generic Provider

For any provider constructed via `BasicTracerProvider`, pass the
processor in the `spanProcessors` array:

```typescript
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  registerGlasstrace,
  createGlasstraceSpanProcessor,
} from "@glasstrace/sdk";

const provider = new BasicTracerProvider({
  spanProcessors: [
    // ... your existing processors
    createGlasstraceSpanProcessor(),
  ],
});

registerGlasstrace();
```

## CLI

```bash
npx glasstrace init
```

Scaffolds instrumentation files for your project and auto-configures
MCP for any detected AI coding agents (Claude Code, Cursor, Codex,
Gemini, Windsurf). Agent detection scans for marker files and writes
native MCP configuration so agents can query traces immediately.

**Instrumentation file precedence:** init targets the first matching
location in this order:

1. An existing `src/instrumentation.{ts,js,mjs}` — the user has already
   committed to this location, so merge there.
2. An existing `instrumentation.{ts,js,mjs}` at the project root — same
   rationale.
3. A new `src/instrumentation.ts` when the project contains a `src/`
   directory at its root (the common Next.js convention used by many
   apps, including those that already have `src/instrumentation.ts` for
   Sentry or Datadog).
4. A new `instrumentation.ts` at the root when no `src/` directory is
   present.

Next.js only loads instrumentation from one of the two locations, so
scaffolding to the wrong one was a silent failure — the SDK was
installed but never ran.

**Merge into existing instrumentation:** If the target file already
exists, init merges rather than overwriting:

- If it exposes an `export [async] function register()`, init inserts
  `registerGlasstrace()` as the first statement of the existing body and
  imports `registerGlasstrace` at the top of the file.
- If it has no `register()` function (e.g., only contains a top-level
  Sentry import), init appends a new `export async function register()`
  that calls `registerGlasstrace()`.
- If `registerGlasstrace()` is already present, init is a no-op.

Before modifying an existing file, init prompts for confirmation. Pass
`--force` (or `--yes`) to skip the prompt for automated environments.

**Both-layout conflict:** If the project has **both** `instrumentation.ts`
at the root **and** `src/instrumentation.ts`, init exits with an error
without modifying either file. Next.js's loader behavior is undefined
when both are present: it will pick one and silently ignore the other.
Merge your code into `src/instrumentation.ts` and delete the root file,
then re-run init.

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

### Blocking Init Verification

Before reporting success, `glasstrace init` contacts the Glasstrace API
to verify that your anonymous key is registered server-side. Without
this step, a silent network failure during the runtime SDK's background
init call leaves your anon key unlinked — and subsequent MCP queries
fail with "authentication failed" even though `init` claimed success.

The CLI uses Node's built-in `node:https` module directly for this
request, bypassing any `fetch` patching introduced by Next.js 16's
caching layer.

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0`  | Scaffolding succeeded AND the server confirmed the anon key. |
| `1`  | Scaffolding failed. No verification attempted. |
| `2`  | Scaffolding succeeded but server verification failed. Safe to re-run. |

**Error classes reported on non-zero exit:**

- `fetch failed: <reason>` — the SDK could not reach the Glasstrace API
  (DNS failure, TCP reset, TLS error, or 10-second timeout). The
  request is retried twice with 500ms + 1500ms backoff (20-second
  total cap) before surfacing the failure.
- `server rejected the key (HTTP <status>)` — the API responded with
  a 4xx or 5xx status. Not retried; verify `GLASSTRACE_API_KEY` or
  check Glasstrace status.
- `server returned malformed response` — the API responded 2xx but
  the body was not valid JSON or did not match the expected schema.
  Usually indicates a mid-rollout schema mismatch.

**Skipping verification.** Set `GLASSTRACE_SKIP_INIT_VERIFY=1` to skip
the verification step (useful for offline installs). CI mode skips
verification automatically.

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

### Refreshing agent instruction guidance

```bash
npx glasstrace upgrade-instructions
```

Refreshes the managed Glasstrace MCP section in every detected agent
instruction file (AGENTS.md, CLAUDE.md, GEMINI.md,
.cursor/rules/glasstrace.mdc, .windsurf/rules/glasstrace.md, and the
legacy .cursorrules fallback) so existing projects pick up updated
runtime-evidence guidance on SDK upgrade. Idempotent and safe to
re-run; only files that already contain a Glasstrace marker pair are
touched.

The managed section's start marker carries an SDK version stamp
(e.g. `<!-- glasstrace:mcp:start v=1.5.0 -->`). When the running SDK
detects a strictly older stamp, it writes a single stderr line at
`registerGlasstrace()` time pointing at this command. Suppress the
notice with `GLASSTRACE_DISABLE_UPGRADE_NOTICE=1`. See the
[`@glasstrace/sdk` README](packages/sdk/README.md#refreshing-agent-instruction-guidance)
for the full set of constraints.

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

The SDK also refreshes managed MCP config files (e.g.
`.glasstrace/mcp.json`) so MCP queries see the same credential
ingestion is now writing traces with. The refresh applies only when
the file is byte-equivalent to the SDK-shaped output for the
project's anon key — manually edited MCP configs are preserved
untouched. Re-run `npx glasstrace mcp add` after a claim to refresh
agent-specific configs that were set up via the CLI; the command
detects credential drift via the `.glasstrace/mcp-connected` marker
and re-registers automatically.

## Production Export Resilience

The SDK protects your application from wasted traffic when the
Glasstrace ingest endpoint is unreachable or rejecting batches
(invalid credentials, server outage, network partition). A circuit
breaker on the export path counts consecutive non-success exports
and trips after **five consecutive failures**, dropping subsequent
batches until a probe succeeds.

Behavior:

- **Trip threshold**: 5 consecutive failed export attempts. Any 2xx
  response resets the counter.
- **Backoff**: 30 seconds initially, doubling on each failed probe up
  to a 30-minute cap (30s → 60s → 120s → 240s → 480s → 960s →
  1800s).
- **Drop-not-buffer**: while the breaker is OPEN, span batches are
  dropped via the existing `recordSpansDropped` health surface. No
  unbounded buffering. The BSP never retries (the OPEN window is
  itself the backoff).
- **Recovery**: when the timer expires, the next real batch acts as
  the probe. If it succeeds the breaker closes. If it fails the
  timer doubles and the cycle repeats.
- **Credential rotation**: when `registerGlasstrace()` or the
  background heartbeat resolves a different API key, the breaker
  resets to CLOSED immediately. An in-flight probe at rotation time
  is invalidated via a generation counter — its outcome is ignored
  so a stale failure cannot poison the post-rotation breaker.
- **FSM coupling**: while the breaker is OPEN the SDK reports
  `getStatus().tracing === "degraded"`; when the breaker recovers
  and no other degradation source is active, `tracing` returns to
  `"active"`.

Operational visibility:

- `getStatus().tracing` returns `"degraded"` while the breaker is
  OPEN.
- `.glasstrace/runtime-state.json` records the most recent OPEN
  state under `lastError` with `category: "export-circuit-open"` and
  `exportCircuitCategory` set to the failure class (`"auth"`,
  `"client_error"`, `"rate_limit"`, `"server_error"`, or
  `"network"`). The record is cleared automatically when the breaker
  recovers.
- `npx glasstrace status` surfaces both fields without requiring a
  live process connection.

Internally the breaker emits three structured lifecycle events
(`otel:circuit_opened`, `otel:circuit_half_open`,
`otel:circuit_closed`) that the runtime-state writer subscribes to.
Their payloads are PII-safe by construction — the closed `category`
enum, a fixed-template `message`, and structured numeric/timestamp
fields only (e.g. `consecutiveFailures`, `nextProbeMs`,
`previousTimerMs`, `outageDurationMs`, ISO-8601 `timestamp`). No
URLs, headers, request bodies, or credentials are ever included.

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

Server-only utilities (`collectSourceMaps`, `buildImportGraph`) live
under the `@glasstrace/sdk/node` subpath, require Node.js, and should
be excluded from browser bundles via your bundler's externalization
config.

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
