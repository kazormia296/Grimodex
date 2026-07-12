import { existsSync } from "node:fs";
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

function relativeSource(absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
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
  const pattern = /(?:^|[\n;])\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[1].trim().startsWith("type ")) result.push(match[2]);
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

function resolveImport(_importer, specifier) {
  if (!specifier.startsWith("@/")) return null;
  const withoutAlias = specifier.slice(2);
  const base = path.join(sourceRoot, withoutAlias);
  return (
    [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
      (candidate) => existsSync(candidate),
    ) ?? null
  );
}

function canonicalCycle(component) {
  const sorted = [...component].sort();
  return sorted.join(" -> ");
}

function findCycles(graph) {
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
      component.push(relativeSource(current));
    } while (current !== node);
    if (component.length > 1) components.push(canonicalCycle(component));
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

export async function collectFindings() {
  const files = await collectSourceFiles(sourceRoot);
  const findings = {
    "cross-feature-store-import": [],
    "cross-feature-store-mutation": [],
    "dynamic-store-import": [],
    "application-component-import": [],
    "feature-cycle": [],
  };
  const graph = new Map(files.map((file) => [file, new Set()]));

  for (const file of files) {
    const relative = relativeSource(file);
    const fromFeature = featureFromSource(relative);
    const source = await readFile(file, "utf8");

    for (const specifier of importSpecifiers(source)) {
      const toFeature = featureFromSpecifier(specifier);
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
      if (/^src\/application/.test(relative) && /\.tsx?$/.test(specifier)) {
        findings["application-component-import"].push(
          `${relative}:${specifier}`,
        );
      }
    }

    for (const specifier of runtimeImportSpecifiers(source)) {
      const resolved = resolveImport(file, specifier);
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

  findings["feature-cycle"] = findCycles(graph);
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
