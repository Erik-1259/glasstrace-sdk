---
"@glasstrace/sdk": patch
---

Bundle @glasstrace/protocol and zod into the SDK so the package has zero mandatory dependencies. Consumers only need `npm install @glasstrace/sdk` plus their chosen OTel packages (all optional peer dependencies). Works with npm, pnpm, yarn, and Bun out of the box.
