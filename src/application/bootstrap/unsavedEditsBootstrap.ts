import { useEffect } from "react";
import { toast } from "sonner";

import { subscribeAutoSaveUnsavedState } from "@/hooks/useAutoSave";
import i18next from "@/lib/i18n";
import {
  createUnsavedEditsReporter,
  onUnsavedEditsRetained,
} from "@/lib/unsavedEditsGuard";

/**
 * PUB-G #36 (DR-PUBG-36-1): tell Main whether unsaved edits exist (it reads
 * the flag only before a fatal exit) and show a sticky notice if the author
 * chose to go back instead of exiting. Nothing is stored or moved.
 *
 * Mounted once by `ApplicationBootstrapHost`; kept out of the Host so the
 * lifecycle Host stays within its architecture line budget.
 */
export function useUnsavedEditsBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeAutoSaveUnsavedState(
      createUnsavedEditsReporter(),
    );
    const unlisten = onUnsavedEditsRetained(() => {
      toast.error(i18next.t("unsavedEditsGuard.retained"), {
        id: "unsaved-edits-retained",
        duration: Infinity,
      });
    });
    return () => {
      unsubscribe();
      unlisten();
    };
  }, []);
}
