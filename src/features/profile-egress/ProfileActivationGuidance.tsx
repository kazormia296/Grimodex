import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ensureProfileEgressTranslations } from "./profileEgressTranslations";
import { useProfileActivationRequest } from "./useProfileActivationRequest";

ensureProfileEgressTranslations();

/**
 * The `profile-not-restricted` guidance of Related Scenes (K3/2 T-1; NIR-1
 * DA-2 ST3, DR-DA2-33). A lazy chunk requested from the Graph view only while
 * both `NIR1_GRAPH_UI_ENABLED` and `PROFILE_ACTIVATION_UI_ENABLED` are on and
 * Native answered `profile-not-restricted`. It makes the same request as the
 * settings item; Main shows the confirmation.
 */
export default function ProfileActivationGuidance(): ReactElement | null {
  const { t } = useTranslation();
  const { pending, lastStatus, request } = useProfileActivationRequest();
  return (
    <div
      role="status"
      data-testid="profile-activation-guidance"
      className="space-y-1.5 px-3 py-2 text-[11px] text-muted-foreground"
    >
      <p>{t("profileEgress.guidance.graphNeedsRestriction")}</p>
      {lastStatus !== "activated" && (
        <button
          type="button"
          data-testid="profile-activation-request"
          disabled={pending}
          onClick={request}
          className="rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t(
            pending
              ? "profileEgress.settings.requesting"
              : "profileEgress.settings.request",
          )}
        </button>
      )}
      {lastStatus && !pending && (
        <p
          data-testid="profile-activation-result"
          data-profile-activation-status={lastStatus}
          className="break-words"
        >
          {t(`profileEgress.result.${lastStatus}`)}
        </p>
      )}
    </div>
  );
}
