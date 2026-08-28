import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const API_ROOT = "https://api.github.com";
// GitHub exposes an App bot with different login shapes across its APIs.
const CODEX_GRAPHQL_LOGIN = "chatgpt-codex-connector";
const CODEX_REST_LOGIN = "chatgpt-codex-connector[bot]";
const VERSION_PR_HEAD = "changeset-release/main";
const VERSION_PR_TITLE = "chore: version packages";
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const KNOWN_ASSOCIATIONS = new Set([
  ...TRUSTED_ASSOCIATIONS,
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "NONE",
]);
const KNOWN_PERMISSIONS = new Set(["admin", "write", "read", "none"]);

export const REQUIRED_RELEASE_CHECKS = [
  { app: "github-actions", name: "Lint, Typecheck, Test, Build (20)" },
  { app: "github-actions", name: "Lint, Typecheck, Test, Build (22)" },
  { app: "github-actions", name: "Browser import check" },
  { app: "github-actions", name: "Compatibility (min peer deps)" },
  {
    app: "github-actions",
    name: "Next.js compatibility (webpack + Turbopack)",
  },
  { app: "github-actions", name: "Code Scanning" },
  { app: "github-advanced-security", name: "CodeQL" },
];

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned malformed data.`);
  }
  return value;
}

function assertSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character SHA.`);
  }
  return value;
}

function assertLogin(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)
  ) {
    throw new Error(`${label} must be a valid GitHub login.`);
  }
  return value;
}

function assertActorLogin(value, label) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})(?:\[bot\])?$/.test(value)
  ) {
    throw new Error(`${label} must be a valid GitHub actor login.`);
  }
  return value;
}

function parseTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    throw new Error(`${label} has an invalid timestamp.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} has an invalid timestamp.`);
  }
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  if (new Date(timestamp).toISOString() !== canonical) {
    throw new Error(`${label} has an invalid timestamp.`);
  }
  return timestamp;
}

function repositoryParts(repository) {
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error("GITHUB_REPOSITORY must be in owner/name form.");
  }
  return { owner: parts[0], name: parts[1] };
}

function encodePath(value) {
  return encodeURIComponent(value);
}

