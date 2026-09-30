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
      baseVersion: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-fp-version");
          if (raw === null) return null;
          const value = Number(raw);
          return Number.isSafeInteger(value) && value >= 0 ? value : null;
        },
        renderHTML: (attrs) =>
          Number.isSafeInteger(attrs.baseVersion) && attrs.baseVersion >= 0
            ? { "data-fp-version": String(attrs.baseVersion) }
            : {},
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
