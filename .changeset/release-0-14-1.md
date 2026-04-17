---
"@glasstrace/protocol": patch
"@glasstrace/sdk": patch
---

Re-release 0.14.0 content as 0.14.1 on the `latest` dist-tag.

Version 0.14.0 was built correctly from `main` but published under the
`canary` dist-tag due to a workflow misuse (a canary dispatch ran after
the version PR had already consumed the changesets, causing the empty
snapshot to publish the current stable semver as a canary). The canary
publish path in `release.yml` now fails fast when no changesets are
present, preventing this class of mis-tag going forward.
