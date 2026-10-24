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
