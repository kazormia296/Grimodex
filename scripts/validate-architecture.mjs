import { existsSync, statSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "src");
const baselinePath = path.join(repoRoot, "architecture-baseline.json");
const genericSqlWriteManifestPath = path.join(
  repoRoot,
  "policies/architecture/generic-renderer-sql-writes.json",
);

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
  return files;
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

function rawSqlWrite(node) {
  let sql;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    sql = node.text;
  } else if (ts.isTemplateExpression(node)) {
    sql = node.head.text;
  } else {
    return null;
  }
  const patterns = [
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
  ];
  for (const { operation, pattern } of patterns) {
    const match = sql.match(pattern);
    if (match) return { operation, target: match[1] };
  }
  return null;
}

function genericRendererSqlWriteFindings(
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
  const bases = [];

  function add(kind, target) {
    bases.push(`${relative}:${kind}:${target}`);
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
      add(`drizzle-${node.expression.name.text}`, target);
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
      add("generic-db-route", node.arguments[0].text);
    }

    const rawWrite =
      relative === "src/lib/browser-mock.ts" ? null : rawSqlWrite(node);
    if (rawWrite) {
      add(`raw-sql-${rawWrite.operation}`, rawWrite.target);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const occurrences = new Map();
  return bases.map((base) => {
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return `${base}#${occurrence}`;
  });
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

function canonicalCycle(component) {
  const sorted = [...component].sort();
  return sorted.join(" -> ");
}

function findCycles(graph, currentRepoRoot = repoRoot) {
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
      component.push(relativeSource(current, currentRepoRoot));
    } while (current !== node);
    if (component.length > 1) components.push(canonicalCycle(component));
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

export async function collectFindings(options = {}) {
  const currentRepoRoot = options.repoRoot ?? repoRoot;
  const currentSourceRoot =
    options.sourceRoot ?? path.join(currentRepoRoot, "src");
  const files = await collectSourceFiles(currentSourceRoot);
  const findings = {
    "cross-feature-store-import": [],
    "cross-feature-store-mutation": [],
    "dynamic-store-import": [],
    "application-component-import": [],
    "single-scene-load-in-array-loop": [],
    "generic-renderer-sql-write": [],
    "legacy-ipc-error-text-check": [],
    "feature-cycle": [],
  };
  const graph = new Map(files.map((file) => [file, new Set()]));

  for (const file of files) {
    const relative = relativeSource(file, currentRepoRoot);
    const fromFeature = featureFromSource(relative);
    const source = await readFile(file, "utf8");

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
    findings["generic-renderer-sql-write"].push(
      ...genericRendererSqlWriteFindings(
        source,
        relative,
        file,
        currentSourceRoot,
      ),
    );
    findings["legacy-ipc-error-text-check"].push(
      ...legacyIpcErrorTextFindings(source, relative),
    );
  }

  findings["feature-cycle"] = findCycles(graph, currentRepoRoot);
  for (const values of Object.values(findings)) values.sort();
  return findings;
}

function flatten(findings) {
  return Object.entries(findings).flatMap(([rule, values]) =>
    values.map((value) => `${rule}:${value}`),
  );
}

export function findNewFindings(findings, baseline) {
  const known = new Set(flatten(baseline));
  return flatten(findings).filter((finding) => !known.has(finding));
}

export function createGenericSqlWriteManifest(findings) {
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
  return {
    schemaVersion: 1,
    scope:
      "Existing renderer Drizzle mutations, raw SQL mutations, and direct generic db_execute routes.",
    policy:
      "This is a migration ceiling, not an approved API list. New callsites must use a typed persistence command or explicitly update this debt manifest.",
    allowedCallsiteCounts: Object.fromEntries(
      Object.entries(allowedCallsiteCounts).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };
}

export function findNewGenericSqlWriteFindings(findings, manifest) {
  const allowed = manifest.allowedCallsiteCounts ?? {};
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
  return [...overages, ...staleCeilings].sort();
}

async function main() {
  const findings = await collectFindings();
  const genericSqlWriteFindings = findings["generic-renderer-sql-write"];
  const architectureFindings = { ...findings };
  delete architectureFindings["generic-renderer-sql-write"];
  if (process.argv.includes("--write-baseline")) {
    await writeFile(
      baselinePath,
      `${JSON.stringify(architectureFindings, null, 2)}\n`,
    );
    await writeFile(
      genericSqlWriteManifestPath,
      `${JSON.stringify(
        createGenericSqlWriteManifest(genericSqlWriteFindings),
        null,
        2,
      )}\n`,
    );
    console.log(`Wrote ${baselinePath} and ${genericSqlWriteManifestPath}`);
    return;
  }

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const genericSqlWriteManifest = JSON.parse(
    await readFile(genericSqlWriteManifestPath, "utf8"),
  );
  const fresh = [
    ...findNewFindings(architectureFindings, baseline),
    ...findNewGenericSqlWriteFindings(
      genericSqlWriteFindings,
      genericSqlWriteManifest,
    ).map((finding) => `generic-renderer-sql-write:${finding}`),
  ];
  if (fresh.length > 0) {
    console.error("Architecture boundary violations introduced:");
    for (const finding of fresh) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Architecture boundary baseline is clean.");
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
