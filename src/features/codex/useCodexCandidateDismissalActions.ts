import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useCodexCandidateHostStore } from "./codexCandidateHostStore";
import { candidateKey } from "./codexCandidates";

export function useCodexCandidateDismissalActions() {
  const { t } = useTranslation();
  const mutateDismissed = useCodexCandidateHostStore((s) => s.mutateDismissed);

  const handleDismiss = useCallback(
    (surface: string) => {
      const prev = useCodexCandidateHostStore.getState().dismissed;
      const next = new Set(prev);
      next.add(candidateKey(surface));
      mutateDismissed(next, prev, t("codex.candidates.historyDismiss"), () =>
        t("codex.candidates.dismissFailed"),
      );
    },
    [mutateDismissed, t],
  );

  const handleRestoreDismissedKeys = useCallback(
    (keys: readonly string[]) => {
      const prev = useCodexCandidateHostStore.getState().dismissed;
      const next = new Set(prev);
      for (const key of keys) next.delete(key);
      if (next.size === prev.size) return;
      mutateDismissed(next, prev, t("codex.candidates.historyRestore"), () =>
        t("codex.candidates.dismissFailed"),
      );
    },
    [mutateDismissed, t],
  );

  const handleRestoreAll = useCallback(() => {
    mutateDismissed(
      new Set(),
      useCodexCandidateHostStore.getState().dismissed,
      t("codex.candidates.historyRestore"),
      () => t("codex.candidates.dismissFailed"),
    );
  }, [mutateDismissed, t]);

  return { handleDismiss, handleRestoreDismissedKeys, handleRestoreAll };
}
