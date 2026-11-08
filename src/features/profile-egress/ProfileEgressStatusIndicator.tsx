import { Suspense, lazy, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { ensureProfileEgressTranslations } from "./profileEgressTranslations";
import { useProfileEgressStatus } from "./useProfileEgressStatus";
import { useWritesRetryAfterActivation } from "./profileActivationWriteRetry";
import { closeProfileEgressEntrances } from "@/features/chat/closeProfileEgressEntrances";
import { NIR1_LOCAL_GENERATION_UI_ENABLED } from "@/features/chat/nir1/nir1LocalGenerationAvailability";
import { PROFILE_EGRESS_STATUS_POSITION } from "./profileEgressStatusPlacement";
import { ProfileEgressStatusBoundary } from "./ProfileEgressStatusBoundary";
import type { ProfileEgressStatusSnapshot } from "./useProfileEgressStatus";

ensureProfileEgressTranslations();

// DD-1c (DR-DD1C-2): the local generation disclosure is a lazy chunk requested
// only while the constant is on; while it is false the bundler drops the
// branch, this lazy import and the chunk from the startup graph. A chunk that
// fails to load draws nothing.
const Nir1LocalDisclosure = /* @__PURE__ */ lazy(() =>
  import("@/features/chat/nir1/Nir1LocalDisclosure").catch(() => ({
    default: () => null,
  })),
);

/**
 * The app-wide profile egress status (K3/2 "状態の表示", Positive (6); NIR-1
 * DA-2 ST3, DR-DA2-31). A lazy chunk: `ProfileEgressStatusSlot` requests it
 * only while `PROFILE_ACTIVATION_UI_ENABLED` is on.
 *
 * - restricted: always shown while the process is restricted.
 * - activating: shown from stage 2 until stage 6 or a failure.
 * - unavailable: the reason and the recovery step, from the closed code only.
 * - unrestricted, loading, unknown: nothing.
 *
 * It also starts the bounded retry of the generic DB writes refused during
 * the activation, once this renderer sees it complete (W-1, DR-DA2B-R8).
 *
 * It is also the only writer of the AI entrances' closure (DA-2b PUB-G 前の必須
 * 3・4, DR-DA2B-R22): a known state other than unrestricted closes them, the
 * same rule as the chat panel's probe. The state only moves forward, so the
 * closure is never reopened.
 */
export default function ProfileEgressStatusIndicator() {
  const snapshot = useProfileEgressStatus();
  const entrancesClosed =
    snapshot.kind === "known" && snapshot.view.state !== "unrestricted";
  // The closure effect comes before every other effect of this component
  // (DR-DA2-64): React runs a component's effects in one loop under one try, so
  // an effect that throws synchronously skips the ones declared after it. Keep
  // this the first effect; add new effects below it.
  useEffect(() => {
    if (entrancesClosed) closeProfileEgressEntrances();
  }, [entrancesClosed]);
  useWritesRetryAfterActivation(snapshot);
  // The rendering is a child under its own boundary (DR-DA2-64): an exception
  // of `t()` or the markup cannot stop this component's effects above, which
  // hold the closure and the write retry. This component renders nothing but
  // that boundary.
  return (
    <ProfileEgressStatusBoundary>
      <ProfileEgressStatusView snapshot={snapshot} />
    </ProfileEgressStatusBoundary>
  );
}

function ProfileEgressStatusView({
  snapshot,
}: {
  snapshot: ProfileEgressStatusSnapshot;
}) {
  const { t } = useTranslation();
  if (snapshot.kind !== "known") return null;
  const { view } = snapshot;
  if (view.state === "unrestricted") return null;
  if (view.state === "unavailable") {
    return (
      <div
        role="alert"
        data-testid="profile-egress-status"
        data-profile-egress-state="unavailable"
        data-profile-egress-reason={view.reason}
        style={PROFILE_EGRESS_STATUS_POSITION}
        className="pointer-events-none fixed z-[90] w-80 rounded-md border border-destructive/40 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
      >
        <p className="flex items-center gap-1.5 font-medium text-destructive">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("profileEgress.status.unavailableTitle")}
        </p>
        <p className="mt-1 break-words">
          {t(`profileEgress.reason.${view.reason}`)}
        </p>
        <p className="mt-1 break-words text-muted-foreground">
          {t("profileEgress.status.unavailableNote")}
        </p>
      </div>
    );
  }
  const restricted = view.state === "restricted";
  return (
    <div
      role="status"
      data-testid="profile-egress-status"
      data-profile-egress-state={view.state}
      title={
        restricted ? t("profileEgress.status.restrictedDetail") : undefined
      }
      style={PROFILE_EGRESS_STATUS_POSITION}
      className="pointer-events-auto fixed z-[90] flex items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-[11px] font-medium text-popover-foreground shadow"
    >
      {restricted ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      )}
      <span className="truncate">
        {t(
          restricted
            ? "profileEgress.status.restricted"
            : "profileEgress.status.activating",
        )}
      </span>
      {restricted && (
        <span className="sr-only">
          {t("profileEgress.status.restrictedDetail")}
        </span>
      )}
      {NIR1_LOCAL_GENERATION_UI_ENABLED && restricted && (
        <Suspense fallback={null}>
          <Nir1LocalDisclosure placement={5} />
        </Suspense>
      )}
    </div>
  );
}
