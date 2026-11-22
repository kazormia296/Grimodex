# 年表の位置の印と視点の人物（CPL/1）の実装の判断の記録

- 契約：`nir1-chronicle-position-label-proposal/1`（CPL/1）。本文は [nir1-chronicle-position-label-design-draft.md](../nir1-chronicle-position-label-design-draft.md)、台帳は [nir1-l6-l9-execution-plan.md](../nir1-l6-l9-execution-plan.md) の「2026-11-22補足」。
- この lane は、NIR-1 の残レーンの委任の外である。規則・残る制限・脅威モデルは、ユーザーが確認した。この文書は、確認された本文の範囲内の、実装の技術判断を記す。規則を変える判断は、ここに書かず、ユーザーに伺う。
- 起案の本文は、台帳に取り込んだ後は変えない。起案の事実と、実装の基点のコードの違いは、ここに記す。
- この版が扱うのは、§4.1 の 1（視点の人物。V1・V2）だけである。§4.1 の 2 以降（位置の印、自動のまとめ、道具の返り値と説明）は、別の PR で、この文書に足す。

## 1. 実装の前の読み直し（2026-11-22）

起案の §6 が言う「実装の前に、基点のコードを読み直す」を、V1・V2 について行った。読み直しは read-only で、実行はしていない。結果は、repo の外の `design-notes/editor-scene-interpretation-2026-11-21/wf28.json` の `cpl-pov` にある。基点は古い `master` `8a683b45` だったので、実装の着手時の基点（`master` `e1aa06ec`。その後 `469a6b77` を取り込んだ）で、行と事実を読み直した。

- 場面の視点は、`tree_nodes.pov_character_id`（Codex の id）に保存される。チャットの場面の文脈（L3「現在のシーン」）には、題・時期・あらすじ・狙いだけが出ていて、場面の視点は出ていない。
- 場面の視点を使うのは、予定ビートの節（`buildPendingBeatsSection`）だけである。ビートの視点が場面の視点と違うときにだけ名前を付け、名前は `contextEligibleIds` で絞る。
- 場面の文脈を組み立てる箇所（`collectSceneContext`）は、場面の tree node と、Phase を今の場面で解決した Codex の索引（`effectiveIndexById`）を同じ関数の中に持つ。新しい DB の読みは要らない。
- 作品の視点（`projects.pov`、自由記述）は、L1 に「視点: …」として既に渡る。label `pov` は、これ専用である。

## 2. 判断

### DR-CPL-1　契約の範囲（V1・V2 の読み）

- V1：チャットの場面の文脈（L3）に、場面に設定した視点の人物の名前を、「この場面の視点」（en は「POV of this scene」）の 1 行として足す。視点が無い場面は、何も足さない。
- V2：視点の人物の Codex の項目が、今の場面の時点（Phase 解決後）で hidden なら、渡さない。項目が Codex に無いときも、渡さない。渡すのは名前だけで、要約・本文は渡さない。
- 起案の文のとおり、渡さないのは、hidden の人物と、Codex に無い人物だけである（確認 82。DR-CPL-2）。

### DR-CPL-2　渡す条件は、規則どおり（hidden と、Codex に無い人物だけ渡さない）

- 経緯：最初の実装は、名前を引いて渡してよいかの判定を、同じ場面の予定ビートの視点の名前と同じ集合（`contextEligibleIds`）に合わせていた。これは V2 より狭く、Codex で「AI の文脈に入れない」（suppress。明示のピン無し）にした人物や、このターンで自動から外した人物（`excludedAutoEntryIds`）の名前も、渡していなかった。ユーザーが、規則どおり、と決めた（確認 82、2026-11-22。原文は `user-confirmation-2026-11-22-chronicle-scene-review-apply.md` の末尾）。この版で、その決定に直した。
- 渡す条件：視点の id が、その project の Codex の索引（`effectiveIndexById`。場面の Phase を解決した後）にあり、解決後の contextMode が hidden でないこと。次は、条件にしない：suppress かどうか、このターンの自動除外（`excludedAutoEntryIds`）、明示のピンの有無。
  - 「AI の文脈に入れない」設定の人物でも、場面の視点に設定してあれば、名前は渡す。項目の中身（summary・content）は、ここでは渡さない。視点の人物の項目を、L4 の候補に足したり、relation の起点にしたりもしない（名前の 1 行だけ）。
  - 索引に無い id（視点の id が、他の project の Codex 項目や、削除された項目を指す場合）は、名前が引けず、渡さない。なお、索引そのものに他の project の行が混ざる場合は、この条件ではなく、既存の `collectSceneContext` の throw（foreign-project row）が文脈全体を止める。
  - 名前が空白だけの項目も、行を出さない。
- hidden の判定：`isCodexContextModeHiddenFromAi`（`codexVisibilityPolicy`。agent tool・beat・map の AI 文脈と同じ正本）を使う。`canExposeResolvedCodexIdentity` は使えない：どの `reason` でも suppress を除くので、suppress の視点を渡す、確認 82 の決定に合わない。
- 読めない contextMode（壊れた値）：`isCodexContextModeHiddenFromAi` は hidden と同じく落とす。hidden かどうかを判定できないので、渡さない（fail-closed）。V2 の字面（hidden なら渡さない）に対し、判定できない値だけ hidden と同じに扱う技術判断である。通常の値（hidden・suppress・mentioned・always）では、規則どおりである。
- 予定ビートの視点（`buildPendingBeatsSection`）：今も `contextEligibleIds` の判定で、この PR では変えない（範囲の外）。このため、同じ場面の中で、suppress の人物は、予定ビートの視点としては出ず、場面の視点としては出る、という差がある。これは、確認 82 が認めた差である。
- 起案の脅威モデル L2（§3）との関係：渡すのは名前だけで、hidden は渡さない。送信先・保存の範囲・閾値は動かない。
- 判定の固定：`sceneContextSource.test.ts` に、suppress（ピン無し／ピンあり。中身は出ない）、このターンの自動除外、hidden、Phase で hidden になった人物、Phase で hidden が解けた人物、索引に無い id、読めない contextMode、視点なしの場面、場面でない node、空白の名前を入れた。Phase の上書きがあっても名前が変わらない試験も 1 件ある（`name` は Phase で変わらない。`materializeResolvedCodexContext` は name を触らない）。

