import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useWorkspaceStore } from "@/features/workspace/store";
import { MarkdownDoc } from "@/features/settings/categories/about/MarkdownDoc";
import { EULA_VERSION } from "./constants";

export function EulaConsentDialog() {
  const { t } = useTranslation();
  const { globalSettings, updateGlobalSettings } = useWorkspaceStore();
  const [agreed, setAgreed] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);

  const needsConsent =
    globalSettings != null &&
    globalSettings.acceptedEulaVersion !== EULA_VERSION;

  const handleAccept = useCallback(async () => {
    if (!agreed || isAccepting) return;
    setIsAccepting(true);
    try {
      await updateGlobalSettings({ acceptedEulaVersion: EULA_VERSION });
    } catch (err) {
      toast.error(
        t("legal.eula.saveFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setIsAccepting(false);
    }
  }, [agreed, isAccepting, updateGlobalSettings, t]);

  if (!needsConsent) return null;

  return (
    <Dialog open modal>
      <DialogContent
        showClose={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="flex max-h-[90vh] max-w-2xl flex-col gap-3"
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{t("legal.eula.title")}</DialogTitle>
          <DialogDescription>
            {t("legal.eula.description", { version: EULA_VERSION })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded border border-border px-4 py-3">
          <MarkdownDoc src="TERMS_ja.md" />
          {showMessage && (
            <>
              <hr className="border-border" />
              <MarkdownDoc src="DEVELOPER_MESSAGE_ja.md" />
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowMessage((v) => !v)}
          className="flex-shrink-0 text-left text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {showMessage
            ? t("legal.eula.hideDeveloperMessage")
            : t("legal.eula.showDeveloperMessage")}
        </button>

        <label className="flex flex-shrink-0 cursor-pointer items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={agreed}
            onCheckedChange={(v) => setAgreed(v === true)}
          />
          <span>{t("legal.eula.agreeCheckbox")}</span>
        </label>

        <DialogFooter className="flex-shrink-0">
          <Button
            type="button"
            disabled={!agreed || isAccepting}
            onClick={() => void handleAccept()}
          >
            {isAccepting ? t("common.loading") : t("legal.eula.acceptButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
