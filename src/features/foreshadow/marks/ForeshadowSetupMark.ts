import { Mark, mergeAttributes } from "@tiptap/core";

export const ForeshadowSetupMark = Mark.create({
  name: "foreshadowSetup",
  inclusive: false,

  addAttributes() {
    return {
      setupId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-fs-setup-id") ?? null,
        renderHTML: (attrs) =>
          attrs.setupId ? { "data-fs-setup-id": attrs.setupId } : {},
      },
      foreshadowId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-fs-id") ?? null,
        renderHTML: (attrs) =>
          attrs.foreshadowId ? { "data-fs-id": attrs.foreshadowId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-foreshadow-setup]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-foreshadow-setup": "" }, HTMLAttributes),
      0,
    ];
  },
});
