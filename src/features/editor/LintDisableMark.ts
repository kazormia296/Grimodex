import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * `lintDisable` Mark — inline range on which a subset of Linter rules is
 * suppressed.
 *
 * Shape (mirrors Rust `DisableDirective.rules`):
 *   - `rules: ["*"]`         → suppress every rule
 *   - `rules: ["ja/..."]`    → suppress the listed rule IDs
 *
 * `inclusive: false` keeps typing at the edge from expanding the range
 * accidentally. Phase 3 design:
 * > 執筆中に disable 範囲の端に文字を入力した時に、意図せず無効化範囲が広がるのを防ぐため
 *
 * Markdown export: `lintDisable` carries no visible payload, so the
 * default TipTap markdown behaviour (drop unknown marks, keep children)
 * is what we want — no custom `markdown.serialize` needed.
 */
export interface LintDisableAttributes {
  rules: string[];
}

export const LintDisableMark = Mark.create({
  name: "lintDisable",
  inclusive: false,

  addAttributes() {
    return {
      rules: {
        default: ["*"] as string[],
        parseHTML: (el) => {
          const raw = el.getAttribute("data-lint-disable");
          if (!raw) return ["*"];
          try {
            const parsed = JSON.parse(raw);
            if (
              Array.isArray(parsed) &&
              parsed.every((s) => typeof s === "string")
            ) {
              return parsed;
            }
          } catch {
            // fall through
          }
          return ["*"];
        },
        renderHTML: (attrs) => {
          const rules = Array.isArray(attrs.rules) ? attrs.rules : ["*"];
          return { "data-lint-disable": JSON.stringify(rules) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-lint-disable]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Author-visible Span: light grey underline for regular disables,
    // a slightly more prominent color when the Mark silences every
    // rule (`["*"]`). CSS classes are resolved in the editor stylesheet.
    const rulesRaw = HTMLAttributes["data-lint-disable"];
    let isAll: boolean;
    try {
      const parsed = typeof rulesRaw === "string" ? JSON.parse(rulesRaw) : null;
      isAll = Array.isArray(parsed) && parsed.length === 1 && parsed[0] === "*";
    } catch {
      isAll = true;
    }
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: isAll ? "lint-disable lint-disable--all" : "lint-disable",
      }),
      0,
    ];
  },
});
