import { describe, it, expect } from "vitest";
import {
  checkAliasCollisions,
  checkRelationDuplicates,
  computeCodexIntegrityIssues,
  type IntegrityEntryInput,
  type IntegrityRelationInput,
} from "./codexIntegrity";

function entry(
  id: string,
  name: string,
  aliases?: string[] | string | null,
): IntegrityEntryInput {
  return { id, name, aliases };
}

function rel(
  fromCodexId: string,
  toCodexId: string,
  relationType = "custom",
): IntegrityRelationInput {
  return { fromCodexId, toCodexId, relationType };
}

describe("checkAliasCollisions", () => {
  it("複数エントリが同じ名前を持つと衝突を返す", () => {
    const issues = checkAliasCollisions([
      entry("a", "シオン"),
      entry("b", "シオン"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("alias-collision");
    expect(issues[0].normalized).toBe("シオン");
    expect(issues[0].surfaces.map((s) => s.entryId).sort()).toEqual(["a", "b"]);
  });

  it("あるエントリの別名が別エントリの名前と衝突する", () => {
    const issues = checkAliasCollisions([
      entry("a", "灰目", ["シオン"]),
      entry("b", "シオン"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].normalized).toBe("シオン");
    expect(issues[0].surfaces.map((s) => s.entryId).sort()).toEqual(["a", "b"]);
  });

  it("Latin名は大文字小文字を無視して衝突 (matcher と同じ正規化)", () => {
    const issues = checkAliasCollisions([
      entry("a", "Elara"),
      entry("b", "elara"),
    ]);
    expect(issues).toHaveLength(1);
    // 元表記は保持される (表示用)
    expect(issues[0].surfaces.map((s) => s.surface).sort()).toEqual([
      "Elara",
      "elara",
    ]);
  });

  it("前後空白は trim して同一視する", () => {
    const issues = checkAliasCollisions([
      entry("a", " シオン "),
      entry("b", "シオン"),
    ]);
    expect(issues).toHaveLength(1);
  });

  it("同一エントリ内で名前と別名が重複しても自己衝突は作らない", () => {
    const issues = checkAliasCollisions([
      entry("a", "シオン", ["シオン", "シオン"]),
    ]);
    expect(issues).toEqual([]);
  });

  it("空文字・空白のみの表記は無視する", () => {
    const issues = checkAliasCollisions([
      entry("a", "", ["  "]),
      entry("b", "", null),
    ]);
    expect(issues).toEqual([]);
  });

  it("3エントリの衝突は1件にまとめ全 entryId を含む", () => {
    const issues = checkAliasCollisions([
      entry("a", "賢者"),
      entry("b", "賢者"),
      entry("c", "賢者"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].surfaces.map((s) => s.entryId).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("衝突が無ければ空配列", () => {
    const issues = checkAliasCollisions([
      entry("a", "シオン"),
      entry("b", "エリカ", ["賢者"]),
    ]);
    expect(issues).toEqual([]);
  });

  it("aliases が JSON 文字列でもパースする", () => {
    const issues = checkAliasCollisions([
      entry("a", "灰目", '["シオン"]'),
      entry("b", "シオン"),
    ]);
    expect(issues).toHaveLength(1);
  });

  it("NFC で合成形・分解形の同名を衝突として検出する", () => {
    const composed = "Élara"; // É = U+00C9
    const decomposed = "Élara"; // E + combining acute U+0301
    expect(composed).not.toBe(decomposed); // バイト列は異なる
    const issues = checkAliasCollisions([
      entry("a", composed),
      entry("b", decomposed),
    ]);
    expect(issues).toHaveLength(1);
  });

  it("excludedAliases に含まれる表記は衝突報告から除外する (matcher 整合)", () => {
    // baseline: 別名 藍 が衝突する
    expect(
      checkAliasCollisions([entry("a", "灰目", ["藍"]), entry("b", "藍")]),
    ).toHaveLength(1);
    // a が 藍 を除外していれば実行時に一致しない → 衝突報告しない
    expect(
      checkAliasCollisions([
        { id: "a", name: "灰目", aliases: ["藍"], excludedAliases: ["藍"] },
        entry("b", "藍"),
      ]),
    ).toEqual([]);
  });
});

describe("checkRelationDuplicates", () => {
  it("同一ペア同type の重複 (順方向2本) を検出する", () => {
    const issues = checkRelationDuplicates([
      rel("a", "b", "rival"),
      rel("a", "b", "rival"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "duplicate-relation",
      relationType: "rival",
      count: 2,
    });
  });

  it("逆方向 (A→B と B→A) も無向で同一視して重複扱い", () => {
    // expandCodexRelationsBFS が双方向展開するため、逆向き重複は冗長。
    const issues = checkRelationDuplicates([
      rel("a", "b", "friend"),
      rel("b", "a", "friend"),
    ]);
    expect(issues).toHaveLength(1);
    expect((issues[0] as { entryIds: string[] }).entryIds).toEqual(["a", "b"]);
  });

  it("同じペアでも type が違えば重複ではない", () => {
    const issues = checkRelationDuplicates([
      rel("a", "b", "friend"),
      rel("a", "b", "rival"),
    ]);
    expect(issues).toEqual([]);
  });

  it("自己参照 (from===to) を検出する", () => {
    const issues = checkRelationDuplicates([rel("a", "a", "custom")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "self-relation", entryId: "a" });
  });

  it("同一エントリの自己参照が複数あっても type ごとに1件に畳む", () => {
    const issues = checkRelationDuplicates([
      rel("a", "a", "custom"),
      rel("a", "a", "custom"),
    ]);
    expect(issues).toHaveLength(1);
  });

  it("単一の正常なリレーションは何も返さない", () => {
    const issues = checkRelationDuplicates([rel("a", "b", "mentor")]);
    expect(issues).toEqual([]);
  });

  it("relationType の大文字小文字違いを同一視して重複検出する", () => {
    const issues = checkRelationDuplicates([
      rel("a", "b", "Friend"),
      rel("a", "b", "friend"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "duplicate-relation", count: 2 });
  });
});

describe("computeCodexIntegrityIssues", () => {
  it("別名衝突とリレーション問題を結合して返す", () => {
    const issues = computeCodexIntegrityIssues({
      entries: [entry("a", "シオン"), entry("b", "シオン")],
      relations: [rel("c", "c", "custom")],
    });
    const kinds = issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(["alias-collision", "self-relation"]);
  });

  it("問題が無ければ空配列", () => {
    const issues = computeCodexIntegrityIssues({
      entries: [entry("a", "シオン"), entry("b", "エリカ")],
      relations: [rel("a", "b", "friend")],
    });
    expect(issues).toEqual([]);
  });
});
