import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Public-surface guard, exercised as part of the standard `npm run test`
 * gate so published package READMEs and generated declarations cannot expose
 * internal tracking IDs or private Product repository paths.
 */

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(
  thisFileDir,
  "../../scripts/check-no-internal-ids.mjs",
);
const ciWorkflow = readFileSync(
  path.resolve(thisFileDir, "../../.github/workflows/ci.yml"),
  "utf8",
).replace(/\r\n?/g, "\n");

const { checkNoInternalIds, findPublishedSurfaceViolations } = (await import(
  pathToFileURL(scriptPath).href
)) as {
  checkNoInternalIds: () => {
    violations: {
      file: string;
      line: number;
      text: string;
      kind: string;
      match: string;
    }[];
    scannedFileCount: number;
    distMissing: string[];
  };
  findPublishedSurfaceViolations: (
    content: string,
    file?: string,
  ) => {
    file: string;
    line: number;
    text: string;
    kind: string;
    match: string;
  }[];
};

describe("published surfaces carry no forbidden internal references", () => {
  const { violations, distMissing } = checkNoInternalIds();

  it("keeps published package READMEs and built declarations clean", () => {
    const report = violations
      .map((violation) =>
        `${violation.file}:${violation.line} ` +
        `(${violation.kind}: ${violation.match}) — ${violation.text}`,
      )
      .join("\n");
    expect(violations, report).toEqual([]);
  });

  it("runs CI for published package README-only changes", () => {
    const orderedPathFilter = [
      "    paths:",
      '      - "**"',
      '      - "!**/*.md"',
      '      - "!LICENSE"',
      '      - "!.gitignore"',
      '      - "!.github/ISSUE_TEMPLATE/**"',
      '      - "!.github/PULL_REQUEST_TEMPLATE.md"',
      '      - "packages/*/README.md"',
    ].join("\n");

    expect(ciWorkflow).not.toContain("paths-ignore:");
    expect(ciWorkflow.split(orderedPathFilter)).toHaveLength(3);
  });

  it("rejects internal IDs and local Product repository paths", () => {
    const seeded = [
      "/** Internal work item SDK-49. */",
      "/** @drift-check ../glasstrace-product/docs/product-spec.md */",
      String.raw`/** @drift-check ..\..\glasstrace-product\docs\product-spec.md */`,
      "/** Mirrors `glasstrace-product/shared/types/wire.ts`. */",
      "/** See /workspace/glasstrace-product/docs/product-spec.md. */",
      "/** Repository root: ../glasstrace-product */",
      String.raw`/** Repository root: C:\workspace\glasstrace-product. */`,
      String.raw`/** Drive-relative root: C:glasstrace-product */`,
    ].join("\n");

    expect(
      findPublishedSurfaceViolations(seeded, "seeded.d.ts").map(
        ({ kind, line }) => ({ kind, line }),
      ),
    ).toEqual([
      { kind: "internal tracking identifier", line: 1 },
      { kind: "private Product repository path", line: 2 },
      { kind: "private Product repository path", line: 3 },
      { kind: "private Product repository path", line: 4 },
      { kind: "private Product repository path", line: 5 },
      { kind: "private Product repository path", line: 6 },
      { kind: "private Product repository path", line: 7 },
      { kind: "private Product repository path", line: 8 },
    ]);
  });

  it("rejects HTTPS, SSH, and SCP-like private Git references", () => {
    const privateGitReferences = [
      "https://github.com/example/glasstrace-product",
      "https://github.com/product/glasstrace-product",
      "https://gitlab.com/example/glasstrace-product.git",
      "https://gitlab.com/example/team/glasstrace-product.git",
      "https://gitlab.com/example/glasstrace-product/-/blob/main/README.md",
      "https://gitlab.com/example/glasstrace-product.git/info/refs",
      "https://gitlab.com/example/glasstrace-product/info/refs?service=git-upload-pack",
      "https://gitlab.com/example/glasstrace-product/git-receive-pack",
      "https://code.corp.example/team/glasstrace-product/info/refs?service=git-upload-pack",
      "https://code.corp.example/team/glasstrace-product/git-upload-pack",
      "https://gitlab.corp.example/group/glasstrace-product/-/tree/main",
      "https://gitlab.com/topics/glasstrace-product",
      "https://bitbucket.org/example/glasstrace-product/src/main/",
      "https://bitbucket.org/orgs/glasstrace-product",
      "https://bitbucket.corp.example/scm/TEAM/glasstrace-product.git",
      "https://bitbucket.corp.example/bitbucket/scm/TEAM/glasstrace-product.git/browse",
      "https://bitbucket.corp.example/bitbucket/scm/TEAM/glasstrace-product.git/info/refs?service=git-upload-pack",
      "https://bitbucket.corp.example/projects/TEAM/repos/glasstrace-product/browse",
      "https://bitbucket.corp.example/projects/TEAM/repos/glasstrace-product/info/refs?service=git-upload-pack",
      "https://codeberg.org/team/glasstrace-product",
      "https://codeberg.org./team/glasstrace-product",
      "https://codeberg.org/team%2Fglasstrace-product",
      "https://code.forgejo.org/team/glasstrace-product",
      "https://codeberg.org/api/v1/repos/team/glasstrace-product",
      "https://gitea.com/api/v1/repos/team/glasstrace-product",
      "https://api.github.com/repos/team/glasstrace-product",
      "https://github.corp.example/api/v3/repos/team/glasstrace-product",
      "https://github.corp.example/team/glasstrace-product/info/refs?service=git-upload-pack",
      "https://api.bitbucket.org/2.0/repositories/team/glasstrace-product",
      "https://raw.githubusercontent.com/team/glasstrace-product/main/README.md",
      "https://codeload.github.com/team/glasstrace-product/tar.gz/main",
      "https://media.githubusercontent.com/media/team/glasstrace-product/main/README.md",
      "https://dev.azure.com/org/project/_git/glasstrace-product",
      "https://dev.azure.com/org/project/_apis/git/repositories/glasstrace-product",
      "https://org.visualstudio.com/project/_git/glasstrace-product",
      "https://dev.azure.com/org%2Fproject%2F%5Fgit%2Fglasstrace-product",
      "https://git.example.test/team/glasstrace-product.git",
      "https://git.corp.example/team/glasstrace-product",
      "https://git.corp.example/team/glasstrace-product/src/main/README.md",
      "https://git.corp.example/group/team/projects/glasstrace-product",
      "https://git.corp.example/group/team/releases/glasstrace-product",
      "https://git.corp.example/group/team/projects/glasstrace-product/info/refs?service=git-upload-pack",
      "https://git.corp.example/projects/TEAM/repos/glasstrace-product/browse",
      "https://git.corp.example/projects/TEAM/repos/glasstrace-product/browse/api/v1/repos/foo/docs",
      "https://git.corp.example/scm/TEAM/glasstrace-product.git/info/refs?service=git-upload-pack",
      "https://git.corp.example/team/glasstrace-product/-/blob/main/scm/TEAM/docs",
      "https://git.corp.example/team/glasstrace-product/-/blob/main/projects/TEAM/repos/docs",
      "https://git.corp.example/team/glasstrace-product/src/branch/main/scm/TEAM/docs",
      "https://git.corp.example/team/glasstrace-product/-/blob/main/_git/docs",
      "https://git.corp.example/team/glasstrace-product/commits/branch/main/api/v1/repos/foo/docs",
      "https://git.corp.example/team/glasstrace-product/actions/workflows/api/v4/projects/foo%2Fdocs",
      "https://git.corp.example/team/glasstrace-product/commits/branch/main/docs/info/refs?service=git-upload-pack",
      "https://git.corp.example/team/glasstrace-product/actions/workflows/docs/git-upload-pack",
      "https://code.corp.example/team/glasstrace-product.git",
      "https://git.corp.example/glasstrace-product",
      "https://git.corp.example/team%2Fglasstrace-product",
      "https://git.corp.example/team%5Cglasstrace-product.git",
      "https://github.com/example%2Fglasstrace-product",
      "https://github.com/team/glasstrace-product/blob/main/explore/projects/demo",
      "https://gitea.corp.example/team/glasstrace-product",
      "https://forgejo.corp.example/team/glasstrace-product.git",
      "https://gitea.corp.example/team/glasstrace-product/src/branch/main/README.md",
      "https://gitea.corp.example/team/glasstrace-product/find/branch/main",
      "https://gitea.corp.example/team/glasstrace-product/blame/branch/main/README.md",
      "https://gitea.corp.example/team/glasstrace-product/_edit/main/README.md",
      "https://gitea.corp.example/team/glasstrace-product/issues/1",
      "https://gitea.corp.example/team/glasstrace-product/search?q=runner",
      "https://forgejo.corp.example/team/glasstrace-product/raw/branch/main/README.md",
      "https://forgejo.corp.example/team/glasstrace-product/media/branch/main/logo.png",
      "https://forgejo.corp.example/code/team/glasstrace-product/search",
      "https://git@code.corp.example/team/glasstrace-product",
      "https://git@code.corp.example/team/glasstrace-product/src/main/README.md",
      "https://%67it@code.corp.example/team/glasstrace-product",
      "https://gitea.corp.example/code/team/glasstrace-product",
      "https://gitea.corp.example/code/team/glasstrace-product/src/branch/main/README.md",
      "https://gitea.corp.example/code/internal/projects/team/glasstrace-product",
      "https://gitea.corp.example/code/internal/blob/team/glasstrace-product",
      "https://gitea.corp.example/team/glasstrace-product/src/branch/main/explore/repos/demo",
      "https://gitea.corp.example/code/internal/team/glasstrace-product/src/branch/main/explore/repos/demo",
      "https://forgejo.corp.example/repositories/team/glasstrace-product/raw/branch/main/README.md",
      "https://forgejo.corp.example/repositories/team/glasstrace-product/find/branch/main",
      "https://gitlab.corp.example/api/v4/projects/team%2Fglasstrace-product",
      "https://code.corp.example/api/v4/projects/team%2Fglasstrace-product",
      "https://gitea.corp.example/explore/team/glasstrace-product",
      "https://forgejo.corp.example/explore/team/glasstrace-product",
      "https://gitlab.com/team/glasstrace-product/-/blob/main/explore/projects/demo",
      "https://gitlab.com/org/explore/projects/glasstrace-product",
      "https://gitlab.com/org/groups/glasstrace-product/-/activity",
      "https://bitbucket.corp.example/projects/TEAM/repos/glasstrace-product/browse/product/glasstrace-product",
      "ssh://git@github.com/example/glasstrace-product.git",
      "git@github.com:example/glasstrace-product.git",
      "git@github.com:example/glasstrace-product.git?next=x",
      "git@github.com:example/glasstrace-product.git?next=https://example.com/x",
      "git@gitlab.com:example/team/glasstrace-product.git",
      "alice@git.corp.example:glasstrace-product",
      "deploy@host:glasstrace-product",
      "é@host:%67lasstrace-product",
      "alice!@host:team/%67lasstrace-product",
      "deploy+ci@github.com:team/%67lasstrace-product",
      "alice@example.com@example.org:team/%67lasstrace-product.git",
      "deploy,@host:team/%67lasstrace-product.git",
      "alice)@host:%67lasstrace-product",
      "alice]@host:%67lasstrace-product",
      "alice?@host:%67lasstrace-product",
      "alice|@host:%67lasstrace-product",
      "alice>@host:%67lasstrace-product",
      "deploy#@host:team/%67lasstrace-product.git",
      "build_bot@gitea.corp.example:team/glasstrace-product.git",
      "root@[::1]:team/%67lasstrace-product.git",
      "https://example.com/path/deploy@github.com:team/%67lasstrace-product",
      "https://example.com,deploy@github.com:443/topics/%67lasstrace-product",
      "https://example.com;deploy@github.com:443/topics/%67lasstrace-product",
      "https://example.com—deploy@github.com:443/topics/%67lasstrace-product",
      "<https://example.com>deploy@github.com:443/topics/%67lasstrace-product",
      "(https://example.com)deploy@github.com:443/topics/%67lasstrace-product",
      '"https://example.com"deploy@github.com:443/topics/%67lasstrace-product',
      "`https://example.com`deploy@github.com:443/topics/%67lasstrace-product",
      "[https://example.com]deploy@github.com:443/topics/%67lasstrace-product",
      "{https://example.com}deploy@github.com:443/topics/%67lasstrace-product",
      "文https://alice@host:443/%67lasstrace-product",
      "e\u0301https://alice@host:443/%67lasstrace-product",
      "file://alice@git.corp.example:443/%67lasstrace-product",
      "outer@host:path/deploy@github.com:team/%67lasstrace-product",
      "alice@host:%67lasstrace-product,bob@host:ordinary",
      "alice@host:ordinary,bob@host:%67lasstrace-product",
      "git@host:%67lasstrace-product?next=deploy@host:ordinary",
      "git@host:%67lasstrace-product—bob@host:ordinary",
      "https://[::]/team/glasstrace-product.git",
      "ssh://git@[::]/team/glasstrace-product.git",
      "git@[::]:team/glasstrace-product.git",
      "glasstrace-product.git",
    ];

    for (const reference of privateGitReferences) {
      expect(
        findPublishedSurfaceViolations(reference, "git-reference.d.ts"),
        reference,
      ).toEqual([
        expect.objectContaining({
          kind: "private Product repository path",
        }),
      ]);
    }

    const exactCustomUserReferences = [
      [
        "deploy+ci@github.com:team/%67lasstrace-product",
        "deploy+ci@github.com:team/%67lasstrace-product",
      ],
      [
        "prefix🙂alice@host:%67lasstrace-product",
        "alice@host:%67lasstrace-product",
      ],
      [
        "prefix👍🏽alice@host:%67lasstrace-product",
        "alice@host:%67lasstrace-product",
      ],
    ] as const;
    for (const [content, match] of exactCustomUserReferences) {
      expect(
        findPublishedSurfaceViolations(content, "custom-user-scp.d.ts"),
        content,
      ).toEqual([
        expect.objectContaining({
          kind: "private Product repository path",
          match,
        }),
      ]);
    }
  });

  it("rejects private file references without decoding path separators", () => {
    const privateFileReferences = [
      "file:///workspace/glasstrace-product/docs",
      "file:///workspace/glasstrace-product.git",
      "file:///workspace/glasstrace%2Dproduct/docs",
      "file:///workspace/%67lasstrace-product/docs",
      "https://example.com/path/file:///workspace/glasstrace-product/docs",
      "ssh://git@example.com/path/file:///workspace/glasstrace-product/docs",
      "file:///tmp/deploy@host:team/%67lasstrace-product",
      "file:%67lasstrace-product,bob@host:ordinary",
      "file:%67lasstrace-product—bob@host:ordinary",
    ];

    for (const reference of privateFileReferences) {
      expect(
        findPublishedSurfaceViolations(reference, "file-reference.d.ts"),
        reference,
      ).toEqual([
        expect.objectContaining({
          kind: "private Product repository path",
        }),
      ]);
    }
  });

  it("rejects exact private repository targets across lexical wrappers", () => {
    const wrappedPrivateReferences = [
      "`https://github.com/example/glasstrace-product`",
      "[https://github.com/example/glasstrace-product]",
      "<https://github.com/example/glasstrace-product>",
      '"https://github.com/example/glasstrace-product"',
      "'https://github.com/example/glasstrace-product'",
      '<a href="https://github.com/example/glasstrace-product">repo</a>',
      "“https://github.com/example/glasstrace-product”",
      "https://github.com/example/glasstrace-product:",
      "https://github.com/example/glasstrace-product…",
      "https://github.com/example/glasstrace-product—",
      "../glasstrace-product”",
      "../glasstrace-product…",
      "../glasstrace-product—",
    ];

    for (const reference of wrappedPrivateReferences) {
      expect(
        findPublishedSurfaceViolations(reference, "wrapped-reference.d.ts"),
        reference,
      ).toEqual([
        expect.objectContaining({
          kind: "private Product repository path",
        }),
      ]);
    }
  });

  it("does not let a preceding public link absorb an adjacent local path", () => {
    const adjacentPaths = [
      "[public](https://example.com)/workspace/glasstrace-product",
      "https://example.com/x,../glasstrace-product",
      "https://example.com;/workspace/glasstrace-product",
      "https://example.com;~/glasstrace-product",
      "https://example.com;~erik/glasstrace-product",
      "https://example.com,$HOME/glasstrace-product",
      "https://example.com;${HOME}/glasstrace-product",
      "ssh://git@github.com/team/docs.git,/workspace/glasstrace-product/overview",
      "ssh://git@github.com/team/docs.git;../glasstrace-product/docs",
      "git@github.com:team/docs.git,/workspace/glasstrace-product/overview",
      "git@github.com:team/docs.git;../glasstrace-product/docs",
      String.raw`https://example.com,C:\workspace\glasstrace-product`,
      "https://example.com—../glasstrace-product",
      "https://example.com–/workspace/glasstrace-product",
      "https://example.com…$HOME/glasstrace-product",
      String.raw`https://example.com”C:\workspace\glasstrace-product`,
      "https://example.com，../glasstrace-product",
      "https://example.com。/workspace/glasstrace-product",
      "https://example.com\u{10100}../glasstrace-product",
      "https://example.com/docs_(foo—../glasstrace-product",
      "https://example.com/docs_[foo，../glasstrace-product",
      "https://example.com/docs_{foo|../glasstrace-product",
      "https://example.com/docs_(foo)—../glasstrace-product",
      "https://example.com/docs_([foo—../glasstrace-product)]",
      "https://example.com/docs_({foo—../glasstrace-product)}",
      "ssh://git@example.com/team/docs_([foo—../glasstrace-product)]",
      "git@example.com:team/docs_([foo—../glasstrace-product)]",
      "https://example.com—(../glasstrace-product)",
      "https://example.com—[../glasstrace-product]",
      "https://example.com—{/workspace/glasstrace-product}",
      "https://example.com—([../glasstrace-product])",
      "https://example.com—(“../glasstrace-product”)",
      "https://example.com—(（../glasstrace-product）)",
      "https://example.com—([“../glasstrace-product”])",
      "https://example.com,(“$PWD/glasstrace-product”)",
      "https://example.com(../glasstrace-product",
      "https://example.com[../glasstrace-product",
      "https://example.com{/workspace/glasstrace-product",
      "https://example.com—$PWD/glasstrace-product",
      "https://example.com—${PWD}/glasstrace-product",
      "https://example.com—file:///workspace/glasstrace-product",
      "https://example.com—C:glasstrace-product",
      "https://example.com—C:workspace/glasstrace-product",
      "https://example.com—file:C:workspace/glasstrace-product",
      "https://example.com—file:../glasstrace-product",
      "https://example.com—file:workspace/glasstrace-product",
      "https://example.com/path/file:///workspace/glasstrace-product",
      "https://example.com—glasstrace-product/docs",
      "https://example.com—glasstrace-product.git",
      "https://example.com—https://github.com/example/glasstrace-product",
      "https://example.com—https://%/workspace/glasstrace-product",
      "https://example.com—ssh://%/workspace/glasstrace-product",
      "https://example.com—git@not-a-remote/workspace/glasstrace-product",
      "https://example.com，https://api.github.com/repos/example%2Fglasstrace-product",
      "https://example.com;https://gitlab.corp.example/api/v4/projects/team%2Fglasstrace-product",
      "https://example.com（../glasstrace-product）",
      "https://example.com【/workspace/glasstrace-product】",
      "https://example.com\u{200b}../glasstrace-product",
      "https://example.com\u{2060}../glasstrace-product",
      "https://example.com\u{00ad}../glasstrace-product",
      "https://example.com→../glasstrace-product",
      "https://example.com−../glasstrace-product",
      "https://example.com🙂../glasstrace-product",
      "https://example.com\u{0080}../glasstrace-product",
      "https://example.com\u{0378}../glasstrace-product",
      "https://example.com\u{e000}../glasstrace-product",
      "https://example.com\u0000../glasstrace-product",
      "https://example.com\u001b../glasstrace-product",
      "https://example.com\u007f../glasstrace-product",
      "https://example.com—\u0301../glasstrace-product",
      "https://example.com⚠️../glasstrace-product",
      "https://example.com©️../glasstrace-product",
      "https://example.com—(—../glasstrace-product)",
      "https://example.com—(…../glasstrace-product)",
      "https://example.com—(🙂../glasstrace-product)",
      "https://example.com—(→../glasstrace-product)",
      "https://example.com—(\u200b../glasstrace-product)",
      "https://example.com—(。../glasstrace-product)",
      "https://example.com—(”../glasstrace-product)",
      "https://example.com/(ssh://git@github.com/example/docs.git—../glasstrace-product)",
      "ssh://git@example.com/(https://example.com—../glasstrace-product)",
      "ssh://git@github.com/team/docs.git—../glasstrace-product/docs",
      "ssh://git@github.com/team/docs.git—(../glasstrace-product)",
      "ssh://git@github.com/team/docs.git—(“../glasstrace-product”)",
      "ssh://git@github.com/team/docs.git—(—../glasstrace-product)",
      "ssh://git@github.com/team/docs.git\u0000../glasstrace-product",
      "git@github.com:team/docs.git—../glasstrace-product/docs",
      "git@github.com:team/docs.git—(../glasstrace-product)",
      "git@github.com:team/docs.git—(“../glasstrace-product”)",
      "git@github.com:team/docs.git—(—../glasstrace-product)",
      "git@github.com:team/docs.git\u007f../glasstrace-product",
    ];

    for (const content of adjacentPaths) {
      expect(
        findPublishedSurfaceViolations(content, "adjacent.d.ts"),
        content,
      ).toEqual([
        expect.objectContaining({
          kind: "private Product repository path",
        }),
      ]);
    }
  });

  it("uses grapheme-rooted boundaries consistently", () => {
    const forbidden = [
      ["\u0301glasstrace-product/docs", "private Product repository path"],
      ["\ufe0fglasstrace-product.git", "private Product repository path"],
      ["\u0301SDK-49", "internal tracking identifier"],
      ["⚠️SDK-49", "internal tracking identifier"],
      ["SDK-4️⃣", "internal tracking identifier"],
      ["SDK-4⃣", "internal tracking identifier"],
      ["SDK-4︎⃣", "internal tracking identifier"],
      ["SDK-4️⃣9", "internal tracking identifier"],
      ["SDK-4️⃣9️⃣", "internal tracking identifier"],
      ["SDK-491️⃣", "internal tracking identifier"],
      ["1️⃣SDK-49", "internal tracking identifier"],
      ["%2FSDK-49", "internal tracking identifier"],
      ["%20SDK-49", "internal tracking identifier"],
      ["%E2%80%94SDK-49", "internal tracking identifier"],
      ["1%E2%83%A3SDK-49", "internal tracking identifier"],
      ["../glasstrace-product1️⃣/docs", "private Product repository path"],
      ["../glasstrace-product1⃣/docs", "private Product repository path"],
      ["glasstrace-product.git1️⃣", "private Product repository path"],
      [
        "https://example.com|\u0301glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com—\u0301glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com⚠️glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "ssh://git@example.com/docs.git—️glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "git@example.com:docs.git—́glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com—́https://api.github.com/repos/org%2Fglasstrace-product",
        "private Product repository path",
      ],
      [
        "https://example.com⚠️https://api.github.com/repos/org%2Fglasstrace-product",
        "private Product repository path",
      ],
      [
        "https://example.com—1️⃣../glasstrace-product",
        "private Product repository path",
      ],
      [
        "https://example.com/docs1️⃣../glasstrace-product",
        "private Product repository path",
      ],
      [
        "https://example.com—#️⃣$HOME/glasstrace-product",
        "private Product repository path",
      ],
      [
        "https://example.com—*️⃣(../glasstrace-product)",
        "private Product repository path",
      ],
    ] as const;

    for (const [content, kind] of forbidden) {
      expect(
        findPublishedSurfaceViolations(content, "grapheme-boundary.d.ts"),
        content,
      ).toEqual([expect.objectContaining({ kind })]);
    }

    const allowed = [
      "e\u0301glasstrace-product/docs",
      "e\u0301SDK-49",
      "other＿glasstrace-product/docs",
      "../glasstrace-product＿docs",
      "＿SDK-49",
      "SDK-49＿",
      "＿https://example.com/glasstrace-product/docs",
      "%41SDK-49",
      "%5FSDK-49",
      "a%CC%81SDK-49",
      "%65%CC%81SDK-49",
      "%252FSDK-49",
      "SDK-49%41",
      "../glasstrace-product1/docs",
      "../glasstrace-product1️⃣.md",
      "https://example.com/glasstrace-product1️⃣/docs",
      "1\u0301\u20e3SDK-49",
      "SDK-491\u0301\u20e3",
    ];
    for (const content of allowed) {
      expect(
        findPublishedSurfaceViolations(content, "grapheme-control.d.ts"),
        content,
      ).toEqual([]);
    }
  });

  it("keeps only valid remote ranges and recognizes explicit local roots", () => {
    const privatePaths = [
      "https://example.com—!../glasstrace-product",
      "https://example.com—()../glasstrace-product",
      "ssh://git@example.com/team/docs.git—!../glasstrace-product",
      "git@example.com:team/docs.git—!../glasstrace-product",
      "git@not-a-remote/glasstrace-product/docs",
      "git@example.com/team/glasstrace-product/docs",
      "git@:team/glasstrace-product/docs",
      "https://%/workspace/glasstrace-product/docs",
      "https:///workspace/glasstrace-product/docs",
      "ssh://%/workspace/glasstrace-product/docs",
      "ssh://[:::]/workspace/glasstrace-product/docs",
      "git@[:::]:../glasstrace-product/docs",
      "git@example.com:|../glasstrace-product/docs",
      "file://%/workspace/glasstrace-product/docs",
      "https://example.com/docs,${PWD:-.}/glasstrace-product/docs",
      "https://example.com/docs—${PWD:+/tmp}/glasstrace-product/docs",
      "https://example.com/docs—${PWD%/}/glasstrace-product/docs",
      "https://example.com/docs—${PWD%%/}/glasstrace-product/docs",
      "https://example.com/docs—${PWD#*/}/glasstrace-product/docs",
      "https://example.com/docs—${PWD:0:4}/glasstrace-product/docs",
      "https://example.com/docs—${!ROOT}/glasstrace-product/docs",
      "https://example.com/docs—${PWD/foo/bar}/glasstrace-product/docs",
      "https://example.com/docs—${{github.workspace}}/glasstrace-product/docs",
      "https://example.com/docs—${ROOT:-${PWD}}/glasstrace-product/docs",
      "https://example.com/docs,$(pwd)/glasstrace-product/docs",
      "https://example.com/docs,$(dirname$(pwd))/glasstrace-product/docs",
      "https://example.com/docs,$((1+1))/glasstrace-product/docs",
      "https://example.com/docs,$env:PWD/glasstrace-product/docs",
      "https://example.com/docs,%CD%/glasstrace-product/docs",
      "https://example.com/docs,%CD:~0,3%/glasstrace-product/docs",
    ];

    for (const content of privatePaths) {
      expect(
        findPublishedSurfaceViolations(content, "range-boundary.d.ts"),
        content,
      ).toEqual([
        expect.objectContaining({ kind: "private Product repository path" }),
      ]);
    }
  });

  it("covers adversarial review regressions without widening public matches", () => {
    const forbidden = [
      ["SDK-49%31", "internal tracking identifier"],
      ["SDK%2D49", "internal tracking identifier"],
      ["%53DK-49", "internal tracking identifier"],
      ["%53%44%4B%2D%34%39", "internal tracking identifier"],
      ["SDK-49%31%E2%83%A3", "internal tracking identifier"],
      ["SDK-49%31%EF%B8%8F%E2%83%A3", "internal tracking identifier"],
      ["%53%44%4B%2D%34%39%C0", "internal tracking identifier"],
      ["%C0%53%44%4B%2D%34%39", "internal tracking identifier"],
      ["%53%44%4B%2D%34%39%E2%82", "internal tracking identifier"],
      ["../glasstrace-product1️⃣.", "private Product repository path"],
      ["../glasstrace-product.git1️⃣.", "private Product repository path"],
      [
        "https://example.com,!CD!/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com,%1/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com,%~dp0glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com—${PWD\\\\}/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com—$(pwd\\\\)/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com/path/https://%/workspace/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com/path/ssh://%/workspace/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com/path/file://%/workspace/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com/path/git@not-a-remote/workspace/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com/path/git@github.com:team/glasstrace-product",
        "private Product repository path",
      ],
      [
        "file:///workspace/%67lasstrace-product/docs?x=%ZZ",
        "private Product repository path",
      ],
      [
        "file:///workspace/glasstrace%2Dproduct/docs#%",
        "private Product repository path",
      ],
      [
        "file:///workspace/%67lasstrace-product/docs%2Freadme",
        "private Product repository path",
      ],
      [
        "file:///workspace/%67lasstrace-product/docs%5Creadme",
        "private Product repository path",
      ],
      [
        "file:C|/workspace/glasstrace%2Dproduct/docs",
        "private Product repository path",
      ],
      [
        "file://C|/workspace/glasstrace%2Dproduct/docs",
        "private Product repository path",
      ],
      [
        "file:%67lasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "file:../%67lasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "file:C:workspace/%67lasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://github.com/org/docs/blob/main/file://a🙂.example/workspace/glasstrace%2Dproduct/docs",
        "private Product repository path",
      ],
      [
        "https://example.com/file:///workspace/glasstrace-product/docs)%",
        "private Product repository path",
      ],
      [
        "https://example.com/file:///workspace/glasstrace-product/docs/https://example.com/%",
        "private Product repository path",
      ],
      [
        "https://example.com\u0378bad/workspace/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://example.com\ue000bad/workspace/glasstrace-product/docs",
        "private Product repository path",
      ],
      [
        "https://a|b@github.com/org/%67lasstrace-product",
        "private Product repository path",
      ],
      [
        "https://a\"b@github.com/org/%67lasstrace-product",
        "private Product repository path",
      ],
      [
        "https://a'b@github.com/org/%67lasstrace-product",
        "private Product repository path",
      ],
      [
        "https://a`b@github.com/org/%67lasstrace-product",
        "private Product repository path",
      ],
      [
        "https://a<b@github.com/org/%67lasstrace-product",
        "private Product repository path",
      ],
      [
        "https://[user@github.com/org/%67lasstrace-product",
        "private Product repository path",
      ],
      [
        "ssh://a|b@github.com/org/glasstrace-product.git",
        "private Product repository path",
      ],
      [
        "ssh://example.com/path/git@github.com:team/glasstrace-product",
        "private Product repository path",
      ],
      [
        String.raw`C:\git@github.com:team/glasstrace-product`,
        "private Product repository path",
      ],
      [
        String.raw`prefix\git@github.com:team/glasstrace-product`,
        "private Product repository path",
      ],
      [
        String.raw`https://example.com/path\git@github.com:team/glasstrace-product`,
        "private Product repository path",
      ],
      [
        "https://u@example.com|../glasstrace-product",
        "private Product repository path",
      ],
      [
        "https://a|b@[:::]/workspace/glasstrace-product",
        "private Product repository path",
      ],
    ] as const;

    for (const [content, kind] of forbidden) {
      expect(
        findPublishedSurfaceViolations(content, "review-regression.d.ts"),
        content,
      ).toEqual([expect.objectContaining({ kind })]);
    }

    const allowed = [
      "https://example.com/a([)](foo—../glasstrace-product)",
      "https://a🙂/glasstrace-product/docs",
      "ssh://a🙂/glasstrace-product/docs",
      "git@a🙂.example:team/docs/glasstrace-product/overview",
      "git@example.com:+team/docs/glasstrace-product/overview",
      "git@example.com:@team/docs/glasstrace-product/overview",
      "git@example.com:🙂team/docs/glasstrace-product/overview",
      "deploy@example.com",
      "Contact: deploy@example.com",
      "deploy@example.com:ordinary-label",
      "mailto:deploy@example.com?subject=glasstrace-product",
      "deploy@example.com:team/docs/glasstrace-product/overview",
      "https://example.com/path/deploy@example.com:team/docs/glasstrace-product/overview",
      "https://deploy@git.corp.example:443/glasstrace-product/docs",
      "https://deploy:secret@git.corp.example:443/glasstrace-product/docs",
      "https://deploy:>secret@github.com:443/topics/%67lasstrace-product",
      "https://de>ploy@github.com:443/topics/%67lasstrace-product",
      "ssh://deploy@git.corp.example:22/glasstrace-product/docs",
      "ftp://deploy@example.com:21/%67lasstrace-product",
      "postgres://deploy@example.com:5432/%67lasstrace-product",
      "custom://deploy@example.com:123/%67lasstrace-product",
      "https://github.com/org/docs/blob/main/file://host:80/x%2Fglasstrace-product",
      "https://github.com/org/docs/blob/main/file://user@host/x%2Fglasstrace-product",
      "file:///workspace/glasstrace-product%2Freadme",
      "%53%44%4B%2D%34%39%C3%A9",
      "https://example.com—${PWD\\}/glasstrace-product/docs",
      "https://example.com—$(pwd\\)/glasstrace-product/docs",
      "https://sub.a🙂/glasstrace-product/docs",
      "ssh://sub.a🙂/glasstrace-product/docs",
      "https://user.name@a🙂/glasstrace-product/docs",
      "https://sub.server。example/glasstrace-product/docs",
      "https://sub.a🙂.example/glasstrace-product/docs",
      "https://sub.a🙂☕/glasstrace-product/docs",
      "https://sub.a👨🏽/glasstrace-product/docs",
      "https://sub.a👍🏻/glasstrace-product/docs",
      "https://a|b@example.com/glasstrace-product/docs",
      "https://a\"b@example.com/glasstrace-product/docs",
      "https://a'b@example.com/glasstrace-product/docs",
      "https://a`b@example.com/glasstrace-product/docs",
      "https://a<b@example.com/glasstrace-product/docs",
      "https://[user@example.com/glasstrace-product/docs",
      "https://a|b@[::1]/glasstrace-product/docs",
      "ssh://a|b@example.com/team/docs/glasstrace-product/overview",
      "https://example.com/path/git@github.com:team/docs/glasstrace-product/overview",
    ];

    for (const content of allowed) {
      expect(
        findPublishedSurfaceViolations(content, "review-control.d.ts"),
        content,
      ).toEqual([]);
    }
  });

  it("allows public language, public links, and longer unrelated names", () => {
    const allowed = [
      "/** @drift-check Glasstrace product specification §4.5. */",
      "/** Mirrors the canonical Product schema. */",
      "/** The glasstrace-product repository owns the canonical contract. */",
      "/** Repository:glasstrace-product is a public phrase. */",
      "/** format:glasstrace-product is a public label. */",
      "/** schema-C:glasstrace-product is a public token. */",
      "/** @C:glasstrace-product is a public token. */",
      "/** A different other-glasstrace-product/docs tree is unrelated. */",
      "/** A different other.glasstrace-product/docs tree is unrelated. */",
      "/** The public package @glasstrace-product/docs is unrelated. */",
      "/** See https://glasstrace.dev/docs/glasstrace-product/overview. */",
      "/** See https://example.com/glasstrace-product/docs. */",
      "/** See https://example.com/a_(b)/glasstrace-product/docs. */",
      "/** See https://example.com/docs_(foo,../glasstrace-product). */",
      "/** See https://example.com/docs_(foo—../glasstrace-product). */",
      "/** See https://example.com/docs_([foo—../glasstrace-product]). */",
      "/** See https://example.com/docs_({foo—../glasstrace-product}). */",
      "/** See ssh://git@example.com/team/docs_([foo—../glasstrace-product]). */",
      "/** See git@example.com:team/docs_([foo—../glasstrace-product]). */",
      "/** See https://example.com/a([)]/glasstrace-product/overview. */",
      "/** See ssh://git@example.com/a([)]/glasstrace-product/overview. */",
      "/** See git@example.com:a([)]/glasstrace-product/overview. */",
      "/** See ssh://git@example.com/team/docs_(foo,../glasstrace-product). */",
      "/** See https://example.com/docs/~erik/glasstrace-product. */",
      "/** See https://example.com/docs—v1/glasstrace-product. */",
      "/** See https://example.com—workspace/glasstrace-product. */",
      "/** See https://example.com—glasstrace-product. */",
      "/** See https://example.com—glasstrace-product.md. */",
      "/** See https://example.com/docs%E2%80%94../glasstrace-product. */",
      "/** See https://example.com/docs%EF%BC%88../glasstrace-product%EF%BC%89. */",
      "/** See https://example.com/docs%E2%86%92../glasstrace-product. */",
      "/** See https://example.com/docs%C2%AD../glasstrace-product. */",
      "/** See https://example.com/docs%C2%80../glasstrace-product. */",
      "/** See https://example.com/docs%00../glasstrace-product. */",
      "/** See https://example.com/docs%1B../glasstrace-product. */",
      "/** See https://example.com/docs%7F../glasstrace-product. */",
      "/** See https://example.com/docs%CD%B8../glasstrace-product. */",
      "/** See https://example.com/docs%EE%80%80../glasstrace-product. */",
      "/** See https://example.com/docsé../glasstrace-product. */",
      "/** See https://example.com/docse\u{0301}../glasstrace-product. */",
      "/** See https://example.com/docs\u{10400}../glasstrace-product. */",
      "/** See https://example.com/docs\u{1d7ce}../glasstrace-product. */",
      "/** See https://example.com/docsa\u{1d165}../glasstrace-product. */",
      "/** See https://example.com/docs＿../glasstrace-product. */",
      "/** See https://example.com/docs🙂v1/glasstrace-product. */",
      "/** See https://example.com—https://github.com/example/docs/blob/main/glasstrace-product/overview.md. */",
      "/** See https://example.com—https://api.github.com/repos/example/docs/contents/glasstrace-product. */",
      "/** See https://example.com—(https://gitlab.com/example/docs/-/blob/main/glasstrace-product/overview.md). */",
      "/** See ssh://git@example.com/path/https://github.com/example/docs/blob/main/glasstrace-product. */",
      "/** See git@example.com:path/https://github.com/example/docs/blob/main/glasstrace-product. */",
      "/** See https://example.com—(“workspace/glasstrace-product”). */",
      "/** See https://example.com—(（workspace/glasstrace-product）). */",
      "/** See https://example.com/docs-../glasstrace-product. */",
      "/** See https://example.com/?../glasstrace-product. */",
      "/** See https://example.com/#../glasstrace-product. */",
      "/** See https://example.com/docs%2Fglasstrace-product/overview. */",
      "/** See https://[::]/glasstrace-product/overview. */",
      "/** See ssh://[::]/glasstrace-product/overview. */",
      "/** See git@[::]:team/glasstrace-product/overview. */",
      "/** See https://🙂.example.com/glasstrace-product/overview. */",
      "/** See https://☕.example.com/glasstrace-product/overview. */",
      "/** See https://,user@example.com/glasstrace-product/overview. */",
      "/** See https://(user)@example.com/glasstrace-product/overview. */",
      "/** See https://🙂@example.com/glasstrace-product/overview. */",
      "/** See https://1️⃣/glasstrace-product/overview. */",
      "/** See ssh://1️⃣/glasstrace-product/overview. */",
      "/** See git@1️⃣:team/glasstrace-product/overview. */",
      "/** See file:///workspace/other-glasstrace-product/docs. */",
      "/** See file:///workspace/glasstrace-product.md. */",
      "/** See file:///workspace/glasstrace%252Dproduct/docs. */",
      "/** See file:///workspace%2Fglasstrace-product/docs. */",
      "/** See https://example.com—${PWD/glasstrace-product/docs. */",
      "/** See https://example.com—$((1+1)/glasstrace-product/docs. */",
      "/** See https://gitea.corp.example/explore%2Frepos%2Fglasstrace-product. */",
      "/** See https://github.com/example/other-glasstrace-product. */",
      "/** See https://git.corp.example/team%2Fother-glasstrace-product. */",
      "/** See https://example.com;~erik/other-glasstrace-product. */",
      "/** A longer /workspace/glasstrace-product.md file is unrelated. */",
      "/** A longer $HOME/glasstrace-product.md file is unrelated. */",
      "/** Standards such as SHA-256 and ISO-8601 remain public. */",
      "/** A longer éSDK-49 token is not an internal tracking ID. */",
    ].join("\n");

    expect(findPublishedSurfaceViolations(allowed, "allowed.d.ts")).toEqual(
      [],
    );
  });

  it("allows public Git-host routes and longer repository-like names", () => {
    const allowedReferences = [
      "https://github.com/topics/glasstrace-product",
      "https://github.com/orgs/glasstrace-product",
      "https://github.com/marketplace/glasstrace-product",
      "https://github.com/apps/glasstrace-product",
      "https://github.com/collections/glasstrace-product",
      "https://github.com/sponsors/glasstrace-product",
      "https://gitlab.com/explore/projects/topics/glasstrace-product",
      "https://gitlab.com/groups/glasstrace-product/-/activity",
      "https://gitlab.corp.example/groups/glasstrace-product/-/autocomplete_sources/members",
      "https://gitlab.com/example/docs/-/blob/main/glasstrace-product/overview.md",
      "https://gitlab.com/example/glasstrace-product/docs/-/blob/main/README.md",
      "https://gitlab.corp.example/example/docs/-/raw/main/glasstrace-product.git",
      "https://gitlab.corp.example/example%2Fdocs%2F-%2Fblob%2Fmain%2Fglasstrace-product/overview.md",
      "https://bitbucket.org/product/glasstrace-product",
      "https://bitbucket.corp.example/projects/TEAM/repos/docs/browse/glasstrace-product/overview.md",
      "https://bitbucket.corp.example/scm/TEAM/docs.git/browse/glasstrace-product",
      "https://bitbucket.corp.example/bitbucket/scm/TEAM/docs.git/browse/glasstrace-product/overview.md",
      "https://bitbucket.corp.example/bitbucket/scm/TEAM/docs.git/browse/glasstrace-product/info/refs?service=git-upload-pack",
      "https://bitbucket.corp.example/projects/TEAM/repos/docs/browse/glasstrace-product/info/refs?service=git-upload-pack",
      "https://bitbucket.corp.example/scm/TEAM/docs.git/browse/glasstrace-product/git-upload-pack",
      "https://codeberg.org/explore/repos/glasstrace-product",
      "https://codeberg.org/team/docs/src/branch/main/glasstrace-product/overview.md",
      "https://codeberg.org/team/docs/raw/branch/main/glasstrace-product.git",
      "https://gitea.com/glasstrace-product",
      "https://gitea.corp.example/glasstrace-product",
      "https://forgejo.corp.example/glasstrace-product",
      "https://gitea.corp.example/glasstrace-product.git",
      "https://gitea.corp.example/glasstrace-product/docs",
      "https://gitea.corp.example/example/docs/src/branch/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/code/example/docs/src/branch/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/code/glasstrace-product/docs/src/branch/main/README.md",
      "https://gitea.corp.example/team/src/src/branch/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/_edit/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/_delete/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/_new/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/_upload/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/rss/branch/main/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/issues/1/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/releases/download/v1/glasstrace-product/checksum",
      "https://gitea.corp.example/team/docs/commits/branch/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/wiki/glasstrace-product/overview.md",
      "https://gitea.corp.example/team/docs/actions/workflows/glasstrace-product/overview.md",
      "https://forgejo.corp.example/example/docs/raw/branch/main/glasstrace-product.git/overview.md",
      "https://forgejo.corp.example/repositories/example/docs/raw/branch/main/glasstrace-product.git/overview.md",
      "https://dev.azure.com/org/project/_git/docs/glasstrace-product/overview.md",
      "https://dev.azure.com/org/project/_apis/git/repositories/docs/items?path=/glasstrace-product",
      "https://api.github.com/repos/team/docs/contents/glasstrace-product",
      "https://api.bitbucket.org/2.0/repositories/team/docs/src/main/glasstrace-product",
      "https://codeberg.org/api/v1/repos/team/docs/contents/glasstrace-product",
      "https://gitea.corp.example/api/v1/repos/team/docs/contents/glasstrace-product",
      "https://gitlab.com/api/v4/projects/team%2Fdocs/repository/files/glasstrace-product",
      "https://code.corp.example/api/v4/projects/team%2Fdocs/repository/files/glasstrace-product",
      "https://gitlab.com/team/docs/-/blob/main/api/v4/projects/foo%2Fglasstrace-product",
      "https://gitlab.corp.example/team/docs/-/raw/main/api/v4/projects/foo%2Fglasstrace-product",
      "https://code.corp.example/team/docs/-/blob/main/api/v4/projects/foo%2Fglasstrace-product",
      "https://codeberg.org/team/docs/src/branch/main/api/v1/repos/foo/glasstrace-product",
      "https://gitea.corp.example/team/docs/src/branch/main/api/v1/repos/foo/glasstrace-product",
      "https://github.com/team/docs/blob/main/glasstrace-product/info/refs?service=git-upload-pack",
      "https://github.com/example/glasstrace-product.md",
      "https://github.com/example/glasstrace-productish",
      "https://github.com/example/glasstrace-product-extra",
      "https://example.com/docs/glasstrace-product/overview",
      "https://example.com/download/glasstrace-product.md",
      "https://code.corp.example/team/glasstrace-product",
      "https://git-example.corp/team/glasstrace-product",
      "https://example.github.io/docs/glasstrace-product/overview",
      "https://team.gitlab.io/docs/glasstrace-product/overview",
      "https://github.corp.example/topics/glasstrace-product",
      "https://github.corp.example/team/docs/raw/main/glasstrace-product/info/refs?service=git-upload-pack",
      "https://github.corp.example/team/docs/raw/main/glasstrace-product/git-upload-pack",
      "https://gitlab.corp.example/explore/projects/topics/glasstrace-product",
      "https://git.corp.example/example/docs/-/blob/main/glasstrace-product/overview.md",
      "https://git.corp.example/example/docs/src/branch/main/glasstrace-product/overview.md",
      "https://git.corp.example/projects/TEAM/repos/docs/browse/glasstrace-product/info/refs?service=git-upload-pack",
      "https://git.corp.example/projects/TEAM/repos/docs/browse/glasstrace-product/git-upload-pack",
      "https://git.corp.example/scm/TEAM/docs.git/browse/glasstrace-product/info/refs?service=git-upload-pack",
      "https://git.corp.example/projects/TEAM/repos/docs/browse/api/v1/repos/foo/glasstrace-product",
      "https://git.corp.example/projects/TEAM/repos/docs/browse/api/v4/projects/foo%2Fglasstrace-product",
      "https://git.corp.example/team/docs/-/blob/main/scm/TEAM/glasstrace-product",
      "https://git.corp.example/team/docs/src/branch/main/projects/TEAM/repos/glasstrace-product",
      "https://git.corp.example/team/docs/commits/branch/main/projects/TEAM/repos/glasstrace-product/browse",
      "https://git.corp.example/team/docs/commits/branch/main/scm/TEAM/glasstrace-product.git/browse",
      "https://git.corp.example/team/docs/wiki/projects/TEAM/repos/glasstrace-product/browse",
      "https://git.corp.example/team/docs/actions/workflows/scm/TEAM/glasstrace-product.git/browse",
      "https://git.corp.example/team/docs/commits/branch/main/_git/glasstrace-product",
      "https://git.corp.example/team/docs/actions/workflows/_git/glasstrace-product",
      "https://git.corp.example/team/docs/commits/branch/main/api/v1/repos/foo/glasstrace-product",
      "https://git.corp.example/team/docs/actions/workflows/api/v4/projects/foo%2Fglasstrace-product",
      "https://git.corp.example/team/docs/commits/branch/main/glasstrace-product/info/refs?service=git-upload-pack",
      "https://git.corp.example/team/docs/actions/workflows/glasstrace-product/git-upload-pack",
      "https://git.corp.example/team/docs/-/blob/main/_git/glasstrace-product",
      "https://code.corp.example/team/docs/-/blob/main/glasstrace-product.git",
      "https://code.corp.example/team/docs/src/branch/main/glasstrace-product.git",
      "https://code.corp.example/team/docs/blob/main/glasstrace-product.git",
      "https://git.corp.example/team/docs/pull/123/files/glasstrace-product/overview.md",
      "https://git.corp.example/team/docs/discussions/42/glasstrace-product/overview.md",
      "https://media.githubusercontent.com/media/team/docs/main/glasstrace-product/README.md",
      "https://media.githubusercontent.com/media/team/docs/main/glasstrace-product/info/refs?service=git-upload-pack",
      "https://media.githubusercontent.com/media/team/docs/main/glasstrace-product/git-upload-pack",
      "https://gitea.corp.example/code/explore/repos/glasstrace-product",
      "https://forgejo.corp.example/forge/explore/repos/glasstrace-product",
      "https://gitea.corp.example/code/internal/explore/repos/glasstrace-product",
      "https://forgejo.corp.example/forge/internal/explore/repos/glasstrace-product",
      "https://gitlab.corp.example/gitlab/explore/projects/topics/glasstrace-product",
      "https://gitlab.corp.example/gitlab/groups/glasstrace-product/-/activity",
      "https://bitbucket.corp.example/bitbucket/product/glasstrace-product",
      "https://git.corp.example/explore/repos/glasstrace-product",
      "https://git.corp.example/explore/projects/topics/glasstrace-product",
      "https://git.corp.example/groups/glasstrace-product/-/activity",
      "https://bitbucket.corp.example/product/glasstrace-product",
      "https://gitea.corp.example/explore/repos/glasstrace-product",
      "https://forgejo.corp.example/explore/repos/glasstrace-product",
      "https://gitea.corp.example/team/-/packages/generic/glasstrace-product",
      "https://forgejo.corp.example/team/-/packages/generic/glasstrace-product",
      "ssh://git@gitlab.com/group/glasstrace-product/docs.git",
      "git@gitlab.com:group/glasstrace-product/docs.git",
      "other-glasstrace-product.git",
      "glasstrace-product.git.md",
    ];

    for (const reference of allowedReferences) {
      expect(
        findPublishedSurfaceViolations(reference, "public-reference.d.ts"),
        reference,
      ).toEqual([]);
    }
  });

  it("uses Unicode-aware internal-ID boundaries", () => {
    const violations = findPublishedSurfaceViolations(
      "©SDK-49©\n文SDK-49\nSDK-49é",
      "unicode.d.ts",
    );

    expect(violations).toEqual([
      expect.objectContaining({
        kind: "internal tracking identifier",
        line: 1,
        match: "SDK-49",
      }),
    ]);
  });

  it.runIf(distMissing.length === 0)(
    "scans generated declarations after Build",
    () => {
      expect(distMissing).toEqual([]);
    },
  );
});
