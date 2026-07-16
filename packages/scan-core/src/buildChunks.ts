import { stableHash8 } from "./hash.js";
import type {
  BuildChunksOptions,
  NormalizedDocument,
  NormalizedParagraph,
  ScanChunk,
} from "./types.js";

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function chunkFromParagraphs(
  document: NormalizedDocument,
  primary: readonly NormalizedParagraph[],
  overlap: readonly NormalizedParagraph[],
): ScanChunk {
  const all = [...overlap, ...primary];
  const paragraphIds = all.map((paragraph) => paragraph.id);
  const sectionIds = unique(all.map((paragraph) => paragraph.sectionId));
  const id = `chunk:${stableHash8(`${document.source.fingerprint}:${paragraphIds.join(",")}`)}`;
  return {
    id,
    text: all.map((paragraph) => paragraph.text).join("\n"),
    paragraphIds,
    overlapParagraphIds: overlap.map((paragraph) => paragraph.id),
    sectionIds,
  };
}

export function buildChunks(
  document: NormalizedDocument,
  options: BuildChunksOptions,
): ScanChunk[] {
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters <= 0) {
    throw new Error("maxCharacters must be a positive integer");
  }
  const overlapParagraphs = options.overlapParagraphs ?? 0;
  if (!Number.isInteger(overlapParagraphs) || overlapParagraphs < 0) {
    throw new Error("overlapParagraphs must be a non-negative integer");
  }

  const primaryChunks: NormalizedParagraph[][] = [];
  let current: NormalizedParagraph[] = [];
  let currentLength = 0;

  for (const paragraph of document.paragraphs) {
    if (paragraph.text.length > options.maxCharacters) {
      throw new Error(
        `paragraph exceeds maxCharacters (${paragraph.id}: ${paragraph.text.length} > ${options.maxCharacters})`,
      );
    }
    const separatorLength = current.length > 0 ? 1 : 0;
    const nextLength = currentLength + separatorLength + paragraph.text.length;
    if (current.length > 0 && nextLength > options.maxCharacters) {
      primaryChunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += (current.length > 1 ? 1 : 0) + paragraph.text.length;
  }
  if (current.length > 0) primaryChunks.push(current);

  return primaryChunks.map((primary, index) => {
    const previous = primaryChunks[index - 1] ?? [];
    let overlap = previous.slice(
      Math.max(0, previous.length - overlapParagraphs),
    );
    while (
      overlap.length > 0 &&
      [...overlap, ...primary].map((paragraph) => paragraph.text).join("\n")
        .length > options.maxCharacters
    ) {
      overlap = overlap.slice(1);
    }
    return chunkFromParagraphs(document, primary, overlap);
  });
}
