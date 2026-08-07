---
"@glasstrace/sdk": minor
---

Add explicit, default-deny Prisma `count` / `aggregate` result capture. A
new `aggregateAllow` option on `prismaAdapter` (with its
`PrismaAggregateCaptureEntry` type) names exact aggregate selections —
model, operation, closed aggregate bucket, field or the `_all` sentinel,
and the emitted numeric scalar key — and the adapter emits each admitted
result as one complete provider-neutral evidence bundle (a family marker
plus up to 16 numeric scalars) on its owned span. Capture requires the
server-granted aggregate-scalars result-evidence capability, admits each
operation under one coherent configuration snapshot, strictly validates
values (nonnegative safe-integer counts, finite native numbers, the shared
timestamp-magnitude privacy screen), reads only explicitly named own data
properties, and never affects the query's arguments, result, or errors.
Every other operation — including `findMany` — is unaffected, and absence
of `aggregateAllow` changes nothing.
