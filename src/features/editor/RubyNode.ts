import { Node, mergeAttributes } from "@tiptap/core";

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
});
