/**
 * Public-surface guard for references that belong only in private planning.
 *
 * The published README for each workspace and every emitted TypeScript
 * declaration are scanned for two reference classes:
 *
 *   1. internal tracking identifiers such as `SDK-49` or `DISC-1257`;
 *   2. filesystem or private Git references that expose the sibling
 *      `glasstrace-product` repository name.
 *
 * The bare repository name and ordinary public documentation URLs remain
 * allowed. The path check is intentionally lexical: the source text that
 * ships to a consumer must contain a recognizable private path or Git remote.
 * It does not implement a Markdown or HTML renderer.
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";
import process from "node:process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Keep this set explicit so public standards such as SHA-256, UTF-8, and
// ISO-8601 do not become false positives.
const INTERNAL_ID_PREFIXES = [
  "ACCT",
  "DISC",
  "ING",
  "MCP",
  "SCHEMA",
  "SDK",
  "TEST",
  "VAL",
  "WAVE",
];

const INTERNAL_ID_PATTERN = new RegExp(
  String.raw`(?:${INTERNAL_ID_PREFIXES.join("|")})-\d+`,
  "gu",
);
const PRIVATE_PRODUCT_NAME_PATTERN = /glasstrace-product/giu;
const HTTPS_URL_PATTERN = /https?:\/\//iuy;
const SSH_URL_PATTERN = /ssh:\/\//iuy;
const SCP_REFERENCE_PATTERN = /[^\p{Cc}\s:/]+@/uy;
const SCP_REFERENCE_SCAN_PATTERN = /[^\p{Cc}\s:/]+/gu;
const FILE_REFERENCE_PATTERN = /file:/iuy;
const VALID_SCP_START_PATTERN =
  /([^\p{Cc}\s:/]+)@(\[[^\]\s]+\]|[^:@/\\\s<>"'`]+):(?=[^\s<>"'`|()[\]{}?#,;])/uy;
const URL_AUTHORITY_MARKER_SCAN_PATTERN = /:\/\//gu;
const REFERENCE_TERMINATOR_PATTERN = /[\s<>"'`]/u;
const REFERENCE_PREFIX_AT_BOUNDARY_PATTERN =
  /(?:https?:\/\/|ssh:\/\/|git@|file:)/iuy;
const EXPLICIT_LOCAL_PATH_AT_BOUNDARY_PATTERN =
  /(?:\.{1,2}[\\/]|~(?:[^\\/\s,;]+)?[\\/]|file:|[\\/]|[A-Za-z]:)/iuy;
const PRODUCT_REPOSITORY_SEGMENTS = new Set([
  "glasstrace-product",
  "glasstrace-product.git",
]);
const KNOWN_GIT_HOST_PROFILES = new Map([
  ["api.bitbucket.org", "bitbucket-api"],
  ["api.github.com", "github-api"],
  ["bitbucket.org", "one-owner"],
  ["code.forgejo.org", "one-owner"],
  ["codeberg.org", "one-owner"],
  ["codeload.github.com", "one-owner"],
  ["dev.azure.com", "azure"],
  ["gitea.com", "one-owner"],
  ["github.com", "one-owner"],
  ["gitlab.com", "gitlab"],
  ["media.githubusercontent.com", "github-media"],
  ["raw.github.com", "one-owner"],
  ["raw.githubusercontent.com", "one-owner"],
]);
const SELF_HOSTED_GIT_SERVICE_PROFILES = new Map([
  ["bitbucket", "bitbucket-server"],
  ["forgejo", "one-owner"],
  ["git", "generic"],
  ["gitea", "one-owner"],
  ["github", "one-owner"],
  ["gitlab", "gitlab"],
]);
const PUBLIC_GIT_ROUTE_ROOTS = new Map([
  ["bitbucket.org", new Set(["product"])],
  ["code.forgejo.org", new Set(["explore"])],
  ["codeberg.org", new Set(["explore"])],
  ["gitea.com", new Set(["explore"])],
  [
    "github.com",
    new Set([
      "apps",
      "collections",
      "explore",
      "marketplace",
      "organizations",
      "orgs",
      "sponsors",
      "topics",
    ]),
  ],
  ["gitlab.com", new Set(["explore", "groups"])],
]);
const SELF_HOSTED_PUBLIC_ROUTE_ROOTS = new Map([
  ["bitbucket", PUBLIC_GIT_ROUTE_ROOTS.get("bitbucket.org")],
  ["forgejo", new Set(["explore"])],
  ["gitea", new Set(["explore"])],
  ["github", PUBLIC_GIT_ROUTE_ROOTS.get("github.com")],
  ["gitlab", PUBLIC_GIT_ROUTE_ROOTS.get("gitlab.com")],
]);
const GITEA_RESOURCE_ROUTE_ROOTS = new Set([
  "_delete",
  "_edit",
  "_new",
  "_upload",
  "actions",
  "activity",
  "archive",
  "branches",
  "blame",
  "blob",
  "commit",
  "commits",
  "compare",
  "forks",
  "find",
  "graph",
  "issues",
  "info",
  "git-receive-pack",
  "git-upload-pack",
  "media",
  "milestones",
  "projects",
  "pulls",
  "raw",
  "releases",
  "rss",
  "search",
  "settings",
  "src",
  "stars",
  "tags",
  "tree",
  "watchers",
  "wiki",
]);
const SMART_HTTP_SERVICES = new Set([
  "git-receive-pack",
  "git-upload-pack",
]);
const IDENTIFIER_CONTINUATION_PATTERN = /[\p{L}\p{N}\p{M}\p{Pc}]/u;
const SCP_USERNAME_CONTINUATION_PATTERN = /[^\p{Cc}\s:/]/u;
const URL_START_CONTINUATION_PATTERN = /[\p{L}\p{N}]/u;
const PATH_SEGMENT_CONTINUATION_PATTERN =
  /[\p{L}\p{N}\p{M}\p{Pc}@.+%$~-]/u;
const TRAILING_REFERENCE_PUNCTUATION_PATTERN = /[\p{Pe}\p{Pf}\p{Pi}\p{Pd}\p{Po}]/u;
const NON_IDENTIFIER_REFERENCE_SEPARATOR_PATTERN =
  /[^\p{L}\p{N}\p{M}\p{Pc}]/u;
const CONTROL_REFERENCE_SEPARATOR_PATTERN = /\p{Cc}/u;
const HARD_INVALID_REFERENCE_SEPARATOR_PATTERN = /[\p{Cc}\p{Cn}\p{Co}\p{Cs}]/u;
const REFERENCE_BOUNDARY_MARK_PATTERN = /\p{M}/u;
const REFERENCE_BOUNDARY_CONTENT_PATTERN =
  /[/\p{L}\p{N}\p{Pc}.\\~$%!]/u;
const KEYCAP_BASE_PATTERN = /[0-9#*]/u;
const KEYCAP_MARK = "\u20e3";
const REFERENCE_OPENING_WRAPPER_PATTERN = /[\p{Pi}\p{Ps}]/u;
const REFERENCE_DELIMITER_PAIRS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);
const REFERENCE_CLOSING_TO_OPENING = new Map(
  [...REFERENCE_DELIMITER_PAIRS].map(([opening, closing]) => [
    closing,
    opening,
  ]),
);
const URL_WRAPPER_CLOSINGS = new Map([
  ...REFERENCE_DELIMITER_PAIRS,
  ["<", ">"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
]);
const CLOSING_REFERENCE_DELIMITERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);
const IDENTIFIER_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: true,
});

function codePointBefore(value, index) {
  if (index <= 0) return undefined;
  const trailingUnit = value.charCodeAt(index - 1);
  if (trailingUnit >= 0xdc00 && trailingUnit <= 0xdfff && index >= 2) {
    const leadingUnit = value.charCodeAt(index - 2);
    if (leadingUnit >= 0xd800 && leadingUnit <= 0xdbff) {
      return value.slice(index - 2, index);
    }
  }
  return value[index - 1];
}

function codePointAt(value, index) {
  const point = value.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function precedingBoundaryRoot(value, index) {
  let cursor = index;
  while (cursor > 0) {
    const character = codePointBefore(value, cursor);
    if (!REFERENCE_BOUNDARY_MARK_PATTERN.test(character)) break;
    cursor -= character.length;
  }

  if (cursor === 0) {
    return { character: undefined, isKeycap: false };
  }
  const character = codePointBefore(value, cursor);
  const rootStart = cursor - character.length;
  const keycapEnd = keycapSequenceEndAt(value, rootStart);
  return {
    character,
    isKeycap: keycapEnd !== undefined && keycapEnd <= index,
  };
}

function hasBoundaryBefore(value, index, continuationPattern) {
  const root = precedingBoundaryRoot(value, index);
  return (
    root.character === undefined ||
    root.isKeycap ||
    !continuationPattern.test(root.character)
  );
}

function keycapSequenceEndAt(value, index) {
  const base = codePointAt(value, index);
  if (base === undefined || !KEYCAP_BASE_PATTERN.test(base)) return undefined;
  let cursor = index + base.length;
  const variation = codePointAt(value, cursor);
  if (variation === "\ufe0e" || variation === "\ufe0f") {
    cursor += variation.length;
  }
  return codePointAt(value, cursor) === KEYCAP_MARK
    ? cursor + KEYCAP_MARK.length
    : undefined;
}

function keycapMarksEndAt(value, index) {
  let cursor = index;
  const variation = codePointAt(value, cursor);
  if (variation === "\ufe0e" || variation === "\ufe0f") {
    cursor += variation.length;
  }
  return codePointAt(value, cursor) === KEYCAP_MARK
    ? cursor + KEYCAP_MARK.length
    : undefined;
}

function hasIdentifierBoundaryAfter(value, index) {
  if (keycapMarksEndAt(value, index) !== undefined) return true;
  const character = codePointAt(value, index);
  return (
    character === undefined ||
    !IDENTIFIER_CONTINUATION_PATTERN.test(character)
  );
}

function decodeIdentifierPercentEscapes(value) {
  const chunks = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (
      value[cursor] !== "%" ||
      !/^[0-9A-F]{2}$/iu.test(value.slice(cursor + 1, cursor + 3))
    ) {
      chunks.push(codePointAt(value, cursor));
      cursor += codePointAt(value, cursor).length;
      continue;
    }

    let end = cursor;
    while (
      value[end] === "%" &&
      /^[0-9A-F]{2}$/iu.test(value.slice(end + 1, end + 3))
    ) {
      end += 3;
    }
    const encoded = value.slice(cursor, end);
    const bytes = new Uint8Array(encoded.length / 3);
    for (let index = 0; index < encoded.length; index += 3) {
      bytes[index / 3] = Number.parseInt(encoded.slice(index + 1, index + 3), 16);
    }
    chunks.push(IDENTIFIER_UTF8_DECODER.decode(bytes));
    cursor = end;
  }
  return chunks.join("");
}

function collectMatchedClosingReferenceDelimiters(value) {
  const depths = new Map(
    [...REFERENCE_DELIMITER_PAIRS.keys()].map((opening) => [opening, 0]),
  );
  const matchedClosings = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (depths.has(character)) {
      depths.set(character, depths.get(character) + 1);
      continue;
    }

    const opening = CLOSING_REFERENCE_DELIMITERS.get(character);
    if (opening === undefined || depths.get(opening) === 0) continue;
    depths.set(opening, depths.get(opening) - 1);
    matchedClosings.add(index);
  }
  return matchedClosings;
}

function trimTrailingReferencePunctuation(value) {
  const matchedClosings = collectMatchedClosingReferenceDelimiters(value);
  let end = value.length;
  while (end > 0) {
    const character = codePointBefore(value, end);
    if (
      character === undefined ||
      character === "-" ||
      !TRAILING_REFERENCE_PUNCTUATION_PATTERN.test(character)
    ) {
      break;
    }

    const opening = CLOSING_REFERENCE_DELIMITERS.get(character);
    if (
      opening !== undefined &&
      matchedClosings.has(end - character.length)
    ) {
      break;
    }
    end -= character.length;
  }
  return value.slice(0, end);
}

function trimReferenceRange(line, range) {
  const match = trimTrailingReferencePunctuation(
    line.slice(range.start, range.end),
  );
  return { ...range, end: range.start + match.length, match };
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

function repositoryPathSegments(pathname) {
  return pathname
    .split("/")
    .flatMap((segment) => decodePathSegment(segment).split(/[\\/]/))
    .filter(Boolean);
}

// Treat an extensionless HTTPS URL as a Git remote only when the URL itself
// signals a Git service; arbitrary hosts remain valid public documentation.
function recognizableSelfHostedGitService(parsed, hostname) {
  const [serviceLabel] = hostname.split(".");
  if (SELF_HOSTED_GIT_SERVICE_PROFILES.has(serviceLabel)) return serviceLabel;
  return decodePathSegment(parsed.username) === "git" ? "git" : undefined;
}

function gitHostProfile(parsed, hostname, segments) {
  const knownProfile = KNOWN_GIT_HOST_PROFILES.get(hostname);
  if (knownProfile !== undefined) {
    return { profile: knownProfile, service: undefined };
  }
  if (hostname.endsWith(".visualstudio.com")) {
    return { profile: "azure", service: undefined };
  }

  const service = recognizableSelfHostedGitService(parsed, hostname);
  const serviceProfile = SELF_HOSTED_GIT_SERVICE_PROFILES.get(service);
  if (serviceProfile !== undefined && serviceProfile !== "generic") {
    return { profile: serviceProfile, service };
  }
  const azureMarkerIndex = segments.indexOf("_git");
  const existingResourceIndex = repositoryResourceIndex(segments);
  if (
    azureMarkerIndex !== -1 &&
    (existingResourceIndex === -1 || azureMarkerIndex < existingResourceIndex)
  ) {
    return { profile: "azure", service };
  }
  return { profile: serviceProfile ?? "unknown", service };
}

function bitbucketServerRepositoryIndex(segments) {
  const scmIndex = segments.indexOf("scm");
  if (scmIndex !== -1 && segments[scmIndex + 2] !== undefined) {
    return scmIndex + 2;
  }
  const repositoriesIndex = segments.findIndex(
    (segment, index) =>
      segment === "repos" &&
      ["projects", "users"].includes(segments[index - 2]),
  );
  return repositoriesIndex === -1 ? -1 : repositoriesIndex + 1;
}

function repositorySegmentForProfile(profile, segments) {
  if (profile === "azure") {
    const markerIndex = segments.indexOf("_git");
    return markerIndex === -1 ? undefined : segments[markerIndex + 1];
  }
  if (profile === "gitlab") {
    const resourceIndex = segments.indexOf("-");
    const repositoryIndex =
      (resourceIndex === -1 ? segments.length : resourceIndex) - 1;
    return repositoryIndex >= 1 ? segments[repositoryIndex] : undefined;
  }
  if (profile === "one-owner") {
    return segments[1];
  }
  if (profile === "github-media") {
    return segments[0] === "media" ? segments[2] : undefined;
  }
  if (profile === "bitbucket-server") {
    const repositoryIndex = bitbucketServerRepositoryIndex(segments);
    return repositoryIndex === -1
      ? segments.at(-1)
      : segments[repositoryIndex];
  }
  if (profile === "generic") {
    return segments.at(-1);
  }
  return undefined;
}

function rawPathSegments(pathname) {
  return pathname
    .split("/")
    .map(decodePathSegment)
    .filter(Boolean);
}

function transportResourceIndex(segments, family) {
  if (family === "gitea") {
    return repositoryResourceIndex(segments, "gitea");
  }
  return segments.findIndex((segment, index) => {
    if (index < 2) return false;
    if (segment === "-") {
      return ["anchored", "generic", "gitlab"].includes(family);
    }
    if (
      ["anchored", "generic", "gitea"].includes(family) &&
      ["blame", "find", "media", "raw", "src"].includes(segment) &&
      ["branch", "commit", "tag"].includes(segments[index + 1])
    ) {
      return true;
    }
    return (
      ["anchored", "generic", "github"].includes(family) &&
      ["blob", "tree"].includes(segment) &&
      segments[index + 1] !== undefined
    );
  });
}

function repositoryResourceIndex(segments, family = "generic") {
  return segments.findIndex((segment, index) => {
    if (index < 2) return false;
    if (segment === "-") return family !== "gitea";
    if (
      ["blame", "find", "media", "raw", "src"].includes(segment) &&
      ["branch", "commit", "tag"].includes(segments[index + 1])
    ) {
      return true;
    }
    if (["blob", "tree"].includes(segment)) {
      return family !== "gitea" && segments[index + 1] !== undefined;
    }
    if (["_delete", "_edit", "_new", "_upload", "rss"].includes(segment)) {
      return true;
    }
    if (segment === "actions") {
      return ["artifacts", "runs", "secrets", "variables", "workflows"].includes(
        segments[index + 1],
      );
    }
    if (["archive", "commit", "commits", "compare", "graph", "wiki"].includes(segment)) {
      return segments[index + 1] !== undefined;
    }
    if (
      [
        ...(family === "gitea" ? [] : ["discussions", "pull"]),
        "issues",
        "milestones",
        "projects",
        "pulls",
      ].includes(segment)
    ) {
      return (
        segments[index + 1] === undefined ||
        /^\d+$/u.test(segments[index + 1])
      );
    }
    if (segment === "releases") {
      return (
        segments[index + 1] === undefined ||
        ["attachments", "download", "tag"].includes(segments[index + 1])
      );
    }
    if (
      ["activity", "branches", "forks", "search", "stars", "tags", "watchers"].includes(
        segment,
      )
    ) {
      return segments[index + 1] === undefined;
    }
    return false;
  });
}

function apiRepositoryTarget(profile, service, hostname, parsed, segments) {
  if (profile === "github-api") {
    return segments[0] === "repos"
      ? { repository: segments[2] }
      : undefined;
  }
  if (profile === "bitbucket-api") {
    return /^\d+(?:\.\d+)*$/u.test(segments[0] ?? "") &&
      segments[1] === "repositories"
      ? { repository: segments[3] }
      : undefined;
  }
  if (profile === "azure") {
    const markerIndex = segments.findIndex(
      (segment, index) =>
        segment === "_apis" &&
        segments[index + 1] === "git" &&
        segments[index + 2] === "repositories",
    );
    if (markerIndex !== -1 && !segments.slice(0, markerIndex).includes("_git")) {
      return { repository: segments[markerIndex + 3] };
    }
  }

  const isGiteaFamily =
    hostname === "code.forgejo.org" ||
    hostname === "codeberg.org" ||
    hostname === "gitea.com" ||
    service === "forgejo" ||
    service === "gitea";
  const apiResourceBoundary =
    profile === "generic"
      ? repositoryResourceIndex(segments)
      : transportResourceIndex(
          segments,
          isGiteaFamily
            ? "gitea"
            : service === "github"
              ? "github"
              : "generic",
        );
  if (isGiteaFamily || service === "github" || profile === "generic") {
    const markerIndex = segments.findIndex(
      (segment, index) =>
        segment === "api" &&
        /^v\d+$/u.test(segments[index + 1] ?? "") &&
        segments[index + 2] === "repos",
    );
    if (
      markerIndex !== -1 &&
      (service !== "github" || markerIndex === 0) &&
      (apiResourceBoundary === -1 || markerIndex < apiResourceBoundary)
    ) {
      return { repository: segments[markerIndex + 4] };
    }
  }

  if (["generic", "gitlab", "unknown"].includes(profile)) {
    const pathSegments = rawPathSegments(parsed.pathname);
    const markerIndex = pathSegments.findIndex(
      (segment, index) =>
        segment === "api" &&
        /^v\d+$/u.test(pathSegments[index + 1] ?? "") &&
        pathSegments[index + 2] === "projects",
    );
    const resourceBoundary =
      profile === "gitlab"
        ? transportResourceIndex(pathSegments, "gitlab")
        : repositoryResourceIndex(pathSegments);
    if (
      markerIndex !== -1 &&
      (resourceBoundary === -1 || markerIndex < resourceBoundary)
    ) {
      return {
        repository: pathSegments[markerIndex + 3]
          ?.split(/[\\/]/)
          .filter(Boolean)
          .at(-1),
      };
    }
  }

  return undefined;
}

function smartHttpRepositoryTarget(parsed, segments) {
  const service = parsed.searchParams.get("service")?.toLowerCase();
  if (
    segments.at(-2) === "info" &&
    segments.at(-1) === "refs" &&
    SMART_HTTP_SERVICES.has(service)
  ) {
    return { index: segments.length - 3, repository: segments.at(-3) };
  }
  if (SMART_HTTP_SERVICES.has(segments.at(-1))) {
    return { index: segments.length - 2, repository: segments.at(-2) };
  }
  return undefined;
}

function isSmartHttpRepositoryTarget(profile, service, segments, target) {
  const resourceIndex =
    profile === "generic"
      ? repositoryResourceIndex(segments)
      : transportResourceIndex(
          segments,
          profile === "gitlab"
            ? "gitlab"
            : service === "forgejo" || service === "gitea"
              ? "gitea"
              : service === "github"
                ? "github"
                : "generic",
        );
  if (resourceIndex !== -1 && resourceIndex < target.index) return false;

  if (profile === "azure") {
    return target.index === segments.indexOf("_git") + 1;
  }
  if (profile === "github-media") {
    return segments[0] === "media" && target.index === 2;
  }
  if (profile === "bitbucket-server") {
    const repositoryIndex = bitbucketServerRepositoryIndex(segments);
    return target.index === repositoryIndex;
  }
  if (profile === "generic") {
    const repositoryIndex = bitbucketServerRepositoryIndex(segments);
    const existingResourceIndex = repositoryResourceIndex(segments);
    if (
      repositoryIndex !== -1 &&
      (existingResourceIndex === -1 || repositoryIndex < existingResourceIndex)
    ) {
      return target.index === repositoryIndex;
    }
  }
  if (
    profile === "one-owner" &&
    service !== "forgejo" &&
    service !== "gitea"
  ) {
    return target.index === 1;
  }
  if (profile === "gitlab") {
    const gitlabResourceIndex = segments.indexOf("-");
    return gitlabResourceIndex === -1 || gitlabResourceIndex > target.index;
  }
  return true;
}

function isPrivateGiteaRepositoryPath(segments) {
  if (segments.length <= 2) {
    return PRODUCT_REPOSITORY_SEGMENTS.has(segments[1]);
  }

  const transportBoundary = transportResourceIndex(segments, "gitea");
  if (transportBoundary !== -1) {
    return PRODUCT_REPOSITORY_SEGMENTS.has(segments[transportBoundary - 1]);
  }

  // Without a documented route marker, an exact terminal target is the
  // repository under both root-mounted and ordinary app-prefix deployments.
  if (PRODUCT_REPOSITORY_SEGMENTS.has(segments.at(-1))) return true;

  const resourceIndex = repositoryResourceIndex(segments, "gitea");
  if (resourceIndex !== -1) {
    return PRODUCT_REPOSITORY_SEGMENTS.has(segments[resourceIndex - 1]);
  }

  const repositoryFollowedByResource = segments.some(
    (segment, index) =>
      PRODUCT_REPOSITORY_SEGMENTS.has(segment) &&
      GITEA_RESOURCE_ROUTE_ROOTS.has(segments[index + 1]),
  );
  return (
    repositoryFollowedByResource ||
    PRODUCT_REPOSITORY_SEGMENTS.has(segments.at(-1))
  );
}

function isPublicGitRoute(hostname, service, segments) {
  const publicIndexes = [0];
  if (service === "gitea" || service === "forgejo") {
    publicIndexes.push(1);
    const resourceIndex = repositoryResourceIndex(segments, "gitea");
    for (let index = 2; index < segments.length; index += 1) {
      if (
        segments[index] === "explore" &&
        ["projects", "repos"].includes(segments[index + 1]) &&
        (resourceIndex === -1 || index < resourceIndex)
      ) {
        publicIndexes.push(index);
      }
    }
  } else if (service !== undefined && segments[0] === service) {
    publicIndexes.push(1);
  }

  const routeRoots =
    PUBLIC_GIT_ROUTE_ROOTS.get(hostname) ??
    SELF_HOSTED_PUBLIC_ROUTE_ROOTS.get(service);
  const isGiteaFamily =
    ["code.forgejo.org", "codeberg.org", "gitea.com"].includes(hostname) ||
    service === "forgejo" ||
    service === "gitea";
  for (const index of publicIndexes) {
    if (
      routeRoots?.has(segments[index]) &&
      !(isGiteaFamily && segments[index] === "explore")
    ) {
      return true;
    }
    if (
      segments[index] === "explore" &&
      ["projects", "repos"].includes(segments[index + 1])
    ) {
      return true;
    }
    if (segments[index] === "groups") {
      const groupResourceIndex = segments.indexOf("-", index + 1);
      if (
        groupResourceIndex !== -1 &&
        ["activity", "autocomplete_sources"].includes(
          segments[groupResourceIndex + 1],
        )
      ) {
        return true;
      }
    }
    if (
      service === "bitbucket" &&
      segments[index] === "product" &&
      PRODUCT_REPOSITORY_SEGMENTS.has(segments[index + 1])
    ) {
      return true;
    }
  }

  if (["forgejo", "git", "gitea"].includes(service)) {
    const packageRouteIndex = segments.indexOf("-");
    const maximumPackageRouteIndex = service === "git" ? 1 : 2;
    if (
      packageRouteIndex >= 1 &&
      packageRouteIndex <= maximumPackageRouteIndex &&
      segments[packageRouteIndex + 1] === "packages"
    ) {
      return true;
    }
  }
  return false;
}

function isPrivateRepositoryUrl(reference) {
  let parsed;
  try {
    parsed = new URL(reference);
  } catch {
    return false;
  }

  const segments = repositoryPathSegments(parsed.pathname);
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.+$/u, "");
  const { profile, service } = gitHostProfile(parsed, hostname, segments);

  // SSH clone paths identify the repository with their terminal segment.
  if (parsed.protocol === "ssh:") {
    return PRODUCT_REPOSITORY_SEGMENTS.has(segments.at(-1));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (isPublicGitRoute(hostname, service, segments)) return false;

  const bitbucketRepositoryIndex = bitbucketServerRepositoryIndex(segments);
  const existingResourceIndex = repositoryResourceIndex(segments);
  if (
    bitbucketRepositoryIndex !== -1 &&
    (profile === "bitbucket-server" || profile === "generic") &&
    (profile === "bitbucket-server" ||
      existingResourceIndex === -1 ||
      bitbucketRepositoryIndex < existingResourceIndex)
  ) {
    return PRODUCT_REPOSITORY_SEGMENTS.has(
      segments[bitbucketRepositoryIndex],
    );
  }

  const apiTarget = apiRepositoryTarget(
    profile,
    service,
    hostname,
    parsed,
    segments,
  );
  if (apiTarget !== undefined) {
    return PRODUCT_REPOSITORY_SEGMENTS.has(apiTarget.repository);
  }

  const smartHttpTarget = smartHttpRepositoryTarget(parsed, segments);
  if (
    smartHttpTarget !== undefined &&
    isSmartHttpRepositoryTarget(profile, service, segments, smartHttpTarget)
  ) {
    return PRODUCT_REPOSITORY_SEGMENTS.has(smartHttpTarget.repository);
  }

  if (profile === "generic") {
    if (PRODUCT_REPOSITORY_SEGMENTS.has(segments.at(-1))) {
      const anchoredResourceIndex = repositoryResourceIndex(segments);
      return anchoredResourceIndex === -1
        ? true
        : PRODUCT_REPOSITORY_SEGMENTS.has(
            segments[anchoredResourceIndex - 1],
          );
    }

    const resourceIndex = repositoryResourceIndex(segments);
    if (resourceIndex !== -1) {
      return PRODUCT_REPOSITORY_SEGMENTS.has(segments[resourceIndex - 1]);
    }
    return segments.some(
      (segment, index) =>
        segment === "glasstrace-product.git" ||
        (PRODUCT_REPOSITORY_SEGMENTS.has(segment) &&
          GITEA_RESOURCE_ROUTE_ROOTS.has(segments[index + 1])),
    );
  }

  if (profile === "gitlab") {
    const resourceIndex = segments.indexOf("-");
    const namespaceSegments =
      resourceIndex === -1 ? segments : segments.slice(0, resourceIndex);
    if (namespaceSegments.includes("glasstrace-product.git")) return true;
  }

  if (
    profile === "one-owner" &&
    (service === "gitea" || service === "forgejo")
  ) {
    return isPrivateGiteaRepositoryPath(segments);
  }

  const repositorySegment = repositorySegmentForProfile(profile, segments);
  if (PRODUCT_REPOSITORY_SEGMENTS.has(repositorySegment)) return true;

  // An exact `.git` segment is an explicit repository signal on otherwise
  // generic or unknown hosts. Specific host profiles use only their actual
  // repository slot so resource file paths cannot become false positives.
  if (profile !== "unknown") return false;
  const explicitRepositoryIndex = segments.indexOf("glasstrace-product.git");
  if (explicitRepositoryIndex === -1) return false;
  const resourceIndex = transportResourceIndex(segments, "generic");
  return resourceIndex === -1 || explicitRepositoryIndex < resourceIndex;
}

function isPrivateScpReference(reference) {
  const start = validScpStartAt(reference, 0);
  if (start === undefined) return false;
  const [pathname] = reference.slice(start.pathStart).split(/[?#]/u, 1);
  const segments = pathname
    .split(/[\\/]+/)
    .map(decodePathSegment)
    .filter(Boolean);
  return PRODUCT_REPOSITORY_SEGMENTS.has(segments.at(-1));
}

function isPrivateFileReference(reference) {
  const parsed = parseFileReference(reference);
  if (parsed === undefined) return false;

  const segments = parsed.pathname
    .split(/[\\/]/u)
    .map(decodePathSegment)
    .filter(Boolean);
  return segments.some((segment) => PRODUCT_REPOSITORY_SEGMENTS.has(segment));
}

function validatedRawUserinfoMarker(line, start) {
  let cursor = start;
  let lastMarker = -1;
  while (cursor < line.length) {
    const character = codePointAt(line, cursor);
    if (
      character === "/" ||
      character === "?" ||
      character === "#" ||
      /\s/u.test(character)
    ) {
      break;
    }
    if (character === "@") lastMarker = cursor;
    cursor += character.length;
  }
  const rawUserinfo =
    lastMarker === -1 ? "" : line.slice(start, lastMarker);
  const specialIndex = rawUserinfo.search(/[|<>"'`[\]]/u);
  let schemeStart = Math.max(0, start - 3);
  while (
    schemeStart > 0 &&
    /[A-Z0-9+.-]/iu.test(line[schemeStart - 1])
  ) {
    schemeStart -= 1;
  }
  const openingWrapper = codePointBefore(line, schemeStart);
  const closingWrapper = URL_WRAPPER_CLOSINGS.get(openingWrapper);
  const closingBoundaryIndex =
    closingWrapper === undefined
      ? -1
      : rawUserinfo.indexOf(closingWrapper);
  const closingBoundaryPrefix = rawUserinfo.slice(0, closingBoundaryIndex);
  return lastMarker !== -1 &&
    specialIndex !== -1 &&
    !(
      closingBoundaryIndex !== -1 &&
      !closingBoundaryPrefix.endsWith(":") &&
      hasValidAuthority(closingBoundaryPrefix)
    ) &&
    hasValidAuthority(line.slice(start, cursor))
    ? lastMarker
    : -1;
}

function hardUrlAuthorityBounds(line, start) {
  let cursor = start;
  let insideIpv6Literal = false;
  const validatedUserinfoMarker = validatedRawUserinfoMarker(line, start);
  let lastUserinfoMarker = validatedUserinfoMarker;
  while (cursor < line.length) {
    const character = codePointAt(line, cursor);
    const insideValidatedUserinfo =
      validatedUserinfoMarker !== -1 && cursor <= validatedUserinfoMarker;
    if (
      character === "[" &&
      !insideIpv6Literal &&
      !insideValidatedUserinfo
    ) {
      insideIpv6Literal = true;
      cursor += character.length;
      continue;
    }
    if (
      character === "]" &&
      insideIpv6Literal &&
      !insideValidatedUserinfo
    ) {
      insideIpv6Literal = false;
      cursor += character.length;
      continue;
    }
    if (
      character === "@" &&
      !insideIpv6Literal &&
      !insideValidatedUserinfo
    ) {
      lastUserinfoMarker = cursor;
    }
    if (
      !insideIpv6Literal &&
      !insideValidatedUserinfo &&
      (character === "/" ||
        character === "?" ||
        character === "#" ||
        character === "|" ||
        REFERENCE_TERMINATOR_PATTERN.test(character))
    ) {
      break;
    }
    cursor += character.length;
  }
  return { end: cursor, lastUserinfoMarker, validatedUserinfoMarker };
}

function urlAuthorityEnd(line, start) {
  const {
    end: hardEnd,
    lastUserinfoMarker,
    validatedUserinfoMarker,
  } = hardUrlAuthorityBounds(line, start);
  let cursor = start;
  let insideIpv6Literal = false;
  while (cursor < hardEnd) {
    const character = codePointAt(line, cursor);
    const insideValidatedUserinfo =
      validatedUserinfoMarker !== -1 && cursor <= validatedUserinfoMarker;
    if (
      character === "[" &&
      !insideIpv6Literal &&
      !insideValidatedUserinfo
    ) {
      insideIpv6Literal = true;
    } else if (
      character === "]" &&
      insideIpv6Literal &&
      !insideValidatedUserinfo
    ) {
      insideIpv6Literal = false;
    } else if (
      !insideIpv6Literal &&
      !insideValidatedUserinfo &&
      (cursor > lastUserinfoMarker ||
        isScpSuffixBoundary(character) ||
        patternMatchesAt(
          REFERENCE_PREFIX_AT_BOUNDARY_PATTERN,
          line,
          cursor + character.length,
        )) &&
      (isPathAwareReferenceSeparator(character) ||
        /[()[\]{}]/u.test(character))
    ) {
      const previous = codePointBefore(line, cursor);
      if (
        previous !== undefined &&
        /[\p{L}\p{N}\p{M}\p{Pc}\]]/u.test(previous)
      ) {
        const prefix = line.slice(start, cursor);
        if (!hasValidAuthority(prefix)) return hardEnd;
        const completeAuthority = line.slice(start, hardEnd);
        const remainingAuthority = line.slice(
          cursor + character.length,
          hardEnd,
        );
        const pictographicSuffix = remainingAuthority.replace(
          /^(?:[\p{M}\p{Emoji_Modifier}]|\u200d\p{Extended_Pictographic})*/u,
          "",
        );
        const isValidMixedIdnLabel =
          ((/\p{Extended_Pictographic}/u.test(character) &&
            (pictographicSuffix === "" ||
              /^\.[^.]/u.test(pictographicSuffix) ||
              /^\p{Extended_Pictographic}/u.test(pictographicSuffix))) ||
            (/[。．｡]/u.test(character) && remainingAuthority.length > 0)) &&
          hasValidAuthority(completeAuthority);
        if (!isValidMixedIdnLabel) return cursor;
      }
    }
    cursor += character.length;
  }
  return hardEnd;
}

