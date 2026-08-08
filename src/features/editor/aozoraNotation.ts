import {
  Fragment,
  Slice,
  type Mark,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";

export const AOZORA_KANJI_CLASS = "一-鿿々〆〤ヶ";

const PIPE_RUBY_PATTERN = `｜([^｜《》\\n]+)《([^《》\\n]+)》`;
const AUTO_RUBY_PATTERN = `([${AOZORA_KANJI_CLASS}]+)《([^《》\\n]+)》`;
const EMPHASIS_DOTS_PATTERN = "《《([^《》\\n]+)》》";
const TCY_RANGE_PATTERN = "［＃縦中横］([^［］\\n]+)［＃縦中横終わり］";

export const AOZORA_PIPE_RUBY_INPUT_RE = new RegExp(`${PIPE_RUBY_PATTERN}$`);
export const AOZORA_AUTO_RUBY_INPUT_RE = new RegExp(`${AUTO_RUBY_PATTERN}$`);
export const AOZORA_EMPHASIS_DOTS_INPUT_RE = new RegExp(
  `${EMPHASIS_DOTS_PATTERN}$`,
);
export const AOZORA_TCY_RANGE_INPUT_RE = new RegExp(`${TCY_RANGE_PATTERN}$`);

type AozoraInlineSegment =
  | { type: "text"; text: string }
  | { type: "ruby"; base: string; annotation: string }
  | { type: "emphasisDots"; text: string }
  | { type: "tcy"; text: string };

const KANJI_CHAR_RE = new RegExp(`[${AOZORA_KANJI_CLASS}]`);
const PIPE_RUBY_AT_RE = new RegExp(PIPE_RUBY_PATTERN, "y");
const EMPHASIS_DOTS_AT_RE = new RegExp(EMPHASIS_DOTS_PATTERN, "y");
const TCY_RANGE_AT_RE = new RegExp(TCY_RANGE_PATTERN, "y");
const RUBY_ANNOTATION_AT_RE = /《([^《》\n]+)》/y;
const EMPHASIS_OPEN = "《《";
const TCY_OPEN = "［＃縦中横］";

function execAt(
  pattern: RegExp,
  text: string,
  index: number,
): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

function appendText(segments: AozoraInlineSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last?.type === "text") {
    last.text += text;
  } else {
    segments.push({ type: "text", text });
  }
}

function trimTextSuffix(
  segments: AozoraInlineSegment[],
  suffix: string,
): boolean {
  const last = segments[segments.length - 1];
  if (last?.type !== "text" || !last.text.endsWith(suffix)) return false;
  last.text = last.text.slice(0, -suffix.length);
  if (!last.text) segments.pop();
  return true;
}

/** 手入力の InputRule と同じ青空記法を、貼り付け済みの平文から抽出する。 */
function parseAozoraInline(text: string): AozoraInlineSegment[] {
  const segments: AozoraInlineSegment[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith(EMPHASIS_OPEN, index)) {
      const match = execAt(EMPHASIS_DOTS_AT_RE, text, index);
      const value = match?.[1];
      if (match && value) {
        segments.push({ type: "emphasisDots", text: value });
        index += match[0].length;
        continue;
      }
    }

    if (text[index] === "｜") {
      const match = execAt(PIPE_RUBY_AT_RE, text, index);
      const base = match?.[1];
      const annotation = match?.[2];
      if (match && base && annotation) {
        segments.push({ type: "ruby", base, annotation });
        index += match[0].length;
        continue;
      }
    }

    if (text.startsWith(TCY_OPEN, index)) {
      const match = execAt(TCY_RANGE_AT_RE, text, index);
      const value = match?.[1];
      if (match && value) {
        segments.push({ type: "tcy", text: value });
        index += match[0].length;
        continue;
      }
    }

    if (text[index] === "《") {
      const match = execAt(RUBY_ANNOTATION_AT_RE, text, index);
      const annotation = match?.[1];
      if (match && annotation) {
        let baseStart = index;
        while (baseStart > 0 && KANJI_CHAR_RE.test(text[baseStart - 1] ?? "")) {
          baseStart--;
        }
        const base = text.slice(baseStart, index);
        if (base && trimTextSuffix(segments, base)) {
          segments.push({ type: "ruby", base, annotation });
          index += match[0].length;
          continue;
        }
      }
    }

    appendText(segments, text[index] ?? "");
    index++;
  }

  return segments;
}

function addMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  return mark.addToSet(marks);
}

function transformTextNode(
  node: ProseMirrorNode,
  schema: Schema,
): ProseMirrorNode[] {
  const rubyType = schema.nodes.ruby;
  const emphasisType = schema.marks.emphasisDots;
  const tcyType = schema.marks.tcy;
  if (!rubyType || !emphasisType || !tcyType || !node.text) return [node];

  return parseAozoraInline(node.text).map((segment) => {
    switch (segment.type) {
      case "ruby":
        return rubyType.create(
          { base: segment.base, annotation: segment.annotation },
          null,
          node.marks,
        );
      case "emphasisDots":
        return schema.text(
          segment.text,
          addMark(node.marks, emphasisType.create()),
        );
      case "tcy":
        return schema.text(segment.text, addMark(node.marks, tcyType.create()));
      case "text":
        return schema.text(segment.text, node.marks);
    }
  });
}

function transformFragment(
  fragment: Fragment,
  schema: Schema,
  insideCode: boolean,
): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const nodeInsideCode = insideCode || node.type.spec.code === true;
    if (node.isText) {
      const hasCodeMark = node.marks.some(
        (mark) => mark.type.spec.code === true,
      );
      nodes.push(
        ...(nodeInsideCode || hasCodeMark
          ? [node]
          : transformTextNode(node, schema)),
      );
      return;
    }
    nodes.push(
      node.content.size > 0
        ? node.copy(transformFragment(node.content, schema, nodeInsideCode))
        : node,
    );
  });
  return Fragment.fromArray(nodes);
}

/** Markdown 解析済み Slice の構造を保ったまま、青空記法だけを変換する。 */
export function transformAozoraNotationInSlice(
  slice: Slice,
  schema: Schema,
): Slice {
  if (!schema.nodes.ruby || !schema.marks.emphasisDots || !schema.marks.tcy) {
    return slice;
  }
  return new Slice(
    transformFragment(slice.content, schema, false),
    slice.openStart,
    slice.openEnd,
  );
}
