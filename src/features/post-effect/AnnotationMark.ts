import { Mark, mergeAttributes } from "@tiptap/core";

export const AnnotationMark = Mark.create({
  name: "peAnnotation",
  inclusive: false,

  addAttributes() {
    return {
      annotationId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-pe-ann-id") ?? null,
        renderHTML: (attrs) =>
          attrs.annotationId ? { "data-pe-ann-id": attrs.annotationId } : {},
      },
      category: {
        default: "consistency_anchor",
        parseHTML: (el) =>
          el.getAttribute("data-pe-category") ?? "consistency_anchor",
        renderHTML: (attrs) =>
          attrs.category ? { "data-pe-category": attrs.category } : {},
      },
      severity: {
        default: "warning",
        parseHTML: (el) => el.getAttribute("data-pe-severity") ?? "warning",
        renderHTML: (attrs) =>
          attrs.severity ? { "data-pe-severity": attrs.severity } : {},
      },
      status: {
        default: "open",
        parseHTML: (el) => el.getAttribute("data-pe-status") ?? "open",
        renderHTML: (attrs) =>
          attrs.status ? { "data-pe-status": attrs.status } : {},
      },
      live: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-pe-live") === "true",
        renderHTML: (attrs) =>
          attrs.live === true ? { "data-pe-live": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-pe-annotation]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-pe-annotation": "" }, HTMLAttributes),
      0,
    ];
  },
});
