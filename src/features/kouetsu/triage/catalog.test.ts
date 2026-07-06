import { describe, it, expect } from "vitest";
import type { TypoCategory } from "@/features/post-effect/types";
import {
  CAT_EFFECTS,
  catLastRunIso,
  issueMetaLabel,
  relativeTimeLabel,
} from "./catalog";
import type { IssueMeta } from "./issueModel";
import type { EffectLastRunMap } from "./useEffectLastRuns";

// i18n は実リソース（ja が既定言語）で検証する。

describe("issueMetaLabel", () => {
  it("null は空文字", () => {
    expect(issueMetaLabel(null)).toBe("");
  });

  it("rule は rule_id をそのまま出す", () => {
    expect(
      issueMetaLabel({ kind: "rule", ruleId: "ja/no-doubled-joshi" }),
    ).toBe("ja/no-doubled-joshi");
  });

  it("codex は codexChipLabel（detail → entry ▸ detail / summary → entry ▸ サマリ / content → entry）", () => {
    const base = {
      entryId: "e1",
      entryName: "田中",
      sourceExcerpt: undefined,
      expectedValue: "17歳",
      foundValue: "15歳",
    };
    expect(
      issueMetaLabel({
        kind: "codex",
        codex: { ...base, sourceField: "detail", detailName: "年齢" },
      }),
    ).toBe("田中 ▸ 年齢");
    expect(
      issueMetaLabel({
        kind: "codex",
        codex: { ...base, sourceField: "summary", detailName: undefined },
      }),
    ).toBe("田中 ▸ サマリ");
    expect(
      issueMetaLabel({
        kind: "codex",
        codex: { ...base, sourceField: "content", detailName: undefined },
      }),
    ).toBe("田中");
  });

  it("typo は「AI検出 · カテゴリ名」、未知カテゴリは other へフォールバック", () => {
    expect(issueMetaLabel({ kind: "typo", category: "okurigana" })).toBe(
      "AI検出 · 送り仮名",
    );
    expect(
      issueMetaLabel({ kind: "typo", category: "unknown" as TypoCategory }),
    ).toBe("AI検出 · 誤字");
  });

  it("relation は postEffect.relation.* を引き、未知 relation は生値のまま", () => {
    expect(issueMetaLabel({ kind: "relation", relation: "contradicts" })).toBe(
      "矛盾",
    );
    expect(issueMetaLabel({ kind: "relation", relation: "chronology" })).toBe(
      "時系列",
    );
    expect(issueMetaLabel({ kind: "relation", relation: "novel_rel" })).toBe(
      "novel_rel",
    );
  });

  it("lens は lensType ラベル、未知 lensType はメタ構造へフォールバック", () => {
    expect(issueMetaLabel({ kind: "lens", lensType: "pacing" })).toBe("ペース");
    expect(
      issueMetaLabel({
        kind: "lens",
        lensType: "unknown",
      } as unknown as IssueMeta),
    ).toBe("メタ構造");
  });

  it("impact はエントリ名をそのまま出す", () => {
    expect(issueMetaLabel({ kind: "impact", entryName: "魔法体系" })).toBe(
      "魔法体系",
    );
  });
});

describe("catLastRunIso", () => {
  it("単一 effect の観点はその completedAt を返す", () => {
    const lastRuns: EffectLastRunMap = {
      typo_detection: "2026-07-05T10:00:00.000Z",
    };
    expect(catLastRunIso("typo", lastRuns)).toBe("2026-07-05T10:00:00.000Z");
    expect(catLastRunIso("review", lastRuns)).toBeNull();
  });

  it("consistency は codex/intra 2 effect の新しい方へ畳む", () => {
    expect(
      catLastRunIso("consistency", {
        consistency: "2026-07-05T10:00:00.000Z",
        intra_scene_consistency: "2026-07-06T09:00:00.000Z",
      }),
    ).toBe("2026-07-06T09:00:00.000Z");
    expect(
      catLastRunIso("consistency", {
        consistency: "2026-07-06T12:00:00.000Z",
        intra_scene_consistency: "2026-07-06T09:00:00.000Z",
      }),
    ).toBe("2026-07-06T12:00:00.000Z");
    // 片側のみでも拾う
    expect(
      catLastRunIso("consistency", {
        intra_scene_consistency: "2026-07-06T09:00:00.000Z",
      }),
    ).toBe("2026-07-06T09:00:00.000Z");
  });

  it("linter は effect を持たないため常に null（live lint / 手動の固定ラベル側）", () => {
    expect(CAT_EFFECTS.linter).toEqual([]);
    expect(
      catLastRunIso("linter", {
        typo_detection: "2026-07-05T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("空マップは null", () => {
    expect(catLastRunIso("timeline", {})).toBeNull();
  });
});

describe("relativeTimeLabel（i18n 文言化）", () => {
  // TZ 非依存にするため now をローカル時刻で組み、比較対象は差分から作る。
  const now = new Date(2026, 6, 6, 12, 0, 0);

  it("60 秒未満は「たった今」", () => {
    const iso = new Date(now.getTime() - 30_000).toISOString();
    expect(relativeTimeLabel(iso, now)).toBe("たった今");
  });

  it("60 分未満は「N分前」", () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(relativeTimeLabel(iso, now)).toBe("5分前");
  });

  it("当日は HH:MM（ローカル時刻のゼロ埋め）", () => {
    const t = new Date(now.getTime() - 2 * 3_600_000); // 同一ローカル日 10:00
    expect(relativeTimeLabel(t.toISOString(), now)).toBe("10:00");
  });

  it("前日は「昨日」、それ以前は M/D", () => {
    const yesterday = new Date(2026, 6, 5, 23, 0, 0);
    expect(relativeTimeLabel(yesterday.toISOString(), now)).toBe("昨日");
    const older = new Date(2026, 5, 30, 12, 0, 0);
    expect(relativeTimeLabel(older.toISOString(), now)).toBe("6/30");
  });

  it("不正 ISO は null", () => {
    expect(relativeTimeLabel("not-a-date", now)).toBeNull();
  });
});
