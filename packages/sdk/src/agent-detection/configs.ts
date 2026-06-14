import type { DetectedAgent } from "./detect.js";
import { buildAgentInstructionBody } from "./agent-instruction-text.js";

/**
 * Generates the MCP server configuration content for a given agent.
 *
 * The output is the full file content suitable for writing to the agent's
 * MCP config file. The bearer token is intentionally embedded here for
 * agents whose schemas inline the Authorization header — Codex is the
 * exception and uses `bearer_token_env_var` so the actual token never
 * appears in TOML.
 *
 * @param agent - The detected agent to generate config for.
 * @param endpoint - The Glasstrace MCP endpoint URL.
 * @param bearer - The credential to embed in the Authorization header
 *   (anon key or dev key, depending on the project's resolved
 *   credential source). Empty values throw.
 * @returns The formatted configuration string.
 * @throws If endpoint or bearer is empty.
 */
export function generateMcpConfig(
  agent: DetectedAgent,
  endpoint: string,
  bearer: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!bearer || bearer.trim() === "") {
    throw new Error("bearer must not be empty");
  }

  switch (agent.name) {
    case "claude":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "codex": {
      // Escape TOML basic string special characters in the endpoint value.
      // TOML requires backslashes, quotes, and control characters to be escaped.
      const safeEndpoint = endpoint
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return [
        "[mcp_servers.glasstrace]",
        `url = "${safeEndpoint}"`,
        `bearer_token_env_var = "GLASSTRACE_API_KEY"`,
        "",
      ].join("\n");
    }

    case "gemini":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              httpUrl: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "windsurf":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    case "generic":
      return JSON.stringify(
        {
          mcpServers: {
            glasstrace: {
              type: "http",
              url: endpoint,
              headers: {
                Authorization: `Bearer ${bearer}`,
              },
            },
          },
        },
        null,
        2,
      );

    default: {
      const _exhaustive: never = agent.name;
      throw new Error(`Unknown agent: ${_exhaustive}`);
    }
  }
}

/**
 * Strict pattern accepted as the value substituted into a `v=<sdkVersion>`
 * marker stamp. Covers the SDK's own published versions
 * (e.g. `1.4.0`, `0.0.0-canary-20260508120000`, `1.4.0+build.42`) without
 * admitting whitespace, angle-brackets, or terminal control sequences
 * that could be smuggled into the agent instruction file via a
 * malformed callsite.
 *
 * The stamp is the SDK semver string and nothing else: it encodes only
 * the SDK semver string and must not embed user-controlled or
 * environment-derived content. Reject anything outside this charset at the render site
 * rather than relying on the upstream `__SDK_VERSION__` define being
 * well-formed.
 */
const SDK_VERSION_STAMP_PATTERN = /^[A-Za-z0-9.+-]+$/;

/**
 * Marker pair used to delimit the Glasstrace section in agent info files.
 */
interface MarkerPair {
  start: string;
  end: string;
}

function htmlMarkers(sdkVersion: string): MarkerPair {
  return {
    start: `<!-- glasstrace:mcp:start v=${sdkVersion} -->`,
    end: "<!-- glasstrace:mcp:end -->",
  };
}

function hashMarkers(sdkVersion: string): MarkerPair {
  return {
    start: `# glasstrace:mcp:start v=${sdkVersion}`,
    end: "# glasstrace:mcp:end",
  };
}

