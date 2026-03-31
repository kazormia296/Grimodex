import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import type { Extensions } from "@tiptap/core";

/**
 * Centralizes all TipTap extensions.
 * Each feature registers its extensions here to avoid merge conflicts
 * when multiple features add extensions in parallel.
 */
export function getEditorExtensions(): Extensions {
  return [
    StarterKit,
    Markdown,
    // Phase 4: AuthorshipMark will be added here
    // Phase 5: RubyNode will be added here
  ];
}
