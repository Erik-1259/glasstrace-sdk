---
"@glasstrace/sdk": patch
---

Stack-frame parser now accepts Next.js webpack-internal paths with parenthesized App Router markers (`(rsc)/`, `(middleware)/`, `(api)/`, `(client)/`, `(server)/`, `(action)/`, `(app)/`, `(pages)/`). Previously these frames were silently rejected because the file-capture regex excluded `(`, leaving `glasstrace.source.{file,line}` attributes missing for the primary Next.js App Router segment in dev mode and self-hosted production builds. The eval-frame guard is preserved via a precise negative lookahead that targets only V8's nested `eval (eval at ...)` shape.
