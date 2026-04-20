# DRIFT.md — Tier-1 Surface Index

This file lists every Tier-1 contract surface shipped by
`@glasstrace/sdk` and `@glasstrace/protocol` alongside the
authoritative source of truth (a product-spec section, a component
design section, or an IETF RFC) that the surface must stay consistent
with.

It is **not** a CI gate. The Glasstrace maintenance agent re-verifies
each row on demand during quality cycles by reading the `@drift-check`
JSDoc tag on each surface's declaration site and confirming the cited
anchor still resolves. The convention itself is defined in
`../glasstrace-product/docs/component-designs/sdk-2.0.md` §8.2.

When a maintenance pass verifies a row, the `Last Verified` column is
updated with the date of the pass (UTC, `YYYY-MM-DD`). Blank entries
indicate the row has not yet been verified under the current
maintenance cycle.

| Surface | Location | Anchor | Last Verified |
|---|---|---|---|
| `deriveSessionId` | `packages/protocol/src/session.ts:48` | `../glasstrace-product/docs/product-spec.md` §4.5 Session Lifecycle | |
| `SessionIdSchema` regex | `packages/protocol/src/ids.ts:53` | `../glasstrace-product/docs/product-spec.md` §4.5 Session Lifecycle | |
| `DevApiKeySchema` regex | `packages/protocol/src/ids.ts:31` | `../glasstrace-product/docs/component-designs/sdk-2.0.md` §1.2 Lens B — SDK-Facing Security Primitives (row `Dev API key gt_dev_[a-f0-9]{48}`) | |
| `AnonApiKeySchema` regex | `packages/protocol/src/ids.ts:42` | `../glasstrace-product/docs/component-designs/sdk-2.0.md` §1.2 Lens B — SDK-Facing Security Primitives (row `Anon API key gt_anon_[a-f0-9]{48}`) | |
| `DiscoveryResponseSchema` | `packages/protocol/src/wire.ts:88` | `../glasstrace-product/docs/component-designs/sdk-discovery-endpoint.md` §5.1 Schema | |
| `GLASSTRACE_ATTRIBUTE_NAMES` | `packages/protocol/src/constants.ts:12` | OpenTelemetry Semantic Conventions (https://opentelemetry.io/docs/specs/semconv/) + `../glasstrace-product/docs/component-designs/sdk-2.0.md` §7.5 Span attributes (Tier 1) | |
| `VALID_CORE_TRANSITIONS` | `packages/sdk/src/lifecycle.ts:66` | `../glasstrace-product/docs/component-designs/sdk-lifecycle.md` §4.2 Transition Rules | |
| `VALID_AUTH_TRANSITIONS` | `packages/sdk/src/lifecycle.ts:103` | `../glasstrace-product/docs/component-designs/sdk-lifecycle.md` §5.2 Transitions | |
| `VALID_OTEL_TRANSITIONS` | `packages/sdk/src/lifecycle.ts:115` | `../glasstrace-product/docs/component-designs/sdk-lifecycle.md` §6 Layer 3: OTel Coexistence Lifecycle | |
| `MAX_PENDING_SPANS` | `packages/sdk/src/enriching-exporter.ts:25` | `../glasstrace-product/docs/component-designs/sdk-2.0.md` §5.4 Buffering during KEY_PENDING | |
| `HEARTBEAT_SHUTDOWN_PRIORITY` | `packages/sdk/src/heartbeat.ts:23` | `../glasstrace-product/docs/component-designs/sdk-lifecycle.md` §8.3 Shutdown Sequence | |
| `WELL_KNOWN_GLASSTRACE_PATH` | `packages/sdk/src/cli/discovery-file.ts:18` | RFC 8615 (https://www.rfc-editor.org/rfc/rfc8615) + `../glasstrace-product/docs/component-designs/sdk-2.0.md` §7.1 Static discovery file | |

## Adding a new row

When a new Tier-1 surface ships:

1. Add a row to the table above with the declaration's file and line.
2. Add a `@drift-check <anchor>` JSDoc block tag on the declaration
   site. The anchor string must match the `Anchor` column exactly so
   a maintenance agent can cross-reference both locations by text
   search.
3. Leave `Last Verified` blank until the next maintenance pass fills
   it in.

Two Tier-1 surfaces named in sdk-2.0.md §8.2 are **deferred** and not
yet in the table:

- **CLI exit codes** — waiting on `EXIT_CODES` being extracted into
  `@glasstrace/protocol` (sdk-2.0.md §8.1 row 7).
- **`SHUTDOWN_PRIORITY` table** — waiting on LIFE-3 (sdk-2.0.md §10.1),
  which consolidates the four shipped priority constants into a
  single `SHUTDOWN_PRIORITY as const` table. The currently shipped
  `HEARTBEAT_SHUTDOWN_PRIORITY` row above will be superseded by that
  table when LIFE-3 lands.
