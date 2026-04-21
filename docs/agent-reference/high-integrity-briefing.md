# High-Integrity Briefing Overlay

Apply this overlay on top of the wave-planning core when the work is
`brand-sensitive` or the brief makes high-risk factual claims.

## When To Use It

Use this overlay when the work touches:

- public website or docs copy
- dashboard flows, onboarding, auth, pricing, or settings
- domain, deployment, route, or infrastructure claims
- contracts, schemas, exports, or runtime semantics
- any brief whose correctness depends on facts that can be verified

## Recon-First Rule

Briefs are evidence documents, not opinion documents. Before drafting the
brief:

1. List the claims the brief wants to make.
2. Produce a reconnaissance artifact that proves, refutes, or leaves each
   claim uncertain.
3. Author the brief from that artifact.
4. Cite the artifact in the brief or PR so reviewers can audit the
   evidence directly.

Do not author claim-heavy briefs from memory.

## Recommended Recon Loop

1. Name the claims precisely.
2. Gather evidence with commands or file:line references.
3. Mark each claim as `proved`, `refuted`, or `uncertain`.
4. Narrow the scope of the brief to the proved claims.
5. Re-run the key checks during implementation if drift is possible.

## Common Claim Classes

For claim-heavy briefs, explicitly verify the relevant classes:

- route or file exists where the brief says it exists
- domain, URL, deployment, or environment behavior is current
- symbol or schema exists and is exported where claimed
- auth, billing, or onboarding flow behaves as described
- heading, anchor, or docs section exists where cited
- runtime semantics match the described behavior
- package or build configuration resolves the described way

## When Recon Disagrees

If the reconnaissance artifact refutes part of the proposed brief:

1. narrow the brief's scope
2. file a discovery for the architectural mismatch
3. escalate if the wave premise is wrong

Never leave a refuted claim in place with "best-effort" wording.

## Review Emphasis

High-integrity review should focus on truthfulness:

- do the claims match the actual code or deployment state?
- do docs and UX statements match current behavior?
- did the branch prove what it says, or merely assert it?

This overlay strengthens the common `100`-review baseline; it does not
replace it.
