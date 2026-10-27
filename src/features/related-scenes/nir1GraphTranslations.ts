import i18next from "@/lib/i18n";

/**
 * The strings of the Related Scenes Graph UI (CP-3b), keyed under
 * `relatedScenes.graph`.
 *
 * They live in the lazy chunk of the Graph view rather than in
 * `src/locales/*.json`, so that while `NIR1_GRAPH_UI_ENABLED` is false they are
 * not part of the startup JS graph (DR-CP3B-7; the same pattern as
 * `bodyDeclarationTranslations.ts`, DR-CB3-35).
 */
export const NIR1_GRAPH_TRANSLATIONS = {
  ja: {
    graphOnlyMark: "Graph",
    graphOnlyMarkLabel: "Graph が関係づけた Scene",
    pathHeading: "Graph の経路",
    pathHop: "{{hop}} 段",
    relationEvidence: "関係の根拠",
    directed: "一方向",
    symmetric: "双方向",
    directionUnknown: "方向不明",
    bodyExcerpt: "本文の該当箇所",
    openExcerpt: "本文の該当箇所を開く",
    restartRequired:
      "Graph は Grimodex を再起動するまで使えません。保存できていない編集があれば、再起動の前に内容を控えてください。",
    // 起点の表示と候補（DR-SEEDSUG-4：暫定の文言。PUB-G で別に承認する）。
    seedLabel: "起点:",
    seedCandidatesHeading: "起点の候補",
    seedCandidatesHint:
      "Graph はこの Scene の起点の項目から関係をたどります。起点にする項目を選んでください。",
    seedNone:
      "起点がありません。Matrix でこの Scene に Codex の項目を pin すると、Graph が使えます。",
    seedReasonPov: "視点人物",
    seedReasonBeatActor: "ビートの行為者",
    seedReasonBody: "本文の言及",
    seedUse: "起点にする",
    seedUseLabel: "{{name}} を起点にする",
    seedPinFailed: "起点を保存できませんでした。もう一度お試しください。",
  },
  en: {
    graphOnlyMark: "Graph",
    graphOnlyMarkLabel: "A Scene related by Graph",
    pathHeading: "Graph path",
    pathHop: "{{hop}} hop",
    relationEvidence: "Relation evidence",
    directed: "one-way",
    symmetric: "two-way",
    directionUnknown: "direction unknown",
    bodyExcerpt: "Body excerpt",
    openExcerpt: "Open this part of the body",
    restartRequired:
      "Graph is unavailable until Grimodex restarts. If any edits could not be saved, copy them down before restarting.",
    seedLabel: "Starting point:",
    seedCandidatesHeading: "Starting point candidates",
    seedCandidatesHint:
      "Graph follows relations from this Scene's starting point. Choose an entry to start from.",
    seedNone:
      "No starting point. Pin a Codex entry to this Scene in the Matrix to use Graph.",
    seedReasonPov: "POV character",
    seedReasonBeatActor: "Beat actor",
    seedReasonBody: "Mentioned in the body",
    seedUse: "Use as starting point",
    seedUseLabel: "Use as starting point: {{name}}",
    seedPinFailed: "The starting point could not be saved. Please try again.",
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureNir1GraphTranslations(): void {
  if (installed) return;
  for (const [language, graph] of Object.entries(NIR1_GRAPH_TRANSLATIONS)) {
    i18next.addResourceBundle(
      language,
      "translation",
      { relatedScenes: { graph } },
      true,
      true,
    );
  }
  installed = true;
}
