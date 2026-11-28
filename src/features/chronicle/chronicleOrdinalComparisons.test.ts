import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const roots = [
  "src/features/chronicle",
  "electron/shared/readDomain/features/chronicle",
  "electron/shared/readDomain/core",
  "src/application",
];

const allowedComparisons = [
  {
    file: "electron/shared/readDomain/features/chronicle/resolveSceneAnchor.ts",
    functionName: "maxOrdinal",
    expression: "cmpKeys(e.ordinal, best.ordinal) > 0",
    reason:
      "The legacy resolver selects a directly linked event by reading order; it does not compare event dates.",
  },
  {
    file: "electron/shared/readDomain/features/chronicle/resolveSceneAnchor.ts",
    functionName: "syntheticOrdinal",
    expression: "cmpKeys(e.ordinal, best.ordinal) > 0",
    reason: "Ordinal breaks a tie after equal event start dates.",
  },
  {
    file: "electron/shared/readDomain/features/chronicle/chronicleAnchorByDate.ts",
    functionName: "syntheticOrdinal",
    expression: "cmpKeys(e.ordinal, best.ordinal) > 0",
    reason: "Ordinal breaks a tie after equal event start dates.",
  },
  {
    file: "electron/shared/readDomain/features/chronicle/chronicleOrder.ts",
    functionName: "tieBreak",
    expression: "cmpKeys(a.ordinal, b.ordinal)",
    reason: "K1 uses ordinal only to break equal date-span positions.",
  },
  {
    file: "electron/shared/readDomain/features/chronicle/chronicleProvisionalDate.ts",
    functionName: "provisionalEventDates",
    expression: "cmpKeys(a.ordinal, b.ordinal)",
    reason:
      "K1 orders undated events before their provisional dates are assigned.",
  },
  {
    file: "electron/shared/readDomain/core/chronicleTools.ts",
    functionName: "getCharacterTimeline",
    expression: "cmpKeys(a.ordinal, b.ordinal)",
    reason: "This sorts the character timeline for display.",
  },
  {
    file: "src/features/chronicle/chronicleAxis.ts",
    functionName: "compareByOrdinalAndId",
    expression: "cmpKeys(a.ordinal, b.ordinal)",
    reason:
      "This sorts the timeline display when no calendar date axis is available.",
  },
  {
    file: "electron/shared/readDomain/features/chronicle/chronicleTime.ts",
    functionName: "nextEventOrdinal",
    expression: "cmpKeys(k, max)",
    reason: "This finds the maximum key to generate the next ordinal.",
  },
];

function isProductSource(name: string): boolean {
  return (
    /\.(ts|tsx)$/.test(name) &&
    !/\.(test|spec|fixture|fixtures)\.(ts|tsx)$/.test(name) &&
    !name.endsWith(".d.ts")
  );
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && isProductSource(entry.name) ? [path] : [];
  });
}

function functionNameOf(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      if (
        ts.isVariableDeclaration(parent.parent) &&
        ts.isIdentifier(parent.parent.name)
      ) {
        return parent.parent.name.text;
      }
    }
    if (
      (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text;
    }
  }
  return "<top-level>";
}

function isOrdinalComparison(node: ts.Node, functionName: string): boolean {
  const hasOrdinal = (child: ts.Node) => /\bordinal\b/.test(child.getText());
  const isRelational = (operator: ts.SyntaxKind) =>
    operator === ts.SyntaxKind.LessThanToken ||
    operator === ts.SyntaxKind.GreaterThanToken ||
    operator === ts.SyntaxKind.LessThanEqualsToken ||
    operator === ts.SyntaxKind.GreaterThanEqualsToken;
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    return (
      isRelational(operator) &&
      (hasOrdinal(node.left) || hasOrdinal(node.right))
    );
  }
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression) && node.expression.text === "cmpKeys") {
    if (
      node.parent &&
      ts.isBinaryExpression(node.parent) &&
      isRelational(node.parent.operatorToken.kind) &&
      functionName !== "nextEventOrdinal"
    ) {
      return false;
    }
    return (
      node.arguments.some(hasOrdinal) || functionName === "nextEventOrdinal"
    );
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "localeCompare"
  ) {
    if (
      node.parent &&
      ts.isBinaryExpression(node.parent) &&
      isRelational(node.parent.operatorToken.kind)
    ) {
      return false;
    }
    return (
      hasOrdinal(node.expression.expression) || node.arguments.some(hasOrdinal)
    );
  }
  return false;
}

describe("chronicle ordinal comparisons", () => {
  it("rejects direct ordinal comparisons outside the documented ordering cases", () => {
    const root = process.cwd();
    const remaining = new Set(allowedComparisons.map((_, index) => index));
    const unexpected: string[] = [];

    for (const sourcePath of roots.flatMap(sourceFiles)) {
      const file = relative(root, sourcePath).replaceAll("\\", "/");
      const source = ts.createSourceFile(
        sourcePath,
        readFileSync(sourcePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        sourcePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node) => {
        const functionName = functionNameOf(node);
        if (isOrdinalComparison(node, functionName)) {
          const expression = node.getText(source).replace(/\s+/g, " ");
          const allowIndex = allowedComparisons.findIndex(
            (allowed, index) =>
              remaining.has(index) &&
              allowed.file === file &&
              allowed.functionName === functionName &&
              allowed.expression === expression,
          );
          if (allowIndex === -1) {
            unexpected.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${expression}`,
            );
          } else {
            remaining.delete(allowIndex);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(unexpected).toEqual([]);
    expect(
      [...remaining].map((index) => {
        const { file, functionName, reason } = allowedComparisons[index];
        return `${file} (${functionName}): ${reason}`;
      }),
    ).toEqual([]);
  });
});
