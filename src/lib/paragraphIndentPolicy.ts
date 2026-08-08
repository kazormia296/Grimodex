const JAPANESE_DIALOGUE_OPENERS = new Set(["「", "『"]);

/** Whether a paragraph begins with a Japanese dialogue quotation mark. */
export function startsWithJapaneseDialogue(text: string): boolean {
  return JAPANESE_DIALOGUE_OPENERS.has(text[0] ?? "");
}

/**
 * Automatic first-line indentation applies only to non-empty paragraphs that
 * do not already carry author-entered whitespace and do not begin with a
 * Japanese dialogue quotation mark.
 */
export function shouldApplyAutomaticParagraphIndent(text: string): boolean {
  return (
    text.length > 0 && !/^\s/u.test(text) && !startsWithJapaneseDialogue(text)
  );
}
