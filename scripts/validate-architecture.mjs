import { existsSync, statSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(repoRoot, "src");
const baselinePath = path.join(repoRoot, "architecture-baseline.json");

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

async function main() {
  const findings = await collectFindings();
  if (process.argv.includes("--write-baseline")) {
    await writeFile(baselinePath, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`Wrote ${baselinePath}`);
    return;
  }

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const known = new Set(flatten(baseline));
  const fresh = flatten(findings).filter((finding) => !known.has(finding));
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
