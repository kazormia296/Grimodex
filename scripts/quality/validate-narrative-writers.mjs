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

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
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
  "browser-mock.ts",
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
  projects: ["projects"],
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
  codex_types: ["codexTypes"],
  codex_entries: ["codexEntries"],
  codex_tags: ["codexTags"],
  codex_entry_tags: ["codexEntryTags"],
  snippets: ["snippets"],
  snippet_entry_tags: ["snippetEntryTags"],
  codex_relations: ["codexRelations"],
  codex_entry_phases: ["codexEntryPhases"],
  codex_phase_detail_overrides: ["codexPhaseDetailOverrides"],
  codex_detail_definitions: ["codexDetailDefinitions"],
  codex_detail_values: ["codexDetailValues"],
  codex_detail_semantic_bindings: ["codexDetailSemanticBindings"],
  narrative_runtime_policy: ["narrativeRuntimePolicy"],
  project_calendar: ["projectCalendar"],
  narrative_protected_fixture: ["narrativeProtectedFixture"],
  narrative_protected_shared_fixture: ["narrativeProtectedSharedFixture"],
  narrative_revision_source_basis: ["narrativeRevisionSourceBasis"],
  narrative_projection_freshness: ["narrativeProjectionFreshness"],
  narrative_projection_dependencies: ["narrativeProjectionDependencies"],
  narrative_field_authority: ["narrativeFieldAuthority"],
  narrative_change_transactions: ["narrativeChangeTransactions"],
  narrative_change_events: ["narrativeChangeEvents"],
  narrative_change_object_heads: ["narrativeChangeObjectHeads"],
  narrative_change_cursors: ["narrativeChangeCursors"],
  narrative_change_sets: ["narrativeChangeSets"],
  narrative_dependency_declaration_sets: ["narrativeDependencyDeclarationSets"],
  narrative_dependency_declaration_entries: [
    "narrativeDependencyDeclarationEntries",
  ],
  narrative_dependency_declaration_heads: [
    "narrativeDependencyDeclarationHeads",
  ],
};

// These tables are Native-only authority/provenance state. Keep the list
// explicit so adding one to schema.ts without a protected writer entry fails
// the inverse coverage gate.
const NARRATIVE_AUTHORITY_TABLES = [
  "narrative_revision_source_basis",
  "narrative_projection_freshness",
  "narrative_projection_dependencies",
  "narrative_field_authority",
  "narrative_change_transactions",
  "narrative_change_events",
  "narrative_change_object_heads",
  "narrative_change_cursors",
  "narrative_change_sets",
  "narrative_dependency_declaration_sets",
  "narrative_dependency_declaration_entries",
  "narrative_dependency_declaration_heads",
];

const MUTATION_METHODS = new Set(["insert", "update", "delete"]);

