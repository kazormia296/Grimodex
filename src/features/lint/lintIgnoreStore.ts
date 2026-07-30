import { create } from "zustand";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import {
  copyLintIgnores,
  createLintIgnore,
  deleteLintIgnore,
  listLintIgnoresForScene,
  moveLintIgnores,
} from "./lintIgnoreApi";
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

  loadScene: (sceneId: string, projectId: string) => Promise<void>;
  addIgnore: (
    sceneId: string,
    d: Diagnostic,
    sceneText: string,
    projectId: string,
    note?: string,
  ) => Promise<LintIgnoreEntry>;
  deleteIgnore: (id: string, projectId: string) => Promise<void>;
  /**
   * Copy all ignore entries from one scene to another.
   * Used during scene-split: call for each of the two new scene IDs
   * before the old scene is deleted.
   */
  copyIgnoresToScene: (
    fromSceneId: string,
    toSceneId: string,
    projectId: string,
  ) => Promise<void>;
  /**
   * Move all ignore entries from one or more scenes to a target scene.
   * Used during scene-merge: call with both source scene IDs before
   * the source scenes are deleted.
   */
  moveIgnoresToScene: (
    fromSceneIds: string[],
    toSceneId: string,
    projectId: string,
  ) => Promise<void>;
  /** Filter a diagnostic list, dropping ones matched by stored ignores. */
  filterDiagnostics: (
    sceneId: string,
    diagnostics: Diagnostic[],
    sceneText: string,
  ) => Diagnostic[];
  clear: () => void;
}

export const useLintIgnoreStore = create<LintIgnoreState>()((set, get) => ({
  bySceneId: {},
  loading: {},

  loadScene: async (sceneId, projectId) => {
    if (get().loading[sceneId]) return;
    set((s) => ({ loading: { ...s.loading, [sceneId]: true } }));
    try {
      const entries = await listLintIgnoresForScene(sceneId, projectId);
      set((s) => ({
        bySceneId: { ...s.bySceneId, [sceneId]: entries },
        loading: { ...s.loading, [sceneId]: false },
      }));
    } catch (err) {
      set((s) => ({ loading: { ...s.loading, [sceneId]: false } }));
      throw err;
    }
  },

  addIgnore: async (sceneId, d, sceneText, projectId, note) => {
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
    const persisted = await createLintIgnore(entry, projectId);
    set((s) => ({
      bySceneId: {
        ...s.bySceneId,
        [sceneId]: [persisted, ...(s.bySceneId[sceneId] ?? [])],
      },
    }));
    recordChangeEvent({
      domain: "lint",
      opType: "ignore.add",
      entityType: "lint_ignore",
      entityId: persisted.id,
      // sceneId kept in payload (not the FK column) — scene_id may not be a
      // live tree_nodes row and a bad FK would wedge the flush loop.
      payload: { ignoreId: persisted.id, ruleId: persisted.rule_id, sceneId },
    });
    return persisted;
  },

  deleteIgnore: async (id, projectId) => {
    await deleteLintIgnore(id, projectId);
    set((s) => {
      const next: Record<string, LintIgnoreEntry[]> = {};
      for (const [k, arr] of Object.entries(s.bySceneId)) {
        next[k] = arr.filter((e) => e.id !== id);
      }
      return { bySceneId: next };
    });
    recordChangeEvent({
      domain: "lint",
      opType: "ignore.delete",
      entityType: "lint_ignore",
      entityId: id,
      payload: { ignoreId: id },
    });
  },

  copyIgnoresToScene: async (fromSceneId, toSceneId, projectId) => {
    // Resolve source entries: prefer cache, fall back to DB load.
    let source = get().bySceneId[fromSceneId];
    if (!source) {
      await get().loadScene(fromSceneId, projectId);
      source = get().bySceneId[fromSceneId] ?? [];
    }
    if (source.length === 0) return;
    const copies = await copyLintIgnores(fromSceneId, toSceneId, projectId);
    set((s) => ({
      bySceneId: {
        ...s.bySceneId,
        [toSceneId]: [...copies, ...(s.bySceneId[toSceneId] ?? [])],
      },
    }));
  },

  moveIgnoresToScene: async (fromSceneIds, toSceneId, projectId) => {
    if (fromSceneIds.length === 0) return;
    const movedEntries = await moveLintIgnores(
      fromSceneIds,
      toSceneId,
      projectId,
    );
    set((s) => {
      const next: Record<string, LintIgnoreEntry[]> = {};
      for (const [k, arr] of Object.entries(s.bySceneId)) {
        if (fromSceneIds.includes(k)) {
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
