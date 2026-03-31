# @glasstrace/protocol

Shared types and wire format schemas for the Glasstrace SDK.

This package defines the Zod schemas that form the public contract between
the Glasstrace SDK and the Glasstrace backend. Both the SDK (public) and
the backend (private) depend on this package.

> **Status: Pre-release** -- not yet published to npm.

## What's Inside

- **Branded ID types** -- `DevApiKey`, `AnonApiKey`, `SessionId`, `BuildHash`
- **Configuration schemas** -- `CaptureConfig`, `GlasstraceOptions`
- **Wire format schemas** -- `SdkInitResponse`, `DiscoveryResponse`, `SourceMapUploadResponse`
- **Constants** -- semantic attribute names, default capture config

## License

[MIT](./LICENSE)
