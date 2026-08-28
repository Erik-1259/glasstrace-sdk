import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(
  testDirectory,
  "../../.github/workflows/release.yml",
);
const contributingPath = resolve(testDirectory, "../../CONTRIBUTING.md");
const ciPath = resolve(testDirectory, "../../.github/workflows/ci.yml");
const packageJsonPath = resolve(testDirectory, "../../package.json");
const workflow = readFileSync(workflowPath, "utf8");
const contributing = readFileSync(contributingPath, "utf8");
const ci = readFileSync(ciPath, "utf8");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

function embeddedCanaryGuardProgram(source: string): string {
  const opener = "          node --input-type=module <<'NODE'\n";
  const terminator = "\n          NODE";
  const starts = [...source.matchAll(/^[ ]{10}node --input-type=module <<'NODE'$/gm)];
  if (starts.length !== 1) {
    throw new Error(`Expected one canary guard heredoc, found ${starts.length}`);
  }

  const programStart = starts[0].index + opener.length;
  const programEnd = source.indexOf(terminator, programStart);
  if (programEnd < 0) {
    throw new Error("Canary guard heredoc has no terminator");
  }

  return source
    .slice(programStart, programEnd)
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("          ")) {
        throw new Error(`Canary guard line is not indented: ${line}`);
      }
      return line.slice(10);
    })
    .join("\n");
}

