import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ensureProfileEgressTranslations } from "./profileEgressTranslations";
import { useProfileActivationRequest } from "./useProfileActivationRequest";
import {
  useProfileEgressStatus,
  type ProfileEgressStatusSnapshot,
} from "./useProfileEgressStatus";

ensureProfileEgressTranslations();

function stateKey(snapshot: ProfileEgressStatusSnapshot): string {
  if (snapshot.kind !== "known") return snapshot.kind;
  return snapshot.view.state;
}

/**
 * The settings item of the activation request (K3/2 T-1; NIR-1 DA-2 ST3,
 * DR-DA2-32). A lazy chunk requested from the Data category only while
 * `PROFILE_ACTIVATION_UI_ENABLED` is on.
 *
 * The button is offered only while the process is unrestricted. Clicking it
 * asks Main; the confirmation (Native's text, cancel by default, the
 * checkbox) is Main's dialog, not this component.
 */
export default function ProfileActivationSettingsSection(): ReactElement | null {
  const { t } = useTranslation();
  const snapshot = useProfileEgressStatus();
  const { pending, lastStatus, request } = useProfileActivationRequest();
  const view = snapshot.kind === "known" ? snapshot.view : null;
  const canRequest = view?.state === "unrestricted";
  return (
    <div className="mb-6" data-testid="profile-activation-settings">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("profileEgress.settings.title")}
      </h3>
      <div className="space-y-2 text-xs">
        <p className="text-muted-foreground">
          {t("profileEgress.settings.description")}
        </p>
        <p>
          <span className="text-muted-foreground">
            {t("profileEgress.settings.stateLabel")}:{" "}
          </span>
          <span
            data-testid="profile-activation-settings-state"
            data-profile-egress-state={stateKey(snapshot)}
          >
            {t(`profileEgress.settings.state.${stateKey(snapshot)}`)}
          </span>
        </p>
        {view?.state === "unavailable" && (
          <p role="alert" className="break-words text-destructive">
            {t(`profileEgress.reason.${view.reason}`)}
          </p>
        )}
        {canRequest && (
          <button
            type="button"
            data-testid="profile-activation-request"
            disabled={pending}
            onClick={request}
            className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
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
            role="status"
            data-testid="profile-activation-result"
            data-profile-activation-status={lastStatus}
            className="break-words text-muted-foreground"
          >
            {t(`profileEgress.result.${lastStatus}`)}
          </p>
        )}
      </div>
    </div>
  );
}
