---
"@glasstrace/protocol": minor
"@glasstrace/sdk": minor
---

Capture allowlisted identifier columns as pseudonymized tokens

The Prisma adapter gains an `as: "id"` intent that projects an identifier
column onto an `*Id` value-fidelity scalar as a stable, opaque `gthid_<hex>`
token — the raw id is hashed under a per-account key (delivered via the new
optional `attrHmacKey` capture-config field) and never reaches the wire.
Identifier capture is operator-gated: it activates only under full-fidelity
capture with a provisioned key. A full account missing the key records a
count-only `unhashed_id` omission so the misconfiguration stays visible. The
token is computed with Web Crypto (`globalThis.crypto.subtle`) rather than
`node:crypto`, so the identifier path adds no new Node-builtin dependency to
the root barrel.
