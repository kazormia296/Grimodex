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
 * 階層 walk に必要な最小列。M10: chat 経路は icon/notes を持たない
 * projection 行 (CodexContextEntry) を渡すため、CodexEntry 固定にせず
 * 構造的部分型のジェネリクスで受ける (UI 経路は従来通り全列行を渡せる)。
 */
type HierarchyEntry = Pick<CodexEntry, "id" | "parentId">;

/**
 * Get children of an entry from an already-loaded entries array (synchronous).
 * Use this for UI rendering to avoid extra DB queries.
 */
export function getChildrenFromArray<T extends HierarchyEntry>(
  parentId: string,
  allEntries: T[],
): T[] {
  return allEntries.filter((e) => e.parentId === parentId);
}

/**
 * BFS traversal of descendants using loaded entries array.
 * Returns entries in BFS order (breadth-first).
 */
export function getDescendantsBFS<T extends HierarchyEntry>(
  entryId: string,
  allEntries: T[],
): T[] {
  const result: T[] = [];
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
 * Collect descendant ids already surfaced via childrenContext — i.e. the
 * descendants of every seed whose children budget is active (preset !== "none").
 * Used to exclude them from formal-relation (codex_relations) expansion so an
 * entry that is both a hierarchy child AND a typed-relation neighbor is not
 * injected into the L4 context twice (once as childrenContext, once as a
 * relation block). Seeds with budget "none" contribute no descendants.
 */
export function collectBudgetedDescendantIds(
  seedIds: Iterable<string>,
  allEntries: Array<Pick<CodexEntry, "id" | "parentId" | "childrenBudget">>,
): Set<string> {
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const ids = new Set<string>();
  for (const seedId of seedIds) {
    const seed = byId.get(seedId);
    if ((seed?.childrenBudget ?? "compact") === "none") continue;
    for (const d of getDescendantsBFS(seedId, allEntries)) {
      ids.add(d.id);
    }
  }
  return ids;
}

/**
 * Build context string for descendants within a token budget.
 * Returns empty string if preset is 'none' or budget is 0.
 *
 * Phase Cb: `resolvedById` を渡すと、各子孫の summary / content を**現在シーン
 * 時点で phase 解決済みの状態**で注入する（seed と同じ基準に揃える）。未指定 or
 * map に無い子孫は生 summary にフォールバック。生のまま注入すると、過去シーンに
 * 子孫の未来/旧状態を漏らす relation と同型の時点リークになるため、親が phase
 * 解決される経路（detected / focus）では必ず渡すこと。
 */
export function buildChildrenContext(
  descendants: Array<Pick<CodexEntry, "id" | "name" | "summary" | "content">>,
  budgetTokens: number,
  resolvedById?: ReadonlyMap<
    string,
    { summary: string | null; content: string }
  >,
): string {
  if (budgetTokens <= 0 || descendants.length === 0) return "";

  const lines: string[] = [];
  let usedTokens = 0;

  for (const child of descendants) {
    const rs = resolvedById?.get(child.id);
    const childSummary = rs ? rs.summary : child.summary;
    const childContent = rs ? rs.content : child.content;
    const summary =
      childSummary?.trim() || extractPlainText(childContent) || "";
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
