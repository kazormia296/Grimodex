import { Mark, mergeAttributes } from "@tiptap/core";

export const ForeshadowPayoffMark = Mark.create({
  name: "foreshadowPayoff",
  inclusive: false,

  addAttributes() {
    return {
      foreshadowId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-fp-id") ?? null,
        renderHTML: (attrs) =>
          attrs.foreshadowId ? { "data-fp-id": attrs.foreshadowId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-foreshadow-payoff]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-foreshadow-payoff": "" }, HTMLAttributes),
      0,
    ];
  },
});
