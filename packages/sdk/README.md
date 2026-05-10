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
| `1` | Scaffolding failed, OR the static-discovery file at `public/.well-known/glasstrace.json` could not be written. The browser extension cannot discover the project until that file is written; rerun `glasstrace init` after fixing the underlying error (most commonly: the static root is missing or read-only). |
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

## Getting help

```bash
glasstrace --help        # or: glasstrace -h
glasstrace init --help   # same; help short-circuits subcommand routing
```

Help invocations print the command list and exit cleanly without
modifying the project. Help is detected anywhere in the argv slice,
including composite invocations like `glasstrace init --yes --help`
(the `--yes` is ignored — the user asked for help).

## Refreshing agent instruction guidance

`glasstrace init` and `glasstrace mcp add` write a managed Glasstrace
MCP section into your project's agent instruction file(s). Per the
2026 cross-tool standard governed by the Agentic AI Foundation under
the Linux Foundation (`agents.md`), the SDK writes:

- **`AGENTS.md`** — universal cross-tool destination. Read by Cursor,
  Codex, Claude Code, GitHub Copilot, Devin, Windsurf, and Gemini CLI.
  Always written.
- **`CLAUDE.md`** — Claude Code primary canonical destination.
- **`GEMINI.md`** — Gemini CLI primary canonical destination (default
  `context.fileName`).
- **`.cursor/rules/glasstrace.mdc`** — Cursor canonical 2026
  destination (Markdown-extension format with YAML frontmatter
  `alwaysApply: true`); plus `.cursorrules` written unconditionally
  as a transitional fallback for migration teams on mixed Cursor
  versions.
- **`.windsurf/rules/glasstrace.md`** — Windsurf workspace-rules
  directory (active first-class format per Windsurf's docs at
  `windsurf.com/university`).

The section opens with explicit "Call Glasstrace FIRST when" / "SKIP
Glasstrace when" decision rules telling your AI agent **when**
Glasstrace MCP is worth calling and **which** tool is the cheapest
first call for each symptom class.

### Migration from legacy filenames

If you installed `@glasstrace/sdk` before v1.11 (Wave 18 / DISC-1782),
your project may have a managed Glasstrace block in legacy
destinations the SDK no longer writes to as primary:

- `codex.md` (Codex now reads `AGENTS.md` by default)
- `.windsurfrules` (Windsurf moved to `.windsurf/rules/*.md`)

Run `npx glasstrace upgrade-instructions` to migrate: the managed
section is created at the new canonical destination(s). The legacy
files are left untouched (their managed sections become stale but
your free-text content is preserved); copy any custom prose from the
legacy file to `AGENTS.md` to keep your agent's visibility into it.

If you need to roll back to a pre-v1.11 SDK, pin to `~1.10.0` in
`package.json`; the older SDK does not recognize `AGENTS.md` /
`GEMINI.md` / `.cursor/rules/` as agent-instruction targets so its
stale-section warning will not see them.

The managed section's start marker carries an SDK version stamp, e.g.
`<!-- glasstrace:mcp:start v=1.5.0 -->`. When you upgrade
`@glasstrace/sdk`, run:

```bash
npx glasstrace upgrade-instructions
```

The command refreshes every detected agent instruction file in one
run. Files outside the markers are untouched; files without a
Glasstrace managed section are left alone. The command is idempotent
— re-running produces byte-for-byte identical output.

`npx glasstrace mcp add` performs the same managed-section refresh
when run with `--force` (or against a project whose marker file has
shifted credentials), so either command is a valid upgrade path.

### Stale-section warning at SDK init

When the running SDK detects that an agent instruction file's stamp
is strictly older than the running version, it writes a single
stderr line at `registerGlasstrace()` time pointing at the upgrade
command. Constraints:

- Stderr only, never stdout. Tracing behaviour is unaffected.
- At most one warning per process boot, even when multiple
  `registerGlasstrace()` calls happen (test runners, hot reload).
- Node-only — no-op on Edge / browser runtimes. Never throws.
- Does not mutate any file at runtime; the user opts in by running
  the upgrade command.