export function createGitHubApi({ token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("GITHUB_TOKEN is required for stable release readiness.");
  }

  async function request(path, { body, method = "GET" } = {}) {
    const response = await fetchImpl(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `GitHub API ${method} ${path} failed (${response.status}): ${detail.slice(0, 500)}`,
      );
    }
    return response.json();
  }

  async function paginatedArray(path) {
    const items = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(data)) {
        throw new Error(`GitHub API ${path} did not return an array.`);
      }
      items.push(...data);
      if (data.length < 100) return items;
    }
    throw new Error(`GitHub API pagination exceeded 100 pages for ${path}.`);
  }

  const permissionRequests = new Map();

  return {
    async mainTip(repository) {
      const data = assertObject(
        await request(`/repos/${repository}/git/ref/heads/main`),
        "Main ref",
      );
      return assertSha(assertObject(data.object, "Main ref object").sha, "Main tip");
    },

    associatedPullRequests(repository, sha) {
      return paginatedArray(
        `/repos/${repository}/commits/${encodePath(sha)}/pulls`,
      );
    },

    reviews(repository, number) {
      return paginatedArray(`/repos/${repository}/pulls/${number}/reviews`);
    },

    collaboratorPermission(repository, login) {
      repositoryParts(repository);
      const requestedLogin = assertLogin(login, "Review author login");
      const cacheKey = `${repository.toLowerCase()}\0${requestedLogin.toLowerCase()}`;
      if (!permissionRequests.has(cacheKey)) {
        permissionRequests.set(
          cacheKey,
          (async () => {
            const data = assertObject(
              await request(
                `/repos/${repository}/collaborators/${encodePath(requestedLogin)}/permission`,
              ),
              "Collaborator permission",
            );
            const responseLogin = assertLogin(
              assertObject(data.user, "Collaborator permission user").login,
              "Collaborator permission user login",
            );
            if (
              responseLogin.toLowerCase() !== requestedLogin.toLowerCase()
            ) {
              throw new Error(
                `Collaborator permission response login ${responseLogin} does not match ${requestedLogin}.`,
              );
            }
            if (typeof data.permission !== "string") {
              throw new Error(
                "Collaborator permission response has no permission string.",
              );
            }
            if (!KNOWN_PERMISSIONS.has(data.permission)) {
              throw new Error(
                `Collaborator permission response has unexpected permission ${data.permission}.`,
              );
            }
            return data.permission;
          })(),
        );
      }
      return permissionRequests.get(cacheKey);
    },

    issueComments(repository, number) {
      return paginatedArray(`/repos/${repository}/issues/${number}/comments`);
    },

    async checkRuns(repository, sha) {
      const runs = [];
      for (let page = 1; page <= 100; page += 1) {
        const data = assertObject(
          await request(
            `/repos/${repository}/commits/${encodePath(sha)}/check-runs?filter=latest&per_page=100&page=${page}`,
          ),
          "Check runs",
        );
        if (!Array.isArray(data.check_runs)) {
          throw new Error("Check runs response has no check_runs array.");
        }
        runs.push(...data.check_runs);
        if (data.check_runs.length < 100) return runs;
        if (
          typeof data.total_count === "number" &&
          runs.length >= data.total_count
        ) {
          return runs;
        }
      }
      throw new Error("Check-run pagination exceeded 100 pages.");
    },

    async resolveCommit(repository, ref) {
      const data = assertObject(
        await request(`/repos/${repository}/commits/${encodePath(ref)}`),
        "Commit",
      );
      return assertSha(data.sha, "Resolved commit");
    },

    async commitTree(repository, sha) {
      const data = assertObject(
        await request(`/repos/${repository}/commits/${encodePath(sha)}`),
        "Commit",
      );
      return assertSha(
        assertObject(assertObject(data.commit, "Commit data").tree, "Commit tree")
          .sha,
        "Commit tree SHA",
      );
    },

    async reviewState(repository, number) {
      const { owner, name } = repositoryParts(repository);
      const query = `
        query ReleaseReviewState(
          $owner: String!
          $name: String!
          $number: Int!
          $after: String
        ) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes {
                  isResolved
                  comments(first: 1) {
                    nodes {
                      author { __typename login }
                      authorAssociation
                      createdAt
                    }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      `;
      let after = null;
      const unresolvedThreads = [];
      for (let page = 1; page <= 100; page += 1) {
        const data = assertObject(
          await request("/graphql", {
            body: { query, variables: { owner, name, number, after } },
            method: "POST",
          }),
          "GraphQL review state",
        );
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          throw new Error(
            `GitHub GraphQL review state failed: ${JSON.stringify(data.errors).slice(0, 500)}`,
          );
        }
        const repositoryData = assertObject(data.data, "GraphQL data").repository;
        const pullRequest = assertObject(
          assertObject(repositoryData, "GraphQL repository").pullRequest,
          "GraphQL pull request",
        );
        const threads = assertObject(
          pullRequest.reviewThreads,
          "GraphQL review threads",
        );
        if (!Array.isArray(threads.nodes)) {
          throw new Error("GraphQL review threads has no nodes array.");
        }
        for (const rawThread of threads.nodes) {
          const thread = assertObject(rawThread, "Review thread");
          if (typeof thread.isResolved !== "boolean") {
            throw new Error("Review thread has no isResolved boolean.");
          }
          if (thread.isResolved) continue;
          const comments = assertObject(
            thread.comments,
            "Review thread comments",
          );
          if (!Array.isArray(comments.nodes) || comments.nodes.length !== 1) {
            throw new Error(
              "Unresolved review thread must have exactly one root comment.",
            );
          }
          const root = assertObject(
            comments.nodes[0],
            "Review thread root comment",
          );
          let authorLogin = null;
          let authorType = null;
          if (root.author !== null) {
            const author = assertObject(
              root.author,
              "Review thread root comment author",
            );
            if (
              typeof author.__typename !== "string" ||
              author.__typename === ""
            ) {
              throw new Error(
                "Review thread root comment author has no type name.",
              );
            }
            authorType = author.__typename;
            authorLogin = assertActorLogin(
              author.login,
              "Review thread root comment author login",
            );
          }
          if (
            typeof root.authorAssociation !== "string" ||
            !KNOWN_ASSOCIATIONS.has(root.authorAssociation)
          ) {
            throw new Error(
              "Review thread root comment has an invalid author association.",
            );
          }
          parseTimestamp(root.createdAt, "Review thread root comment");
          unresolvedThreads.push({
            authorAssociation: root.authorAssociation,
            authorLogin,
            authorType,
            createdAt: root.createdAt,
          });
        }
        const pageInfo = assertObject(
          threads.pageInfo,
          "GraphQL review thread page info",
        );
        if (pageInfo.hasNextPage !== true) {
          return { unresolvedThreads };
        }
        if (
          typeof pageInfo.endCursor !== "string" ||
          pageInfo.endCursor === ""
        ) {
          throw new Error("Review-thread pagination has no end cursor.");
        }
        after = pageInfo.endCursor;
      }
      throw new Error("Review-thread pagination exceeded 100 pages.");
    },
  };
}

