import { describe, it, expect } from "vitest";
import type { Diagnostic } from "@/features/lint/types";
import type {
  PostEffectAnnotation,
  SceneLensRecord,
} from "@/features/post-effect/types";
import {
  ANNOTATION_CATEGORY_TO_CAT,
  CAT_ORDER,
  advanceFrom,
  deriveSevCounts,
  fromAnnotation,
  fromLintDiagnostic,
  fromSceneLens,
  groupByCat,
  sevOfAnnotation,
  sevOfLens,
  sevOfLint,
  sortIssues,
  type UnifiedIssue,
} from "./issueModel";

/** テスト用の最小 annotation を作る（annotationMeta.test.ts と同型）。 */
function ann(
  partial: Omit<Partial<PostEffectAnnotation>, "metadata"> & {
    category: string;
    metadata?: unknown;
  },
): PostEffectAnnotation {
  return {
    id: "a1",
    projectId: "p1",
    runId: "r1",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart: 0,
    rangeEnd: 0,
    textSnapshot: null,
    persona: null,
    severity: null,
    content: "指摘タイトル",
    authorRole: "ai",
    parentId: null,
    status: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
    metadata:
      typeof partial.metadata === "string"
        ? partial.metadata
        : JSON.stringify(partial.metadata ?? {}),
  } as unknown as PostEffectAnnotation;
}

function diag(partial: Partial<Diagnostic> = {}): Diagnostic {
  return {
    rule_id: "ja/no-doubled-joshi",
    severity: "warning",
    message: "助詞が連続しています",
    range: { start: 0, end: 3 },
    ...partial,
  };
}

function lens(partial: Partial<SceneLensRecord> = {}): SceneLensRecord {
  return {
    id: "l1",
    projectId: "p1",
    runId: "r1",
    targetId: "s1",
    lensType: "pacing",
    metrics: {},
    finding: "中盤でテンポが落ちる",
    severity: "warning",
    createdAt: "2026-07-01T00:00:00.000Z",
    runCompletedAt: null,
    ...partial,
  };
}

/** sort / group / counts テスト用の最小 UnifiedIssue。 */
function issue(partial: Partial<UnifiedIssue> & { id: string }): UnifiedIssue {
  return {
    cat: "review",
    sev: "low",
    sceneId: "s1",
    title: "t",
    meta: null,
    excerpt: null,
    quote: null,
    compare: null,
    suggest: null,
    fixable: false,
    confidence: null,
    createdAt: null,
    source: { kind: "lint", sceneId: "s1", diag: diag() },
    ...partial,
  };
}

describe("severity 写像", () => {
  it("sevOfAnnotation: error→high / warning→mid / suggestion・info・null→low", () => {
    expect(sevOfAnnotation("error")).toBe("high");
    expect(sevOfAnnotation("warning")).toBe("mid");
    expect(sevOfAnnotation("suggestion")).toBe("low");
    expect(sevOfAnnotation("info")).toBe("low");
    expect(sevOfAnnotation(null)).toBe("low");
    expect(sevOfAnnotation(undefined)).toBe("low");
  });

  it("sevOfLint: error→high / warning→mid / info→low", () => {
    expect(sevOfLint("error")).toBe("high");
    expect(sevOfLint("warning")).toBe("mid");
    expect(sevOfLint("info")).toBe("low");
  });

  it("sevOfLens: error→high / warning→mid / suggestion・info→low", () => {
    expect(sevOfLens("error")).toBe("high");
    expect(sevOfLens("warning")).toBe("mid");
    expect(sevOfLens("suggestion")).toBe("low");
    expect(sevOfLens("info")).toBe("low");
  });
});

