import Mention from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CodexEntry } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";

export type MentionRole = "mentioned" | "actor" | "target";
export type MentionKind = "codex" | "scene";

/**
 * Suggestion popup 用のアイテム。codex エントリと scene を同じ `@` トリガで
 * 1 つのリストに混在させるための discriminated union。
 *
 * `kind: "codex"` は従来通り CodexEntry を `source` に保持し、role chip
 * （actor/target）が利く。`kind: "scene"` は tree から組み立てた
 * 軽量メタで、role の概念は持たない（chat 送信時の一時 pin 専用）。
 */
export type MentionItem =
  | {
      kind: "codex";
      id: string;
      name: string;
      typeLabel: string;
      summary?: string;
      source: CodexEntry;
    }
  | {
      kind: "scene";
      id: string;
      name: string;
      typeLabel: string;
      summary?: string;
    };

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
      kind: {
        default: "codex" as MentionKind,
        parseHTML: (el: Element) =>
          (el.getAttribute("data-kind") as MentionKind) ?? "codex",
        renderHTML: (attrs: Record<string, unknown>) => {
          const kind = (attrs.kind as MentionKind) ?? "codex";
          // codex は default なので属性を吐かない（既存 DOM/HTML との互換維持）。
          return kind === "codex" ? {} : { "data-kind": kind };
        },
      },
    };
  },

  /**
   * Live NodeView (Item A): the displayed name resolves from the entry id via
   * the codex store at render time, so renaming a Codex entry updates every
   * `@mention` of it in the open editor WITHOUT mutating the document (the
   * baked `label` attr stays put — it is only a fallback for deleted entries
   * and for HTML serialization via `renderHTML`).
   *
   * Plain ProseMirror NodeView (mirrors `RubyNode`): ProseMirror does NOT
   * auto-apply `contenteditable="false"` to NodeView DOM the way it does for
   * `renderHTML` output, so we set it explicitly to keep the atom uneditable.
   * The DOM (class + data-* attrs) mirrors `renderHTML` so anything keyed on
   * them (styling, `data-entry-id`) is unaffected; only the text is reactive.
   */
  addNodeView() {
    const char =
      (this.options as { suggestion?: { char?: string } }).suggestion?.char ??
      "@";
    return ({ node }: { node: ProseMirrorNode }) => {
      const id = node.attrs.id as string;
      const kind = (node.attrs.kind as MentionKind) ?? "codex";
      const bakedLabel = (node.attrs.label as string | null) ?? null;

      const dom = document.createElement("span");
      dom.className = "mention";
      dom.contentEditable = "false";
      dom.setAttribute("data-entry-id", id ?? "");
      dom.setAttribute(
        "data-role",
        (node.attrs.role as MentionRole) ?? "mentioned",
      );
      if (kind !== "codex") dom.setAttribute("data-kind", kind);

      const resolveName = (): string => {
        if (kind === "codex" && id) {
          const entry = useCodexStore
            .getState()
            .entries.find((e) => e.id === id);
          if (entry) return entry.name;
        }
        return bakedLabel ?? id ?? "";
      };

      let painted = "";
      const paint = (): void => {
        const text = `${char}${resolveName()}`;
        if (text !== painted) {
          painted = text;
          dom.textContent = text;
        }
      };
      paint();
      // Repaint when codex entries change (rename). Codex store updates are
      // entry-CRUD frequency (highlight/match state lives in a separate store),
      // so a per-node listener doing one lookup + string-diff is negligible.
      const unsub = useCodexStore.subscribe(paint);

      return {
        dom,
        ignoreMutation: () => true,
        selectNode() {
          dom.classList.add("ProseMirror-selectednode");
        },
        deselectNode() {
          dom.classList.remove("ProseMirror-selectednode");
        },
        update(updatedNode: ProseMirrorNode) {
          if (updatedNode.type.name !== "mention") return false;
          // Identity attrs changed → let PM recreate so the closure (and its
          // store subscription) rebinds to the new id/kind.
          if ((updatedNode.attrs.id as string) !== id) return false;
          if (((updatedNode.attrs.kind as MentionKind) ?? "codex") !== kind)
            return false;
          dom.setAttribute(
            "data-role",
            (updatedNode.attrs.role as MentionRole) ?? "mentioned",
          );
          paint();
          return true;
        },
        destroy() {
          unsub();
        },
      };
    };
  },
});

