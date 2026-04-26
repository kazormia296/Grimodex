import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { Diagnostic } from "./types";

/**
 * One entry in the persistent ignore list. Mirrors the
 * `lint_ignored_diagnostics` table columns.
 */
export interface LintIgnoreEntry {
  id: string;
  rule_id: string;
  scene_id: string;
  text_snippet: string;
  context_before: string;
  context_after: string;
  note: string | null;
  created_at: number;
}

interface QueryResult {
  rows: Record<string, unknown>[];
}

/** Chars of surrounding context recorded with each ignore entry. */
const CONTEXT_LEN = 20;

export function extractContext(
  sceneText: string,
  d: Diagnostic,
): { snippet: string; before: string; after: string } {
  const start = Math.max(0, Math.min(d.range.start, sceneText.length));
  const end = Math.max(start, Math.min(d.range.end, sceneText.length));
  const snippet = sceneText.slice(start, end);
  const before = sceneText.slice(Math.max(0, start - CONTEXT_LEN), start);
  const after = sceneText.slice(
    end,
    Math.min(sceneText.length, end + CONTEXT_LEN),
  );
  return { snippet, before, after };
}

/**
 * Identify whether a Diagnostic matches a stored ignore entry.
 *
 * Match rule (design spec §永続無視リスト):
 *     rule_id match AND snippet match AND (before match OR after match)
 */
export function matchesIgnore(
  entry: LintIgnoreEntry,
  d: Diagnostic,
  sceneText: string,
): boolean {
  if (entry.rule_id !== d.rule_id) return false;
  const { snippet, before, after } = extractContext(sceneText, d);
  if (snippet !== entry.text_snippet) return false;
  return before === entry.context_before || after === entry.context_after;
}

interface LintIgnoreState {
  /** Cache keyed by scene_id. */
  bySceneId: Record<string, LintIgnoreEntry[]>;
  loading: Record<string, boolean>;

  loadScene: (sceneId: string) => Promise<void>;
  addIgnore: (
    sceneId: string,
    d: Diagnostic,
    sceneText: string,
    note?: string,
  ) => Promise<LintIgnoreEntry>;
  deleteIgnore: (id: string) => Promise<void>;
  /**
   * Copy all ignore entries from one scene to another.
   * Used during scene-split: call for each of the two new scene IDs
   * before the old scene is deleted.
   */
  copyIgnoresToScene: (fromSceneId: string, toSceneId: string) => Promise<void>;
  /**
   * Move all ignore entries from one or more scenes to a target scene.
   * Used during scene-merge: call with both source scene IDs before
   * the source scenes are deleted.
   */
  moveIgnoresToScene: (
    fromSceneIds: string[],
    toSceneId: string,
  ) => Promise<void>;
  /** Filter a diagnostic list, dropping ones matched by stored ignores. */
  filterDiagnostics: (
    sceneId: string,
    diagnostics: Diagnostic[],
    sceneText: string,
  ) => Diagnostic[];
  clear: () => void;
}

async function dbExec<T = unknown>(
  sql: string,
  params: unknown[],
  method: "run" | "all" | "get" | "values",
): Promise<T> {
  const r = await invoke<QueryResult>("db_execute", { sql, params, method });
  return r as unknown as T;
}

function rowToEntry(row: Record<string, unknown>): LintIgnoreEntry {
  return {
    id: String(row.id),
    rule_id: String(row.rule_id),
    scene_id: String(row.scene_id),
    text_snippet: String(row.text_snippet),
    context_before: String(row.context_before),
    context_after: String(row.context_after),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    created_at: Number(row.created_at ?? 0),
  };
}

