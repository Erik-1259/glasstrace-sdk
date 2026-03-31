# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Glasstrace SDK,
please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email: security@glasstrace.dev

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide a
timeline for a fix.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.x     | Current pre-release |

Once v1.0 ships, the latest minor release will receive security
patches. Older minor releases will be supported for 90 days after
the next minor release.

## Security Practices

- npm publishes will use trusted provenance via GitHub Actions OIDC
- Dependencies are audited via `npm audit` in CI
- No secrets or credentials are bundled in published packages
- Scoped packages are published under the `@glasstrace` npm organization
