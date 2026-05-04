---
"@glasstrace/protocol": patch
---

Tighten `PresignedUploadResponseSchema`, `PresignedUploadRequestSchema`, and
`SourceMapManifestRequestSchema` to mirror the backend canonical `.max()`
bounds (DISC-1562):

- `filePath` ≤ 512 characters (`MAX_SOURCE_MAP_FILE_PATH_LENGTH`)
- `clientToken` ≤ 2048 characters
- `pathname` ≤ 1024 characters
- `maxBytes` / `sizeBytes` ≤ 50 MiB (`MAX_SOURCE_MAP_FILE_SIZE`)
- `files` array ≤ 100 entries (`MAX_SOURCE_MAP_FILE_COUNT`, replacing the
  previously hard-coded literal so the cap is self-documenting)

Also exports the three `MAX_SOURCE_MAP_*` constants from the package
barrel so SDK code and external tooling can reference the same numeric
ceilings the backend applies at write time.

Each `.max()` carries an informative custom error message
(e.g. `"filePath length exceeds maximum of 512 characters"`) so
validation failures surface the offending field and limit instead of
Zod's default `"string too long"`.

Non-breaking patch: the backend canonical schema has enforced these
bounds at the producer site since the upload pipeline shipped, so no
historical response payload exceeds them. Third-party tooling that
validates against the SDK schema now observes the same acceptance
envelope the backend enforces, closing the residual contract drift
DISC-1544 left open.