function chronologicalByTimestamp(items, timestampField) {
  const sortable = [...items];
  for (const item of sortable) {
    parseTimestamp(item?.[timestampField], `Review evidence ${timestampField}`);
    if (!Number.isSafeInteger(item?.id)) {
      throw new Error("Review evidence has an invalid id.");
    }
  }
  return sortable.sort((left, right) => {
    const leftTime = Date.parse(left[timestampField]);
    const rightTime = Date.parse(right[timestampField]);
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id - right.id;
  });
}

function assertRequiredChecks(checkRuns, headSha) {
  for (const required of REQUIRED_RELEASE_CHECKS) {
    const matching = checkRuns.filter(
      (run) => run?.name === required.name && run?.app?.slug === required.app,
    );
    if (matching.length === 0) {
      throw new Error(
        `Required release check is missing: ${required.name} (${required.app}).`,
      );
    }
    if (matching.some((run) => !Number.isSafeInteger(run?.id))) {
      throw new Error(`Required release check has an invalid id: ${required.name}.`);
    }
    const latest = [...matching].sort((left, right) => left.id - right.id).at(-1);
    if (latest?.head_sha !== headSha) {
      throw new Error(`Required release check has the wrong head SHA: ${required.name}.`);
    }
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(
        `Required release check is not successful: ${required.name} is ${String(latest.status)}/${String(latest.conclusion)}.`,
      );
    }
  }
}

function hasTrustedAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(value);
}

function hasWritePermission(value) {
  if (!KNOWN_PERMISSIONS.has(value)) {
    throw new Error(
      `Collaborator permission response has unexpected permission ${String(value)}.`,
    );
  }
  return value === "write" || value === "admin";
}

async function assertHumanApproval(api, repository, reviews, headSha) {
  const decisiveStates = new Set(["APPROVED", "CHANGES_REQUESTED"]);
  const latestByReviewer = new Map();
  for (const review of chronologicalByTimestamp(reviews, "submitted_at")) {
    if (review?.user?.type !== "User" || !decisiveStates.has(review.state)) {
      continue;
    }
    if (!hasTrustedAssociation(review.author_association)) continue;
    const login = assertLogin(review.user.login, "Review author login");
    latestByReviewer.set(login.toLowerCase(), { login, review });
  }

  const latestReviews = [];
  for (const { login, review } of latestByReviewer.values()) {
    const permission = await api.collaboratorPermission(repository, login);
    if (hasWritePermission(permission)) latestReviews.push(review);
  }
  if (latestReviews.some((review) => review.state === "CHANGES_REQUESTED")) {
    throw new Error("The Version Packages PR has an outstanding changes-requested review.");
  }
  if (
    !latestReviews.some(
      (review) => review.state === "APPROVED" && review.commit_id === headSha,
    )
  ) {
    throw new Error(
      "The Version Packages PR requires a human APPROVED review on its exact head SHA.",
    );
  }
}