function hasOnlyValidPercentEscapes(value) {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 1)) {
    if (!/^[0-9A-F]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      return false;
    }
  }
  return true;
}

function hasValidAuthority(authority) {
  if (authority.length === 0 || !hasOnlyValidPercentEscapes(authority)) {
    return false;
  }

  try {
    // The WHATWG HTTPS parser supplies consistent host, userinfo, port, IDNA,
    // and IPv6 validation for both HTTPS and SSH authority syntax.
    const parsed = new URL(`https://${authority}/`);
    const hostname = parsed.hostname;
    const isIpv6Literal = hostname.startsWith("[") && hostname.endsWith("]");
    if (
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      hostname.length === 0
    ) {
      return false;
    }
    if (isIpv6Literal) return true;
    const canonicalHostname = hostname.endsWith(".")
      ? hostname.slice(0, -1)
      : hostname;
    return canonicalHostname.split(".").every(
      (label) =>
        label.length > 0 &&
        /^[A-Z0-9_-]+$/iu.test(label) &&
        /[A-Z0-9]/iu.test(label),
    );
  } catch {
    return false;
  }
}

function collectValidUrlAuthorityRanges(line) {
  const ranges = [];
  for (const match of line.matchAll(URL_AUTHORITY_MARKER_SCAN_PATTERN)) {
    let schemeStart = match.index;
    while (
      schemeStart > 0 &&
      /[A-Z0-9+.-]/iu.test(line[schemeStart - 1])
    ) {
      schemeStart -= 1;
    }
    const scheme = line.slice(schemeStart, match.index);
    if (
      !/^[A-Z][A-Z0-9+.-]*$/iu.test(scheme) ||
      !hasReferenceStartBoundary(
        line,
        schemeStart,
        HTTPS_URL_PATTERN,
      )
    ) {
      continue;
    }

    const authorityStart = match.index + match[0].length;
    const authorityEnd = urlAuthorityEnd(line, authorityStart);
    const authority = line.slice(authorityStart, authorityEnd);
    if (authority.length === 0 || !hasOnlyValidPercentEscapes(authority)) {
      continue;
    }

    try {
      const parsed = new URL(
        `${line.slice(schemeStart, authorityStart)}${authority}/`,
      );
      if (
        parsed.protocol !== `${scheme.toLowerCase()}:` ||
        parsed.hostname.length === 0 ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        continue;
      }
    } catch {
      continue;
    }

    const previous = ranges.at(-1);
    if (previous !== undefined && authorityStart <= previous.end) {
      previous.end = Math.max(previous.end, authorityEnd);
    } else {
      ranges.push({ start: authorityStart, end: authorityEnd });
    }
  }
  return ranges;
}

