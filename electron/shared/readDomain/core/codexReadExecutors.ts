import type { CoreCodexReadContext } from "../../mastraRead/ports.js";
import {
  findRelatedEntries,
  listCodexByType,
  searchCodex,
  searchCodexByTags,
} from "./codexTools.js";
import type { CoreReadExecutor } from "./toolResult.js";

/**
 * The Codex read tools that pass through the author's hidden marking, which the shared core implements
 * (Mastra migration MP-4b PR-8b, DR-MP4-40). A fourth table of names, with its own context type
 * (`CoreCodexReadContext`) and its own factory, not part of `CORE_READ_TOOL_NAMES` and
 * `createReadExecutors` (widening `CoreReadContext` would make every test that builds one grow), nor of the
 * chronicle tables. The four tables share no name; a caller that walks "every core tool" walks all four.
 */
export const CODEX_READ_TOOL_NAMES = [
  "search_codex",
  "list_codex_by_type",
  "search_codex_by_tags",
  "find_related_entries",
] as const;

export type CodexReadToolName = (typeof CODEX_READ_TOOL_NAMES)[number];

/**
 * Builds the executors over the ports of one caller. Making them reads nothing from the ports: every read
 * happens when a tool runs. Every executor throws `CoreProjectRequiredError` when the tree state has no
 * project, after it checked its arguments (the renderer answers it with `No active project`), and does not
 * catch a failure of the dense read.
 */
export function createCodexReadExecutors(
  ctx: CoreCodexReadContext,
): Readonly<Record<CodexReadToolName, CoreReadExecutor>> {
  return Object.freeze({
    search_codex: (params) => searchCodex(ctx, params),
    list_codex_by_type: (params) => listCodexByType(ctx, params),
    search_codex_by_tags: (params) => searchCodexByTags(ctx, params),
    find_related_entries: (params) => findRelatedEntries(ctx, params),
  });
}
