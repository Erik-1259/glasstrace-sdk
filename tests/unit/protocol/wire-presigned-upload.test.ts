import { describe, it, expect } from "vitest";
import {
  PresignedUploadRequestSchema,
  PresignedUploadResponseSchema,
  SourceMapManifestRequestSchema,
  SourceMapManifestResponseSchema,
} from "../../../packages/protocol/src/index.js";

const validBuildHash = "abc123";

describe("PresignedUploadRequestSchema", () => {
  it("parses a valid request with 1 file", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [{ filePath: "dist/main.js.map", sizeBytes: 1024 }],
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid request with multiple files", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      filePath: `dist/chunk-${i}.js.map`,
      sizeBytes: 512 * (i + 1),
    }));
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files).toHaveLength(5);
    }
  });

  it("rejects empty files array", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects files array exceeding 100 items", () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      filePath: `dist/chunk-${i}.js.map`,
      sizeBytes: 1024,
    }));
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files,
    });
    expect(result.success).toBe(false);
  });

  it("rejects file with empty filePath", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [{ filePath: "", sizeBytes: 1024 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects file with negative sizeBytes", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [{ filePath: "dist/main.js.map", sizeBytes: -100 }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PresignedUploadResponseSchema", () => {
  const validResponse = {
    uploadId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    expiresAt: 1_775_001_600_000,
    files: [
      {
        filePath: "dist/main.js.map",
        clientToken: "tok_abc123",
        pathname: "/uploads/abc123/main.js.map",
        maxBytes: 5_242_880,
      },
    ],
  };

  it("parses a valid response with tokens", () => {
    const result = PresignedUploadResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadId).toBe(validResponse.uploadId);
      expect(result.data.files[0].clientToken).toBe("tok_abc123");
    }
  });

  it("rejects invalid uploadId (not UUID)", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      uploadId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing clientToken", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          filePath: "dist/main.js.map",
          pathname: "/uploads/abc123/main.js.map",
          maxBytes: 5_242_880,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty clientToken", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          filePath: "dist/main.js.map",
          clientToken: "",
          pathname: "/uploads/abc123/main.js.map",
          maxBytes: 5_242_880,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("SourceMapManifestRequestSchema", () => {
  const validRequest = {
    uploadId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    buildHash: validBuildHash,
    files: [
      {
        filePath: "dist/main.js.map",
        sizeBytes: 1024,
        blobUrl: "https://storage.example.com/uploads/abc123/main.js.map",
      },
    ],
  };

  it("parses a valid request with blobUrls", () => {
    const result = SourceMapManifestRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files[0].blobUrl).toContain("storage.example.com");
    }
  });

  it("rejects invalid blobUrl (not URL)", () => {
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files: [
        {
          filePath: "dist/main.js.map",
          sizeBytes: 1024,
          blobUrl: "not-a-url",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid uploadId", () => {
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      uploadId: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("SourceMapManifestResponseSchema", () => {
  const validResponse = {
    success: true as const,
    buildHash: validBuildHash,
    fileCount: 3,
    totalSizeBytes: 15_360,
    activatedAt: 1_775_001_600_000,
  };

  it("parses a valid response", () => {
    const result = SourceMapManifestResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileCount).toBe(3);
      expect(result.data.activatedAt).toBe(1_775_001_600_000);
    }
  });

  it("rejects success: false", () => {
    const result = SourceMapManifestResponseSchema.safeParse({
      ...validResponse,
      success: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative fileCount", () => {
    const result = SourceMapManifestResponseSchema.safeParse({
      ...validResponse,
      fileCount: -1,
    });
    expect(result.success).toBe(false);
  });
});
