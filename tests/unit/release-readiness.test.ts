import { describe, expect, it, vi } from "vitest";
import {
  createGitHubApi,
  REQUIRED_RELEASE_CHECKS,
  verifyStableReleaseReadiness,
} from "../../scripts/check-stable-release-readiness.mjs";

const repository = "Erik-1259/glasstrace-sdk";
const candidateSha = "a".repeat(40);
const headSha = "b".repeat(40);
const treeSha = "c".repeat(40);

function requiredChecks() {
  return REQUIRED_RELEASE_CHECKS.map((required, index) => ({
    app: { slug: required.app },
    conclusion: "success",
    head_sha: headSha,
    id: index + 1,
    name: required.name,
    status: "completed",
  }));
}

function versionPullRequest() {
  return {
    base: { ref: "main" },
    draft: false,
    head: {
      ref: "changeset-release/main",
      repo: { full_name: repository },
      sha: headSha,
    },
    merge_commit_sha: candidateSha,
    merged_at: "2026-08-27T20:00:00Z",
    number: 400,
    title: "chore: version packages",
  };
}

function humanApproval(overrides = {}) {
  return {
    author_association: "MEMBER",
    commit_id: headSha,
    id: 1,
    state: "APPROVED",
    submitted_at: "2026-08-27T19:58:00Z",
    user: { login: "release-reviewer", type: "User" },
    ...overrides,
  };
}

function unresolvedThread(overrides = {}) {
  return {
    authorAssociation: "NONE",
    authorLogin: "outside-reviewer",
    authorType: "User",
    createdAt: "2026-08-27T19:59:00Z",
    ...overrides,
  };
}

function cleanCodexComment(overrides = {}) {
  return {
    body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
    created_at: "2026-08-27T19:59:00Z",
    id: 2,
    user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    ...overrides,
  };
}

type ReleaseApi = {
  associatedPullRequests: (
    repositoryName: string,
    sha: string,
  ) => Promise<unknown[]>;
  checkRuns: (repositoryName: string, sha: string) => Promise<unknown[]>;
  collaboratorPermission: (
    repositoryName: string,
    login: string,
  ) => Promise<string>;
  commitTree: (repositoryName: string, sha: string) => Promise<string>;
  issueComments: (
    repositoryName: string,
    number: number,
  ) => Promise<unknown[]>;
  mainTip: (repositoryName: string) => Promise<string>;
  resolveCommit: (repositoryName: string, ref: string) => Promise<string>;
  reviews: (repositoryName: string, number: number) => Promise<unknown[]>;
  reviewState: (
    repositoryName: string,
    number: number,
  ) => Promise<{ unresolvedThreads: unknown[] }>;
};

function validApi(overrides: Partial<ReleaseApi> = {}): ReleaseApi {
  return {
    associatedPullRequests: async () => [versionPullRequest()],
    checkRuns: async () => requiredChecks(),
    collaboratorPermission: async () => "write",
    commitTree: async () => treeSha,
    issueComments: async () => [cleanCodexComment()],
    mainTip: async () => candidateSha,
    resolveCommit: async () => headSha,
    reviews: async () => [humanApproval()],
    reviewState: async () => ({ unresolvedThreads: [] }),
    ...overrides,
  };
}

function verify(api: ReleaseApi) {
  return verifyStableReleaseReadiness({ api, candidateSha, repository });
}

