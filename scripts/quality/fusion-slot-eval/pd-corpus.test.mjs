import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanAozoraLine,
  removeIllustrations,
  sizeOf,
  splitScenes,
} from "./pd-corpus.mjs";

test("青空文庫の行：ルビは親文字だけ、注記と外字は除く", () => {
  assert.equal(cleanAozoraLine("　山｜田《だ》の川《かわ》"), "山田の川");
  assert.equal(cleanAozoraLine("赤※［＃「木＋亜」］《あ》の木"), "赤の木");
  assert.equal(cleanAozoraLine("［＃８字下げ］序"), "序");
});

test("挿絵の注記は入れ子の括弧ごと除き、中の章見出しだけ残す", () => {
  const body =
    "a\n\n[Illustration:\n\nx\n\n[_c_]]\n\nb\n\n[Illustration: T\n\nChapter I.]\n\nc";
  const out = removeIllustrations(body);
  assert.ok(!out.includes("[") && !out.includes("]"));
  assert.ok(out.includes("Chapter I."));
  assert.ok(out.startsWith("a") && out.endsWith("c"));
});

test("分割：短い節は次と合わせ、長い節は上限以下にほぼ等分する", () => {
  const rule = { unit: "words", maxPerScene: 10, minPerScene: 3 };
  const words = (n) => Array.from({ length: n }, () => "w").join(" ");
  const sections = [
    { paragraphs: [words(1)] },
    { paragraphs: [words(4)] },
    { paragraphs: [words(6), words(6), words(6), words(6)] },
    { paragraphs: [words(2)] },
  ];
  const scenes = splitScenes(sections, rule);
  // 1 は次と合わせて 5。末尾の 2 は直前（24）に合わせて 26 → 3 等分では 12 が残るので 4 等分。
  assert.deepEqual(
    scenes.map((s) => s.size),
    [5, 6, 6, 6, 8],
  );
  assert.equal(
    scenes.reduce((n, s) => n + s.size, 0),
    sizeOf(
      sections.flatMap((s) => s.paragraphs),
      "words",
    ),
  );
});
