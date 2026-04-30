import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { CodexEntry } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";

export type MentionRole = "mentioned" | "actor" | "target";

const MentionWithRole = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      role: {
        default: "mentioned" as MentionRole,
        parseHTML: (el: Element) =>
          (el.getAttribute("data-role") as MentionRole) ?? "mentioned",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-role": (attrs.role as MentionRole) ?? "mentioned",
        }),
      },
    };
  },
});

export interface CodexMentionPopupState {
  items: CodexEntry[];
  selectedIndex: number;
  clientRect: (() => DOMRect | null) | null | undefined;
  command: ((entry: CodexEntry, role?: MentionRole) => void) | null;
}

/**
 * @メンション補完拡張（Chat / SceneEditor / Beat 共通）。
 * Mention ノード = 非編集可能インライントークン + entryId/name メタデータ。
 * suggestion.render からは状態 setter を経由してポップアップ UI を制御する。
 *
 * Phase A は3か所すべてが同じ suggestion provider（Codex グローバル）を共有する。
 * provider のプラガブル化は Phase B 以降に分離。
 */
export function createCodexMentionExtension(
  setPopup: (state: CodexMentionPopupState | null) => void,
) {
  return MentionWithRole.configure({
    HTMLAttributes: {
      class: "mention",
    },
    renderHTML({ options, node }) {
      return [
        "span",
        {
          ...options.HTMLAttributes,
          "data-entry-id": node.attrs.id,
          "data-role": (node.attrs.role as MentionRole) ?? "mentioned",
        },
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
              command: (entry: CodexEntry, role: MentionRole = "mentioned") =>
                props.command({
                  id: entry.id,
                  label: entry.name,
                  role,
                }),
            });
          },
          onUpdate(props: SuggestionProps<CodexEntry>) {
            setPopup({
              items: props.items,
              selectedIndex: 0,
              clientRect: props.clientRect,
              command: (entry: CodexEntry, role: MentionRole = "mentioned") =>
                props.command({
                  id: entry.id,
                  label: entry.name,
                  role,
                }),
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