function collectLexicalReferenceAnalysis(line) {
  const balancedExpansionEnds = new Uint32Array(line.length + 1);
  const intrinsicPathExpansionEnds = new Uint8Array(line.length + 1);
  const braceStack = [];
  const parenthesisStack = [];
  let precedingBackslashes = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (precedingBackslashes % 2 === 0) {
      if (character === "{") braceStack.push(index);
      else if (character === "}" && braceStack.length > 0) {
        balancedExpansionEnds[braceStack.pop()] = index + 1;
      } else if (character === "(") parenthesisStack.push(index);
      else if (character === ")" && parenthesisStack.length > 0) {
        balancedExpansionEnds[parenthesisStack.pop()] = index + 1;
      }
    }
    precedingBackslashes =
      character === "\\" ? precedingBackslashes + 1 : 0;
  }
  for (const match of line.matchAll(/%~[A-Za-z]*[0-9]/gu)) {
    if (match[0].slice(2, -1).toLowerCase().includes("p")) {
      intrinsicPathExpansionEnds[match.index + match[0].length] = 1;
    }
  }

  const nextBangDelimiter = new Uint32Array(line.length + 1);
  const nextPercentDelimiter = new Uint32Array(line.length + 1);
  const tokenEnds = new Uint32Array(line.length + 1);
  let nextBang = line.length;
  let nextPercent = line.length;
  let tokenEnd = line.length;
  nextBangDelimiter[line.length] = nextBang;
  nextPercentDelimiter[line.length] = nextPercent;
  tokenEnds[line.length] = tokenEnd;

  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (REFERENCE_TERMINATOR_PATTERN.test(line[index])) tokenEnd = index;
    nextBangDelimiter[index] = nextBang;
    nextPercentDelimiter[index] = nextPercent;
    tokenEnds[index] = tokenEnd;
    if (line[index] === "!") nextBang = index;
    if (line[index] === "%") nextPercent = index;
  }

  return {
    balancedExpansionEnds,
    intrinsicPathExpansionEnds,
    nextBangDelimiter,
    nextPercentDelimiter,
    tokenEnds,
    urlAuthorityRanges: collectValidUrlAuthorityRanges(line),
  };
}

