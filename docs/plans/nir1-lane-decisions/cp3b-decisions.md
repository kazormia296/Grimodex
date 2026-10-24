# CP-3b の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

出所の確認済み契約は K2/4（`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md`。`graph-target-scene-body-disclosure` と `scope-storage-authority`。2026-10-17 の Session B2 で確認済み）、K3/2（`nir1-publication` の区分と event の表。2026-10-17 の Session B1）、K3/3（renderer の外向き通信の閉鎖。NC-1）、DSN（Related Scenes と Graph の設計メモ）、CP-3a の判断（`cp3a-decisions.md`。DR-CP3A-24、26、34、41〜44）である。この文書は subtask S1（閉じた定数、seed の選択、hook の配線）の mutation の前に書く。S2（融合と表示）、S3（Graph-only の click と `nir1GraphApi.ts` の置き換え）、S4（統合）の判断は、各 subtask の実装の前に同じ形で追記する（後から本文を直さない）。

U3 の委任（継続計画 §3.1）の外に当たる要素は、CP-3b の範囲に無い。CP-3b は renderer だけを変え、新しい受信先、保存範囲の拡大（schema、table、列、新しい永続の置き場）、確認済みの閾値の緩和、製品入口の公開、認可の削除、新しい authority、IPC・N-API・event の入口のどれも置かない。CP-3a が置いた入口（begin の `graphSeedEntityId`、`related_scenes_graph_continue`、`nir1_evidence_qualify` の Graph-only の arm、`related-scenes:graph-ready`）だけを使う。閉じたままのもの：`PRODUCT_GRAPH_PUBLISHED=false`、`BODY_DECLARATION_UI_ENABLED=false`、PUB-G、activation の UI、DA-2 の入口、local 送信の公開。

設計の分かれ目は TASK §4 の推奨と integrator 追記（2026-10-24。TASK の独立レビュー〔Opus 5.5〕の反映）で確定した：D1＝(a)、D2＝(A)、D3＝(a)、D4＝(b)（P2-1 の訂正つき）、D5＝(B)（P3-3 の注入つき）、D6＝(a)、D7＝(A)（P2-2 の位置づけの修正つき）、D8＝(b)（工数が合わなければ (a)。S2 で記録）、D9＝(a)（P3-7 で対象を excerpt・label・quote に広げる）、D10＝(a)。

## threat model（GDX-PRECHECK-001 の security-sensitive。TASK §11 の写し）

確認済みの actor・防御・受信先・受入れ（K2/4、K3/2、K3/3）の範囲内の技術的な改訂で、新しい actor、受信先、authority は足さない。

