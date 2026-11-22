/**
 * The static rules of the shared read core (Mastra migration MP-4b, PR-4;
 * DR-MP4-3, DR-MP4-21 rule 4).
 *
 * 1. Imports. Nothing under `electron/shared/readDomain/` (the core and the
 *    pure modules moved there) and no port type module may import a store, the
 *    renderer's IPC (`invoke`, `tauri`), i18n, React, the chat IR or anything
 *    outside `electron/shared`. The rule is a whitelist of package specifiers
 *    plus a relative path that stays inside `electron/shared`, so a package or
 *    a path nobody thought of is refused too. Written with the TypeScript AST:
 *    a pattern cannot tell `import()` and `require()` from text.
 * 2. SQL. The core issues Drizzle selects and nothing else: no argument-less
 *    `.get()` (main's adapter does not send method `get`), no `findFirst` or `$with` (a `with`
 *    statement is refused), no write, no raw `sql`, and no string that is a
 *    statement. Every table it names in `from` or a join is a table of the
 *    schema, and the set of them is exactly `MAIN_READ_TABLES`: a table that the
 *    core starts to touch (or stops touching) is a diff of `tables.ts`, of
 *    `tables.test.ts` and of this test.
 *
 * A negative control feeds each violation to the same scanners.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MAIN_READ_TABLES } from "../../mastraRead/tables.js";
import * as schema from "../db/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedRoot = path.resolve(here, "..", "..");
const repoRoot = path.resolve(sharedRoot, "..", "..");
const coreDir = here;
const readDomainDir = path.resolve(here, "..");
const SCAN_FILES = [path.join(sharedRoot, "mastraRead", "ports.ts")];

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;
const DECLARATION = /\.d\.[cm]?ts$/u;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (SOURCE.test(name) && !TEST.test(name) && !DECLARATION.test(name)) {
      yield full;
    }
  }
}

const repoRelative = (file: string): string =>
  path.relative(repoRoot, file).split(path.sep).join("/");

// ---------------------------------------------------------------------------
// 1. Imports
// ---------------------------------------------------------------------------

/** The only packages the core and its pure modules may import. */
const ALLOWED_PACKAGES: ReadonlySet<string> = new Set([
  "drizzle-orm",
  "drizzle-orm/sqlite-core",
  "drizzle-orm/sqlite-proxy",
  "fractional-indexing",
  "temporal-polyfill",
]);

/** Names that mean a store, the renderer's IPC, i18n, React or the chat IR. */
const FORBIDDEN_SPECIFIER: readonly RegExp[] = [
  /(?:^|\/)(?:treeStore|projectStore|phaseStore|chatStore|[a-z]\w*Store)(?:\.[cm]?[jt]s)?$/u,
  /(?:^|\/)(?:tauri|invoke|i18n|debugLog)(?:\.[cm]?[jt]s)?$/u,
  /(?:^|[/@-])(?:zustand|jotai|i18next|react|tauri)(?:$|[/-])/u,
  /chat[-_]?agent[-_]?ir/iu,
  /chatIr/u,
  /chronicleReadingPosition/u,
  /toolExecutors/u,
  /toolDefinitions/u,
];

const FORBIDDEN_TEXT: readonly RegExp[] = [
  /chat[-_]?agent[-_]?ir/iu,
  /chatIr/u,
  /CHAT_AGENT_IR/u,
  /searchEventsWithIr/u,
];

function specifierViolations(
  name: string,
  fromFile: string,
  specifier: string,
): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_SPECIFIER) {
    if (pattern.test(specifier)) {
      violations.push(`${name}: imports ${specifier} (${pattern})`);
    }
  }
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    const inside = path.relative(sharedRoot, resolved);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      violations.push(`${name}: imports ${specifier}, outside electron/shared`);
    }
    if (/(?:^|[/\\])ipcContract(?:\.[cm]?[jt]s)?$/u.test(specifier)) {
      violations.push(`${name}: imports ipcContract`);
    }
  } else if (!ALLOWED_PACKAGES.has(specifier)) {
    violations.push(`${name}: imports ${specifier} (not an allowed package)`);
  }
  return violations;
}

