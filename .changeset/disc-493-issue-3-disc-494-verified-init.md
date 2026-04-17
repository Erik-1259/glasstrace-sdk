---
"@glasstrace/sdk": minor
---

Bypass Next.js 16's patched `fetch` for `/v1/sdk/init` using `node:https`
directly, and verify anon-key registration during CLI `sdk init` instead
of relying on runtime fire-and-forget. Resolves the silent init-hang
(DISC-493 Issue 3) and the silently-unlinked anon-key (DISC-494) in one
PR.

- The SDK now issues its init request via `node:https`, with a 10-second
  per-request timeout, 500 ms + 1500 ms retry backoff on transport
  failures, and a 20-second total deadline. Server HTTP 4xx/5xx
  responses are surfaced immediately and never retried.
- `glasstrace init` now blocks on a verification call before reporting
  success. On failure it exits with code `2` and an error message
  distinguishing three classes: `fetch failed`, `server rejected the
  key`, and `server returned malformed response`.
- No new runtime dependencies — `node:https` is a Node.js core module
  and adds zero bundle weight to the tsup-inlined SDK.
- Set `GLASSTRACE_SKIP_INIT_VERIFY=1` to skip verification for offline
  installs. CI mode skips verification automatically.
