---
"@glasstrace/sdk": patch
---

Share the resolved capture-config across bundled module instances

Under Turbopack `next dev` (HMR rebuilds) and the edge-vs-node bundle
split, the bundler can evaluate more than one copy of the SDK's config
module in a single process. The resolved active capture-config was held in
plain module-level state, so the copy that the background init applied (the
served config, e.g. side-effect evidence enabled) was not necessarily the
copy the in-request emitter read at the call site. The reader fell through
to the fail-closed default and silently captured nothing despite the
backend serving capture as enabled.

The resolved config and its once-per-process disk-cache-checked flag now
live in a `globalThis` singleton keyed on a process-global symbol, so every
bundle instance reads and writes the same record. The per-account HMAC
secret is split off into module-local state and is never placed on that
shared record, so it stays off the well-known global slot and keeps the
same confinement it had before; the public getter still returns the config
with the secret redacted. A non-secret pairing token on the shared record
ties each instance's local key to the config it came from, so if a later
apply (key rotation, a different tenant, any subsequent init) supersedes
it, the now-stale key is no longer returned and full-fidelity id
pseudonymization fail-closes instead of hashing with the wrong key. A
reader instance that sees a `full`, key-provisioned posture but has no
local key behaves like strict (skips identifier projection) rather than
emitting a spurious unhashed-id omission; a genuinely key-less `full`
account still records that omission so the misconfiguration stays
observable. The read-fresh-each-call rotation semantics and the existing
setter are unchanged; the only behavioral difference is that an applied
capture config is now visible across bundle copies. The store touches no
Node built-in and never reaches the `process` global, so it stays inside
the edge-safe runtime contract.