function parseFileReference(reference) {
  try {
    const parsed = new URL(reference);
    if (
      parsed.protocol !== "file:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== ""
    ) {
      return undefined;
    }
    if (
      parsed.hostname !== "" &&
      parsed.hostname !== "localhost" &&
      !hasValidAuthority(parsed.host)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function hasValidUrlAuthorityAt(line, index, scheme) {
  const authorityStart = index + scheme.length;
  if (authorityStart >= line.length || line[authorityStart] === "/") {
    return false;
  }
  const authorityEnd = urlAuthorityEnd(line, authorityStart);
  const authority = line.slice(authorityStart, authorityEnd);
  return hasValidAuthority(authority);
}

function validScpStartAt(line, index) {
  VALID_SCP_START_PATTERN.lastIndex = index;
  const match = VALID_SCP_START_PATTERN.exec(line);
  VALID_SCP_START_PATTERN.lastIndex = 0;
  if (match === null) return undefined;
  const pathStart = index + match[0].length;
  if (
    keycapSequenceEndAt(line, pathStart) !== undefined ||
    !hasValidAuthority(match[2])
  ) {
    return undefined;
  }
  return { pathStart };
}

function hasValidScpStartAt(line, index) {
  return validScpStartAt(line, index) !== undefined;
}

function isInsideUrlAuthority(urlAuthorityRanges, index) {
  return sortedRangesContainIndex(urlAuthorityRanges, index);
}

function hasValidFileStartAt(line, index) {
  const pathStart = index + "file:".length;
  if (pathStart >= line.length) return false;

  if (/^(?:\/\/)?[A-Za-z][|:][\\/]/u.test(line.slice(pathStart))) {
    return true;
  }

  if (line.startsWith("//", pathStart)) {
    const authorityStart = pathStart + 2;
    const { end: authorityEnd } = hardUrlAuthorityBounds(
      line,
      authorityStart,
    );
    if (line[authorityEnd] !== "/") return false;
    return (
      parseFileReference(line.slice(index, authorityEnd + 1)) !== undefined
    );
  }

  const first = codePointAt(line, pathStart);
  if (
    first === undefined ||
    first === "?" ||
    first === "#" ||
    REFERENCE_TERMINATOR_PATTERN.test(first) ||
    HARD_INVALID_REFERENCE_SEPARATOR_PATTERN.test(first)
  ) {
    return false;
  }
  return parseFileReference(`file:${first}`) !== undefined;
}

function hasReferenceStartBoundary(line, index, pattern) {
  const root = precedingBoundaryRoot(line, index);
  const continuationPattern =
    pattern === SCP_REFERENCE_PATTERN
      ? SCP_USERNAME_CONTINUATION_PATTERN
      : URL_START_CONTINUATION_PATTERN;
  if (
    root.character !== undefined &&
    !root.isKeycap &&
    continuationPattern.test(root.character)
  ) {
    return false;
  }
  return !(
    pattern === SCP_REFERENCE_PATTERN &&
    !root.isKeycap &&
    root.character === "/"
  );
}

function hasValidReferenceStartAt(
  line,
  urlAuthorityRanges,
  index,
  pattern,
  requireBoundary,
) {
  pattern.lastIndex = index;
  const match = pattern.exec(line);
  pattern.lastIndex = 0;
  if (match === null) return false;
  if (requireBoundary && !hasReferenceStartBoundary(line, index, pattern)) {
    return false;
  }
  if (pattern === HTTPS_URL_PATTERN || pattern === SSH_URL_PATTERN) {
    return hasValidUrlAuthorityAt(line, index, match[0]);
  }
  if (pattern === FILE_REFERENCE_PATTERN) {
    return hasValidFileStartAt(line, index);
  }
  return (
    !isInsideUrlAuthority(urlAuthorityRanges, index) &&
    hasValidScpStartAt(line, index)
  );
}

function isScpSuffixBoundary(character) {
  return (
    isPathAwareReferenceSeparator(character) || /[)>}\]]/u.test(character)
  );
}

