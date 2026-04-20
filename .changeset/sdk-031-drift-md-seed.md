---
"@glasstrace/sdk": patch
---

Add internal `WELL_KNOWN_GLASSTRACE_PATH` constant in
`packages/sdk/src/cli/discovery-file.ts`.

The new constant is the RFC 8615 static discovery-file path
(`.well-known/glasstrace.json`) served by `sdk init` under the
framework-specific static root. It replaces two duplicated string
literals in `relativeDiscoveryPath` and carries a `@drift-check`
JSDoc anchor so a future maintenance pass can verify the path
against the design doc and the RFC.

The change is additive and internal. `cli/discovery-file` is not
in this package's `exports` map, so the constant is not reachable
by external consumers and no published behavior changes. The
changeset exists to trigger the linked-changeset co-bump and to
document the extraction in the changelog.

See `DRIFT.md` and `../glasstrace-product/docs/component-designs/sdk-2.0.md`
§7.1 (Static discovery file).

**Changeset linkage note.** `.changeset/config.json` declares
`linked: [["@glasstrace/protocol", "@glasstrace/sdk"]]`, so this patch
bump on `@glasstrace/sdk` will co-bump `@glasstrace/protocol` to the
same patch level even though no protocol API changed in this
changeset. That is expected behavior for linked packages.
