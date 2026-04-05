---
"@glasstrace/protocol": minor
"@glasstrace/sdk": minor
---

Add opt-in console error capture and manual captureError API:

- New `consoleErrors` field in CaptureConfig (default: false). When enabled, console.error and console.warn calls are recorded as span events on the active OTel span.
- New `captureError(error)` function for manual error reporting, works regardless of consoleErrors config.
- SDK's own log messages (prefixed with "[glasstrace]") are never captured.