function lastScpSuffixBoundaryEnd(value) {
  let boundaryEnd = -1;
  for (let cursor = 0; cursor < value.length; ) {
    const character = codePointAt(value, cursor);
    if (isScpSuffixBoundary(character)) {
      boundaryEnd = cursor + character.length;
    }
    cursor += character.length;
  }
  return boundaryEnd;
}

function collectScpPatternStarts(line, urlAuthorityRanges) {
  const starts = [];
  for (const match of line.matchAll(SCP_REFERENCE_SCAN_PATTERN)) {
    const lastUserinfoMarker = match[0].lastIndexOf("@");
    if (lastUserinfoMarker === -1) continue;
    const matchEnd = match.index + lastUserinfoMarker + 1;
    const containingAuthority = sortedRangeContainingIndex(
      urlAuthorityRanges,
      match.index,
    );
    let candidate = { start: match.index, requireBoundary: true };

    if (
      containingAuthority !== undefined &&
      containingAuthority.end < matchEnd
    ) {
      const separator = codePointAt(line, containingAuthority.end);
      if (separator === undefined) continue;
      candidate = {
        start: containingAuthority.end + separator.length,
        requireBoundary: false,
      };
    }

    const userinfo = match[0].slice(0, lastUserinfoMarker);
    const suffixBoundaryEnd = lastScpSuffixBoundaryEnd(userinfo);
    if (suffixBoundaryEnd !== -1 && suffixBoundaryEnd < userinfo.length) {
      const suffixStart = match.index + suffixBoundaryEnd;
      if (suffixStart > candidate.start) {
        candidate = { start: suffixStart, requireBoundary: false };
      }
    }

    if (
      hasValidReferenceStartAt(
        line,
        urlAuthorityRanges,
        candidate.start,
        SCP_REFERENCE_PATTERN,
        candidate.requireBoundary,
      )
    ) {
      starts.push(candidate.start);
    }
  }
  return starts;
}

function hasReferenceStartAtBoundary(line, lexicalAnalysis, index) {
  if (
    [
    HTTPS_URL_PATTERN,
    SSH_URL_PATTERN,
    FILE_REFERENCE_PATTERN,
    ].some((pattern) =>
      hasValidReferenceStartAt(
        line,
        lexicalAnalysis.urlAuthorityRanges,
        index,
        pattern,
        false,
      ),
    )
  ) {
    return true;
  }
  return lexicalAnalysis.scpReferenceStarts.has(index);
}

function collectPatternStarts(line, urlAuthorityRanges, patterns) {
  const starts = [];
  for (const pattern of patterns) {
    if (pattern === SCP_REFERENCE_PATTERN) {
      starts.push(...collectScpPatternStarts(line, urlAuthorityRanges));
      continue;
    }
    for (let index = 0; index < line.length; index += 1) {
      if (
        hasValidReferenceStartAt(
          line,
          urlAuthorityRanges,
          index,
          pattern,
          true,
        )
      ) {
        starts.push(index);
      }
    }
  }
  return [...new Set(starts)].sort((left, right) => left - right);
}

function collectMatchRanges(
  line,
  patterns,
  referenceStarts,
  lexicalAnalysis,
  explicitStarts,
) {
  const starts =
    explicitStarts ??
    collectPatternStarts(
      line,
      lexicalAnalysis.urlAuthorityRanges,
      patterns,
    );
  const ranges = starts.map((start) => {
    let end = lexicalAnalysis.tokenEnds[start];
    let contentStart = referenceContentStart(line, start, patterns);
    for (const pattern of patterns) {
      pattern.lastIndex = start;
      const match = pattern.exec(line);
      pattern.lastIndex = 0;
      if (
        match !== null &&
        (pattern === HTTPS_URL_PATTERN || pattern === SSH_URL_PATTERN)
      ) {
        const authorityEnd = urlAuthorityEnd(
          line,
          start + match[0].length,
        );
        end = Math.max(end, lexicalAnalysis.tokenEnds[authorityEnd]);
        contentStart = Math.max(contentStart, authorityEnd);
      } else if (match !== null && pattern === SCP_REFERENCE_PATTERN) {
        const scpStart = validScpStartAt(line, start);
        if (scpStart !== undefined) {
          end = Math.max(end, lexicalAnalysis.tokenEnds[scpStart.pathStart]);
          contentStart = Math.max(contentStart, scpStart.pathStart);
        }
      }
    }
    return { contentStart, end, match: "", start };
  });
  for (const range of ranges) {
    const nextStart = firstIndexInRange(
      referenceStarts,
      Math.max(range.start + 1, range.contentStart + 1),
      range.end,
    );
    if (nextStart !== undefined) range.end = nextStart;
    range.match = line.slice(range.start, range.end);
  }
  return ranges;
}

