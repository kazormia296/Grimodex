import { getProject } from "@/features/project/api";
import { isBodyWriteDisabled } from "@/features/ai-policy/parse";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

/**
 * Whether a proposal can be applied headlessly (no live editor): `append`
 * always; `insert` only when it carries a content anchor. `insert` without an
 * anchor and `replace` need a live cursor / doc range, so they stay in the diff
 * UI for manual review. Single source of truth for "auto-apply owns this" —
 * used both by the consumer and the diff-UI suppression so they never disagree.
 */
export function isHeadlessAppliable(
  proposal: Pick<PendingProseProposal, "mode" | "anchorText">,
): boolean {
  if (proposal.mode === "append") return true;
  if (proposal.mode === "insert" && !!proposal.anchorText) return true;
  return false;
}

/**
 * Headless body auto-apply gate: opt-in toggle (`ai.autoAcceptBodyProposals`,
 * project-scoped, default off) AND the project's `bodyWrite` policy must be on.
 *
 * Lightweight on purpose — it has NO dependency on the apply graph
 * (persistSceneBody / editor side-effects), so the inline-AI diff UI can import
 * it to decide whether to surface a proposal for manual review without pulling
 * in the whole headless writer.
 */
export async function isAutoAcceptEnabled(projectId: string): Promise<boolean> {
  if (
    !useSettingsStore.getState().getBoolean("ai.autoAcceptBodyProposals", false)
  ) {
    return false;
  }
  try {
    const project = await getProject(projectId);
    if (isBodyWriteDisabled(project?.aiPolicy)) return false;
  } catch (e) {
    debugLog.warn("autoAcceptProse", "policy read failed", errorDetail(e));
    return false;
  }
  return true;
}
