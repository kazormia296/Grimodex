import { countTokens } from "@/features/chat/contextBuilder";
import type { CodexEntry } from "./api";

export type ChildrenBudgetPreset = "none" | "compact" | "standard" | "generous";

export const BUDGET_RATIOS: Record<ChildrenBudgetPreset, number> = {
  none: 0,
  compact: 0.15,
  standard: 0.3,
  generous: 0.5,
};

export const BUDGET_LABELS: Record<ChildrenBudgetPreset, string> = {
  none: "なし (0%)",
  compact: "コンパクト (15%)",
  standard: "標準 (30%)",
  generous: "充実 (50%)",
};

/**
 * Get children of an entry from an already-loaded entries array (synchronous).
 * Use this for UI rendering to avoid extra DB queries.
 */
export function getChildrenFromArray(
  parentId: string,
  allEntries: CodexEntry[],
): CodexEntry[] {
  return allEntries.filter((e) => e.parentId === parentId);
}

/**
 * BFS traversal of descendants using loaded entries array.
 * Returns entries in BFS order (breadth-first).
 */
export function getDescendantsBFS(
  entryId: string,
  allEntries: CodexEntry[],
): CodexEntry[] {
  const result: CodexEntry[] = [];
  const visited = new Set<string>();
  const queue = getChildrenFromArray(entryId, allEntries);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    result.push(current);
    queue.push(...getChildrenFromArray(current.id, allEntries));
  }

  return result;
}

/**
 * Build context string for descendants within a token budget.
 * Returns empty string if preset is 'none' or budget is 0.
 */
export function buildChildrenContext(
  descendants: CodexEntry[],
  budgetTokens: number,
): string {
  if (budgetTokens <= 0 || descendants.length === 0) return "";

  const lines: string[] = [];
  let usedTokens = 0;

  for (const child of descendants) {
    const summary = child.summary?.trim();
    if (!summary) continue;
    const line = `  - ${child.name}: ${summary}`;
    const lineTokens = countTokens(line);
    if (usedTokens + lineTokens > budgetTokens) break;
    lines.push(line);
    usedTokens += lineTokens;
  }

  return lines.join("\n");
}

/**
 * Compute token budget for children context.
 */
export function computeChildrenTokenBudget(
  preset: string,
  totalContextBudget: number,
): number {
  const ratio = BUDGET_RATIOS[preset as ChildrenBudgetPreset] ?? 0.15;
  return Math.floor(totalContextBudget * ratio);
}
