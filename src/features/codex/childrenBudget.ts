import i18next from "@/lib/i18n";
import { countTokens } from "@/features/chat/contextBuilder";
import { extractPlainText } from "./prosemirrorTextExtractor";
import type { CodexEntry } from "./api";

export type ChildrenBudgetPreset = "none" | "compact" | "standard" | "generous";

export const BUDGET_RATIOS: Record<ChildrenBudgetPreset, number> = {
  none: 0,
  compact: 0.15,
  standard: 0.3,
  generous: 0.5,
};

const BUDGET_LABEL_KEYS: Record<ChildrenBudgetPreset, string> = {
  none: "codex.childrenBudget.none",
  compact: "codex.childrenBudget.compact",
  standard: "codex.childrenBudget.standard",
  generous: "codex.childrenBudget.generous",
};

export function getBudgetLabels(): Record<ChildrenBudgetPreset, string> {
  return Object.fromEntries(
    Object.entries(BUDGET_LABEL_KEYS).map(([k, v]) => [k, i18next.t(v)]),
  ) as Record<ChildrenBudgetPreset, string>;
}

/** @deprecated Use getBudgetLabels() for localized labels */
export const BUDGET_LABELS = BUDGET_LABEL_KEYS;

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

  return result.sort((a, b) => a.id.localeCompare(b.id));
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
    const summary =
      child.summary?.trim() || extractPlainText(child.content) || "";
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
