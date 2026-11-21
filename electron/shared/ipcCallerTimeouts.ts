/**
 * The caller-side IPC timeouts that renderer (`src/lib/tauri.ts`) and Electron
 * main's own reads share (Mastra migration MP-4b, DR-MP4-4).
 *
 * This module is a leaf: it imports nothing, so the renderer takes it without
 * widening its module graph, and no table of commands is shared. Only the two
 * values that already exist in `tauri.ts` and the four commands main's read
 * port calls are here. The values are unchanged from `tauri.ts`; adding a new
 * value is a threshold change and needs the user's confirmation.
 *
 * A caller timeout never stops Native: the call keeps its slot and runs to its
 * own end. The caller only gives up waiting.
 */

/** The default caller timeout of a verified read-only command (10 seconds). */
export const IPC_TIMEOUT_MS = 10_000;

/** AI inference can take several minutes on local hardware (Ollama etc.). */
export const AI_IPC_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * The four commands main's read port calls with a caller timeout, copied from
 * the renderer's table (a copy, not an equivalence: the renderer's
 * `db_execute` timeout applies only to a statement its own check classifies as
 * read-only and a statement outside that check waits without a timeout, whereas
 * main sends only statements its own SELECT check let through and always cuts
 * them at this value).
 *
 * `foreshadow_list_open_for_context` is not here: the renderer gives it no
 * caller timeout either, and no new value is placed for it.
 */
export const MAIN_READ_CALLER_TIMEOUT_MS = Object.freeze({
  db_execute: IPC_TIMEOUT_MS,
  fts_search: IPC_TIMEOUT_MS,
  codex_semantic_search: AI_IPC_TIMEOUT_MS,
  events_semantic_search: AI_IPC_TIMEOUT_MS,
} as const);

export type MainReadTimedCommand = keyof typeof MAIN_READ_CALLER_TIMEOUT_MS;
