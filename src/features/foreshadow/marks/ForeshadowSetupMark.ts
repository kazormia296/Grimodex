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
      baseVersion: {
        default: null,
        parseHTML: (el) => {
          const value = el.getAttribute("data-fs-base-version");
          if (value == null) return null;
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
        },
        renderHTML: (attrs) =>
          Number.isSafeInteger(attrs.baseVersion) && attrs.baseVersion >= 0
            ? { "data-fs-base-version": String(attrs.baseVersion) }
            : {},
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
