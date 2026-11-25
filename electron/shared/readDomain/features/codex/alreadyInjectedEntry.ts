// The renderer's legacy handler (src/application/chat/chatAgentToolHandlers.ts) keeps the
// same wording as literals, to leave the startup graph unchanged. Its test compares both.
export const ALREADY_INJECTED_CODEX_ENTRY_SUMMARY =
  "Already injected (short-circuited)";

export function alreadyInjectedCodexEntryContent(id: string) {
  return {
    id,
    note: "This entry is already fully injected in the system prompt — refer to the 登場キャラクター・設定情報 section above (id, aliases, summary, custom details, full body are all there). Do not call get_codex_entry on this id again.",
  };
}
