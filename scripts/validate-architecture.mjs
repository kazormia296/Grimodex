import { existsSync, statSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "src");
const baselinePath = path.join(repoRoot, "architecture-baseline.json");
const persistenceDebtManifestPath = path.join(
  repoRoot,
  "policies/architecture/renderer-persistence-debt.json",
);
const PERSISTENCE_DEBT_CATEGORIES = [
  "renderer-drizzle-mutation",
  "renderer-raw-sql-read",
  "renderer-raw-sql-write",
  "renderer-generic-db-route",
  "tsx-direct-persistence",
  "store-direct-persistence",
];
const ARCHITECTURE_BASELINE_SCHEMA_VERSION = 2;
const ARCHITECTURE_FINDING_RULES = [
  "cross-feature-store-import",
  "cross-feature-store-mutation",
  "dynamic-store-import",
  "application-component-import",
  "oversized-app-root",
  "oversized-lifecycle-host",
  "single-scene-load-in-array-loop",
  "legacy-ipc-error-text-check",
];

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(absolute)));
    } else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|browser|stories)\.(?:ts|tsx)$/.test(entry.name)
    ) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function relativeSource(absolute, currentRepoRoot = repoRoot) {
  return path.relative(currentRepoRoot, absolute).split(path.sep).join("/");
}

function featureFromSource(source) {
  const match = source.match(/^src\/features\/([^/]+)/);
  return match?.[1] ?? null;
}

function featureFromSpecifier(specifier) {
  const match = specifier.match(/^@\/features\/([^/]+)/);
  return match?.[1] ?? null;
}

function looksLikeStoreSpecifier(specifier) {
  return /(?:^|\/)(?:[^/]*(?:Store|store)|store)(?:\.[^/]*)?$/.test(specifier);
}

function isStoreFile(relative) {
  return /(?:^|\/)(?:store|[^/]*Store)\.tsx?$/.test(relative);
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

function runtimeImportSpecifiers(source) {
  const result = [];
  const pattern =
    /(?:^|[\n;])\s*import\s+(?!type\b)(?!["'])([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    result.push(match[2]);
  }
  for (const match of source.matchAll(
    /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g,
  )) {
    result.push(match[1]);
  }
  for (const match of source.matchAll(
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    result.push(match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\n;])\s*export\s+(?!type\b)([\s\S]*?)\s+from\s+["']([^"']+)["']/g,
  )) {
    result.push(match[2]);
  }
  return result;
}

function importedStoreBindings(source) {
  const bindings = new Map();
  const importPattern =
    /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    if (!looksLikeStoreSpecifier(specifier)) continue;
    const owner = featureFromSpecifier(specifier);
    if (!owner) continue;
    for (const raw of match[1].split(",")) {
      const binding = raw.trim().replace(/^type\s+/, "");
      if (!binding) continue;
      const [imported, local = imported] = binding.split(/\s+as\s+/);
      if (/^use[A-Z].*Store$/.test(local)) bindings.set(local, owner);
    }
  }
  return bindings;
}

const GENERIC_SQL_WRITE_METHODS = new Set(["insert", "update", "delete"]);
const LEGACY_IPC_ERROR_MARKERS = [
  "WORKSPACE_SWITCHING",
  "IPC_BACKEND_UNAVAILABLE",
  "IPC_UNIMPLEMENTED",
  "IPC_TIMED_OUT",
  "IPC_DERIVED_CANCELLED",
];
const LEGACY_ERROR_TEXT_METHODS = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "match",
  "test",
]);

function importedNamedBindings(
  sourceFile,
  importer,
  currentSourceRoot,
  target,
  importedName,
) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      resolveImport(
        importer,
        statement.moduleSpecifier.text,
        currentSourceRoot,
      ) !== target
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

function sqlLiteralText(node) {
  let sql;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    sql = node.text;
  } else if (ts.isTemplateExpression(node)) {
    sql = node.head.text;
  } else {
    return null;
  }
  return sql.replace(
    /^(?:(?:\s+)|(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/))*/,
    "",
  );
}

