export interface ClassificationSample {
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly head: string;
  readonly middle: string;
  readonly tail: string;
  readonly totalLength: number;
}

const DEFAULT_HEAD_CHARS = 400;
const DEFAULT_TAIL_CHARS = 400;

export function buildClassificationSample(
  resourceKey: string,
  relativePath: string,
  text: string,
  options?: { headChars?: number; tailChars?: number },
): ClassificationSample {
  const headChars = options?.headChars ?? DEFAULT_HEAD_CHARS;
  const tailChars = options?.tailChars ?? DEFAULT_TAIL_CHARS;
  const totalLength = text.length;

  if (totalLength <= headChars + tailChars + 32) {
    return {
      resourceKey,
      relativePath,
      head: text,
      middle: "",
      tail: "",
      totalLength,
    };
  }

  const head = text.slice(0, headChars);
  const tail = text.slice(totalLength - tailChars);
  const middleStart = Math.floor((totalLength - headChars - tailChars) / 2);
  const middle = text.slice(middleStart, middleStart + 120);

  return {
    resourceKey,
    relativePath,
    head,
    middle,
    tail,
    totalLength,
  };
}

export function sampleFromBlocks(
  resourceKey: string,
  relativePath: string,
  blocks: readonly { text: string }[],
): ClassificationSample {
  const text = blocks.map((block) => block.text).join("\n\n");
  return buildClassificationSample(resourceKey, relativePath, text);
}
