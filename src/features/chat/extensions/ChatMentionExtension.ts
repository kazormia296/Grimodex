import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { CodexEntry } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";

export interface MentionPopupState {
  items: CodexEntry[];
  selectedIndex: number;
  clientRect: (() => DOMRect | null) | null | undefined;
  command: ((entry: CodexEntry) => void) | null;
}

/**
 * @メンション補完拡張。
 * Mention ノード = 非編集可能インライントークン + entryId/name メタデータ。
 * suggestion.render からは状態 setter を経由してポップアップUIを制御する。
 */
export function createChatMentionExtension(
  setPopup: (state: MentionPopupState | null) => void,
) {
  return Mention.configure({
    HTMLAttributes: {
      class: "mention",
    },
    renderHTML({ options, node }) {
      return [
        "span",
        { ...options.HTMLAttributes, "data-entry-id": node.attrs.id },
        `${options.suggestion.char}${node.attrs.label ?? node.attrs.id}`,
      ];
    },
    suggestion: {
      char: "@",
      items({ query }: { query: string }) {
        const entries = useCodexStore.getState().entries;
        const q = query.toLowerCase();
        return entries.filter(
          (e) =>
            e.contextMode !== "hidden" &&
            (q === "" || e.name.toLowerCase().includes(q)),
        );
      },
      render() {
        return {
          onStart(props: SuggestionProps<CodexEntry>) {
            setPopup({
              items: props.items,
              selectedIndex: 0,
              clientRect: props.clientRect,
              command: (entry: CodexEntry) =>
                props.command({ id: entry.id, label: entry.name }),
            });
          },
          onUpdate(props: SuggestionProps<CodexEntry>) {
            setPopup({
              items: props.items,
              selectedIndex: 0,
              clientRect: props.clientRect,
              command: (entry: CodexEntry) =>
                props.command({ id: entry.id, label: entry.name }),
            });
          },
          onKeyDown({ event }: { event: KeyboardEvent }) {
            if (
              event.key === "ArrowDown" ||
              event.key === "ArrowUp" ||
              event.key === "Enter"
            ) {
              return true;
            }
            return false;
          },
          onExit() {
            setPopup(null);
          },
        };
      },
    },
  });
}
