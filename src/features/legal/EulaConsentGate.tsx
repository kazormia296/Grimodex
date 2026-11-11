import { lazy, Suspense } from "react";

import { useWorkspaceStore } from "@/features/workspace/store";
import { EULA_VERSION } from "./constants";

const EulaConsentDialog = lazy(() =>
  import("./EulaConsentDialog").then((m) => ({
    default: m.EulaConsentDialog,
  })),
);

/**
 * 利用規約の同意が要るときだけ、同意ダイアログ（規約の Markdown の描画を含む）を読む。
 * 同意済みの起動では読まない。読み込みの間は画面全体を覆って操作を受け付けず、
 * 同意の前にアプリを触れる隙間を作らない。
 */
export function EulaConsentGate() {
  const needsConsent = useWorkspaceStore(
    (state) =>
      state.globalSettings != null &&
      state.globalSettings.acceptedEulaVersion !== EULA_VERSION,
  );
  if (!needsConsent) return null;
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          className="fixed inset-0 z-50"
          data-testid="eula-consent-loading"
        />
      }
    >
      <EulaConsentDialog />
    </Suspense>
  );
}
