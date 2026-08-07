---
"@glasstrace/sdk": minor
---

Add default-deny bounded-row result capture for Prisma `findMany`. When
the server grants the bounded-rows result-evidence capability, results
for models named by the existing `allow` list are captured as one
complete provider-neutral evidence bundle: at most 8 returned rows
sampled by original array position, row-qualified scalars under the
shared 16-scalar operation ceiling with a fixed internal attempt budget,
and truthful cardinality metadata (the real returned-array length, the
fixed row cap, rows selected, and rows that contributed a value). Each
operation admits under one coherent configuration snapshot; only own data
properties of each row are read, with candidate values snapshotted before
any asynchronous work; values follow the established per-intent rules
including the timestamp privacy screen and pseudonymized identifier
capture; and the family marker is written last so a truncated bundle
fails closed at the receiver. Empty results, unsupported shapes, unsafe
policies, group, bulk, raw, and unknown operations emit nothing, and the
query's arguments, result, and errors are never affected.