function isPathAwareReferenceSeparator(character) {
  // Raw non-ASCII prose punctuation can delimit adjacent references.
  // Percent-encoding keeps the mark unambiguously inside the URL.
  return (
    character === "," ||
    character === ";" ||
    CONTROL_REFERENCE_SEPARATOR_PATTERN.test(character) ||
    (character.codePointAt(0) > 0x7f &&
      NON_IDENTIFIER_REFERENCE_SEPARATOR_PATTERN.test(character))
  );
}

function collectBalancedReferenceDelimiters(line, start, end) {
  const contentOpenings = new Set();
  const contentClosings = new Set();
  const contentOpeningForClosing = new Map();
  const hardClosings = new Set();
  const openingStacks = new Map(
    [...REFERENCE_DELIMITER_PAIRS.keys()].map((opening) => [opening, []]),
  );

  for (let index = start; index < end; index += 1) {
    const character = line[index];
    if (REFERENCE_DELIMITER_PAIRS.has(character)) {
      openingStacks.get(character).push(index);
      continue;
    }

    const opening = REFERENCE_CLOSING_TO_OPENING.get(character);
    if (opening === undefined) continue;
    const matchingStack = openingStacks.get(opening);
    if (matchingStack.length === 0) {
      hardClosings.add(index);
      continue;
    }
    const openingIndex = matchingStack.pop();
    contentOpenings.add(openingIndex);
    contentClosings.add(index);
    contentOpeningForClosing.set(index, openingIndex);
  }

  const protectingOpenings = new Set();
  const protectingClosings = new Set();
  const strictStack = [];
  const strictFrames = [];
  const strictFrameByOpening = new Map();
  let errorVersion = 0;
  for (let index = start; index < end; index += 1) {
    while (strictStack.at(-1)?.crossedClosed) strictStack.pop();
    const character = line[index];
    if (REFERENCE_DELIMITER_PAIRS.has(character)) {
      const frame = {
        character,
        clean: false,
        closing: undefined,
        crossedClosed: false,
        index,
        parent: strictStack.at(-1),
        protected: false,
        version: errorVersion,
      };
      strictFrames.push(frame);
      strictFrameByOpening.set(index, frame);
      strictStack.push(frame);
      continue;
    }

    const expectedOpening = REFERENCE_CLOSING_TO_OPENING.get(character);
    if (expectedOpening === undefined) continue;
    const top = strictStack.at(-1);
    if (top === undefined || top.character !== expectedOpening) {
      errorVersion += 1;
      const crossedOpening = contentOpeningForClosing.get(index);
      const crossedFrame = strictFrameByOpening.get(crossedOpening);
      if (crossedFrame !== undefined) {
        crossedFrame.crossedClosed = true;
        crossedFrame.closing = index;
      }
      continue;
    }
    strictStack.pop();
    top.closing = index;
    if (top.version === errorVersion) {
      top.clean = true;
    }
  }

  for (const frame of strictFrames) {
    frame.protected =
      frame.clean && (frame.parent === undefined || frame.parent.protected);
    if (frame.protected) {
      protectingOpenings.add(frame.index);
      protectingClosings.add(frame.closing);
    }
  }

  return {
    contentClosings,
    contentOpenings,
    hardClosings,
    protectingClosings,
    protectingOpenings,
  };
}

function collectForbiddenLocalProductStarts(line, lexicalAnalysis) {
  const starts = [];
  for (const candidate of line.matchAll(PRIVATE_PRODUCT_NAME_PATTERN)) {
    const end = candidate.index + candidate[0].length;
    if (isLocalProductPath(line, candidate.index, end, lexicalAnalysis)) {
      starts.push(candidate.index);
    }
  }
  return starts;
}

function collectProductStarts(line) {
  return [...line.matchAll(PRIVATE_PRODUCT_NAME_PATTERN)].map(
    (candidate) => candidate.index,
  );
}

function firstIndexInRange(sortedIndices, start, end) {
  let low = 0;
  let high = sortedIndices.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedIndices[middle] < start) low = middle + 1;
    else high = middle;
  }
  return low < sortedIndices.length && sortedIndices[low] < end
    ? sortedIndices[low]
    : undefined;
}

function patternMatchesAt(pattern, line, index) {
  pattern.lastIndex = index;
  const matches = pattern.test(line);
  pattern.lastIndex = 0;
  return matches;
}

