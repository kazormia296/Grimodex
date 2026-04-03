import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import Typography from "@tiptap/extension-typography";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { RubyNode } from "@/features/editor/RubyNode";
import { EmphasisDotsMark } from "@/features/editor/EmphasisDotsMark";
import { SceneBreakNode } from "@/features/editor/SceneBreakNode";
import { FindReplaceExtension } from "@/features/editor/FindReplaceExtension";
import { SlashCommandExtension } from "@/features/editor/inlineAi/SlashCommandExtension";
import type { Extensions } from "@tiptap/core";

/**
 * Centralizes all TipTap extensions.
 * Each feature registers its extensions here to avoid merge conflicts
 * when multiple features add extensions in parallel.
 */
export function getEditorExtensions(): Extensions {
  return [
    StarterKit,
    Markdown.configure({ html: true }),
    // Official extensions
    Underline,
    Link.configure({
      openOnClick: false,
      HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
    }),
    Placeholder.configure({ placeholder: "ここに書き始める…" }),
    CharacterCount,
    Typography,
    // Custom marks/nodes
    AuthorshipMark,
    EmphasisDotsMark,
    RubyNode,
    SceneBreakNode,
    FindReplaceExtension,
    SlashCommandExtension,
  ];
}
