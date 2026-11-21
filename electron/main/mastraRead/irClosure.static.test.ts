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
 *     `electron/shared/mastraRead/`) plus the shared timeout module, so a file
 *     PR-4 and later put there is covered without a list to update;
 *   - no source (comments included) names an IR symbol, command or module;
 *   - no source imports from `src/` (`@/...`), the tool definitions or the tool
 *     executors;
 *   - `NAPI_COMMANDS` appears only as an import of the name itself and as
 *     `NAPI_COMMANDS.<one of the four literal keys>`: no bracket access, no
 *     alias, no destructuring, no `Object.keys`, no string of its name.
 * A negative control feeds each violation to the same scanner.
 *
 * Why the scanner is written with the TypeScript AST and not with a pattern:
 * a pattern cannot tell a literal key from a computed one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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

const FORBIDDEN_IMPORT: readonly RegExp[] = [
  /^@\//u,
  /(?:^|\/)src\//u,
  /toolDefinitions/u,
  /toolExecutors/u,
];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (
      /\.(ts|tsx|mjs|js)$/u.test(name) &&
      !/\.(test|spec)\.(ts|tsx|mjs|js)$/u.test(name) &&
      !name.endsWith(".d.ts")
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

/** Every violation of one source, as a short readable line. */
export function scanSource(name: string, text: string): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_TEXT) {
    if (pattern.test(text)) violations.push(`${name}: names ${pattern}`);
  }
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

describe("main's read port: the chat IR stays closed and commands are named literally", () => {
  const files = scannedFiles();

  it("scans a non-empty set that holds the modules of this PR", () => {
    const relative = files.map((file) => path.relative(repoRoot, file));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const expected of [
      "electron/main/mastraRead/db.ts",
      "electron/main/mastraRead/typed.ts",
      "electron/main/mastraRead/nativeCall.ts",
      "electron/shared/mastraRead/sql.ts",
      "electron/shared/mastraRead/tables.ts",
      "electron/shared/mastraRead/ports.ts",
      "electron/shared/ipcCallerTimeouts.ts",
    ]) {
      expect(relative).toContain(expected);
    }
  });

  it("has no violation in any of them", () => {
    const violations = files.flatMap((file) =>
      scanSource(path.relative(repoRoot, file), readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("names NAPI_COMMANDS only in the typed reads, with the four literal keys", () => {
    const users = files.filter((file) =>
      readFileSync(file, "utf8").includes("NAPI_COMMANDS"),
    );
    expect(users.map((file) => path.relative(repoRoot, file))).toEqual([
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
  ])("flags %s", (_name, source) => {
    expect(scanSource("bad.ts", source)).not.toEqual([]);
  });

  it.each([
    ["the command name", 'export const c = "chat_agent_ir_select";'],
    [
      "the method name",
      "export const m = (b: { chatAgentIrSelect(): void }) => b.chatAgentIrSelect();",
    ],
    ["the flag", "export const f = CHAT_AGENT_IR_ENABLED;"],
    [
      "the availability module",
      'import { x } from "./chatAgentIrAvailability.js";',
    ],
    ["the wire module", 'import { x } from "../chatAgentIrWire.js";'],
    ["the result module", 'import { x } from "./chatIrToolResult.js";'],
    ["the renderer's IR module", 'import { x } from "@/lib/chatIr";'],
    ["the gate kind", 'export const k = "chat-agent-ir";'],
    ["the IR search", "export const s = searchEventsWithIr;"],
    ["the IR description", "export const d = SEARCH_EVENTS_IR_DESCRIPTION;"],
    ["a name in a comment", "// uses chatAgentIrSelect\nexport const a = 1;"],
    ["an import from src", 'import { x } from "../../../src/lib/tauri";'],
    ["an alias import from the renderer", 'import { x } from "@/db/client";'],
    ["the tool definitions", 'import { x } from "./toolDefinitions.js";'],
    ["the tool executors", 'import { x } from "./toolExecutors.js";'],
  ])("flags %s", (_name, source) => {
    expect(scanSource("bad.ts", source)).not.toEqual([]);
  });
});
