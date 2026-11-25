import { narrativeMaintenanceStaleProposalCount } from "@/application/narrative-extraction/nativeApi";
import { isJapaneseProjectLanguage } from "@/features/ime/language";
import {
  useCodexCandidateHostStore,
  selectCodexCandidateCount,
} from "@/features/codex/codexCandidateHostStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { isCodexStructureExtractionReviewEnabled } from "@/features/codex/codexStructureExtractionFlag";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { isNarrativeMaintenanceUiEnabled } from "@/features/narrative-extraction/maintenance/maintenanceFlags";
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
      // 件数だけを返す読み取り。保守 Inbox の全件を構築しない（件数に比例して重く、その間は共有の DB 接続を握る）。
      const count = await narrativeMaintenanceStaleProposalCount({ projectId });
      return { allowed: true, count };
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
