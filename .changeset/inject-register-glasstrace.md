---
"@glasstrace/sdk": minor
---

Init now injects registerGlasstrace() into existing instrumentation.ts files instead of skipping them. Projects with pre-existing Prisma, Sentry, or other instrumentation no longer need to manually add the Glasstrace registration call.