describe("category 写像", () => {
  it("対象 6 category を観点に写す", () => {
    expect(ANNOTATION_CATEGORY_TO_CAT.typo_anchor).toBe("typo");
    expect(ANNOTATION_CATEGORY_TO_CAT.consistency_anchor).toBe("consistency");
    expect(ANNOTATION_CATEGORY_TO_CAT.review).toBe("review");
    expect(ANNOTATION_CATEGORY_TO_CAT.intent_anchor).toBe("intent");
    expect(ANNOTATION_CATEGORY_TO_CAT.timeline_anchor).toBe("timeline");
    expect(ANNOTATION_CATEGORY_TO_CAT.impact_review_anchor).toBe("impact");
  });

  it("対象外 category は写像に無く fromAnnotation も null", () => {
    expect(ANNOTATION_CATEGORY_TO_CAT.pseudo_comment).toBeUndefined();
    expect(ANNOTATION_CATEGORY_TO_CAT.foreshadow_anchor).toBeUndefined();
    expect(ANNOTATION_CATEGORY_TO_CAT.theme_anchor).toBeUndefined();
    expect(fromAnnotation(ann({ category: "pseudo_comment" }))).toBeNull();
    expect(fromAnnotation(ann({ category: "foreshadow_anchor" }))).toBeNull();
    expect(fromAnnotation(ann({ category: "theme_anchor" }))).toBeNull();
  });
});