- 守るもの：Graph-only の Scene の title、本文の excerpt と range、path の label と quote、Graph の到達（どの Scene が Graph で関係づいたか）、候補の有無。
- Trusted：Native（CP-3a の再検証と組立、CB-4 の reader、owner の gate）、Main（owner の束縛、`nir1-publication` の開始時と返却時の再認可、形の検査）。
- Untrusted：renderer の全部（CP-3b のコードを含む）。乗っ取られた renderer は CP-3a の入口を任意の引数で呼べる。
- T-1 誰が何を呼べるか：renderer は `related_scenes_begin`（seed つき）、`related_scenes_graph_continue`（待受けと settle）、`nir1_evidence_qualify` を呼べる。CP-3b はこれらを呼ぶ renderer のコードを足すだけで、入口も区分も変えない。乗っ取られた renderer が CP-3b のコードを経ずに呼んでも、得られるものは CP-3a の threat model（DR-CP3A-16、17、37）のとおりで、CP-3b はそれを広げない。
- T-2 gate が閉じている間に起きないこと：(i) 定数が false の間、renderer は pin を読まず、seed を送らず（begin は CP-3a 前と byte 同一。S-5）、Graph の UI の module と文言を要求しない（U-5）、Graph の行も通知も描かない。(ii) 定数を true にしても Native の gate が閉じていれば、owner は `not-activated`（unrestricted では `profile-not-restricted`）を返し、worker の spawn も Graph の DB 読取も無い（CP-3a の N-2）。renderer は `graph-ready` の payload を受け取らないので何も出さない。`graph-ready` の event も出ない（DR-CP3A-36）。(iii) Graph の chunk の取得は同一 origin（`app://bundle`）の静的 asset で、外向きの通信を足さない（K3/3）。
- T-3 Graph-only の本文の扱い：renderer が受け取るのは title、excerpt、UTF-16 の range、opaque な handle、path の text だけ（digest、token、Revision の ID は wire に無い。DR-CP3A-24）。renderer はこれを表示中の fetch の state にだけ持ち、storage、log、chat、Packing、snippet、copy の操作に渡さない（N-R6、N-R7）。click では Native が本文を読み直して照合し、renderer は自分の editor の text と excerpt を比べるだけで digest を扱わない（DR-CP3A-26）。renderer がもともと `tree_nodes` から本文を読めること（K2/4 Out-of-scope）は変わらない。
- T-4 renderer の表示が Native の判定と食い違わないこと：表示は、同じ `queryBinding` で `graph-ready` と判定された payload の部分集合だけ（合流 helper が deadline の後の Graph を混ぜない）。renderer は Graph の行を合成せず、Native が返さない Scene を出さない。Native と同じ枠の規則で検査し、食い違えば表示を狭める側に倒す（D4）。Graph-only が出ない理由を renderer は区別できず、区別した表示もしない。click の遷移は Native の 2 回の qualify と editor の照合をすべて通ったときだけ（C-2、C-3）。宣言の取消は、同じ renderer なら D8 で行を外し、ほかの経路でも click が拒否する。
- T-5 Graph 全体の理由の表示：`restart-required` だけを閉じた文言で出し、target を識別する値、件数、宣言の有無を含めない（MD 9。Graph 全体の理由は候補に依らない原因だけ）。
- 残余（受け入れる。K2/4 の Out-of-scope のとおり）：renderer が表示した excerpt を利用者が自分で写して送ること。乗っ取られた renderer による Graph の表示の妨害（可用性）。処理時間の差からの推測。

## owner/lifecycle matrix（GDX-PRECHECK-001。async lifecycle の変更。egress、subprocess、background は足さない。TASK §12 の写し）

| 項目 | seed の読取（S1） | Graph の lazy chunk（S2） | 取消の通知（S2、D8 (b)） | Graph-only の click（S3） |
|---|---|---|---|---|
| entry／start | hook の `run()`。定数が true のときだけ、query の世代ごとに 1 回 | Section の描画で、定数が true かつ payload か `restart-required` があるとき 1 回（React.lazy が module を 1 回だけ取る） | CB-3 の取消の成功の後の同期の通知 | 行の操作 → `requestNir1EvidenceNavigation` |
| retry | しない（失敗は seed なし） | しない（失敗は error boundary で R/R+IR の行。React.lazy は reject を cache するので、再読込まで再試行しない。fail-closed。integrator 追記 P3-8 の訂正） | しない | しない（利用者の再操作だけ） |
| reentrant | 世代が変われば前の読取の結果を捨てる | なし | 同じ Scene の通知の重複は 1 回の refresh にまとめる（世代ごとに 1 回） | 既存の `cancelNir1EvidenceNavigation` が前の要求を取り消す（1 件だけ） |
| admission closure | `disposed`、`current.current !== generation`、`abort.signal` | unmount で描画しない | hook の effect の解除で購読を外す。購読も定数の下で閉じる（P3-9） | claim と `isCurrent()`（既存） |
| pending-start | 読取の後に世代を確かめてから fetch を始める | なし | なし | `await import()` の後に `claim.isCurrent()` と editor の capture を確かめ直す（既存と同じ） |
| active handle | なし（Drizzle の 1 回の読取） | なし | listener の Set | 既存の pending と Native の Operation の lease（DR-CP3A-42。Graph-only の行がある間は解放しない） |
| cancellation | hook の cleanup（`disposed`、abort） | unmount | 購読の解除 | 既存の cancel（Scene の切替、workspace、phase、session の invalidation） |
| bounded wait | 1 回の DB 読取（`LIMIT 1`）。期限は既存の renderer の DB の作法に従う（新しい数値を足さない） | 1 回の静的 asset の取得 | 同期 | qualify の IPC（既存）と 1 回の `import()` |
| 終了の証拠 | Promise の解決と世代の照合 | 描画か error boundary | 解除の関数の呼出し | `claim.finish()`（`finally`。既存） |
| error／timeout | seed なしで続ける（R+IR は不変） | R/R+IR の行に戻す | 握りつぶさず `debugLog.warn`（text なし） | 遷移しない（既存と同じ。理由は表示しない） |
| restart の状態 | 持たない（永続なし） | 持たない | 持たない | 持たない |