function explicitExpansionAt(line, index, lexicalAnalysis) {
  if (line[index] === "$") {
    if (line[index + 1] === "{") {
      const end = lexicalAnalysis.balancedExpansionEnds[index + 1];
      return end === 0 ? undefined : { end, intrinsicPath: false };
    }
    if (line[index + 1] === "(") {
      const end = lexicalAnalysis.balancedExpansionEnds[index + 1];
      return end === 0 ? undefined : { end, intrinsicPath: false };
    }
    const match = /^\$(?:(?:[A-Za-z_][A-Za-z0-9_]*:)?[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/u.exec(
      line.slice(index),
    );
    return match === null
      ? undefined
      : { end: index + match[0].length, intrinsicPath: false };
  }

  if (line[index] === "%") {
    const positional = /^%~[A-Za-z]*[0-9]/u.exec(line.slice(index));
    if (positional !== null) {
      return {
        end: index + positional[0].length,
        intrinsicPath: positional[0].slice(2, -1).toLowerCase().includes("p"),
      };
    }
    if (/^%[0-9]/u.test(line.slice(index, index + 2))) {
      return { end: index + 2, intrinsicPath: false };
    }
    const closing = lexicalAnalysis.nextPercentDelimiter[index];
    return closing < line.length && closing > index + 1
      ? { end: closing + 1, intrinsicPath: false }
      : undefined;
  }

  if (line[index] === "!") {
    const closing = lexicalAnalysis.nextBangDelimiter[index];
    return closing < line.length && closing > index + 1
      ? { end: closing + 1, intrinsicPath: false }
      : undefined;
  }
  return undefined;
}

function hasExplicitLocalPathAtBoundary(line, index, lexicalAnalysis) {
  if (
    patternMatchesAt(
      EXPLICIT_LOCAL_PATH_AT_BOUNDARY_PATTERN,
      line,
      index,
    )
  ) {
    return true;
  }
  if (
    line[index] === "!" &&
    patternMatchesAt(
      EXPLICIT_LOCAL_PATH_AT_BOUNDARY_PATTERN,
      line,
      index + 1,
    )
  ) {
    return true;
  }
  const expansion = explicitExpansionAt(line, index, lexicalAnalysis);
  return (
    expansion !== undefined &&
    (expansion.intrinsicPath ||
      line[expansion.end] === "/" ||
      line[expansion.end] === "\\")
  );
}

function isReferenceOpeningWrapper(character) {
  return (
    REFERENCE_DELIMITER_PAIRS.has(character) ||
    (character.codePointAt(0) > 0x7f &&
      REFERENCE_OPENING_WRAPPER_PATTERN.test(character))
  );
}

function isReferenceBoundaryPrefix(character) {
  return (
    isReferenceOpeningWrapper(character) ||
    isPathAwareReferenceSeparator(character) ||
    REFERENCE_BOUNDARY_MARK_PATTERN.test(character) ||
    !REFERENCE_BOUNDARY_CONTENT_PATTERN.test(character)
  );
}

function collectNextReferenceBoundaryContentIndices(line) {
  const indices = new Uint32Array(line.length + 1);
  indices[line.length] = line.length;
  for (let end = line.length; end > 0; ) {
    const character = codePointBefore(line, end);
    const start = end - character.length;
    const keycapEnd = keycapSequenceEndAt(line, start);
    if (keycapEnd !== undefined) {
      indices.fill(indices[keycapEnd], start, keycapEnd);
    } else {
      const nextIndex = isReferenceBoundaryPrefix(character)
        ? indices[end]
        : start;
      indices.fill(nextIndex, start, end);
    }
    end = start;
  }
  return indices;
}

function hasReferenceAfterBoundary(
  line,
  start,
  end,
  localProductStarts,
  productStarts,
  nextBoundaryContentIndices,
  resultCache,
  lexicalAnalysis,
) {
  const referenceStart = Math.min(nextBoundaryContentIndices[start], end);
  const cached = resultCache.get(referenceStart);
  if (cached !== undefined) return cached;

  if (
    hasReferenceStartAtBoundary(
      line,
      lexicalAnalysis,
      referenceStart,
    )
  ) {
    resultCache.set(referenceStart, true);
    return true;
  }
  const productStart = firstIndexInRange(
    localProductStarts,
    referenceStart,
    end,
  );
  if (productStart === undefined) {
    const rawProductStart = firstIndexInRange(
      productStarts,
      referenceStart,
      end,
    );
    const expansion = explicitExpansionAt(
      line,
      referenceStart,
      lexicalAnalysis,
    );
    if (
      rawProductStart !== undefined &&
      expansion?.intrinsicPath &&
      rawProductStart === expansion.end
    ) {
      resultCache.set(referenceStart, true);
      return true;
    }
    resultCache.set(referenceStart, false);
    return false;
  }
  if (
    patternMatchesAt(
      REFERENCE_PREFIX_AT_BOUNDARY_PATTERN,
      line,
      referenceStart,
    )
  ) {
    resultCache.set(referenceStart, true);
    return true;
  }
  if (
    hasExplicitLocalPathAtBoundary(
      line,
      referenceStart,
      lexicalAnalysis,
    )
  ) {
    resultCache.set(referenceStart, true);
    return true;
  }
  if (productStart === referenceStart || line[productStart - 1] === "\\") {
    resultCache.set(referenceStart, true);
    return true;
  }
  resultCache.set(referenceStart, false);
  return false;
}

function hasInvalidReferencePrefixAfterSlash(
  line,
  start,
  end,
  localProductStarts,
  nextBoundaryContentIndices,
  resultCache,
) {
  const referenceStart = Math.min(nextBoundaryContentIndices[start], end);
  const cacheKey = -referenceStart - 1;
  const cached = resultCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const productStart = firstIndexInRange(
    localProductStarts,
    referenceStart,
    end,
  );
  const hasRawPrefix = patternMatchesAt(
    REFERENCE_PREFIX_AT_BOUNDARY_PATTERN,
    line,
    referenceStart,
  );
  const isValidEmbeddedScp =
    patternMatchesAt(SCP_REFERENCE_PATTERN, line, referenceStart) &&
    hasValidScpStartAt(line, referenceStart);
  const result =
    productStart !== undefined && hasRawPrefix && !isValidEmbeddedScp;
  resultCache.set(cacheKey, result);
  return result;
}

function isLegacyFileDrivePipe(line, rangeStart, index, patterns) {
  if (!patterns.includes(FILE_REFERENCE_PATTERN)) return false;
  return (
    (index === rangeStart + 6 &&
      /^[A-Za-z]\|[\\/]/u.test(line.slice(rangeStart + 5, rangeStart + 8))) ||
    (index === rangeStart + 8 &&
      /^[A-Za-z]\|[\\/]/u.test(line.slice(rangeStart + 7, rangeStart + 10)))
  );
}

function referenceContentStart(line, start, patterns) {
  for (const pattern of patterns) {
    pattern.lastIndex = start;
    const match = pattern.exec(line);
    pattern.lastIndex = 0;
    if (match === null) continue;

    if (pattern === HTTPS_URL_PATTERN || pattern === SSH_URL_PATTERN) {
      return urlAuthorityEnd(line, start + match[0].length);
    }
    if (pattern === FILE_REFERENCE_PATTERN) {
      const afterScheme = start + match[0].length;
      return line.startsWith("//", afterScheme)
        ? urlAuthorityEnd(line, afterScheme + 2)
        : afterScheme;
    }

    return validScpStartAt(line, start)?.pathStart ?? start;
  }
  return start;
}

function collectDelimitedReferenceRanges(
  line,
  patterns,
  referenceStarts,
  lexicalAnalysis,
  explicitStarts,
) {
  const matchedRanges = collectMatchRanges(
    line,
    patterns,
    referenceStarts,
    lexicalAnalysis,
    explicitStarts,
  );
  const localProductStarts = collectForbiddenLocalProductStarts(
    line,
    lexicalAnalysis,
  );
  const productStarts = collectProductStarts(line);
  const nextBoundaryContentIndices =
    collectNextReferenceBoundaryContentIndices(line);
  const ranges = [];

  for (const range of matchedRanges) {
    const matchedEnd = range.end;
    const contentStart = referenceContentStart(line, range.start, patterns);
    const {
      contentClosings,
      contentOpenings,
      hardClosings,
      protectingClosings,
      protectingOpenings,
    } = collectBalancedReferenceDelimiters(
      line,
      contentStart,
      matchedEnd,
    );
    const boundaryResultCache = new Map();
    let protectedDelimiterDepth = 0;

    for (let cursor = contentStart; cursor < matchedEnd; ) {
      const index = cursor;
      const character = codePointAt(line, index);
      const keycapEnd = keycapSequenceEndAt(line, index);
      cursor = keycapEnd ?? index + character.length;

      if (keycapEnd !== undefined) {
        if (
          protectedDelimiterDepth === 0 &&
          hasReferenceAfterBoundary(
            line,
            keycapEnd,
            matchedEnd,
            localProductStarts,
            productStarts,
            nextBoundaryContentIndices,
            boundaryResultCache,
            lexicalAnalysis,
          )
        ) {
          range.end = index;
          break;
        }
        continue;
      }

      if (protectingOpenings.has(index)) {
        protectedDelimiterDepth += 1;
        continue;
      }
      if (protectingClosings.has(index)) {
        protectedDelimiterDepth -= 1;
        continue;
      }

      if (REFERENCE_DELIMITER_PAIRS.has(character)) {
        if (contentOpenings.has(index)) continue;
        if (
          protectedDelimiterDepth === 0 &&
          hasReferenceAfterBoundary(
            line,
            index + character.length,
            matchedEnd,
            localProductStarts,
            productStarts,
            nextBoundaryContentIndices,
            boundaryResultCache,
            lexicalAnalysis,
          )
        ) {
          range.end = index;
          break;
        }
        continue;
      }

      const opening = REFERENCE_CLOSING_TO_OPENING.get(character);
      if (opening !== undefined) {
        if (contentClosings.has(index)) continue;
        if (hardClosings.has(index)) {
          range.end = index;
          break;
        }
        continue;
      }

      if (
        (character === "/" || character === "\\") &&
        protectedDelimiterDepth === 0 &&
        hasInvalidReferencePrefixAfterSlash(
          line,
          index + character.length,
          matchedEnd,
          localProductStarts,
          nextBoundaryContentIndices,
          boundaryResultCache,
        )
      ) {
        range.end = index;
        break;
      }

      if (character === "|") {
        if (isLegacyFileDrivePipe(line, range.start, index, patterns)) {
          continue;
        }
        if (protectedDelimiterDepth > 0) continue;
        range.end = index;
        break;
      }
      if (
        HARD_INVALID_REFERENCE_SEPARATOR_PATTERN.test(character) &&
        protectedDelimiterDepth === 0
      ) {
        range.end = index;
        break;
      }
      if (
        protectedDelimiterDepth === 0 &&
        isPathAwareReferenceSeparator(character) &&
        hasReferenceAfterBoundary(
          line,
          index + character.length,
          matchedEnd,
          localProductStarts,
          productStarts,
          nextBoundaryContentIndices,
          boundaryResultCache,
          lexicalAnalysis,
        )
      ) {
        range.end = index;
        break;
      }
    }

    ranges.push(trimReferenceRange(line, range));
  }

  return ranges.sort((left, right) => left.start - right.start);
}

function sortedRangeContainingIndex(ranges, index) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].start <= index) low = middle + 1;
    else high = middle;
  }
  const candidate = low > 0 ? ranges[low - 1] : undefined;
  return candidate !== undefined && index < candidate.end
    ? candidate
    : undefined;
}

function sortedRangesContainIndex(ranges, index) {
  return sortedRangeContainingIndex(ranges, index) !== undefined;
}

function hasTerminalPathBoundaryAt(line, index) {
  if (line[index] === ".") {
    let cursor = index;
    while (line[cursor] === ".") cursor += 1;
    const afterPunctuation = codePointAt(line, cursor);
    return (
      afterPunctuation === undefined ||
      !PATH_SEGMENT_CONTINUATION_PATTERN.test(afterPunctuation)
    );
  }

  const next = codePointAt(line, index);
  return (
    next === undefined || !PATH_SEGMENT_CONTINUATION_PATTERN.test(next)
  );
}

function isTerminalRepositoryReference(line, end) {
  if (end >= line.length) return true;

  const keycapEnd = keycapSequenceEndAt(line, end);
  if (keycapEnd !== undefined) {
    return hasTerminalPathBoundaryAt(line, keycapEnd);
  }

  const suffix = line.slice(end, end + 4).toLowerCase();
  if (suffix === ".git") {
    const gitKeycapEnd = keycapSequenceEndAt(line, end + 4);
    if (gitKeycapEnd !== undefined) {
      return hasTerminalPathBoundaryAt(line, gitKeycapEnd);
    }
    const afterGit = codePointAt(line, end + 4);
    return (
      afterGit === undefined ||
      afterGit === "/" ||
      afterGit === "\\" ||
      !PATH_SEGMENT_CONTINUATION_PATTERN.test(afterGit)
    );
  }

  return hasTerminalPathBoundaryAt(line, end);
}

function isLocalProductPath(line, start, end, lexicalAnalysis) {
  const previous = codePointBefore(line, start);
  const next = codePointAt(line, end);
  const keycapEnd = keycapSequenceEndAt(line, end);
  const afterKeycap =
    keycapEnd === undefined ? undefined : codePointAt(line, keycapEnd);
  const hasChildPath =
    next === "/" ||
    next === "\\" ||
    afterKeycap === "/" ||
    afterKeycap === "\\";
  const hasGitSuffix = line.slice(end, end + 4).toLowerCase() === ".git";
  const followsSeparator = previous === "/" || previous === "\\";
  const followsDrivePrefix =
    start >= 2 &&
    line[start - 1] === ":" &&
    /[A-Za-z]/.test(line[start - 2]) &&
    hasBoundaryBefore(
      line,
      start - 2,
      PATH_SEGMENT_CONTINUATION_PATTERN,
    );
  const followsIntrinsicPathExpansion =
    lexicalAnalysis.intrinsicPathExpansionEnds[start] === 1;
  const hasLeadingBoundary = hasBoundaryBefore(
    line,
    start,
    PATH_SEGMENT_CONTINUATION_PATTERN,
  );

  if (hasChildPath && hasLeadingBoundary) return true;
  if (
    hasGitSuffix &&
    hasLeadingBoundary &&
    isTerminalRepositoryReference(line, end)
  ) {
    return true;
  }
  return (
    (followsSeparator ||
      followsDrivePrefix ||
      followsIntrinsicPathExpansion) &&
    isTerminalRepositoryReference(line, end)
  );
}

