/**
 * Main's read port keeps the chat IR closed, and names a Native command only
 * as one of four literal keys (Mastra migration MP-4b, DR-MP4-21 rules 1 and 5,
 * DR-MP4-6).
 *
 * `chatAgentIr.test.ts` already fixes that no product source in `electron/`,
 * `src/` or `packages/` contains the hyphenated gate kind. It does not see the
 * snake_case command name, the camel-case method, the flag, the renderer's IR
 * modules, nor a command looked up through `NAPI_COMMANDS` with a variable. So
 * this test reads the new read-port sources more narrowly:
 *   - the scan roots are DIRECTORIES (`electron/main/mastraRead/`,
 *     `electron/shared/mastraRead/`, and `electron/shared/readDomain/` where the
 *     shared core lives) plus the shared timeout module, so a file a later PR
 *     puts there is covered without a list to update;
 *   - no source (comments included) names an IR symbol, command or module;
 *   - no source imports from `src/` (`@/...`), the tool definitions or the tool
 *     executors;
 *   - `NAPI_COMMANDS` appears only as an import of the name itself and as
 *     `NAPI_COMMANDS.<one of the four literal keys>`: no bracket access, no
 *     alias, no destructuring, no `Object.keys`, no string of its name;
 *   - from `ipcContract` a source imports `NAPI_COMMANDS` and types, nothing
 *     else (`dispatchInvoke` and the rest of the file's values are the router);
 *   - `import()`, `require()` and `import x = require()` get the same rules as
 *     a static import, and a computed specifier is refused;
 *   - a source that handles the backend (names `NapiBackendLike`,
 *     `NAPI_COMMANDS` or `backend`) has no computed key (`backend[m]()`) and
 *     no `Reflect`, so no method is reached through a variable;
 *   - `.ts .tsx .mts .cts .js .jsx .mjs .cjs` are scanned, tests and `.d.ts`
 *     are not.
 * A negative control feeds each violation to the same scanner.
 *
 * Why the scanner is written with the TypeScript AST and not with a pattern:
 * a pattern cannot tell a literal key from a computed one.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const SCAN_DIRS = [
  path.join("electron", "main", "mastraRead"),
  path.join("electron", "shared", "mastraRead"),
  // The shared read core and the pure modules moved with it (PR-4): the same IR
  // rules reach them, so a core file cannot name an IR symbol or import src/.
  path.join("electron", "shared", "readDomain"),
];
const SCAN_FILES = [path.join("electron", "shared", "ipcCallerTimeouts.ts")];

/** The only four commands the read port may name (DR-MP4-6). */
const ALLOWED_COMMAND_KEYS: ReadonlySet<string> = new Set([
  "fts_search",
  "codex_semantic_search",
  "events_semantic_search",
  "foreshadow_list_open_for_context",
]);

/** IR names, commands, flags and modules (DR-MP4-21 rule 1), in any spelling. */
const FORBIDDEN_TEXT: readonly RegExp[] = [
  /chat[-_]?agent[-_]?ir/iu,
  /chatIr/u,
  /searchEventsWithIr/u,
  /selectChatAgentIr/u,
  /SEARCH_EVENTS_IR/u,
  /CHAT_AGENT_IR/u,
];

/** The module that holds `NAPI_COMMANDS`, whatever the path or the extension. */
const IPC_CONTRACT = /(?:^|\/)ipcContract(?:\.[cm]?[jt]s)?$/u;

/** A file that touches the backend: it may hold no computed key. */
const HANDLES_BACKEND = /NapiBackendLike|NAPI_COMMANDS|\bbackend\b/u;

const FORBIDDEN_IMPORT: readonly RegExp[] = [
  /^@\//u,
  /(?:^|\/)src\//u,
  /toolDefinitions/u,
  /toolExecutors/u,
];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST_SOURCE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;
const DECLARATION = /\.d\.[cm]?ts$/u;

/** Repo-relative, with `/` separators on every OS (Windows yields `\\`). */
const repoRelative = (file: string): string =>
  path.relative(repoRoot, file).split(path.sep).join("/");

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (
      SOURCE_EXTENSION.test(name) &&
      !TEST_SOURCE.test(name) &&
      !DECLARATION.test(name)
    ) {
      yield full;
    }
  }
}

function scannedFiles(): string[] {
  return [
    ...SCAN_DIRS.flatMap((dir) => [...sourceFiles(path.join(repoRoot, dir))]),
    ...SCAN_FILES.map((file) => path.join(repoRoot, file)),
  ];
}