/** Every import-rule violation of one source, as a short readable line. */
export function scanImports(
  name: string,
  text: string,
  fromFile: string,
): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_TEXT) {
    if (pattern.test(text)) violations.push(`${name}: names ${pattern}`);
  }
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node | undefined, how: string): void => {
    if (
      node !== undefined &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      violations.push(...specifierViolations(name, fromFile, node.text));
    } else {
      violations.push(`${name}: ${how} with a computed specifier`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        literal(node.moduleSpecifier, "a static import");
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression, "import = require");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        literal(node.arguments[0], "import()");
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        literal(node.arguments[0], "require()");
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      violations.push(
        ...specifierViolations(name, fromFile, node.argument.literal.text),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

// ---------------------------------------------------------------------------
// 2. SQL
// ---------------------------------------------------------------------------

/**
 * A method the core may not call: it is not a Drizzle select, or main's adapter
 * cannot send it. `.get()` is handled apart (a `Map` has one with an argument);
 * `.all()` and `.values()` are the two methods main sends.
 */
const FORBIDDEN_CALLS: ReadonlySet<string> = new Set([
  "run",
  "execute",
  "insert",
  "update",
  "delete",
  "transaction",
  "batch",
  "findFirst",
  "findMany",
  "$with",
  "with",
  "query",
  "$client",
]);

const TABLE_REFERENCE_CALLS: ReadonlySet<string> = new Set([
  "from",
  "leftJoin",
  "rightJoin",
  "innerJoin",
  "fullJoin",
  "crossJoin",
]);

/** A string that is a statement: raw SQL assembled into the core. */
const STATEMENT_TEXT =
  /^\s*(?:select|insert|update|delete|with|pragma|create|drop|alter|replace|attach|vacuum)\b/iu;

const tableNameOf = (binding: string): string | undefined => {
  const value = (schema as Record<string, unknown>)[binding];
  return is(value, SQLiteTable) ? getTableName(value) : undefined;
};

export interface DrizzleScan {
  readonly tables: ReadonlySet<string>;
  readonly violations: readonly string[];
}

/** The tables a source names in `from` and joins, and every SQL-rule violation. */
export function scanDrizzle(
  name: string,
  text: string,
  tableOf: (binding: string) => string | undefined = tableNameOf,
): DrizzleScan {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const tables = new Set<string>();
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      const bindings = node.importClause?.namedBindings;
      if (
        ts.isStringLiteral(specifier) &&
        specifier.text === "drizzle-orm" &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "sql") {
            violations.push(`${name}: imports raw sql from drizzle-orm`);
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      if (FORBIDDEN_CALLS.has(method)) {
        violations.push(`${name}: calls .${method}()`);
      }
      // Drizzle's `.get()` takes no argument; `Map.prototype.get` takes one.
      if (method === "get" && node.arguments.length === 0) {
        violations.push(`${name}: calls .get() with no argument (Drizzle's)`);
      }
      if (TABLE_REFERENCE_CALLS.has(method)) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isIdentifier(first)) {
          const table = tableOf(first.text);
          if (table === undefined) {
            violations.push(
              `${name}: .${method}(${first.text}) is not a table of the schema`,
            );
          } else {
            tables.add(table);
          }
        } else {
          violations.push(
            `${name}: .${method}() with an argument that is not a table binding`,
          );
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === "query" || node.name.text === "$client")
    ) {
      violations.push(`${name}: reads .${node.name.text}`);
    }
    if (ts.isTaggedTemplateExpression(node)) {
      violations.push(`${name}: a tagged template (raw SQL)`);
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      STATEMENT_TEXT.test(
        ts.isTemplateExpression(node) ? node.head.text : node.text,
      )
    ) {
      violations.push(`${name}: a string that is a statement`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { tables, violations };
}

// ---------------------------------------------------------------------------

describe("the core and the pure modules import no store, IPC, i18n, React, chat IR or renderer", () => {
  const files = [...sourceFiles(readDomainDir), ...SCAN_FILES];

  it("scans the core, the moved modules and the port types", () => {
    const relative = files.map((file) => repoRelative(file));
    expect(files.length).toBeGreaterThanOrEqual(35);
    for (const expected of [
      "electron/shared/readDomain/core/readExecutors.ts",
      "electron/shared/readDomain/core/treeReadTools.ts",
      "electron/shared/readDomain/core/plotThreadTools.ts",
      "electron/shared/readDomain/core/codexTagTools.ts",
      "electron/shared/readDomain/db/schema.ts",
      "electron/shared/readDomain/lib/fts.ts",
      "electron/shared/mastraRead/ports.ts",
    ]) {
      expect(relative).toContain(expected);
    }
  });

  it("has no violation in any of them", () => {
    const violations = files.flatMap((file) =>
      scanImports(repoRelative(file), readFileSync(file, "utf8"), file),
    );
    expect(violations).toEqual([]);
  });
});

describe("the core issues Drizzle selects only, over exactly the allowlisted tables", () => {
  const files = [...sourceFiles(coreDir)];
  const scans = files.map((file) => ({
    file: repoRelative(file),
    scan: scanDrizzle(repoRelative(file), readFileSync(file, "utf8")),
  }));

  it("has no SQL-rule violation", () => {
    expect(scans.flatMap(({ scan }) => scan.violations)).toEqual([]);
  });

  it("names the tables of MAIN_READ_TABLES and no other", () => {
    const named = new Set(scans.flatMap(({ scan }) => [...scan.tables]));
    expect([...named].sort()).toEqual([...MAIN_READ_TABLES]);
  });

  it("every allowlisted table is a table of the schema", () => {
    const real = new Set(
      Object.values(schema)
        .filter((value) => is(value, SQLiteTable))
        .map((value) => getTableName(value as SQLiteTable)),
    );
    for (const table of MAIN_READ_TABLES) expect(real.has(table)).toBe(true);
  });
});

const fixtureTable = (binding: string): string | undefined =>
  ({ treeNodes: "tree_nodes", narrativeRuns: "narrative_runs" })[binding];

describe("the scanners catch each violation (negative control)", () => {
  const importOf = (specifier: string): string =>
    "import { x } from " + JSON.stringify(specifier) + ";\nexport const y = x;";
  const here_ = path.join(coreDir, "fixture.ts");

  it("passes a clean core module", () => {
    expect(
      scanImports(
        "ok.ts",
        [
          'import { and, eq } from "drizzle-orm";',
          'import { treeNodes } from "../db/schema.js";',
          'import type { CoreReadContext } from "../../mastraRead/ports.js";',
          "export const f = (ctx: CoreReadContext) => [and, eq, treeNodes, ctx];",
        ].join("\n"),
        here_,
      ),
    ).toEqual([]);
  });

  it.each([
    ["a store", importOf("../../../../src/features/tree/treeStore")],
    ["a store by alias", importOf("@/features/tree/treeStore")],
    ["the project store", importOf("../features/project/projectStore.js")],
    ["the renderer's IPC", importOf("@/lib/tauri")],
    ["the tauri api", importOf("@tauri-apps/api/core")],
    ["i18n", importOf("@/lib/i18n")],
    ["i18next", importOf("i18next")],
    ["react", importOf("react")],
    ["zustand", importOf("zustand")],
    ["jotai", importOf("jotai")],
    ["the renderer's db client", importOf("@/db/client")],
    ["a node builtin", importOf("node:fs")],
    ["electron", importOf("electron")],
    ["a package nobody listed", importOf("lodash")],
    [
      "a relative path out of electron/shared",
      importOf("../../../main/ipc.js"),
    ],
    ["the IPC contract", importOf("../../ipcContract.js")],
    ["the chat IR availability", importOf("./chatAgentIrAvailability.js")],
    ["the chat IR result module", importOf("../chatIrToolResult.js")],
    [
      "the IR position module",
      importOf("../features/chronicle/chronicleReadingPosition.js"),
    ],
    ["the tool executors", importOf("./toolExecutors.js")],
    ["a dynamic import", 'export const f = () => import("@/lib/tauri");'],
    ["a computed dynamic import", "export const f = (p: string) => import(p);"],
    ["a require", 'export const f = () => require("@/lib/tauri");'],
    [
      "an import type of src",
      'export type T = import("@/features/tree/treeStore").X;',
    ],
    [
      "a re-export",
      'export { useTreeStore } from "@/features/tree/treeStore";',
    ],
    [
      "the IR flag in a comment",
      "// CHAT_AGENT_IR_ENABLED\nexport const a = 1;",
    ],
  ])("flags %s", (_name, source) => {
    expect(scanImports("bad.ts", source, here_)).not.toEqual([]);
  });

  const drizzle = (body: string): DrizzleScan =>
    scanDrizzle("bad.ts", body, fixtureTable);

  it("collects the tables of from and of every join", () => {
    const scan = drizzle(
      "export const q = (db: D) => db.select().from(treeNodes).leftJoin(treeNodes, x);",
    );
    expect(scan.violations).toEqual([]);
    expect([...scan.tables]).toEqual(["tree_nodes"]);
  });

  it("sees a table that is not in the allowlist (a closed table)", () => {
    const scan = drizzle(
      "export const q = (db: D) => db.select().from(narrativeRuns);",
    );
    expect([...scan.tables]).toEqual(["narrative_runs"]);
    expect(
      [...scan.tables].filter(
        (t) => !(MAIN_READ_TABLES as readonly string[]).includes(t),
      ),
    ).toEqual(["narrative_runs"]);
  });

  it.each([
    [
      "a .get()",
      "export const q = (db: D) => db.select().from(treeNodes).get();",
    ],
    ["a .run()", "export const q = (db: D) => db.run(x);"],
    [
      "findFirst",
      "export const q = (db: D) => db.query.treeNodes.findFirst();",
    ],
    ["$with", "export const q = (db: D) => db.$with('a');"],
    ["with", "export const q = (db: D) => db.with(a).select();"],
    ["a write", "export const q = (db: D) => db.insert(treeNodes).values(x);"],
    ["an update", "export const q = (db: D) => db.update(treeNodes).set(x);"],
    ["a delete", "export const q = (db: D) => db.delete(treeNodes);"],
    ["a transaction", "export const q = (db: D) => db.transaction(f);"],
    [
      "raw sql imported",
      'import { sql } from "drizzle-orm";\nexport const q = sql;',
    ],
    [
      "a tagged template",
      "export const q = (id: string) => sql`select ${id}`;",
    ],
    ["a statement in a string", 'export const q = "select * from tree_nodes";'],
    [
      "a statement in a template",
      "export const q = (t: string) => `delete from ${t}`;",
    ],
    [
      "a from with a variable",
      "export const q = (db: D, t: T) => db.select().from(t);",
    ],
    [
      "a from with an unknown binding",
      "export const q = (db: D) => db.select().from(unknownTable);",
    ],
    [
      "a join with a call",
      "export const q = (db: D) => db.select().from(treeNodes).leftJoin(pick(), x);",
    ],
  ])("flags %s", (_name, source) => {
    expect(drizzle(source).violations).not.toEqual([]);
  });
});
