import type { AuthorshipAttributes } from "./AuthorshipMark";

/**
 * Build authorship mark attributes for AI-generated text landing in the body.
 *
 * Mirrors the inline shape used by `insertFromChat` (editorStore.ts) so that
 * placement paths that previously inserted AI prose *without* a mark
 * (Foreshadow adopt / typo fix) tag their text as `source='ai'`. Without this
 * the text inherits the AuthorshipMark default `source='human'` and is
 * mis-counted as human in `authorship_spans` / `loadBatchAiRatio`.
 *
 * Unset fields fall back to the AuthorshipMark defaults (timestamp/model/etc.
 * default to null). `originalLength` is intentionally omitted — `AiEditedPlugin`
 * does not consult it for its split-on-human-edit logic.
 */
export function aiAuthorshipAttrs(
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  } = {},
): Partial<AuthorshipAttributes> {
  return {
    source: "ai",
    timestamp: new Date().toISOString(),
    model: opts.model ?? null,
    chatMessageId: opts.chatMessageId ?? null,
    traceId: opts.traceId ?? null,
  };
}
