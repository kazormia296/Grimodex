import type { ContextItem, ContextPlan } from "@/features/ai-context/types";
import type {
  CodexContext,
  NoteContext,
  PinnedSnippetContext,
  PinnedStickyContext,
} from "../contextBuilder";

export type ChatContextPayload =
  | {
      kind: "codex";
      entry: CodexContext;
      includePinnedExtras: boolean;
    }
  | { kind: "note"; note: NoteContext }
  | { kind: "snippet"; snippet: PinnedSnippetContext }
  | { kind: "sticky"; sticky: PinnedStickyContext }
  | { kind: "map"; markdown: string };

export type ChatContextItemKind = ChatContextPayload["kind"];

export type ChatContextItem = ContextItem<
  ChatContextPayload,
  ChatContextItemKind
>;

export type ChatContextPlan = ContextPlan<
  ChatContextPayload,
  ChatContextItemKind
>;

/**
 * Only selected, full-body Spotlight items may short-circuit Agent fetches.
 * Source candidates are insufficient because the budget selector can remove
 * an atomic pin, and focus currently lives outside the typed L4 plan.
 */
export function fullyInjectedCodexIdsFromPlan(plan: ChatContextPlan): string[] {
  return plan.items.flatMap((item) => {
    if (item.payload.kind !== "codex") return [];
    const { entry, includePinnedExtras } = item.payload;
    return includePinnedExtras && Boolean(entry.fullContent?.trim())
      ? [entry.id]
      : [];
  });
}
