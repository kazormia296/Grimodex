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

interface QueryResult {
  rows: Record<string, unknown>[];
}

async function execute<T = unknown>(
  sql: string,
  params: unknown[],
  method: "run" | "all",
): Promise<T> {
  const result = await invoke<QueryResult>("db_execute", {
    sql,
    params,
    method,
  });
  return result as unknown as T;
}

function parseRow(row: Record<string, unknown>): PersistedTermDictionaryRow {
  const variantsRaw = String(row.variants ?? "[]");
  let variants: string[] = [];
  try {
    const parsed = JSON.parse(variantsRaw);
    if (Array.isArray(parsed)) {
      variants = parsed.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    }
  } catch {
    // A corrupt row contributes no matcher variants but does not block loading
    // the rest of the project dictionary.
  }

  return {
    id: String(row.id),
    preferred: String(row.preferred),
    variants,
    severity: String(row.severity) === "info" ? "info" : "warning",
    note: row.note === null || row.note === undefined ? null : String(row.note),
    enabled: Number(row.enabled ?? 1) === 1,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export async function listTermDictionaryEntries(
  projectId: string,
): Promise<PersistedTermDictionaryRow[]> {
  const result = await execute<QueryResult>(
    `SELECT id, preferred, variants, severity, note, enabled, sort_order, created_at, updated_at
       FROM lint_term_dictionary
       WHERE project_id = ?
       ORDER BY sort_order ASC, preferred ASC`,
    [projectId],
    "all",
  );
  return result.rows.map(parseRow);
}

export async function insertTermDictionaryEntry(
  projectId: string,
  entry: TermDictionaryEntryWrite,
): Promise<void> {
  await execute(
    `INSERT INTO lint_term_dictionary
       (id, project_id, preferred, variants, severity, note, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      projectId,
      entry.preferred,
      JSON.stringify(entry.variants),
      entry.severity,
      entry.note,
      entry.enabled ? 1 : 0,
      entry.sortOrder,
      entry.createdAt,
      entry.updatedAt,
    ],
    "run",
  );
}

export async function updateTermDictionaryEntry(
  entry: Omit<TermDictionaryEntryWrite, "sortOrder" | "createdAt">,
): Promise<void> {
  await execute(
    `UPDATE lint_term_dictionary
       SET preferred = ?, variants = ?, severity = ?, note = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [
      entry.preferred,
      JSON.stringify(entry.variants),
      entry.severity,
      entry.note,
      entry.enabled ? 1 : 0,
      entry.updatedAt,
      entry.id,
    ],
    "run",
  );
}

export async function setTermDictionaryEntryEnabled(
  id: string,
  enabled: boolean,
  updatedAt: number,
): Promise<void> {
  await execute(
    `UPDATE lint_term_dictionary SET enabled = ?, updated_at = ? WHERE id = ?`,
    [enabled ? 1 : 0, updatedAt, id],
    "run",
  );
}

export async function deleteTermDictionaryEntry(id: string): Promise<void> {
  await execute(`DELETE FROM lint_term_dictionary WHERE id = ?`, [id], "run");
}
