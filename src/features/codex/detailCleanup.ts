import type { CodexDetailDefinition } from "./detailApi";
import {
  listDefinitionsByType,
  listValuesByDefinitionIds,
  deleteDefinition,
} from "./detailApi";
import { extractPlainText } from "./prosemirrorTextExtractor";

/**
 * デティール値が「未入力」かを判定する。
 * text フィールドは PM JSON で保存されるため、parse できた object は
 * テキスト抽出で空判定する。parse できない生文字列（dropdown の選択値・
 * codex_reference の ID）は trim 非空なら入力済みとして必ず残す —
 * extractPlainText は invalid JSON に "" を返すので直接は使えない。
 */
export function isDetailValueEmpty(value: string | null): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  return extractPlainText(trimmed) === "";
}

async function partitionEmptyDefinitions(
  projectId: string,
  typeSlug: string,
): Promise<{ empty: CodexDetailDefinition[]; total: number }> {
  const definitions = await listDefinitionsByType(projectId, typeSlug);
  if (definitions.length === 0) return { empty: [], total: 0 };
  const values = await listValuesByDefinitionIds(definitions.map((d) => d.id));
  const usedIds = new Set(
    values
      .filter((v) => !isDetailValueEmpty(v.value))
      .map((v) => v.definitionId),
  );
  return {
    empty: definitions.filter((d) => !usedIds.has(d.id)),
    total: definitions.length,
  };
}

/** 値が1件も入っていないフィールド定義を列挙する（確認ダイアログ用） */
export async function listEmptyDetailFields(
  projectId: string,
  typeSlug: string,
): Promise<CodexDetailDefinition[]> {
  return (await partitionEmptyDefinitions(projectId, typeSlug)).empty;
}

export interface DeleteEmptyFieldsResult {
  deleted: CodexDetailDefinition[];
  kept: number;
}

/**
 * 未入力のフィールド定義を一括削除する。確認後の実行時に再計算するため
 * 確認表示との間に入力があったフィールドは削除されない。
 */
export async function deleteEmptyDetailFields(
  projectId: string,
  typeSlug: string,
): Promise<DeleteEmptyFieldsResult> {
  const { empty, total } = await partitionEmptyDefinitions(projectId, typeSlug);
  for (const definition of empty) {
    await deleteDefinition(definition.id);
  }
  return { deleted: empty, kept: total - empty.length };
}
