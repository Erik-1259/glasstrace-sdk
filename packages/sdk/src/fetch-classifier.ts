/**
 * The set of recognized fetch target categories.
 */
export type FetchTarget = "supabase" | "stripe" | "internal" | "unknown";

/**
 * Classifies an outbound fetch target URL into a known category.
 * Classification is case-insensitive and based on the URL hostname.
 * Uses dot-boundary matching to avoid false positives (e.g. evilstripe.com).
 *
 * Returns one of: 'supabase', 'stripe', 'internal', or 'unknown'.
 */
export function classifyFetchTarget(url: string): FetchTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === "supabase.co" ||
    hostname.endsWith(".supabase.co") ||
    hostname === "supabase.in" ||
    hostname.endsWith(".supabase.in")
  ) {
    return "supabase";
  }

  if (hostname === "stripe.com" || hostname.endsWith(".stripe.com")) {
    return "stripe";
  }

  const port = process.env.PORT ?? "3000";
  const internalOrigin = `localhost:${port}`;
  const parsedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const urlOrigin = `${hostname}:${parsedPort}`;

  if (urlOrigin === internalOrigin) {
    return "internal";
  }

  return "unknown";
}
