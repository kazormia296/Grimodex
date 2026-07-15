import type {
  ScanLanguage,
  SourceDocumentV1,
  SourceParagraphV1,
  SourceSectionV1,
} from "./scanBundleV1.js";
import { sha256Hex } from "./hash.js";

export type SourceFingerprintInput = Pick<
  SourceDocumentV1,
  "title" | "language" | "sections" | "paragraphs"
>;

function canonicalSource(input: SourceFingerprintInput): string {
  return JSON.stringify({
    title: input.title,
    language: input.language,
    sections: input.sections.map((section: SourceSectionV1) => ({
      id: section.id,
      ordinal: section.ordinal,
      title: section.title,
      paragraphIds: [...section.paragraphIds],
    })),
    paragraphs: input.paragraphs.map((paragraph: SourceParagraphV1) => ({
      id: paragraph.id,
      sectionId: paragraph.sectionId,
      ordinal: paragraph.ordinal,
      text: paragraph.text,
    })),
  });
}

export function computeSourceFingerprint(input: SourceFingerprintInput): string {
  return `sha256:${sha256Hex(canonicalSource(input))}`;
}

export function isScanLanguage(value: unknown): value is ScanLanguage {
  return value === "ja" || value === "en" || value === "other";
}
