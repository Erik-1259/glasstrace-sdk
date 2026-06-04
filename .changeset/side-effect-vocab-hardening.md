---
"@glasstrace/sdk": minor
---

Side-effect vocabulary-governance signals

- Emit a `console.warn` the first time a `*Class` or `*Role` field value
  deviates from the lowercase-kebab convention (dedup by `(key,
  casing-pattern)` per process; warn message contains the key name only
  for PII safety). Emission still succeeds — the warn is a producer-side
  normalization signal, not enforcement.

- When the SDK is initialized with `verbose: true`, emit a one-shot
  `console.warn` when a process has emitted 50 distinct pattern-admitted
  field keys (those without an explicit attribute mapping — stable-core
  and the existing built-in keys do not count). The warn lists the
  most-recent 5 keys and recommends vocabulary review. Default behavior
  (verbose off) is unchanged.

Both signals are non-blocking and emit at most once per (key,
casing-pattern) or once per process respectively.
