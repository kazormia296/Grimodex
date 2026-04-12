import type { DockviewApi } from "dockview-react";

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/** Recursively count leaf nodes in a serialized grid tree */
function countLeaves(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as Record<string, unknown>;
  if (n.type === "leaf") return 1;
  if (n.type === "branch" && Array.isArray(n.data)) {
    return (n.data as unknown[]).reduce<number>(
      (sum, child) => sum + countLeaves(child),
      0,
    );
  }
  return 0;
}

/**
 * Validate a serialized dockview layout before calling api.fromJSON().
 * Catches structurally degenerate layouts (e.g. single group = 100% width)
 * that fromJSON() would restore without throwing.
 */
export function validateSerializedLayout(data: unknown): ValidationResult {
  if (!data || typeof data !== "object") {
    return { valid: false, reason: "レイアウトデータが不正です" };
  }

  const d = data as Record<string, unknown>;

  if (!d.grid || typeof d.grid !== "object") {
    return { valid: false, reason: "grid フィールドがありません" };
  }

  const grid = d.grid as Record<string, unknown>;

  if (!grid.root) {
    return { valid: false, reason: "grid.root がありません" };
  }

  if (typeof grid.width !== "number" || grid.width <= 0) {
    return { valid: false, reason: `grid.width が不正です (${grid.width})` };
  }

  if (typeof grid.height !== "number" || grid.height <= 0) {
    return { valid: false, reason: `grid.height が不正です (${grid.height})` };
  }

  const leafCount = countLeaves(grid.root);
  if (leafCount < 2) {
    return {
      valid: false,
      reason: `レイアウトが退化しています（グループ数: ${leafCount}）`,
    };
  }

  const panels = d.panels;
  if (!panels || typeof panels !== "object" || Object.keys(panels).length < 2) {
    return {
      valid: false,
      reason: `パネル数が不足しています（${Object.keys(panels ?? {}).length}）`,
    };
  }

  return { valid: true };
}

/**
 * Validate a live dockview layout after calling api.fromJSON().
 * Catches cases where the restored layout has too few groups or
 * a single group dominates the entire viewport.
 */
export function validateRuntimeLayout(api: DockviewApi): ValidationResult {
  const groups = api.groups;

  if (groups.length < 2) {
    return {
      valid: false,
      reason: `グループ数が不足しています（${groups.length}）`,
    };
  }

  const totalWidth = api.width;
  if (totalWidth > 0) {
    for (const group of groups) {
      const ratio = group.width / totalWidth;
      if (ratio > 0.85) {
        return {
          valid: false,
          reason: `単一グループが画面幅の ${Math.round(ratio * 100)}% を占めています`,
        };
      }
    }
  }

  return { valid: true };
}
