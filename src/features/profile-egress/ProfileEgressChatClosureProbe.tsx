import { useEffect } from "react";
import { ensureProfileEgressTranslations } from "./profileEgressTranslations";
import { useProfileEgressStatus } from "./useProfileEgressStatus";

ensureProfileEgressTranslations();

/**
 * Reports whether the profile egress state closes the chat panel's AI
 * entrances (K3/2 "D の扱い": restricted and the activation in progress;
 * unavailable too, whose AI routes stay closed). It draws nothing. The
 * defence is Main's gate and Native; this only lets the panel say so and skip
 * calls that cannot succeed (DR-DA2B-R6).
 *
 * A lazy chunk requested by the chat panel only while
 * `PROFILE_ACTIVATION_UI_ENABLED` is on (DR-DA2-30).
 */
export default function ProfileEgressChatClosureProbe({
  onChange,
}: {
  onChange: (closed: boolean) => void;
}) {
  const snapshot = useProfileEgressStatus();
  const closed =
    snapshot.kind === "known" && snapshot.view.state !== "unrestricted";
  useEffect(() => {
    onChange(closed);
  }, [closed, onChange]);
  return null;
}