function findInternalTrackingIds(line) {
  const identifierView = decodeIdentifierPercentEscapes(line);
  return [...identifierView.matchAll(INTERNAL_ID_PATTERN)]
    .filter(
      (match) =>
        hasBoundaryBefore(
          identifierView,
          match.index,
          IDENTIFIER_CONTINUATION_PATTERN,
        ) &&
        hasIdentifierBoundaryAfter(
          identifierView,
          match.index + match[0].length,
        ),
    )
    .map((match) => match[0]);
}

function findPrivateProductReferences(line) {
  const lexicalAnalysis = collectLexicalReferenceAnalysis(line);
  const scpReferenceStarts = collectScpPatternStarts(
    line,
    lexicalAnalysis.urlAuthorityRanges,
  );
  const referenceStarts = [...new Set([
    ...collectPatternStarts(
      line,
      lexicalAnalysis.urlAuthorityRanges,
      [HTTPS_URL_PATTERN, SSH_URL_PATTERN, FILE_REFERENCE_PATTERN],
    ),
    ...scpReferenceStarts,
  ])].sort(
    (left, right) => left - right,
  );
  const embeddedScpStarts = [];
  for (const match of line.matchAll(SCP_REFERENCE_SCAN_PATTERN)) {
    if (
      codePointBefore(line, match.index) === "/" &&
      !isInsideUrlAuthority(
        lexicalAnalysis.urlAuthorityRanges,
        match.index,
      ) &&
      hasValidScpStartAt(line, match.index)
    ) {
      embeddedScpStarts.push(match.index);
    }
  }
  lexicalAnalysis.scpReferenceStarts = new Set([
    ...scpReferenceStarts,
    ...embeddedScpStarts,
  ]);
  const allReferenceStarts = [...referenceStarts, ...embeddedScpStarts].sort(
    (left, right) => left - right,
  );
  const httpsUrls = collectDelimitedReferenceRanges(
    line,
    [HTTPS_URL_PATTERN],
    referenceStarts,
    lexicalAnalysis,
  );
  const sshUrls = collectDelimitedReferenceRanges(
    line,
    [SSH_URL_PATTERN],
    referenceStarts,
    lexicalAnalysis,
  );
  const scpReferences = collectDelimitedReferenceRanges(
    line,
    [SCP_REFERENCE_PATTERN],
    referenceStarts,
    lexicalAnalysis,
  );
  const fileReferences = collectDelimitedReferenceRanges(
    line,
    [FILE_REFERENCE_PATTERN],
    referenceStarts,
    lexicalAnalysis,
  );
  const embeddedScpReferences = collectDelimitedReferenceRanges(
    line,
    [SCP_REFERENCE_PATTERN],
    allReferenceStarts,
    lexicalAnalysis,
    embeddedScpStarts,
  );
  const validHttpsUrls = httpsUrls.filter((range) =>
    hasValidUrlAuthorityAt(
      range.match,
      0,
      /^https?:\/\//iu.exec(range.match)?.[0] ?? "",
    ),
  );
  const validSshUrls = sshUrls.filter((range) =>
    hasValidUrlAuthorityAt(range.match, 0, "ssh://"),
  );
  const validScpReferences = scpReferences.filter((range) =>
    hasValidScpStartAt(range.match, 0),
  );
  const validFileReferences = fileReferences.filter(
    (range) => parseFileReference(range.match) !== undefined,
  );
  const privateHttpsUrls = validHttpsUrls.filter((range) =>
    isPrivateRepositoryUrl(range.match),
  );
  const privateSshUrls = validSshUrls.filter((range) =>
    isPrivateRepositoryUrl(range.match),
  );
  const privateScpReferences = validScpReferences.filter((range) =>
    isPrivateScpReference(range.match),
  );
  const privateFileReferences = validFileReferences.filter((range) =>
    isPrivateFileReference(range.match),
  );
  const privateEnclosingReferences = [
    ...privateHttpsUrls,
    ...privateSshUrls,
    ...privateScpReferences,
    ...privateFileReferences,
  ].sort(
    (left, right) => left.start - right.start,
  );
  const privateEmbeddedScpReferences = embeddedScpReferences.filter(
    (range) =>
      hasValidScpStartAt(range.match, 0) &&
      isPrivateScpReference(range.match) &&
      !sortedRangesContainIndex(privateEnclosingReferences, range.start),
  );
  const privateReferences = [
    ...privateHttpsUrls,
    ...privateSshUrls,
    ...privateScpReferences,
    ...privateFileReferences,
    ...privateEmbeddedScpReferences,
  ].sort((left, right) => left.start - right.start);
  const remoteReferenceRanges = [
    ...validHttpsUrls,
    ...validSshUrls,
    ...validScpReferences,
  ].sort((left, right) => left.start - right.start);
  const matches = privateReferences.map((reference) => reference.match);

  for (const candidate of line.matchAll(PRIVATE_PRODUCT_NAME_PATTERN)) {
    const start = candidate.index;
    const end = start + candidate[0].length;
    if (sortedRangesContainIndex(privateReferences, start)) {
      continue;
    }

    // Non-private URL/remote references are not sibling filesystem paths.
    // Private Git references were collected above before this exclusion.
    if (sortedRangesContainIndex(remoteReferenceRanges, start)) {
      continue;
    }

    if (isLocalProductPath(line, start, end, lexicalAnalysis)) {
      matches.push(line.slice(start, end));
    }
  }

  return matches;
}

/**
 * Recursively collect declaration files (`.d.ts` / `.d.cts`) under `dir`.
 */
function collectDeclarationFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectDeclarationFiles(full));
    } else if (full.endsWith(".d.ts") || full.endsWith(".d.cts")) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve every README that npm publishes from a workspace package. */
function collectPublishedReadmes(pkgDir) {
  const found = new Set();

  // npm implicitly publishes a package-root README regardless of `files`.
  for (const entry of readdirSync(pkgDir)) {
    if (/^readme(\.|$)/i.test(entry)) {
      const full = join(pkgDir, entry);
      if (statSync(full).isFile()) found.add(full);
    }
  }

  // Also honor explicit, non-glob README paths in `files`.
  const manifestPath = join(pkgDir, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (Array.isArray(manifest.files)) {
      for (const pattern of manifest.files) {
        if (typeof pattern !== "string" || !/readme/i.test(pattern)) {
          continue;
        }
        const full = join(pkgDir, pattern);
        if (existsSync(full) && statSync(full).isFile()) found.add(full);
      }
    }
  }

  return [...found].sort();
}

/**
 * Scan published-surface text using the same matcher as the CLI entry point.
 */
export function findPublishedSurfaceViolations(content, file = "<memory>") {
  const violations = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const matches = [
      ...findInternalTrackingIds(line).map((match) => ({
        kind: "internal tracking identifier",
        match,
      })),
      ...findPrivateProductReferences(line).map((match) => ({
        kind: "private Product repository path",
        match,
      })),
    ];

    for (const { kind, match } of matches) {
      violations.push({
        file,
        line: index + 1,
        text: line.trim(),
        kind,
        match,
      });
    }
  }

  return violations;
}

function scanFile(absPath) {
  return findPublishedSurfaceViolations(
    readFileSync(absPath, "utf-8"),
    relative(REPO_ROOT, absPath),
  );
}

/** Scan every published README and built declaration file. */
export function checkNoInternalIds() {
  const surfaces = [];
  const packagesDir = resolve(REPO_ROOT, "packages");
  const distMissing = [];

  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir).sort()) {
      const pkgDir = join(packagesDir, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;

      surfaces.push(...collectPublishedReadmes(pkgDir));

      const distDir = join(pkgDir, "dist");
      if (!existsSync(distDir)) {
        distMissing.push(relative(REPO_ROOT, distDir));
        continue;
      }
      surfaces.push(...collectDeclarationFiles(distDir).sort());
    }
  }

  const violations = [];
  for (const surface of surfaces) {
    violations.push(...scanFile(surface));
  }

  return { violations, scannedFileCount: surfaces.length, distMissing };
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const invokedDirectly =
  process.argv[1] &&
  canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { violations, scannedFileCount, distMissing } = checkNoInternalIds();

  if (distMissing.length > 0) {
    process.stderr.write(
      `[check-no-internal-ids] declaration files not found for: ${distMissing.join(
        ", ",
      )}\n` +
        `  Run \`npm run build\` first — this guard scans the generated ` +
        `.d.ts / .d.cts files that ship to consumers.\n`,
    );
    process.exit(2);
  }

  if (violations.length > 0) {
    process.stderr.write(
      `[check-no-internal-ids] FAIL — forbidden internal references found ` +
        `in ${String(violations.length)} published-surface reference(s):\n\n`,
    );
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.file}:${String(violation.line)}  ` +
          `(${violation.kind}: ${violation.match})\n`,
      );
      process.stderr.write(`    ${violation.text}\n`);
    }
    process.stderr.write(
      `\n  Internal tracking IDs and private Product repository paths must ` +
        `not appear in published package READMEs or generated declarations. ` +
        `Rewrite the reference in public, path-free language.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[check-no-internal-ids] OK — no forbidden internal references on ` +
      `${String(scannedFileCount)} published-surface file(s).\n`,
  );
}