async function assertReviewThreads(
  api,
  repository,
  reviewState,
  mergedAt,
) {
  const state = assertObject(reviewState, "Review state");
  if (!Array.isArray(state.unresolvedThreads)) {
    throw new Error("Review state has no unresolvedThreads array.");
  }
  const mergeTimestamp = parseTimestamp(mergedAt, "Version Packages PR merge");
  let blockingCount = 0;
  for (const rawThread of state.unresolvedThreads) {
    const thread = assertObject(rawThread, "Unresolved review thread");
    const createdAt = parseTimestamp(
      thread.createdAt,
      "Review thread root comment",
    );
    if (
      typeof thread.authorAssociation !== "string" ||
      !KNOWN_ASSOCIATIONS.has(thread.authorAssociation)
    ) {
      throw new Error("Review thread root comment has malformed author data.");
    }

    if (createdAt <= mergeTimestamp) {
      blockingCount += 1;
      continue;
    }

    // `author` is nullable in GitHub's GraphQL schema. A deleted or otherwise
    // unavailable post-merge actor cannot prove trusted authority and must not
    // let a public account deny publication. Pre-merge roots already blocked
    // above regardless of identity.
    if (thread.authorType === null && thread.authorLogin === null) continue;
    if (
      typeof thread.authorType !== "string" ||
      thread.authorType === "" ||
      thread.authorLogin === null
    ) {
      throw new Error("Review thread root comment has malformed author data.");
    }
    const authorLogin = assertActorLogin(
      thread.authorLogin,
      "Review thread root comment author login",
    );
    if (
      thread.authorType === "Bot" &&
      authorLogin === CODEX_GRAPHQL_LOGIN
    ) {
      blockingCount += 1;
      continue;
    }
    if (
      thread.authorType === "User" &&
      hasTrustedAssociation(thread.authorAssociation)
    ) {
      const permission = await api.collaboratorPermission(
        repository,
        authorLogin,
      );
      if (hasWritePermission(permission)) blockingCount += 1;
    }
  }
  if (blockingCount !== 0) {
    throw new Error(
      `The Version Packages PR has ${blockingCount} blocking unresolved review thread(s).`,
    );
  }
}

async function assertCleanCodexReview(
  api,
  repository,
  comments,
  reviews,
  acceptableShas,
) {
  const accepted = new Set(acceptableShas);
  const artifacts = reviews
    .filter(
      (review) =>
        review?.user?.login === CODEX_REST_LOGIN &&
        review?.user?.type === "Bot" &&
        accepted.has(review?.commit_id),
    )
    .map((review) => ({
      clean: false,
      created_at: review.submitted_at,
      id: review.id,
    }));
  for (const comment of comments) {
    if (
      comment?.user?.login !== CODEX_REST_LOGIN ||
      comment?.user?.type !== "Bot" ||
      typeof comment.body !== "string"
    ) {
      continue;
    }
    const marker = /\*\*Reviewed commit:\*\* `([0-9a-f]{10})`/.exec(
      comment.body,
    );
    if (
      marker === null ||
      ![...accepted].some((sha) => sha.startsWith(marker[1]))
    ) {
      continue;
    }
    const resolved = await api.resolveCommit(repository, marker[1]);
    if (!accepted.has(resolved)) continue;
    artifacts.push({
      ...comment,
      clean: comment.body.includes(
        "Codex Review: Didn't find any major issues.",
      ),
    });
  }

  const chronological = chronologicalByTimestamp(artifacts, "created_at");
  if (chronological.length === 0) {
    throw new Error(
      "The Version Packages PR has no Codex review artifact bound to either proven release-tree SHA.",
    );
  }
  const latestTime = Date.parse(chronological.at(-1).created_at);
  const latestArtifacts = chronological.filter(
    (artifact) => Date.parse(artifact.created_at) === latestTime,
  );
  // PR-review IDs and issue-comment IDs are unrelated namespaces. If clean
  // and finding-bearing artifacts share GitHub's one-second timestamp
  // resolution, there is no trustworthy cross-surface ordering; fail closed.
  if (latestArtifacts.some((artifact) => artifact.clean !== true)) {
    throw new Error(
      "The latest proven-tree Codex review artifact is not a clean review.",
    );
  }
}

