import type { WorkLayerModel, WorkLayerPort } from "./types";

export const WORK_LAYER_FIXTURE: WorkLayerModel = {
  scopeId: "work-layer-preview",
  focus: {
    id: "work-dungeon",
    title: "地下牢の改稿",
    authorTasks: [
      {
        id: "task-timeline",
        title: "東西分断後の時系列を確認",
        completed: false,
      },
    ],
    later: [
      {
        id: "work-blue-sword",
        title: "伏線『青い剣』の回収位置を再確認",
      },
      { id: "work-east-west", title: "東西分断後の時系列を確認" },
    ],
  },
  attention: [
    {
      id: "finding-binding",
      groupLabel: "Scene 12 改稿",
      kind: "ambiguous-identity",
      title: "『アリス』の参照先が曖昧",
      summary: "本文の表記が2件のCodex候補に一致しています。",
      source: {
        label: "Scene 12 · ¶2",
        excerpt: "アリスは鍵を拾い、地下牢を出た。",
      },
      reason: "Surface『アリス』が2件の候補に一致",
      previousValue: "Binding なし",
      candidates: [
        { id: "alice-rain", label: "アリス・レイン", meta: "登場 12 Scene" },
        { id: "alice-hague", label: "アリス・ハーグ", meta: "登場 3 Scene" },
      ],
      impact: ["Chronicle Event『脱獄』", "Related Scenes · 4件"],
      states: {
        review: "未判断",
        freshness: "曖昧",
        projection: "未適用",
      },
      materialChain: [
        "Source · Scene 12 v48",
        "Anchor · ¶2",
        "Assertion · entity-binding@1",
        "Edge · source-evidence",
        "Freshness · ambiguous",
        "Finding · ambiguous-identity",
      ],
      systemWork: {
        runId: "run-8f31",
        taskLabel: "recheck",
        attemptLabel: "attempt 1",
        authority: "Workspace authority",
        epoch: "42",
      },
    },
    {
      id: "finding-evidence",
      groupLabel: "Scene 12 改稿",
      kind: "source-missing",
      title: "Chronicle『脱獄』のEvidenceが見つからない",
      summary: "承認済みの構造は保持され、根拠だけが古くなっています。",
      source: { label: "Scene 12 · 旧¶2", excerpt: null },
      reason: "以前のAnchorが現在の本文に存在しない",
      previousValue: "Evidence · Scene 12 v47 ¶2",
      candidates: [],
      impact: ["Chronicle Event『脱獄』", "Timeline 再評価"],
      states: {
        review: "承認済み · V1",
        freshness: "根拠消失",
        projection: "適用済み · V1",
      },
      materialChain: [
        "Source · Scene 12 v48",
        "Anchor · missing",
        "Assertion · scene-event@1",
        "Edge · evidence",
        "Freshness · source-missing",
        "Finding · evidence-stale",
      ],
      systemWork: {
        runId: "run-8f31",
        taskLabel: "verify",
        attemptLabel: "attempt 1",
        authority: "Workspace authority",
        epoch: "42",
      },
    },
  ],
  disposedAttention: [
    {
      id: "finding-snoozed",
      title: "表記ゆれの再確認",
      disposition: "snoozed",
    },
    {
      id: "finding-held",
      title: "Timeline矛盾の作者判断",
      disposition: "held",
    },
    {
      id: "finding-dismissed",
      title: "処分済みのFinding",
      disposition: "dismissed",
    },
    {
      id: "finding-legacy",
      title: "旧識別のAttention",
      disposition: "legacy",
    },
  ],
  allWork: [
    {
      id: "work-dungeon",
      title: "地下牢の改稿",
      status: "active",
      detail: "タスク 1/2 · Scene 12",
      tag: "NOW",
      updatedLabel: "2日前〜",
    },
    {
      id: "work-blue-sword",
      title: "伏線『青い剣』の回収位置を再確認",
      status: "waiting",
      detail: "Codex: 青い剣",
      updatedLabel: "昨日",
    },
    {
      id: "work-east-west",
      title: "東西分断後の時系列を確認",
      status: "waiting",
      detail: "Chronicle: 分断",
      updatedLabel: "3日前",
    },
    {
      id: "work-alisa",
      title: "『アリサ』の表記ゆれ疑い",
      status: "held",
      tag: "SNOOZE",
      updatedLabel: "再浮上 3日後",
    },
    {
      id: "work-escape-evidence",
      title: "Chronicle『脱獄』のEvidence消失",
      status: "held",
      tag: "HOLD",
      updatedLabel: "作者判断",
    },
    {
      id: "work-legacy",
      title: "旧識別のAttention 1件",
      status: "held",
      tag: "LEGACY",
      updatedLabel: "EPOCH 38",
    },
    {
      id: "work-chapter-title",
      title: "第二部の章タイトル見直し",
      status: "completed",
      updatedLabel: "昨日",
    },
    {
      id: "work-guard-name",
      title: "看守の名前を統一",
      status: "completed",
      updatedLabel: "4日前",
    },
    {
      id: "work-prologue-pov",
      title: "序章の視点を三人称に変更",
      status: "completed",
      updatedLabel: "先週",
    },
  ],
  batchProposals: [
    {
      id: "proposal-key",
      title: "scene-event 追加『鍵の入手』",
      detail: "¶2",
      eligible: true,
      reason: "新規追加 · Evidence anchored · 重複なし",
    },
    {
      id: "proposal-escape",
      title: "scene-event 追加『牢からの脱出』",
      detail: "¶2",
      eligible: true,
      reason: "新規追加 · Evidence anchored · 重複なし",
    },
    {
      id: "proposal-state",
      title: "state 変化『アリス: 幽囚 → 逃亡』",
      detail: "Scene 12",
      eligible: true,
      reason: "既存状態と矛盾なし",
    },
    {
      id: "proposal-relation",
      title: "relation『アリス — 地下牢: 脱出』",
      detail: "Scene 12",
      eligible: true,
      reason: "Evidence anchored · 重複なし",
    },
    {
      id: "proposal-rewrite",
      title: "event 変更『脱獄』手段の書換",
      detail: "Chronicle『脱獄』",
      eligible: false,
      reason: "承認済みV1と矛盾",
    },
    {
      id: "proposal-binding",
      title: "entity binding『アリス』",
      detail: "Scene 12",
      eligible: false,
      reason: "候補2件",
    },
  ],
  system: {
    state: "idle",
    label: "idle",
    activities: [
      {
        id: "activity-source-change",
        label: "Source change",
        detail: "Scene 12 v48",
        state: "completed",
      },
      {
        id: "activity-recheck",
        label: "Recheck",
        detail: "2 Findings",
        state: "running",
      },
      {
        id: "activity-projection",
        label: "Projection",
        detail: "Author review待ち",
        state: "queued",
      },
    ],
    blockedReason: "Scope authorityを確認できませんでした。",
    staleImpact:
      "既存の承認済み構造を保持し、新しい結果だけを古い状態として扱います。",
  },
};

export function createWorkLayerFixturePort(): WorkLayerPort {
  return {
    async load() {
      return WORK_LAYER_FIXTURE;
    },
  };
}
