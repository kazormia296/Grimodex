import { create } from "zustand";

import i18next from "@/lib/i18n";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { listCodexMatchTargets } from "@/features/codex/api";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  planBulkImport,
  type ImportMode,
  type ImportResult,
} from "./termDictionaryImport";
import type { ParsedTermEntry } from "./termDictionaryCsv";
import type { LintTermEntry } from "./types";
import {
  deleteTermDictionaryEntry,
  insertTermDictionaryEntry,
  listTermDictionaryEntries,
  setTermDictionaryEntryEnabled,
  updateTermDictionaryEntry,
  type PersistedTermDictionaryRow,
} from "./termDictionaryRepository";

/**
 * One row as stored in the `lint_term_dictionary` table plus decoration
 * fields (`aliasCollision`) computed on load.
 */
export interface TermDictionaryRow extends PersistedTermDictionaryRow {
  /**
   * Which variants collide with a Codex entry's alias / canonical. When
   * non-empty the row is shadowed by Codex at lint time (Codex wins);
   * the Settings UI surfaces the warning icon from this field.
   */
  aliasCollision: string[];
}

async function fetchCodexAliases(): Promise<Set<string>> {
  // Per 設計書 §「Codex Alias との衝突」, variants collide with entries'
  // `aliases` only — canonical names are not checked. This matches the
  // Rust engine's pre-filter in `resolve_term_dictionary`.
  const out = new Set<string>();
  try {
    const rows = await listCodexMatchTargets(getCurrentProjectId());
    for (const r of rows) {
      if (!r.aliases) continue;
      try {
        const parsed = JSON.parse(r.aliases);
        if (!Array.isArray(parsed)) continue;
        for (const a of parsed) {
          if (
            typeof a === "string" &&
            a.length > 0 &&
            a !== r.name // `aliases` sometimes echoes the canonical
          ) {
            out.add(a);
          }
        }
      } catch {
        // Skip broken alias JSON on one entry — doesn't affect the rest.
      }
    }
  } catch {
    // Codex DB not ready; leave collision set empty.
  }
  return out;
}

function computeCollision(variants: string[], aliases: Set<string>): string[] {
  const out: string[] = [];
  for (const v of variants) {
    if (aliases.has(v)) out.push(v);
  }
  return out;
}

/**
 * Validation performed before every upsert. Matches 設計書 §「バリデー
 * ション（保存時）」:
 *   - variants 空 → 保存不可
 *   - preferred 空 → 保存不可
 *   - preferred == variant → 自動的に variant から除去（返却値に反映）
 *   - 同じ variant が他エントリにある → エラー
 */
export interface ValidatedEntry {
  preferred: string;
  variants: string[];
  severity: "warning" | "info";
  note: string | null;
  enabled: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  cleaned?: ValidatedEntry;
}