- Suppressed by setting one of:

  ```bash
  GLASSTRACE_DISABLE_UPGRADE_NOTICE=1
  GLASSTRACE_DISABLE_UPGRADE_NOTICE=true
  GLASSTRACE_DISABLE_UPGRADE_NOTICE=yes
  ```

  (case-insensitive). Any other value, including unset, leaves the
  warning enabled.

Legacy unstamped managed sections (written by `@glasstrace/sdk`
versions before 1.5.0) trigger no warning — those projects receive
the refreshed text on their next `mcp add` or
`upgrade-instructions` run, and the upgrade replaces the legacy
block in place rather than appending a duplicate.

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

## Production deployment under Next 16

As of `@glasstrace/sdk@1.3.5`, auto-attach detection now classifies the
SDK's own bundled proxy correctly under bundler minification (DISC-1556
— verified against the `clean-next-sdk130` validation fixture). The
manual integration documented below remains supported for users who
prefer explicit configuration.

Next 16 (`next build && next start`) registers an OpenTelemetry
TracerProvider before user code runs. When `registerGlasstrace()` then
detects that provider, the SDK attempts to attach its span processor to
the existing pipeline. On most providers this auto-attach succeeds and
no further action is required; on a small number of provider shapes —
including Next 16's production-runtime provider in some versions — the
provider exposes no injection point and auto-attach returns
unsuccessfully. In that case spans flow through the existing pipeline
without reaching the Glasstrace exporter, so no traces appear in MCP
queries or the dashboard.

The SDK signals this case in three ways:

1. **Log line.** The SDK logs a guidance message at `warn` level in
   development and `error` level under `NODE_ENV=production`:

   ```text
   [glasstrace] An existing OTel TracerProvider is registered but
   Glasstrace could not auto-attach its span processor.
   Add Glasstrace to your provider configuration:
   ...
   ```

2. **Programmatic signal.** `getStatus().tracing === "not-configured"`
   after `registerGlasstrace()` has resolved indicates spans are not
   reaching the Glasstrace exporter. Poll this from a health endpoint
   or a startup readiness check:

   ```ts
   import { getStatus } from "@glasstrace/sdk";

   const { tracing } = getStatus();
   if (tracing === "not-configured") {
     // Spans are not being exported. Apply the manual workaround below.
   }
   ```

3. **CLI bridge.** `.glasstrace/runtime-state.json` carries a
   structured `lastError` record that downstream tooling (custom
   dashboards, CI assertions, the `npx @glasstrace/sdk status`
   command in future releases) can surface verbatim:

   ```json
   {
     "otel": { "state": "COEXISTENCE_FAILED", "scenario": "C/F" },
     "lastError": {
       "category": "auto-attach-returned-null",
       "message": "tryAutoAttachGlasstraceProcessor returned null — ...",
       "timestamp": "2026-05-04T12:34:56.789Z",
       "providerClass": "BasicTracerProvider"
     }
   }
   ```

   The `providerClass` field is the constructor name of the existing
   provider's delegate. URLs, headers, and credentials are never
   captured.

### Manual workaround

When auto-attach cannot succeed, register Glasstrace's span processor
on the provider you already own:

```ts
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { createGlasstraceSpanProcessor } from "@glasstrace/sdk";

const provider = new BasicTracerProvider({
  spanProcessors: [
    // ... your existing processors,
    createGlasstraceSpanProcessor(),
  ],
});
```

`createGlasstraceSpanProcessor()` produces a processor with the same
branded exporter the auto-attach path uses, so duplicate
`registerGlasstrace()` calls remain idempotent. `registerGlasstrace()`
is still required when wiring the processor manually — it handles the
init handshake, anonymous-key resolution, and session management, none
of which are owned by the span processor.

A future SDK release may extend the auto-attach detection to recognize
additional Next 16 provider shapes; until that ships, the manual path
above is the production-supported integration.

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

## Capturing error evidence

For server-side errors, the SDK promotes a curated set of OTel
attributes into the `glasstrace.error.*` family so product
consumers can render bounded, sanitized error evidence without
having to parse raw stack traces or framework HTML themselves.

### Bounded stack capture

