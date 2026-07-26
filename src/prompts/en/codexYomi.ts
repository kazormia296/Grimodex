import { JSON_ONLY } from "../shared/jsonContract";
import type { YomiEstimationInput } from "../ja/codexYomi";

// Prompt-injection hardening: surfaces are user-authored free text. Neutralize a
// forged `[entries]` section boundary the same way the JA builder does.
const RESERVED_SECTION_TOKEN_RE = /\[(?=\s*entries\b)/gi;

function sanitize(text: string): string {
  return text.replace(RESERVED_SECTION_TOKEN_RE, "[\\");
}

/**
 * Estimate hiragana readings for kanji-bearing proper-noun surfaces (English UI).
 * Even in an English project, Codex surfaces may be Japanese (imported / bilingual),
 * so the reading is still hiragana. Output: {readings:[{id, surface, yomi}]}.
 */
export function buildYomiEstimationPromptEn(
  input: YomiEstimationInput,
): string {
  const entryLines =
    input.entries
      .map((e) => {
        const surfaces = e.surfaces.map((s) => sanitize(s)).join(" / ");
        return `- id=${e.id} category=${sanitize(e.category)} surfaces=[${surfaces}]`;
      })
      .join("\n") || "(none)";

  return [
    "You estimate the reading (furigana) of proper nouns for a novel-writing app.",
    "For each surface, estimate the single most natural reading in **hiragana**.",
    "",
    "[Rules]",
    "- yomi MUST be hiragana only (no katakana, kanji, or romaji).",
    "- Use the category (person / place / etc.) to pick a plausible name reading.",
    "- Return exactly one, most-common reading per surface.",
    "- Never output an id / surface not present in the input. Omit a surface whose reading is impossible to guess.",
    "- Represent long vowels with 'ー'.",
    "",
    "JSON shape:",
    '{"readings":[{"id":"...","surface":"the surface verbatim","yomi":"hiragana"}]}',
    JSON_ONLY,
    "",
    "[entries]",
    entryLines,
  ].join("\n");
}
