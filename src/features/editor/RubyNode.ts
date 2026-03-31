import { Node, mergeAttributes } from "@tiptap/core";

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
