import {
  computeSourceFingerprint,
  type ScanLanguage,
} from "@grimodex/scan-contract";
import { stableHash8 } from "./hash.js";
import { normalizeText, paragraphText } from "./normalizeText.js";
import type {
  NormalizedDocument,
  NormalizedParagraph,
  NormalizedSection,
  SourceDocumentInput,
} from "./types.js";

interface SectionDraft {
  title: string;
  lines: string[];
  isHeading: boolean;
}

function headingTitle(line: string): string | null {
  const markdown = /^#{1,6}\s+(.+?)\s*$/.exec(line);
  if (markdown?.[1]) return markdown[1].trim();

  const japanese =
    /^(第[0-9一二三四五六七八九十百千万]+章|序章|終章)\s*(.*)$/.exec(line);
  if (!japanese?.[1]) return null;
  return `${japanese[1]}${japanese[2] ? ` ${japanese[2].trim()}` : ""}`.trim();
}

function splitParagraphs(lines: readonly string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = paragraphText(current);
    if (text) paragraphs.push(text);
    current = [];
  };

  for (const line of lines) {
    if (line === "") {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return paragraphs;
}

function buildSection(
  draft: SectionDraft,
  sectionOrdinal: number,
): NormalizedSection {
  const texts = splitParagraphs(draft.lines);
  const sectionId = `section:${sectionOrdinal}:${stableHash8(`${draft.title}\n${texts.join("\n")}`)}`;
  const paragraphs: NormalizedParagraph[] = texts.map((text, ordinal) => ({
    id: `paragraph:${sectionOrdinal}:${ordinal}:${stableHash8(text)}`,
    sectionId,
    sectionOrdinal,
    ordinal,
    text,
  }));
  return {
    id: sectionId,
    ordinal: sectionOrdinal,
    title: draft.title,
    paragraphIds: paragraphs.map((paragraph) => paragraph.id),
    paragraphs,
  };
}

function detectSectionDrafts(
  text: string,
  fallbackTitle: string,
  continuationTitle: string,
): SectionDraft[] {
  const drafts: SectionDraft[] = [];
  let current: SectionDraft | null = null;
  let sawHeading = false;

  const flush = () => {
    if (
      current &&
      (current.isHeading || current.lines.some((line) => line !== ""))
    ) {
      drafts.push(current);
    }
    current = null;
  };

  for (const line of text.split("\n")) {
    const title = headingTitle(line);
    if (title) {
      sawHeading = true;
      flush();
      current = { title, lines: [], isHeading: true };
      continue;
    }
    if (/^[-_=*]{3,}$/.test(line)) {
      if (current?.lines.some((item) => item !== "")) flush();
      if (sawHeading)
        current = { title: continuationTitle, lines: [], isHeading: false };
      continue;
    }
    current ??= {
      title: sawHeading ? continuationTitle : fallbackTitle,
      lines: [],
      isHeading: false,
    };
    current.lines.push(line);
  }
  flush();

  if (drafts.length === 0) {
    return [
      { title: fallbackTitle, lines: text.split("\n"), isHeading: false },
    ];
  }
  return drafts;
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

export function normalizeDocument(
  input: SourceDocumentInput,
): NormalizedDocument {
  const text = normalizeText(input.text);
  const fallbackTitle =
    input.title.trim() || (input.language === "en" ? "Manuscript" : "本文");
  const continuationTitle = input.language === "en" ? "Next section" : "次章";
  const drafts = detectSectionDrafts(text, fallbackTitle, continuationTitle);
  const sections = drafts.map((draft, ordinal) => buildSection(draft, ordinal));
  const paragraphs = sections.flatMap((section) => section.paragraphs);

  const sourceStructure = {
    title: input.title.trim() || "Untitled",
    language: input.language,
    sections: sections.map((section) => ({
      id: section.id,
      ordinal: section.ordinal,
      title: section.title,
      paragraphIds: [...section.paragraphIds],
    })),
    paragraphs: paragraphs.map((paragraph) => ({
      id: paragraph.id,
      sectionId: paragraph.sectionId,
      ordinal: paragraph.ordinal,
      text: paragraph.text,
    })),
  };
  const source = {
    title: sourceStructure.title,
    language: sourceStructure.language,
    fingerprint: computeSourceFingerprint(sourceStructure),
    characterCount: countCharacters(text),
    paragraphCount: paragraphs.length,
    sectionCount: sections.length,
  } satisfies {
    title: string;
    language: ScanLanguage;
    fingerprint: string;
    characterCount: number;
    paragraphCount: number;
    sectionCount: number;
  };

  return {
    title: source.title,
    text,
    source,
    sections,
    paragraphs,
  };
}