新しい timer、thread、background、永続の状態は作らない。

## 判断の表

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CP3B-1 | 2026-10-24 | CP-3b／S1 | 範囲の判断：CP-3b は renderer だけを変える。含めるもの：閉じた定数（`nir1GraphAvailability.ts`）、seed の選択（`nir1GraphSeed.ts`）と production の `run()` への配線、融合（`nir1GraphFusion.ts`）、表示（lazy な `Nir1GraphRelatedScenes.tsx`、`Nir1GraphPathEvidence.tsx`、`nir1GraphTranslations.ts`）、Graph-only の click（`nir1EvidenceNavigation.ts`、`useNir1EvidenceNavigation.ts`、lazy な `nir1EvidenceConsume.ts`、`nir1EvidenceRange.ts`）、`nir1GraphApi.ts` の置き換え、quarantine 中の未保存の編集の UX の決定（D7）、取消の通知（D8）、評価の分類と記録。含めないもの：PUB-G（定数を true にすること、`PRODUCT_GRAPH_PUBLISHED`、製品の gate、B の activation）、DA-2、PUB-L、CP-4、CP-2b、schema・table・列、新しい永続の置き場、新しい IPC・N-API・event・wire の field、Native・Main・preload・`src/lib/tauri.ts`、`fetchRelatedScenes.ts`・`selectRelatedScenes.ts`・`seedTerms.ts`・`fetchNir1RelatedScenes.ts`・`nir1RelatedScenesFusion.ts`・`nir1RelatedScenesGraphJoin.ts`・`fetchNir1RelatedScenesGraph.ts`・`nir1RelatedScenesApi.ts`、path Evidence への遷移、Graph-only の行から chat・Packing・snippet・copy への操作、seed を選ぶ UI、seed の規則の拡張、確認済みの閾値と起動時の予算の緩和。subtask は S1→S2→S3→S4 の順で各 1 commit | 範囲の整理だけ。新しい権限・受信先・保存・閾値の変更は無く、製品入口は閉じたまま | CP-3a の入口では足りない場合に wire を足す案：lane の定義の外で `[precheck]`（TASK §13.1 の P-2）。採らない | 独立レビュー（Opus 5.5。TASK の integrator 追記の冒頭に結論） | 該当なし | 上の matrix（S1〜S3 の列） | 記録済み（実装前） |
| DR-CP3B-2 | 2026-10-24 | CP-3b／S1（D1） | 閉じた定数：`src/features/related-scenes/nir1GraphAvailability.ts` に `NIR1_GRAPH_UI_ENABLED = false as const` と `isNir1GraphUiEnabled()` を置く（CB-3 の `bodyDeclarationAvailability.ts`〔DR-CB3-2、DR-CB3-21〕と同じ作法）。試験は本物の既定値で固定する（A-1。mock しない）。CB-3 の `BODY_DECLARATION_UI_ENABLED` と共用しない：path の付加は宣言に依らず、CB-3 の file を跨いで結合させない。PUB-G は、この定数、`BODY_DECLARATION_UI_ENABLED`、Native の gate（`PRODUCT_GRAPH_PUBLISHED` と activation）を同じ承認で変える。両方の availability の doc comment にそれを書く（`bodyDeclarationAvailability.ts` は comment だけを足す） | 定数は renderer の表示と seed の送信を閉じるだけで、安全の根拠は Native の gate（renderer は untrusted）。二重で閉じる | (b) CB-3 の定数を共用：宣言の UI と Graph の表示の公開の単位が結びつく。採らない | 不要 | 該当なし | なし（定数） | 記録済み（実装前） |
| DR-CP3B-3 | 2026-10-24 | CP-3b／S1（D2、DR-DI1A-6、integrator 追記 P3-4） | seed の規則の写し：`selectNir1GraphSeed(projectId, sceneId)` は Native の `read_nir1_graph_seed_in_tx`（`nir1_packing/graph_candidates.rs:223-256`）と同じ規則を Drizzle の query builder（raw の `sql` を使わない。`renderer-raw-sql-read` の上限に当たらない）で読む：`scene_codex_pins` を、同じ project の `node_type='scene'` で `archived_at IS NULL` の `tree_nodes`（`scene_id` で）と、同じ project の `codex_entries`（`entry_id` で）に inner join し、`scene_id = 現在の Scene`、`ORDER BY created_at, entry_id LIMIT 1`。**先頭の 1 件だけで判定し、次の pin へは進まない**（Native も `LIMIT 1` の後で `NoPin`／`TooLarge`）：0 件、`entry_id` が空、trim 後に空、200 UTF-16 を超える場合はどれも seed なし（Main の `graphSeedEntityId` の検査〔DR-CP3A-34。`ipcContract.ts` の `RELATED_SCENES_ID_UTF16_MAX`〕に当たると begin 全体が `IPC_INVALID_REQUEST` になり R まで落ちるため）。読取の失敗（例外）も seed なしで、R+IR の query は続ける。restricted の profile で：`scene_codex_pins`、`tree_nodes`、`codex_entries` は Native の closed にも read-open にも無い（`electron/main/d2aSqlPolicyFixture.ts` の `NATIVE_CLOSED_TABLES`／`NATIVE_READ_OPEN_TABLES`／`NATIVE_READ_OPEN_COLUMNS` で確かめた）ので、Main の `dbStatementRoute` は SELECT を `internal` として通す。D2＝(A)：`useNir1RelatedScenes.ts` の `run()` は `isNir1GraphUiEnabled()` が true のときだけ seed を読み、文字列なら `fetchRelatedPastScenes` の既存の option `graphSeedEntityId`（CP-3a の注入点）に渡す。false の間は pin を読まず、begin は CP-3a 前と byte 同一（S-5 で `beginRelatedScenes` の引数を strict に比べる）。`rawOnly` の再取得では読まない（begin が無い）。既存の `listPinsForScene` は `created_at` だけで並べ join もしないので使わない | seed は locator の申告で、Native が §3.3 で規則から読み直す（DR-CP3A-13）。renderer の SQL が Native と食い違えば Graph 全体が `invalidated` になる（可用性だけ。R-1）。renderer がもともと pin と Codex を読めることは変わらない | (B) 定数に依らず seed を読んで渡す：PUB-G の前に、すべての query で pin の読取が 1 回増え、seed のない従来の経路（`awaitNir1RelatedScenes`）から合流 helper の経路に変わる（DSN §3.2「seed のない query は従来の経路」を崩す）。委任の内側だが採らない。`listPinsForScene` を使う：並びと join が Native と違う。採らない | 独立レビュー（TASK の integrator 追記。D2＝(A) を確認） | 該当なし | 上の matrix の「seed の読取」 | 記録済み（実装前） |
| DR-CP3B-4 | 2026-10-24 | CP-3b／S1（D3、D4、integrator 追記 P2-1、P3-5、P3-6。実装は S2） | 融合の置き場と規則：`nir1GraphFusion.ts` の pure な関数（DOM に依らない。CP-4 の R+IR+Graph の arm から呼べる）を表示の層（lazy component）で呼び、**`fetch.result` は変えない**（評価 harness `scripts/quality/nir1-retrieval/renderer.ts` と P は `result` を読む）。規則：既存の表示行（R または R+IR）への path の付加と、Graph-only の 1 枠の追加（`policies/narrative/nir1-related-scenes-ranking.json` の `fusion.maxScenes` 8、`maxAdditionalScenes` 1。`nir1RelatedScenesFusion.ts` と同じ規則で、R+IR に `ir` の行が無く、R が 8 件未満のときだけ末尾に 1 件、rank は件数＋1）。R と IR がともに空で Graph-only だけがある場合（Native の `compose` は raw 0 件で枠を開ける）も行を作る（P3-5。Section の「空」の分岐を Graph の描画の側が拾う）。renderer の検査（D4＝(b)。P2-1 の訂正つき）：**attachment の食い違い**（表示集合に無い Scene、同じ Scene が 2 回、`graph.queryBinding !== fetch.queryBinding` など）では Graph の寄与の全体（attachments と Graph-only の両方）を捨てる（Native の手順 2 が食い違えば手順 3 へ進まないのと同じ向き）。**Graph-only の行だけの食い違い**（Scene が既に表示中、Scene が query の Scene、枠が閉じている、excerpt が空か改行を含む、`path.edges` が空、`pinEntityId` が最後の edge の端点でない、range が範囲外）では、その行だけを捨て、attachments は残す（MD3）。捨てたことは件数だけを `debugLog` に出し、text や ID は出さない | 表示は Native が `graph-ready` と判定した payload の部分集合だけ。renderer は行を合成しない（T-4） | (a) Graph の寄与を常に全体で捨てる：Graph-only の行の不一致で正しい path の付加まで消え、Native の all-or-nothing の範囲より狭い。(b) fetch に融合済みの field を足す／(c) `result` を融合する：harness と P、R+IR の receipt の source が動く。採らない | 独立レビュー（P2-1） | 該当なし | なし（pure な関数） | 記録済み（実装前） |
| DR-CP3B-5 | 2026-10-24 | CP-3b／S1 | owner/lifecycle の matrix：上の表（TASK §12 の写し、integrator 追記 P3-8、P3-9 の訂正を反映）を正とする。S1 の「seed の読取」は、hook の `run()` の中で世代ごとに 1 回、読取の前と後で `current.current === generation && !disposed` を確かめ、変わっていれば何もしない（fetch を始めない。S-7）。読取の失敗は seed なしで fetch を続ける。timer・thread・background・永続の状態は作らない。既存の debounce（400 ms）と timeout の再試行（2 回）は変えない | 新しい入口なし | 読取を debounce の前に始める：世代の管理が二重になる。採らない | 不要 | 該当なし | 上の matrix | 記録済み（実装前） |