When an OTel `recordException()` event (or a span attribute carrying
`exception.stacktrace`) is observed on a failed span, the SDK
emits the stack as `glasstrace.error.stack` with two sibling
booleans:

| Attribute | Meaning |
|---|---|
| `glasstrace.error.stack` | The bounded stack string (sanitized, then truncated). Treat this as input for product-side `StackSummary` parsing, not as a final agent-facing artifact. |
| `glasstrace.error.stack.truncated` | `true` if the original exceeded the byte budget and `...[stack truncated]` was appended. |
| `glasstrace.error.stack.redacted` | `true` if at least one sanitization rule modified the stack content (path normalization, URL query stripping, or credential redaction). |

Sanitization runs **before** truncation so credentials straddling
the truncation boundary are still removed from the visible portion.
The sanitizer:

- **Normalizes absolute paths.** A frame like
  `at handler (/Users/erik/proj/src/api/handler.ts:5:1)` becomes
  `at handler (<path>/src/api/handler.ts:5:1)`. The keep-from
  marker set is `node_modules`, `.next`, `.glasstrace`, `src`,
  `dist`, `build`, `lib`, `app`, `pages` (priority order). When no
  marker matches, the path collapses to its basename so
  `/var/private/secret/data.js` becomes `<path>/data.js`.
- **Strips URL query strings and fragments.**
  `https://api.example.com/users?token=secret` becomes
  `https://api.example.com/users`.
- **Redacts credentials** using the same pattern set as
  response-body capture: `Bearer …`, JWT-shaped tokens,
  Glasstrace API key prefixes (`gt_dev_*` / `gt_anon_*`), AWS
  access keys (`AKIA…` / `ASIA…`), and `apikey`/`secret`/
  `password`/`token` key-value pairs.

The byte budget is 8192 UTF-8 bytes. Truncation respects codepoint
boundaries so multi-byte characters are never split mid-sequence.

### Source provenance

When the exporter emits any of the new
`glasstrace.error.{message,code,stack,original_path,fallback_route}`
attributes, it also sets `glasstrace.error.source` to name the
surface that supplied the facts:

| Value | Source |
|---|---|
| `otel_exception` | OTel `recordException()` event (event name `"exception"`). |
| `otel_event` | An OTel-shape `exception.*` attribute set on the span itself instead of on an event. |
| `glasstrace_attribute` | A `glasstrace.error.*` attribute set explicitly by an adapter or user code. |
| `framework_runtime` | Reserved for a future framework-runtime probe. |
| `framework_fallback` | The framework rewrote the route to a fallback (e.g., `/_error`); see below. |
| `response_body` | Reserved for cases where the response body is the only error-bearing surface. |

Product consumers use the source to decide how to render
evidence (an `otel_exception` source can show the raw type and
message; `framework_fallback` is a softer signal that benefits
from the original-path context).

### Framework fallback markers

When a request reaches a framework fallback route — Next.js
`/_error`, `/_not-found`, `/_404`, `/_500` — the SDK preserves
the originally requested path so product consumers don't lose the
URL the user actually hit. Three additional attributes land on
the span:

| Attribute | Example |
|---|---|
| `glasstrace.error.original_path` | `/api/storage/missing/avatar.png` (path-only; no query, no fragment) |
| `glasstrace.error.fallback_route` | `/_error` |
| `glasstrace.error.framework.kind` | `"fallback"` |

The existing `glasstrace.route` attribute continues to carry
whatever the framework instrumentation reported (typically the
fallback route itself), so existing consumers are unaffected.
Product-side projection should prefer `glasstrace.error.original_path`
when present and fall back to `glasstrace.route` otherwise. The
markers fire only when the SDK observed a different requested URL
than the route — a real visit to `/_error` (an app could have a
real such page) is not flagged.

### What the SDK does NOT do

For agent-facing protection, several things are explicitly *not*
emitted from the SDK side:

- **No raw `exception.stacktrace`.** The string is always
  sanitized before promotion to `glasstrace.error.stack`, and the
  source-attribute path that bypassed enrichment never appears in
  agent-facing MCP output (product ingestion projects only the
  `glasstrace.*` family).
