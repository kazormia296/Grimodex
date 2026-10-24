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
 * This module is in the startup graph, so it holds no text: the strings are in
 * `profileEgressAiStopText.ts`, a part of the chat panel's lazy chunk. Until
 * that chunk has loaded, or for any other message, the answer is `null` and the
 * display keeps its own text (DR-DA2-30).
 */
const AI_STOP =
  /D2A_EGRESS_DENIED: (?:(?:profile-activation|legacy-request)-stopped(?![\w-])|old-(?:external|local)-ai: route \S+ (completed) after profile restriction began)/;

export function aiFailureText(message: string | null): string | null {
  const match = message === null ? null : AI_STOP.exec(message);
  if (!match) return null;
  const key = `profileEgressAiStop.${match[1] ? "discarded" : "stopped"}`;
  return i18next.exists(key) ? i18next.t(key) : null;
}