## S1 の試験の対応表（TASK §6.1）

| ID | 場所 | 試験 |
|---|---|---|
| A-1 | `src/features/related-scenes/nir1GraphAvailability.test.ts` | `is closed by default (only PUB-G turns it on, with the Native gate)`（本物の定数） |
| S-1 | `src/features/related-scenes/nir1GraphSeed.test.ts` | `returns no seed when the scene has no pin` |
| S-2 | 同 | `picks the earliest created_at, then the smallest entry_id` |
| S-3 | 同 | `ignores a pin of an archived scene, of a scene in another project, or of an entry in another project`、`ignores a pin on a non-scene node` |
| S-4 | 同 | `returns no seed for an empty, blank or over-200-UTF-16 entry id`（200 は seed）、`decides on the first pin only and does not fall through to the next one`（P3-4） |
| S-5 | `src/features/related-scenes/useNir1RelatedScenes.graphSeed.test.tsx` | `with the real default no pin is read and begin carries no graphSeedEntityId`。fetch の option の key の集合を strict に比べる（CP-3b 前と同じ 4 key）。begin の 5 key は CP-3a の `fetchRelatedScenes.nir1.test.ts` の `leaves an unseeded query exactly as before` と `preserves the saved-body query ...`（`toHaveBeenCalledExactlyOnceWith`）が固定する。hook から begin までを 1 本で通す試験にはしなかった（fetch の依存の mock が二重になる） |
| S-6 | 同 | `passes the selected seed to the production fetch when the UI is enabled`、`sends no seed key when the scene has no usable pin` |
| S-7 | 同 | `a seed read that resolves after the scene changed starts nothing`、`a seed read that resolves after unmount starts nothing`、`a failed seed read runs the unseeded query`、`a Raw-only recovery reads no seed` |

## S1 の検証の記録（2026-10-24。worktree `claude-nir1-di1b`、branch `claude/nir1-cp3b`）

- `pnpm exec vitest --run src/features/related-scenes`：23 file 通過、1 skipped（既存）。304 passed、6 skipped。既存の `useNir1RelatedScenes.test.tsx`、`useNir1RelatedScenes.invalidation.test.tsx`、`RelatedScenesSection.test.tsx` は無変更で通過。
- `pnpm exec tsc --noEmit`、`pnpm exec tsc -p electron/tsconfig.json --noEmit`：error なし。`pnpm exec eslint src/features/related-scenes src/features/editor/sceneMeta/bodyDeclaration`：error なし。
- 起動時の JS graph（`vite build` → `node scripts/check-performance-budgets.mjs`）：base（`5fb19295`）raw 4,249,075／gzip 1,342,073、S1 raw 4,249,075／gzip 1,342,099（raw は差 0。上限 raw 4,250,000）。