export async function verifyStableReleaseReadiness({
  api,
  candidateSha,
  repository,
}) {
  const sha = assertSha(candidateSha, "Stable candidate");
  repositoryParts(repository);

  const liveMainTip = await api.mainTip(repository);
  if (liveMainTip !== sha) {
    throw new Error(
      `Stable candidate ${sha} is stale; live main is ${liveMainTip}. Dispatch stable again from the current main tip.`,
    );
  }

  const associatedPullRequests = await api.associatedPullRequests(
    repository,
    sha,
  );
  const mergedAtCandidate = associatedPullRequests.filter(
    (pullRequest) => pullRequest?.merge_commit_sha === sha,
  );
  if (mergedAtCandidate.length !== 1) {
    throw new Error(
      `Expected exactly one pull request merged as ${sha}; found ${mergedAtCandidate.length}.`,
    );
  }
  const pullRequest = mergedAtCandidate[0];
  if (
    pullRequest.merged_at === null ||
    typeof pullRequest.merged_at !== "string" ||
    pullRequest.draft !== false ||
    pullRequest.base?.ref !== "main" ||
    pullRequest.head?.ref !== VERSION_PR_HEAD ||
    pullRequest.head?.repo?.full_name !== repository ||
    pullRequest.title !== VERSION_PR_TITLE
  ) {
    throw new Error(
      "Stable candidate is not the exact merged, non-draft Changesets Version Packages PR.",
    );
  }
  parseTimestamp(pullRequest.merged_at, "Version Packages PR merge");
  const headSha = assertSha(pullRequest.head?.sha, "Version Packages PR head");

  const [candidateTree, headTree] = await Promise.all([
    api.commitTree(repository, sha),
    api.commitTree(repository, headSha),
  ]);
  if (candidateTree !== headTree) {
    throw new Error(
      "Stable candidate tree does not exactly match the reviewed Version Packages PR head tree.",
    );
  }

  const [checkRuns, reviews, comments, reviewState] = await Promise.all([
    api.checkRuns(repository, headSha),
    api.reviews(repository, pullRequest.number),
    api.issueComments(repository, pullRequest.number),
    api.reviewState(repository, pullRequest.number),
  ]);
  assertRequiredChecks(checkRuns, headSha);
  await assertHumanApproval(api, repository, reviews, headSha);
  // A hosted review requested after a squash merge binds to the merge commit,
  // not the PR head. Their trees were proven identical above, so either SHA is
  // valid Codex evidence; human approvals and required checks remain pinned to
  // the PR head.
  await assertCleanCodexReview(
    api,
    repository,
    comments,
    reviews,
    [headSha, sha],
  );
  await assertReviewThreads(
    api,
    repository,
    reviewState,
    pullRequest.merged_at,
  );

  const finalMainTip = await api.mainTip(repository);
  if (finalMainTip !== sha) {
    throw new Error(
      `Stable candidate ${sha} became stale during readiness verification; live main is now ${finalMainTip}.`,
    );
  }

  return { headSha, pullRequestNumber: pullRequest.number };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const candidateSha = process.env.GITHUB_SHA ?? "";
  const api = createGitHubApi({ token: process.env.GITHUB_TOKEN ?? "" });
  const result = await verifyStableReleaseReadiness({
    api,
    candidateSha,
    repository,
  });
  process.stdout.write(
    `Stable release readiness passed for Version Packages PR #${result.pullRequestNumber} at ${result.headSha}.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `::error::${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
