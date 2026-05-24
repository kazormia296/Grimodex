import type { RubyStyle } from "./types";

/** Unicode code-point split (sufficient for typical Japanese novel text). */
function splitChars(text: string): string[] {
  return [...text];
}

/**
 * Render ruby (furigana) as plain text / markup for export.
 * Formats follow common Japanese novel, wiki, and game-engine conventions.
 */
export function renderRubyText(
  base: string,
  annotation: string,
  style: RubyStyle,
): string {
  switch (style) {
    case "html":
      return `<ruby>${base}<rp>(</rp><rt>${annotation}</rt><rp>)</rp></ruby>`;
    case "parentheses":
      return `${base}(${annotation})`;
    case "aozora":
      return `｜${base}《${annotation}》`;
    case "aozora-auto":
      return `${base}《${annotation}》`;
    case "narou-parens":
      return `|${base}(${annotation})`;
    case "hash-underscore":
      return `#${base}__${annotation}__#`;
    case "rb-bracket":
      return `[[rb:${base} > ${annotation}]]`;
    case "mediawiki":
      return `{{ruby|${base}|${annotation}}}`;
    case "wikiwiki":
      return `&ruby(${annotation}){${base}};`;
    case "denden":
      return `{${base}|${annotation}}`;
    case "denden-chars":
      return renderDendenChars(base, annotation);
    case "renpy":
      return `\\r[${base},${annotation}]`;
    case "game-engine":
      return renderGameEngine(base, annotation);
    case "base":
      return base;
  }
}

/** {対象|ル|ビ} — one ruby segment per base character when lengths match. */
function renderDendenChars(base: string, annotation: string): string {
  const baseChars = splitChars(base);
  const annoChars = splitChars(annotation);
  if (baseChars.length === annoChars.length) {
    return `{${base}|${annoChars.join("|")}}`;
  }
  return `{${base}|${annotation}}`;
}

/** [ruby text=ル]対[ruby text=ビ]象 — per-character when lengths match. */
function renderGameEngine(base: string, annotation: string): string {
  const baseChars = splitChars(base);
  const annoChars = splitChars(annotation);
  if (baseChars.length === annoChars.length) {
    return baseChars
      .map((char, i) => `[ruby text=${annoChars[i]}]${char}`)
      .join("");
  }
  return `[ruby text=${annotation}]${base}`;
}