### DR-CPL-3　描画の場所と形

- `SceneContext` に、任意の欄 `povName` を足す。L3 の `hasRealScene` の中で、時期（`storyTimeLabel`）の後、あらすじ（`synopsis`）の前に 1 行を足す。空白だけの値は、行を出さない。名前は `trim` する。
- 行の組み立ては、新しい小さな file（`src/prompts/shared/sceneL3Lines.ts`。時期と視点の 2 行。時期の出力は変えない）に置いた。`contextBuilder.ts` は、大きい module の行数の上限（`policies/architecture/large-module-debt.json`、2389 行）に張り付いていて、増やせないためである。上限は、動かしていない。置き場を `src/prompts/shared/` にしたのは、変更の影響の選択（`evals/impact-map.yaml`）が、すでに分類している path で、新しい file が全 suite の fallback を起こさないためである。
- 名前は、改行・連続空白を 1 つの空白に畳み（作者指定の Codex リンクの `entryName` と同じ。名前の途中の改行が L3 の新しい行や偽の `### シーン本文` の見出しにならないため）、200 コードポイントで切る（技術判断。`SCENE_POV_NAME_MAX_CODE_POINTS`。200 字を超える名前は、200 字で切って渡す）。L3 の「題の行から本文の見出しまで」は trim できない先頭なので、Codex の名前に長さの上限が無いと、とても長い名前が予算を超え、場面の本文ごと L3 が落ちるためである。上限は、人物の名前として十分に長い値で、通常の名前は変わらない。渡す内容は名前だけで、範囲は広がらない。
- 名前の escape は、場面の題・あらすじと同じで、L3 全体を `wrapDataLayer` が包むときの、予約タグの escape に任せる。名前だけの個別の escape は足さない。
- label は、`labels.pov`（L1 の作品の視点）と別に、`labels.scenePov` を ja・en の両方に足す。ja は「この場面の視点」。L1 の trim の印（`\n視点:`）に、この行は当たらない（行頭が違う）。
- 視点を設定していない場面の出力は、byte 同一である。固定した期待値（`legacyReadGolden`、`nir1-df06-plain-chat.json` ほか）は、1 つも変えない。`chatSystemBase.txt` と `chatSystemDataBoundaryReminder.txt` は、触らない。
- `povName` は、場面の文脈のソース（`collectSceneContext`）だけが置く。入力の snapshot の場面が `povName` を持っていても、必ず、gate の結果で置き換える（信頼しない）。
- フォルダ・作品の集約の擬似場面（`nonSceneContextSource`）には、置かない。codex・snippet のスコープの空の場面にも、出ない（`hasRealScene` の外）。
- 場面の視点の読みは、予定ビートと同じく、場面の tree node（`currentScene.povCharacterId`。live の tree）から取る。request の immutable な snapshot（`fetchSceneContext`）に `povCharacterId` を足す案は、`chatContextPreparationComposition.ts` を触るので、この PR では採らなかった。これは、送信の時点の tree に追従する、予定ビートの視点と同じ読みである。

### DR-CPL-4　範囲の外に置いたもの

- ビート生成（`buildBeatContext.ts` の `povName`）の hidden 判定：今も、hidden の人物の名前を、判定なしで provider に送っている（ADR 013 が「beat の povName」として残漏れに挙げる）。V2 を、チャットだけに入れると、規則が経路で食い違う。直すと、送信は狭まる向きである。別 commit／別 PR で、`visibleCodexForAi`（Phase 解決後）に通し、hidden なら `null` にする。起案の §1.2 の「場面の視点は渡していない」は、「チャットの場面の文脈では」と限って読む。
- 集約スコープの予定ビート（`chatContextPreparationComposition.ts` の `resolveCharacterName`）：名前の解決が `allEntries` の無絞り込みである。同じ判定に揃えるかは、別に決める。
- `docs/CONTEXT_INJECTION.md`：L3 の表、データソースの表、hidden の節に、場面の視点を足す。未分類の path で、同じ PR に入れると、変更の影響の選択が全 suite の fallback になる。docs だけの別の PR にする。
- 年表の自動のまとめ、道具の返り値と説明、位置の印（CPL/1 の残り）。
- Rust の側（`electron/native/grimodex-node/src/nir1_prepared_request.rs`）：`<current_scene>` を自前で組むが、製品の chat に IR は未接続である。L3 の視点の行を写す必要があるかは、調べていない。IR を接続するときに、決める。

## 3. 検証

- focused の試験：`contextBuilder.test.ts`（視点あり＝あらすじの前・時期の後／なし・空白＝byte 同一／ja・en／予約タグ風の名前の escape／L1 の作品の視点と別の行／空の場面）、`sceneContextSource.test.ts`（DR-CPL-2 の判定の固定。変異の確認：hidden の判定を外すと hidden・Phase で hidden・読めない mode の試験が落ち、条件を `contextEligibleIds` に戻すと suppress・自動除外の試験が落ちる。確かめた後、戻した）、`nonSceneContextSource.test.ts`（集約の擬似場面に出ない）。
- 視点を設定していない場面で、既にある期待値を書き換えていない。
