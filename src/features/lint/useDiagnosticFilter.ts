import { useState } from "react";
import type { Diagnostic, Severity } from "./types";

/**
 * Severity filter shared by Current / Project linter views.
 * Each flag toggles whether diagnostics of that severity are visible.
 */
export interface SeverityFilter {
  error: boolean;
  warning: boolean;
  info: boolean;
}

const DEFAULT_FILTER: SeverityFilter = {
  error: true,
  warning: true,
  info: true,
};

/**
 * Shared local state used by both LinterPanel views (Current scene and
 * Project mode). Each view picks its own GroupMode literal because the
 * available group axes differ ("severity"|"rule"|"none" vs.
 * "scene"|"rule"|"severity"), but every other piece of state is identical.
 *
 * Keeping the state inside one hook ensures both views default the same
 * way and stay in sync if any setter contract changes.
 */
export function useDiagnosticFilter<G extends string>(defaultGroupMode: G) {
  const [severityFilter, setSeverityFilter] =
    useState<SeverityFilter>(DEFAULT_FILTER);
  const [groupMode, setGroupMode] = useState<G>(defaultGroupMode);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  return {
    severityFilter,
    setSeverityFilter,
    groupMode,
    setGroupMode,
    query,
    setQuery,
    collapsed,
    setCollapsed,
    selectedKey,
    setSelectedKey,
  };
}

/** True when `d` passes both the severity filter and the search query. */
export function matchesDiagnosticFilter(
  d: Diagnostic,
  filter: SeverityFilter,
  query: string,
): boolean {
  if (!filter[d.severity]) return false;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const hay = `${d.rule_id} ${d.message}`.toLowerCase();
  return hay.includes(q);
}

/** Apply the severity+query filter to a flat Diagnostic[]. */
export function filterDiagnostics(
  diagnostics: Diagnostic[],
  filter: SeverityFilter,
  query: string,
): Diagnostic[] {
  return diagnostics.filter((d) => matchesDiagnosticFilter(d, filter, query));
}

/** A render-ready bucket for the LinterPanel list. */
export interface DiagnosticGroup<T> {
  key: string;
  label: string | null;
  items: T[];
}

const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"];
const SEVERITY_LABELS: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

/**
 * Group `items` by severity. Generic over the row type because Project
 * mode wraps each diagnostic in `{ scene, d }`, while Current mode
 * passes plain `Diagnostic`. `keyPrefix` differentiates the resulting
 * group keys ("error" vs "sev:error") so each view's flatRows /
 * collapsed map keys stay backwards-compatible.
 */
export function groupBySeverity<T>(
  items: T[],
  getSeverity: (item: T) => Severity,
  keyPrefix = "",
): DiagnosticGroup<T>[] {
  const buckets: Record<Severity, T[]> = { error: [], warning: [], info: [] };
  for (const item of items) buckets[getSeverity(item)].push(item);
  return SEVERITY_ORDER.filter((s) => buckets[s].length > 0).map((s) => ({
    key: `${keyPrefix}${s}`,
    label: `${SEVERITY_LABELS[s]} (${buckets[s].length})`,
    items: buckets[s],
  }));
}

/** Group `items` by rule id, sorted lexicographically. */
export function groupByRule<T>(
  items: T[],
  getRuleId: (item: T) => string,
): DiagnosticGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const id = getRuleId(item);
    const arr = buckets.get(id) ?? [];
    arr.push(item);
    buckets.set(id, arr);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleId, groupItems]) => ({
      key: `rule:${ruleId}`,
      label: `${ruleId} (${groupItems.length})`,
      items: groupItems,
    }));
}
