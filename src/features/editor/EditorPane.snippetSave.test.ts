import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// EditorPane の snippet 本文保存は、かつて updateSnippet 直呼び +
// snippetStore.update の二重 DB 書き込みだった。snippet の OCC (baseVersion)
// 導入後にこの二重化が復活すると、直呼び側の書き込みが store 側 OCC と
// 自己衝突する (or 無条件 bump なら 1 保存で +2 になる) ため、store 経由の
// 1 回に集約されていることをソースレベルで gate する。
// EditorPane はコンポーネントテスト基盤が無い巨大コンポーネントなので、
// レンダリングせず構造 invariant として検証する。
describe("EditorPane snippet save (二重書き込み集約)", () => {
  const source = readFileSync(resolve(__dirname, "./EditorPane.tsx"), "utf-8");

  it("snippets/api の updateSnippet を直接呼ばない (store.update に一本化)", () => {
    // import 自体を禁止する (直呼びが無ければ import も不要)。
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bupdateSnippet\b[^}]*\}\s*from\s*"@\/features\/snippets\/api"/,
    );
    expect(source).not.toMatch(/(?<![.\w])updateSnippet\(/);
  });

  it("snippet 本文保存は snippetStore.update を await して 1 回だけ行う", () => {
    expect(source).toMatch(
      /await useSnippetStore\.getState\(\)\.update\(id, \{ content \}\)/,
    );
  });
});