function rawSqlStatement(node) {
  const sql = sqlLiteralText(node);
  if (sql === null) return null;

  const writePatterns = [
    {
      operation: "insert",
      pattern:
        /^\s*insert(?:\s+or\s+\w+)?\s+into\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      operation: "replace",
      pattern: /^\s*replace\s+into\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      operation: "update",
      pattern:
        /^\s*update(?:\s+or\s+\w+)?\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s+set\b/i,
    },
    {
      operation: "delete",
      pattern: /^\s*delete\s+from\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      operation: "create",
      pattern:
        /^\s*create(?:\s+\w+)*\s+(?:table|index|trigger|view)\s+(?:if\s+not\s+exists\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      operation: "alter",
      pattern: /^\s*alter\s+table\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      operation: "drop",
      pattern:
        /^\s*drop\s+(?:table|index|trigger|view)\s+(?:if\s+exists\s+)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    },
    {
      operation: "vacuum",
      pattern: /^\s*vacuum(?:\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*))?/i,
    },
    {
      operation: "reindex",
      pattern: /^\s*reindex(?:\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*))?/i,
    },
  ];
  for (const { operation, pattern } of writePatterns) {
    const match = sql.match(pattern);
    if (match) {
      return {
        access: "write",
        operation,
        target: match[1] ?? "<database>",
      };
    }
  }

  const pragma = sql.match(
    /^\s*pragma\s+(?:["'`[]?[A-Za-z_][A-Za-z0-9_]*["'`\]]?\.)?["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  if (pragma) {
    return {
      access: /=/.test(sql.slice(pragma[0].length)) ? "write" : "read",
      operation: "pragma",
      target: pragma[1],
    };
  }

  const select = sql.match(
    /^\s*(?:explain(?:\s+query\s+plan)?\s+)?select\s+[\s\S]*?\bfrom\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  if (select) {
    return { access: "read", operation: "select", target: select[1] };
  }
  if (/^\s*(?:explain(?:\s+query\s+plan)?\s+)?select\s+/i.test(sql)) {
    return {
      access: "read",
      operation: "select",
      target: "<expression>",
    };
  }

  if (
    /^\s*with\s+(?:recursive\s+)?["'`[]?[A-Za-z_][A-Za-z0-9_]*["'`\]]?\s+as\s*\(/i.test(
      sql,
    )
  ) {
    const mutation = sql.match(
      /\b(insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i,
    );
    if (mutation) {
      return {
        access: "write",
        operation: mutation[1].split(/\s+/)[0].toLowerCase(),
        target: mutation[2],
      };
    }
    const target = sql.match(/\bfrom\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
    return {
      access: "read",
      operation: "select",
      target: target ?? "<cte>",
    };
  }

  return null;
}

function persistenceDebtFindings(
  source,
  relative,
  absolute,
  currentSourceRoot,
) {
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const dbBindings = importedNamedBindings(
    sourceFile,
    absolute,
    currentSourceRoot,
    path.join(currentSourceRoot, "db/client.ts"),
    "db",
  );
  const invokeBindings = importedNamedBindings(
    sourceFile,
    absolute,
    currentSourceRoot,
    path.join(currentSourceRoot, "lib/tauri.ts"),
    "invoke",
  );
  const bases = Object.fromEntries(
    PERSISTENCE_DEBT_CATEGORIES.map((category) => [category, []]),
  );
  const directCategory = relative.endsWith(".tsx")
    ? "tsx-direct-persistence"
    : isStoreFile(relative)
      ? "store-direct-persistence"
      : null;

  function add(category, kind, target) {
    const suffix = target === undefined ? kind : `${kind}:${target}`;
    bases[category].push(`${relative}:${suffix}`);
  }

  if (directCategory && dbBindings.size > 0) {
    add(directCategory, "db-client");
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      dbBindings.has(node.expression.expression.text) &&
      GENERIC_SQL_WRITE_METHODS.has(node.expression.name.text)
    ) {
      const target =
        node.arguments[0]?.getText(sourceFile).replace(/\s+/g, "") ??
        "<dynamic>";
      add(
        "renderer-drizzle-mutation",
        `drizzle-${node.expression.name.text}`,
        target,
      );
    }

    if (
      relative !== "src/db/client.ts" &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      invokeBindings.has(node.expression.text) &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.arguments[0].text === "db_execute" ||
        node.arguments[0].text === "db_execute_batch")
    ) {
      const route = node.arguments[0].text;
      add("renderer-generic-db-route", "generic-db-route", route);
      if (directCategory) {
        add(directCategory, "generic-db-route", route);
      }
    }

    const rawSql =
      relative === "src/lib/browser-mock.ts" ? null : rawSqlStatement(node);
    if (rawSql) {
      add(
        rawSql.access === "write"
          ? "renderer-raw-sql-write"
          : "renderer-raw-sql-read",
        `raw-sql-${rawSql.operation}`,
        rawSql.target,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // SQL-looking UI labels (for example "VACUUM") are not persistence debt.
  // A raw renderer statement is actionable only in a module that also owns a
  // direct generic database route; Drizzle query builders are inventoried by
  // their mutation calls instead.
  if (bases["renderer-generic-db-route"].length === 0) {
    bases["renderer-raw-sql-read"] = [];
    bases["renderer-raw-sql-write"] = [];
  }

  return Object.fromEntries(
    Object.entries(bases).map(([category, categoryBases]) => {
      const occurrences = new Map();
      return [
        category,
        categoryBases.map((base) => {
          const occurrence = (occurrences.get(base) ?? 0) + 1;
          occurrences.set(base, occurrence);
          return `${base}#${occurrence}`;
        }),
      ];
    }),
  );
}

function legacyIpcErrorTextFindings(source, relative) {
  // `tauri.ts` is the one compatibility boundary allowed to classify legacy
  // native error text into a typed IpcInvokeError. Feature code must consume
  // the resulting `code` discriminator.
  if (relative === "src/lib/tauri.ts") return [];

  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LEGACY_ERROR_TEXT_METHODS.has(node.expression.name.text)
    ) {
      const callText = node.getText(sourceFile);
      const marker = LEGACY_IPC_ERROR_MARKERS.find((candidate) =>
        callText.includes(candidate),
      );
      if (marker) {
        const position = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        findings.push(
          `${relative}:${position.line + 1}:${node.expression.name.text}:${marker}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

const SINGLE_SCENE_LOADERS = new Set(["loadSceneContent", "loadSceneFull"]);
const ARRAY_CALLBACK_METHODS = new Set(["map", "forEach", "flatMap"]);

function importedSingleSceneLoaderBindings(
  sourceFile,
  importer,
  currentSourceRoot,
) {
  const bindings = new Map();
  const treeApi = path.join(currentSourceRoot, "features/tree/api.ts");
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      resolveImport(
        importer,
        statement.moduleSpecifier.text,
        currentSourceRoot,
      ) !== treeApi
    ) {
      continue;
    }
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!SINGLE_SCENE_LOADERS.has(imported)) continue;
      bindings.set(element.name.text, imported);
    }
  }
  return bindings;
}

function enclosingArrayLoopKind(node) {
  let current = node.parent;
  while (current) {
    if (ts.isForOfStatement(current)) return "for-of";
    if (ts.isForInStatement(current)) return "for-in";
    if (ts.isForStatement(current)) return "for";

    if (ts.isFunctionLike(current)) {
      const callbackCall = current.parent;
      if (
        ts.isCallExpression(callbackCall) &&
        callbackCall.arguments.some((argument) => argument === current) &&
        ts.isPropertyAccessExpression(callbackCall.expression) &&
        ARRAY_CALLBACK_METHODS.has(callbackCall.expression.name.text)
      ) {
        return callbackCall.expression.name.text;
      }
      // Do not attribute a deferred nested function to a loop outside it.
      return null;
    }
    current = current.parent;
  }
  return null;
}

function singleSceneLoadLoopFindings(
  source,
  relative,
  absolute,
  currentSourceRoot,
) {
  const sourceFile = ts.createSourceFile(
    relative,
    source,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = importedSingleSceneLoaderBindings(
    sourceFile,
    absolute,
    currentSourceRoot,
  );
  if (bindings.size === 0) return [];

  const findings = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ARRAY_CALLBACK_METHODS.has(node.expression.name.text)
    ) {
      for (const argument of node.arguments) {
        if (!ts.isIdentifier(argument) || !bindings.has(argument.text)) {
          continue;
        }
        findings.push(
          `${relative}:${bindings.get(argument.text)}:${node.expression.name.text}`,
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      bindings.has(node.expression.text)
    ) {
      const loopKind = enclosingArrayLoopKind(node);
      if (loopKind) {
        const loader = bindings.get(node.expression.text);
        findings.push(`${relative}:${loader}:${loopKind}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...new Set(findings)];
}

function isFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveImport(
  importer,
  specifier,
  currentSourceRoot = sourceRoot,
) {
  let base;
  if (specifier.startsWith("@/")) {
    base = path.join(currentSourceRoot, specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }
  return (
    [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ].find(isFile) ?? null
  );
}

function shortestPath(graph, start, goal, allowedNodes) {
  if (start === goal) return [start];
  const queue = [start];
  const previous = new Map([[start, null]]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const neighbors = [...(graph.get(current) ?? [])].sort();
    for (const neighbor of neighbors) {
      if (!allowedNodes.has(neighbor) || previous.has(neighbor)) continue;
      previous.set(neighbor, current);
      if (neighbor === goal) {
        const path = [];
        let cursor = goal;
        while (cursor !== null) {
          path.push(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }

  return [];
}

export function findCycleDetails(graph, currentRepoRoot = repoRoot) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node), lowLinks.get(neighbor)),
        );
      } else if (onStack.has(neighbor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(neighbor)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length <= 1) return;

    const componentSet = new Set(component);
    const members = component
      .map((member) => relativeSource(member, currentRepoRoot))
      .sort();
    const edges = [];
    for (const from of component) {
      for (const to of graph.get(from) ?? []) {
        if (!componentSet.has(to)) continue;
        const returnPath = shortestPath(graph, to, from, componentSet).map(
          (member) => relativeSource(member, currentRepoRoot),
        );
        edges.push({
          from: relativeSource(from, currentRepoRoot),
          to: relativeSource(to, currentRepoRoot),
          returnPath,
        });
      }
    }
    edges.sort((left, right) => {
      const leftKey = `${left.from}->${left.to}`;
      const rightKey = `${right.from}->${right.to}`;
      return leftKey.localeCompare(rightKey);
    });
    components.push({ members, edges });
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components.sort((left, right) =>
    left.members.join("\n").localeCompare(right.members.join("\n")),
  );
}

export function findCycles(graph, currentRepoRoot = repoRoot) {
  return findCycleDetails(graph, currentRepoRoot).map(({ members }) =>
    members.join(" -> "),
  );
}

export function createArchitectureMetrics(
  findings,
  featureCycles,
  trackedMetrics = {},
) {
  const cyclicModules = new Set(
    featureCycles.flatMap((cycle) => cycle.members),
  );
  const hasCompleteEdgeData = featureCycles.every((cycle) =>
    Array.isArray(cycle.edges),
  );
  return {
    "cross-feature-store-import":
      findings["cross-feature-store-import"]?.length ?? 0,
    "cross-feature-store-mutation":
      findings["cross-feature-store-mutation"]?.length ?? 0,
    "dynamic-store-import": findings["dynamic-store-import"]?.length ?? 0,
    "cyclic-modules": cyclicModules.size,
    "largest-scc": featureCycles.reduce(
      (largest, cycle) => Math.max(largest, cycle.members.length),
      0,
    ),
    "scc-internal-edges": hasCompleteEdgeData
      ? featureCycles.reduce((total, cycle) => total + cycle.edges.length, 0)
      : null,
    ...trackedMetrics,
  };
}

export async function collectArchitectureSnapshot(options = {}) {
  const currentRepoRoot = options.repoRoot ?? repoRoot;
  const currentSourceRoot =
    options.sourceRoot ?? path.join(currentRepoRoot, "src");
  const files = await collectSourceFiles(currentSourceRoot);
  const findings = {
    "cross-feature-store-import": [],
    "cross-feature-store-mutation": [],
    "dynamic-store-import": [],
    "application-component-import": [],
    "oversized-app-root": [],
    "oversized-lifecycle-host": [],
    "single-scene-load-in-array-loop": [],
    "legacy-ipc-error-text-check": [],
    "feature-cycle": [],
    ...Object.fromEntries(
      PERSISTENCE_DEBT_CATEGORIES.map((category) => [category, []]),
    ),
  };
  const trackedMetrics = {};
  const graph = new Map(files.map((file) => [file, new Set()]));

  for (const file of files) {
    const relative = relativeSource(file, currentRepoRoot);
    const fromFeature = featureFromSource(relative);
    const source = await readFile(file, "utf8");
    const lineCount = source.split(/\r?\n/).length;

    if (relative === "src/App.tsx") {
      trackedMetrics["app-root-lines"] = lineCount;
      if (lineCount > 200) {
        findings["oversized-app-root"].push(`${relative}:${lineCount}>200`);
      }
    }
    if (/(?:^|\/)[^/]*Host\.tsx$/.test(relative)) {
      trackedMetrics["largest-host-lines"] = Math.max(
        trackedMetrics["largest-host-lines"] ?? 0,
        lineCount,
      );
      if (lineCount > 300) {
        findings["oversized-lifecycle-host"].push(
          `${relative}:${lineCount}>300`,
        );
      }
    }

    if (relative === "src/features/chat/chatStore.ts") {
      trackedMetrics["chat-store-lines"] = lineCount;
      trackedMetrics["chat-store-runtime-imports"] =
        runtimeImportSpecifiers(source).length;
    }

    for (const specifier of importSpecifiers(source)) {
      const toFeature = featureFromSpecifier(specifier);
      const resolved = resolveImport(file, specifier, currentSourceRoot);
      if (
        fromFeature &&
        toFeature &&
        fromFeature !== toFeature &&
        isStoreFile(relative) &&
        looksLikeStoreSpecifier(specifier)
      ) {
        findings["cross-feature-store-import"].push(
          `${relative}:${fromFeature}->${toFeature}:${specifier}`,
        );
      }
      if (/^src\/application/.test(relative) && resolved?.endsWith(".tsx")) {
        findings["application-component-import"].push(
          `${relative}:${specifier}`,
        );
      }
    }

    for (const specifier of runtimeImportSpecifiers(source)) {
      const resolved = resolveImport(file, specifier, currentSourceRoot);
      if (resolved && graph.has(resolved)) graph.get(file).add(resolved);
    }

    if (/^src\/features\//.test(relative)) {
      for (const match of source.matchAll(
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      )) {
        if (looksLikeStoreSpecifier(match[1])) {
          findings["dynamic-store-import"].push(`${relative}:${match[1]}`);
        }
      }
    }

    if (fromFeature && fromFeature !== "application") {
      const bindings = importedStoreBindings(source);
      for (const [binding, owner] of bindings) {
        if (
          owner !== fromFeature &&
          new RegExp(`\\b${binding}\\.setState\\s*\\(`).test(source)
        ) {
          findings["cross-feature-store-mutation"].push(
            `${relative}:${fromFeature}->${owner}:${binding}.setState`,
          );
        }
      }
    }

    findings["single-scene-load-in-array-loop"].push(
      ...singleSceneLoadLoopFindings(source, relative, file, currentSourceRoot),
    );
    const persistenceFindings = persistenceDebtFindings(
      source,
      relative,
      file,
      currentSourceRoot,
    );
    for (const category of PERSISTENCE_DEBT_CATEGORIES) {
      findings[category].push(...persistenceFindings[category]);
    }
    findings["legacy-ipc-error-text-check"].push(
      ...legacyIpcErrorTextFindings(source, relative),
    );
  }

  const featureCycles = findCycleDetails(graph, currentRepoRoot);
  findings["feature-cycle"] = featureCycles.map(({ members }) =>
    members.join(" -> "),
  );
  for (const category of PERSISTENCE_DEBT_CATEGORIES) {
    trackedMetrics[category] = findings[category].length;
  }
  for (const values of Object.values(findings)) values.sort();
  return {
    findings,
    featureCycles,
    metrics: createArchitectureMetrics(findings, featureCycles, trackedMetrics),
  };
}

export async function collectFindings(options = {}) {
  const snapshot = await collectArchitectureSnapshot(options);
  return snapshot.findings;
}

function flatten(findings) {
  return Object.entries(findings).flatMap(([rule, values]) =>
    values.map((value) => `${rule}:${value}`),
  );
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function findingDelta(current, baseline) {
  const currentCounts = countValues(current);
  const baselineCounts = countValues(baseline);
  const introduced = [];
  const improvements = [];

  for (const [signature, currentCount] of currentCounts) {
    const baselineCount = baselineCounts.get(signature) ?? 0;
    for (
      let occurrence = baselineCount;
      occurrence < currentCount;
      occurrence += 1
    ) {
      introduced.push(signature);
    }
  }

  for (const [signature, baselineCount] of baselineCounts) {
    const currentCount = currentCounts.get(signature) ?? 0;
    if (currentCount < baselineCount) {
      improvements.push(
        `${signature}#baseline-${baselineCount}-observed-${currentCount}`,
      );
    }
  }

  return { introduced, improvements };
}

function normalizeCycleEntry(entry) {
  if (typeof entry === "string") {
    return {
      members: entry
        .split(" -> ")
        .map((member) => member.trim())
        .filter(Boolean)
        .sort(),
      edges: null,
    };
  }
  if (!entry || !Array.isArray(entry.members)) return null;
  const edges = Array.isArray(entry.edges)
    ? entry.edges
        .filter(
          (edge) =>
            edge &&
            typeof edge.from === "string" &&
            typeof edge.to === "string",
        )
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          ...(Array.isArray(edge.returnPath)
            ? { returnPath: [...edge.returnPath] }
            : {}),
        }))
        .sort((left, right) =>
          `${left.from}->${left.to}`.localeCompare(
            `${right.from}->${right.to}`,
          ),
        )
    : null;
  return {
    members: [...new Set(entry.members)].sort(),
    edges,
  };
}

function normalizeCycleEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeCycleEntry)
    .filter(Boolean)
    .sort((left, right) =>
      left.members.join("\n").localeCompare(right.members.join("\n")),
    );
}

function deriveBaselineMetrics(findings, featureCycles) {
  const metrics = createArchitectureMetrics(findings, featureCycles);
  if (featureCycles.some((cycle) => cycle.edges === null)) {
    metrics["scc-internal-edges"] = null;
  }
  return metrics;
}

export function normalizeArchitectureBaseline(baseline = {}) {
  const sourceFindings =
    baseline.findings && typeof baseline.findings === "object"
      ? baseline.findings
      : baseline;
  const findings = Object.fromEntries(
    ARCHITECTURE_FINDING_RULES.map((rule) => [
      rule,
      Array.isArray(sourceFindings[rule]) ? [...sourceFindings[rule]] : [],
    ]),
  );
  const cycleSource =
    baseline["feature-cycle"]?.sccs ??
    baseline["feature-cycle"] ??
    sourceFindings["feature-cycle"] ??
    [];
  const featureCycles = normalizeCycleEntries(cycleSource);
  const metrics =
    baseline.metrics && typeof baseline.metrics === "object"
      ? { ...baseline.metrics }
      : deriveBaselineMetrics(findings, featureCycles);

  return {
    schemaVersion: baseline.schemaVersion ?? 1,
    findings,
    featureCycles,
    metrics,
    waivers: Array.isArray(baseline.waivers) ? [...baseline.waivers] : [],
    legacy: baseline.schemaVersion !== ARCHITECTURE_BASELINE_SCHEMA_VERSION,
  };
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return new Date(value ?? Date.now()).toISOString().slice(0, 10);
}

function isValidDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isWaiverShapeValid(waiver) {
  return (
    waiver &&
    typeof waiver.id === "string" &&
    typeof waiver.rule === "string" &&
    typeof waiver.signature === "string" &&
    typeof waiver.reason === "string" &&
    typeof waiver.ownerArea === "string" &&
    Number.isInteger(waiver.issue) &&
    isValidDateOnly(waiver.introducedAt) &&
    isValidDateOnly(waiver.expiresAt) &&
    waiver.introducedAt <= waiver.expiresAt
  );
}

function waiverExpired(waiver, today) {
  return !isWaiverShapeValid(waiver) || waiver.expiresAt < today;
}

function waiverMatches(waiver, rule, signature) {
  return (
    isWaiverShapeValid(waiver) &&
    waiver.rule === rule &&
    waiver.signature === signature
  );
}

function isSubset(members, container) {
  const containerSet = new Set(container);
  return members.every((member) => containerSet.has(member));
}

function edgeKey(edge) {
  return `${edge.from}->${edge.to}`;
}

function cycleDebtContainsSignature(cycles, signature) {
  if (signature.startsWith("new-scc:")) {
    const members = signature
      .slice("new-scc:".length)
      .split(" -> ")
      .filter(Boolean)
      .sort();
    return cycles.some(
      (cycle) => cycle.members.join(" -> ") === members.join(" -> "),
    );
  }
  if (signature.startsWith("new-internal-edge:")) {
    const edge = signature
      .slice("new-internal-edge:".length)
      .split(":return=", 1)[0];
    return cycles.some((cycle) =>
      cycle.edges?.some((candidate) => edgeKey(candidate) === edge),
    );
  }
  return false;
}

function compareCycleDebt(currentCycles, baselineCycles) {
  const introduced = [];
  const improvements = [];
  const matches = new Map();

  for (const current of currentCycles) {
    const matchingBaseline = baselineCycles.find((baseline) =>
      isSubset(current.members, baseline.members),
    );
    if (!matchingBaseline) {
      introduced.push(`feature-cycle:new-scc:${current.members.join(" -> ")}`);
      continue;
    }

    matches.set(matchingBaseline, (matches.get(matchingBaseline) ?? 0) + 1);
    if (current.members.length < matchingBaseline.members.length) {
      improvements.push(
        `feature-cycle:scc-shrunk:${matchingBaseline.members.join(" -> ")}#observed-${current.members.length}`,
      );
    }

    if (current.edges === null || matchingBaseline.edges === null) continue;
    const currentEdges = new Set(current.edges.map(edgeKey));
    const baselineEdges = new Set(matchingBaseline.edges.map(edgeKey));
    for (const edge of current.edges) {
      if (baselineEdges.has(edgeKey(edge))) continue;
      const returnPath = edge.returnPath?.join(" -> ");
      introduced.push(
        `feature-cycle:new-internal-edge:${edgeKey(edge)}${
          returnPath ? `:return=${returnPath}` : ""
        }`,
      );
    }
    for (const edge of matchingBaseline.edges) {
      if (!currentEdges.has(edgeKey(edge))) {
        improvements.push(`feature-cycle:edge-removed:${edgeKey(edge)}`);
      }
    }
  }

  for (const baseline of baselineCycles) {
    if (!matches.has(baseline)) {
      improvements.push(
        `feature-cycle:scc-removed:${baseline.members.join(" -> ")}`,
      );
    }
  }

  return { introduced, improvements };
}

export function compareArchitectureBaseline(snapshot, baseline, options = {}) {
  const normalizedBaseline = normalizeArchitectureBaseline(baseline);
  const introduced = [];
  const improvements = [];
  const today = dateOnly(options.now);
  const expiredWaivers = normalizedBaseline.waivers.filter((waiver) =>
    waiverExpired(waiver, today),
  );
  const activeWaivers = normalizedBaseline.waivers.filter(
    (waiver) => isWaiverShapeValid(waiver) && !waiverExpired(waiver, today),
  );
  const currentFindings = snapshot.findings ?? {};

  for (const rule of ARCHITECTURE_FINDING_RULES) {
    const delta = findingDelta(
      Array.isArray(currentFindings[rule]) ? currentFindings[rule] : [],
      normalizedBaseline.findings[rule],
    );
    for (const signature of delta.introduced) {
      if (
        !activeWaivers.some((waiver) => waiverMatches(waiver, rule, signature))
      ) {
        introduced.push(`${rule}:${signature}`);
      }
    }
    improvements.push(...delta.improvements.map((value) => `${rule}:${value}`));
  }

  const cycleDelta = compareCycleDebt(
    normalizeCycleEntries(snapshot.featureCycles),
    normalizedBaseline.featureCycles,
  );
  for (const finding of cycleDelta.introduced) {
    const { rule, signature } = splitRuleSignature(finding);
    if (
      !activeWaivers.some((waiver) => waiverMatches(waiver, rule, signature))
    ) {
      introduced.push(finding);
    }
  }
  improvements.push(...cycleDelta.improvements);

  const metricIncreases = [];
  const metricImprovements = [];
  for (const [metric, current] of Object.entries(snapshot.metrics ?? {})) {
    const baselineValue = normalizedBaseline.metrics[metric];
    if (typeof current !== "number" || typeof baselineValue !== "number") {
      continue;
    }
    if (current > baselineValue) {
      metricIncreases.push({ baseline: baselineValue, current, metric });
    } else if (current < baselineValue) {
      metricImprovements.push({ baseline: baselineValue, current, metric });
    }
  }

  const staleWaivers = normalizedBaseline.waivers.filter((waiver) => {
    if (!isWaiverShapeValid(waiver)) return false;
    if (waiver.rule === "metric") {
      return typeof snapshot.metrics?.[waiver.signature] !== "number";
    }
    if (waiver.rule === "feature-cycle") {
      return !cycleDebtContainsSignature(
        normalizeCycleEntries(snapshot.featureCycles),
        waiver.signature,
      );
    }
    return !(currentFindings[waiver.rule] ?? []).includes(waiver.signature);
  });

  return {
    introduced: [...new Set(introduced)].sort(),
    improvements: [...new Set(improvements)].sort(),
    metricIncreases: metricIncreases.sort((left, right) =>
      left.metric.localeCompare(right.metric),
    ),
    metricImprovements: metricImprovements.sort((left, right) =>
      left.metric.localeCompare(right.metric),
    ),
    expiredWaivers,
    staleWaivers,
    baseline: normalizedBaseline,
  };
}

export function createArchitectureBaseline(snapshot, options = {}) {
  const findings = Object.fromEntries(
    ARCHITECTURE_FINDING_RULES.map((rule) => [
      rule,
      [...(snapshot.findings[rule] ?? [])].sort(),
    ]),
  );
  const sccs = normalizeCycleEntries(snapshot.featureCycles).map((cycle) => ({
    members: cycle.members,
    edges: cycle.edges?.map(({ from, to }) => ({ from, to })) ?? [],
  }));
  return {
    schemaVersion: ARCHITECTURE_BASELINE_SCHEMA_VERSION,
    findings,
    "feature-cycle": { sccs },
    metrics: { ...snapshot.metrics },
    waivers: [...(options.waivers ?? [])],
  };
}

export function findNewFindings(findings, baseline) {
  const known = new Set(flatten(baseline));
  return flatten(findings).filter((finding) => !known.has(finding));
}

const PERSISTENCE_CATEGORY_SCOPES = {
  "renderer-drizzle-mutation":
    "Renderer-side db.insert(), db.update(), and db.delete() callsites.",
  "renderer-raw-sql-read":
    "Raw renderer SQL read statements, including SELECT, read-only PRAGMA, and CTE reads.",
  "renderer-raw-sql-write": "Raw renderer SQL mutation and DDL statements.",
  "renderer-generic-db-route":
    "Direct renderer invoke() calls to db_execute and db_execute_batch.",
  "tsx-direct-persistence":
    "React TSX modules that import db/client or invoke a generic database route directly.",
  "store-direct-persistence":
    "Zustand store modules that import db/client or invoke a generic database route directly.",
};

function createCallsiteCeilings(findings) {
  const allowedCallsiteCounts = {};
  for (const finding of findings) {
    const match = finding.match(/^(.*)#(\d+)$/);
    if (!match) continue;
    const count = Number(match[2]);
    allowedCallsiteCounts[match[1]] = Math.max(
      allowedCallsiteCounts[match[1]] ?? 0,
      count,
    );
  }
  return Object.fromEntries(
    Object.entries(allowedCallsiteCounts).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
}

export function createPersistenceDebtManifest(findings) {
  return {
    schemaVersion: 2,
    scope:
      "Renderer persistence debt separated by mechanism and presentation/state ownership boundary.",
    policy:
      "These are migration ceilings, not approved APIs. React components and Zustand stores must not access db/client or db_execute* directly. Reads use feature repositories; writes use typed domain commands.",
    categories: Object.fromEntries(
      PERSISTENCE_DEBT_CATEGORIES.map((category) => [
        category,
        {
          scope: PERSISTENCE_CATEGORY_SCOPES[category],
          allowedCallsiteCounts: createCallsiteCeilings(
            findings[category] ?? [],
          ),
        },
      ]),
    ),
  };
}

function compareCallsiteCeilings(findings, allowed) {
  const observed = {};
  for (const finding of findings) {
    const match = finding.match(/^(.*)#(\d+)$/);
    if (!match) continue;
    observed[match[1]] = Math.max(observed[match[1]] ?? 0, Number(match[2]));
  }
  const overages = findings.filter((finding) => {
    const match = finding.match(/^(.*)#(\d+)$/);
    if (!match) return true;
    return Number(match[2]) > (allowed[match[1]] ?? 0);
  });
  const staleCeilings = Object.entries(allowed).flatMap(
    ([signature, allowedCount]) => {
      const observedCount = observed[signature] ?? 0;
      return observedCount < allowedCount
        ? [`${signature}#manifest-${allowedCount}-observed-${observedCount}`]
        : [];
    },
  );
  return {
    improvements: staleCeilings.sort(),
    introduced: overages.sort(),
  };
}

export function findPersistenceDebtChanges(findings, manifest) {
  const introduced = [];
  const improvements = [];
  for (const category of PERSISTENCE_DEBT_CATEGORIES) {
    const changes = compareCallsiteCeilings(
      findings[category] ?? [],
      manifest.categories?.[category]?.allowedCallsiteCounts ?? {},
    );
    introduced.push(
      ...changes.introduced.map((finding) => `${category}:${finding}`),
    );
    improvements.push(
      ...changes.improvements.map((finding) => `${category}:${finding}`),
    );
  }
  return {
    introduced: introduced.sort(),
    improvements: improvements.sort(),
  };
}

const METRIC_LABELS = {
  "cross-feature-store-import": "cross-feature store imports",
  "cross-feature-store-mutation": "direct cross-feature mutations",
  "dynamic-store-import": "dynamic store imports",
  "cyclic-modules": "cyclic modules",
  "largest-scc": "largest SCC",
  "scc-internal-edges": "SCC-internal edges",
  "chat-store-lines": "chatStore.ts lines",
  "chat-store-runtime-imports": "chatStore.ts runtime imports",
  "app-root-lines": "App.tsx lines",
  "largest-host-lines": "largest lifecycle Host lines",
  "renderer-drizzle-mutation": "renderer Drizzle mutations",
  "renderer-raw-sql-read": "renderer raw SQL reads",
  "renderer-raw-sql-write": "renderer raw SQL writes",
  "renderer-generic-db-route": "renderer generic DB routes",
  "tsx-direct-persistence": "TSX direct persistence",
  "store-direct-persistence": "store direct persistence",
};

export function formatArchitectureMetrics(metrics) {
  return Object.entries(METRIC_LABELS).map(
    ([metric, label]) => `- ${label}: ${metrics[metric] ?? "unknown"}`,
  );
}

function cliOption(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasCliFlag(flag) {
  return process.argv.includes(flag);
}

function splitRuleSignature(value) {
  const separator = value.indexOf(":");
  if (separator === -1) return { rule: "unknown", signature: value };
  return {
    rule: value.slice(0, separator),
    signature: value.slice(separator + 1),
  };
}

export function createGrowthWaivers(
  values,
  metricIncreases,
  options,
  existing,
) {
  const today = dateOnly();
  const requests = [
    ...values.map((value) => splitRuleSignature(value)),
    ...metricIncreases.map(({ metric }) => ({
      rule: "metric",
      signature: metric,
    })),
  ];
  const nextWaivers = [...existing];
  const existingKeys = new Set(
    existing.map((waiver) => `${waiver.rule}:${waiver.signature}`),
  );
  for (const request of requests) {
    const key = `${request.rule}:${request.signature}`;
    const slug = request.signature
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const waiver = {
      id: `architecture-${request.rule}-${slug || "debt"}`,
      rule: request.rule,
      signature: request.signature,
      reason: options.reason,
      ownerArea: options.ownerArea,
      issue: options.issue,
      introducedAt: today,
      expiresAt: options.expiresAt,
    };
    if (request.rule === "metric" && existingKeys.has(key)) {
      const existingIndex = nextWaivers.findIndex(
        (candidate) =>
          candidate.rule === request.rule &&
          candidate.signature === request.signature,
      );
      nextWaivers[existingIndex] = {
        ...waiver,
        id: nextWaivers[existingIndex].id,
      };
      continue;
    }
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    nextWaivers.push(waiver);
  }
  return nextWaivers;
}

function growthWaiverOptions() {
  const issueValue = cliOption("--issue");
  const issue = issueValue === undefined ? undefined : Number(issueValue);
  return {
    issue: Number.isInteger(issue) && issue > 0 ? issue : undefined,
    reason: cliOption("--reason"),
    ownerArea: cliOption("--owner-area"),
    expiresAt: cliOption("--expires-at"),
  };
}

export function growthWaiverOptionsAreValid(options, today = dateOnly()) {
  return (
    Number.isInteger(options.issue) &&
    options.issue > 0 &&
    typeof options.reason === "string" &&
    options.reason.trim().length > 0 &&
    typeof options.ownerArea === "string" &&
    options.ownerArea.trim().length > 0 &&
    isValidDateOnly(options.expiresAt) &&
    options.expiresAt >= today
  );
}

function printList(label, values) {
  if (values.length === 0) return;
  console.error(`${label}:`);
  for (const value of values) console.error(`- ${value}`);
}

async function main() {
  const snapshot = await collectArchitectureSnapshot();
  const persistenceFindings = Object.fromEntries(
    PERSISTENCE_DEBT_CATEGORIES.map((category) => [
      category,
      snapshot.findings[category],
    ]),
  );
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const persistenceDebtManifest = JSON.parse(
    await readFile(persistenceDebtManifestPath, "utf8"),
  );
  const architectureComparison = compareArchitectureBaseline(
    snapshot,
    baseline,
  );
  const persistenceChanges = findPersistenceDebtChanges(
    persistenceFindings,
    persistenceDebtManifest,
  );
  const introduced = [
    ...architectureComparison.introduced,
    ...persistenceChanges.introduced,
  ];
  const improvements = [
    ...architectureComparison.improvements,
    ...persistenceChanges.improvements,
  ];

  if (hasCliFlag("--write-baseline")) {
    const growth = [
      ...introduced,
      ...architectureComparison.metricIncreases.map(
        ({ metric, baseline: previous, current }) =>
          `metric:${metric}:${previous}->${current}`,
      ),
    ];
    const waiverOptions = growthWaiverOptions();
    if (growth.length > 0 && !growthWaiverOptionsAreValid(waiverOptions)) {
      console.error(
        "Baseline growth requires --issue, --reason, --owner-area, and a valid non-expired YYYY-MM-DD --expires-at.",
      );
      printList("Unwaived growth", growth);
      process.exitCode = 1;
      return;
    }
    if (
      architectureComparison.expiredWaivers.length > 0 ||
      architectureComparison.staleWaivers.length > 0
    ) {
      console.error(
        "Expired or stale architecture waivers must be removed before writing a baseline.",
      );
      return (process.exitCode = 1);
    }

    const waivers = createGrowthWaivers(
      introduced,
      architectureComparison.metricIncreases,
      waiverOptions,
      architectureComparison.baseline.waivers,
    );
    const nextBaseline = createArchitectureBaseline(snapshot, { waivers });
    await writeFile(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`);
    await writeFile(
      persistenceDebtManifestPath,
      `${JSON.stringify(
        createPersistenceDebtManifest(persistenceFindings),
        null,
        2,
      )}\n`,
    );
    console.log(
      `Wrote ${baselinePath} and ${persistenceDebtManifestPath} (architecture debt ratchet baseline).`,
    );
    return;
  }

  if (
    introduced.length > 0 ||
    architectureComparison.metricIncreases.length > 0 ||
    architectureComparison.expiredWaivers.length > 0 ||
    architectureComparison.staleWaivers.length > 0
  ) {
    console.error("Architecture debt ratchet failed:");
    printList("New or unwaived debt", introduced);
    printList(
      "Metric increases",
      architectureComparison.metricIncreases.map(
        ({ metric, baseline: previous, current }) =>
          `${metric}: baseline=${previous}, current=${current}`,
      ),
    );
    printList(
      "Expired waivers",
      architectureComparison.expiredWaivers.map(
        (waiver) => waiver.id ?? "invalid",
      ),
    );
    printList(
      "Stale waivers",
      architectureComparison.staleWaivers.map((waiver) => waiver.id),
    );
    process.exitCode = 1;
    return;
  }

  if (
    improvements.length > 0 ||
    architectureComparison.metricImprovements.length > 0
  ) {
    console.error("Architecture debt ratchet requires baseline shrink:");
    printList("Improvement detected", improvements);
    printList(
      "Metric decreases",
      architectureComparison.metricImprovements.map(
        ({ metric, baseline: previous, current }) =>
          `${metric}: baseline=${previous}, current=${current}`,
      ),
    );
    console.error(
      `Run ${path.basename(process.argv[1])} --write-baseline after reviewing the reduction.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("Architecture debt ratchet unchanged:");
  for (const line of formatArchitectureMetrics(snapshot.metrics)) {
    console.log(line);
  }
  console.log(
    `- expired waivers: ${architectureComparison.expiredWaivers.length}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  });
}