function runEmbeddedCanaryGuard(status: unknown): {
  exitCode: number | null;
  stderr: string;
  stdout: string;
} {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "glasstrace-canary-guard-"));
  try {
    writeFileSync(
      join(fixtureRoot, "changeset-status.json"),
      JSON.stringify(status),
    );
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", embeddedCanaryGuardProgram(workflow)],
      {
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: fixtureRoot },
      },
    );
    return {
      exitCode: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const EXPECTED_CONTRACT_LINES = [
  "name: Release",
  "on:",
  "  push:",
  "    branches: [main]",
  "  workflow_dispatch:",
  "    inputs:",
  "      mode:",
  '        description: "Release mode"',
  "        required: true",
  "        type: choice",
  "        options:",
  "          - canary",
  "          - stable",
  "        default: canary",
  "concurrency:",
  "  group: release-${{ github.event_name }}",
  "  queue: max",
  "jobs:",
  "  version:",
  "    name: Version Packages PR",
  "    if: ${{ github.event_name == 'push' }}",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 15",
  "    permissions:",
  "      contents: write",
  "      pull-requests: write",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "        with:",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@v7",
  "        with:",
  "          node-version: 22",
  "          cache: npm",
  "      - name: Use the declared npm version",
  "        run: npm install -g npm@11.6.1",
  "      - run: npm ci --no-audit",
  "      - run: npm run check:workspace-lock",
  "      - name: Create or update Version Packages PR",
  "        uses: changesets/action@v2",
  "        with:",
  '          pr-title: "chore: version packages"',
  '          commit-message: "chore: version packages"',
  "          version-script: npm run version-packages",
  "          github-token: ${{ secrets.GITHUB_TOKEN }}",
  "  preflight:",
  "    name: Publish preflight (${{ inputs.mode }})",
  "    if: ${{ github.event_name == 'workflow_dispatch' }}",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 10",
  "    permissions:",
  "      checks: read",
  "      contents: read",
  "      issues: read",
  "      pull-requests: read",
  "    steps:",
  "      - name: Guard — require supported release mode",
  "        shell: bash",
  "        env:",
  "          RELEASE_MODE: ${{ inputs.mode }}",
  "        run: |",
  '          case "$RELEASE_MODE" in',
  "            canary|stable) ;;",
  "            *)",
  '              echo "::error::Release mode must be exactly canary or stable."',
  "              exit 1",
  "              ;;",
  "          esac",
  "      - name: Guard — stable releases require main",
  "        if: ${{ inputs.mode == 'stable' && github.ref != 'refs/heads/main' }}",
  "        shell: bash",
  "        run: |",
  '          echo "::error::Stable releases must be dispatched from the current main branch."',
  "          exit 1",
  "      - uses: actions/checkout@v7",
  "        with:",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@v7",
  "        with:",
  "          node-version: 22",
  "      - name: Verify stable release readiness",
  "        if: ${{ inputs.mode == 'stable' }}",
  "        env:",
  "          GITHUB_TOKEN: ${{ github.token }}",
  "        run: node scripts/check-stable-release-readiness.mjs",
  "  publish:",
  "    name: Publish (${{ inputs.mode }})",
  "    if: ${{ github.event_name == 'workflow_dispatch' }}",
  "    needs: preflight",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 20",
  "    permissions:",
  "      checks: read",
  "      contents: read",
  "      issues: read",
  "      id-token: write",
  "      pull-requests: read",
  "    steps:",
  "      - uses: actions/checkout@v7",
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "      - name: Make Changesets base branch resolvable",
  "        shell: bash",
  "        run: git show-ref --verify --quiet refs/heads/main || git branch --track main refs/remotes/origin/main",
  "      - uses: actions/setup-node@v7",
  "        with:",
  "          node-version: 22",
  "          cache: npm",
  "      - name: Upgrade npm for trusted publishing",
  "        run: npm install -g npm@11.6.1",
  "      - run: npm ci",
  "      - name: Guard — require versionable changesets for canary",
  "        if: ${{ inputs.mode == 'canary' }}",
  "        shell: bash",
  "        run: |",
  '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"',
  "          node --input-type=module <<'NODE'",
  '          import { readFileSync } from "node:fs";',
  "          const status = JSON.parse(",
  '            readFileSync(`${process.env.RUNNER_TEMP}/changeset-status.json`, "utf8"),',
  "          );",
  '          const versionableTypes = new Set(["patch", "minor", "major"]);',
  "          const releases = Array.isArray(status?.releases) ? status.releases : [];",
  "          const versionableReleases = releases.filter((release) =>",
  "            release !== null &&",
  '            typeof release === "object" &&',
  '            typeof release.name === "string" &&',
  '            release.name.trim() !== "" &&',
  "            versionableTypes.has(release.type) &&",
  '            typeof release.oldVersion === "string" &&',
  '            release.oldVersion.trim() !== "" &&',
  '            typeof release.newVersion === "string" &&',
  '            release.newVersion.trim() !== "" &&',
  "            release.newVersion !== release.oldVersion",
  "          );",
  "          if (versionableReleases.length === 0) {",
  '            console.error("::error::Canary mode requires at least one versionable package release in .changeset/.");',
  '            console.error("::error::Without one, snapshot versioning is a no-op and canary publication would re-tag a stable version.");',
  "            process.exit(1);",
  "          }",
  "          console.log(`Found ${versionableReleases.length} versionable package release(s).`);",
  "          NODE",
  "      - name: Snapshot version",
  "        if: ${{ inputs.mode == 'canary' }}",
  "        run: npm run version-packages -- --snapshot canary",
  "      - name: Typecheck",
  "        run: npm run typecheck",
  "      - name: Test",
  "        run: npm run test",
  "      - name: Build",
  "        run: npm run build",
  "      - name: Reverify readiness and publish stable",
  "        if: ${{ inputs.mode == 'stable' }}",
  "        env:",
  "          GITHUB_TOKEN: ${{ github.token }}",
  "        run: |",
  "          node scripts/check-stable-release-readiness.mjs",
  "          npx changeset publish",
  "      - name: Publish canary",
  "        if: ${{ inputs.mode == 'canary' }}",
  "        run: npx changeset publish --tag canary",
];

function contractLines(source: string): string[] {
  // CRLF is a canonical line ending. A remaining bare carriage return is
  // also a YAML line break, but `split(/\r?\n/)` would leave it embedded in
  // a comment line and let executable YAML disappear from the projection.
  // Reject that representation before applying any comment filtering.
  const normalizedSource = source.replace(/\r\n/g, "\n");
  if (normalizedSource.includes("\r")) {
    throw new Error("Release workflow contains a bare carriage return.");
  }
  const sourceEndsWithLineBreak = /\n$/.test(normalizedSource);
  const lines = normalizedSource.split("\n");
  if (lines.at(-1) === "" && sourceEndsWithLineBreak) {
    // `split` materializes the ordinary terminating line break as an empty
    // element. It is not an additional blank line for `+` chomping.
    lines.pop();
  }
  const contract: string[] = [];
  let blockScalar:
    | {
        contentIndent: number | undefined;
        hasContentLine: boolean;
        headerIndent: number;
        keepTrailingBlankLines: boolean;
        pendingBlankLines: string[];
      }
    | undefined;

  function nextContentIndent(afterIndex: number): number | undefined {
    for (let index = afterIndex + 1; index < lines.length; index += 1) {
      if (/^[ \t]*$/.test(lines[index]) || /^[ \t]*#/.test(lines[index])) {
        continue;
      }
      return /^ */.exec(lines[index])?.[0].length ?? 0;
    }
    return undefined;
  }

  function takePendingBlankLines(
    state: NonNullable<typeof blockScalar>,
    count = state.pendingBlankLines.length,
  ): string[] {
    const retained = state.pendingBlankLines
      .slice(0, count)
      .map((line) =>
        state.hasContentLine &&
        state.contentIndent !== undefined &&
        line.length > state.contentIndent
          ? line
          : "",
      );
    state.pendingBlankLines = [];
    return retained;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const indentation = /^ */.exec(line)?.[0].length ?? 0;
    const isAsciiBlank = /^[ \t]*$/.test(line);
    const isCommentLine = /^[ \t]*#/.test(line);

    if (blockScalar !== undefined) {
      if (isAsciiBlank) {
        // Blank lines are buffered until their role is known. They affect a
        // scalar when content resumes, and at the end only with `+` chomping.
        // A tab in YAML indentation is invalid, so retain it unconditionally
        // and make the exact-contract assertion fail closed.
        if (
          line.includes("\t") ||
          (blockScalar.hasContentLine &&
            blockScalar.contentIndent !== undefined &&
            indentation > blockScalar.contentIndent)
        ) {
          contract.push(...takePendingBlankLines(blockScalar), line);
          blockScalar.hasContentLine = true;
        } else {
          blockScalar.pendingBlankLines.push(line);
        }
        continue;
      }
      if (isCommentLine) {
        // Inside a scalar, `#` is string content and GitHub still expands
        // expressions on the line before Bash sees it as a shell comment.
        // A dedented comment is outside only when the next content line is
        // also dedented; resuming indented content would make invalid YAML.
        const nextIndent = nextContentIndent(lineIndex);
        if (
          blockScalar.contentIndent === undefined &&
          indentation > blockScalar.headerIndent
        ) {
          blockScalar.contentIndent = indentation;
        }
        const contentIndent = blockScalar.contentIndent;
        if (
          line.slice(0, line.indexOf("#")).includes("\t") ||
          (contentIndent !== undefined && indentation >= contentIndent) ||
          (contentIndent === undefined &&
            indentation > blockScalar.headerIndent) ||
          (contentIndent === undefined &&
            nextIndent !== undefined &&
            nextIndent > blockScalar.headerIndent) ||
          (contentIndent !== undefined &&
            nextIndent !== undefined &&
            nextIndent >= contentIndent)
        ) {
          blockScalar.hasContentLine = true;
          contract.push(...takePendingBlankLines(blockScalar));
          contract.push(line);
        } else {
          if (blockScalar.keepTrailingBlankLines) {
            contract.push(...takePendingBlankLines(blockScalar));
          }
          blockScalar = undefined;
        }
        continue;
      }

      if (
        blockScalar.contentIndent === undefined &&
        indentation > blockScalar.headerIndent
      ) {
        blockScalar.contentIndent = indentation;
      }

      if (
        blockScalar.contentIndent !== undefined &&
        indentation >= blockScalar.contentIndent
      ) {
        blockScalar.hasContentLine = true;
        contract.push(...takePendingBlankLines(blockScalar));
        contract.push(line);
        continue;
      }

      if (blockScalar.keepTrailingBlankLines) {
        contract.push(...takePendingBlankLines(blockScalar));
      }
      blockScalar = undefined;
    }

    if (isAsciiBlank || isCommentLine) continue;

    contract.push(
      line.replace(/^(\s*id-token: write)[ \t]+#.*$/, "$1"),
    );

    const blockScalarHeader =
      /^ *[^#\n][^:\n]*:[ \t]*[|>]((?:[+-][1-9]?|[1-9][+-]?)?)[ \t]*(?:#.*)?$/.exec(
        line,
      );
    if (blockScalarHeader !== null) {
      const modifiers = blockScalarHeader[1];
      const indentationIndicator = /[1-9]/.exec(modifiers)?.[0];
      blockScalar = {
        contentIndent:
          indentationIndicator === undefined
            ? undefined
            : indentation + Number(indentationIndicator),
        headerIndent: indentation,
        hasContentLine: false,
        keepTrailingBlankLines: modifiers.includes("+"),
        pendingBlankLines: [],
      };
    }
  }

  if (blockScalar?.keepTrailingBlankLines) {
    let retainedCount = Math.max(
      0,
      blockScalar.pendingBlankLines.length -
        (sourceEndsWithLineBreak ? 0 : 1),
    );
    if (
      !blockScalar.hasContentLine &&
      blockScalar.pendingBlankLines.length > 0 &&
      !sourceEndsWithLineBreak
    ) {
      const finalBlankLine = blockScalar.pendingBlankLines.at(-1) ?? "";
      const minimumContentIndent =
        blockScalar.contentIndent ?? blockScalar.headerIndent + 1;
      if (finalBlankLine.length >= minimumContentIndent) {
        retainedCount = Math.max(1, retainedCount);
      }
    }
    contract.push(...takePendingBlankLines(blockScalar, retainedCount));
  }

  return contract;
}

function assertReleaseWorkflowContract(source: string): void {
  expect(contractLines(source)).toEqual(EXPECTED_CONTRACT_LINES);
}

describe("release workflow contract", () => {
  it("matches the complete ordered release contract", () => {
    assertReleaseWorkflowContract(workflow);
  });

  it("rejects a bare-CR line break before comments are projected away", () => {
    const malicious = workflow.replace(
      "    permissions:\n      contents: write",
      "    permissions:\n      # benign\r      actions: write\n      contents: write",
    );

    expect(malicious.split(/\r\n?|\n/)).toContain("      actions: write");
    expect(() => contractLines(malicious)).toThrow(
      "Release workflow contains a bare carriage return.",
    );
  });

  it("accepts canonical CRLF without weakening the exact contract", () => {
    expect(contractLines(workflow.replace(/\n/g, "\r\n"))).toEqual(
      EXPECTED_CONTRACT_LINES,
    );
  });

  it("uses only supported Changesets v2 inputs and token wiring", () => {
    const actionStart = workflow.indexOf(
      "      - name: Create or update Version Packages PR",
    );
    const actionEnd = workflow.indexOf("\n\n  # Manual dispatch preflight", actionStart);
    expect(actionStart).toBeGreaterThan(0);
    expect(actionEnd).toBeGreaterThan(actionStart);
    const actionStep = workflow.slice(actionStart, actionEnd);

    expect(
      workflow.match(/^\s*uses:\s*changesets\/action@[^\s#]+/gm) ?? [],
    ).toEqual(["        uses: changesets/action@v2"]);
    expect(workflow).toContain('          pr-title: "chore: version packages"');
    expect(workflow).toContain(
      '          commit-message: "chore: version packages"',
    );
    expect(workflow).toContain(
      "          version-script: npm run version-packages",
    );
    expect(workflow).toContain(
      "          github-token: ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(actionStep).not.toMatch(/^ {8}env:/m);
    expect(actionStep).not.toContain("push-with-git-cli");
  });

  it("installs the exact npm version declared by packageManager", () => {
    const declaredNpm = /^npm@(.+)$/.exec(packageJson.packageManager)?.[1];
    expect(declaredNpm).toBeTruthy();
    expect(
      workflow.match(/^ {8}run: npm install -g npm@.+$/gm) ?? [],
    ).toEqual([
      `        run: npm install -g npm@${declaredNpm}`,
      `        run: npm install -g npm@${declaredNpm}`,
    ]);
    expect(contributing).toContain(
      `- npm ${declaredNpm} (the version declared in \`packageManager\`)`,
    );
  });

  it("checks workspace lock metadata explicitly after clean install", () => {
    const install = ci.indexOf("      - run: npm ci --no-audit");
    const workspaceInvariant = ci.indexOf(
      "      - run: npm run check:workspace-lock",
      install,
    );
    const unchangedDiff = ci.indexOf(
      "        run: git diff --exit-code -- package-lock.json",
      workspaceInvariant,
    );
    expect(install).toBeGreaterThan(0);
    expect(workspaceInvariant).toBeGreaterThan(install);
    expect(unchangedDiff).toBeGreaterThan(workspaceInvariant);
  });

  it("queues publication separately from push-driven version generation", () => {
    expect(workflow).toContain(
      "concurrency:\n  group: release-${{ github.event_name }}\n  queue: max",
    );
    expect(workflow).not.toContain("cancel-in-progress:");
    expect(contributing).toContain(
      "`queue: max` concurrency group; an arriving dispatch cannot replace an already\nwaiting publication",
    );
    expect(contributing).toContain(
      "Push-driven Version PR generation uses a separate event\ngroup",
    );
  });

  it("does not persist checkout credentials into any release install path", () => {
    const checkoutSteps = [
      ...workflow.matchAll(
        /^ {6}- uses: actions\/checkout@v7\n {8}with:\n((?: {10}.*\n)+)/gm,
      ),
    ];
    expect(checkoutSteps).toHaveLength(3);
    for (const step of checkoutSteps) {
      expect(step[1]).toContain("          persist-credentials: false\n");
    }
    expect(workflow).toContain(
      "          github-token: ${{ secrets.GITHUB_TOKEN }}",
    );
  });

  it("rejects unsupported modes before every other preflight step", () => {
    const modeGuard = workflow.indexOf(
      "      - name: Guard — require supported release mode",
    );
    const stableGuard = workflow.indexOf(
      "      - name: Guard — stable releases require main",
    );
    const modeStep = workflow.slice(modeGuard, stableGuard);

    expect(modeGuard).toBeGreaterThan(0);
    expect(modeGuard).toBeLessThan(stableGuard);
    expect(modeStep).not.toContain("        if:");
    expect(modeStep).toContain('          RELEASE_MODE: ${{ inputs.mode }}');
    expect(modeStep).toContain('          case "$RELEASE_MODE" in');
    expect(modeStep).toContain("            canary|stable) ;;");
    expect(modeStep).toContain(
      '              echo "::error::Release mode must be exactly canary or stable."',
    );
    expect(modeStep).toContain("              exit 1");
  });

  it("fails off-main stable dispatch and gates both ends of stable publication", () => {
    const guard = workflow.indexOf(
      "      - name: Guard — stable releases require main",
    );
    const preflightCheckout = workflow.indexOf(
      "      - uses: actions/checkout@v7",
      guard,
    );
    const install = workflow.indexOf("      - run: npm ci", preflightCheckout);
    const firstReadiness = workflow.indexOf(
      "      - name: Verify stable release readiness",
    );
    const finalReadinessAndPublish = workflow.indexOf(
      "      - name: Reverify readiness and publish stable",
    );
    const finalStepEnd = workflow.indexOf(
      "      - name: Publish canary",
      finalReadinessAndPublish,
    );
    const finalStep = workflow.slice(finalReadinessAndPublish, finalStepEnd);

    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(preflightCheckout);
    expect(preflightCheckout).toBeLessThan(install);
    expect(workflow.slice(guard, preflightCheckout)).toContain("exit 1");
    expect(firstReadiness).toBeGreaterThan(preflightCheckout);
    expect(finalReadinessAndPublish).toBeGreaterThan(firstReadiness);
    expect(finalStep.indexOf("node scripts/check-stable-release-readiness.mjs"))
      .toBeGreaterThan(0);
    expect(finalStep.indexOf("npx changeset publish")).toBeGreaterThan(
      finalStep.indexOf("node scripts/check-stable-release-readiness.mjs"),
    );
    expect(
      workflow.match(/node scripts\/check-stable-release-readiness\.mjs/g),
    ).toHaveLength(2);
    expect(workflow).not.toContain("      - name: Publish stable");
    expect(workflow).not.toContain(
      "inputs.mode == 'stable' && github.ref == 'refs/heads/main'",
    );
  });

  it("routes snapshot versioning through the lock-refreshing wrapper before verification", () => {
    const snapshot = workflow.indexOf(
      "        run: npm run version-packages -- --snapshot canary",
    );
    const typecheck = workflow.indexOf("      - name: Typecheck", snapshot);
    const test = workflow.indexOf("      - name: Test", snapshot);
    const build = workflow.indexOf("      - name: Build", snapshot);

    expect(snapshot).toBeGreaterThan(0);
    expect(snapshot).toBeLessThan(typecheck);
    expect(typecheck).toBeLessThan(test);
    expect(test).toBeLessThan(build);
    expect(workflow).not.toContain("npx changeset version --snapshot canary");
    expect(contributing).toContain(
      "`npm run version-packages -- --snapshot canary` produces a real snapshot\nversion and refreshes the npm workspace lock metadata before verification.",
    );
  });

  it("documents feature-branch canaries and exact-head stable evidence", () => {
    expect(contributing).toContain(
      "Canary dispatches publish the selected ref, not implicitly `main`.",
    );
    expect(contributing).toContain(
      "A feature\nbranch can therefore be selected for pre-merge canary validation",
    );
    expect(contributing).toContain(
      "at least one trusted human's latest decisive review must be\n`APPROVED`",
    );
    expect(contributing).toContain(
      "The publish job then\nperforms the final readiness evaluation and starts stable publication in the\nsame shell step.",
    );
    expect(contributing).toContain(
      "the GitHub API evaluation and npm publication are not an atomic transaction",
    );
  });

  it("rejects status plans that cannot produce a new snapshot version", () => {
    const unchangedRelease = {
      name: "@glasstrace/sdk",
      oldVersion: "1.32.1",
      newVersion: "1.32.1",
    };
    const nonVersionablePlans = [
      null,
      {},
      { releases: null },
      { releases: [] },
      { releases: [null] },
      { releases: [{ ...unchangedRelease, type: "none" }] },
      { releases: [{ ...unchangedRelease, type: "patch" }] },
      {
        releases: [
          {
            ...unchangedRelease,
            type: "none",
            newVersion: "1.32.2",
          },
        ],
      },
      {
        releases: [
          {
            ...unchangedRelease,
            type: "unknown",
            newVersion: "1.32.2",
          },
        ],
      },
      {
        releases: [
          {
            ...unchangedRelease,
            name: " ",
            type: "patch",
            newVersion: "1.32.2",
          },
        ],
      },
      {
        releases: [
          {
            ...unchangedRelease,
            type: "patch",
            oldVersion: "",
            newVersion: "1.32.2",
          },
        ],
      },
      {
        releases: [
          {
            ...unchangedRelease,
            type: "patch",
            newVersion: " ",
          },
        ],
      },
      {
        releases: [
          {
            name: "@glasstrace/sdk",
            type: "patch",
            oldVersion: 1,
            newVersion: 2,
          },
        ],
      },
    ];

    for (const status of nonVersionablePlans) {
      const result = runEmbeddedCanaryGuard(status);
      expect(result.exitCode, JSON.stringify(status)).toBe(1);
      expect(result.stderr, JSON.stringify(status)).toContain(
        "Canary mode requires at least one versionable package release",
      );
      expect(result.stderr, JSON.stringify(status)).toContain(
        "snapshot versioning is a no-op",
      );
      expect(result.stdout, JSON.stringify(status)).toBe("");
    }
  });

  it("accepts and counts only real patch, minor, or major version changes", () => {
    const noneRelease = {
      name: "@glasstrace/sdk",
      type: "none",
      oldVersion: "1.32.1",
      newVersion: "1.32.1",
    };
    const sdkPatch = {
      name: "@glasstrace/sdk",
      type: "patch",
      oldVersion: "1.32.1",
      newVersion: "1.32.2",
    };
    const protocolMinor = {
      name: "@glasstrace/protocol",
      type: "minor",
      oldVersion: "0.32.0",
      newVersion: "0.33.0",
    };
    const sdkMajor = {
      name: "@glasstrace/sdk",
      type: "major",
      oldVersion: "1.32.1",
      newVersion: "2.0.0",
    };
    const versionablePlans = [
      { releases: [sdkPatch], expectedCount: 1 },
      { releases: [protocolMinor], expectedCount: 1 },
      { releases: [sdkMajor], expectedCount: 1 },
      { releases: [noneRelease, sdkPatch], expectedCount: 1 },
      { releases: [sdkPatch, protocolMinor], expectedCount: 2 },
    ];

    for (const { expectedCount, releases } of versionablePlans) {
      const result = runEmbeddedCanaryGuard({ releases });
      expect(result.exitCode, JSON.stringify(releases)).toBe(0);
      expect(result.stderr, JSON.stringify(releases)).toBe("");
      expect(result.stdout, JSON.stringify(releases)).toBe(
        `Found ${expectedCount} versionable package release(s).\n`,
      );
    }
  });

  it("keeps the public canary runbook aligned with the versionable-release guard", () => {
    const workflowGuardErrors = [
      ...workflow.matchAll(/^[ \t]*console\.error\("([^"]+)"\);$/gm),
    ].map((match) => match[1]);
    const documentedGuardErrors =
      contributing.match(/^::error::.*$/gm) ?? [];

    expect(workflowGuardErrors).toEqual([
      "::error::Canary mode requires at least one versionable package release in .changeset/.",
      "::error::Without one, snapshot versioning is a no-op and canary publication would re-tag a stable version.",
    ]);
    expect(documentedGuardErrors).toEqual(workflowGuardErrors);
    expect(contributing).toContain(
      "`Guard — require versionable changesets for canary`",
    );
    expect(contributing).toContain(
      "Ignored guide files such as `.changeset/README.md`, empty changesets, and\nexplicit `none` release entries do not qualify.",
    );
    expect(contributing).toContain(
      "The guard requires a real\n`patch`, `minor`, or `major` version change.",
    );
    expect(contributing).not.toContain(
      "`Guard — require changesets for canary`",
    );
    expect(contributing).not.toContain(
      "requires at least one changeset in .changeset/.",
    );
  });

  it.skipIf(process.platform === "win32")(
    "makes the local Changesets base branch resolvable after a full feature-branch checkout",
    () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), "glasstrace-release-base-ref-"),
      );
      const seed = join(fixtureRoot, "seed");
      const origin = join(fixtureRoot, "origin.git");
      const checkout = join(fixtureRoot, "checkout");
      const isolatedGlobalConfig = join(fixtureRoot, "global.gitconfig");
      const baseBranchCommand =
        "git show-ref --verify --quiet refs/heads/main || git branch --track main refs/remotes/origin/main";
      writeFileSync(isolatedGlobalConfig, "");
      const hostileGitEnvironment = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
        GIT_CONFIG_KEY_0: "commit.gpgSign",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_VALUE_0: "true",
        GIT_TERMINAL_PROMPT: "0",
        HOME: fixtureRoot,
        LANG: "C",
        LC_ALL: "C",
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: fixtureRoot,
      };
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          env: hostileGitEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();

      expect(workflow).toContain(`        run: ${baseBranchCommand}`);

      try {
        git(fixtureRoot, "init", "-b", "main", seed);
        git(seed, "config", "user.name", "Release contract fixture");
        git(seed, "config", "user.email", "release-contract@example.invalid");
        expect(git(seed, "config", "--bool", "--get", "commit.gpgSign")).toBe(
          "true",
        );
        writeFileSync(join(seed, "fixture.txt"), "main\n");
        git(seed, "add", "fixture.txt");
        git(
          seed,
          "commit",
          "--no-gpg-sign",
          "--no-verify",
          "-m",
          "main fixture",
        );
        const mainSha = git(seed, "rev-parse", "HEAD");

        git(seed, "switch", "-c", "feature");
        writeFileSync(join(seed, "fixture.txt"), "feature\n");
        git(
          seed,
          "commit",
          "--no-gpg-sign",
          "--no-verify",
          "-am",
          "feature fixture",
        );
        git(fixtureRoot, "clone", "--bare", seed, origin);
        git(
          fixtureRoot,
          "clone",
          "--branch",
          "feature",
          origin,
          checkout,
        );

        expect(
          spawnSync(
            "git",
            ["show-ref", "--verify", "--quiet", "refs/heads/main"],
            { cwd: checkout, env: hostileGitEnvironment },
          ).status,
        ).toBe(1);
        expect(git(checkout, "rev-parse", "refs/remotes/origin/main")).toBe(
          mainSha,
        );

        execFileSync("bash", ["-c", baseBranchCommand], {
          cwd: checkout,
          env: hostileGitEnvironment,
          stdio: "pipe",
        });

        expect(git(checkout, "rev-parse", "refs/heads/main")).toBe(mainSha);
        expect(git(checkout, "merge-base", "main", "HEAD")).toBe(mainSha);

        // The same step is safe when the local branch already exists.
        execFileSync("bash", ["-c", baseBranchCommand], {
          cwd: checkout,
          env: hostileGitEnvironment,
          stdio: "pipe",
        });
        expect(git(checkout, "rev-parse", "refs/heads/main")).toBe(mainSha);
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
  );

  it("allows YAML comments without weakening the permission scalar", () => {
    const noComment = workflow.replace(
      "      id-token: write  # OIDC for npm trusted publishing",
      "      id-token: write",
    );
    const tabComment = workflow.replace(
      "      id-token: write  # OIDC for npm trusted publishing",
      "      id-token: write\t# replacement explanation",
    );
    const changedScalar = workflow.replace(
      "      id-token: write  # OIDC for npm trusted publishing",
      "      id-token: write\u00a0# not a YAML comment",
    );
    const addedYamlComment = workflow.replace(
      "jobs:\n",
      "jobs:\n  # semantically inert replacement explanation\n",
    );
    const afterScalarComments = [
      "# inert",
      "      # inert",
      "        # inert",
      "         # inert between the header and content indent",
      "         # ${{ fromJSON('ignored-outside-scalar') }}",
    ]
      .map((comment) =>
        workflow.replace(
          "          NODE",
          `          NODE\n${comment}`,
        ),
      );

    expect(() => assertReleaseWorkflowContract(noComment)).not.toThrow();
    expect(() => assertReleaseWorkflowContract(tabComment)).not.toThrow();
    expect(() => assertReleaseWorkflowContract(addedYamlComment)).not.toThrow();
    for (const afterScalarComment of afterScalarComments) {
      expect(() =>
        assertReleaseWorkflowContract(afterScalarComment),
      ).not.toThrow();
    }
    expect(() => assertReleaseWorkflowContract(changedScalar)).toThrow();
  });

  it("retains comment content for every legal block-scalar header form", () => {
    const headers = [
      "|",
      "|-",
      "|+",
      "|2",
      "|-2",
      "|+2",
      "|2-",
      "|2+",
      ">",
      ">-",
      ">+",
      ">2",
      ">-2",
      ">+2",
      ">2-",
      ">2+",
    ];
    const expressionComment = "  # ${{ fromJSON('not-json') }}";

    for (const header of headers) {
      expect(contractLines(`run: ${header}\n${expressionComment}`)).toEqual([
        `run: ${header}`,
        expressionComment,
      ]);
    }
  });

  it("retains blank lines that belong to literal or folded scalars", () => {
    for (const header of ["|", "|-", "|+", ">", ">-", ">+"]) {
      expect(
        contractLines(
          [`run: ${header}`, "  echo one", "", "  echo two", "next: value"].join(
            "\n",
          ),
        ),
      ).toEqual([
        `run: ${header}`,
        "  echo one",
        "",
        "  echo two",
        "next: value",
      ]);
    }
  });

  it("retains trailing blank lines only when keep chomping makes them content", () => {
    const keepHeaders = ["|+", "|+2", "|2+", ">+", ">+2", ">2+"];

    for (const header of keepHeaders) {
      const emptyScalarIndent = header.includes("2") ? "  " : " ";
      expect(
        contractLines(
          [`run: ${header}`, "  echo ok", "", "next: value"].join("\n"),
        ),
      ).toEqual([`run: ${header}`, "  echo ok", "", "next: value"]);
      expect(contractLines(`run: ${header}\n  echo ok\n`)).toEqual([
        `run: ${header}`,
        "  echo ok",
      ]);
      expect(contractLines(`run: ${header}\n  echo ok\n\n`)).toEqual([
        `run: ${header}`,
        "  echo ok",
        "",
      ]);
      expect(contractLines(`run: ${header}\n  echo ok\n `)).toEqual([
        `run: ${header}`,
        "  echo ok",
      ]);
      expect(contractLines(`run: ${header}\n  echo ok\n \n`)).toEqual([
        `run: ${header}`,
        "  echo ok",
        "",
      ]);
      expect(contractLines(`run: ${header}\n  echo ok\n   `)).toEqual([
        `run: ${header}`,
        "  echo ok",
        "   ",
      ]);
      expect(contractLines(`run: ${header}\n  echo ok\n   \n`)).toEqual([
        `run: ${header}`,
        "  echo ok",
        "   ",
      ]);
      expect(contractLines(`run: ${header}\n${emptyScalarIndent}`)).toEqual([
        `run: ${header}`,
        "",
      ]);
      expect(
        contractLines(`run: ${header}\n${emptyScalarIndent}\n`),
      ).toEqual([
        `run: ${header}`,
        "",
      ]);
      expect(
        contractLines(
          `run: ${header}\n${emptyScalarIndent}\n${emptyScalarIndent}\n`,
        ),
      ).toEqual([
        `run: ${header}`,
        "",
        "",
      ]);
    }

    for (const header of ["|+2", "|2+", ">+2", ">2+"]) {
      expect(contractLines(`run: ${header}\n `)).toEqual([
        `run: ${header}`,
      ]);
      expect(contractLines(`run: ${header}\n \n`)).toEqual([
        `run: ${header}`,
        "",
      ]);
    }

    for (const [header, overIndentedBlank] of [
      ["|+1", "  "],
      ["|1+", "  "],
      [">+1", "  "],
      [">1+", "  "],
      ["|+2", "   "],
      ["|2+", "   "],
      [">+2", "   "],
      [">2+", "   "],
    ]) {
      expect(
        contractLines(`run: ${header}\n\n${overIndentedBlank}`),
      ).toEqual([`run: ${header}`, ""]);
      expect(
        contractLines(`run: ${header}\n\n${overIndentedBlank}\n`),
      ).toEqual([`run: ${header}`, "", ""]);
      expect(
        contractLines(
          `run: ${header}\n${overIndentedBlank}\n  echo ok`,
        ),
      ).toContain(overIndentedBlank);
    }

    for (const header of ["|", "|-", "|2-", ">", ">-", ">2-"]) {
      expect(
        contractLines(
          [`run: ${header}`, "  echo ok", "", "next: value"].join("\n"),
        ),
      ).toEqual([`run: ${header}`, "  echo ok", "next: value"]);
    }
  });

  it("distinguishes scalar content indentation from header indentation", () => {
    const outsideComment = [
      "        run: |",
      "          echo ok",
      "         # inert outside comment",
      "      next: value",
    ].join("\n");
    const resumedScalar = [
      "        run: |",
      "          echo one",
      "         # invalid dedent before resumed scalar content",
      "          echo two",
      "      next: value",
    ].join("\n");

    expect(contractLines(outsideComment)).toEqual([
      "        run: |",
      "          echo ok",
      "      next: value",
    ]);
    expect(contractLines(resumedScalar)).toContain(
      "         # invalid dedent before resumed scalar content",
    );
  });

  it("fails closed on alternate YAML and publication paths", () => {
    const mutations = [
      workflow.replace(
        "      contents: write\n      pull-requests: write",
        "      contents: write\n      ? actions\n      : write\n      pull-requests: write",
      ),
      workflow.replace(
        "      - run: npm ci",
        "      - run: >-\n          npx changeset\n          publish",
      ),
      workflow.replace(
        "      - name: Publish canary",
        "      - uses: JS-DevTools/npm-publish@v3\n      - name: Publish canary",
      ),
      workflow.replace(
        "      - name: Typecheck\n        run: npm run typecheck",
        "      - name: Typecheck\n        run: echo skipped",
      ),
      workflow.replace(
        "        run: npx changeset publish --tag canary",
        "        run: npx changeset publish --tag canary\n          \u00a0",
      ),
      workflow.replace(
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"',
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"\n          # ${{ fromJSON(\'not-json\') }}',
      ),
      workflow.replace(
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"',
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"\n\t# ${{ fromJSON(\'not-json\') }}',
      ),
      workflow.replace(
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"',
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"\n        # dedented scalar comment',
      ),
      workflow.replace(
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"',
        '          npx changeset status --output="$RUNNER_TEMP/changeset-status.json"\n\t',
      ),
      workflow.replace(
        "        run: |",
        '        run: |\n        # ${{ fromJSON("not-json") }}',
      ),
      workflow.replace(
        "          NODE",
        "          NODE\n           ",
      ),
    ];

    for (const mutation of mutations) {
      expect(() => assertReleaseWorkflowContract(mutation)).toThrow();
    }
  });
});
