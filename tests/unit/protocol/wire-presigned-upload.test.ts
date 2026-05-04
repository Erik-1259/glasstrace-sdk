import { describe, it, expect } from "vitest";
import {
  MAX_SOURCE_MAP_FILE_COUNT,
  MAX_SOURCE_MAP_FILE_PATH_LENGTH,
  MAX_SOURCE_MAP_FILE_SIZE,
  PresignedUploadRequestSchema,
  PresignedUploadResponseSchema,
  SourceMapManifestRequestSchema,
  SourceMapManifestResponseSchema,
} from "../../../packages/protocol/src/index.js";

const validBuildHash = "abc123";

/** Build a `filePath` string of exactly `length` characters. */
function filePathOfLength(length: number): string {
  // The leading "dist/" prefix is realistic; pad with "a" to reach `length`.
  if (length <= 0) return "";
  const prefix = "dist/";
  if (length <= prefix.length) return prefix.slice(0, length);
  return prefix + "a".repeat(length - prefix.length);
}

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

  // --- DISC-1562: backend canonical max() bounds ---

  it("accepts filePath at the maximum allowed length (boundary)", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [
        {
          filePath: filePathOfLength(MAX_SOURCE_MAP_FILE_PATH_LENGTH),
          sizeBytes: 1024,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects filePath one character above the maximum with an informative message", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [
        {
          filePath: filePathOfLength(MAX_SOURCE_MAP_FILE_PATH_LENGTH + 1),
          sizeBytes: 1024,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `filePath length exceeds maximum of ${MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters`,
      );
    }
  });

  it("accepts sizeBytes at the maximum allowed file size (boundary)", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [
        { filePath: "dist/main.js.map", sizeBytes: MAX_SOURCE_MAP_FILE_SIZE },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects sizeBytes one byte above the maximum file size with an informative message", () => {
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files: [
        {
          filePath: "dist/main.js.map",
          sizeBytes: MAX_SOURCE_MAP_FILE_SIZE + 1,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `sizeBytes exceeds maximum of ${MAX_SOURCE_MAP_FILE_SIZE} bytes (${MAX_SOURCE_MAP_FILE_SIZE / (1024 * 1024)} MiB)`,
      );
    }
  });

  it("accepts a files array of exactly the maximum count (boundary)", () => {
    const files = Array.from({ length: MAX_SOURCE_MAP_FILE_COUNT }, (_, i) => ({
      filePath: `dist/chunk-${i}.js.map`,
      sizeBytes: 1024,
    }));
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a files array exceeding the maximum count with an informative message", () => {
    const files = Array.from(
      { length: MAX_SOURCE_MAP_FILE_COUNT + 1 },
      (_, i) => ({
        filePath: `dist/chunk-${i}.js.map`,
        sizeBytes: 1024,
      }),
    );
    const result = PresignedUploadRequestSchema.safeParse({
      buildHash: validBuildHash,
      files,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `files array exceeds maximum of ${MAX_SOURCE_MAP_FILE_COUNT} entries`,
      );
    }
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
        access: "public" as const,
      },
    ],
  };

  it("parses a valid response with tokens", () => {
    const result = PresignedUploadResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadId).toBe(validResponse.uploadId);
      expect(result.data.files[0].clientToken).toBe("tok_abc123");
      expect(result.data.files[0].access).toBe("public");
    }
  });

  it("accepts expiresAt: 0 (TimestampSchema is nonnegative, not strictly positive)", () => {
    // DISC-1544: align with backend `TimestampSchema` (`int().nonnegative()`).
    // The pre-fix schema used `positive()` which rejected `0`; backend has always
    // emitted `nonnegative` timestamps.
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      expiresAt: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects expiresAt: -1 (must be nonnegative)", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      expiresAt: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects per-file entry missing the `access` field", () => {
    // DISC-1544: backend has required `access: "public"` per DISC-756; the SDK
    // protocol now matches the canonical wire shape.
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          filePath: "dist/main.js.map",
          clientToken: "tok_abc123",
          pathname: "/uploads/abc123/main.js.map",
          maxBytes: 5_242_880,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects per-file `access` value other than \"public\"", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          filePath: "dist/main.js.map",
          clientToken: "tok_abc123",
          pathname: "/uploads/abc123/main.js.map",
          maxBytes: 5_242_880,
          access: "private",
        },
      ],
    });
    expect(result.success).toBe(false);
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
          access: "public",
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
          access: "public",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // --- DISC-1562: backend canonical max() bounds ---

  it("accepts filePath at the maximum allowed length (boundary)", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          filePath: filePathOfLength(MAX_SOURCE_MAP_FILE_PATH_LENGTH),
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects filePath one character above the maximum with an informative message", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          filePath: filePathOfLength(MAX_SOURCE_MAP_FILE_PATH_LENGTH + 1),
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `filePath length exceeds maximum of ${MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters`,
      );
    }
  });

  it("accepts clientToken at the maximum allowed length (boundary)", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          clientToken: "a".repeat(2048),
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects clientToken one character above the maximum with an informative message", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          clientToken: "a".repeat(2049),
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        "clientToken length exceeds maximum of 2048 characters",
      );
    }
  });

  it("accepts pathname at the maximum allowed length (boundary)", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          pathname: "/" + "a".repeat(1023),
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects pathname one character above the maximum with an informative message", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          pathname: "/" + "a".repeat(1024),
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        "pathname length exceeds maximum of 1024 characters",
      );
    }
  });

  it("accepts maxBytes at the maximum allowed file size (boundary)", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          maxBytes: MAX_SOURCE_MAP_FILE_SIZE,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects maxBytes one byte above the maximum file size with an informative message", () => {
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files: [
        {
          ...validResponse.files[0],
          maxBytes: MAX_SOURCE_MAP_FILE_SIZE + 1,
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `maxBytes exceeds maximum of ${MAX_SOURCE_MAP_FILE_SIZE} bytes (${MAX_SOURCE_MAP_FILE_SIZE / (1024 * 1024)} MiB)`,
      );
    }
  });

  it("accepts a files array of exactly the maximum count (boundary)", () => {
    const files = Array.from({ length: MAX_SOURCE_MAP_FILE_COUNT }, (_, i) => ({
      filePath: `dist/chunk-${i}.js.map`,
      clientToken: `tok_${i}`,
      pathname: `/uploads/abc123/chunk-${i}.js.map`,
      maxBytes: 5_242_880,
      access: "public" as const,
    }));
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a files array exceeding the maximum count with an informative message", () => {
    const files = Array.from(
      { length: MAX_SOURCE_MAP_FILE_COUNT + 1 },
      (_, i) => ({
        filePath: `dist/chunk-${i}.js.map`,
        clientToken: `tok_${i}`,
        pathname: `/uploads/abc123/chunk-${i}.js.map`,
        maxBytes: 5_242_880,
        access: "public" as const,
      }),
    );
    const result = PresignedUploadResponseSchema.safeParse({
      ...validResponse,
      files,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `files array exceeds maximum of ${MAX_SOURCE_MAP_FILE_COUNT} entries`,
      );
    }
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

  // --- DISC-1562: backend canonical max() bounds ---

  it("accepts filePath at the maximum allowed length (boundary)", () => {
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files: [
        {
          ...validRequest.files[0],
          filePath: filePathOfLength(MAX_SOURCE_MAP_FILE_PATH_LENGTH),
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects filePath one character above the maximum with an informative message", () => {
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files: [
        {
          ...validRequest.files[0],
          filePath: filePathOfLength(MAX_SOURCE_MAP_FILE_PATH_LENGTH + 1),
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `filePath length exceeds maximum of ${MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters`,
      );
    }
  });

  it("accepts sizeBytes at the maximum allowed file size (boundary)", () => {
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files: [
        { ...validRequest.files[0], sizeBytes: MAX_SOURCE_MAP_FILE_SIZE },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects sizeBytes one byte above the maximum file size with an informative message", () => {
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files: [
        { ...validRequest.files[0], sizeBytes: MAX_SOURCE_MAP_FILE_SIZE + 1 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `sizeBytes exceeds maximum of ${MAX_SOURCE_MAP_FILE_SIZE} bytes (${MAX_SOURCE_MAP_FILE_SIZE / (1024 * 1024)} MiB)`,
      );
    }
  });

  it("accepts a files array of exactly the maximum count (boundary)", () => {
    const files = Array.from({ length: MAX_SOURCE_MAP_FILE_COUNT }, (_, i) => ({
      filePath: `dist/chunk-${i}.js.map`,
      sizeBytes: 1024,
      blobUrl: `https://storage.example.com/uploads/abc123/chunk-${i}.js.map`,
    }));
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a files array exceeding the maximum count with an informative message", () => {
    const files = Array.from(
      { length: MAX_SOURCE_MAP_FILE_COUNT + 1 },
      (_, i) => ({
        filePath: `dist/chunk-${i}.js.map`,
        sizeBytes: 1024,
        blobUrl: `https://storage.example.com/uploads/abc123/chunk-${i}.js.map`,
      }),
    );
    const result = SourceMapManifestRequestSchema.safeParse({
      ...validRequest,
      files,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain(
        `files array exceeds maximum of ${MAX_SOURCE_MAP_FILE_COUNT} entries`,
      );
    }
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
