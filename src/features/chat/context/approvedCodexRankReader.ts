import type {
  Nir1EntityRelationApprovedCodexFilterResponse,
  readApprovedNir1EntityRelationCodexEntryIds,
} from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";
import {
  createApprovedCodexRanker,
  type ApprovedCodexRanker,
} from "./approvedCodexRank";

export async function readApprovedCodexEntryIds(
  expectedWorkspacePath: string | undefined,
  projectId: string,
  codexEntryIds: readonly string[],
  read?: typeof readApprovedNir1EntityRelationCodexEntryIds,
): Promise<ReadonlySet<string> | undefined> {
  if (!expectedWorkspacePath || codexEntryIds.length === 0) {
    return undefined;
  }
  try {
    // 読み口は動的に読む。静的 import にすると、旗が閉じた build でも
    // 依存が残り、起動時の chunk の preload の表が増える。
    const readFiltered =
      read ??
      (
        await import("@/features/narrative-semantic-core/nir1EntityRelationRevisionApi")
      ).readApprovedNir1EntityRelationCodexEntryIds;
    const result: Nir1EntityRelationApprovedCodexFilterResponse =
      await readFiltered({
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

/** 旗が開いた分岐だけから呼ぶ。失敗と承認済みが無いときは並べ替えなし。 */
export async function loadApprovedCodexRanker(
  expectedWorkspacePath: string | undefined,
  projectId: string,
  codexEntryIds: readonly string[],
): Promise<ApprovedCodexRanker | undefined> {
  const approved = await readApprovedCodexEntryIds(
    expectedWorkspacePath,
    projectId,
    codexEntryIds,
  );
  return approved?.size ? createApprovedCodexRanker(approved) : undefined;
}
