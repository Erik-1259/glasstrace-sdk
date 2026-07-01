---
"@glasstrace/sdk": minor
---

Relabel SDK-emitted scalar budget overflow omissions as
`scalar_cap_exceeded` instead of `value_too_long`, matching the public protocol
reason and backend read path for dropped scalar values.
