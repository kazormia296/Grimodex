import { invoke } from "@/lib/tauri";

import type { Severity } from "./types";

export interface PersistedTermDictionaryRow {
  id: string;
  preferred: string;
  variants: string[];
  severity: Extract<Severity, "warning" | "info">;
  note: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface TermDictionaryEntryWrite {
  id: string;
  preferred: string;
  variants: readonly string[];
  severity: Extract<Severity, "warning" | "info">;
  note: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export async function listTermDictionaryEntries(
  projectId: string,
): Promise<PersistedTermDictionaryRow[]> {
  return invoke<PersistedTermDictionaryRow[]>("lint_term_dictionary_list", {
    projectId,
  });
}

export async function insertTermDictionaryEntry(
  projectId: string,
  entry: TermDictionaryEntryWrite,
): Promise<void> {
  await invoke("lint_term_dictionary_insert", {
    payload: {
      ...entry,
      projectId,
      variants: [...entry.variants],
    },
  });
}

export async function updateTermDictionaryEntry(
  projectId: string,
  entry: Omit<TermDictionaryEntryWrite, "sortOrder" | "createdAt">,
): Promise<void> {
  await invoke("lint_term_dictionary_update", {
    payload: {
      ...entry,
      projectId,
      variants: [...entry.variants],
    },
  });
}

export async function setTermDictionaryEntryEnabled(
  projectId: string,
  id: string,
  enabled: boolean,
  updatedAt: number,
): Promise<void> {
  await invoke("lint_term_dictionary_set_enabled", {
    projectId,
    id,
    enabled,
    updatedAt,
  });
}

export async function deleteTermDictionaryEntry(
  projectId: string,
  id: string,
): Promise<void> {
  await invoke("lint_term_dictionary_delete", { projectId, id });
}
