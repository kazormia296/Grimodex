# ユーザーの指示と回答の記録：minimatch の Dependabot の警告（2026-11-04）

- 指示（原文）：**「並行してminimatchの更新も進めて」**
- 調べた事実：警告 #109（GHSA-g3hv-75wg-m249、medium、DoS「globparts amplification」、2026-11-03 作成）。直った版は 11.0.1 だけ（`minimatch < 11.0.1`）。pnpm-lock には 3.1.5／5.1.9／9.0.9／10.2.5 があり、引いているのは electron-builder 系（@electron/asar、@electron/universal、dir-compare、filelist、glob@7）と eslint 系（eslint-plugin-jsx-a11y、@eslint/config-array）の開発用の依存だけ。上流の最新版（@electron/asar 4.3.1 は ^10、filelist 2.0.2 は ^10、eslint-plugin-jsx-a11y 6.10.2 は ^3、dir-compare 5.0.0 は ^3）も 11 を要求しない。3.x／5.x と 9 以降は API が違い（関数の export と名前付き export）、全部を 11 に強制すると build の道具が壊れる危険がある。
- 質問「minimatch の警告（…）をどうしますか？」（選択肢：警告を理由つきで閉じる (推奨)／互換な版だけ上げる／全部 11 に強制する）→ **回答：「警告を理由つきで閉じる (推奨)」**
- 実行：`gh api -X PATCH repos/kazormia296/Grimodex/dependabot/alerts/109 -f state=dismissed -f dismissed_reason=tolerable_risk -f dismissed_comment="Dev tooling only (electron-builder deps, eslint-plugin-jsx-a11y); patterns are developer-authored, not in shipped runtime. Only fix is 11.0.1 and latest upstreams still require ^3/^10. Revisit when upstream adopts 11."`。結果：#109 は dismissed（tolerable_risk）。開いている Dependabot の警告は 0。依存は変えていない。
- 残す宿題：上流（electron-builder、eslint-plugin-jsx-a11y、dir-compare）が minimatch 11 に移ったら上げる。
