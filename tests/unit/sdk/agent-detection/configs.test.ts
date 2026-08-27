import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  generateMcpConfig,
  generateInfoSection,
  generateInfoSectionForCursorMdc,
  generateInfoSectionForCursorrulesLegacy,
} from "../../../../packages/sdk/src/agent-detection/configs.js";
import { buildAgentInstructionBody } from "../../../../packages/sdk/src/agent-detection/agent-instruction-text.js";
import type { DetectedAgent } from "../../../../packages/sdk/src/agent-detection/detect.js";

const ENDPOINT = "https://mcp.glasstrace.dev/v1";
const ANON_KEY = "gt_anon_test123";
// SDK-050: generateInfoSection() now requires the SDK semver string for
// the version-stamped start marker. Pin a stable test value so snapshot
// assertions don't drift when package.json's version bumps.
const SDK_VERSION = "1.4.0";
const SDK_PACKAGE_README = readFileSync(
  new URL("../../../../packages/sdk/README.md", import.meta.url),
  "utf8",
);

function makeAgent(
  name: DetectedAgent["name"],
  overrides?: Partial<DetectedAgent>,
): DetectedAgent {
  return {
    name,
    mcpConfigPath: `/fake/${name}/mcp.json`,
    infoFilePath: null,
    cliAvailable: false,
    registrationCommand: null,
    ...overrides,
  };
}

function expectSafeDiscoveryWindowGuidance(info: string): void {
  expect(info).toContain("omit `timeWindow` on the first search");
  expect(info).toContain("bounded current window from its own clock");
  expect(info).toContain("Do not invent epoch milliseconds");
  expect(info).toContain("A current-window candidate does not satisfy");
  expect(info).toContain("integer arithmetic from the returned `serverNow`");
  expect(info).toContain("user's timezone and deterministic date tooling");
  expect(info).toContain("If the response does not include it, do not calculate");
  expect(info).toContain("derived from `serverNow`");
  expect(info).toContain("nonnegative integer epoch milliseconds");
  expect(info).toContain("When `find_trace_candidates` returns");
  expect(info).toContain("`diagnostic.recoveryActions[]`");
  expect(info).toContain("whose `tool` is `find_trace_candidates`");
  expect(info).toContain("a `cursor` belongs to one exact query");
  expect(info).toContain(
    "`timeWindow: { start: effectiveTimeWindow.start, end: effectiveTimeWindow.end }`",
  );
  expect(info).toContain("not a material window change");
  expect(info).toContain("If that valid window is absent, do not continue by cursor");
  expect(info).toContain("starts a fresh search without `cursor`");
  expect(info).toContain(
    "prefer `closeMatches[].suggestedCall` over a recovery-action label",
  );
  expect(info).toContain("Accept it only when `tool` is `find_trace_candidates`");
  expect(info).toContain("exactly one own key from");
  expect(info).toContain("whose value is a nonempty string");
  expect(info).toContain("and no other keys");
  expect(info).toContain("Clear all three prior locator fields");
  expect(info).toContain("whether the original window was explicit or server-defaulted");
  expect(info).toContain("whose `suggestedParams` contains only");
  expect(info).toContain("strictly contains the returned effective interval");
  expect(info).toContain("at least one bound strict");
  expect(info).toContain("replace only `timeWindow`");
  expect(info).toContain("do not widen an interval already marked");
  expect(info).toContain("require the new valid effective interval");
  expect(info).toContain("stop widening and report the retention limit");
  expect(info).toContain("Treat `label` as explanatory text only");
  expect(info).toContain("stop rather than guess");
  expect(info).toContain(
    "`suggestedFollowups` are drill-down arguments, not search-widening instructions",
  );
  expect(info).toContain(
    "server-authoritative searched bounds and `serverNow`",
  );
  expect(info).toContain("it is not itself a widening instruction");
  expect(info).toContain("If `start > end`");
  expect(info).toContain("stop window-derived `recoveryActions`");
  expect(info).toContain("one separate current-scope search without `timeWindow`");
  expect(info).toContain("not a retry of the invalid interval");
  expect(info).toContain("if `start === end`, it searched zero duration");
  expect(info).toContain("do not classify the result as absence or partial coverage");
  expect(info).toContain("Only when effective `start < end`");
  expect(info).toContain("`retentionBounded: true`");
  expect(info).toContain("it has full temporal coverage");
  expect(info).toContain("overlap for positive duration");
  expect(info).toContain("partial historical coverage");
  expect(info).toContain("including boundary-only contact");
  expect(info).toContain("report no coverage of the requested period");
  expect(info).toContain("cannot establish absence during uncovered requested time");
  expect(info).toContain("does not by itself determine coverage");
  expect(info).not.toContain(
    "`retentionBounded: true` or effective bounds that do not cover an explicit request mean partial historical coverage",
  );
  expect(info).toContain("not a locator retry or historical continuation");
  expect(info).not.toContain("copy its `suggestedParams`");
  expect(info).not.toContain("Read its label");
  expect(info).not.toContain("rough time window");
  expect(info).not.toContain("tight time window");
  expect(info).not.toContain("open window");
}

function sectionBetween(
  text: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing section start: ${startMarker}`);
  }

  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`Missing section end after ${startMarker}: ${endMarker}`);
  }

  return text.slice(start, end);
}

function standaloneLineStartingWith(text: string, prefix: string): number {
  const matches = text.split(/\r?\n/).flatMap((line, index) =>
    line.startsWith(prefix) ? [index] : [],
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one standalone line starting with ${JSON.stringify(prefix)}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function standaloneLineEqualTo(text: string, expected: string): number {
  const matches = text.split(/\r?\n/).flatMap((line, index) =>
    line === expected ? [index] : [],
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one standalone line equal to ${JSON.stringify(expected)}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function markdownParagraphStartingWith(text: string, prefix: string): string {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  const matches = blocks.filter((block) => block.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one Markdown paragraph starting with ${JSON.stringify(prefix)}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function labeledBullet(section: string, label: string): string {
  const marker = `   - **${label}**`;
  const lines = section.split(/\r?\n/);
  const matches = lines.flatMap((line, index) =>
    line.startsWith(marker) ? [index] : [],
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one standalone routing bullet for ${label}, found ${matches.length}`,
    );
  }

  const start = matches[0];
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith("   - **"),
  );
  return lines.slice(start, next < 0 ? lines.length : next).join("\n");
}