/**
 * Generates informational content for an agent's instruction file.
 *
 * This content is designed to be appended to or inserted into agent-specific
 * instruction files. Wave 18 expanded the canonical set to follow the
 * 2026 cross-tool standard governed by the Agentic AI Foundation under
 * the Linux Foundation: `AGENTS.md` is the universal write target,
 * with per-agent canonical files written alongside it where the agent
 * has a documented primary file (Claude Code → CLAUDE.md, Gemini CLI
 * → GEMINI.md, Cursor → `.cursor/rules/glasstrace.mdc` canonical +
 * `.cursorrules` transitional fallback). Codex / Windsurf / generic
 * resolve to AGENTS.md alone (Codex retired `codex.md`; Windsurf
 * supports both AGENTS.md and `.windsurf/rules/glasstrace.md`). The
 * managed section's content is identical across destinations — only
 * the marker shape differs (HTML comments for Markdown / `.md` /
 * `.mdc` targets; `.cursorrules` legacy uses hash-prefix markers
 * preserved from the original contract for backward-compat with
 * already-rendered managed sections). It contains a
 * tight, agent-facing decision policy + workflow + tool list — no
 * endpoint URL, no auth tokens, no setup instructions (those live in
 * the user's MCP config and the SDK README; the agent reads this file
 * to decide WHEN to call Glasstrace MCP and HOW to use the returned
 * evidence).
 *
 * The rendered block opens with explicit "Call Glasstrace FIRST when"
 * / "SKIP Glasstrace when" decision rules so a frontier agent has a
 * cheap pre-tool-call heuristic it can apply BEFORE spending tokens
 * on tool consideration. The Workflow section names
 * `find_trace_candidates` as the discovery entry point and instructs
 * the agent to READ `closeMatches` / `recentRoutesSample` /
 * `recoveryActions` before pivoting to source — that is the
 * load-bearing recovery contract (codified in the server-side MCP
 * contract as `ToolDiagnosticSchema` / `CandidateDiagnosticSchema`)
 * and it prevents the bail-to-source failure mode that the prior
 * cost-aware decision paragraph did not surface.
 *
 * The body itself lives in a sibling module
 * (`agent-instruction-text.ts`) so future content evolutions are a
 * single-file edit and don't disturb the marker / version-stamp /
 * per-agent-format machinery in this file.
 *
 * The start marker carries a `v=<sdkVersion>` stamp
 * so a later `glasstrace upgrade-instructions` run — and
 * the SDK's stale-section warning at init — can detect that the
 * file was rendered by an older SDK and refresh the block.
 *
 * @param agent - The detected agent to generate info for.
 * @param endpoint - The Glasstrace MCP endpoint URL. (Validated for
 *   non-emptiness here for backwards compatibility with the prior
 *   contract; not currently inlined in the body — agents
 *   reach Glasstrace via the MCP server name `glasstrace` configured
 *   separately in `.glasstrace/mcp.json` or per-agent native config.)
 * @param sdkVersion - The SDK semver string to embed in the start marker
 *   (e.g. `1.4.0`, `0.0.0-canary-20260508120000`). Must match
 *   `[A-Za-z0-9.+\-]+`; arbitrary or empty values throw.
 * @returns The formatted info section string, or empty string for agents without a supported info file format.
 * @throws If endpoint is empty, or if sdkVersion is empty or contains
 *   characters outside the accepted stamp charset.
 */
export function generateInfoSection(
  agent: DetectedAgent,
  endpoint: string,
  sdkVersion: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!sdkVersion || sdkVersion.trim() === "") {
    throw new Error("sdkVersion must not be empty");
  }
  if (!SDK_VERSION_STAMP_PATTERN.test(sdkVersion)) {
    throw new Error(
      "sdkVersion must match [A-Za-z0-9.+\\-]+ (semver-shaped, no whitespace, no angle brackets)",
    );
  }

  const content = buildAgentInstructionBody();

  switch (agent.name) {
    case "claude":
    case "codex":
    case "gemini":
    case "windsurf":
    case "generic": {
      // All Markdown-family targets (CLAUDE.md, AGENTS.md, GEMINI.md,
      // .windsurf/rules/glasstrace.md) use the HTML comment marker
      // shape that has soaked in production via SDK-050 / DISC-1592 /
      // DISC-1602 since Wave 17 main / `@glasstrace/sdk@1.10.x`.
      const m = htmlMarkers(sdkVersion);
      return `${m.start}\n${content}${m.end}\n`;
    }

    case "cursor": {
      // Wave 18 routes Cursor to the canonical `.cursor/rules/
      // glasstrace.mdc` destination. `.mdc` is Markdown body + YAML
      // frontmatter delimited by `---` lines; the SDK's marker
      // contract carries through unchanged via HTML comments. The
      // legacy `.cursorrules` write (still produced by the
      // multi-target write helper as a transitional fallback) is
      // rendered via {@link generateInfoSectionForCursorrulesLegacy}
      // using hash-prefix markers preserved from SDK-050 for
      // backward-compat with already-rendered managed sections.
      const m = htmlMarkers(sdkVersion);
      return `${m.start}\n${content}${m.end}\n`;
    }

    default: {
      const _exhaustive: never = agent.name;
      throw new Error(`Unknown agent: ${_exhaustive}`);
    }
  }
}