function shouldScanFile(filePath) {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return false;
  const normalized = filePath.split(path.sep).join("/");
  return !EXCLUDED_PATH_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
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

function findUnregisteredNarrativeAuthorityTables(repoRoot, registry) {
  const schemaPath = path.join(repoRoot, "src/db/schema.ts");
  if (!existsSync(schemaPath)) return [];
  const schema = readFileSync(schemaPath, "utf8");
  const schemaTables = new Set(
    [...schema.matchAll(/sqliteTable\(\s*["'](narrative_[a-z0-9_]+)["']/g)].map(
      (match) => match[1],
    ),
  );
  const registered = new Set(registry.map((entry) => entry.table));
  return NARRATIVE_AUTHORITY_TABLES.filter(
    (table) => schemaTables.has(table) && !registered.has(table),
  );
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

function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function propertyNameText(node) {
  if (!node) return null;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function updateSetArgument(updateCall) {
  const setAccess = updateCall.parent;
  if (
    !ts.isPropertyAccessExpression(setAccess) ||
    setAccess.name.text !== "set" ||
    !ts.isCallExpression(setAccess.parent) ||
    setAccess.parent.expression !== setAccess ||
    setAccess.parent.arguments.length === 0
  ) {
    return null;
  }
  return setAccess.parent.arguments[0];
}

function collectObjectLiteralKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  const keys = new Set();
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
    ) {
      const key = propertyNameText(property.name);
      if (!key) return null;
      keys.add(camelToSnake(key));
      continue;
    }
    return null;
  }
  return keys;
}

function isNativeSqlBuilderMutation(node) {
  let current = node;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const parent = current.parent;
    if (!parent) return false;
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === "toSQL"
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function tableForIdentifier(identifier, protectedBindings, protectedIdents) {
  const resolved = protectedBindings.has(identifier)
    ? protectedBindings.get(identifier)
    : protectedIdents.has(identifier)
      ? identifier
      : null;
  if (!resolved) return null;
  for (const [table, identifiers] of Object.entries(
    TABLE_TO_DRIZZLE_IDENTIFIERS,
  )) {
    if (identifiers.includes(resolved)) return table;
  }
  return resolved;
}

function findDrizzleMutations(
  sourceFile,
  protectedBindings,
  protectedIdents,
  entriesByTable,
) {
  const findings = new Set();
  const violations = new Set();

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      if (MUTATION_METHODS.has(method) && node.arguments.length > 0) {
        const resolved = resolveProtectedArg(
          node.arguments[0],
          protectedBindings,
          protectedIdents,
        );
        if (!resolved) {
          ts.forEachChild(node, visit);
          return;
        }
        const table = tableForIdentifier(
          resolved,
          protectedBindings,
          protectedIdents,
        );
        const entry = table ? entriesByTable.get(table) : null;
        if (!entry) {
          ts.forEachChild(node, visit);
          return;
        }
        findings.add(table);
        if (entry.protection !== "columns" || method !== "update") {
          // `toSQL()` is only a statement builder. The resulting SQL is
          // executed by a trusted Native bundle (for example the AI tree
          // scaffold), so it is not an untrusted renderer mutation.
          if (!isNativeSqlBuilderMutation(node)) violations.add(table);
        } else {
          const columns = collectObjectLiteralKeys(updateSetArgument(node));
          const hasNoProtectedColumns =
            entry.columns.length === 0 && !entry.versionColumn;
          if (
            !hasNoProtectedColumns &&
            (columns === null ||
              [...columns].some(
                (column) =>
                  entry.columns.includes(column) ||
                  column === entry.versionColumn,
              ))
          ) {
            violations.add(table);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { findings: [...findings], violations: [...violations] };
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

function analyzeFile(filePath, scanEntries, protectedIdents) {
  const source = readFileSync(filePath, "utf8");
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind,
  );

  const importedBindings = collectImportedProtectedBindings(
    sourceFile,
    protectedIdents,
  );
  const drizzle = findDrizzleMutations(
    sourceFile,
    importedBindings,
    protectedIdents,
    new Map(scanEntries.map((entry) => [entry.table, entry])),
  );
  const sqlHits = findRawSqlMutations(
    sourceFile,
    scanEntries.map((entry) => entry.table),
  );

  return {
    drizzleHits: drizzle.findings,
    drizzleViolations: drizzle.violations,
    sqlHits,
  };
}

export function validateNarrativeWriters({
  repoRoot = REPO_ROOT,
  registryPath = REGISTRY_PATH,
  includeDeferred = false,
} = {}) {
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const active = registry.filter((entry) => entry.enforcement === "active");
  const deferred = registry.filter((entry) => entry.enforcement === "deferred");
  const files = collectScanFiles(repoRoot);
  const scanEntries = includeDeferred ? [...active, ...deferred] : active;
  const scanTables = scanEntries.map((entry) => entry.table);
  const protectedIdents = protectedIdentifiersForTables(scanTables);
  const tableToEntry = new Map(
    scanEntries.map((entry) => [entry.table, entry]),
  );
  const violations = [];
  const registryCoverageViolations = findUnregisteredNarrativeAuthorityTables(
    repoRoot,
    registry,
  );
  /** @type {Map<string, { aggregate: string, table: string, enforcement: string, nativeWriter: string, legacyWriters: Set<string> }>} */
  const inventoryByTable = new Map();

  for (const entry of registry) {
    inventoryByTable.set(entry.table, {
      aggregate: entry.aggregate ?? entry.writer ?? entry.table,
      table: entry.table,
      enforcement: entry.enforcement,
      nativeWriter: entry.writer ?? entry.nativeWriter ?? null,
      legacyWriters: new Set(),
    });
  }

  for (const file of files) {
    const { drizzleHits, drizzleViolations, sqlHits } = analyzeFile(
      file,
      scanEntries,
      protectedIdents,
    );
    const hitTables = new Set();
    const relative = path.relative(repoRoot, file);

    for (const table of drizzleHits) {
      if (tableToEntry.has(table)) hitTables.add(table);
    }

    for (const table of sqlHits) {
      if (tableToEntry.has(table)) hitTables.add(table);
    }

    for (const table of hitTables) {
      const entry = tableToEntry.get(table);
      const inventory = inventoryByTable.get(table);
      if (inventory) inventory.legacyWriters.add(relative);
      // Active violations fail the gate; deferred are inventory-only unless required.
      if (entry.enforcement !== "active") continue;
      const identifiers = TABLE_TO_DRIZZLE_IDENTIFIERS[table] ?? [table];
      const drizzleViolation = drizzleViolations.includes(table);
      const sqlViolation = sqlHits.includes(table);
      if (!drizzleViolation && !sqlViolation) continue;
      violations.push({
        file: relative,
        table,
        writer: entry.writer,
        identifiers: drizzleViolation
          ? identifiers
          : sqlViolation
            ? [table]
            : identifiers,
      });
    }
  }

  const inventory = [...inventoryByTable.values()].map((entry) => ({
    aggregate: entry.aggregate,
    table: entry.table,
    enforcement: entry.enforcement,
    nativeWriter: entry.nativeWriter,
    legacyWriters: [...entry.legacyWriters].sort(),
  }));

  return {
    activeCount: active.length,
    deferredCount: deferred.length,
    scannedFiles: files.length,
    violations,
    registryCoverageViolations,
    inventory,
  };
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    reportDeferred: argv.includes("--report-deferred"),
    requireNoDeferred: argv.includes("--require-no-deferred"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateNarrativeWriters({
    includeDeferred: args.reportDeferred || args.json || args.requireNoDeferred,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          activeCount: result.activeCount,
          deferredCount: result.deferredCount,
          scannedFiles: result.scannedFiles,
          violations: result.violations,
          registryCoverageViolations: result.registryCoverageViolations,
          inventory: result.inventory,
        },
        null,
        2,
      ),
    );
  } else if (args.reportDeferred) {
    const deferredInventory = result.inventory.filter(
      (entry) => entry.enforcement === "deferred",
    );
    for (const entry of deferredInventory) {
      console.log(
        JSON.stringify({
          aggregate: entry.aggregate,
          table: entry.table,
          legacyWriters: entry.legacyWriters,
          nativeWriter: entry.nativeWriter,
          enforcement: entry.enforcement,
        }),
      );
    }
    console.log(
      `validate-narrative-writers: deferred inventory (${deferredInventory.length} tables, scanned=${result.scannedFiles})`,
    );
  }

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

  if (result.registryCoverageViolations.length > 0) {
    console.error(
      "Native narrative authority tables are missing protected-writer registry entries:",
    );
    for (const table of result.registryCoverageViolations) {
      console.error(`  - ${table}`);
    }
    process.exitCode = 1;
    return;
  }

  if (args.requireNoDeferred && result.deferredCount > 0) {
    console.error(
      `validate-narrative-writers: expected deferred=0, found ${result.deferredCount}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!args.json && !args.reportDeferred) {
    console.log(
      `validate-narrative-writers: ok (active=${result.activeCount}, deferred=${result.deferredCount}, scanned=${result.scannedFiles})`,
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
