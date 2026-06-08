import { setProseProposalHandler } from "@/features/concurrency/externalWriteFeed";
import { loadAllProposedProse } from "@/features/agent-writes/prose";
import { autoApplyProseProposal } from "@/features/agent-writes/autoApplyProse";
import {
  isAutoAcceptEnabled,
  isHeadlessAppliable,
} from "@/features/agent-writes/autoAcceptGate";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

/**
 * Headless auto-apply consumer for AI body proposals (A2 / Phase 1).
 *
 * Bridges incoming MCP/agent prose proposals to {@link autoApplyProseProposal}
 * — but ONLY when the user has opted in (`ai.autoAcceptBodyProposals`) AND the
 * project's `bodyWrite` policy is on. Off by default, so the human-in-the-loop
 * accept/reject contract is unchanged unless explicitly enabled.
 *
 * Two trigger paths share the same gate + apply logic:
 *  - live: the change-event poller calls the registered handler on each new
 *    `prose.propose` (see setProseProposalHandler in externalWriteFeed).
 *  - backlog: {@link drainProposedProse} sweeps rows that were proposed while
 *    the app was closed (the poller starts at the tail and never sees them).
 */

// Guards against the poller and the backlog drain racing on the same row.
const inFlight = new Set<string>();

/**
 * Apply one proposal. Returns true if the proposal was consumed (applied, or
 * already in flight) so the caller skips the human-review enqueue; false if it
 * should fall back to manual review (unsupported mode, file-backed, error).
 */
async function applyOne(proposal: PendingProseProposal): Promise<boolean> {
  if (!isHeadlessAppliable(proposal)) return false;
  if (inFlight.has(proposal.stagingId)) return true;
  inFlight.add(proposal.stagingId);
  try {
    const outcome = await autoApplyProseProposal(proposal);
    if (outcome.applied) return true;
    debugLog.info(
      "autoAcceptProse",
      `skipped ${proposal.stagingId} (${outcome.reason})`,
    );
    return false;
  } catch (e) {
    debugLog.error("autoAcceptProse", "auto-apply failed", errorDetail(e));
    return false;
  } finally {
    inFlight.delete(proposal.stagingId);
  }
}

let registered = false;

/** Register the live poller handler once (idempotent). */
export function setupAutoAcceptProseConsumer(): void {
  if (registered) return;
  registered = true;
  setProseProposalHandler(async (proposal, projectId) => {
    if (!(await isAutoAcceptEnabled(projectId))) return false;
    return applyOne(proposal);
  });
}

/** Sweep the proposed-prose backlog for a project (call on project open). */
export async function drainProposedProse(projectId: string): Promise<void> {
  if (!(await isAutoAcceptEnabled(projectId))) return;
  let proposals: PendingProseProposal[];
  try {
    proposals = await loadAllProposedProse(projectId);
  } catch (e) {
    debugLog.error("autoAcceptProse", "backlog load failed", errorDetail(e));
    return;
  }
  if (proposals.length === 0) return;
  let applied = 0;
  for (const proposal of proposals) {
    if (await applyOne(proposal)) applied += 1;
  }
  debugLog.info(
    "autoAcceptProse",
    `backlog drained: ${applied}/${proposals.length} applied`,
  );
}

/** Test hook: reset the one-time registration + in-flight guard. */
export function resetAutoAcceptProseConsumerForTest(): void {
  registered = false;
  inFlight.clear();
}
