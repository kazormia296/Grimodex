import i18next from "@/lib/i18n";

/**
 * Strings of the project Scene Scope default screens that live only in lazy
 * chunks (settings, import, chapter dialog, related-scene guidance). They are
 * kept out of the startup locale files so the startup graph stays inside its
 * budget (DR-SDEF-52, the same pattern as DR-CB3-35). The Scope field's own
 * strings stay in `ja.json`／`en.json`.
 */
export const SCENE_SCOPE_DEFAULT_TRANSLATIONS = {
  ja: {
    settings: {
      project: {
        sceneScopeDefault: "新しい場面の Scope の既定",
        sceneScopeDefaultHint:
          "新しく作る場面は、この Scope で作られます。回想・夢・別の世界線・作中作の場面は、作ったあと場面ごとに変えてください。既定を変えても、既にある場面は変わりません。取り消し・やり直し・ゴミ箱・スナップショットで戻した場面、外部フォルダから同期した場面、取り込んだ場面は未設定になります（取り込みは画面で選べば、取り込みのあとに既定を当てます）。",
        sceneScopeDefaultNone: "既定なし（新しい場面は未設定）",
        sceneScopeDefaultSet: "既定を使う",
        sceneScopeDefaultSave: "既定を保存",
        sceneScopeDefaultSaved: "Scope の既定を保存しました",
        sceneScopeNoVocabulary:
          "このプロジェクトにはまだ Scope の語彙がありません。最初の場面を作ると選べるようになります。",
        sceneScopeRefUnregistered:
          "選んだ値が Scope の語彙にありません。場面の Scope 欄の「Scope の語彙」で追加してから選んでください。",
        sceneScopeRegistryWarning:
          "この値は Scope の語彙にありません。使うには、先に場面の Scope 欄の「Scope の語彙」で追加してください。語彙に追加すると、このプロジェクトの承認済みの解釈と本文の宣言がすべて失効し、作り直しが必要になります。",
        sceneScopeDefaultInvalid:
          "このプロジェクトの Scope の既定の記録を読めません。既定は使われず、新しい場面は未設定で作られます。",
        sceneScopeDefaultConflict:
          "ほかの画面で既定が変わりました。読み直した値を確かめてください。",
        sceneScopeApplyUnset: "未設定の場面に既定を当てる",
        sceneScopeApplyLegacy: "以前からの場面にも既定を当てる",
        sceneScopeApplyConfirm:
          "{{count}} 件の場面にプロジェクトの既定（{{value}}）を当てます。当てた場面に結びついた承認済みの解釈と本文の宣言は失効します。",
        sceneScopeApplyNone: "当てる対象の場面はありません。",
        sceneScopeApplyResult:
          "{{applied}} 件に当てました。{{failed}} 件は当てられませんでした。",
        sceneScopeApplyNoDefault:
          "Scope の既定が無いので当てられません。設定 > プロジェクトで既定を選んでください。",
        sceneScopeMainLine: "本筋",
        sceneScopeApplyNeedsSave:
          "選んだ既定はまだ保存されていません。当てる前に保存してください。",
      },
    },
    import: {
      sceneScopeApplyDefault:
        "取り込みのあと、取り込んだ場面にプロジェクトの既定の Scope を当てる（回想などが含まれる場合は、あとで場面ごとに変えてください）",
      sceneScopeApplyNewProject:
        "新しいプロジェクトには Scope の既定がありません。取り込んだあと、設定 > プロジェクトで既定を選び、「未設定の場面に既定を当てる」を使ってください。",
      sceneScopeApplyNoDefault:
        "今のプロジェクトには Scope の既定がありません。",
      sceneScopeApplyValue: "当てる値：{{value}}",
      sceneScopeApplyChanged:
        "取り込みの間に Scope の既定が変わったため、取り込んだ場面には当てませんでした。設定 > プロジェクトから当ててください。",
    },
    relatedScenes: {
      scopeUnknown:
        "この場面の Scope が未設定のため、承認済みの解釈は出ません。取り消し・やり直し・ゴミ箱・スナップショットで戻した場面や、取り込んだ場面は未設定になります。",
      scopeUnresolved:
        "この場面の Scope に未解決の軸があるため、承認済みの解釈は出ません。",
      scopeOpen: "Scope を設定",
      scopeApplyDefault: "既定を当てる",
      scopeLegacy:
        "この場面は以前からの場面で、Scope がまだ設定されていないため、承認済みの解釈は出ません。Scope 欄で設定してください。",
      scopeApplied:
        "既定の Scope を当てました。関連場面は、次に開き直したとき（場面を切り替えたときなど）に新しい Scope で検索されます。",
    },
  },
  en: {
    settings: {
      project: {
        sceneScopeDefault: "Default scope for new scenes",
        sceneScopeDefaultHint:
          "New scenes start with this scope. For flashbacks, dreams, other worldlines or stories within the story, change the scope of each scene after creating it. Changing the default does not change existing scenes. Scenes brought back by undo, redo, the trash or a snapshot, scenes synced from an external folder, and imported scenes start unset (for imports, you can choose to apply the default after importing).",
        sceneScopeDefaultNone: "No default (new scenes start unset)",
        sceneScopeDefaultSet: "Use a default",
        sceneScopeDefaultSave: "Save default",
        sceneScopeDefaultSaved: "Saved the default scope",
        sceneScopeNoVocabulary:
          "This project has no scope vocabulary yet. Create the first scene to choose a default.",
        sceneScopeRefUnregistered:
          'The chosen value is not in the scope vocabulary. Add it under "Scope registry" in a scene\'s scope field first.',
        sceneScopeRegistryWarning:
          'This value is not in the scope vocabulary. To use it, first add it under "Scope registry" in a scene\'s scope field. Adding it invalidates every approved interpretation and body declaration in this project; they must be recreated.',
        sceneScopeDefaultInvalid:
          "The default scope record of this project cannot be read. No default is used and new scenes start unset.",
        sceneScopeDefaultConflict:
          "The default changed elsewhere. Check the reloaded value.",
        sceneScopeApplyUnset: "Apply the default to unset scenes",
        sceneScopeApplyLegacy: "Apply the default to earlier scenes",
        sceneScopeApplyConfirm:
          "This applies the project default ({{value}}) to {{count}} scenes. Approved interpretations and body declarations tied to those scenes are invalidated.",
        sceneScopeApplyNone: "There are no scenes to apply the default to.",
        sceneScopeApplyResult:
          "Applied to {{applied}} scenes. {{failed}} could not be applied.",
        sceneScopeApplyNoDefault:
          "There is no default scope to apply. Choose one in Settings > Project.",
        sceneScopeMainLine: "Main line",
        sceneScopeApplyNeedsSave:
          "The chosen default is not saved yet. Save it before applying.",
      },
    },
    import: {
      sceneScopeApplyDefault:
        "After importing, apply the project default scope to the imported scenes (if they include flashbacks or similar, change those scenes afterwards)",
      sceneScopeApplyNewProject:
        'A new project has no default scope. After importing, choose one in Settings > Project and use "Apply the default to unset scenes".',
      sceneScopeApplyNoDefault: "The current project has no default scope.",
      sceneScopeApplyValue: "Value to apply: {{value}}",
      sceneScopeApplyChanged:
        "The default scope changed during the import, so it was not applied to the imported scenes. Apply it from Settings > Project.",
    },
    relatedScenes: {
      scopeUnknown:
        "Approved interpretations do not appear because this scene's scope is unset. Scenes brought back by undo, redo, the trash or a snapshot, and imported scenes, start unset.",
      scopeUnresolved:
        "Approved interpretations do not appear because this scene's scope has an unresolved axis.",
      scopeOpen: "Set the scope",
      scopeApplyDefault: "Apply the default",
      scopeLegacy:
        "This is an earlier scene whose scope is not set yet, so approved interpretations do not appear. Set it in the scope field.",
      scopeApplied:
        "The default scope was applied. Related scenes are searched with the new scope the next time they are opened (for example, after switching scenes).",
    },
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureSceneScopeDefaultTranslations(): void {
  if (installed) return;
  for (const [language, resources] of Object.entries(
    SCENE_SCOPE_DEFAULT_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(language, "translation", resources, true, false);
  }
  installed = true;
}

ensureSceneScopeDefaultTranslations();