/** Violations of the `ipcContract` import rule for one declaration. */
function ipcContractViolations(
  name: string,
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): string[] {
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly
      ? []
      : [`${name}: re-exports a value from ipcContract`];
  }
  const clause = node.importClause;
  if (clause === undefined) {
    return [`${name}: imports ipcContract for its effect`];
  }
  if (clause.isTypeOnly) return [];
  const violations: string[] = [];
  if (clause.name !== undefined) {
    violations.push(`${name}: default-imports ipcContract`);
  }
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    violations.push(`${name}: namespace-imports ipcContract`);
  }
  if (bindings !== undefined && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (imported !== "NAPI_COMMANDS") {
        violations.push(
          `${name}: imports the value ${imported} from ipcContract (only NAPI_COMMANDS and types)`,
        );
      }
    }
  }
  return violations;
}

/** `import("x")`, `require("x")` and `import a = require("x")`: a value import. */
function dynamicSpecifierViolations(
  name: string,
  how: string,
  specifier: ts.Node | undefined,
): string[] {
  if (
    specifier === undefined ||
    !(
      ts.isStringLiteral(specifier) ||
      ts.isNoSubstitutionTemplateLiteral(specifier)
    )
  ) {
    return [`${name}: ${how} with a computed specifier`];
  }
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_IMPORT) {
    if (pattern.test(specifier.text)) {
      violations.push(`${name}: ${how} of ${specifier.text}`);
    }
  }
  if (IPC_CONTRACT.test(specifier.text)) {
    violations.push(
      `${name}: ${how} of ipcContract (a static type import only)`,
    );
  }
  return violations;
}

