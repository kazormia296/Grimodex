import { invoke } from "@/lib/tauri";
import type { LintIgnoreEntry } from "./lintIgnoreStore";

interface LintIgnoreWireEntry {
  id: string;
  ruleId: string;
  sceneId: string;
  textSnippet: string;
  contextBefore: string;
  contextAfter: string;
  note: string | null;
  createdAt: number;
  sceneTitle: string | null;
}

function fromWire(entry: LintIgnoreWireEntry): LintIgnoreEntry {
  return {
    id: entry.id,
    rule_id: entry.ruleId,
    scene_id: entry.sceneId,
    text_snippet: entry.textSnippet,
    context_before: entry.contextBefore,
    context_after: entry.contextAfter,
    note: entry.note,
    created_at: entry.createdAt,
  };
}

export async function listLintIgnores(
  projectId: string,
): Promise<Array<LintIgnoreEntry & { sceneTitle: string | null }>> {
  const entries = await invoke<LintIgnoreWireEntry[]>("lint_ignore_list", {
    projectId,
  });
  return entries.map((entry) => ({
    ...fromWire(entry),
    sceneTitle: entry.sceneTitle,
  }));
}

export async function listLintIgnoresForScene(
  sceneId: string,
  projectId: string,
): Promise<LintIgnoreEntry[]> {
  const entries = await invoke<LintIgnoreWireEntry[]>(
    "lint_ignore_list_scene",
    { projectId, sceneId },
  );
  return entries.map(fromWire);
}

export async function createLintIgnore(
  entry: LintIgnoreEntry,
  projectId: string,
): Promise<LintIgnoreEntry> {
  const created = await invoke<LintIgnoreWireEntry>("lint_ignore_create", {
    payload: {
      id: entry.id,
      projectId,
      sceneId: entry.scene_id,
      ruleId: entry.rule_id,
      textSnippet: entry.text_snippet,
      contextBefore: entry.context_before,
      contextAfter: entry.context_after,
      note: entry.note,
      createdAt: entry.created_at,
    },
  });
  return fromWire(created);
}

export function deleteLintIgnore(id: string, projectId: string): Promise<void> {
  return invoke<void>("lint_ignore_delete", { projectId, id });
}

export async function copyLintIgnores(
  fromSceneId: string,
  toSceneId: string,
  projectId: string,
): Promise<LintIgnoreEntry[]> {
  const entries = await invoke<LintIgnoreWireEntry[]>("lint_ignore_copy", {
    payload: { projectId, fromSceneId, toSceneId },
  });
  return entries.map(fromWire);
}

export async function moveLintIgnores(
  fromSceneIds: string[],
  toSceneId: string,
  projectId: string,
): Promise<LintIgnoreEntry[]> {
  const entries = await invoke<LintIgnoreWireEntry[]>("lint_ignore_move", {
    payload: { projectId, fromSceneIds, toSceneId },
  });
  return entries.map(fromWire);
}
