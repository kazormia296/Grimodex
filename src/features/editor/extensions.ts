import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { RubyNode } from "@/features/editor/RubyNode";
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
    AuthorshipMark,
    RubyNode,
  ];
}