/** Every violation of one source, as a short readable line. */
export function scanSource(name: string, text: string): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_TEXT) {
    if (pattern.test(text)) violations.push(`${name}: names ${pattern}`);
  }
  const handlesBackend = HANDLES_BACKEND.test(text);
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        for (const pattern of FORBIDDEN_IMPORT) {
          if (pattern.test(specifier.text)) {
            violations.push(`${name}: imports ${specifier.text}`);
          }
        }
        if (IPC_CONTRACT.test(specifier.text)) {
          violations.push(...ipcContractViolations(name, node));
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      violations.push(
        ...dynamicSpecifierViolations(
          name,
          "import = require",
          node.moduleReference.expression,
        ),
      );
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        violations.push(
          ...dynamicSpecifierViolations(name, "import()", node.arguments[0]),
        );
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        violations.push(
          ...dynamicSpecifierViolations(name, "require()", node.arguments[0]),
        );
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      for (const pattern of FORBIDDEN_IMPORT) {
        if (pattern.test(node.argument.literal.text)) {
          violations.push(`${name}: imports ${node.argument.literal.text}`);
        }
      }
    }
    if (handlesBackend) {
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        if (
          !ts.isStringLiteral(key) &&
          !ts.isNoSubstitutionTemplateLiteral(key) &&
          !ts.isNumericLiteral(key)
        ) {
          violations.push(
            `${name}: a computed key in a source that handles the backend (${node.getText(file).slice(0, 60)})`,
          );
        }
      }
      if (ts.isIdentifier(node) && node.text === "Reflect") {
        violations.push(
          `${name}: Reflect in a source that handles the backend`,
        );
      }
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
      node.getText(file).includes("NAPI_COMMANDS")
    ) {
      violations.push(`${name}: a string names NAPI_COMMANDS`);
    }
    if (ts.isIdentifier(node) && node.text === "NAPI_COMMANDS") {
      const parent = node.parent;
      const isImportOfTheName =
        ts.isImportSpecifier(parent) &&
        parent.propertyName === undefined &&
        parent.name === node;
      const isLiteralKeyAccess =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ts.isIdentifier(parent.name) &&
        ALLOWED_COMMAND_KEYS.has(parent.name.text);
      if (!isImportOfTheName && !isLiteralKeyAccess) {
        violations.push(
          `${name}: NAPI_COMMANDS is used other than as a literal key of the four commands (${parent.getText(file).slice(0, 60)})`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

// The import fixtures are built at run time: written as literal import
// statements, the CI change-scope walker would read them as this file's own
// imports and fail to resolve them.
const importFrom = (specifier: string): string =>
  "import { x } from " + JSON.stringify(specifier) + ";";
const requireOf = (specifier: string): string =>
  "const x = req" +
  "uire(" +
  JSON.stringify(specifier) +
  ");\nexport const f = x;";

describe("main's read port: the chat IR stays closed and commands are named literally", () => {
  const files = scannedFiles();

  it("scans a non-empty set that holds the modules of this PR", () => {
    const relative = files.map((file) => repoRelative(file));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const expected of [
      "electron/main/mastraRead/db.ts",
      "electron/main/mastraRead/typed.ts",
      "electron/main/mastraRead/nativeCall.ts",
      "electron/shared/mastraRead/sql.ts",
      "electron/shared/mastraRead/tables.ts",
      "electron/shared/mastraRead/ports.ts",
      "electron/shared/ipcCallerTimeouts.ts",
      "electron/shared/readDomain/core/readExecutors.ts",
      "electron/shared/readDomain/core/treeReadTools.ts",
      "electron/shared/readDomain/core/plotThreadTools.ts",
      "electron/shared/readDomain/core/codexTagTools.ts",
      "electron/shared/readDomain/db/schema.ts",
    ]) {
      expect(relative).toContain(expected);
    }
  });

  it("has no violation in any of them", () => {
    const violations = files.flatMap((file) =>
      scanSource(repoRelative(file), readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("names NAPI_COMMANDS only in the typed reads, with the four literal keys", () => {
    const users = files.filter((file) =>
      readFileSync(file, "utf8").includes("NAPI_COMMANDS"),
    );
    expect(users.map((file) => repoRelative(file))).toEqual([
      "electron/main/mastraRead/typed.ts",
    ]);
    const used = new Set(
      [
        ...readFileSync(users[0]!, "utf8").matchAll(/NAPI_COMMANDS\.(\w+)/gu),
      ].map((match) => match[1]),
    );
    expect(used).toEqual(ALLOWED_COMMAND_KEYS);
  });
});

describe("the scanner catches each violation (negative control)", () => {
  const prefix =
    'import { NAPI_COMMANDS } from "../../shared/ipcContract.js";\n';
  it("passes a clean source with a literal key", () => {
    expect(
      scanSource(
        "ok.ts",
        `${prefix}export const run = () => NAPI_COMMANDS.fts_search.run;`,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a computed key",
      `${prefix}export const f = (c: string) => NAPI_COMMANDS[c];`,
    ],
    [
      "a bracket with a literal",
      `${prefix}export const f = NAPI_COMMANDS["fts_search"];`,
    ],
    [
      "a command that is not one of the four",
      `${prefix}export const f = NAPI_COMMANDS.db_execute;`,
    ],
    [
      "the command of the closed gate",
      `${prefix}export const f = NAPI_COMMANDS.chat_agent_ir_select;`,
    ],
    ["Object.keys", `${prefix}export const f = Object.keys(NAPI_COMMANDS);`],
    [
      "a destructuring",
      `${prefix}export const { fts_search } = NAPI_COMMANDS;`,
    ],
    [
      "an alias of the table",
      `${prefix}const T = NAPI_COMMANDS;\nexport const f = T;`,
    ],
    [
      "an aliased import",
      'import { NAPI_COMMANDS as T } from "../../shared/ipcContract.js";\nexport const f = T;',
    ],
    [
      "a namespace import",
      'import * as c from "../../shared/ipcContract.js";\nexport const f = c.NAPI_COMMANDS.fts_search;',
    ],
    [
      "a re-export",
      'export { NAPI_COMMANDS } from "../../shared/ipcContract.js";',
    ],
    [
      "a string with its name",
      'export const f = (m: Record<string, unknown>) => m["NAPI_COMMANDS"];',
    ],
    ["a template with its name", "export const f = `${1}NAPI_COMMANDS`;"],
    [
      "a value other than NAPI_COMMANDS from ipcContract",
      'import { dispatchInvoke } from "../../shared/ipcContract.js";\nexport const f = dispatchInvoke;',
    ],
    [
      "NAPI_COMMANDS together with another value from ipcContract",
      'import { NAPI_COMMANDS, dispatchInvoke } from "../../shared/ipcContract.js";\nexport const f = [NAPI_COMMANDS.fts_search, dispatchInvoke];',
    ],
    [
      "a default import of ipcContract",
      'import c from "../../shared/ipcContract";\nexport const f = c;',
    ],
    [
      "ipcContract imported for its effect",
      'import "../../shared/ipcContract.js";',
    ],
    [
      "a value re-export from ipcContract",
      'export * from "../../shared/ipcContract.js";',
    ],
    [
      "a computed key on the backend",
      "export const f = (backend: Record<string, () => void>, m: string) => backend[m]();",
    ],
    [
      "a computed key built from strings",
      'export const f = (backend: Record<string, () => void>) => backend["chat" + "Agent" + "IrSelect"]();',
    ],
    [
      "a computed key in a file that names NapiBackendLike",
      'import type { NapiBackendLike } from "../../shared/ipcContract.js";\nexport const f = (b: NapiBackendLike, m: keyof NapiBackendLike) => b[m];',
    ],
    [
      "Reflect on the backend",
      "export const f = (backend: object, m: string) => Reflect.get(backend, m);",
    ],
    [
      "a dynamic import of ipcContract",
      'export const f = () => import("../../shared/ipcContract.js");',
    ],
    [
      "a dynamic import with a computed specifier",
      "export const f = (p: string) => import(p);",
    ],
    [
      "a dynamic import of the renderer",
      'export const f = () => import("@/lib/chatIr");',
    ],
    [
      "a require of ipcContract",
      'export const f = () => require("../../shared/ipcContract.js");',
    ],
    [
      "a require with a computed specifier",
      "export const f = (p: string) => require(p);",
    ],
    ["a require of the tool executors", requireOf("./toolExecutors.js")],
    [
      "an import = require of ipcContract",
      'import c = require("../../shared/ipcContract.js");\nexport const f = c;',
    ],
    [
      "an import = require of src",
      'import c = require("../../../src/lib/tauri");\nexport const f = c;',
    ],
    ["an import type of src", 'export type T = import("@/lib/tauri").Foo;'],
  ])("flags %s", (_name, source) => {
    expect(scanSource("bad.ts", source)).not.toEqual([]);
  });

  it.each([
    [
      "a type import from ipcContract",
      'import type { NapiBackendLike, DispatchDeps } from "../../shared/ipcContract.js";\nexport type B = NapiBackendLike | DispatchDeps;',
    ],
    [
      "an inline type import beside NAPI_COMMANDS",
      'import { NAPI_COMMANDS, type DispatchDeps } from "../../shared/ipcContract.js";\nexport const f = (d: DispatchDeps) => [NAPI_COMMANDS.fts_search, d];',
    ],
    [
      "a type re-export",
      'export type { NapiBackendLike } from "../../shared/ipcContract.js";',
    ],
    [
      "a numeric or literal key in a backend file",
      'export const f = (backend: { m: () => void }, a: number[]) => [backend["m"], a[0]];',
    ],
    [
      "a computed key in a file that does not handle the backend",
      "export const f = (a: string[], i: number) => a[i];",
    ],
    [
      "an import() of a sibling",
      'export const f = () => import("./errors.js");',
    ],
  ])("passes %s", (_name, source) => {
    expect(scanSource("ok.ts", source)).toEqual([]);
  });

  it("scans .mts, .cts, .tsx, .jsx, .mjs and .cjs, and skips tests and declarations", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ir-closure-ext-"));
    try {
      for (const file of [
        "a.ts",
        "b.mts",
        "c.cts",
        "d.tsx",
        "e.jsx",
        "f.mjs",
        "g.cjs",
        "h.test.mts",
        "i.spec.cts",
        "j.d.ts",
        "k.d.mts",
        "l.md",
      ]) {
        writeFileSync(path.join(dir, file), "export {};\n");
      }
      expect([...sourceFiles(dir)].map((f) => path.basename(f)).sort()).toEqual(
        ["a.ts", "b.mts", "c.cts", "d.tsx", "e.jsx", "f.mjs", "g.cjs"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["the command name", 'export const c = "chat_agent_ir_select";'],
    [
      "the method name",
      "export const m = (b: { chatAgentIrSelect(): void }) => b.chatAgentIrSelect();",
    ],
    ["the flag", "export const f = CHAT_AGENT_IR_ENABLED;"],
    ["the availability module", importFrom("./chatAgentIrAvailability.js")],
    ["the wire module", importFrom("../chatAgentIrWire.js")],
    ["the result module", importFrom("./chatIrToolResult.js")],
    ["the renderer's IR module", importFrom("@/lib/chatIr")],
    ["the gate kind", 'export const k = "chat-agent-ir";'],
    ["the IR search", "export const s = searchEventsWithIr;"],
    ["the IR description", "export const d = SEARCH_EVENTS_IR_DESCRIPTION;"],
    ["a name in a comment", "// uses chatAgentIrSelect\nexport const a = 1;"],
    ["an import from src", importFrom("../../../src/lib/tauri")],
    ["an alias import from the renderer", importFrom("@/db/client")],
    ["the tool definitions", importFrom("./toolDefinitions.js")],
    ["the tool executors", importFrom("./toolExecutors.js")],
  ])("flags %s", (_name, source) => {
    expect(scanSource("bad.ts", source)).not.toEqual([]);
  });
});
