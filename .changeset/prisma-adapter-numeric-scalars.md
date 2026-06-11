---
"@glasstrace/sdk": minor
---

`prismaAdapter` now captures numeric columns, not just booleans. Each allow entry takes an optional `as` intent — `"flag"` (default, boolean) or `"value"` / `"amount"` / `"ms"` / `"bytes"` / `"ratio"` (finite number) — that appends the value-fidelity scalar key suffix to the column, not doubled if the column already ends in it (e.g. `{ column: "size", as: "bytes" }` projects `sizeBytes`). Values are strict-validated by type at emit and gated by your account's capture allowlist. Numeric intents capture native JavaScript `number` columns only — a Prisma `Decimal` (a Decimal.js object) or `BigInt` is safely omitted rather than lossily converted. `as` defaults to `"flag"`, so existing configurations are unchanged.