describe("stable release readiness", () => {
  it("accepts only the exact reviewed and checked Version Packages candidate", async () => {
    await expect(verify(validApi())).resolves.toEqual({
      headSha,
      pullRequestNumber: 400,
    });
  });

  it("rejects a queued candidate after live main advances", async () => {
    await expect(
      verify(validApi({ mainTip: async () => "d".repeat(40) })),
    ).rejects.toThrow("is stale; live main is");
  });

  it("rejects main advancing while review evidence is evaluated", async () => {
    const mainTip = vi
      .fn<ReleaseApi["mainTip"]>()
      .mockResolvedValueOnce(candidateSha)
      .mockResolvedValueOnce("d".repeat(40));

    await expect(verify(validApi({ mainTip }))).rejects.toThrow(
      "became stale during readiness verification",
    );
    expect(mainTip).toHaveBeenCalledTimes(2);
  });

  it("rejects missing or ambiguous merge-commit associations", async () => {
    await expect(
      verify(validApi({ associatedPullRequests: async () => [] })),
    ).rejects.toThrow("found 0");
    await expect(
      verify(
        validApi({
          associatedPullRequests: async () => [
            versionPullRequest(),
            { ...versionPullRequest(), number: 401 },
          ],
        }),
      ),
    ).rejects.toThrow("found 2");
  });

  it("rejects a lookalike fork PR or a candidate tree changed at merge", async () => {
    await expect(
      verify(
        validApi({
          associatedPullRequests: async () => [
            {
              ...versionPullRequest(),
              head: {
                ...versionPullRequest().head,
                repo: { full_name: "attacker/fork" },
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow("not the exact merged");

    await expect(
      verify(
        validApi({
          commitTree: async (_repositoryName, sha) =>
            sha === candidateSha ? "c".repeat(40) : "d".repeat(40),
        }),
      ),
    ).rejects.toThrow("tree does not exactly match");
  });

  it("rejects missing, skipped, or wrong-head required checks", async () => {
    await expect(
      verify(validApi({ checkRuns: async () => requiredChecks().slice(1) })),
    ).rejects.toThrow("Required release check is missing");

    const skipped = requiredChecks();
    skipped[0] = { ...skipped[0], conclusion: "skipped" };
    await expect(
      verify(validApi({ checkRuns: async () => skipped })),
    ).rejects.toThrow("completed/skipped");

    const wrongHead = requiredChecks();
    wrongHead[0] = { ...wrongHead[0], head_sha: "e".repeat(40) };
    await expect(
      verify(validApi({ checkRuns: async () => wrongHead })),
    ).rejects.toThrow("wrong head SHA");
  });

  it("does not let an older success mask a newer queued or failed rerun", async () => {
    for (const conclusion of [null, "failure"]) {
      const checks = requiredChecks();
      checks.push({
        ...checks[0],
        conclusion,
        id: 10_000,
        status: conclusion === null ? "queued" : "completed",
      });
      await expect(
        verify(validApi({ checkRuns: async () => checks })),
      ).rejects.toThrow("Required release check is not successful");
    }

    const malformed = requiredChecks();
    malformed.push({ ...malformed[0], id: null });
    await expect(
      verify(validApi({ checkRuns: async () => malformed })),
    ).rejects.toThrow("Required release check has an invalid id");
  });

  it("requires a current trusted approval and rejects trusted outstanding changes", async () => {
    await expect(
      verify(validApi({ reviews: async () => [] })),
    ).rejects.toThrow("requires a human APPROVED review");
    await expect(
      verify(
        validApi({
          reviews: async () => [
            humanApproval({ commit_id: "f".repeat(40) }),
          ],
        }),
      ),
    ).rejects.toThrow("exact head SHA");
    await expect(
      verify(
        validApi({
          reviews: async () => [
            humanApproval(),
            humanApproval({
              id: 2,
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-08-27T19:59:30Z",
            }),
          ],
        }),
      ),
    ).rejects.toThrow("outstanding changes-requested");
  });

  it("ignores outsider decisions without allowing permission-lookup denial of service", async () => {
    const collaboratorPermission = vi.fn<ReleaseApi["collaboratorPermission"]>(
      async () => {
        throw new Error("outsider must not reach the permission endpoint");
      },
    );
    await expect(
      verify(
        validApi({
          collaboratorPermission,
          reviews: async () => [
            humanApproval({
              author_association: "NONE",
              user: { login: "outside-reviewer", type: "User" },
            }),
          ],
        }),
      ),
    ).rejects.toThrow("requires a human APPROVED review");
    expect(collaboratorPermission).not.toHaveBeenCalled();

    await expect(
      verify(
        validApi({
          collaboratorPermission: async () => "write",
          reviews: async () => [
            humanApproval(),
            humanApproval({
              author_association: "NONE",
              id: 2,
              state: "CHANGES_REQUESTED",
              user: { login: "outside-reviewer", type: "User" },
            }),
          ],
        }),
      ),
    ).resolves.toMatchObject({ headSha });
  });

  it("accepts only live write or admin permission for decisive reviews", async () => {
    for (const permission of ["read", "none"]) {
      await expect(
        verify(
          validApi({
            collaboratorPermission: async () => permission,
          }),
        ),
      ).rejects.toThrow("requires a human APPROVED review");
    }
    for (const permission of ["write", "admin"]) {
      await expect(
        verify(
          validApi({
            collaboratorPermission: async () => permission,
          }),
        ),
      ).resolves.toMatchObject({ headSha });
    }
    await expect(
      verify(
        validApi({
          collaboratorPermission: async () => "unexpected-role",
        }),
      ),
    ).rejects.toThrow("unexpected permission unexpected-role");
  });

  it("uses each trusted reviewer's latest decisive review", async () => {
    await expect(
      verify(
        validApi({
          reviews: async () => [
            humanApproval({ state: "CHANGES_REQUESTED" }),
            humanApproval({
              id: 2,
              state: "APPROVED",
              submitted_at: "2026-08-27T19:59:00Z",
            }),
          ],
        }),
      ),
    ).resolves.toMatchObject({ headSha });
  });

  it("requires the latest Codex clean artifact to resolve to the exact head", async () => {
    await expect(
      verify(
        validApi({
          issueComments: async () => [
            cleanCodexComment({
              user: { login: "lookalike-codex[bot]", type: "Bot" },
            }),
          ],
        }),
      ),
    ).rejects.toThrow("no Codex review artifact");

    await expect(
      verify(validApi({ resolveCommit: async () => "f".repeat(40) })),
    ).rejects.toThrow("no Codex review artifact");

    await expect(
      verify(
        validApi({
          issueComments: async () => [
            cleanCodexComment(),
            cleanCodexComment({
              body: `Codex Review: found a release issue.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
              created_at: "2026-08-27T20:00:00Z",
              id: 3,
            }),
          ],
        }),
      ),
    ).rejects.toThrow(
      "latest proven-tree Codex review artifact is not a clean review",
    );

    await expect(
      verify(
        validApi({
          reviews: async () => [
            humanApproval(),
            {
              body: "Codex found a release issue.",
              commit_id: headSha,
              id: 4,
              state: "COMMENTED",
              // Equal-second IDs from PR reviews and issue comments are not
              // comparable. A finding tied with the clean comment fails shut.
              submitted_at: "2026-08-27T19:59:00Z",
              user: {
                login: "chatgpt-codex-connector[bot]",
                type: "Bot",
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(
      "latest proven-tree Codex review artifact is not a clean review",
    );
  });

  it("accepts Codex evidence on either proven tree-identical release SHA", async () => {
    await expect(
      verify(
        validApi({
          issueComments: async () => [
            cleanCodexComment({
              body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${candidateSha.slice(0, 10)}\``,
            }),
          ],
          resolveCommit: async (_repositoryName, ref) =>
            ref === candidateSha.slice(0, 10) ? candidateSha : headSha,
        }),
      ),
    ).resolves.toMatchObject({ headSha });

    await expect(
      verify(
        validApi({
          reviews: async () => [
            humanApproval(),
            {
              body: "Codex found a release issue after merge.",
              commit_id: candidateSha,
              id: 4,
              state: "COMMENTED",
              submitted_at: "2026-08-27T20:01:00Z",
              user: {
                login: "chatgpt-codex-connector[bot]",
                type: "Bot",
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(
      "latest proven-tree Codex review artifact is not a clean review",
    );
  });

  it("blocks all pre-merge unresolved threads", async () => {
    await expect(
      verify(
        validApi({
          reviewState: async () => ({
            unresolvedThreads: [unresolvedThread()],
          }),
        }),
      ),
    ).rejects.toThrow("1 blocking unresolved review thread");
  });

  it("blocks only Codex or a currently trusted writer after merge", async () => {
    const postMerge = "2026-08-27T20:01:00Z";
    const collaboratorPermission = vi.fn<ReleaseApi["collaboratorPermission"]>(
      async () => "write",
    );
    await expect(
      verify(
        validApi({
          collaboratorPermission,
          reviewState: async () => ({
            unresolvedThreads: [unresolvedThread({ createdAt: postMerge })],
          }),
        }),
      ),
    ).resolves.toMatchObject({ headSha });
    expect(collaboratorPermission).toHaveBeenCalledTimes(1);
    expect(collaboratorPermission).toHaveBeenCalledWith(
      repository,
      "release-reviewer",
    );

    await expect(
      verify(
        validApi({
          reviewState: async () => ({
            unresolvedThreads: [
              unresolvedThread({
                authorAssociation: "NONE",
                authorLogin: "chatgpt-codex-connector",
                authorType: "Bot",
                createdAt: postMerge,
              }),
            ],
          }),
        }),
      ),
    ).rejects.toThrow("1 blocking unresolved review thread");

    await expect(
      verify(
        validApi({
          reviewState: async () => ({
            unresolvedThreads: [
              unresolvedThread({
                authorAssociation: "MEMBER",
                authorLogin: "release-reviewer",
                createdAt: postMerge,
              }),
            ],
          }),
        }),
      ),
    ).rejects.toThrow("1 blocking unresolved review thread");
  });

  it("ignores a post-merge trusted-association author without current write permission", async () => {
    await expect(
      verify(
        validApi({
          collaboratorPermission: async (_repositoryName, login) =>
            login === "release-reviewer" ? "write" : "read",
          reviewState: async () => ({
            unresolvedThreads: [
              unresolvedThread({
                authorAssociation: "COLLABORATOR",
                authorLogin: "former-writer",
                createdAt: "2026-08-27T20:01:00Z",
              }),
            ],
          }),
        }),
      ),
    ).resolves.toMatchObject({ headSha });
  });

  it("blocks a nullable pre-merge author but ignores one after merge", async () => {
    await expect(
      verify(
        validApi({
          reviewState: async () => ({
            unresolvedThreads: [
              unresolvedThread({ authorLogin: null, authorType: null }),
            ],
          }),
        }),
      ),
    ).rejects.toThrow("1 blocking unresolved review thread");

    await expect(
      verify(
        validApi({
          reviewState: async () => ({
            unresolvedThreads: [
              unresolvedThread({
                authorLogin: null,
                authorType: null,
                createdAt: "2026-08-27T20:01:00Z",
              }),
            ],
          }),
        }),
      ),
    ).resolves.toMatchObject({ headSha });
  });

  it("fails closed on malformed thread and review timestamps", async () => {
    for (const createdAt of ["not-a-time", "2026-02-31T20:01:00Z"]) {
      await expect(
        verify(
          validApi({
            reviewState: async () => ({
              unresolvedThreads: [unresolvedThread({ createdAt })],
            }),
          }),
        ),
      ).rejects.toThrow("invalid timestamp");
    }
    await expect(
      verify(
        validApi({
          issueComments: async () => [
            cleanCodexComment({ created_at: null }),
          ],
        }),
      ),
    ).rejects.toThrow("invalid timestamp");
  });
});

describe("GitHub readiness API", () => {
  it("paginates REST comments and sends GraphQL JSON with an explicit content type", async () => {
    const calls: { init: RequestInit; url: string }[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    let graphqlPage = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit) => {
      const url = String(input);
      calls.push({ init, url });
      if (url.endsWith("page=1")) {
        return new Response(JSON.stringify(firstPage), { status: 200 });
      }
      if (url.endsWith("page=2")) {
        return new Response(JSON.stringify([{ id: 100 }]), { status: 200 });
      }
      graphqlPage += 1;
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes:
                    graphqlPage === 1
                      ? [{ isResolved: true, comments: { nodes: [] } }]
                      : [
                          {
                            comments: {
                              nodes: [
                                {
                                  author: {
                                    __typename: "User",
                                    login: "outside-reviewer",
                                  },
                                  authorAssociation: "NONE",
                                  createdAt: "2026-08-27T20:01:00Z",
                                },
                              ],
                            },
                            isResolved: false,
                          },
                        ],
                  pageInfo:
                    graphqlPage === 1
                      ? { endCursor: "page-2", hasNextPage: true }
                      : { endCursor: null, hasNextPage: false },
                },
              },
            },
          },
        }),
        { status: 200 },
      );
    });
    const api = createGitHubApi({ fetchImpl, token: "test-token" });

    await expect(api.issueComments(repository, 400)).resolves.toHaveLength(101);
    await expect(api.reviewState(repository, 400)).resolves.toEqual({
      unresolvedThreads: [
        {
          authorAssociation: "NONE",
          authorLogin: "outside-reviewer",
          authorType: "User",
          createdAt: "2026-08-27T20:01:00Z",
        },
      ],
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/Erik-1259/glasstrace-sdk/issues/400/comments?per_page=100&page=1",
      "https://api.github.com/repos/Erik-1259/glasstrace-sdk/issues/400/comments?per_page=100&page=2",
      "https://api.github.com/graphql",
      "https://api.github.com/graphql",
    ]);
    expect(calls[2].init.method).toBe("POST");
    expect(calls[2].init.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    const graphqlQuery = JSON.parse(String(calls[2].init.body)).query;
    expect(graphqlQuery).toContain("comments(first: 1)");
    expect(graphqlQuery).toContain("author { __typename login }");
    expect(graphqlQuery).toContain("authorAssociation");
    expect(graphqlQuery).toContain("createdAt");
    expect(JSON.parse(String(calls[3].init.body)).variables.after).toBe(
      "page-2",
    );
  });

  it("caches validated collaborator permission lookups", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          permission: "write",
          user: { login: "Release-Reviewer" },
        }),
        { status: 200 },
      ),
    );
    const api = createGitHubApi({ fetchImpl, token: "test-token" });

    await expect(
      api.collaboratorPermission(repository, "release-reviewer"),
    ).resolves.toBe("write");
    await expect(
      api.collaboratorPermission(repository, "Release-Reviewer"),
    ).resolves.toBe("write");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/Erik-1259/glasstrace-sdk/collaborators/release-reviewer/permission",
    );
  });

  it("preserves a schema-valid nullable review-thread author", async () => {
    const api = createGitHubApi({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        comments: {
                          nodes: [
                            {
                              author: null,
                              authorAssociation: "NONE",
                              createdAt: "2026-08-27T20:01:00Z",
                            },
                          ],
                        },
                        isResolved: false,
                      },
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            },
          }),
          { status: 200 },
        ),
      token: "test-token",
    });

    await expect(api.reviewState(repository, 400)).resolves.toEqual({
      unresolvedThreads: [
        {
          authorAssociation: "NONE",
          authorLogin: null,
          authorType: null,
          createdAt: "2026-08-27T20:01:00Z",
        },
      ],
    });
  });

  it("rejects a collaborator permission response for a different login", async () => {
    const api = createGitHubApi({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ permission: "admin", user: { login: "attacker" } }),
          { status: 200 },
        ),
      token: "test-token",
    });

    await expect(
      api.collaboratorPermission(repository, "release-reviewer"),
    ).rejects.toThrow("does not match");
  });

  it("rejects an unknown collaborator permission value", async () => {
    const api = createGitHubApi({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            permission: "maintain",
            user: { login: "release-reviewer" },
          }),
          { status: 200 },
        ),
      token: "test-token",
    });

    await expect(
      api.collaboratorPermission(repository, "release-reviewer"),
    ).rejects.toThrow("unexpected permission maintain");
  });
});
