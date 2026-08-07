---
"@glasstrace/sdk": patch
---

Consume the server-derived result-evidence capability envelope through the
existing configuration lifecycle, failing closed at the application
boundary. A server or cached configuration whose only defect is a
malformed, partial, unknown-member, or future-version
`resultEvidenceCapabilities` envelope now applies with both result-evidence
capabilities unavailable, instead of discarding the whole otherwise-valid
configuration and falling back to defaults. The strict direct-call
contracts of `sendInitRequest()` and `loadCachedConfig()` are unchanged, as
are cache normalization, key secrecy, and all adapter capture behavior — no
adapter emits result evidence.