export const useLintIgnoreStore = create<LintIgnoreState>()((set, get) => ({
  bySceneId: {},
  loading: {},

  loadScene: async (sceneId) => {
    if (get().loading[sceneId]) return;
    set((s) => ({ loading: { ...s.loading, [sceneId]: true } }));
    try {
      const r = await dbExec<QueryResult>(
        `SELECT id, rule_id, scene_id, text_snippet, context_before, context_after, note, created_at
         FROM lint_ignored_diagnostics
         WHERE scene_id = ?
         ORDER BY created_at DESC`,
        [sceneId],
        "all",
      );
      const entries = r.rows.map(rowToEntry);
      set((s) => ({
        bySceneId: { ...s.bySceneId, [sceneId]: entries },
        loading: { ...s.loading, [sceneId]: false },
      }));
    } catch (err) {
      set((s) => ({ loading: { ...s.loading, [sceneId]: false } }));
      throw err;
    }
  },

  addIgnore: async (sceneId, d, sceneText, note) => {
    const ctx = extractContext(sceneText, d);
    const entry: LintIgnoreEntry = {
      id: crypto.randomUUID(),
      rule_id: d.rule_id,
      scene_id: sceneId,
      text_snippet: ctx.snippet,
      context_before: ctx.before,
      context_after: ctx.after,
      note: note ?? null,
      created_at: Date.now(),
    };
    await dbExec(
      `INSERT INTO lint_ignored_diagnostics
         (id, rule_id, scene_id, text_snippet, context_before, context_after, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.rule_id,
        entry.scene_id,
        entry.text_snippet,
        entry.context_before,
        entry.context_after,
        entry.note,
        entry.created_at,
      ],
      "run",
    );
    set((s) => ({
      bySceneId: {
        ...s.bySceneId,
        [sceneId]: [entry, ...(s.bySceneId[sceneId] ?? [])],
      },
    }));
    return entry;
  },

  deleteIgnore: async (id) => {
    await dbExec(
      `DELETE FROM lint_ignored_diagnostics WHERE id = ?`,
      [id],
      "run",
    );
    set((s) => {
      const next: Record<string, LintIgnoreEntry[]> = {};
      for (const [k, arr] of Object.entries(s.bySceneId)) {
        next[k] = arr.filter((e) => e.id !== id);
      }
      return { bySceneId: next };
    });
  },

  copyIgnoresToScene: async (fromSceneId, toSceneId) => {
    // Resolve source entries: prefer cache, fall back to DB load.
    let source = get().bySceneId[fromSceneId];
    if (!source) {
      await get().loadScene(fromSceneId);
      source = get().bySceneId[fromSceneId] ?? [];
    }
    if (source.length === 0) return;
    const copies: LintIgnoreEntry[] = source.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
      scene_id: toSceneId,
      created_at: Date.now(),
    }));
    // Batch insert via individual executions (db_execute handles one at a time).
    for (const c of copies) {
      await dbExec(
        `INSERT INTO lint_ignored_diagnostics
           (id, rule_id, scene_id, text_snippet, context_before, context_after, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.rule_id,
          c.scene_id,
          c.text_snippet,
          c.context_before,
          c.context_after,
          c.note,
          c.created_at,
        ],
        "run",
      );
    }
    set((s) => ({
      bySceneId: {
        ...s.bySceneId,
        [toSceneId]: [...copies, ...(s.bySceneId[toSceneId] ?? [])],
      },
    }));
  },

  moveIgnoresToScene: async (fromSceneIds, toSceneId) => {
    if (fromSceneIds.length === 0) return;
    const placeholders = fromSceneIds.map(() => "?").join(", ");
    await dbExec(
      `UPDATE lint_ignored_diagnostics SET scene_id = ? WHERE scene_id IN (${placeholders})`,
      [toSceneId, ...fromSceneIds],
      "run",
    );
    set((s) => {
      const movedEntries: LintIgnoreEntry[] = [];
      const next: Record<string, LintIgnoreEntry[]> = {};
      for (const [k, arr] of Object.entries(s.bySceneId)) {
        if (fromSceneIds.includes(k)) {
          movedEntries.push(...arr.map((e) => ({ ...e, scene_id: toSceneId })));
          next[k] = [];
        } else {
          next[k] = arr;
        }
      }
      next[toSceneId] = [...movedEntries, ...(next[toSceneId] ?? [])];
      return { bySceneId: next };
    });
  },

  filterDiagnostics: (sceneId, diagnostics, sceneText) => {
    const entries = get().bySceneId[sceneId];
    if (!entries || entries.length === 0) return diagnostics;
    return diagnostics.filter(
      (d) => !entries.some((e) => matchesIgnore(e, d, sceneText)),
    );
  },

  clear: () => set({ bySceneId: {}, loading: {} }),
}));
