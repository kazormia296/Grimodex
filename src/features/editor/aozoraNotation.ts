import {
  Fragment,
  Slice,
  type Mark,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";

export const AOZORA_KANJI_CLASS = "一-鿿々〆〤ヶ";

export const AOZORA_PIPE_RUBY_INPUT_RE = new RegExp(
  `｜([^｜《》\\n]+)《([^《》\\n]+)》$`,
);
export const AOZORA_AUTO_RUBY_INPUT_RE = new RegExp(
  `([${AOZORA_KANJI_CLASS}]+)《([^《》\\n]+)》$`,
);
export const AOZORA_EMPHASIS_DOTS_INPUT_RE = /《《([^《》\n]+)》》$/;
export const AOZORA_TCY_RANGE_INPUT_RE =
  /［＃縦中横］([^［］\n]+)［＃縦中横終わり］$/;

type AozoraInlineSegment =
  | { type: "text"; text: string }
  | { type: "ruby"; base: string; annotation: string }
  | { type: "emphasisDots"; text: string }
  | { type: "tcy"; text: string };

const KANJI_CHAR_RE = new RegExp(`[${AOZORA_KANJI_CLASS}]`);
const EMPHASIS_OPEN = "《《";
const EMPHASIS_CLOSE = "》》";
const TCY_OPEN = "［＃縦中横］";
const TCY_CLOSE = "［＃縦中横終わり］";

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
      const close = text.indexOf(EMPHASIS_CLOSE, index + EMPHASIS_OPEN.length);
      if (close !== -1) {
        const value = text.slice(index + EMPHASIS_OPEN.length, close);
        if (value && !/[《》\n]/.test(value)) {
          segments.push({ type: "emphasisDots", text: value });
          index = close + EMPHASIS_CLOSE.length;
          continue;
        }
      }
    }

    if (text[index] === "｜") {
      const open = text.indexOf("《", index + 1);
      const close = open === -1 ? -1 : text.indexOf("》", open + 1);
      if (open !== -1 && close !== -1) {
        const base = text.slice(index + 1, open);
        const annotation = text.slice(open + 1, close);
        if (
          base &&
          annotation &&
          !/[｜《》\n]/.test(base) &&
          !/[《》\n]/.test(annotation)
        ) {
          segments.push({ type: "ruby", base, annotation });
          index = close + 1;
          continue;
        }
      }
    }

    if (text.startsWith(TCY_OPEN, index)) {
      const close = text.indexOf(TCY_CLOSE, index + TCY_OPEN.length);
      if (close !== -1) {
        const value = text.slice(index + TCY_OPEN.length, close);
        if (value && !/[［］\n]/.test(value)) {
          segments.push({ type: "tcy", text: value });
          index = close + TCY_CLOSE.length;
          continue;
        }
      }
    }

    if (text[index] === "《") {
      const close = text.indexOf("》", index + 1);
      if (close !== -1) {
        const annotation = text.slice(index + 1, close);
        let baseStart = index;
        while (baseStart > 0 && KANJI_CHAR_RE.test(text[baseStart - 1] ?? "")) {
          baseStart--;
        }
        const base = text.slice(baseStart, index);
        if (
          base &&
          annotation &&
          !/[《》\n]/.test(annotation) &&
          trimTextSuffix(segments, base)
        ) {
          segments.push({ type: "ruby", base, annotation });
          index = close + 1;
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
