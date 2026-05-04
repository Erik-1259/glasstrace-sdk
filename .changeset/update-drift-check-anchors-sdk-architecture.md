---
"@glasstrace/protocol": patch
"@glasstrace/sdk": patch
---

chore: update internal `@drift-check` anchors to reference the renamed component design `sdk-architecture.md` (was `sdk-2.0.md`).

The companion glasstrace-product change renamed `docs/component-designs/sdk-2.0.md` to `docs/component-designs/sdk-architecture.md` so the filename no longer pins to a specific milestone. The rename ships the doc as a milestone-neutral architecture reference covering both the published SDK 1.x line and the next-major target.

This patch propagates the rename into SDK-side citations so the published `dist/*.d.ts` JSDoc tooltips that consumers see in their IDE (e.g., on `DevApiKeySchema`, `AnonApiKeySchema`, `GLASSTRACE_ATTRIBUTE_NAMES`, `MAX_PENDING_SPANS`, `WELL_KNOWN_GLASSTRACE_PATH`) point at the live filename. `DRIFT.md` is updated in the same change.

No runtime behavior change. No public API change. Pure JSDoc / documentation-string update.
