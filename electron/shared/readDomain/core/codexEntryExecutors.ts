import type { CoreCodexEntryContext } from "../../mastraRead/ports.js";
import { getCodexEntry } from "./codexEntryTools.js";
import type { CoreReadExecutor } from "./toolResult.js";

/** `get_codex_entry` 専用の5つ目の名前表。 */
export const CODEX_ENTRY_TOOL_NAMES = ["get_codex_entry"] as const;

export type CodexEntryToolName = (typeof CODEX_ENTRY_TOOL_NAMES)[number];

export function createCodexEntryExecutors(
  ctx: CoreCodexEntryContext,
): Readonly<Record<CodexEntryToolName, CoreReadExecutor>> {
  return Object.freeze({
    get_codex_entry: (params) => getCodexEntry(ctx, params),
  });
}