describe("fromAnnotation", () => {
  it("基本フィールド: id / cat / sev / sceneId / title / createdAt / source", () => {
    const a = ann({
      id: "ann-42",
      category: "review",
      severity: "error",
      content: "冒頭が冗長",
      sceneId: "scene-9",
      createdAt: "2026-07-02T10:00:00.000Z",
    });
    const issueRow = fromAnnotation(a);
    expect(issueRow).not.toBeNull();
    expect(issueRow?.id).toBe("ann:ann-42");
    expect(issueRow?.cat).toBe("review");
    expect(issueRow?.sev).toBe("high");
    expect(issueRow?.sceneId).toBe("scene-9");
    expect(issueRow?.title).toBe("冒頭が冗長");
    expect(issueRow?.createdAt).toBe("2026-07-02T10:00:00.000Z");
    expect(issueRow?.meta).toBeNull(); // review はメタ表示なし
    expect(issueRow?.source.kind).toBe("annotation");
    if (issueRow?.source.kind === "annotation") {
      expect(issueRow.source.ann).toBe(a);
      expect(issueRow.source.parsed.kind).toBe("review");
    }
  });

  it("excerpt: foundContext を foundText で分割し pre/mark/post、quote は textSnapshot 優先", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "review",
        textSnapshot: "スナップショット本文",
        metadata: {
          found_text: "そして",
          found_context: "夜が明けた。そして朝が来た。",
        },
      }),
    );
    expect(issueRow?.excerpt).toEqual({
      pre: "夜が明けた。",
      mark: "そして",
      post: "朝が来た。",
    });
    expect(issueRow?.quote).toBe("スナップショット本文");
  });

  it("excerpt 成功 + textSnapshot 無し: quote は foundContext", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "review",
        textSnapshot: null,
        metadata: {
          found_text: "そして",
          found_context: "夜が明けた。そして朝が来た。",
        },
      }),
    );
    expect(issueRow?.excerpt).not.toBeNull();
    expect(issueRow?.quote).toBe("夜が明けた。そして朝が来た。");
  });

  it("excerpt 不一致（foundText が foundContext に無い）: excerpt=null, quote=foundContext", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "review",
        textSnapshot: "スナップショット本文",
        metadata: {
          found_text: "存在しない語",
          found_context: "夜が明けた。そして朝が来た。",
        },
      }),
    );
    expect(issueRow?.excerpt).toBeNull();
    expect(issueRow?.quote).toBe("夜が明けた。そして朝が来た。");
  });

  it("excerpt 欠落（foundText 無し）: excerpt=null, quote=foundContext ?? textSnapshot", () => {
    const withContext = fromAnnotation(
      ann({
        category: "review",
        textSnapshot: "スナップショット本文",
        metadata: { found_context: "文脈のみ" },
      }),
    );
    expect(withContext?.excerpt).toBeNull();
    expect(withContext?.quote).toBe("文脈のみ");

    const snapshotOnly = fromAnnotation(
      ann({
        category: "review",
        textSnapshot: "スナップショット本文",
        metadata: {},
      }),
    );
    expect(snapshotOnly?.excerpt).toBeNull();
    expect(snapshotOnly?.quote).toBe("スナップショット本文");

    const nothing = fromAnnotation(
      ann({ category: "review", textSnapshot: null, metadata: {} }),
    );
    expect(nothing?.quote).toBeNull();
  });

  it("typo: suggest + fixable + meta(kind=typo) + confidence", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "typo_anchor",
        severity: "suggestion",
        metadata: {
          typo_ref: {
            category: "okurigana",
            found_text: "行なう",
            found_context: "式を行なう予定だ",
            suggestion: "行う",
            confidence: "high",
            llm_reason: "送り仮名",
            dismiss_key: "k1",
          },
        },
      }),
    );
    expect(issueRow?.cat).toBe("typo");
    expect(issueRow?.sev).toBe("low");
    expect(issueRow?.suggest).toEqual({
      found: "行なう",
      suggestion: "行う",
    });
    expect(issueRow?.fixable).toBe(true);
    expect(issueRow?.meta).toEqual({ kind: "typo", category: "okurigana" });
    expect(issueRow?.confidence).toBe("high");
    expect(issueRow?.excerpt).toEqual({
      pre: "式を",
      mark: "行なう",
      post: "予定だ",
    });
  });

  it("typo: suggestion が空なら suggest=null / fixable=false", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "typo_anchor",
        metadata: {
          typo_ref: {
            category: "other",
            found_text: "誤り",
            found_context: "誤りを含む文",
            suggestion: "",
            confidence: "low",
            llm_reason: "r",
            dismiss_key: "k1",
          },
        },
      }),
    );
    expect(issueRow?.suggest).toBeNull();
    expect(issueRow?.fixable).toBe(false);
  });

  it("consistency: compare（expected/found の値のみ）+ meta(kind=codex)", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "consistency_anchor",
        severity: "warning",
        metadata: {
          codex_ref: {
            entry_id: "e1",
            entry_name: "田中",
            source_field: "detail",
            detail_name: "年齢",
            expected_value: "17歳",
            found_value: "15歳",
            found_text: "十五歳",
            found_context: "彼は十五歳だった",
            confidence: "medium",
            llm_reason: "設定と不一致",
            dismiss_key: "k1",
          },
        },
      }),
    );
    expect(issueRow?.cat).toBe("consistency");
    expect(issueRow?.sev).toBe("mid");
    expect(issueRow?.compare).toEqual({
      leftLabel: "",
      left: "17歳",
      rightLabel: "",
      right: "15歳",
    });
    expect(issueRow?.meta).toEqual({
      kind: "codex",
      codex: {
        entryId: "e1",
        entryName: "田中",
        sourceField: "detail",
        sourceExcerpt: undefined,
        detailName: "年齢",
        expectedValue: "17歳",
        foundValue: "15歳",
      },
    });
    expect(issueRow?.confidence).toBe("medium");
    expect(issueRow?.fixable).toBe(false);
  });

  it("consistency: expected/found が欠けると compare=null（meta は codex のまま）", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "consistency_anchor",
        metadata: {
          codex_ref: {
            entry_id: "e1",
            entry_name: "田中",
            source_field: "summary",
            found_text: "x",
            found_context: "x を含む",
            confidence: "low",
            llm_reason: "r",
            dismiss_key: "k1",
          },
        },
      }),
    );
    expect(issueRow?.compare).toBeNull();
    expect(issueRow?.meta).toMatchObject({ kind: "codex" });
  });

  it("impact: compare(left=changeSummary, right=foundText) + meta(kind=impact)", () => {
    const issueRow = fromAnnotation(
      ann({
        category: "impact_review_anchor",
        metadata: {
          impact_ref: {
            entry_id: "e1",
            entry_name: "田中",
            change_id: "c1",
            change_summary: "年齢 15→17",
            contradiction_score: 0.9,
            found_text: "十五歳",
            found_context: "彼は十五歳だった",
            confidence: "high",
            llm_reason: "r",
            dismiss_key: "k1",
          },
        },
      }),
    );
    expect(issueRow?.cat).toBe("impact");
    expect(issueRow?.compare).toEqual({
      leftLabel: "",
      left: "年齢 15→17",
      rightLabel: "",
      right: "十五歳",
    });
    expect(issueRow?.meta).toEqual({ kind: "impact", entryName: "田中" });
  });

  it("intent / timeline: meta(kind=relation)、relation 欠落なら null", () => {
    const intent = fromAnnotation(
      ann({
        category: "intent_anchor",
        metadata: { relation: "contradicts", found_text: "x" },
      }),
    );
    expect(intent?.cat).toBe("intent");
    expect(intent?.meta).toEqual({ kind: "relation", relation: "contradicts" });

    const timeline = fromAnnotation(
      ann({
        category: "timeline_anchor",
        metadata: { relation: "chronology" },
      }),
    );
    expect(timeline?.cat).toBe("timeline");
    expect(timeline?.meta).toEqual({
      kind: "relation",
      relation: "chronology",
    });

    const noRelation = fromAnnotation(
      ann({ category: "intent_anchor", metadata: {} }),
    );
    expect(noRelation?.meta).toBeNull();
  });
});

