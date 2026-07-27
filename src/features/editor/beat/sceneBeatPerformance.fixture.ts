export const EDITOR_DISPATCH_CHARACTER_FIXTURES = [
  5_000, 50_000, 200_000,
] as const;

export const EDITOR_DISPATCH_BEAT_FIXTURES = [0, 20, 200] as const;

interface PerformanceDocumentOptions {
  characterCount: (typeof EDITOR_DISPATCH_CHARACTER_FIXTURES)[number];
  beatCount: (typeof EDITOR_DISPATCH_BEAT_FIXTURES)[number];
}

interface FixtureNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Array<{ type: "text"; text: string }>;
}

/**
 * Deterministic long-document fixture for editor.viewDispatch benchmarks.
 * Paragraph text is split into bounded blocks so both text size and Beat
 * density can be varied independently.
 */
export function createSceneBeatPerformanceDocument({
  characterCount,
  beatCount,
}: PerformanceDocumentOptions): {
  type: "doc";
  content: FixtureNode[];
} {
  const blockSize = 1_000;
  const paragraphCount = Math.max(1, Math.ceil(characterCount / blockSize));
  const content: FixtureNode[] = [];
  let remaining = characterCount;

  for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphCount;
    paragraphIndex += 1
  ) {
    const size = Math.min(blockSize, remaining);
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "本文".repeat(Math.ceil(size / 2)).slice(0, size),
        },
      ],
    });
    remaining -= size;

    const beatsThroughThisParagraph = Math.floor(
      ((paragraphIndex + 1) * beatCount) / paragraphCount,
    );
    const beatsThroughPreviousParagraph = Math.floor(
      (paragraphIndex * beatCount) / paragraphCount,
    );
    for (
      let beatIndex = beatsThroughPreviousParagraph;
      beatIndex < beatsThroughThisParagraph;
      beatIndex += 1
    ) {
      content.push({
        type: "sceneBeat",
        attrs: {
          id: `fixture-beat-${beatIndex}`,
          collapsed: false,
          beatType: "free",
          pov: null,
        },
        content: [{ type: "text", text: `Beat ${beatIndex}` }],
      });
    }
  }

  return { type: "doc", content };
}