function toolBullet(toolsSection: string, toolName: string): string {
  const marker = `- \`${toolName}\` — `;
  const matches = toolsSection
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one standalone Tools bullet for ${toolName}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function normalizeContractText(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/traceId/gi, "trace id")
    .replace(/tracing[-_ ]*identifier/gi, "trace id")
    .replace(/trace[-_ ]*identifier/gi, "trace id")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mentionsKnownTraceId(text: string): boolean {
  const normalized = normalizeContractText(text);
  return (
    /\b(?:already (?:have|has)|known|precise|provided|available|suppl(?:y|ies|ied))\b.{0,80}\btrace id\b/.test(
      normalized,
    ) ||
    /\btrace id\b.{0,80}\b(?:already (?:known|provided|available)|known|precise|provided|available|suppl(?:y|ies|ied))\b/.test(
      normalized,
    )
  );
}

function hasSupportedStepOneContract(stepOne: string): boolean {
  try {
    const exactId = labeledBullet(stepOne, "Precise trace ID already known");
    const activeFailure = labeledBullet(
      stepOne,
      "Active failure without an independently known precise trace ID",
    );
    const normalized = normalizeContractText(stepOne);
    const exactIdNormalized = normalizeContractText(exactId);
    const exactIdLine = standaloneLineStartingWith(
      stepOne,
      "   - **Precise trace ID already known**",
    );
    const activeFailureLine = standaloneLineStartingWith(
      stepOne,
      "   - **Active failure without an independently known precise trace ID**",
    );

    return (
      normalized.includes(
        "an independently known precise trace id takes precedence over every other symptom branch",
      ) &&
      !/active failure.{0,100}takes precedence over.{0,100}(?:known|precise).{0,40}trace id/.test(
        normalized,
      ) &&
      exactIdLine < activeFailureLine &&
      exactIdNormalized.includes("call get_root_cause directly") &&
      exactIdNormalized.includes("do not send a trace id to get_trace") &&
      !/(?:call|use) get_trace.{0,80}(?:with|using|by|for|\().{0,40}trace id/.test(
        exactIdNormalized,
      ) &&
      normalizeContractText(activeFailure).includes("get_latest_error first")
    );
  } catch {
    return false;
  }
}

function hasSupportedGetTraceToolsContract(toolsSection: string): boolean {
  try {
    const bullet = toolBullet(toolsSection, "get_trace");
    const normalized = normalizeContractText(bullet);
    return (
      normalized.includes(
        "filtered trace search by url, method, status code, time window, or correlation id",
      ) &&
      normalized.includes(
        "candidate-directed trace read after find_trace_candidates",
      ) &&
      !/traceId/i.test(bullet) &&
      !/get_trace\s*\([^)]*trace id/.test(normalized) &&
      !/\bexact(?:-id)? (?:trace )?(?:lookup|search|retrieval)\b/.test(
        normalized,
      ) &&
      !/\b(?:accepts?|takes?|receives?|pass(?:es)?)\b.{0,80}\b(?:user supplied )?trace id\b/.test(
        normalized,
      )
    );
  } catch {
    return false;
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lineStructuredSha256(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function rawSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function expectSupportedDiagnosticRouting(info: string): void {
  const infoLines = info.split(/\r?\n/);
  const standaloneStartMarkers = infoLines.filter((line) =>
    /^(?:<!--|#) glasstrace:mcp:start v=[^\s>]+(?: -->)?$/.test(line),
  );
  const standaloneEndMarkers = infoLines.filter((line) =>
    /^(?:<!-- glasstrace:mcp:end -->|# glasstrace:mcp:end)$/.test(line),
  );
  expect(standaloneStartMarkers).toHaveLength(1);
  expect(standaloneEndMarkers).toHaveLength(1);

  const exactHeadings = [
    "### Call Glasstrace FIRST when:",
    "### SKIP Glasstrace when:",
    "### Workflow",
    "### Tools",
  ];
  for (const heading of exactHeadings) {
    standaloneLineEqualTo(info, heading);
    const merged = info.replace(`\n${heading}`, ` ${heading}`);
    expect(merged).not.toBe(info);
    expect(() => standaloneLineEqualTo(merged, heading)).toThrow();
  }

  const structuralBoundaries = [
    "- You already have a precise `traceId` and need to inspect that trace directly.",
    "1. Pick the first call by symptom",
    "   **Explicit-window guard:**",
    "2. After `find_trace_candidates`",
    "3. Side-effect evidence",
    "4. If a tool returns empty, READ the response's empty-result envelope",
    "5. Follow-up tools refine evidence; they do not invalidate it:",
    "6. After a relevant trace is found, pause before editing:",
    "   - If a plausible candidate lacks semantic evidence,",
    "7. Stateful bugs often span more than one request",
    "8. If a route-based search is sparse, ambiguous, or returns a weak response,",
  ];
  const structuralBoundaryLines = structuralBoundaries.map((prefix) =>
    standaloneLineStartingWith(info, prefix),
  );
  expect(structuralBoundaryLines).toEqual(
    [...structuralBoundaryLines].sort((left, right) => left - right),
  );
  for (const prefix of structuralBoundaries) {
    const boundary = `\n${prefix}`;
    const merged = info.replace(boundary, ` ${prefix}`);
    expect(merged).not.toBe(info);
    expect(() => standaloneLineStartingWith(merged, prefix)).toThrow();
  }

  const allChangedBoundaryLines = [
    standaloneLineEqualTo(info, "### Call Glasstrace FIRST when:"),
    standaloneLineStartingWith(info, structuralBoundaries[0]),
    standaloneLineEqualTo(info, "### SKIP Glasstrace when:"),
    standaloneLineEqualTo(info, "### Workflow"),
    ...structuralBoundaryLines.slice(1),
    standaloneLineEqualTo(info, "### Tools"),
  ];
  expect(allChangedBoundaryLines).toEqual(
    [...allChangedBoundaryLines].sort((left, right) => left - right),
  );

  const callWhen = sectionBetween(
    info,
    "### Call Glasstrace FIRST when:",
    "### SKIP Glasstrace when:",
  );
  const skipWhen = sectionBetween(
    info,
    "### SKIP Glasstrace when:",
    "### Workflow",
  );
  const expectedCallWhenHash =
    "ee0ba3e9d7188feee61b5c18265ead514dc7c8803d391c7a7982ac8185a0328b";
  expect(lineStructuredSha256(callWhen)).toBe(expectedCallWhenHash);
  const contradictoryCallRule = callWhen.replace(
    "and need to inspect that trace directly.",
    "and need to inspect that trace directly. Even so, skip Glasstrace when the user supplied that identifier.",
  );
  expect(contradictoryCallRule).not.toBe(callWhen);
  expect(lineStructuredSha256(contradictoryCallRule)).not.toBe(
    expectedCallWhenHash,
  );
  const expectedSkipWhenHash =
    "75f591b9c8a8a064f192b5aa93a8f71c8169741386b9522d7b1154b128312b3e";
  expect(lineStructuredSha256(skipWhen)).toBe(expectedSkipWhenHash);
  const knownIdCallLine = callWhen
    .split(/\r?\n/)
    .find((line) =>
      line.startsWith(
        "- You already have a precise `traceId` and need to inspect that trace directly.",
      ),
    );
  expect(knownIdCallLine).toBeDefined();
  expect(mentionsKnownTraceId(knownIdCallLine ?? "")).toBe(true);
  expect(mentionsKnownTraceId(skipWhen)).toBe(false);
  for (const forbiddenSkipRule of [
    "- You already have a precise traceId from another source.",
    "- You already have a precise `traceId` from another source.",
    "- A precise trace ID is already known from prior context.",
    "- If the user supplies a trace identifier, skip Glasstrace.",
  ]) {
    const mutatedSkip = `${skipWhen.trimEnd()}\n${forbiddenSkipRule}\n`;
    expect(mentionsKnownTraceId(mutatedSkip)).toBe(true);
    expect(lineStructuredSha256(mutatedSkip)).not.toBe(expectedSkipWhenHash);
  }

  // Known IDs use the direct-ID tools; get_trace remains a filtered search.
  const firstCallRouting = sectionBetween(
    info,
    "1. Pick the first call by symptom",
    "   **Explicit-window guard:**",
  );
  const expectedFirstCallHash =
    "5ae34d78a3e9a4d8d85610df72ad3ae6360c3e19e37b4c320576ad179a04ad3d";
  expect(hasSupportedStepOneContract(firstCallRouting)).toBe(true);
  expect(lineStructuredSha256(firstCallRouting)).toBe(expectedFirstCallHash);

  const oppositePrecedence = firstCallRouting.replace(
    "An independently known precise trace ID takes precedence over every other symptom branch;",
    "An independently known precise trace ID takes precedence over every other symptom branch; an active failure takes precedence over an independently known precise trace ID;",
  );
  expect(oppositePrecedence).not.toBe(firstCallRouting);
  expect(hasSupportedStepOneContract(oppositePrecedence)).toBe(false);
  expect(lineStructuredSha256(oppositePrecedence)).not.toBe(
    expectedFirstCallHash,
  );

  for (const forbiddenExactLookup of [
    "call `get_trace(traceId)` directly",
    "call `get_trace({ traceId })` directly",
  ]) {
    const exactLookupMutation = firstCallRouting.replace(
      "call `get_root_cause` directly",
      forbiddenExactLookup,
    );
    expect(exactLookupMutation).not.toBe(firstCallRouting);
    expect(hasSupportedStepOneContract(exactLookupMutation)).toBe(false);
    expect(lineStructuredSha256(exactLookupMutation)).not.toBe(
      expectedFirstCallHash,
    );
  }

  const exactIdBranch = labeledBullet(
    firstCallRouting,
    "Precise trace ID already known",
  );
  expect(exactIdBranch).toContain("call `get_root_cause` directly");
  expect(exactIdBranch).toContain(
    "with no active candidate-directed sequence",
  );
  expect(exactIdBranch).toContain(
    "If `find_trace_candidates` just returned the ID inside a candidate, follow that candidate's bounded sequence",
  );
  expect(exactIdBranch).toContain("Do not send a `traceId` to `get_trace`");
  expect(exactIdBranch).toContain(
    "it searches by URL, method, status code, time window, or correlation ID",
  );
  expect(exactIdBranch).toContain(
    "use `get_span_attributes` with the independently known `traceId`",
  );
  expect(exactIdBranch).toContain(
    "include a relevant `spanId` to narrow the result",
  );
  expect(exactIdBranch).toContain(
    "even when the request just failed or a stack trace is present",
  );

  const activeFailureBranch = labeledBullet(
    firstCallRouting,
    "Active failure without an independently known precise trace ID",
  );
  expect(activeFailureBranch).toContain("`get_latest_error` first");
  const firstCallLabels = [
    "Precise trace ID already known",
    "Active failure without an independently known precise trace ID",
    "Known route or procedure with suspected misbehavior",
    "Historical exploration",
  ];
  for (const label of firstCallLabels) {
    expect(labeledBullet(firstCallRouting, label)).toContain(`**${label}**`);
  }
  for (const label of firstCallLabels.slice(1)) {
    const boundary = `\n   - **${label}**`;
    const merged = firstCallRouting.replace(boundary, `   - **${label}**`);
    expect(merged).not.toBe(firstCallRouting);
    expect(() => labeledBullet(merged, label)).toThrow();
  }

  const routing = sectionBetween(
    info,
    "2. After `find_trace_candidates`",
    "3. Side-effect evidence",
  );
  // Complete line-structured snapshot: scoped assertions below explain the
  // contract, while this digest rejects any unreviewed negation, reorder, or
  // reassociation elsewhere in the public routing section.
  const expectedRoutingHash =
    "0ffaa76255ca74569bd8854e8a45142fc0df94af474a695cd1d63a41e356e59f";
  expect(lineStructuredSha256(routing)).toBe(expectedRoutingHash);

  const routingLabels = [
    "Decisive / supporting response",
    "Present application evidence",
    "Pure stop",
    "Weak result",
    "Authentication short circuit",
    "Orphaned partial evidence",
    "Structured fields omitted / pagination",
  ];
  for (const label of routingLabels.slice(1)) {
    const boundary = `\n   - **${label}**`;
    const merged = routing.replace(boundary, `   - **${label}**`);
    expect(merged).not.toBe(routing);
    expect(lineStructuredSha256(merged)).not.toBe(expectedRoutingHash);
    expect(() => labeledBullet(merged, label)).toThrow();
  }

  // Pin each response class inside its own bullet so unrelated vocabulary
  // elsewhere in the managed body cannot make a broken association pass.
  const diagnosticResponse = labeledBullet(
    routing,
    "Decisive / supporting response",
  );
  expect(normalizeWhitespace(routing.split("\n", 1)[0])).toContain(
    "distinguish the response-level `diagnosticValue`, `recommendedNextStep`, and `maxUsefulFollowups` rollup from each candidate row's `diagnosticValue`, `sideEffectEvidence`, and `suggestedFollowups`",
  );
  expect(routing.split("\n", 1)[0]).toContain(
    "Candidate array order is rank order",
  );
  expect(routing.split("\n", 1)[0]).toContain("On a mixed page");
  expect(normalizeWhitespace(diagnosticResponse)).toContain(
    "Response-level `diagnosticValue: decisive` pairs with `recommendedNextStep: get_trace` and `maxUsefulFollowups: 1`; response-level `diagnosticValue: supporting` pairs with `recommendedNextStep: get_trace` and `maxUsefulFollowups: 2`.",
  );
  expect(diagnosticResponse).toContain(
    "These are one response budget, not per-candidate budgets",
  );
  expect(normalizeWhitespace(diagnosticResponse)).toContain(
    "Use the first candidate (the highest-ranked row) and its `suggestedFollowups.getTrace` first.",
  );
  expect(diagnosticResponse).toContain("Every candidate includes a `traceId`");
  expect(diagnosticResponse).toContain(
    "this active candidate-directed sequence takes precedence over the independently-known-ID shortcut",
  );
  expect(normalizeWhitespace(diagnosticResponse)).toContain(
    "For a supporting response, use that same first candidate's `suggestedFollowups.getRootCause` as the second step only when root-cause analysis is still useful.",
  );
  expect(diagnosticResponse).not.toContain("`inspect_source`");

  const presentEvidence = labeledBullet(routing, "Present application evidence");
  expect(presentEvidence).toContain("zero-budget response-level stop rollup");
  expect(presentEvidence).toContain(
    "`sideEffectEvidence.status` equal to `present`",
  );
  expect(presentEvidence).toContain(
    "choose the first such candidate in array order (the highest-ranked evidence-bearing row)",
  );
  expect(presentEvidence).toContain("that candidate's");
  expect(presentEvidence).toContain("`suggestedFollowups.getTrace`");
  expect(presentEvidence).toContain(
    "This per-candidate evidence override applies",
  );
  expect(presentEvidence).toContain(
    "response-level `diagnosticValue` is `route_only`, `weak`, or `auth_short_circuit`",
  );
  expect(presentEvidence).toContain("`route_only`");
  expect(presentEvidence).toContain("`weak`");
  expect(presentEvidence).toContain("`auth_short_circuit`");
  expect(presentEvidence).toContain("`maxUsefulFollowups: 0`");
  expect(presentEvidence).toContain("`recommendedNextStep: inspect_source`");
  expect(presentEvidence).toContain("read the full trace before editing");
  expect(presentEvidence).toContain(
    "When the response rollup is already decisive or supporting, use the first candidate",
  );
  expect(presentEvidence).toContain(
    "comes before the response-level `recommendedNextStep: inspect_source` or `recommendedNextStep: retry_with_authenticated_credential`",
  );

  const pureStop = labeledBullet(routing, "Pure stop");
  expect(pureStop).toContain("response-level");
  expect(pureStop).toContain("`route_only`");
  expect(pureStop).toContain("`maxUsefulFollowups: 0`");
  expect(pureStop).toContain("`recommendedNextStep: inspect_source`");
  expect(pureStop).toContain("no candidate carrying present application evidence");
  expect(pureStop).toContain("inspect source first");
  expect(pureStop).toContain("Do not issue an unconditional trace drill-down");
  expect(pureStop).toContain(
    "The first candidate's `suggestedFollowups` stay valid if source review still needs the exact trace.",
  );

  const weakResult = labeledBullet(routing, "Weak result");
  expect(weakResult).toContain("response-level");
  expect(weakResult).toContain("`diagnosticValue: weak`");
  expect(weakResult).toContain("`maxUsefulFollowups: 0`");
  expect(weakResult).toContain("`recommendedNextStep: inspect_source`");
  expect(weakResult).toContain("no candidate carrying present application evidence");
  expect(weakResult).toContain("inspect source first");
  expect(weakResult).toContain(
    "Do not turn a low-information match into a default trace drill-down.",
  );
  expect(weakResult).toContain(
    "follow the evidence-bearing-candidate override above",
  );
  expect(weakResult).not.toContain("`suggestedFollowups`");

  const authShortCircuit = labeledBullet(routing, "Authentication short circuit");
  expect(authShortCircuit).toContain("response-level");
  expect(authShortCircuit).toContain("`diagnosticValue: auth_short_circuit`");
  expect(authShortCircuit).toContain("`maxUsefulFollowups: 0`");
  expect(authShortCircuit).toContain(
    "`recommendedNextStep: retry_with_authenticated_credential`",
  );
  expect(authShortCircuit).toContain(
    "no candidate carrying present application evidence",
  );
  expect(authShortCircuit).toContain("retry with an authenticated credential");
  expect(authShortCircuit).toContain("Do not substitute candidate drill-down");
  expect(authShortCircuit).toContain(
    "read the highest-ranked evidence-bearing trace under the override above before retrying",
  );

  const presentIndex = routing.indexOf("   - **Present application evidence**");
  const pureStopIndex = routing.indexOf("   - **Pure stop**");
  const weakIndex = routing.indexOf("   - **Weak result**");
  const authIndex = routing.indexOf("   - **Authentication short circuit**");
  expect(presentIndex).toBeLessThan(pureStopIndex);
  expect(pureStopIndex).toBeLessThan(weakIndex);
  expect(weakIndex).toBeLessThan(authIndex);

  const orphanedPartial = labeledBullet(routing, "Orphaned partial evidence");
  expect(orphanedPartial).toContain(
    "`diagnostic.reason: orphaned_partial_evidence`",
  );
  expect(orphanedPartial).toContain("`recommendedNextStep: get_root_cause`");
  expect(orphanedPartial).toContain("`maxUsefulFollowups: 1`");
  expect(orphanedPartial).toContain("`candidates.length === 0`");
  expect(orphanedPartial).toContain("no candidate `suggestedFollowups`");
  expect(orphanedPartial).toContain("`diagnostic.recoveryActions[]`");
  expect(orphanedPartial).toContain("`tool` is `get_root_cause`");
  expect(orphanedPartial).toContain("`suggestedParams`");
  expect(orphanedPartial).toContain("exactly one own `traceId` key");
  expect(orphanedPartial).toContain("no other keys");
  expect(orphanedPartial).not.toContain("candidate's `suggestedFollowups`");

  const omittedFields = labeledBullet(
    routing,
    "Structured fields omitted / pagination",
  );
  expect(omittedFields).toContain("three rollup fields are absent");
  expect(omittedFields).toContain("`candidates.length === 0`");
  expect(omittedFields).toContain("`hasMore: true`");
  expect(omittedFields).toContain("response's `cursor` and diagnostic guidance");
  expect(omittedFields).toContain("Continue the identical query before widening");
  expect(omittedFields).toContain("do not invent a stop or continue signal");

  // Missing, withheld, and unsupported are preserved rather than converted
  // into affirmative absence, and stateful investigations remain multi-trace.
  const evidenceState = sectionBetween(
    info,
    "**A candidate with absent compact summaries is still evidence.**",
    "4. If a tool returns empty",
  );
  const sideEffectRouting = sectionBetween(
    info,
    "3. Side-effect evidence",
    "4. If a tool returns empty",
  );
  const expectedSideEffectRoutingHash =
    "c325ca9b6bf711499c63203855477d1b95904c697bac792ed67e0ce2d813c3ad";
  expect(lineStructuredSha256(sideEffectRouting)).toBe(
    expectedSideEffectRoutingHash,
  );
  expect(sideEffectRouting).toContain(
    "a decisive/supporting response still uses the first candidate and the response-level follow-up budget",
  );
  expect(sideEffectRouting).toContain(
    "only a zero-budget `route_only`/`weak`/`auth_short_circuit` response uses the highest-ranked evidence-bearing candidate override",
  );
  expect(sideEffectRouting).toContain(
    "Presence does not create a separate follow-up budget for each candidate",
  );
  const perCandidateBudgetMutation = `${sideEffectRouting.trimEnd()} Every candidate with present evidence gets its own trace pull.`;
  expect(lineStructuredSha256(perCandidateBudgetMutation)).not.toBe(
    expectedSideEffectRoutingHash,
  );
  expect(evidenceState).toContain(
    "A present `sideEffectEvidence` object with `status` `missing` / `withheld` / `unsupported` carries `notAbsenceProof`",
  );
  expect(evidenceState).toContain(
    "If the entire `sideEffectEvidence` field is absent",
  );
  expect(evidenceState).toContain("there is no object or flag to read");
  expect(evidenceState).toContain(
    "never rewrite missing, withheld, unsupported, or omitted evidence as affirmative absence",
  );
  expect(evidenceState).not.toContain(
    "is absent or has `status` `missing` / `withheld` / `unsupported` is likewise not proof there was no side effect (it carries `notAbsenceProof`)",
  );

  const editBoundaryAndStatefulRouting = sectionBetween(
    info,
    "6. After a relevant trace is found",
    "8. If a route-based search",
  );
  const expectedEditBoundaryAndStatefulHash =
    "14295d38c811dfec0a0c99e3f28439d6a26fb28190b659fb716ed4ce2d53329e";
  expect(lineStructuredSha256(editBoundaryAndStatefulRouting)).toBe(
    expectedEditBoundaryAndStatefulHash,
  );
  const noMultiTraceComparison = editBoundaryAndStatefulRouting.replace(
    "compare the relevant traces in sequence",
    "do not compare the relevant traces in sequence",
  );
  expect(noMultiTraceComparison).not.toBe(editBoundaryAndStatefulRouting);
  expect(lineStructuredSha256(noMultiTraceComparison)).not.toBe(
    expectedEditBoundaryAndStatefulHash,
  );
  const ambiguousEditBoundaryException =
    `${editBoundaryAndStatefulRouting.trimEnd()} Except when a candidate is ambiguous, ignore the matching response-level row.`;
  expect(lineStructuredSha256(ambiguousEditBoundaryException)).not.toBe(
    expectedEditBoundaryAndStatefulHash,
  );

  const weakRecovery = sectionBetween(
    info,
    "8. If a route-based search",
    "### Tools",
  );
  const expectedWeakRecoveryHash =
    "0f9ab5424c15dff1e70ced9dc08604321f09007ffc63060349a6e7dbe95cb20a";
  expect(lineStructuredSha256(weakRecovery)).toBe(expectedWeakRecoveryHash);
  expect(weakRecovery).toContain(
    "When no candidate carries present application evidence, first honor the matching response-level row in step 2",
  );
  expect(weakRecovery).toContain(
    "a decisive/supporting response uses the first candidate's bounded drill-down sequence",
  );
  expect(weakRecovery).toContain(
    "a `route_only`/`weak` response inspects source",
  );
  expect(weakRecovery).toContain(
    "an `auth_short_circuit` response retries with an authenticated credential",
  );
  expect(weakRecovery).toContain(
    "Present application evidence still follows the applicable step 2 row",
  );
  expect(weakRecovery).toContain(
    "a decisive/supporting response continues through the first candidate",
  );
  expect(weakRecovery).toContain(
    "only a zero-budget `route_only`/`weak`/`auth_short_circuit` response uses the highest-ranked evidence-bearing candidate override",
  );
  const ambiguousResponseException = weakRecovery.replace(
    "a decisive/supporting response continues through the first candidate",
    "a decisive/supporting response continues through the first candidate except when the response is ambiguous",
  );
  expect(ambiguousResponseException).not.toBe(weakRecovery);
  expect(lineStructuredSha256(ambiguousResponseException)).not.toBe(
    expectedWeakRecoveryHash,
  );
  expect(weakRecovery).toContain(
    "only when the response provides a valid structured route",
  );
  expect(info).toContain("compare the relevant traces in sequence");

  const tools = sectionBetween(info, "### Tools", "\n\n");
  const expectedToolsHash =
    "b0d407bcce5c58b4c466c84ed2ca346bb4fe19579b42f737075307ab02dcc8a0";
  expect(lineStructuredSha256(tools)).toBe(expectedToolsHash);
  expect(hasSupportedGetTraceToolsContract(tools)).toBe(true);
  const getTraceTool = toolBullet(tools, "get_trace");
  expect(getTraceTool).toContain(
    "filtered trace search by URL, method, status code, time window, or correlation ID",
  );
  expect(getTraceTool).toContain(
    "also the candidate-directed trace read after `find_trace_candidates`",
  );
  expect(getTraceTool).not.toContain("`traceId`");

  const exactGetTraceTool = tools.replace(
    getTraceTool,
    "- `get_trace` — exact trace lookup by `traceId`",
  );
  expect(exactGetTraceTool).not.toBe(tools);
  expect(hasSupportedGetTraceToolsContract(exactGetTraceTool)).toBe(false);

  const traceIdInputTool = tools.replace(
    getTraceTool,
    `${getTraceTool}; call \`get_trace({ traceId })\` for an exact lookup`,
  );
  expect(traceIdInputTool).not.toBe(tools);
  expect(hasSupportedGetTraceToolsContract(traceIdInputTool)).toBe(false);

  const proseTraceIdInputTool = tools.replace(
    getTraceTool,
    `${getTraceTool}; accepts traceId input`,
  );
  expect(proseTraceIdInputTool).not.toBe(tools);
  expect(hasSupportedGetTraceToolsContract(proseTraceIdInputTool)).toBe(false);

  const tracingIdentifierInputTool = tools.replace(
    getTraceTool,
    `${getTraceTool}; it accepts a user-supplied tracing identifier`,
  );
  expect(tracingIdentifierInputTool).not.toBe(tools);
  expect(hasSupportedGetTraceToolsContract(tracingIdentifierInputTool)).toBe(
    false,
  );
  expect(lineStructuredSha256(tracingIdentifierInputTool)).not.toBe(
    expectedToolsHash,
  );

  expect(tools).toContain(
    "for an independently known `traceId` when no active candidate sequence applies",
  );

  expect(info).not.toContain("You already have a precise traceId from another source");
  expect(info).not.toContain("`get_trace` — exact trace by `traceId`");
  expect(info).not.toContain(
    "inspect the highest-confidence candidate with `get_trace` or `get_root_cause` before deciding",
  );
  expect(info).not.toContain("In every case, pull the trace");
  expect(info).not.toContain(
    "If a plausible candidate lacks semantic evidence, pull the trace if possible",
  );
  expect(info).not.toContain(
    "For a non-stop result, use the useful drill-down arguments",
  );
}

describe("generateMcpConfig", () => {
  describe("input validation", () => {
    it("throws when endpoint is empty", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), "", ANON_KEY),
      ).toThrow(/endpoint must not be empty/);
    });

    it("throws when endpoint is whitespace-only", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), "   ", ANON_KEY),
      ).toThrow(/endpoint must not be empty/);
    });

    it("throws when anonKey is empty", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), ENDPOINT, ""),
      ).toThrow(/bearer must not be empty/);
    });

    it("throws when anonKey is whitespace-only", () => {
      expect(() =>
        generateMcpConfig(makeAgent("generic"), ENDPOINT, "   "),
      ).toThrow(/bearer must not be empty/);
    });

    it("throws when endpoint is valid but anonKey is empty (partial invalidity)", () => {
      expect(() =>
        generateMcpConfig(makeAgent("claude"), ENDPOINT, ""),
      ).toThrow(/bearer must not be empty/);
    });
  });

  describe("Claude Code config", () => {
    it("produces correct JSON with type and url fields", () => {
      const config = generateMcpConfig(
        makeAgent("claude"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: {
              Authorization: `Bearer ${ANON_KEY}`,
            },
          },
        },
      });
    });

    it("is pretty-printed with 2-space indent", () => {
      const config = generateMcpConfig(
        makeAgent("claude"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(config).toContain("  ");
      expect(config).not.toContain("\t");
    });
  });

  describe("Codex CLI config", () => {
    it("produces valid TOML format", () => {
      const config = generateMcpConfig(
        makeAgent("codex"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(config).toContain("[mcp_servers.glasstrace]");
      expect(config).toContain(`url = "${ENDPOINT}"`);
      expect(config).toContain(
        'bearer_token_env_var = "GLASSTRACE_API_KEY"',
      );
    });

    it("does NOT contain the actual token value", () => {
      const config = generateMcpConfig(
        makeAgent("codex"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(config).not.toContain(ANON_KEY);
    });

    it("escapes control characters in the endpoint for valid TOML", () => {
      const malformedEndpoint = "https://example.com/path\nHost: evil.com";
      const config = generateMcpConfig(
        makeAgent("codex"),
        malformedEndpoint,
        ANON_KEY,
      );
      // The raw newline must be escaped, not embedded literally
      expect(config).not.toContain("\nHost:");
      expect(config).toContain("\\n");
      // Verify backslash and tab escaping as well
      const withTab = "https://example.com/\tpath";
      const tabConfig = generateMcpConfig(makeAgent("codex"), withTab, ANON_KEY);
      expect(tabConfig).not.toContain("\t");
      expect(tabConfig).toContain("\\t");
    });

    it("escapes carriage returns in the endpoint", () => {
      const withCR = "https://example.com/\r\npath";
      const config = generateMcpConfig(makeAgent("codex"), withCR, ANON_KEY);
      expect(config).not.toContain("\r");
      expect(config).toContain("\\r");
    });
  });

  describe("Gemini CLI config", () => {
    it("uses httpUrl instead of url", () => {
      const config = generateMcpConfig(
        makeAgent("gemini"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.httpUrl).toBe(ENDPOINT);
      expect(parsed.mcpServers.glasstrace.url).toBeUndefined();
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("gemini"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });
  });

  describe("Cursor config", () => {
    // DISC-1573 / Wave 17: cursor branch now emits the canonical
    // `{ type: "http", url, headers }` shape per Cursor's current MCP
    // HTTP server schema. The prior shape (no `type` field) is retired.
    it("emits the canonical Claude-compatible HTTP shape", () => {
      const config = generateMcpConfig(
        makeAgent("cursor"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${ANON_KEY}` },
          },
        },
      });
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("cursor"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });
  });

  describe("Windsurf config", () => {
    // DISC-1574 / Wave 17: windsurf branch now emits `url` (not the
    // prior `serverUrl`) and includes `type: "http"` per Windsurf's
    // current MCP HTTP server schema. The prior shape is retired.
    it("emits the canonical Claude-compatible HTTP shape (was: serverUrl + no type)", () => {
      const config = generateMcpConfig(
        makeAgent("windsurf"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${ANON_KEY}` },
          },
        },
      });
      // Regression guard: the legacy `serverUrl` field MUST NOT appear.
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.serverUrl).toBeUndefined();
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("windsurf"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });
  });

  describe("exhaustive switch", () => {
    it("throws for an unknown agent name", () => {
      const unknownAgent = makeAgent("claude");
      // Force an invalid name to test the default branch at runtime
      (unknownAgent as { name: string }).name = "unknown-agent";
      expect(() =>
        generateMcpConfig(unknownAgent as DetectedAgent, ENDPOINT, ANON_KEY),
      ).toThrow(/Unknown agent/);
    });
  });

  describe("Generic config", () => {
    it("uses url field", () => {
      const config = generateMcpConfig(
        makeAgent("generic"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.url).toBe(ENDPOINT);
    });

    it("includes auth header", () => {
      const config = generateMcpConfig(
        makeAgent("generic"),
        ENDPOINT,
        ANON_KEY,
      );
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.glasstrace.headers.Authorization).toBe(
        `Bearer ${ANON_KEY}`,
      );
    });

    // DISC-1572: the generic shape must include `type: "http"` so
    // `.glasstrace/mcp.json` is accepted by Claude Code's
    // `--strict-mcp-config` validator. The full shape assertion below
    // pins the field set so that future emitter changes either adopt
    // the new shape or fail loudly in this test.
    it("emits the Claude-compatible HTTP shape", () => {
      const config = generateMcpConfig(
        makeAgent("generic"),
        ENDPOINT,
        ANON_KEY,
      );
      expect(JSON.parse(config)).toEqual({
        mcpServers: {
          glasstrace: {
            type: "http",
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${ANON_KEY}` },
          },
        },
      });
    });
  });
});

describe("generateInfoSection", () => {
  it("freezes the complete shared instruction body", () => {
    const body = buildAgentInstructionBody();
    const expectedBodyHash =
      "62c8afa78dc1615539b2b80cac5c207d0adc3e9fcc749efcbed08d40d7c6ad33";
    const expectedRawBodyHash =
      "af3bc9f851768c51273e12479c3551556c24d2fe49f1a977d11e52e584eafb96";
    expect(body).toContain("## Glasstrace MCP — Runtime Debugging Evidence");
    expect(body.startsWith("\n")).toBe(true);
    expect(body.endsWith("\n")).toBe(true);
    expect(lineStructuredSha256(body)).toBe(expectedBodyHash);
    expect(rawSha256(body)).toBe(expectedRawBodyHash);
  });

  describe("input validation", () => {
    it("throws when endpoint is empty", () => {
      expect(() => generateInfoSection(makeAgent("claude"), "", SDK_VERSION)).toThrow(
        /endpoint must not be empty/,
      );
    });

    it("throws when endpoint is whitespace-only", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), "   ", SDK_VERSION),
      ).toThrow(/endpoint must not be empty/);
    });
  });

  describe("Claude Code info section", () => {
    it("uses HTML comment markers carrying the SDK version stamp", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    // Wave 17 / 2026-05-09: the new agent-instruction body deliberately
    // does NOT inline the endpoint URL — agents reach Glasstrace via the
    // MCP server name `glasstrace` configured in `.glasstrace/mcp.json`
    // or per-agent native config. Keeping the URL out of the instruction
    // file avoids drift between the instruction file and the MCP config.
    // (Prior SDK-050 contract DID inline the endpoint; that test
    // assertion has been retired in lockstep with the content evolution.)
    it("does NOT inline the endpoint URL (Wave 17 — agent reaches Glasstrace via MCP server name, not by reading URL from instruction file)", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain(ENDPOINT);
      // The MCP server name SHOULD be present so the agent knows which
      // configured server to call.
      expect(info).toContain("`glasstrace`");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain(ANON_KEY);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
      expect(info).not.toContain("gt_anon_");
      expect(info).not.toContain("gt_dev_");
    });

    it("references the current MCP tools list (get_test_suggestions retired; get_span_attributes drill-down included)", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("get_latest_error");
      expect(info).toContain("find_trace_candidates");
      expect(info).toContain("get_error_list");
      expect(info).toContain("get_trace");
      expect(info).toContain("get_root_cause");
      // get_span_attributes is a registered MCP tool (the scalar
      // span-attribute drill-down); the body names it so the agent can
      // reach the Layer-2 evidence the Workflow follow-up guidance
      // refers to. Pin it to the primary Tools list line (mirrors the
      // get_test_suggestions OFF-list guard below) so dropping the list
      // entry is caught even if the §5 prose mention survives.
      expect(
        info.split("\n").some((l) => /^- `get_span_attributes`/.test(l)),
        "get_span_attributes appears on the primary Tools list",
      ).toBe(true);
      expect(info).toContain("get_session_timeline");
      // get_test_suggestions stays OFF the primary Tools list — the
      // Workflow covers the discovery-then-deep-dive path without a
      // separate test-suggestions bullet (it still requires a traceId at
      // the MCP server contract level; the agent learns the traceId via
      // `suggestedFollowups`).
      const line = info
        .split("\n")
        .find((l) => /^- `get_test_suggestions`/.test(l));
      expect(
        line,
        "get_test_suggestions stays off the primary Tools list",
      ).toBeUndefined();
    });

    // Wave 17 vocabulary correction (R13 from wave plan): the prompt
    // names `suggestedFollowups` (singular noun, no Args suffix) — that
    // is the actual server contract field name in
    // `wire-mcp.ts:755`. An earlier draft of the prompt used
    // `suggestedFollowupArgs`; if that string ever appears in the
    // rendered output, the vocabulary has drifted and downstream agents
    // will look for a non-existent field.
    it("uses the correct `suggestedFollowups` field name (NOT `suggestedFollowupArgs`)", () => {
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("`suggestedFollowups`");
      expect(info).not.toContain("suggestedFollowupArgs");
    });
  });

  describe("Codex info section", () => {
    it("uses HTML comment markers carrying the SDK version stamp", () => {
      const info = generateInfoSection(makeAgent("codex"), ENDPOINT, SDK_VERSION);
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("codex"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
    });
  });

  describe("Cursor info section", () => {
    it("uses HTML comment markers (Wave 18: cursor canonical destination is .cursor/rules/glasstrace.mdc which is Markdown-extension; prior hash markers were for the legacy .cursorrules file)", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
    });

    it("does NOT contain any auth token", () => {
      const info = generateInfoSection(makeAgent("cursor"), ENDPOINT, SDK_VERSION);
      expect(info).not.toContain("Bearer");
      expect(info).not.toContain("Authorization");
    });
  });

  describe("exhaustive switch", () => {
    it("throws for an unknown agent name", () => {
      const unknownAgent = makeAgent("claude");
      (unknownAgent as { name: string }).name = "unknown-agent";
      expect(() =>
        generateInfoSection(unknownAgent as DetectedAgent, ENDPOINT, SDK_VERSION),
      ).toThrow(/Unknown agent/);
    });
  });

  describe("Wave 18: all agents now render an info section", () => {
    // Pre-Wave-18 the gemini/windsurf/generic branches returned ""
    // because the SDK had no canonical destination wired for them.
    // Wave 18 (DISC-1782) wires every agent to a 2026 canonical
    // destination (GEMINI.md / .windsurf/rules/glasstrace.md /
    // AGENTS.md) so generateInfoSection now returns content for all
    // six agents.
    it("renders the body for gemini wrapped in HTML markers", () => {
      const info = generateInfoSection(makeAgent("gemini"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
      expect(info).toContain("Glasstrace MCP");
    });

    it("renders the body for windsurf wrapped in HTML markers", () => {
      const info = generateInfoSection(makeAgent("windsurf"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
      expect(info).toContain("Glasstrace MCP");
    });

    it("renders the body for generic wrapped in HTML markers (universal AGENTS.md fallback)", () => {
      const info = generateInfoSection(makeAgent("generic"), ENDPOINT, SDK_VERSION);
      expect(info).toContain("<!-- glasstrace:mcp:start");
      expect(info).toContain("<!-- glasstrace:mcp:end -->");
      expect(info).toContain("Glasstrace MCP");
    });
  });

  describe("supported diagnostic routing across every rendered target family", () => {
    const renderedTargets: Array<{
      label: string;
      render: () => string;
    }> = [
      {
        label: "Claude",
        render: () => generateInfoSection(makeAgent("claude"), ENDPOINT, SDK_VERSION),
      },
      {
        label: "Codex",
        render: () => generateInfoSection(makeAgent("codex"), ENDPOINT, SDK_VERSION),
      },
      {
        label: "Gemini",
        render: () => generateInfoSection(makeAgent("gemini"), ENDPOINT, SDK_VERSION),
      },
      {
        label: "Windsurf",
        render: () =>
          generateInfoSection(makeAgent("windsurf"), ENDPOINT, SDK_VERSION),
      },
      {
        label: "generic AGENTS.md",
        render: () =>
          generateInfoSection(makeAgent("generic"), ENDPOINT, SDK_VERSION),
      },
      {
        label: "Cursor .mdc",
        render: () => generateInfoSectionForCursorMdc(ENDPOINT, SDK_VERSION),
      },
      {
        label: "legacy Cursor fallback",
        render: () =>
          generateInfoSectionForCursorrulesLegacy(ENDPOINT, SDK_VERSION),
      },
    ];

    for (const target of renderedTargets) {
      it(`renders the complete positive and negative routing matrix for ${target.label}`, () => {
        expectSupportedDiagnosticRouting(target.render());
      });
    }
  });

  it("keeps the published package README aligned with every diagnostic routing row", () => {
    const readmeRoutingStart = "The section opens with explicit";
    const readmeRoutingEnd =
      "For a first `find_trace_candidates` search by route or procedure";
    const readmeRoutingSection = sectionBetween(
      SDK_PACKAGE_README,
      readmeRoutingStart,
      readmeRoutingEnd,
    );
    const readmeRouting = normalizeWhitespace(readmeRoutingSection);
    const readmeRoutingIntro =
      "After `find_trace_candidates`, the agent reads the response-level";
    const readmeParagraphAfterRouting = "The section also teaches the agent";
    const readmeParagraphAfterChangedGuidance = readmeRoutingEnd;
    const openingParagraph = markdownParagraphStartingWith(
      SDK_PACKAGE_README,
      readmeRoutingStart,
    );
    const routingIntroParagraph = markdownParagraphStartingWith(
      SDK_PACKAGE_README,
      readmeRoutingIntro,
    );
    const paragraphAfterRouting = markdownParagraphStartingWith(
      SDK_PACKAGE_README,
      readmeParagraphAfterRouting,
    );
    const paragraphAfterChangedGuidance = markdownParagraphStartingWith(
      SDK_PACKAGE_README,
      readmeParagraphAfterChangedGuidance,
    );
    expect(openingParagraph).toContain(
      "not as an exact-ID lookup.",
    );
    expect(routingIntroParagraph).toContain(
      "Candidate array order is rank order.",
    );
    expect(normalizeWhitespace(paragraphAfterRouting)).toContain(
      "side-effect evidence as first-class runtime facts",
    );
    const readmeParagraphPositions = [
      SDK_PACKAGE_README.indexOf(openingParagraph),
      SDK_PACKAGE_README.indexOf(routingIntroParagraph),
      SDK_PACKAGE_README.indexOf(paragraphAfterRouting),
      SDK_PACKAGE_README.indexOf(paragraphAfterChangedGuidance),
    ];
    expect(readmeParagraphPositions).toEqual(
      [...readmeParagraphPositions].sort((left, right) => left - right),
    );
    for (const paragraphPrefix of [
      readmeRoutingStart,
      readmeRoutingIntro,
      readmeParagraphAfterRouting,
      readmeParagraphAfterChangedGuidance,
    ]) {
      const boundary = `\n\n${paragraphPrefix}`;
      const merged = SDK_PACKAGE_README.replace(
        boundary,
        `\n${paragraphPrefix}`,
      );
      expect(merged).not.toBe(SDK_PACKAGE_README);
      expect(() =>
        markdownParagraphStartingWith(merged, paragraphPrefix),
      ).toThrow();
    }
    const expectedReadmeRoutingHash =
      "46c7324d0ccc6b1f22af53932d38898fc80527571b75184f5d4cac1118107b36";

    // Keep the digest boundaries explicit: this starts at the complete
    // decision-routing paragraph (including the independent trace-ID action)
    // and ends after every paragraph changed by this PR, before the unchanged
    // explicit-window section. The normalized length helps distinguish prose
    // drift from a reviewed wording update, while the digest preserves line
    // boundaries.
    expect(readmeRouting.startsWith(readmeRoutingStart)).toBe(true);
    expect(readmeRouting.endsWith("path never ran.")).toBe(true);
    expect(readmeRouting).toHaveLength(5286);
    expect(lineStructuredSha256(readmeRoutingSection)).toBe(
      expectedReadmeRoutingHash,
    );

    expect(readmeRouting).toContain(
      "When a precise `traceId` is independently known and no candidate-directed sequence is active, that branch takes precedence even when the request just failed or a stack trace is present.",
    );
    expect(readmeRouting).toContain(
      "The guidance routes directly to `get_root_cause`, with `get_span_attributes` available for value-level span detail.",
    );
    expect(readmeRouting).toContain(
      "A trace ID returned by `find_trace_candidates` follows the candidate sequence below instead.",
    );
    expect(readmeRouting).toContain(
      "The guidance describes `get_trace` as a filtered search by URL, method, status code, time window, or correlation ID, not as an exact-ID lookup.",
    );

    // Regression proof for the partial-range false green: changing the direct
    // known-ID action to get_trace must alter the frozen section digest.
    const wrongDirectTool = readmeRoutingSection.replace(
      "directly to `get_root_cause`",
      "directly to `get_trace`",
    );
    expect(wrongDirectTool).not.toBe(readmeRoutingSection);
    expect(lineStructuredSha256(wrongDirectTool)).not.toBe(
      expectedReadmeRoutingHash,
    );

    const wrongAbsenceMeaning = readmeRoutingSection.replace(
      "candidate is not absence evidence",
      "candidate is absence evidence",
    );
    expect(wrongAbsenceMeaning).not.toBe(readmeRoutingSection);
    expect(lineStructuredSha256(wrongAbsenceMeaning)).not.toBe(
      expectedReadmeRoutingHash,
    );

    const readmeBulletPrefixes = [
      "- A response-level `decisive` rollup",
      "- On a zero-budget response-level stop rollup",
      "- A pure response-level `route_only` stop result",
      "- A response-level `weak` / `0` / `inspect_source` result",
      "- An empty `orphaned_partial_evidence` result",
      "- Missing, withheld, unsupported, or omitted evidence",
    ];
    const readmeBulletLines = readmeBulletPrefixes.map((prefix) =>
      standaloneLineStartingWith(readmeRoutingSection, prefix),
    );
    expect(readmeBulletLines).toEqual(
      [...readmeBulletLines].sort((left, right) => left - right),
    );
    for (const prefix of readmeBulletPrefixes) {
      const boundary = `\n${prefix}`;
      const merged = readmeRoutingSection.replace(boundary, ` ${prefix}`);
      expect(merged).not.toBe(readmeRoutingSection);
      expect(lineStructuredSha256(merged)).not.toBe(expectedReadmeRoutingHash);
      expect(() => standaloneLineStartingWith(merged, prefix)).toThrow();
    }

    expect(readmeRouting).toContain(
      "the response-level `diagnosticValue`, `recommendedNextStep`, and `maxUsefulFollowups` rollup separately from each candidate's `diagnosticValue`, `sideEffectEvidence`, and `suggestedFollowups`.",
    );
    expect(readmeRouting).toContain(
      "Candidate array order is rank order. On a mixed page, the response rollup chooses the branch and that branch identifies which ranked candidate supplies the follow-up arguments:",
    );
    expect(readmeRouting).toContain(
      "A response-level `decisive` rollup uses the first candidate (the highest-ranked row) and its `suggestedFollowups.getTrace` for the response's one useful follow-up.",
    );
    expect(readmeRouting).toContain(
      "A response-level `supporting` rollup uses that same candidate's trace read first and may then use its `suggestedFollowups.getRootCause` as the response's second useful follow-up.",
    );
    expect(readmeRouting).toContain(
      "The budget is response-level, not one budget per candidate.",
    );
    expect(readmeRouting).toContain(
      "This candidate-directed sequence takes precedence over the independently-known-ID shortcut even though every candidate includes a `traceId`.",
    );
    expect(readmeRouting).toContain(
      'On a zero-budget response-level stop rollup, explicit `sideEffectEvidence.status: "present"` on one or more candidate rows still justifies a trace read.',
    );
    expect(readmeRouting).toContain(
      "The agent selects the first such candidate in array order (the highest-ranked evidence-bearing row) and uses that candidate's `suggestedFollowups.getTrace`.",
    );
    expect(readmeRouting).toContain(
      "This per-candidate evidence override takes precedence over the independently-known-ID shortcut and applies to response-level `route_only`, `weak`, and `auth_short_circuit` stop rows.",
    );
    expect(readmeRouting).toContain(
      "A pure response-level `route_only` stop result with no candidate carrying present application evidence sends the agent to source first.",
    );
    expect(readmeRouting).toContain(
      "It does not issue an unconditional trace drill-down; the first candidate's suggested arguments remain valid if source review still needs the exact trace.",
    );
    expect(readmeRouting).toContain(
      "A response-level `weak` / `0` / `inspect_source` result with no candidate carrying present application evidence also sends the agent to source first; present evidence follows the highest-ranked-evidence-bearing-candidate override above.",
    );
    expect(readmeRouting).toContain(
      "A response-level `auth_short_circuit` / `0` / `retry_with_authenticated_credential` result with no present evidence retries with an authenticated credential instead of substituting trace drill-down. With present evidence, the agent reads the highest-ranked evidence-bearing trace first, then retries with an authenticated credential if that remains useful.",
    );
    expect(readmeRouting).toContain(
      "An empty `orphaned_partial_evidence` result is presence-affirming. It has no candidate `suggestedFollowups`; the agent uses only a validated `get_root_cause` entry from `diagnostic.recoveryActions[]` and its `suggestedParams`.",
    );
    expect(readmeRouting).toContain(
      "If the structured rollup fields are omitted on a paginated empty page, the agent follows the response's cursor and diagnostic guidance for the identical query instead of inventing a signal or widening first.",
    );
    expect(readmeRouting).toContain(
      "Missing, withheld, unsupported, or omitted evidence retains that state and is never rewritten as affirmative absence.",
    );
    expect(readmeRouting).not.toContain(
      "highest-confidence `find_trace_candidates` result with `get_trace` or `get_root_cause` before deciding",
    );

    const candidateIndex = readmeRoutingSection.indexOf(
      "- A response-level `decisive` rollup",
    );
    const presentIndex = readmeRoutingSection.indexOf(
      "- On a zero-budget response-level stop rollup",
    );
    const routeOnlyIndex = readmeRoutingSection.indexOf(
      "- A pure response-level `route_only` stop result",
    );
    const weakAuthIndex = readmeRoutingSection.indexOf(
      "- A response-level `weak` / `0` / `inspect_source` result",
    );
    expect(candidateIndex).toBeGreaterThanOrEqual(0);
    expect(candidateIndex).toBeLessThan(presentIndex);
    expect(presentIndex).toBeLessThan(routeOnlyIndex);
    expect(routeOnlyIndex).toBeLessThan(weakAuthIndex);
  });

  // Wave 17 (2026-05-09): snapshot-style assertions on the rendered info
  // section for every target that emits content today (claude / codex /
  // cursor). The body is sourced from the new sibling
  // `agent-instruction-text.ts` module per Erik's 2026-05-09 Prompt 1
  // directive. Two load-bearing parts the prior SDK-050 / DISC-1593
  // paragraph did NOT have:
  //   1. Explicit `Call Glasstrace FIRST when:` / `SKIP Glasstrace when:`
  //      decision rules — give a frontier agent a cheap pre-tool-call
  //      heuristic before spending tokens on tool consideration.
  //   2. Explicit instruction to READ `closeMatches`, `recentRoutesSample`,
  //      and `recoveryActions` before pivoting to source — prevents the
  //      bail-to-source failure mode after an empty MCP result.
  //
  // (The prior SDK-050 acceptance-gate assertions for the cost-aware
  // decision paragraph have been retired in lockstep with the content
  // evolution; the marker / version-stamp contract from DISC-1592 +
  // DISC-1602 is preserved and asserted below.)
  describe("Wave 17 agent-instruction body + version stamp", () => {
    const TARGETS = [
      { name: "claude" as const, markerKind: "html" as const },
      { name: "codex" as const, markerKind: "html" as const },
      // Wave 18 (DISC-1782): Cursor's canonical destination changed
      // from `.cursorrules` (hash markers) to `.cursor/rules/
      // glasstrace.mdc` (Markdown-extension format with HTML markers).
      // The legacy `.cursorrules` transitional fallback retains hash
      // markers via `generateInfoSectionForCursorrulesLegacy`.
      { name: "cursor" as const, markerKind: "html" as const },
      { name: "gemini" as const, markerKind: "html" as const },
      { name: "windsurf" as const, markerKind: "html" as const },
      { name: "generic" as const, markerKind: "html" as const },
    ];

    for (const target of TARGETS) {
      describe(`target=${target.name}`, () => {
        it("renders the FIRST/SKIP decision rules", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Two load-bearing decision-rule headers that give a frontier
          // agent a cheap pre-tool-call heuristic.
          expect(info).toContain("### Call Glasstrace FIRST when:");
          expect(info).toContain("### SKIP Glasstrace when:");
          // At least one trigger and one skip indicator must be present.
          expect(info).toMatch(/role, locale, timezone/);
          expect(info).toMatch(/statically obvious from source/);
        });

        it("renders the Workflow step 1 as a symptom-keyed decision tree", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("### Workflow");
          const workflowIdx = info.indexOf("### Workflow");
          // Step 1 is now a decision-tree header that routes to one of
          // four first calls by symptom (independently known trace ID /
          // active failure / known route / historical exploration).
          const stepOneIdx = info.indexOf(
            "1. Pick the first call by symptom, using the first matching branch.",
            workflowIdx,
          );
          expect(stepOneIdx).toBeGreaterThan(-1);
          const stepTwoIdx = info.indexOf(
            "2. After `find_trace_candidates`",
            stepOneIdx,
          );
          expect(stepTwoIdx).toBeGreaterThan(stepOneIdx);
          // All four first-call branches and their safe-window contract
          // are present before the drill-down step begins.
          const stepOneSlice = info.slice(stepOneIdx, stepTwoIdx);
          expect(stepOneSlice).toContain("Active failure");
          expect(stepOneSlice).toContain("`get_latest_error`");
          expect(stepOneSlice).toContain("Precise trace ID already known");
          expect(stepOneSlice).toContain("`get_root_cause` directly");
          expect(stepOneSlice).toContain(
            "An independently known precise trace ID takes precedence over every other symptom branch",
          );
          const exactIdIndex = stepOneSlice.indexOf(
            "Precise trace ID already known",
          );
          const activeFailureIndex = stepOneSlice.indexOf("Active failure");
          const knownRouteIndex = stepOneSlice.indexOf(
            "Known route or procedure",
          );
          const historicalIndex = stepOneSlice.indexOf(
            "Historical exploration",
          );
          expect(exactIdIndex).toBeLessThan(activeFailureIndex);
          expect(activeFailureIndex).toBeLessThan(knownRouteIndex);
          expect(knownRouteIndex).toBeLessThan(historicalIndex);
          expect(stepOneSlice).toContain(
            "Do not send a `traceId` to `get_trace`",
          );
          expect(stepOneSlice).toContain("Known route or procedure");
          expect(stepOneSlice).toContain("`find_trace_candidates`");
          expect(stepOneSlice).toContain("omit `timeWindow` on the first search");
          expect(stepOneSlice).toContain("Historical exploration");
          expect(stepOneSlice).toContain("server-defaulted bounded search");
          expectSafeDiscoveryWindowGuidance(info);
        });

        it("preserves the SDK-050 cost-aware framing alongside the decision-tree §1", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // The decision tree is additive — the SDK-050 cost-aware
          // sections (Call Glasstrace FIRST when / SKIP Glasstrace
          // when) must remain present alongside the new Workflow §1
          // so the agent has both the symptom-class router (which
          // tool to pick first) and the cost-vs-skip guidance
          // (whether to call Glasstrace at all).
          expect(info).toContain("### Call Glasstrace FIRST when:");
          expect(info).toContain("### SKIP Glasstrace when:");
          // Both must appear BEFORE the Workflow section so an agent
          // reading top-to-bottom evaluates "should I call?" before
          // "which tool?". Pin both section positions so a future
          // content edit can't silently drift either one below the
          // Workflow header.
          const firstWhenIdx = info.indexOf("### Call Glasstrace FIRST when:");
          const skipWhenIdx = info.indexOf("### SKIP Glasstrace when:");
          const workflowIdx = info.indexOf("### Workflow");
          expect(firstWhenIdx).toBeLessThan(workflowIdx);
          expect(skipWhenIdx).toBeLessThan(workflowIdx);
          // Conventional ordering: Call FIRST before SKIP, both
          // before Workflow.
          expect(firstWhenIdx).toBeLessThan(skipWhenIdx);
        });

        it("references the empty-result envelope contract (closeMatches / recentRoutesSample / windowActivity / humanReadable / recoveryActions / diagnosticValue / recommendedNextStep / notAbsenceProof)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Workflow §4 — load-bearing recovery contract from MCP-025 /
          // MCP-027 / DISC-1626 / DISC-1652 codified in
          // `wire-mcp.ts` ToolDiagnosticSchema + CandidateDiagnosticSchema.
          // Without these the agent bails to source on empty results —
          // the failure mode the parent wave fixes. Wave 17 follow-up
          // (post-PR-998) added windowActivity, humanReadable,
          // diagnosticValue, and recommendedNextStep alongside the
          // original closeMatches / recentRoutesSample / recoveryActions
          // because each disambiguates a different reason for the empty
          // result.
          expect(info).toContain("`closeMatches`");
          expect(info).toContain("`recentRoutesSample`");
          expect(info).toContain("`windowActivity`");
          expect(info).toContain("`humanReadable`");
          expect(info).toContain("`recoveryActions`");
          expect(info).toContain("`diagnosticValue`");
          expect(info).toContain("`recommendedNextStep`");
          expect(info).toContain("`notAbsenceProof: true`");
        });

        it("describes windowActivity's four-way distinguisher (Wave 17 follow-up — DISC-1652 Amendment 1 / DISC-1654)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // windowActivity is the load-bearing distinguisher between
          // "wrong vocabulary", "no traffic in window", "captureConfig-
          // blocked", and "no traces ever for this tenant" — the fields
          // the agent reads to disambiguate are totalTracesInWindow,
          // totalTracesInTenantEver, and captureConfigBlocksRequest.
          // Pin all three so the rendered text retains the four-way
          // explanation if a future content edit shortens it by accident.
          expect(info).toContain("totalTracesInWindow");
          expect(info).toContain("totalTracesInTenantEver");
          expect(info).toContain("captureConfigBlocksRequest");
        });

        it("references the side-effect evidence allowlist (sideEffectSummary + all 7 allowlisted keys)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Workflow §3 — sideEffectSummary plus all seven allowlisted
          // keys. These keys live in the SDK `@glasstrace/protocol`
          // package (`packages/protocol/src/side-effect.ts`,
          // SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS: templateKey,
          // providerOperation, role, locale, timezone, status, phase) —
          // the SDK consumes the matching server-side vocabulary. These
          // are the ones that disambiguate payload bugs.
          expect(info).toContain("`sideEffectSummary`");
          expect(info).toContain("`templateKey`");
          expect(info).toContain("`providerOperation`");
          expect(info).toContain("`role`");
          expect(info).toContain("`locale`");
          expect(info).toContain("`timezone`");
          expect(info).toContain("`status`");
          expect(info).toContain("`phase`");
        });

        // Evidence-interpretation guidance: teach the agent to act on
        // returned trace evidence rather than skim past it, and to keep
        // using a trace when a follow-up tool comes back thin. Wording is
        // candidate-agnostic — the generic `*Holds` boolean-key pattern
        // and contract field/tool names only, never a specific domain
        // field or the validation candidate.
        it("frames side-effect evidence as first-class and `*Holds` keys as semantic booleans", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("first-class runtime evidence");
          expect(info).toContain("`Holds`");
          expect(info).toMatch(/true\/false claim/);
        });

        it("distinguishes `sideEffectEvidence` (presence on candidates) from `sideEffectSummary` (values on get_latest_error / get_trace / get_root_cause)", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("`sideEffectEvidence`");
          expect(info).toContain("`sideEffectSummary`");
          // The values come from all three carriers — naming get_latest_error
          // prevents the redundant-second-call behavior (an active-failure
          // agent enters via get_latest_error and already holds the values).
          expect(info).toContain("`get_latest_error`");
          // Presence follows the response row and never creates one budget per
          // candidate on a decisive/supporting page.
          expect(info).toContain(
            "Presence does not create a separate follow-up budget for each candidate",
          );
        });

        it("conditions candidate drill-down on the structured result and present evidence", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("After `find_trace_candidates`");
          expect(info).toContain(
            "distinguish the response-level `diagnosticValue`, `recommendedNextStep`, and `maxUsefulFollowups` rollup from each candidate row's `diagnosticValue`, `sideEffectEvidence`, and `suggestedFollowups`",
          );
          expect(info).toContain("Candidate array order is rank order");
          expect(info).toContain("Candidate rows can locate the right trace without including every decisive semantic field");
          expect(info).toContain("`suggestedFollowups`");
          expect(info).toContain("**Present application evidence**");
          expect(info).toContain("**Pure stop**");
          expect(info).toContain("inspect source first");
        });

        it("teaches that categorical fields identify the operation and its state", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toMatch(/identify which operation ran and what state/);
        });

        it("tells the agent to cross-check trace facts against source and direct verification", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toMatch(/[Cc]ross-check/);
          expect(info).toContain("direct verification");
          expect(info).toContain("runtime evidence for the failing path");
          expect(info).toContain("not a patch recipe");
        });

        it("explains that an empty `get_span_attributes` result does not invalidate side-effect evidence", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("`get_span_attributes`");
          expect(info).toMatch(/does NOT invalidate side-effect evidence/);
        });

        it("tells the agent to continue from trace evidence when `get_root_cause` is unavailable, without retrying or attaching recommendedNextStep", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain('`status: "unavailable"`');
          expect(info).toMatch(/rather than retrying the same call or discarding the trace/);
          // recommendedNextStep lives on the diagnostic/miss envelope (Workflow
          // §4), NOT on the unavailable get_root_cause payload — the §5 line must
          // not associate it with get_root_cause's unavailable response. Anchor
          // the slice on the §5 header and assert it exists first, so a renamed/
          // removed header fails loudly instead of making the guard pass on a
          // -1 slice.
          const followupsAnchor = info.indexOf("5. Follow-up tools");
          expect(
            followupsAnchor,
            "Workflow §5 'Follow-up tools' header must be present to anchor this guard",
          ).toBeGreaterThan(-1);
          const followups = sectionBetween(
            info,
            "5. Follow-up tools",
            "6. After a relevant trace is found",
          );
          expect(followups).not.toContain("recommendedNextStep");
        });

        it("requires a trace-evidence checkpoint before editing and bounds the source layer", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("After a relevant trace is found");
          expect(info).toContain("pause before editing");
          expect(info).toContain("the runtime fact");
          expect(info).toContain("the route/procedure/operation that produced it");
          expect(info).toContain("the likely source decision point");
          expect(info).toContain("the intended edit boundary");
          expect(info).toMatch(/smallest source path/);
          expect(info).toContain("owns the runtime decision");
          expect(info).toContain("Do not rewrite routing, batching, request transport, middleware, or sibling propagation");
          expect(info).toContain("unless the trace explicitly implicates that layer");
        });

        it("guides stale-state and categorical side-effect evidence without turning categories into patches", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("For stale, cross-request, or cross-batch state");
          expect(info).toContain("do not simply forward the observed request or batch value");
          expect(info).toContain("durable authoritative state source");
          expect(info).toContain("decision function that consumed stale state");
          expect(info).toContain("Treat categorical side-effect fields as branch/location evidence, not patch instructions");
        });

        it("compares multiple traces for stateful bugs", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toMatch(/[Ss]tateful bugs/);
          expect(info).toMatch(/compare the relevant traces in sequence/);
        });

        // DISC-1955: a sparse candidate (compact summaries absent) is not
        // absence of evidence; the compact CATEGORY projections are the
        // budget/top-rank-gated ones, distinct from per-candidate
        // sideEffectEvidence (which carries a status + notAbsenceProof).
        it("teaches that a candidate with absent compact summaries is still evidence", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // Assert the FULL closed set of four compact category projections,
          // so dropping/renaming any one is caught (the sentence's value is
          // naming the exact set the server emits).
          expect(info).toContain("`performanceQuerySummary`");
          expect(info).toContain("`dataShapeSummary`");
          expect(info).toContain("`raceConcurrencySummary`");
          expect(info).toContain("`contextBranchSummary`");
          expect(info).toMatch(/absence is normal, not absence of evidence/);
          // sideEffectEvidence status is per-candidate (not the gated projection set).
          expect(info).toMatch(/`missing` \/ `withheld` \/ `unsupported`/);
          expect(info).toContain("`notAbsenceProof`");
          // Preserve the taxonomy instead of turning unavailable evidence into
          // either absence or an unconditional trace-drill-down instruction.
          expect(info).toContain("Preserve that reported state");
          expect(info).toContain(
            "never rewrite missing, withheld, unsupported, or omitted evidence as affirmative absence",
          );
          expect(info).toContain("On a pure stop result, inspect source first");
          expect(info).not.toContain("In every case, pull the trace");
        });

        it("routes a plausible candidate without semantic evidence through the stop/continue result", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          expect(info).toContain("If a plausible candidate lacks semantic evidence");
          expect(info).toContain("follow the matching response-level row above");
          expect(info).toContain(
            "a decisive/supporting response uses the first candidate's bounded drill-down sequence",
          );
          expect(info).toContain(
            "weak and pure route-only responses with no candidate carrying present application evidence inspect source first",
          );
          expect(info).toContain(
            "an authentication-short-circuit response retries with an authenticated credential",
          );
          expect(info).toContain("Broaden or retry only when the response provides a valid route");
          expect(info).not.toContain("pull the trace if possible");
        });

        it("teaches retry-by-procedure (the `{ procedure }` param form) and route-vs-URL comparison for a sparse search", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // The param-object form (not just naming the `procedure` filter).
          expect(info).toMatch(/find_trace_candidates\(\{ procedure:/);
          expect(info).toMatch(/Changing the locator starts a fresh search without `cursor`/);
          expect(info).toMatch(/preserve the exact valid returned effective `start` \/ `end` bounds/);
          expect(info).toMatch(/not a locator retry or historical continuation/);
          expect(info).toMatch(/preferred over a vague route fragment/);
          expect(info).toMatch(/compare the candidate's `route` pattern against the URL/);
        });

        // Guard: the public, user-installed body must never leak the
        // validation-candidate specifics that motivated this guidance.
        it("does not leak candidate-specific terms into the installed body", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          for (const term of [
            "Rallly",
            "BetterAuth",
            "revalidateTag",
            "cache invalidation",
            "MFG-RLY",
            "same-batch",
            "pending-value",
            "author-profile",
            "validation harness",
            "benchmark",
            "Codex",
            "Claude",
          ]) {
            expect(info).not.toContain(term);
          }
        });

        it("uses the correct `suggestedFollowups` field name", () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          // R13 vocabulary correction: the actual server contract field
          // is `suggestedFollowups` (NOT `suggestedFollowupArgs`).
          expect(info).toContain("`suggestedFollowups`");
          expect(info).not.toContain("suggestedFollowupArgs");
        });

        it(`emits a parseable v=<sdkVersion> stamp on the ${target.markerKind} start marker`, () => {
          const info = generateInfoSection(
            makeAgent(target.name),
            ENDPOINT,
            SDK_VERSION,
          );
          if (target.markerKind === "html") {
            expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
            // The end marker remains unstamped (DISC-1592 Required
            // Semantics Item 1: "the marker end (...mcp:end) does not
            // need a stamp").
            expect(info).toContain("<!-- glasstrace:mcp:end -->");
          } else {
            expect(info).toContain(`# glasstrace:mcp:start v=${SDK_VERSION}`);
            expect(info).toContain("# glasstrace:mcp:end");
          }
        });
      });
    }

    // Validation prompt PRE-FLIGHT 4 stamps `v=1.0.0` to simulate
    // staleness. The stamp must round-trip through different version
    // shapes — including canary pre-release strings — so the snapshot
    // tests don't silently drift when the SDK ships a canary.
    it("accepts canary semver strings as the stamp value", () => {
      const canary = "0.0.0-canary-20260508120000";
      const info = generateInfoSection(makeAgent("claude"), ENDPOINT, canary);
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${canary} -->`);
    });

    it("rejects an empty sdkVersion", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, ""),
      ).toThrow(/sdkVersion must not be empty/);
    });

    it("rejects a whitespace-only sdkVersion", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "   "),
      ).toThrow(/sdkVersion must not be empty/);
    });

    // SDK-050 Required Semantics Item 1: the stamp must not embed
    // user-controlled or environment-derived content, and must reject
    // characters that could smuggle terminal escape sequences or break
    // out of the HTML comment / hash marker.
    it("rejects an sdkVersion containing whitespace", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0 evil"),
      ).toThrow(/sdkVersion must match/);
    });

    it("rejects an sdkVersion containing angle brackets", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0>extra"),
      ).toThrow(/sdkVersion must match/);
    });

    it("rejects an sdkVersion containing a newline", () => {
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0\ninjected"),
      ).toThrow(/sdkVersion must match/);
    });

    it("rejects an sdkVersion containing a control character", () => {
      // ESC (0x1B) is the leading byte of every ANSI terminal escape
      // sequence; the stamp must never carry one to the user's tty.
      expect(() =>
        generateInfoSection(makeAgent("claude"), ENDPOINT, "1.4.0[31m"),
      ).toThrow(/sdkVersion must match/);
    });
  });

  describe("Cursor direct render helpers", () => {
    it("renders the trace-evidence edit-boundary guidance into Cursor .mdc output", () => {
      const info = generateInfoSectionForCursorMdc(ENDPOINT, SDK_VERSION);
      expectSafeDiscoveryWindowGuidance(info);
      expect(info).toContain("alwaysApply: true");
      expect(info).toContain(`<!-- glasstrace:mcp:start v=${SDK_VERSION} -->`);
      expect(info).toContain("After `find_trace_candidates`");
      expect(info).toContain("Candidate rows can locate the right trace without including every decisive semantic field");
      expect(info).toContain("pause before editing");
      expect(info).toContain("the intended edit boundary");
      expect(info).toContain("not a patch recipe");
      expect(info).toContain("do not simply forward the observed request or batch value");
      expect(info).toContain("Do not rewrite routing, batching, request transport, middleware, or sibling propagation");
    });

    it("renders the trace-evidence edit-boundary guidance into legacy .cursorrules output", () => {
      const info = generateInfoSectionForCursorrulesLegacy(ENDPOINT, SDK_VERSION);
      expectSafeDiscoveryWindowGuidance(info);
      expect(info).toContain(`# glasstrace:mcp:start v=${SDK_VERSION}`);
      expect(info).toContain("After `find_trace_candidates`");
      expect(info).toContain("Candidate rows can locate the right trace without including every decisive semantic field");
      expect(info).toContain("pause before editing");
      expect(info).toContain("the intended edit boundary");
      expect(info).toContain("not a patch recipe");
      expect(info).toContain("do not simply forward the observed request or batch value");
      expect(info).toContain("Do not rewrite routing, batching, request transport, middleware, or sibling propagation");
    });
  });
});
