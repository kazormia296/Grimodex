// `codexStore` は型だけを取り込み、実体は呼び手（起動時の graph にある hook）から受ける。この module は動的 import の
// chunk になり、ここで実体を取り込むと、起動時の graph の共有 chunk（editorSessionStore と
// externalEditConflictRegistry）が 2 つに割れて raw が 468 byte 増える（perf:budget の上限を超えた）。
import type { useCodexStore } from "@/features/codex/codexStore";
import { narrativeMaintenanceStaleProposalCount } from "@/application/narrative-extraction/nativeApi";
import { isJapaneseProjectLanguage } from "@/features/ime/language";
import {
  useCodexCandidateHostStore,
  selectCodexCandidateCount,
} from "@/features/codex/codexCandidateHostStore";
import { isCodexStructureExtractionReviewEnabled } from "@/features/codex/codexStructureExtractionFlag";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { isNarrativeMaintenanceUiEnabled } from "@/features/narrative-extraction/maintenance/maintenanceFlags";
import { getNarrativeRuntimePolicy } from "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi";
import type { WorkLayerLivePortDependencies } from "@/features/work-layer/types";

export function createWorkLayerLiveReaders(
  projectId: string,
  codexStore: typeof useCodexStore,
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
      return selectCodexCandidateCount(host, codexStore.getState().entries);
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
      const unsubscribeEntries = codexStore.subscribe((state, previous) => {
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
