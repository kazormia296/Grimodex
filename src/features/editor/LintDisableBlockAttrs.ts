import { Extension } from "@tiptap/core";

/**
 * Adds a `lintDisabled` attribute to every block kind the linter looks
 * at. When set to a non-empty array, every Diagnostic whose range falls
 * entirely inside the block is suppressed (or, if the array is `["*"]`,
 * every rule is silenced).
 *
 * Block-level disable complements the Span-level `lintDisable` Mark —
 * the Mark covers "this phrase only", the block attribute covers "this
 * whole paragraph" without having to select the entire text (and
 * without the Mark's inclusive: false quirks eating the trailing
 * newline).
 *
 * Wire conversion happens outside this file: the offset-map walker
 * picks up both the Mark ranges and each block's `lintDisabled` attr
 * and hands the engine a flat `DisableDirective[]`.
 */
export const LintDisableBlockAttrs = Extension.create({
  name: "lintDisableBlockAttrs",

  addGlobalAttributes() {
    return [
      {
        // Mirror the block kinds the Rust linter operates on (see
        // SKIP_PM_TYPES in offsetMap.ts and engine.rs's supported block
        // kinds). Keep these in sync.
        types: ["paragraph", "heading", "blockquote", "listItem", "tableCell"],
        attributes: {
          lintDisabled: {
            default: null as string[] | null,
            parseHTML: (el) => {
              const raw = el.getAttribute("data-lint-disabled");
              if (!raw) return null;
              try {
                const parsed = JSON.parse(raw);
                if (
                  Array.isArray(parsed) &&
                  parsed.every((s) => typeof s === "string")
                ) {
                  return parsed.length > 0 ? parsed : null;
                }
              } catch {
                // fall through
              }
              return null;
            },
            renderHTML: (attrs) => {
              const value = attrs.lintDisabled;
              if (!Array.isArray(value) || value.length === 0) return {};
              return { "data-lint-disabled": JSON.stringify(value) };
            },
            // Keep the attr out of markdown round-trips. An exported
            // Markdown file should contain only the author's prose —
            // linter suppression is editor metadata.
            keepOnSplit: true,
          },
        },
      },
    ];
  },
});
