import { narrativeMaintenanceInboxList } from "@/application/narrative-extraction/nativeApi";
import { isJapaneseProjectLanguage } from "@/features/ime/language";
import {
  useCodexCandidateHostStore,
  selectCodexCandidateCount,
} from "@/features/codex/codexCandidateHostStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { isCodexStructureExtractionReviewEnabled } from "@/features/codex/codexStructureExtractionFlag";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { isNarrativeMaintenanceUiEnabled } from "@/features/narrative-extraction/maintenance/maintenanceFlags";
import { summarizeInbox } from "@/features/narrative-extraction/maintenance-ui/structureHealthModel";
import { getNarrativeRuntimePolicy } from "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi";
import type { WorkLayerLivePortDependencies } from "@/features/work-layer/types";

export function createWorkLayerLiveReaders(
  projectId: string,
): WorkLayerLivePortDependencies {
  useCodexCandidateHostStore.getState().syncProject(projectId);

  return {
    projectId,
    async readStaleProposalCount() {
      const policy = await getNarrativeRuntimePolicy();
      if (!isNarrativeMaintenanceUiEnabled(policy)) return { allowed: false };
      const inbox = await narrativeMaintenanceInboxList({ projectId });
      return { allowed: true, count: summarizeInbox(inbox).proposalsStale };
    },
    readCandidateCount() {
      const host = useCodexCandidateHostStore.getState();
      if (host.projectId !== projectId) return { status: "not-counted" };
      return selectCodexCandidateCount(host, useCodexStore.getState().entries);
    },
    ensureCandidateScan() {
      return useCodexCandidateHostStore.getState().requestScan();
    },
    subscribeCandidateCount(listener) {
      const unsubscribeHost = useCodexCandidateHostStore.subscribe(
        (state, previous) => {
          if (
            state.projectId !== previous.projectId ||
            state.scan !== previous.scan ||
            state.dismissed !== previous.dismissed ||
            state.dismissedLoaded !== previous.dismissedLoaded
          ) {
            listener();
          }
        },
      );
      const unsubscribeEntries = useCodexStore.subscribe((state, previous) => {
        if (state.entries !== previous.entries) listener();
      });
      return () => {
        unsubscribeHost();
        unsubscribeEntries();
      };
    },
    isCandidateExtractionApplicable() {
      return isJapaneseProjectLanguage(getCurrentProjectLanguage());
    },
    structureReviewAvailable() {
      return isCodexStructureExtractionReviewEnabled();
    },
    openStructureReview() {
      useCodexCandidateHostStore.getState().openStructureReview();
    },
  };
}
