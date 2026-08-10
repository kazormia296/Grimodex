#!/usr/bin/env node
/**
 * Fail CI when production TypeScript still mutates active protected Narrative
 * writer tables via Drizzle (`.insert|.update|.delete(...)`) or raw SQL DML.
 *
 * Domain cutover PRs flip `enforcement` to `active` in
 * `policies/narrative/protected-writers.json`. Deferred entries are reported
 * but do not fail the gate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

const SCAN_ROOT_DIRS = ["src", "packages", "electron"];

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "coverage",
  ".git",
  "target",
  "storybook-static",
  "browser-mock",
]);

const EXCLUDED_PATH_FRAGMENTS = [
  ".test.ts",
  ".test.tsx",
  ".browser.test.ts",
  ".browser.test.tsx",
  ".stories.",
  "/browser-mock/",
  "/__fixtures__/",
  "/fixtures/",
  "/generated/",
  "schema-seed",
  "seed_schema",
];

/**
 * Map registry SQL table names to common Drizzle schema export identifiers.
 * Domain cutovers should keep this map in sync when adding tables.
 */
const TABLE_TO_DRIZZLE_IDENTIFIERS = {
  foreshadows: ["foreshadows"],
  foreshadow_setups: ["foreshadowSetups"],
  foreshadow_payoffs: ["foreshadowPayoffs"],
  foreshadow_codex_links: ["foreshadowCodexLinks"],
  plot_threads: ["plotThreads"],
  plot_thread_scene_links: ["plotThreadSceneLinks"],
  plot_thread_branches: ["plotThreadBranches"],
  events: ["events"],
  event_participants: ["eventParticipants"],
  scene_events: ["sceneEvents"],
  event_relations: ["eventRelations"],
  tree_nodes: ["treeNodes"],
  codex_entries: ["codexEntries"],
  codex_relations: ["codexRelations"],
  codex_entry_phases: ["codexEntryPhases"],
  codex_detail_definitions: ["codexDetailDefinitions"],
  codex_detail_values: ["codexDetailValues"],
  narrative_runtime_policy: ["narrativeRuntimePolicy"],
  project_calendar: ["projectCalendar"],
  narrative_protected_fixture: ["narrativeProtectedFixture"],
  narrative_protected_shared_fixture: ["narrativeProtectedSharedFixture"],
};

const MUTATION_METHODS = new Set(["insert", "update", "delete"]);

function shouldScanFile(filePath) {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return false;
  const normalized = filePath.split(path.sep).join("/");
  return !EXCLUDED_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function walkSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (shouldScanFile(full)) {
      out.push(full);
    }
  }
  return out;
}

function collectScanFiles(repoRoot) {
  const files = [];
  for (const rootDir of SCAN_ROOT_DIRS) {
    walkSourceFiles(path.join(repoRoot, rootDir), files);
  }
  return files;
}

function protectedIdentifiersForTables(tables) {
  const identifiers = new Set();
  for (const table of tables) {
    const mapped = TABLE_TO_DRIZZLE_IDENTIFIERS[table] ?? [table];
    for (const ident of mapped) identifiers.add(ident);
  }
  return identifiers;
}

function collectImportedProtectedBindings(sourceFile, protectedIdents) {
  /** @type {Map<string, string>} localName -> canonical schema identifier */
  const bindings = new Map();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const { namedBindings, name } = statement.importClause;
    if (name && protectedIdents.has(name.text)) {
      bindings.set(name.text, name.text);
    }
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = (element.propertyName ?? element.name).text;
      if (!protectedIdents.has(importedName)) continue;
      bindings.set(element.name.text, importedName);
    }
  }

  return bindings;
}

