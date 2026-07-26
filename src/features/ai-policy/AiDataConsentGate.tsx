import { useSyncExternalStore } from "react";
import { AiDataConsentDialog } from "./AiDataConsentDialog";
import {
  acceptActiveAiDataConsent,
  declineActiveAiDataConsent,
  getActiveAiDataConsentRequest,
  subscribeAiDataConsent,
} from "./aiDataConsentBroker";

export function AiDataConsentGate() {
  const request = useSyncExternalStore(
    subscribeAiDataConsent,
    getActiveAiDataConsentRequest,
    () => null,
  );

  if (!request) return null;
  return (
    <AiDataConsentDialog
      open
      disclosure={request.disclosure}
      onAccept={acceptActiveAiDataConsent}
      onDecline={declineActiveAiDataConsent}
    />
  );
}
