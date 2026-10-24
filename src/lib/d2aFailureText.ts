import { debugLog, errorDetail, rootCause } from "./debugLog";
import { isD2aEgressDenied } from "./tauri";

/**
 * The text a failure display shows for `error`: `text` (the display's own
 * text, unchanged) unless `error` is a D2a refusal, which shows `rootCause`'s
 * generic text instead. It never shows the raw marker and route, nor the
 * statement and params of a refused query that Drizzle wraps, nor a reason
 * that blames a connection, a CLI or a license server for the gate's refusal
 * (K3/2 "D の扱い", Negative (11); DR-DA2B-R5). The refusal and its reason
 * code go to the debug log (`errorDetail` redacts the params) instead.
 *
 * Only the lazy displays import this module (settings, export, Vivliostyle,
 * kouetsu, Map, Codex, matrix, the chat panel), so it stays out of the startup
 * graph (DR-DA2-30).
 */
export function d2aFailureText(error: unknown, text: string): string {
  if (!isD2aEgressDenied(error)) return text;
  debugLog.warn("D2a", "refusal shown as the generic text", errorDetail(error));
  return rootCause(error);
}

/**
 * `d2aFailureText` for a message a store kept instead of the error (shown on
 * every render, so it logs nothing): a D2a refusal shows the generic text.
 */
export function d2aMessageText(message: string): string {
  return isD2aEgressDenied(message) ? rootCause(message) : message;
}
