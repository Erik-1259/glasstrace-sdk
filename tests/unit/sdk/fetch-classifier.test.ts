import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyFetchTarget, _resetEnvCacheForTesting } from "../../../packages/sdk/src/fetch-classifier.js";

describe("classifyFetchTarget", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.PORT;
    delete process.env.GLASSTRACE_ENV;
    _resetEnvCacheForTesting();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetEnvCacheForTesting();
  });

  it("classifies supabase.co URLs as supabase", () => {
    expect(classifyFetchTarget("https://myproject.supabase.co/rest/v1/users")).toBe("supabase");
  });

  it("classifies supabase.in URLs as supabase", () => {
    expect(classifyFetchTarget("https://myproject.supabase.in/rest/v1/users")).toBe("supabase");
  });

  it("classifies stripe.com URLs as stripe", () => {
    expect(classifyFetchTarget("https://api.stripe.com/v1/charges")).toBe("stripe");
  });

  it("classifies same-origin URLs as internal", () => {
    expect(classifyFetchTarget("http://localhost:3000/api/data")).toBe("internal");
  });

  it("classifies unknown URLs as unknown", () => {
    expect(classifyFetchTarget("https://api.example.com/data")).toBe("unknown");
  });

  it("classification is case-insensitive for supabase", () => {
    expect(classifyFetchTarget("https://project.SUPABASE.CO/rest")).toBe("supabase");
  });

  it("classification is case-insensitive for stripe", () => {
    expect(classifyFetchTarget("https://api.STRIPE.COM/v1/charges")).toBe("stripe");
  });

  it("classification is case-insensitive for internal", () => {
    expect(classifyFetchTarget("http://LOCALHOST:3000/api/data")).toBe("internal");
  });

  it("error case: malformed URL returns unknown", () => {
    expect(classifyFetchTarget("not-a-url")).toBe("unknown");
  });

  it("error case: empty string returns unknown", () => {
    expect(classifyFetchTarget("")).toBe("unknown");
  });

  it("internal detection uses PORT from env", () => {
    process.env.PORT = "8080";
    _resetEnvCacheForTesting();
    expect(classifyFetchTarget("http://localhost:8080/api/data")).toBe("internal");
  });

  it("URL with supabase in path but not host is unknown", () => {
    expect(classifyFetchTarget("https://example.com/supabase.co/rest")).toBe("unknown");
  });

  it("URL with stripe in path but not host is unknown", () => {
    expect(classifyFetchTarget("https://example.com/stripe.com/v1")).toBe("unknown");
  });

  it("supabase.co with subdomains is classified correctly", () => {
    expect(classifyFetchTarget("https://abc.def.supabase.co/rest")).toBe("supabase");
  });

  it("stripe.com with subdomains is classified correctly", () => {
    expect(classifyFetchTarget("https://api.stripe.com/v1/customers")).toBe("stripe");
  });

  it("security: domains ending in stripe.com without dot boundary are unknown", () => {
    expect(classifyFetchTarget("https://evilstripe.com/v1/charges")).toBe("unknown");
  });

  it("security: domains ending in supabase.co without dot boundary are unknown", () => {
    expect(classifyFetchTarget("https://notsupabase.co/rest")).toBe("unknown");
  });

  it("bare supabase.co domain is classified as supabase", () => {
    expect(classifyFetchTarget("https://supabase.co/rest")).toBe("supabase");
  });

  it("bare stripe.com domain is classified as stripe", () => {
    expect(classifyFetchTarget("https://stripe.com/v1")).toBe("stripe");
  });
});
