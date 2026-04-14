import type { DockviewApi } from "dockview-react";
import i18next from "@/lib/i18n";

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
    return { valid: false, reason: i18next.t("validation.invalidData") };
  }

  const d = data as Record<string, unknown>;

  if (!d.grid || typeof d.grid !== "object") {
    return { valid: false, reason: i18next.t("validation.missingGrid") };
  }

  const grid = d.grid as Record<string, unknown>;

  if (!grid.root) {
    return { valid: false, reason: i18next.t("validation.missingGridRoot") };
  }

  if (typeof grid.width !== "number" || grid.width <= 0) {
    return {
      valid: false,
      reason: i18next.t("validation.invalidGridWidth", { value: grid.width }),
    };
  }

  if (typeof grid.height !== "number" || grid.height <= 0) {
    return {
      valid: false,
      reason: i18next.t("validation.invalidGridHeight", { value: grid.height }),
    };
  }

  const leafCount = countLeaves(grid.root);
  if (leafCount < 2) {
    return {
      valid: false,
      reason: i18next.t("validation.degenerateLayout", { count: leafCount }),
    };
  }

  const panels = d.panels;
  if (!panels || typeof panels !== "object" || Object.keys(panels).length < 2) {
    return {
      valid: false,
      reason: i18next.t("validation.insufficientPanels", {
        count: Object.keys(panels ?? {}).length,
      }),
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
      reason: i18next.t("validation.insufficientGroups", {
        count: groups.length,
      }),
    };
  }

  const totalWidth = api.width;
  if (totalWidth > 0) {
    for (const group of groups) {
      const ratio = group.width / totalWidth;
      if (ratio > 0.85) {
        return {
          valid: false,
          reason: i18next.t("validation.singleGroupDominates", {
            pct: Math.round(ratio * 100),
          }),
        };
      }
    }
  }

  return { valid: true };
}
