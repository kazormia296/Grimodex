import { Node, mergeAttributes, type RawCommands } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "prosemirror-model";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ruby: {
      /** Insert a ruby (furigana) annotation. */
      setRuby: (base: string, annotation: string) => ReturnType;
    };
  }
}

export const RubyNode = Node.create({
  name: "ruby",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      base: {
        default: "",
      },
      annotation: {
        default: "",
      },
    };
  },

  addCommands() {
    return {
      setRuby:
        (base: string, annotation: string) =>
        ({ chain }) => {
          return chain()
            .insertContent({
              type: this.name,
              attrs: { base, annotation },
            })
            .run();
        },
    } as Partial<RawCommands>;
  },

  parseHTML() {
    return [
      {
        tag: "ruby[data-base]",
        getAttrs(node) {
          const el = node as HTMLElement;
          return {
            base: el.getAttribute("data-base"),
            annotation: el.getAttribute("data-annotation"),
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "ruby",
      mergeAttributes(HTMLAttributes, {
        "data-base": node.attrs.base,
        "data-annotation": node.attrs.annotation,
      }),
      node.attrs.base as string,
      ["rp", {}, "("],
      ["rt", {}, node.attrs.annotation as string],
      ["rp", {}, ")"],
    ];
  },

  /**
   * カスタム NodeView: display:inline-block の wrapper span でルビをラップする。
   *
   * ProseMirror はカスタム NodeView の DOM に contenteditable 属性を自動付与しない
   * (viewdesc.ts:708-709 は renderHTML 経由の DOM にのみ適用)。
   * wrapper を display:inline-block にすることで、ブラウザは画像と同様に
   * atom を原子的にスキップし、End/Home/矢印キーのナビゲーション問題を回避する。
   */
  addNodeView() {
    return ({ node }: { node: ProseMirrorNode }) => {
      const dom = document.createElement("span");
      dom.classList.add("ruby-atom");
      dom.contentEditable = "false";

      const ruby = document.createElement("ruby");
      ruby.setAttribute("data-base", node.attrs.base as string);
      ruby.setAttribute("data-annotation", node.attrs.annotation as string);

      const baseText = document.createTextNode(node.attrs.base as string);
      ruby.appendChild(baseText);

      const rp1 = document.createElement("rp");
      rp1.textContent = "(";
      ruby.appendChild(rp1);

      const rt = document.createElement("rt");
      rt.textContent = node.attrs.annotation as string;
      ruby.appendChild(rt);

      const rp2 = document.createElement("rp");
      rp2.textContent = ")";
      ruby.appendChild(rp2);

      dom.appendChild(ruby);

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
          if (updatedNode.type.name !== "ruby") return false;
          ruby.setAttribute("data-base", updatedNode.attrs.base as string);
          ruby.setAttribute(
            "data-annotation",
            updatedNode.attrs.annotation as string,
          );
          baseText.textContent = updatedNode.attrs.base as string;
          rt.textContent = updatedNode.attrs.annotation as string;
          return true;
        },
      };
    };
  },
});