describe("fromLintDiagnostic", () => {
  it("id / meta(kind=rule) / fixable=fix 有無 / createdAt=null", () => {
    const withFix = fromLintDiagnostic(
      "scene-1",
      3,
      diag({
        severity: "error",
        fix: {
          label: "修正",
          replacement: "は",
          range: { start: 0, end: 3 },
        },
      }),
    );
    expect(withFix.id).toBe("lint:scene-1:3:ja/no-doubled-joshi");
    expect(withFix.cat).toBe("linter");
    expect(withFix.sev).toBe("high");
    expect(withFix.sceneId).toBe("scene-1");
    expect(withFix.title).toBe("助詞が連続しています");
    expect(withFix.meta).toEqual({
      kind: "rule",
      ruleId: "ja/no-doubled-joshi",
    });
    expect(withFix.fixable).toBe(true);
    expect(withFix.createdAt).toBeNull();
    expect(withFix.excerpt).toBeNull();
    expect(withFix.quote).toBeNull();
    expect(withFix.compare).toBeNull();
    expect(withFix.suggest).toBeNull();

    const noFix = fromLintDiagnostic("scene-1", 0, diag({ severity: "info" }));
    expect(noFix.fixable).toBe(false);
    expect(noFix.sev).toBe("low");
    expect(noFix.source).toEqual({
      kind: "lint",
      sceneId: "scene-1",
      diag: diag({ severity: "info" }),
    });
  });
});

describe("fromSceneLens", () => {
  it("finding が null / 空文字 / 空白のみ なら行にしない", () => {
    expect(fromSceneLens(lens({ finding: null }))).toBeNull();
    expect(fromSceneLens(lens({ finding: "" }))).toBeNull();
    expect(fromSceneLens(lens({ finding: "  " }))).toBeNull();
  });

  it("finding あり: id / cat=meta / meta(kind=lens) / fixable=false", () => {
    const record = lens({
      id: "lens-7",
      severity: "error",
      lensType: "plot_structure",
      targetId: "scene-2",
    });
    const issueRow = fromSceneLens(record);
    expect(issueRow?.id).toBe("lens:lens-7");
    expect(issueRow?.cat).toBe("meta");
    expect(issueRow?.sev).toBe("high");
    expect(issueRow?.sceneId).toBe("scene-2");
    expect(issueRow?.title).toBe("中盤でテンポが落ちる");
    expect(issueRow?.meta).toEqual({
      kind: "lens",
      lensType: "plot_structure",
    });
    expect(issueRow?.fixable).toBe(false);
    expect(issueRow?.createdAt).toBe("2026-07-01T00:00:00.000Z");
    expect(issueRow?.source).toEqual({ kind: "lens", record });
  });
});

