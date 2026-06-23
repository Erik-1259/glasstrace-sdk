# SDK Public-Repo Overlay

Apply this overlay on top of the wave-planning core and the
high-integrity briefing overlay for all SDK wave sessions.

## Purpose

`glasstrace-sdk` is a public repo. The common `100`-review baseline is not
enough by itself for public package history, release metadata, and
package-surface guarantees.

## Additional Review Load

- The wave-planning core sets a `100`-review baseline.
- SDK wave sessions add `400` more adversarial review passes for a total
  of `500`.
- Those additional passes should focus on public API truthfulness,
  package/release correctness, and external-consumer risk.

## Public-Repo Discipline

- Treat every pushed commit and PR description as external documentation.
- Do not leave casual iteration history on the branch that reaches final
  review.
- Prefer squash-merge-ready branches and polished commit messages.
- README impact review and changeset review belong in the same change as
  the public API modification.

## SDK-Specific Review Emphasis

The additional `400` passes should stress:

- public API surface and backward compatibility
- exported symbols, package contents, and runtime truthfulness
- README accuracy and example correctness
- changeset intent, semver impact, and release notes quality
- CJS/ESM or package-resolution behavior where relevant
- build/package output, tree-shaking, and dependency hygiene

## Discovery Filing

- Important non-fix findings still belong in tracked product or SDK
  artifacts, not just PR comments.
- When SDK work needs a discovery in `glasstrace-product`, use an isolated
  worktree or equivalent isolated flow rather than writing into the main
  product working tree directly.

## Release-Mechanics Verification

Do not assert release or version semantics from memory — verify them against
the repo's own configuration before stating them in a brief, plan, or PR:

- read `.changeset/config.json` (the `updateInternalDependencies`, `linked`,
  and `fixed` settings) before claiming that one package's bump re-versions
  another;
- check each dependency's TYPE in `package.json`. A package consumed only as
  a bundled `devDependency` (the bundler inlines it via `noExternal`) ships
  nothing *additional into the bundling package's consumers* on its own release
  and triggers no internal force-patch — even though that package is itself
  published, the inlined copy reaches consumers only when the bundling package
  is republished, carrying the rebuilt output, via its own changeset;
- classify the version bump against precedent in `CHANGELOG.md`: a newly
  emitted attribute, marker, or capability is a minor, not a patch, even when
  it ships alongside a bug fix;
- enumerate the exact changeset set per package per change, and confirm any
  public-API change carries its changeset in the same PR.

## Verification Additions

Before final ready, also confirm:

- the README is current for the public API surface
- the changeset matches the intended release semantics (verified per
  "Release-Mechanics Verification" above, not assumed)
- the package/build output matches the claimed behavior