/**
 * Renders the managed section for Cursor's legacy `.cursorrules` file
 * (transitional fallback companion to the canonical
 * `.cursor/rules/glasstrace.mdc` write).
 *
 * Uses hash-prefix markers preserved from the original contract —
 * earlier SDK versions rendered `.cursorrules` with hash markers, so
 * the legacy file's already-rendered managed sections need to be
 * recognized and idempotently replaced by the new SDK. Switching to
 * HTML markers on `.cursorrules` would break in-place replacement for
 * existing users (the new SDK wouldn't find the old marker pair) and
 * append a duplicate section.
 *
 * The SDK writes `.cursorrules` UNCONDITIONALLY alongside the
 * `.cursor/rules/glasstrace.mdc` canonical — mixed-version Cursor
 * scenarios may have Agent mode
 * reading legacy rules inconsistently across versions, so a
 * conditional fallback is too narrow).
 */
export function generateInfoSectionForCursorrulesLegacy(
  endpoint: string,
  sdkVersion: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!sdkVersion || sdkVersion.trim() === "") {
    throw new Error("sdkVersion must not be empty");
  }
  if (!SDK_VERSION_STAMP_PATTERN.test(sdkVersion)) {
    throw new Error(
      "sdkVersion must match [A-Za-z0-9.+\\-]+ (semver-shaped, no whitespace, no angle brackets)",
    );
  }

  const content = buildAgentInstructionBody();
  const m = hashMarkers(sdkVersion);
  return `${m.start}\n${content}${m.end}\n`;
}

/**
 * Renders the managed section for Cursor's `.cursor/rules/
 * glasstrace.mdc` canonical destination.
 *
 * `.mdc` is Cursor's Markdown-extension format with YAML frontmatter
 * delimited by `---` lines (per cursor.com/docs/rules — frontmatter
 * supports `alwaysApply`, `globs`, `description`). The Glasstrace
 * managed section uses `alwaysApply: true` because it's a global
 * agent instruction the user's coding agent should consult on every
 * debugging task. The SDK's idempotent-replacement logic anchors on
 * the markers and does NOT touch the frontmatter — user
 * customizations to the frontmatter survive `upgrade-instructions`.
 *
 * Recon caveat (Wave 18 impl-time, 2026-05-10): Cursor's official
 * docs do not address whether `.mdc` parser preserves HTML comments.
 * This implementation defaults to HTML comment markers (consistent
 * with the marker contract for `CLAUDE.md` and other Markdown
 * targets which have soaked in production). If a Cursor version
 * strips HTML comments from `.mdc` body content, the marker contract
 * breaks; track via the wave's closeout-gate items.
 */
export function generateInfoSectionForCursorMdc(
  endpoint: string,
  sdkVersion: string,
): string {
  if (!endpoint || endpoint.trim() === "") {
    throw new Error("endpoint must not be empty");
  }
  if (!sdkVersion || sdkVersion.trim() === "") {
    throw new Error("sdkVersion must not be empty");
  }
  if (!SDK_VERSION_STAMP_PATTERN.test(sdkVersion)) {
    throw new Error(
      "sdkVersion must match [A-Za-z0-9.+\\-]+ (semver-shaped, no whitespace, no angle brackets)",
    );
  }

  const content = buildAgentInstructionBody();
  const m = htmlMarkers(sdkVersion);
  // YAML frontmatter goes ABOVE the managed section. The marker
  // contract anchors on the `<!-- glasstrace:mcp:start -->` ...
  // `<!-- glasstrace:mcp:end -->` markers; the frontmatter sits above
  // the section and is preserved across re-renders.
  return [
    "---",
    "description: Glasstrace MCP runtime debugging tools — runtime evidence the agent reads when source alone cannot resolve a bug",
    "alwaysApply: true",
    "---",
    "",
    `${m.start}\n${content}${m.end}\n`,
  ].join("\n");
}
