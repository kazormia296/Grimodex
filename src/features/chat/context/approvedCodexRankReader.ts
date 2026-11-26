import {
  readApprovedNir1EntityRelationCodexEntryIds,
  type Nir1EntityRelationApprovedCodexFilterResponse,
} from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";

export async function readApprovedCodexEntryIds(
  enabled: boolean,
  expectedWorkspacePath: string | undefined,
  projectId: string,
  codexEntryIds: readonly string[],
  read: typeof readApprovedNir1EntityRelationCodexEntryIds = readApprovedNir1EntityRelationCodexEntryIds,
): Promise<ReadonlySet<string> | undefined> {
  if (!enabled || !expectedWorkspacePath || codexEntryIds.length === 0) {
    return undefined;
  }
  try {
    const result: Nir1EntityRelationApprovedCodexFilterResponse = await read({
      expectedWorkspacePath,
      projectId,
      codexEntryIds: codexEntryIds.slice(0, 64),
    });
    return result.status === "available"
      ? new Set(result.approvedCodexEntryIds)
      : undefined;
  } catch {
    return undefined;
  }
}
