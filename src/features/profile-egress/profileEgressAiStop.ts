import i18next from "@/lib/i18n";

/**
 * The text of an AI failure that is one of the profile activation's AI
 * terminals (K3/2 "activation の途中の AI 処理" 1; NIR-1 DA-2 D-10 (a),
 * DR-DA2-34), for the existing failure displays (the chat store's toasts, the
 * chat panel, the inline AI toolbar). The terminal arrives through the existing
 * terminal path (the stream's error event or the invoke's rejection) with a
 * closed code only:
 *
 * - `stopped`: Main's synthesized stream / Codex terminal at stage 2
 *   (`D2A_EGRESS_DENIED: profile-activation-stopped`) or Native's
 *   cancellation of a non-stream legacy request at stage 5
 *   (`D2A_EGRESS_DENIED: legacy-request-stopped…`).
 * - `discarded`: Main refused a legacy AI result completed after stage 2
 *   (`D2A_EGRESS_DENIED: old-external-ai: route <cmd> completed after profile
 *   restriction began`, or `old-local-ai`).
 *
 * The match is anchored, so a provider error that merely contains a marker
 * keeps its own text. Main's synthesized terminal must equal its fixed text,
 * as the audit's `profileActivationStopAuditMetadata` requires
 * (`ai-audit/transportContext.ts`). The other two may carry only the
 * `Error: ` that a stringified error adds; after Native's
 * `legacy-request-stopped` only its own `: ` detail may follow, and Main's
 * completion refusal must end where Main's text ends.
 *
 * This module is in the startup graph, so it holds no text: the strings are in
 * `profileEgressAiStopText.ts`, a part of the chat panel's lazy chunk. Until
 * that chunk has loaded the answer is `null` and the display keeps its own
 * text (DR-DA2-30). Any other refusal of the gate (an anchored marker) answers
 * the startup locale's generic `common.error`; any other message answers
 * `null`.
 */
const AI_STOP =
  /^(?:D2A_EGRESS_DENIED: profile-activation-stopped$|(?:Error: )?D2A_EGRESS_DENIED: (?:legacy-request-stopped(?:: |$)|old-(?:external|local)-ai: route \S+ (completed) after profile restriction began$))/;

const D2A_REFUSAL =
  /^(?:Error: )?(?:\w+ rejected: )?D2A_EGRESS_DENIED: [a-z0-9-]+(?::|$)/;

export function aiFailureText(message: string | null): string | null {
  const match = AI_STOP.exec(message ?? "");
  // Any other refusal of the gate (the AI routes are closed while restricted)
  // shows the generic error text, never the raw marker nor a provider's or
  // Ollama's reason (Negative (11); DR-DA2B-R5). Anchored like `AI_STOP`, so a
  // provider text that merely contains a marker keeps its own text (S4).
  if (!match) {
    return D2A_REFUSAL.test(message ?? "") ? i18next.t("common.error") : null;
  }
  const key = `profileEgressAiStop.${match[1] ? "discarded" : "stopped"}`;
  return i18next.exists(key) ? i18next.t(key) : null;
}
