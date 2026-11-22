# 年表の位置の印と視点の人物（CPL/1）の実装の判断の記録

- 契約：`nir1-chronicle-position-label-proposal/1`（CPL/1）。本文は [nir1-chronicle-position-label-design-draft.md](../nir1-chronicle-position-label-design-draft.md)、台帳は [nir1-l6-l9-execution-plan.md](../nir1-l6-l9-execution-plan.md) の「2026-11-22補足」。
- この lane は、NIR-1 の残レーンの委任の外である。規則・残る制限・脅威モデルは、ユーザーが確認した。この文書は、確認された本文の範囲内の、実装の技術判断を記す。規則を変える判断は、ここに書かず、ユーザーに伺う。
- 起案の本文は、台帳に取り込んだ後は変えない。起案の事実と、実装の基点のコードの違いは、ここに記す。
- この版が扱うのは、§4.1 の 1（視点の人物。V1・V2）だけである。§4.1 の 2 以降（位置の印、自動のまとめ、道具の返り値と説明）は、別の PR で、この文書に足す。

## 1. 実装の前の読み直し（2026-11-22）

起案の §6 が言う「実装の前に、基点のコードを読み直す」を、V1・V2 について行った。読み直しは read-only で、実行はしていない。結果は、repo の外の `design-notes/editor-scene-interpretation-2026-11-21/wf28.json` の `cpl-pov` にある。基点は古い `master` `8a683b45` だったので、実装の基点（`master` `e1aa06ec`）で、行と事実を読み直した。

- 場面の視点は、`tree_nodes.pov_character_id`（Codex の id）に保存される。チャットの場面の文脈（L3「現在のシーン」）には、題・時期・あらすじ・狙いだけが出ていて、場面の視点は出ていない。
- 場面の視点を使うのは、予定ビートの節（`buildPendingBeatsSection`）だけである。ビートの視点が場面の視点と違うときにだけ名前を付け、名前は `contextEligibleIds` で絞る。
- 場面の文脈を組み立てる箇所（`collectSceneContext`）は、場面の tree node と、Phase を今の場面で解決した Codex の索引（`effectiveIndexById`）を同じ関数の中に持つ。新しい DB の読みは要らない。
- 作品の視点（`projects.pov`、自由記述）は、L1 に「視点: …」として既に渡る。label `pov` は、これ専用である。

## 2. 判断

### DR-CPL-1　契約の範囲（V1・V2 の読み）

- V1：チャットの場面の文脈（L3）に、場面に設定した視点の人物の名前を、「この場面の視点」（en は「POV of this scene」）の 1 行として足す。視点が無い場面は、何も足さない。
- V2：視点の人物の Codex の項目が、今の場面の時点（Phase 解決後）で hidden なら、渡さない。項目が Codex に無いときも、渡さない。渡すのは名前だけで、要約・本文は渡さない。
- 起案の文は、「hidden なら渡さない」という必要条件である。この PR は、これを満たし、さらに DR-CPL-2 の理由で、より狭く渡す。起案より広く渡すことはしない。

### DR-CPL-2　gate は、予定ビートの視点と同じ判定（`contextEligibleIds`）にする

- 名前を引いて渡してよいかの判定は、同じ場面の予定ビートの視点の名前と同じ集合（`contextEligibleIds`。`relationTraversalEntries` の id）にする。hidden のほかに、次を渡さない。
  - Phase 解決後の contextMode が suppress の項目（明示のピンが無いとき）。
  - このターンで作者が自動から外した項目（`excludedAutoEntryIds`）。
  - 索引に無い id（視点の id が、他の project の Codex 項目や、削除された項目を指す場合）。なお、索引そのものに他の project の行が混ざる場合は、この gate ではなく、既存の `collectSceneContext` の throw（foreign-project row）が文脈全体を止める。
- 理由：場面の視点の名前は、自動の注入である。ADR 013 は、suppress を「自動では渡さない」とし、`CONTEXT_INJECTION.md` も、effective suppress の自動の注入を除く。V2 の字面どおり hidden だけを落とすと、suppress の人物の名前が、新しく自動で出て、確認済みの 2 段の強さを広げる。同じ場面の中で、予定ビートの視点と、場面の視点とで、同じ人物の扱いが分かれることも避ける。
- 起案の文との関係：V2 は「hidden は必ず渡さない」という必要条件だけを書き、suppress や自動の除外を「渡す」とは書かない。この gate は、V2 より狭い向きで、送信は増えない。送信先・保存の範囲・閾値は動かない。起案の脅威モデル L2（§3）は hidden しか書かないが、改訂ではなく注記で足りる（渡す範囲は L2 の範囲に収まる）。
- 明示のピンのある suppress の人物は、ピンが `l4SeedIds` に入るので、名前が出る。ピンは作者が選んだ明示の行為で、予定ビートの視点でも同じである。
- 判定は、`effectiveIndexById`（Phase 解決後。`name` は Phase で変わらない。Phase の上書きは summary・content・contextMode だけで、`materializeResolvedCodexContext` は name を触らない。`sceneContextSource.test.ts` に、Phase の上書きがあっても名前が変わらない試験を 1 件入れた）を引く。索引に無い id は、名前が引けず、渡さない（fail-closed）。名前が空白だけの項目も、行を出さない。
- 判定の固定：`sceneContextSource.test.ts` に、hidden・Phase で hidden が解除された人物・Phase で hidden になった人物・索引に無い id・suppress（ピンなし／ピンあり）・自動の除外・視点なしの場面・場面でない node・空白の名前を入れた。

### DR-CPL-3　描画の場所と形

- `SceneContext` に、任意の欄 `povName` を足す。L3 の `hasRealScene` の中で、時期（`storyTimeLabel`）の後、あらすじ（`synopsis`）の前に 1 行を足す。空白だけの値は、行を出さない。名前は `trim` する。
- 行の組み立ては、新しい小さな file（`src/prompts/shared/sceneL3Lines.ts`。時期と視点の 2 行。時期の出力は変えない）に置いた。`contextBuilder.ts` は、大きい module の行数の上限（`policies/architecture/large-module-debt.json`、2389 行）に張り付いていて、増やせないためである。上限は、動かしていない。置き場を `src/prompts/shared/` にしたのは、変更の影響の選択（`evals/impact-map.yaml`）が、すでに分類している path で、新しい file が全 suite の fallback を起こさないためである。
- 名前は、改行・連続空白を 1 つの空白に畳み（作者指定の Codex リンクの `entryName` と同じ。名前の途中の改行が L3 の新しい行や偽の `### シーン本文` の見出しにならないため）、200 コードポイントで切る（技術判断。`SCENE_POV_NAME_MAX_CODE_POINTS`）。L3 の「題の行から本文の見出しまで」は trim できない先頭なので、Codex の名前に長さの上限が無いと、とても長い名前が予算を超え、場面の本文ごと L3 が落ちるためである。上限は、人物の名前として十分に長い値で、通常の名前は変わらない。渡す内容は名前だけで、範囲は広がらない。
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

- focused の試験：`contextBuilder.test.ts`（視点あり＝あらすじの前・時期の後／なし・空白＝byte 同一／ja・en／予約タグ風の名前の escape／L1 の作品の視点と別の行／空の場面）、`sceneContextSource.test.ts`（DR-CPL-2 の判定の固定）、`nonSceneContextSource.test.ts`（集約の擬似場面に出ない）。
- 視点を設定していない場面で、既にある期待値を書き換えていない。