- **No fabricated stack frames** when `exception.stacktrace` was
  not observed. Missing stack evidence stays missing; the
  `glasstrace.error.stack*` attributes are simply absent.
- **No compile-diagnostic capture** in this version. If the SDK
  cannot observe a Next.js compile error in the running mode, no
  diagnostic is fabricated from the route name or status code.
  Compile-diagnostic capture is a future feature gated on a
  separate account capture-policy class.
- **No structured application logs.** Application logs are
  outside the trace-evidence contract.

## Capturing side-effect evidence

When debugging a bug whose root cause is which side-effect operation
ran with which non-sensitive semantic value — "the cancellation email
used the wrong locale", "the wrong invite role was sent" — the agent
needs to know template key, role, locale, timezone, status, and phase,
but never the recipient, the rendered subject or body, the calendar
link, or any token that flowed through the operation. The SDK can
record allowlisted side-effect evidence on the active trace via
`recordSideEffect()`, gated by the `sideEffectEvidence` capture-config
flag.

What the SDK captures: a compact, normalized operation label, the
operation kind (`email`, `calendar_link`, `webhook`, `external_api`,
`queue`, `after_callback`), an optional lifecycle status
(`scheduled`, `started`, `succeeded`, `failed`, `unknown`), an
optional execution phase (`request`, `post_response`, `background`,
`unknown`), and a small set of allowlisted semantic fields:
`templateKey`, `providerOperation`, `role`, `locale`, `timezone`,
`status`, `phase`. Each value is bounded to compact tokens — IANA
timezones, BCP-47 locales, identifier-shaped enum tokens. The
per-trace operation budget is five.

What the SDK does not capture: recipient email addresses, sender or
recipient names, rendered email subjects or bodies, calendar links,
invite links, any URL with a query string or fragment, any
`Authorization`/`Cookie`/bearer-shaped value, any
password/token/api_key key-value pair, any UUID, any Glasstrace API
key, any free-form prose, and any structured payload. Values matching
those shapes are silently dropped and replaced with an integer count
under the matching omission attribute. The dropped value never
appears on the span, in any log line, or in any export.

Behavior-neutrality: `recordSideEffect()` is an observer.  It does
not send, retry, duplicate, schedule, or delay any side effect. It
never throws. If no recording span is active, the call is a silent
no-op.

Account opt-in: the capture is gated on the `sideEffectEvidence` flag
in your account's capture configuration, which the SDK fetches at
init time. The flag defaults to `false`, so no side-effect attribute
is ever attached unless your account has explicitly enabled it.

```ts
import { recordSideEffect } from "@glasstrace/sdk";

await mailer.send({ to: recipient, template: "EventCanceledEmail" });
recordSideEffect({
  kind: "email",
  operation: "email.send",
  status: "succeeded",
  phase: "request",
  fields: {
    templateKey: "EventCanceledEmail",
    role: "invitee",
    locale: "en-US",
    timezone: "Europe/Paris",
  },
});
```

The SDK guard protects only callers of `recordSideEffect()`; user
code that bypasses the SDK and writes directly to the OTel span will
still hit the wire as-is and is filtered by the glasstrace-product
ingestion service before persistence. This is intentional
defense-in-depth: the SDK is the first gate; the product receiver
is the second.

## Source maps

Glasstrace uploads server-side source maps at build time and resolves
compiled-output stack frames back to original source on the dashboard
and in agent prompts. Three span attributes connect the runtime trace
to the build-time manifest:

| Attribute | When stamped | Source |
|---|---|---|
| `glasstrace.build.hash` | every server span | `process.env.GLASSTRACE_BUILD_HASH` (read once at module load) |
| `glasstrace.source.file` | error spans only | top user-attributable frame of `Error.stack` |
| `glasstrace.source.line` | error spans only | top user-attributable frame of `Error.stack` |

The build hash links a runtime span to the source maps uploaded
during the same build. Set the env var in your deploy step:

```bash
# Vercel / GitHub Actions / any CI
GLASSTRACE_BUILD_HASH=$(git rev-parse HEAD) npm run start
```

