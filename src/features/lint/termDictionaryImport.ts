/**
 * 用語辞書 CSV インポートの「取込計画」を立てる純粋ロジック。
 *
 * DB / store には依存せず、既存行と取込エントリから DELETE / UPDATE / INSERT の
 * 操作列と結果サマリを算出する。variant は辞書全体で一意（`validateEntry` の
 * cross-entry uniqueness と同じ不変条件）でなければならないため、衝突する
 * variant は「先勝ち」で落とし、全 variant が落ちたエントリはスキップする。
 *
 * 前提: `entries` は preferred がユニーク（`parseTermDictionaryCsv` が
 * preferred でグループ化済みのため保証される）。
 */

import type { ParsedTermEntry, TermSeverity } from "./termDictionaryCsv";

export type ImportMode = "merge" | "replace";

/** 計画立案に必要な既存行の最小形。TermDictionaryRow が構造的に代入可能。 */
export interface PlannerRow {
  id: string;
  preferred: string;
  variants: string[];
  severity: TermSeverity;
  note: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface PlannedUpdate {
  id: string;
  preferred: string;
  variants: string[];
  severity: TermSeverity;
  note: string | null;
  enabled: boolean;
}

export interface PlannedInsert {
  preferred: string;
  variants: string[];
  severity: TermSeverity;
  note: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface SkippedEntry {
  preferred: string;
  reason: string;
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: SkippedEntry[];
}

export interface ImportPlan {
  deletes: string[];
  updates: PlannedUpdate[];
  inserts: PlannedInsert[];
  result: ImportResult;
}

const DUP_OTHER = "variant がすべて他エントリと重複するためスキップ";

export function planBulkImport(
  existing: PlannerRow[],
  entries: ParsedTermEntry[],
  mode: ImportMode,
): ImportPlan {
  const deletes: string[] = [];
  const updates: PlannedUpdate[] = [];
  const inserts: PlannedInsert[] = [];
  const result: ImportResult = { added: 0, updated: 0, skipped: [] };

  // variant → 所有 preferred。辞書全体の一意性を保つ台帳。
  const claimed = new Map<string, string>();

  if (mode === "replace") {
    for (const r of existing) deletes.push(r.id);
    let sortOrder = 0;
    for (const e of entries) {
      const vs = e.variants.filter((v) => !claimed.has(v));
      if (vs.length === 0) {
        result.skipped.push({ preferred: e.preferred, reason: DUP_OTHER });
        continue;
      }
      for (const v of vs) claimed.set(v, e.preferred);
      inserts.push({
        preferred: e.preferred,
        variants: vs,
        severity: e.severity,
        note: e.note,
        enabled: e.enabled,
        sortOrder,
      });
      sortOrder++;
      result.added++;
    }
    return { deletes, updates, inserts, result };
  }

  // --- merge ---
  const byPreferred = new Map<string, PlannerRow>();
  for (const r of existing) {
    const clone: PlannerRow = { ...r, variants: [...r.variants] };
    byPreferred.set(r.preferred, clone);
    for (const v of r.variants) claimed.set(v, r.preferred);
  }
  let sortOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;

  for (const e of entries) {
    const target = byPreferred.get(e.preferred);
    if (target) {
      // 既存 preferred は CSV の内容で上書き更新。自分の旧 variant は
      // 一旦台帳から外してから衝突判定する（自己衝突を誤検出しない）。
      for (const v of target.variants) {
        if (claimed.get(v) === target.preferred) claimed.delete(v);
      }
      const vs = e.variants.filter((v) => !claimed.has(v));
      if (vs.length === 0) {
        // 旧 variant の claim を戻して据え置き（無変更）扱い。
        for (const v of target.variants) claimed.set(v, target.preferred);
        result.skipped.push({
          preferred: e.preferred,
          reason: DUP_OTHER,
        });
        continue;
      }
      for (const v of vs) claimed.set(v, e.preferred);
      target.variants = vs;
      updates.push({
        id: target.id,
        preferred: e.preferred,
        variants: vs,
        severity: e.severity,
        note: e.note,
        enabled: e.enabled,
      });
      result.updated++;
    } else {
      const vs = e.variants.filter((v) => !claimed.has(v));
      if (vs.length === 0) {
        result.skipped.push({ preferred: e.preferred, reason: DUP_OTHER });
        continue;
      }
      for (const v of vs) claimed.set(v, e.preferred);
      inserts.push({
        preferred: e.preferred,
        variants: vs,
        severity: e.severity,
        note: e.note,
        enabled: e.enabled,
        sortOrder,
      });
      sortOrder++;
      result.added++;
    }
  }
  return { deletes, updates, inserts, result };
}
