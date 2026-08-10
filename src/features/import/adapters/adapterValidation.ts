import type { ImportSourceNode } from "../core/importSourceNode";
import type { ImportDiagnostic } from "../core/importDiagnostics";
import { importDiagnostic } from "../core/importDiagnostics";

export function findDuplicateNodeKeys(
  nodes: readonly ImportSourceNode[],
): readonly string[] {
  const seen = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    const count = (seen.get(node.key) ?? 0) + 1;
    seen.set(node.key, count);
    if (count > 1) duplicates.add(node.key);
  }
  return [...duplicates].sort();
}

export function findNodeParentCycles(
  nodes: readonly ImportSourceNode[],
): readonly string[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const cycles: string[] = [];

  for (const node of nodes) {
    const visited = new Set<string>();
    let current: ImportSourceNode | undefined = node;
    while (current?.parentKey) {
      if (visited.has(current.key)) {
        cycles.push(node.key);
        break;
      }
      visited.add(current.key);
      const parent = byKey.get(current.parentKey);
      if (!parent) break;
      if (parent.key === node.key) {
        cycles.push(node.key);
        break;
      }
      current = parent;
    }
  }

  return [...new Set(cycles)].sort();
}

export function validateImportSourceNodes(
  nodes: readonly ImportSourceNode[],
): readonly ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = [];
  for (const key of findDuplicateNodeKeys(nodes)) {
    diagnostics.push(
      importDiagnostic("error", "duplicate-node-key", `Duplicate node key: ${key}`, key),
    );
  }
  for (const key of findNodeParentCycles(nodes)) {
    diagnostics.push(
      importDiagnostic("error", "node-parent-cycle", `Node parent cycle detected: ${key}`, key),
    );
  }
  return diagnostics;
}

export function validateImportSourcePackageDraft(input: {
  readonly nodes: readonly ImportSourceNode[];
}): readonly ImportDiagnostic[] {
  return validateImportSourceNodes(input.nodes);
}