The Glasstrace `next.config.ts` wrapper (`withGlasstraceConfig`) and
the `@glasstrace/sdk/node` upload helpers compute the same hash via
`computeBuildHash()` (preferring `git rev-parse HEAD`, falling back
to a deterministic content hash). When the runtime env var is unset,
the SDK silently omits the attribute — no crash, no diagnostic — so
projects that have not adopted the convention behave exactly as
before; their stored traces simply do not render mapped frames in
the dashboard.

When `GLASSTRACE_BUILD_HASH` is set but does not match the typical
git SHA shape (7-64 hexadecimal characters, covering abbreviated
SHA-1, full SHA-1, and full SHA-256), the SDK logs a one-shot warning
at startup and still ships the value — the build hash is
informational metadata, so a misconfiguration must never prevent the
SDK from starting. The warning surfaces common failure modes
(path-traversal-shaped values, wrong env-var name copied from
another tool, internal whitespace from a CI variable with a stray
newline) earlier than waiting to notice the dashboard rendering no
mapped frames. The captured value is redacted in the warning text in
case a secret was accidentally substituted.

The error-source attributes are stamped only by the manual
`captureError()` API, on the `glasstrace.error` span event. They
report the compiled-output `file:line` from the top user-attributable
frame; ingestion's resolver then maps that pair back to original
source via the uploaded source map manifest. The SDK skips frames
inside Node's built-in modules (`node:internal/*`, `node:fs`, etc.)
and inside its own `node_modules/@glasstrace/sdk/` closure, so the
reported frame is always the caller of `captureError()`. If
`Error.stack` is absent, malformed, or contains only internal frames,
the attributes are silently omitted and only the existing
`error.message` / `error.type` / `error.stack` event attributes are
recorded.

These attributes are additive: any consumer that does not understand
them ignores them. Existing trace pipelines and dashboards continue
to work unchanged.

### Path information in `glasstrace.source.file`

`glasstrace.source.file` carries the path string V8 reported for the
top user-attributable frame, exactly as the JavaScript runtime emitted
it. On a developer machine this is typically an absolute filesystem
path including your home directory and repository root; in a built or
served runtime (Vercel, AWS Lambda, a container image) it is the
deployment-controlled directory the runtime evaluated the file from;
in bundler-instrumented runtimes (Next.js webpack, Turbopack) it can be
a pseudo-path such as `webpack-internal:///(rsc)/./app/page.tsx`. The
SDK preserves whichever form V8 reported.

The same path already appears in the `error.stack` event attribute on
captured `glasstrace.error` events whose underlying value is an `Error`
instance with a `stack` property (every frame's path lands in the
serialized stack string). The `glasstrace.source.file` attribute is a
strict subset of what `error.stack` exposes for those events, so
adopting source-map enrichment introduces no incremental path
disclosure beyond what existing error traces already carry.

The SDK forwards the path verbatim — without stripping the working
directory or bundler prefix — because ingestion's source-map resolver
matches against the path the compiler emitted into the source map.
Stripping at the writer would prevent the dashboard from rendering
mapped frames.

## Browser-extension discovery

The supported discovery contract is the static file
`public/.well-known/glasstrace.json` (or
`static/.well-known/glasstrace.json` on SvelteKit). The Glasstrace
browser extension reads this file directly. `glasstrace init` writes
it for you; you do not need to add any HTTP routing for discovery. The
file contains only a schema version and the project's anonymous key —
it is public metadata, not a secret, and should be committed to source
control alongside the rest of your project.

### Migration: removing the runtime discovery handler

If you previously wired `createDiscoveryHandler` yourself (for example
on `@glasstrace/sdk@<1.0.0`), the migration below shows how to remove
it on upgrade. Users starting fresh on `@glasstrace/sdk@>=1.0.0` do
not need this section.

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

**The supported discovery contract is `public/.well-known/glasstrace.json`.**
`createDiscoveryHandler` was removed from the public API in `v1.0.0` and
is no longer exported from `@glasstrace/sdk`. The SDK retains an
internal runtime handler at `/__glasstrace/config` for backwards
compatibility with older consumer integrations during local
development. The internal handler is **not part of the supported
discovery contract** — it is not documented for use, not covered by
validation expectations, and may be removed in a future release
without a deprecation cycle. Rely on the static file.

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
