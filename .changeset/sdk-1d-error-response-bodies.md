---
"@glasstrace/sdk": patch
---

Capture HTTP error response bodies when the account opts in.

When the account-side `captureConfig.errorResponseBodies` flag is `true`
and a span carries an HTTP status in `[400..599]`, the exporter now
promotes the internal `glasstrace.internal.response_body` attribute to
the public `glasstrace.error.response_body` attribute. The flag
defaults to `false`, so capture is off unless the account has
explicitly enabled it server-side.

Before promotion, the body is sanitized to redact common secret
patterns — Bearer tokens, JWT-shaped tokens, Glasstrace API keys
(`gt_dev_*` / `gt_anon_*`), AWS access-key prefixes (`AKIA…` /
`ASIA…`), and generic `apikey`/`secret`/`password`/`token` key-value
pairs — and truncated to 4096 UTF-8 bytes with a `...[truncated]`
marker appended when truncation fires. Truncation respects codepoint
boundaries so multi-byte characters are never split mid-sequence.

The previous Phase 1 passthrough lacked the status gate, the
sanitization step, and bottomed out at a 500-character truncation; an
adapter that mistakenly populated the internal attribute on a 200
response could leak through. The status gate closes that path. No
public API symbols are added.

Closes DISC-1216.
