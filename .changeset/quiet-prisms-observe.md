---
"@glasstrace/sdk": patch
---

Restrict Prisma value capture to documented single-record operations.
Count, aggregate, group, list, bulk, raw, and unknown operations now open no
owned value-capture span, preventing count-select results from being
misclassified as model fields. Eligible results also ignore inherited
allowlisted properties.
