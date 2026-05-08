import { describe, it, expect } from "vitest";
import {
  ERROR_STACK_MAX_BYTES,
  ERROR_STACK_TRUNCATION_MARKER,
  prepareStack,
  sanitizeStack,
  truncateStack,
} from "../../../packages/sdk/src/error-stack.js";

describe("sanitizeStack", () => {
  describe("absolute path normalization", () => {
    it("strips POSIX abs prefix and keeps from `node_modules/` onward", () => {
      const stack = `Error: something
    at fn (/Users/erik/proj/node_modules/zod/lib/index.js:42:5)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).toContain("<path>/node_modules/zod/lib/index.js:42:5");
      expect(out.stack).not.toContain("/Users/erik/proj/");
    });

    it("strips POSIX abs prefix and keeps from `src/` onward", () => {
      const stack = `Error: something
    at handler (/Users/erik/proj/src/api/storage/[...key].ts:18:11)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).toContain("<path>/src/api/storage/[...key].ts:18:11");
      expect(out.stack).not.toContain("/Users/erik");
    });

    it("strips file:// scheme then normalizes the underlying abs path", () => {
      const stack = `Error: something
    at fn (file:///Users/erik/proj/src/file.ts:10:5)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).toContain("<path>/src/file.ts:10:5");
      expect(out.stack).not.toContain("file://");
      expect(out.stack).not.toContain("/Users/erik");
    });

    it("falls back to basename when no recognizable marker is present", () => {
      const stack = `Error
    at fn (/var/private/randompath/secret/data.js:1:1)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).toContain("<path>/data.js:1:1");
      expect(out.stack).not.toContain("/var/private/randompath/secret");
    });

    it("preserves frames that already use webpack-internal:// scheme", () => {
      const stack = `Error
    at fn (webpack-internal:///./src/api/handler.ts:25:7)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(false);
      expect(out.stack).toContain("webpack-internal:///./src/api/handler.ts:25:7");
    });

    it("preserves frames that use the node: scheme", () => {
      const stack = `Error
    at fn (node:internal/process/main_thread_only:75:7)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(false);
      expect(out.stack).toContain("node:internal/process/main_thread_only:75:7");
    });

    it("anchors to the rightmost marker so deep node_modules paths keep both segments", () => {
      const stack = `Error
    at f (/Users/erik/proj/node_modules/.pnpm/@trpc+server@11.0.0/node_modules/@trpc/server/dist/index.js:100:1)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      // The rightmost `/node_modules/` is the inner one — that's where the
      // actual frame lives. Outer pnpm path is dropped.
      expect(out.stack).toContain("<path>/node_modules/@trpc/server/dist/index.js:100:1");
    });

    it("does not modify already-relative paths", () => {
      const stack = `Error
    at fn (./src/file.ts:10:5)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(false);
      expect(out.stack).toContain("./src/file.ts:10:5");
    });
  });

  describe("URL query/fragment stripping", () => {
    it("strips `?…` from URLs in stack frames", () => {
      const stack = `failed fetch https://api.example.com/users?token=secret123 timed out`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).toContain("https://api.example.com/users");
      expect(out.stack).not.toContain("?token=secret123");
    });

    it("strips `#…` fragments", () => {
      const stack = `redirect https://app.example.com/dashboard#section-anchor`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).toContain("https://app.example.com/dashboard");
      expect(out.stack).not.toContain("#section-anchor");
    });
  });

  describe("credential redaction (delegated to error-response-body's redactor)", () => {
    it("redacts a Bearer token echoed in a stack frame", () => {
      const stack = `Error: 401
    Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature
    at fetchUser (./src/api.ts:5:1)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(out.stack).toContain("[REDACTED]");
    });

    it("redacts a Glasstrace dev key prefix", () => {
      const stack = `Error: invalid api_key=gt_dev_${"a".repeat(48)} rejected`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(true);
      expect(out.stack).not.toMatch(/gt_dev_[A-Za-z0-9]{16,}/);
      expect(out.stack).toContain("[REDACTED]");
    });

    it("does not flag false positives on plain dependency paths", () => {
      // `react.dom.server` looks JWT-shaped only if you squint; the
      // 16-char floor on each segment keeps it safe.
      const stack = `Error
    at render (./node_modules/react-dom/server.js:1:1)`;
      const out = sanitizeStack(stack);
      // Path normalization may or may not redact — the credential
      // redactor specifically must NOT fire on this benign content.
      expect(out.stack).not.toContain("[REDACTED]");
    });
  });

  describe("change reporting", () => {
    it("returns redacted: false when no rule fires", () => {
      const stack = `Error: plain
    at fn (./src/file.ts:1:1)`;
      const out = sanitizeStack(stack);
      expect(out.redacted).toBe(false);
      expect(out.stack).toBe(stack);
    });
  });
});

describe("truncateStack", () => {
  it("returns the input unchanged when within budget", () => {
    const stack = "Error: short\n    at fn (./a.ts:1:1)";
    const out = truncateStack(stack);
    expect(out.truncated).toBe(false);
    expect(out.stack).toBe(stack);
  });

  it("truncates oversized input and appends the marker", () => {
    const longFrame = "    at very_long_function_name (./src/a.ts:1:1)\n";
    const stack = "Error\n" + longFrame.repeat(500);
    const out = truncateStack(stack);
    expect(out.truncated).toBe(true);
    expect(out.stack.endsWith(ERROR_STACK_TRUNCATION_MARKER)).toBe(true);
    // Encoded byte length of the prefix (excluding marker) should be
    // at most the budget.
    const prefix = out.stack.slice(0, -ERROR_STACK_TRUNCATION_MARKER.length);
    const bytes = new TextEncoder().encode(prefix).byteLength;
    expect(bytes).toBeLessThanOrEqual(ERROR_STACK_MAX_BYTES);
  });

  it("never decodes a partial UTF-8 codepoint at the truncation boundary", () => {
    // Build a stack that, if naively sliced at MAX_BYTES, would split
    // a 4-byte codepoint (e.g., U+1F600 emoji is 4 bytes UTF-8). Pad
    // up to the exact budget then add an emoji that crosses the line.
    const padBytes = ERROR_STACK_MAX_BYTES - 3; // 3 bytes shy of budget
    const padding = "x".repeat(padBytes);
    const stack = padding + "😀extra"; // emoji starts at byte (budget - 3)
    const out = truncateStack(stack);
    expect(out.truncated).toBe(true);
    // Decoded prefix must end on a clean codepoint boundary — no
    // trailing U+FFFD substituted from a torn 4-byte sequence.
    const prefix = out.stack.slice(0, -ERROR_STACK_TRUNCATION_MARKER.length);
    expect(prefix.endsWith("�")).toBe(false);
    // Either the emoji is fully present at the end, or it was
    // dropped entirely; never half-rendered.
    if (prefix.endsWith("😀")) {
      // Codepoint fits cleanly.
    } else {
      expect(prefix.endsWith("x")).toBe(true);
    }
  });
});

describe("prepareStack", () => {
  it("returns null for empty input", () => {
    expect(prepareStack("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(prepareStack("   \n\t  ")).toBeNull();
  });

  it("end-to-end: sanitize then truncate; surfaces both flags", () => {
    const longSecretStack =
      "Error\n" +
      "    Authorization: Bearer secrettoken12345\n" +
      "    at f (/Users/x/y/src/file.ts:1:1)\n" +
      "    at g (./src/file.ts:2:2)\n".repeat(500);
    const out = prepareStack(longSecretStack)!;
    expect(out).not.toBeNull();
    expect(out.redacted).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.stack).not.toContain("secrettoken12345");
    expect(out.stack).not.toContain("/Users/x/y/");
    expect(out.stack.endsWith(ERROR_STACK_TRUNCATION_MARKER)).toBe(true);
  });

  it("end-to-end: short clean stack returns truncated=false, redacted=false", () => {
    const stack = "Error: plain\n    at fn (./src/file.ts:1:1)";
    const out = prepareStack(stack)!;
    expect(out).not.toBeNull();
    expect(out.redacted).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out.stack).toBe(stack);
  });
});
