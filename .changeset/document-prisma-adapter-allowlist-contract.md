---
"@glasstrace/sdk": patch
---

docs: document the prismaAdapter passive value-capture extension and the producer/operator allowlist contract

Adds a README section for `prismaAdapter({ allow })` — the passive Prisma client
extension that projects allowlisted result columns onto the value-fidelity
scalar channel. Covers the `as`-intent suffixes, the `as: "id"` pseudonymized
`gthid_` behavior (full fidelity + provisioned key), the two-allowlist
(producer `allow` + operator server allowlist) contract keyed on the emitted
scalar key, the no-doubling suffix derivation, the result-shape requirement, and
the fail-closed behavior for each misconfiguration.