function identifierText(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function resolveProtectedArg(argNode, protectedBindings, protectedIdents) {
  const argName = identifierText(argNode);
  if (!argName) return null;
  if (protectedBindings.has(argName)) return protectedBindings.get(argName);
  // Direct schema identifier (or `ns.ident` property name) without local alias.
  if (protectedIdents.has(argName)) return argName;
  return null;
}

function findDrizzleMutations(sourceFile, protectedBindings, protectedIdents) {
  const findings = new Set();

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (MUTATION_METHODS.has(method) && node.arguments.length > 0) {
        const resolved = resolveProtectedArg(
          node.arguments[0],
          protectedBindings,
          protectedIdents,
        );
        if (resolved) findings.add(resolved);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...findings];
}

function getLiteralText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += " ";
      text += span.literal.text;
    }
    return text;
  }
  return null;
}

function findRawSqlMutations(sourceFile, tableNames) {
  const findings = new Set();
  const tableAlternation = [...tableNames]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!tableAlternation) return [];

  const dmlPattern = new RegExp(
    `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:["'\`])?(${tableAlternation})\\b`,
    "i",
  );

  function visit(node) {
    const text = getLiteralText(node);
    if (text) {
      const match = text.match(dmlPattern);
      if (match) findings.add(match[1].toLowerCase());
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...findings];
}

function analyzeFile(filePath, activeTables, protectedIdents) {
  const source = readFileSync(filePath, "utf8");
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind,
  );

  const importedBindings = collectImportedProtectedBindings(sourceFile, protectedIdents);
  const drizzleHits = findDrizzleMutations(
    sourceFile,
    importedBindings,
    protectedIdents,
  );
  const sqlHits = findRawSqlMutations(sourceFile, activeTables);

  return { drizzleHits, sqlHits };
}

export function validateNarrativeWriters({
  repoRoot = REPO_ROOT,
  registryPath = REGISTRY_PATH,
} = {}) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const active = registry.filter((entry) => entry.enforcement === "active");
  const deferred = registry.filter((entry) => entry.enforcement === "deferred");
  const files = collectScanFiles(repoRoot);
  const activeTables = active.map((entry) => entry.table);
  const protectedIdents = protectedIdentifiersForTables(activeTables);
  const tableToEntry = new Map(active.map((entry) => [entry.table, entry]));
  const violations = [];

  for (const file of files) {
    const { drizzleHits, sqlHits } = analyzeFile(file, activeTables, protectedIdents);
    const hitTables = new Set();

    for (const ident of drizzleHits) {
      for (const [table, idents] of Object.entries(TABLE_TO_DRIZZLE_IDENTIFIERS)) {
        if (idents.includes(ident) && tableToEntry.has(table)) {
          hitTables.add(table);
        }
      }
      // Fallback: identifier equals table name
      if (tableToEntry.has(ident)) hitTables.add(ident);
    }

    for (const table of sqlHits) {
      if (tableToEntry.has(table)) hitTables.add(table);
    }

    for (const table of hitTables) {
      const entry = tableToEntry.get(table);
      const identifiers =
        TABLE_TO_DRIZZLE_IDENTIFIERS[table] ?? [table];
      const matchedIdents = [
        ...drizzleHits.filter((ident) => identifiers.includes(ident) || ident === table),
        ...sqlHits.filter((hit) => hit === table),
      ];
      violations.push({
        file: path.relative(repoRoot, file),
        table,
        writer: entry.writer,
        identifiers: matchedIdents.length > 0 ? matchedIdents : identifiers,
      });
    }
  }

  return {
    activeCount: active.length,
    deferredCount: deferred.length,
    scannedFiles: files.length,
    violations,
  };
}

function main() {
  const result = validateNarrativeWriters();
  if (result.violations.length > 0) {
    console.error(
      "Active protected Narrative writers still have production Drizzle/SQL mutations:",
    );
    for (const violation of result.violations) {
      console.error(
        `  - ${violation.file}: ${violation.table} (${violation.writer}) via ${violation.identifiers.join(", ")}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `validate-narrative-writers: ok (active=${result.activeCount}, deferred=${result.deferredCount}, scanned=${result.scannedFiles})`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
