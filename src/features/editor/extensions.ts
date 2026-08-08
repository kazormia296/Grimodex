import type { Extensions } from "@tiptap/core";
import {
  getEditorExtensions as getEditorExtensionsCore,
  getReadonlyEditorExtensions as getReadonlyEditorExtensionsCore,
  ParagraphWithEmptyLineSupport as ParagraphWithEmptyLineSupportCore,
} from "./extensionsCore";
import type { EditorExtensionOptions } from "./extensionsCore";
import { createParagraphIndentPlugin } from "./ParagraphIndentPlugin";

export * from "./extensionsCore";

/**
 * Shared paragraph node for DB-native and file-backed editors. The inherited
 * Markdown storage preserves empty paragraphs; this extension adds the display
 * policy that suppresses automatic indentation for dialogue and explicitly
 * indented paragraphs.
 */
export const ParagraphWithEmptyLineSupport =
  ParagraphWithEmptyLineSupportCore.extend({
    addProseMirrorPlugins() {
      return [createParagraphIndentPlugin()];
    },
  });

function withParagraphIndentPolicy(extensions: Extensions): Extensions {
  return extensions.map((extension) =>
    extension === ParagraphWithEmptyLineSupportCore
      ? ParagraphWithEmptyLineSupport
      : extension,
  );
}

export function getEditorExtensions(
  options: EditorExtensionOptions = {},
): Extensions {
  return withParagraphIndentPolicy(getEditorExtensionsCore(options));
}

export function getReadonlyEditorExtensions(
  options: EditorExtensionOptions = {},
): Extensions {
  return withParagraphIndentPolicy(getReadonlyEditorExtensionsCore(options));
}
