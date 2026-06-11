import type { CodexDetailDefinition } from "./detailApi";

export function isDetailValueEmpty(_value: string | null): boolean {
  throw new Error("not implemented");
}

export async function listEmptyDetailFields(
  _projectId: string,
  _typeSlug: string,
): Promise<CodexDetailDefinition[]> {
  throw new Error("not implemented");
}

export interface DeleteEmptyFieldsResult {
  deleted: CodexDetailDefinition[];
  kept: number;
}

export async function deleteEmptyDetailFields(
  _projectId: string,
  _typeSlug: string,
): Promise<DeleteEmptyFieldsResult> {
  throw new Error("not implemented");
}
