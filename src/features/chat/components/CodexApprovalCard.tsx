import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexAppEvent } from "@/../electron/shared/codexAppProtocol";
import { Button } from "@/components/ui/button";

type ApprovalEvent = Extract<CodexAppEvent, { type: "approval-requested" }>;

interface CodexApprovalCardProps {
  request: ApprovalEvent;
  onDecision: (decision: "accept" | "decline") => Promise<void>;
}

/** A bounded, explicit confirmation surface for an App Server write request. */
export function CodexApprovalCard({
  request,
  onDecision,
}: CodexApprovalCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "accept" | "decline") => {
    if (busy) return;
    setBusy(true);
    try {
      await onDecision(decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mb-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
      data-testid="codex-approval-card"
      aria-label={t("chat.codexApprovalTitle")}
    >
      <div className="font-medium text-foreground">
        {request.title || t("chat.codexApprovalTitle")}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {request.kind} · {request.summary}
      </div>
      {request.command && request.command.length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs font-mono">
          {request.command.join(" ")}
        </pre>
      )}
      {request.affectedPaths && request.affectedPaths.length > 0 && (
        <div className="mt-2 rounded bg-muted p-2 text-xs">
          {request.affectedPaths.map((path) => (
            <div key={path} className="break-all font-mono">
              {path}
            </div>
          ))}
        </div>
      )}
      {request.diff && (
        <details className="mt-2 rounded bg-muted p-2 text-xs" open>
          <summary className="cursor-pointer font-medium">
            {t("chat.codexApprovalDiff")}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono">
            {request.diff}
          </pre>
        </details>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void decide("decline")}
        >
          {t("chat.codexApprovalDecline")}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={busy}
          onClick={() => void decide("accept")}
        >
          {t("chat.codexApprovalAccept")}
        </Button>
      </div>
    </section>
  );
}
