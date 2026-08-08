---
"@glasstrace/sdk": patch
---

Harden the middleware and async-context wrappers. A per-call watchdog now
force-ends a wrapped call's span after 10 minutes when a returned thenable
or awaited promise never settles, so such calls can no longer leak spans —
the watchdog ends only the telemetry span, never affects the user's work,
holds no event-loop reference in Node (`unref` is feature-detected), and
is idempotent with the normal settle path. String attribute values (including string elements of array-valued
attributes) are now stripped of ASCII control characters below 0x20 at the
wrappers' attribute-write boundary — transport hygiene, not privacy
redaction, as the updated documentation states. The internal lifecycle
bridge slot is now namespaced by bridge-contract version so a pre-existing
release and a release on a different bridge contract can no longer route
events through each other's lifecycle module, and the bridge callback now
verifies event names at runtime instead of casting.
