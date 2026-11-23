/**
 * 「知らせる段は AI・候補絞り・保存を呼ばない」の静的な固定（DR-INN-1）。
 * `semanticSearch` などは試験で mock していないので、直接呼ぶ変更は spy の 0 回の assert では
 * 落ちない。知らせの経路の file が AI／候補絞り／保存の module を import していないことを、
 * file の文字列で照合する。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "../impact-review/impactPending.ts",
  "../impact-review/impactGate.ts",
  "../impact-review/readImpactPending.ts",
  "../impact-review/impactPendingEpoch.ts",
  "../codex/components/useImpactPending.ts",
  "../codex/components/ImpactPendingTabMarker.tsx",
];

/** 静的 import／export from／動的 import() の指定子を集める。 */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    found.push(m[1] ?? m[2]);
  }
  return found;
}

const FORBIDDEN_SPECIFIER =
  /runImpactReview|\/narrowing|post-effect\/api|semantic-search|modelRouting|chat\/store|\/lib\/api|\/db\/client/;
/**
 * 共有の純関数 `impactGate.ts` が import してよい指定子の許可リスト。禁止リスト方式では、
 * DB を import する `./snapshot` などの将来の追加を検出できない（独立レビューの指摘）ので、
 * 許可したもの以外はすべて失敗にする。
 */
const GATE_ALLOWED_SPECIFIERS: readonly string[] = [
  "@/features/codex/context/codexVisibilityPolicy",
  "./diff",
];
const FORBIDDEN_IDENTIFIER =
  /\b(runImpactReview|narrowCandidateScenes|semanticSearch|runPostEffectMulti|resolveRoleSendOverride|saveBaseline|fts_search)\b/;

describe("知らせの経路は AI・候補絞り・保存の module を import しない", () => {
  it.each(FILES)("%s", (rel) => {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    const specs = specifiers(source);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec).not.toMatch(FORBIDDEN_SPECIFIER);
    if (rel === "../impact-review/impactGate.ts") {
      for (const spec of specs) expect(GATE_ALLOWED_SPECIFIERS).toContain(spec);
    }
    // コメントを除いて識別子も確かめる。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(FORBIDDEN_IDENTIFIER);
  });

  it("impactGate.ts の許可リストは、DB を import する module（./snapshot・./baseline など）を通さない（空振り防止）", () => {
    const gateSource = readFileSync(
      new URL("../impact-review/impactGate.ts", import.meta.url),
      "utf8",
    );
    const withSnapshot = `${gateSource}\nimport { buildCodexSnapshot } from "./snapshot";\n`;
    const offenders = specifiers(withSnapshot).filter(
      (spec) => !GATE_ALLOWED_SPECIFIERS.includes(spec),
    );
    expect(offenders).toEqual(["./snapshot"]);
    // 実際の impactGate.ts は許可リストの中だけ。
    expect(
      specifiers(gateSource).filter(
        (spec) => !GATE_ALLOWED_SPECIFIERS.includes(spec),
      ),
    ).toEqual([]);
  });

  it("照合の正規表現が実際に import を拾える（空振り防止）", () => {
    expect(
      specifiers(
        'import { a } from "pkg-a";\nconst m = await import("pkg-b");\nexport * from "pkg-c";',
      ),
    ).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
  });
});