export function validateEntry(
  input: {
    preferred: string;
    variants: string[];
    severity: "warning" | "info";
    note: string | null;
    enabled: boolean;
  },
  others: TermDictionaryRow[],
  selfId?: string,
): ValidationResult {
  const errors: string[] = [];
  const preferred = input.preferred.trim();
  if (!preferred) {
    errors.push(
      i18next.t(
        "lint.termDict.errorPreferredRequired",
        "推奨表記を入力してください。",
      ),
    );
  }
  // Deduplicate variants; drop preferred==variant occurrences per spec.
  const seen = new Set<string>();
  const cleanedVariants: string[] = [];
  for (const raw of input.variants) {
    const v = raw.trim();
    if (!v) continue;
    if (v === preferred) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    cleanedVariants.push(v);
  }
  if (cleanedVariants.length === 0) {
    errors.push(
      i18next.t(
        "lint.termDict.errorVariantsRequired",
        "許容しない表記を 1 つ以上入力してください。",
      ),
    );
  }
  // Cross-entry variant uniqueness.
  const dupAcross: string[] = [];
  for (const row of others) {
    if (row.id === selfId) continue;
    for (const v of cleanedVariants) {
      if (row.variants.includes(v)) dupAcross.push(`「${v}」`);
    }
  }
  if (dupAcross.length > 0) {
    errors.push(
      i18next.t("lint.termDict.errorDuplicateVariant", {
        variants: dupAcross.join(", "),
        defaultValue:
          "同じ variant が他のエントリに登録されています: {{variants}}",
      }),
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    cleaned: {
      preferred,
      variants: cleanedVariants,
      severity: input.severity,
      note: input.note?.trim() ? input.note.trim() : null,
      enabled: input.enabled,
    },
  };
}

interface TermDictionaryState {
  rows: TermDictionaryRow[];
  isLoaded: boolean;
  loading: boolean;
  searchQuery: string;
  sortBy: "preferred" | "updatedAt" | "severity" | "sortOrder";

  load: () => Promise<void>;
  /** Clear project-owned dictionary rows before a reload. */
  resetForProject: () => void;
  upsert: (
    input: {
      preferred: string;
      variants: string[];
      severity: "warning" | "info";
      note: string | null;
      enabled: boolean;
    },
    existingId?: string,
  ) => Promise<
    { ok: true; row: TermDictionaryRow } | { ok: false; errors: string[] }
  >;
  toggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<TermDictionaryRow | null>;
  /**
   * CSV インポートで得たエントリを一括反映する。`mode` = "merge"（preferred
   * 一致で更新・他は追加・既存据え置き）/ "replace"（全削除して入替）。
   * variant 一意性の解決・スキップ判定は `planBulkImport` に委譲し、反映後は
   * `load()` で rows と aliasCollision を作り直す。
   */
  bulkImport: (
    entries: ParsedTermEntry[],
    mode: ImportMode,
  ) => Promise<ImportResult>;
  setSearchQuery: (q: string) => void;
  setSortBy: (sort: TermDictionaryState["sortBy"]) => void;
  /** Rebuild `aliasCollision` on every row — called after Codex edits. */
  refreshCollisions: () => Promise<void>;
  /** Wire shape sent alongside every lint_text request. */
  toWire: () => LintTermEntry[];
}

export const useTermDictionaryStore = create<TermDictionaryState>()(
  (set, get) => ({
    rows: [],
    isLoaded: false,
    loading: false,
    searchQuery: "",
    sortBy: "sortOrder",

    resetForProject: () => set({ rows: [], isLoaded: false, loading: false }),

    load: async () => {
      if (get().loading) return;
      set({ loading: true });
      try {
        const persistedRows = await listTermDictionaryEntries(
          getCurrentProjectId(),
        );
        const aliases = await fetchCodexAliases();
        const rows: TermDictionaryRow[] = persistedRows.map((row) => ({
          ...row,
          aliasCollision: computeCollision(row.variants, aliases),
        }));
        set({ rows, isLoaded: true, loading: false });
      } catch (err) {
        set({ loading: false });
        throw err;
      }
    },

    upsert: async (input, existingId) => {
      const others = get().rows;
      const validation = validateEntry(input, others, existingId);
      if (!validation.ok || !validation.cleaned) {
        return { ok: false, errors: validation.errors };
      }
      const cleaned = validation.cleaned;
      const now = Date.now();
      const aliases = await fetchCodexAliases();
      const collision = computeCollision(cleaned.variants, aliases);
      if (existingId) {
        await updateTermDictionaryEntry({
          id: existingId,
          preferred: cleaned.preferred,
          variants: cleaned.variants,
          severity: cleaned.severity,
          note: cleaned.note,
          enabled: cleaned.enabled,
          updatedAt: now,
        });
        const updated: TermDictionaryRow = {
          id: existingId,
          preferred: cleaned.preferred,
          variants: cleaned.variants,
          severity: cleaned.severity,
          note: cleaned.note,
          enabled: cleaned.enabled,
          sortOrder: others.find((r) => r.id === existingId)?.sortOrder ?? 0,
          createdAt: others.find((r) => r.id === existingId)?.createdAt ?? now,
          updatedAt: now,
          aliasCollision: collision,
        };
        set({
          rows: get()
            .rows.map((r) => (r.id === existingId ? updated : r))
            .sort(compareRows(get().sortBy)),
        });
        recordChangeEvent({
          domain: "lint",
          opType: "term.upsert",
          entityType: "lint_term",
          entityId: existingId,
          payload: { termId: existingId, preferred: cleaned.preferred },
        });
        return { ok: true, row: updated };
      }
      const id = crypto.randomUUID();
      const sortOrder = (others[others.length - 1]?.sortOrder ?? -1) + 1;
      await insertTermDictionaryEntry(getCurrentProjectId(), {
        id,
        preferred: cleaned.preferred,
        variants: cleaned.variants,
        severity: cleaned.severity,
        note: cleaned.note,
        enabled: cleaned.enabled,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      });
      const row: TermDictionaryRow = {
        id,
        preferred: cleaned.preferred,
        variants: cleaned.variants,
        severity: cleaned.severity,
        note: cleaned.note,
        enabled: cleaned.enabled,
        sortOrder,
        createdAt: now,
        updatedAt: now,
        aliasCollision: collision,
      };
      set({
        rows: [...get().rows, row].sort(compareRows(get().sortBy)),
      });
      recordChangeEvent({
        domain: "lint",
        opType: "term.upsert",
        entityType: "lint_term",
        entityId: id,
        payload: { termId: id, preferred: cleaned.preferred },
      });
      return { ok: true, row };
    },

    toggleEnabled: async (id, enabled) => {
      const now = Date.now();
      await setTermDictionaryEntryEnabled(id, enabled, now);
      set({
        rows: get().rows.map((r) =>
          r.id === id ? { ...r, enabled, updatedAt: now } : r,
        ),
      });
    },

    remove: async (id) => {
      await deleteTermDictionaryEntry(id);
      set({ rows: get().rows.filter((r) => r.id !== id) });
      recordChangeEvent({
        domain: "lint",
        opType: "term.delete",
        entityType: "lint_term",
        entityId: id,
        payload: { termId: id },
      });
    },

    duplicate: async (id) => {
      const source = get().rows.find((r) => r.id === id);
      if (!source) return null;
      // Bypass the CRUD validator — duplicated variants would otherwise
      // trip the uniqueness check. We disable the row, append `_copy`
      // to every variant, and leave it to the user to edit into shape.
      const now = Date.now();
      const newId = crypto.randomUUID();
      const sortOrder =
        (get().rows[get().rows.length - 1]?.sortOrder ?? -1) + 1;
      const newVariants = source.variants.map((v) => `${v}_copy`);
      const preferred = i18next.t("lint.termDict.copySuffix", {
        name: source.preferred,
        defaultValue: "{{name}}（コピー）",
      });
      await insertTermDictionaryEntry(getCurrentProjectId(), {
        id: newId,
        preferred,
        variants: newVariants,
        severity: source.severity,
        note: source.note,
        enabled: false,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      });
      const row: TermDictionaryRow = {
        id: newId,
        preferred,
        variants: newVariants,
        severity: source.severity,
        note: source.note,
        enabled: false,
        sortOrder,
        createdAt: now,
        updatedAt: now,
        aliasCollision: [],
      };
      set({ rows: [...get().rows, row].sort(compareRows(get().sortBy)) });
      return row;
    },

    bulkImport: async (entries, mode) => {
      // 未ロードのまま replace すると既存行を取りこぼすため、先に読み込む。
      if (!get().isLoaded) await get().load();
      const plan = planBulkImport(get().rows, entries, mode);
      const now = Date.now();
      const projectId = getCurrentProjectId();
      for (const id of plan.deletes) {
        await deleteTermDictionaryEntry(id);
      }
      for (const u of plan.updates) {
        await updateTermDictionaryEntry({
          id: u.id,
          preferred: u.preferred,
          variants: u.variants,
          severity: u.severity,
          note: u.note,
          enabled: u.enabled,
          updatedAt: now,
        });
        recordChangeEvent({
          domain: "lint",
          opType: "term.upsert",
          entityType: "lint_term",
          entityId: u.id,
          payload: { termId: u.id, preferred: u.preferred },
        });
      }
      for (const ins of plan.inserts) {
        const id = crypto.randomUUID();
        await insertTermDictionaryEntry(projectId, {
          id,
          preferred: ins.preferred,
          variants: ins.variants,
          severity: ins.severity,
          note: ins.note,
          enabled: ins.enabled,
          sortOrder: ins.sortOrder,
          createdAt: now,
          updatedAt: now,
        });
        recordChangeEvent({
          domain: "lint",
          opType: "term.upsert",
          entityType: "lint_term",
          entityId: id,
          payload: { termId: id, preferred: ins.preferred },
        });
      }
      // rows と aliasCollision を DB から作り直す。
      await get().load();
      return plan.result;
    },

    setSearchQuery: (q) => set({ searchQuery: q }),
    setSortBy: (sort) =>
      set({
        sortBy: sort,
        rows: [...get().rows].sort(compareRows(sort)),
      }),

    refreshCollisions: async () => {
      const aliases = await fetchCodexAliases();
      set({
        rows: get().rows.map((r) => ({
          ...r,
          aliasCollision: computeCollision(r.variants, aliases),
        })),
      });
    },

    toWire: () => {
      return get().rows.map((r) => ({
        id: r.id,
        preferred: r.preferred,
        variants: r.variants,
        severity: r.severity,
        note: r.note ?? undefined,
        enabled: r.enabled,
      }));
    },
  }),
);

function compareRows(sortBy: TermDictionaryState["sortBy"]) {
  return (a: TermDictionaryRow, b: TermDictionaryRow) => {
    switch (sortBy) {
      case "preferred":
        return a.preferred.localeCompare(b.preferred, "ja");
      case "updatedAt":
        return b.updatedAt - a.updatedAt;
      case "severity":
        return a.severity.localeCompare(b.severity);
      case "sortOrder":
      default:
        return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt;
    }
  };
}