describe("sortIssues", () => {
  it("sev high→mid→low、次に createdAt 降順（null は最後）、次に id 昇順", () => {
    const input = [
      issue({ id: "e", sev: "low", createdAt: "2026-07-03T00:00:00.000Z" }),
      issue({ id: "b", sev: "high", createdAt: null }),
      issue({ id: "a", sev: "high", createdAt: "2026-07-01T00:00:00.000Z" }),
      issue({ id: "d", sev: "mid", createdAt: "2026-07-02T00:00:00.000Z" }),
      issue({ id: "c", sev: "high", createdAt: "2026-07-02T00:00:00.000Z" }),
    ];
    const sorted = sortIssues(input);
    expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("同 sev・同 createdAt は id 昇順", () => {
    const input = [
      issue({ id: "z", sev: "mid", createdAt: "2026-07-01T00:00:00.000Z" }),
      issue({ id: "y", sev: "mid", createdAt: "2026-07-01T00:00:00.000Z" }),
    ];
    expect(sortIssues(input).map((i) => i.id)).toEqual(["y", "z"]);
  });

  it("完全同値キーは入力順を保つ（安定）+ 非破壊", () => {
    const first = issue({ id: "same", title: "先" });
    const second = issue({ id: "same", title: "後" });
    const input = [first, second];
    const sorted = sortIssues(input);
    expect(sorted[0]).toBe(first);
    expect(sorted[1]).toBe(second);
    // 非破壊: 入力配列は変更されない
    expect(input).toEqual([first, second]);
    expect(sorted).not.toBe(input);
  });
});

describe("groupByCat", () => {
  it("CAT_ORDER 順に、空の観点を含めず、items は入力順のまま", () => {
    expect(CAT_ORDER).toEqual([
      "linter",
      "typo",
      "consistency",
      "impact",
      "review",
      "intent",
      "meta",
      "timeline",
    ]);
    const input = [
      issue({ id: "t1", cat: "timeline" }),
      issue({ id: "l1", cat: "linter" }),
      issue({ id: "t2", cat: "timeline" }),
      issue({ id: "c1", cat: "consistency" }),
    ];
    const groups = groupByCat(input);
    expect(groups.map((g) => g.cat)).toEqual([
      "linter",
      "consistency",
      "timeline",
    ]);
    expect(groups[2].items.map((i) => i.id)).toEqual(["t1", "t2"]);
  });

  it("空リストは空配列", () => {
    expect(groupByCat([])).toEqual([]);
  });
});

describe("deriveSevCounts", () => {
  it("重大度別の件数を数える", () => {
    const input = [
      issue({ id: "a", sev: "high" }),
      issue({ id: "b", sev: "high" }),
      issue({ id: "c", sev: "mid" }),
      issue({ id: "d", sev: "low" }),
    ];
    expect(deriveSevCounts(input)).toEqual({ high: 2, mid: 1, low: 1 });
    expect(deriveSevCounts([])).toEqual({ high: 0, mid: 0, low: 0 });
  });
});

describe("advanceFrom", () => {
  it("中間の項目からは次の項目へ", () => {
    expect(advanceFrom(["a", "b", "c"], "b", true)).toBe("c");
    expect(advanceFrom(["a", "b", "c"], "b", false)).toBe("c");
  });

  it("末尾からは先頭へ折り返す", () => {
    expect(advanceFrom(["a", "b", "c"], "c", true)).toBe("a");
    expect(advanceFrom(["a", "b", "c"], "c", false)).toBe("a");
  });

  it("removed=false で自分しか残っていなければ null（自分に戻らない）", () => {
    expect(advanceFrom(["a"], "a", false)).toBeNull();
  });

  it("removed=true で残り 1 件ならそれを選ぶ / 自分のみなら null", () => {
    expect(advanceFrom(["a", "b"], "a", true)).toBe("b");
    expect(advanceFrom(["a", "b"], "b", true)).toBe("a");
    expect(advanceFrom(["a"], "a", true)).toBeNull();
  });

  it("id が order に無ければ null", () => {
    expect(advanceFrom(["a", "b"], "x", true)).toBeNull();
    expect(advanceFrom([], "x", false)).toBeNull();
  });
});
