import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * SDK-032 edge-compat JSDoc gate.
 *
 * Every symbol re-exported from `packages/sdk/src/node-subpath.ts` must
 * carry a JSDoc comment on its source declaration that contains the
 * literal string "Node-only." (case-sensitive). The marker lives on the
 * source declaration — not on the re-export — because TypeScript IDE
 * tooltips follow the `export { ... } from "..."` re-export to the
 * original symbol and surface its JSDoc, not the barrel's.
 *
 * This test fails in a named way when a specific symbol is missing the
 * marker, so a CI failure points directly at the symbol that needs a
 * `@remarks Node-only. …` block. It also hard-codes the expected count
 * (14 = 10 values + 4 types) so that adding a new `/node` export
 * without a matching JSDoc block surfaces as a test failure rather than
 * a silent gap.
 *
 * The test only walks ASTs — it does not execute any SDK source — so
 * it is safe to run in any environment Vitest supports.
 */

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisFileDir, "../../..");
const nodeSubpathFile = path.join(
  repoRoot,
  "packages/sdk/src/node-subpath.ts",
);

const EXPECTED_NODE_EXPORT_COUNT = 15;
const NODE_ONLY_MARKER = "Node-only.";

/**
 * Builds a TypeScript program rooted at `node-subpath.ts` so the
 * checker can follow the `export { ... } from "..."` re-exports down
 * to their source declarations.
 */
function createProgram(): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  };
  return ts.createProgram({
    rootNames: [nodeSubpathFile],
    options: compilerOptions,
  });
}

/**
 * Returns the JSDoc text attached to the declaration of `symbol` in the
 * given `checker`. Resolves aliases so that an `export { foo } from
 * "./source-map-uploader.js"` returns the JSDoc on `foo`'s declaration
 * in `source-map-uploader.ts`, not on the re-export statement.
 *
 * The concatenation across multiple declarations (function overloads,
 * merged interfaces) is intentional: any declaration carrying the
 * marker satisfies the gate.
 */
function getJsDocText(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  const resolved = symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;

  const declarations = resolved.getDeclarations() ?? [];
  const parts: string[] = [];
  for (const decl of declarations) {
    const jsDocs = ts.getJSDocCommentsAndTags(decl);
    for (const doc of jsDocs) {
      parts.push(doc.getFullText());
    }
  }
  return parts.join("\n");
}

interface ExportAnnotations {
  annotations: Map<string, string>;
  valueCount: number;
  typeCount: number;
}

/**
 * Collects the JSDoc text for every export declared in `node-subpath.ts`,
 * keyed by export name, and counts how many are value exports vs.
 * type-only exports.
 */
function collectNodeSubpathAnnotations(): ExportAnnotations {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(nodeSubpathFile);
  if (!source) {
    throw new Error(
      `node-subpath.ts not found in program: ${nodeSubpathFile}`,
    );
  }

  const annotations = new Map<string, string>();
  let valueCount = 0;
  let typeCount = 0;

  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) {
      continue;
    }
    const isTypeOnly = statement.isTypeOnly;
    for (const element of clause.elements) {
      const localName = (element.propertyName ?? element.name).text;
      const exportedName = element.name.text;
      const symbol = checker.getSymbolAtLocation(element.name);
      if (!symbol) {
        throw new Error(
          `No symbol resolved for /node export "${exportedName}" ` +
            `(source-declared as "${localName}")`,
        );
      }
      annotations.set(exportedName, getJsDocText(checker, symbol));
      if (isTypeOnly || element.isTypeOnly) {
        typeCount++;
      } else {
        valueCount++;
      }
    }
  }

  return { annotations, valueCount, typeCount };
}

describe("SDK-032 /node surface JSDoc marker", () => {
  const { annotations, valueCount, typeCount } =
    collectNodeSubpathAnnotations();

  it("covers exactly 15 /node exports (11 values + 4 types)", () => {
    expect(annotations.size).toBe(EXPECTED_NODE_EXPORT_COUNT);
    expect(valueCount).toBe(11);
    expect(typeCount).toBe(4);
  });

  for (const [name, jsDoc] of annotations) {
    it(`"${name}" JSDoc contains the "${NODE_ONLY_MARKER}" marker`, () => {
      expect(jsDoc).toContain(NODE_ONLY_MARKER);
    });
  }
});