export interface CodexMentionPopupState {
  items: MentionItem[];
  selectedIndex: number;
  clientRect: (() => DOMRect | null) | null | undefined;
  /**
   * 確定時のコールバック。codex は role を伴い、scene は role 無視 (`undefined`)。
   */
  command: ((item: MentionItem, role?: MentionRole) => void) | null;
}

export interface CodexMentionExtensionOptions {
  /**
   * codex 以外のサジェストアイテムを差し込むためのプラガブルプロバイダ。
   * chat 入力欄が scene mention を混在させる時に使う。
   * - SceneEditor / Beat は渡さない → 振る舞いは従来通り。
   * - 同期/非同期どちらでも可。
   */
  extraItems?: (query: string) => MentionItem[] | Promise<MentionItem[]>;
}

/**
 * @メンション補完拡張（Chat / SceneEditor / Beat 共通）。
 * Mention ノード = 非編集可能インライントークン + entryId/name メタデータ + kind。
 * suggestion.render からは状態 setter を経由してポップアップ UI を制御する。
 *
 * `extraItems` を渡すと codex 以外のアイテム（chat 用の scene 等）を混ぜられる。
 */
export function createCodexMentionExtension(
  setPopup: (state: CodexMentionPopupState | null) => void,
  options?: CodexMentionExtensionOptions,
) {
  const buildItems = async (query: string): Promise<MentionItem[]> => {
    const q = query.toLowerCase();
    const entries = useCodexStore.getState().entries;
    const codexItems: MentionItem[] = entries
      .filter(
        (e) =>
          e.contextMode !== "hidden" &&
          (q === "" || e.name.toLowerCase().includes(q)),
      )
      .map((e) => ({
        kind: "codex" as const,
        id: e.id,
        name: e.name,
        typeLabel: e.type,
        summary: e.summary ?? undefined,
        source: e,
      }));
    const extra = options?.extraItems
      ? await Promise.resolve(options.extraItems(query))
      : [];
    return [...codexItems, ...extra];
  };

  return MentionWithRole.configure({
    HTMLAttributes: {
      class: "mention",
    },
    renderHTML({ options: opts, node }) {
      const kind = (node.attrs.kind as MentionKind) ?? "codex";
      const baseAttrs: Record<string, string> = {
        ...opts.HTMLAttributes,
        "data-entry-id": node.attrs.id,
        "data-role": (node.attrs.role as MentionRole) ?? "mentioned",
      };
      if (kind !== "codex") baseAttrs["data-kind"] = kind;
      return [
        "span",
        baseAttrs,
        `${opts.suggestion.char}${node.attrs.label ?? node.attrs.id}`,
      ];
    },
    suggestion: {
      char: "@",
      async items({ query }: { query: string }) {
        return buildItems(query);
      },
      render() {
        const commandFor = (
          props: SuggestionProps<MentionItem>,
        ): ((item: MentionItem, role?: MentionRole) => void) => {
          return (item, role = "mentioned") =>
            props.command({
              id: item.id,
              label: item.name,
              role,
              kind: item.kind,
            });
        };
        return {
          onStart(props: SuggestionProps<MentionItem>) {
            setPopup({
              items: props.items,
              selectedIndex: 0,
              clientRect: props.clientRect,
              command: commandFor(props),
            });
          },
          onUpdate(props: SuggestionProps<MentionItem>) {
            setPopup({
              items: props.items,
              selectedIndex: 0,
              clientRect: props.clientRect,
              command: commandFor(props),
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
