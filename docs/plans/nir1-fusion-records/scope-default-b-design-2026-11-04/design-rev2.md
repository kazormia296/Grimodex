# 案 B の設計（改訂 2）：新しい場面の Scope の既定を「project の既定を受け継ぐ」にする（`scope-storage-authority` の改訂案）

| 項目 | 内容 |
| ---- | ---- |
| 状態 | **設計草稿の改訂 2（draft）。未確認。契約の確定でも実装の承認でもない**。改訂 1 は独立レビュー（`review-1.md`、判定 (b)）の P1〜P3 を、改訂 2 は最終確認（`review-2-fable.md`、判定 (b)、P1 なし）の P2・P3 を反映した。元の草稿は `design-draft.md`、改訂 1 は `design-rev1.md` に残す |
| 基点 | 改訂 1 までは `origin/master` `f36dd696`（#783）。改訂 2 の確認は `origin/master` `a8c5fa65`（#787。`f36dd696` からの差分は依存と CI の設定と `grimodex-ai/src/lib.rs` だけで、引いた file の行は同じ）。記録は `origin/claude/nir1-contracts` `2cddfb14` |
| ユーザーの決定 | `2cddfb14` の `docs/plans/nir1-cp4-records/user-confirmation-2026-11-03-scope-default-first.md` の追記。質問 2 の回答は「B：project の既定を受け継ぐ (推奨)」。記録には「この回答は設計の着手の承認で、契約の改訂・実装の承認ではない」とある。B の説明の「変えられる。既に作った場面は変わらない」は integrator が質問の前に示した説明で、ユーザーはそれを読んで B を選んだ（ユーザー自身の文言ではない） |
| 材料 | `origin/claude/nir1-contracts:docs/plans/nir1-fusion-records/scope-default-material-2026-11-04.md`（以下「材料」） |
| 調べ方 | git object を読むだけ（`git show`／`git grep`）。repo の編集・build・test・起動はしていない |
| 表記 | 行番号は特記が無ければ `origin/master` の版。パスは repo 相対。`scene_scope.rs` は `src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs`、`core scope` は `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs`、`l6-l9` は `docs/plans/nir1-l6-l9-execution-plan.md`。**推測**と書いたものは私の読みで、コードや文書で確かめていない |

## 改訂の対照表

### 改訂 1（review-1 の指摘 → 対応）

指摘の事実は、反映する前に `origin/master` の git object で確かめた。「確認」の列はその結果。改訂 1 の `sceneScopeInit` の案は、改訂 2 で削った（下の改訂 2 の表）。

| 指摘 | 確認 | 対応（場所） |
| ---- | ---- | ---- |
| P1-1 undo／redo が `tree_node_create` を通って既定を受け継ぎ、§4.3 と食い違う | **正しい**。削除の undo は `src/features/tree/treeStore.ts:1544-1559` の `restorePersisted` が同じ id と本文で `api.createNode` を呼び、`historyWriteContext("undo", …)` を渡す。作成の redo は :1381-1396 の `recreatePersisted` が `historyWriteContext("redo", …)` を渡す。どちらも `tree_node_create` を通る。章の削除（:1529 の `deleteTreeSubtree`）も同じ。`tree_node_create_with_authority`（`domain_writes.rs:3198-3290`）は `origin`（`NarrativeChangeOrigin`。`change_feed.rs:47-55` の Human／AiApply／Import／Undo／Redo／Restore／Migration）、`original_transaction_id`、`undo_journal_id` を受け、renderer の文脈の route（`human-direct`／`import-apply`／`history-replay`／`restore-or-migration`。:3225-3233）と照合し、lineage を検証する（:3269-3283）。`apply_ai_tree_plan` は `redo` の flag と lineage を持ち（:5410-5419）、`promote_sticky` の payload は origin を持つ（`map_writes.rs:160-163`、:1163-1169） | 継承するかを origin と lineage で Native が決める規則にした。継承するのは「origin が human か ai-apply、lineage が無い、AI 計画の `redo` が false」のときだけ。undo／redo／history-replay／restore／migration は `unknown`（§2.2 の 2・3、§4.1、§4.2）。実行時の受入れ試験を足した（§10.2 の R1〜R4） |
| P2-2 既存の project への取り込みと外部 mount も受け継ぐ | **正しい**。取り込みは `createNode` を origin `import` で呼ぶ（`src/features/import/importApi.ts:633-642` の場面、`scan/scanImportOperations.ts:89-116`）。`importTarget.ts:10-15` は markdown の single で `"currentProject"` を選ぶ。外部 mount は `src/features/external-mount/mountManager.ts:1320-1335` で場面を `createNode` で作るが、writeContext を渡さないので origin は既定の `human`（`src/features/native-writes/writeContext.ts:90`）。origin だけでは mount と作者の作成を区別できない | `tree_node_create` に閉じた optional の field `sceneScopeInit`（値は `"unset"` だけ）を足す。renderer はこれで安全な向き（未設定）にだけ下げられ、上げることはできない。mount は常に `"unset"` を渡す。取り込みは画面のチェックで選び、既定はオフで `"unset"` を渡す。これを推奨として書き、確認点（U1、U2）に入れた（§2.2 の 2、§4.1、§4.2、§10.3） |
| P2-3 語彙の初期投入は「既存の project には効かない」が、公開版の利用者には当たらない | **正しい**。`LAST_PUBLIC_RELEASE_SCHEMA_VERSION = 2`（`grimodex-core/src/lib.rs:4-8`）。backfill は `current < 36` のとき走り（`migrate.rs:4535-4543`）、`ensure_scope_registry_in_tx` を呼ぶ（`scene_scope.rs:536-539`）。公開版から更新する利用者の既存の project には、全部に語彙が入る | §3.5.1 を書き直した。挙動は変わらない（`unknown` は ref を参照しない）が、既存の利用者の migration で入るデータが変わることを明記した。§5.2・§5.3・§7.1 の「既存の project は registry が空」の前提を、利用者の種類ごとに分けた。Gate A2 の upgrade fixture の期待値への影響を §9 と §10.2 に、U3 に入れた |
| P2-4 (i) 作成ダイアログのチェックの既定オンは、作者が触っていない場面に explicit を書く | 事実の確認は不要（意味の論点）。l6-l9:861、:870 の「明示」の意味に関わる | ユーザーへの確認点 U2 として明示した（§7.1、§10.3） |
| P2-4 (ii) ユーザーの記録の素直な読みは「作成の全経路で継承」だが、草稿は 8 経路のうち 3 経路に絞った | 事実の確認は不要（記録の読みの差） | ユーザーへの確認点 U1 として明示した（§4.1、§10.3） |
| P2-4 (iii) 「既定を変えても既存の場面は変わらない」はユーザーの決定ではなく integrator の説明 | **正しい**。`2cddfb14` の記録では、integrator の説明の中にある | 冒頭の表、§3.1、§3.5.2 の表現を直した |
| P3-5 generic import（`import/commit.rs:164`）は `project_create` を通らずに project を作る | **正しい**。`src-tauri/crates/grimodex-db/src/import/commit.rs:163-167` は `INSERT INTO projects` を直接実行する。registry は後で場面を作るときに `scene_scope.rs:445` で作られる | §3.5.1 の「効く範囲」に足した。β の既定は入らない（§3.5.2） |
| P3-6 `src/features/trash-bin/restorers/scene.ts:54` は `createNode` で復元する | **正しい**。ただし `restoreScene` を呼ぶ製品のコードは無い（`git grep` では `pickupHandlers.ts:16` が型を import するだけ）。配線されると origin `human` で受け継ぐ | §4.1 に載せた。受入れ試験 R4 で、配線されたときに受け継がないことを固定する（§10.2）。配線するときは `sceneScopeInit: "unset"` を渡す |
| P3-7 MANIFEST の `SceneCreate` を分けるだけでは足りない | **正しい**。snapshot の restore は `ProjectRestore` の class（`tests/narrative_scope_storage_authority.rs:466-478` 付近）。本文保存は場面の INSERT ではないので MANIFEST に無い | §4.2 を、grep の試験（継承の定数は許可した関数の中の origin で守られた分岐にだけ現れる）と実行時の試験の 2 段にした |
| P3-8 tombstone の `{"kind":"none"}` は `deny_unknown_fields` と合わない | **正しい**。`NarrativeSceneQueryIdentityV1` は `deny_unknown_fields`（`core scope:54-60`） | §3.2 で `state` の列を別に持つ形にした。`source_token` の列の用途を書いた |
| P3-9 query だけを変えた時点で、その場面に anchor する Revision は失効する | **型付き Revision については正しい**（X1/1 の編集ごとの表の「S の A1 設定」の行。`docs/plans/nir1-scene-scope-projection-proposal-1-draft.md:222-252`）。Chronicle の IR が A1 の変更で使えなくなるかは、材料の scope control の種類（`scene_scope.rs:1925-1953` の `project-scope-authority`／`scope-dependency-projection-v1`）による。今回は追いきれていない | §8.4 の 4 を、確かめた範囲に合わせて書き直した |
| （レビューが確かめられなかった点）`project_snapshots.rs:2952` 付近の binding を残す分岐 | `ensure_scene_scope_binding_in_tx` は binding があれば何もしない（`scene_scope.rs:447-459`）。snapshot が置き換えた場面で binding が残る場合も、新しく作る場合も、B は作成の種類を `UnknownRepairOrRestore` にするので既定は入らない。残る場合の世代は :2955-2960 の refresh で進む | §4.1 の snapshot の行に注として書いた。どちらの場合があるかは確かめていない（§10.4） |

### 改訂 2（review-2-fable の指摘 → 対応）

指摘の事実は `origin/master` `a8c5fa65` の git object で確かめた。

| 指摘 | 確認 | 対応（場所） |
| ---- | ---- | ---- |
| P2-1 「継承するかは Native が決め、renderer の値で継承を起こさない」が mount・取り込み・restorer で成り立たない | **正しい**。mount の場面の作成は writeContext を渡さず（`mountManager.ts:1320-1335`）、origin は既定の `human`（`writeContext.ts:90`）で、改訂 1 では `sceneScopeInit` を省くと継承した。取り込みは origin `import`（`importApi.ts:633-642`、`scanImportOperations.ts:106-116`）で、改訂 1 の (a) は import を許していた。`createNode` に `sourceUri` を渡すのは mount だけ（`git grep`。`markdownParser.ts:9` は file 名の解析に使うだけで payload に渡さない）。main は payload の origin を route に写すだけ（`electron/main/ipc.ts:1898-1912`：human→human-direct、import→import-apply、undo／redo→history-replay、restore／migration→restore-or-migration）で、origin は renderer の申告 | 推奨の (i)〜(iii) を採った。(i) `source_uri` か `source_mtime` を持つ作成は Native が継承しない。(ii) origin `import` を継承の対象から外す。取り込みの画面のチェックが ON のときは、取り込みの完了後に既存の writer `narrative_scene_scope_update` のループで当てる（§5.1 と同じ操作）。(iii) 未配線の renderer の restorer は、配線するとき origin `restore`（route `restore-or-migration`）を要求する。これで Native がすべての経路を自分で判定でき、`sceneScopeInit` の field は要らなくなったので削った。§2.2 の 2・3、§2.3、§4.1、§4.2、§8.3、§10 を直した |
| P2-2 T8（PUB-G の開示文）は技術判断ではなくユーザーの確認の対象 | 指摘のとおり | T8 を削り、U 側の注記に「文案は §9 に書く。確定は PUB-G の確認で聞く」と移した（§10.3） |
| P2-3 β の帰結（新しい workspace の `default-project` と generic import の project は既定なし）がユーザーに伝わらない | **正しい**。`migrate.rs:1521-1527` の INSERT と `import/commit.rs:163-167` は `project_create` を通らない | U2 の注記に 1 行で入れた（§10.3） |
| P3-4 §4.1 の列挙の抜け | **正しい**。構成テンプレートの一括作成（`src/features/grid/applyStructureTemplate.ts:88`〔folder〕、:108〔場面〕）、スマホの空の project での自動作成（`src/features/tree/PhoneEmptySceneBootstrap.tsx:19`、`interaction: "implicit"`）、マトリクス（`src/features/matrix/MatrixPanel.tsx:288`）、`treeStore.ts:1174`（`createScene`）。どれも origin `human` | §4.1 に行を足した。U1 の「作者が新しく作った場面」に、テンプレートの一括作成と自動作成を含むと明示した |
| P3-5 `sceneScopeInit` が冪等の fingerprint に入る | **正しい**（`idempotency.rs:121-130` は transport の識別子だけを除く） | P2-1 の (i)〜(iii) で field 自体を削ったので、この問題は無くなった。将来 field を足すなら fingerprint と `canonicalPayload`（`tree/api.ts:433`）の扱いを決める、と §4.2 に書いた |
| P3-6 §7.1 の hint に redo と history-replay が無い | **正しい**（`treeStore.ts:1381-1396` の redo） | 文言を「取り消し・やり直し・ゴミ箱・スナップショット」にした（§7.1） |
| P3-7 既定の変更履歴を残すかは保存範囲の判断 | 指摘のとおり | 残す方向を推奨にし、draft の保存範囲に含めて U4 で確認する、と T9 に書いた（§6 の注、§10.3） |
| P3-8 U4 の判断材料として B-lite との比較が無い | 材料 §6 の末尾に B-lite の項がある | U4 の注記に 1 行の比較と、採らない理由を書いた（§10.3） |
| （確かめられなかったこと）`requireTreeNodeCreatePayload` が未知の key を拒否するか | **拒否しない**（`electron/shared/ipcContract.ts:4255-4286` は既知の key の型だけを見る） | 改訂 2 は IPC の field を足さないので、作成の command の検証は変えない。backup の restore の表の allowlist は §10.4 に足した |

## 0. 要点

- project ごとに「場面の Scope の既定」を Native が持つ。中身は 3 軸（timeline／worldline／narrativeLayer）の exact な ref。保存先は新しい表にする。registry の外に置くので、既定を変えても既存の場面と registry の token は変わらない（§3）。
- 継承するかは Native がすべての経路で自分で決める。条件は、新しい場面を作る 3 つの writer（作成〔`tree_node_create`〕、AI の木構造計画〔`redo` でないもの〕、付箋の昇格）で、origin が `human` か `ai-apply`、undo／redo の lineage が無く、外部 source（`source_uri`／`source_mtime`）を持たないこと。このとき Native は同じ transaction で既定を読み、`explicit` の binding を書く。それ以外は今どおり `unknown` にする。`any` には落とさない（§2、§4）。renderer が Scope の値や継承の可否を申告する field は無い。
- undo／redo／history-replay、ゴミ箱、project snapshot、本文保存での欠けた binding の修復、外部 mount の同期、取り込み、サンプル、seed、migration は継承しない（§4）。取り込みの画面のチェックが ON のときは、取り込みの完了後に既存の writer で当てる（作者の操作。U1、U2）。
- 「語彙の初期投入」と「既定の初期設定」を分ける。既定を全ての `project_create` で自動で入れる案（α）は、CP-4 の凍結 setup と DP-H の harness を registry の置換で止める（§3.5、§9）。推奨は β で、作成ダイアログの経路だけが既定を入れる。語彙は registry を初めて作るときに入れる。公開版から更新する利用者の既存の project にも語彙が入るが、挙動は変わらない（§3.5.1）。
- 既存の project と既存の `unknown` の場面には、migration で既定を当てない。作者が操作で当てる（§5）。
- 開示の主な危険は、回想・夢・別の世界線・作中作の Scope を作者が変え忘れ、本筋の IR／Graph に混ざること。読書順と秘密の防御は変わらない（§8）。
- 新しい保存先を足すので、AGENTS の委任の外（保存範囲の拡大と新しい契約）にあたる。新しい draftRef の確認が要る（§2）。ユーザーに聞く点は 4 つにまとめた（§10.3）。

## 1. 目的と範囲、変えないもの

### 1.1 目的

今の製品では、新しい場面の Scope binding は `compatibility_marker: unknown` で作られる（`scene_scope.rs:461-472`。marker は :464）。関連場面の IR は、query の場面が `unknown`、または `explicit` でも query の軸に `unresolved` が残ると、`ScopeUnsupported` で出ない（`retrieval_admission/query_context.rs:120-133`）。材料側も `unknown` の場面を拒否する（`scene_scope.rs:1955-1956`）。Graph は、target の場面が `explicit` で query の軸が exact に一致することを求める（`nir1_graph/scenes.rs:787-833`）。このため作者が場面ごとに registry を作り、3 軸を選ばないと、IR も Graph も出ない（材料 §4）。

案 B では、project に既定の Scope を持たせ、新しい場面が作成時にそれを `explicit` で受け継ぐ。作者が何もしなくても、本筋の場面どうしで IR と Graph が働く状態から始められる。

### 1.2 範囲

- 契約 `scope-storage-authority` に新しい draftRef の差分を足す（§2）。
- project の既定の保存、作成の経路での継承、既定の読み書きの IPC、UI（§3〜§7）。
- 既存の場面の扱い、失効、開示の安全、評価への影響、段取り（§5〜§10）。

### 1.3 変えないもの

| 変えないもの | 根拠 |
| ---- | ---- |
| `unknown`／`unresolved` の fail closed。query 側の `ScopeUnsupported`、材料側の `ScopeUnsupported`、Graph の `explicit` 要件 | `query_context.rs:120-133`、`scene_scope.rs:1955-1956`、:1966-1977、`nir1_graph/scenes.rs:787-833`。l6-l9:304「unknown／unresolvedはfail closedにする」 |
| query identity に `any` を作らない | `core scope:222-225`（`queryIdentity.{name} cannot be any`）、l6-l9:857 |
| ADR 009 の any と unresolved の区別 | 材料 §2、`docs/adr/009-narrative-scope-relation-contract.md`。B は any も unresolved も新しく作らず、exact だけを書く |
| 読書順の制約（材料は今の場面より前の場面に限る）と、秘密を出さないこと | l6-l9:877「IR/Graph材料のstrict reading-before-S2を維持」、`query_context.rs:197` の `allow_secrets: false` |
| 案 D（`unknown` を any や legacy-absent と同じに扱う）を採らない | 材料 §5「案 D を推奨しない理由」。l6-l9:302 の In-scope attacks「unknownからanyへのfallback」 |
| `legacy-absent` の意味と、`explicit`／`unknown` から `legacy-absent` へ戻せないこと | `scene_scope.rs:1283-1289`、`core scope:142-164` |
| registry を変えると全場面の Scope 世代が進み、型付き Revision がすべて失効する規則（X1/1 の Q2） | `docs/plans/nir1-scene-scope-projection-proposal-1-draft.md:422-431`、`scene_scope.rs:1507-1529` |
| undo／restore は旧資格を復活させず、削除の undo が旧 incarnation を継ぐのは journal で証明できるときだけ。snapshot の本文 restore は binding を作り直す | l6-l9:299、l6-l9 の L6 の表（:868-873）、X1/1 の F19、`project_snapshots.rs:3707-3765` |
| binding の行の形（列と `NarrativeSceneScopeBindingV1`）と、v1 の source token の式 | `core scope:84-97`、:176-199。B は binding の形を変えない |
| 閾値、Gold、評価の規則、凍結済みの trace の file | 委任の外（AGENTS「閾値の緩和」）。§9 |

### 1.4 B を入れても IR が出ない残りの条件（B は解かない）

- 材料にする過去の場面が `unknown`（材料 §4。B の前に作った場面）。§5 で作者が操作で当てられるようにする。
- 場面が archived（`query_context.rs:63`）。
- 読みの軸が reading でない（`query_context.rs:94-95`）。新しい project の `phase_resolution_mode` の既定は `'auto'`（`migrate.rs:529`）で、全場面に story の key が付くと story の軸に切り替わる（`narrative_extraction/disclosure_precheck/scene_axis.rs:48-49`）。
- `legacy-absent` の場面は、IR は出るが Graph は出ない（材料 §4 の表）。
- 承認済みの Revision が無ければ、どの Scope でも IR は出ない（IR は人の承認を要する）。

## 2. 契約の改訂

### 2.1 draftRef と確認の扱い

- draftRef の案は `nir1-scene-scope-default-proposal/1`、contractId は `scope-storage-authority`。
- 既存の 4 行（proposal/3 の baseline、X1/1、X1/3、K2/4。l6-l9:229、:247、:249、:251）は置き換えず、この行を加算で並べる。X1/1・X1/3・K2/4 の差分とは互いを前提にしない。
- AGENTS の委任（NIR-1 の残レーンの技術判断）は「保存範囲の拡大」と「新しい契約・authority」を含まない（`AGENTS.md`「作業範囲と完了」）。B は project の既定という新しい保存項目を足すので、ユーザーの確認が要る。確認の手続は l6-l9:294 の Confirmation protocol（2026-10-25 の緩和後）に従う。

### 2.2 Delta（案）

1. **project の場面 Scope の既定**。Native が project ごとに 0 または 1 つの既定を持つ。中身は閉じた型で、query identity の 3 軸がすべて exact、material 制約は query identity と同じ exact、holder と audience は reader に固定する（v1）。既定が無い状態は「既定なし」で、今の挙動と同じになる。
2. **作成時の継承と、その条件を決める主体**。継承するのは、新しい incarnation を発行する作成の writer のうち、閉じた一覧（`tree_node_create_with_authority`、`apply_ai_tree_plan`、`promote_sticky`）だけ。さらに次をすべて満たす場合に限る。満たすかどうかは Native が payload と文脈から決める。
   - (a) origin が `human` か `ai-apply`（`NarrativeChangeOrigin`）。`import`、`undo`、`redo`、`restore`、`migration` は継承しない。
   - (b) `original_transaction_id` と `undo_journal_id` が無い。AI の木構造計画は `redo` が false。renderer の文脈の route が `history-replay` でも `restore-or-migration` でもない。
   - (c) 外部 source を持たない：`source_uri` と `source_mtime` がどちらも無い（`TreeNodeCreatePayload`、`domain_writes.rs:2447-2469`）。今これを渡すのは外部 mount の同期だけ。
   - (d) 既定があり、その ref が同じ snapshot の registry の member。
   
   満たせば binding を `explicit`、既定の値、version 1 で書く。満たさなければ `unknown` で書く。renderer は作成時の Scope の値も、継承するかどうかも申告しない。renderer が申告する origin／lineage／route は、既存の契約の作成の writer の申告（route `human-direct` など。`ipc.ts:1898-1912`）と同じ扱いで、新しい信頼を足さない（§2.3）。
3. **継承しない経路**。上の一覧の外の経路は、今どおり `unknown`／`legacy-absent` を書く。対象は、復元（ゴミ箱、project snapshot の本文 restore）、欠けた binding の修復（本文保存）、migration の backfill、サンプル、seed。一覧の中でも (a)〜(c) を満たさない呼出しは `unknown` を書く。undo／redo／history-replay、外部 mount の同期（外部 source あり）、取り込み（origin `import`）、ゴミ箱の renderer の restorer（配線するときは origin `restore` を要求する。§4.1）がこれにあたる。取り込みの画面のチェックが ON のときは、取り込みの完了後に作者の操作として既存の writer で当てる（§5.1 と同じ。継承ではない）。l6-l9:873「markerのない部分snapshot、不明な復旧」は `unknown` のまま。削除の undo が journal の証明で旧 incarnation と状態を継ぐ経路（l6-l9 の L6 の表「削除undo、object復元」）は今は無い（推測：今の undo は同じ ID で作り直すだけで、新しい incarnation と `unknown` になる）。B はこれを変えない。
4. **既定の変更は既存の場面を変えない**。既定の書込みは binding、registry、project の Scope authority の token のどれにも入らない。既存の Revision、Index、宣言を失効させない。
5. **registry との不変条件**。既定の ref は registry の member でなければ書けない。registry の writer は、既定が使っている ref を消す更新を拒否する（既存の binding と同じ扱い。`scene_scope.rs:1476-1481`）。万一 dangling になっても（例：古い backup）、作成時の継承は `unknown` に落とし、any には落とさない。
6. **新しい project の初期設定**。既定を書くのは、`project_create` の payload の optional な typed field（§3.5.2 の β）で「本筋」を選んだときだけ。同じ transaction で既定を書く。語彙は registry を初めて作るときに入れる（§3.5.1）。場面はまだ無いので依存は無い。
7. **L6 の表の読み方**（l6-l9:870「新規、複製、import、削除後のID再利用｜…Scope markerは未設定なら`unknown`」）。「未設定」を「場面にも project にも既定が無いか、継承の条件を満たさない」と読む。project の既定から Native が書いた binding は、作者の project の設定に由来する明示設定として `explicit` で表す。marker の値の集合と意味の区別（l6-l9:861）は変えない。作者が場面ごとには触っていない場面にも `explicit` が付く点が意味の変更で、U2 で確認する。
8. **変えないもの**：§1.3 のすべて。

### 2.3 actor・攻撃・防御・受入れ（proposal/3 の行への追加）

- Trusted actors：変えない（Native、既存の project の Scope authority、同じ transaction の journal と失効）。既定の writer と reader、継承の判定は Native に置く。
- Untrusted actors：今の一覧（renderer の Scope／profile／incarnation の申告、model output、stale な UI・cache・restore 由来のデータ。l6-l9:301）に、次の 2 つを加える：renderer が申告する既定の値、`project_create` の初期設定の field。どちらも開示の認可の根拠にしない。Native は型と registry の所属を検証する。作成の種類の申告（origin／lineage／route）は、既存の契約の作成の writer（route `human-direct` など）と同じ扱いで、Scope の値の申告は受けない。main は origin を route に写すだけ（`ipc.ts:1898-1912`）で、origin は renderer の申告のまま。
- In-scope attacks（追加）は次の 6 つ：別 project の既定の参照、registry に無い ref を持つ既定、dangling な既定から any への fallback、復元・undo／redo・history-replay・同期・取り込みの経路での黙った継承、renderer の申告による Scope の値の持ち込み、既定の変更で既存の場面が書き換わること。
- Mandatory defenses（追加）：
  - 継承するかは、作成の writer の種類、origin、lineage、route、外部 source の有無で Native が決める。継承を起こす renderer の field は無い。origin／lineage／route の申告の扱いは既存の契約と同じで、origin を `human` と偽った呼出しは作者の作成として扱われる（それで書けるのは既定の値だけで、既存の Scope の writer より弱い。§8.3）。
  - 既定と registry は同じ snapshot で読み、exact な project と ref を要求する。継承できなければ `unknown` にする。
  - 既定の書込みは binding と token を書かない。
- Acceptance（追加）：
  - Positive：既定のある project で、3 つの writer の forward の作成が `explicit` を書き、cold reopen の後も同じ値。IR と Graph が本筋の場面どうしで出る。
  - Negative：既定なし・dangling・別 project では `unknown`。undo（削除の取消）、redo（作成のやり直し）、AI 計画の redo、付箋の昇格の undo／redo、history-replay、外部 source を持つ作成（mount）、origin `import`、origin `restore` では、既定があっても `unknown`。復元と修復の経路も既定があっても `unknown`。既定の変更で既存の binding の bytes と token が変わらない。registry から使用中の ref を消す更新は拒否される。
  - Recovery：既定の行が壊れていれば既定なしとして扱い、作成は `unknown`。

### 2.4 確認台帳の行の新旧の対照

| 欄 | 今（proposal/3、l6-l9:229 と :296-305） | 案 B の新しい行（加算） |
| ---- | ---- | ---- |
| contractId | `scope-storage-authority` | 同じ |
| draftRef／confirmedRef | `nir1-l6-l9-contract-proposal/3` | `nir1-scene-scope-default-proposal/1`（確認後に confirmedRef） |
| 保存するもの | project の registry と、場面ごとの閉じた binding | 上に加えて、project ごとの場面 Scope の既定（新しい表。§3） |
| 新しい場面の marker | 「未設定なら`unknown`」（l6-l9:870） | 継承の条件（§2.2 の 2）を満たせば `explicit`（既定の値）。満たさなければ `unknown`。import と外部 source の作成は継承しない |
| undo／redo／復元・不明な復旧 | 旧資格へ戻さない。不明な復旧は `unknown`（l6-l9:299、:873） | 変えない。継承もしない |
| 既定の変更の効果 | （項目なし） | 既存の場面、registry、token、Revision、宣言を変えない |
| registry の更新 | 全 binding の世代を進め、依存を失効させる（X1/1 Q2） | 変えない。既定が使う ref の削除を拒否する条件を足す |
| In-scope attacks | cross-project、偽造・stale token、unknown→any、ID reuse／restore 混入、stale result（l6-l9:302） | 加えて §2.3 の 6 項 |
| Mandatory defenses | 同じ snapshot での検証、renderer を根拠にしない、unknown／unresolved は fail closed（l6-l9:304） | 加えて §2.3 の 3 項 |
| 開く lane | A1 など | B-1〜B-4（§10.1） |
| 確認していないもの | — | Graph・local 送信・activation UI の公開、閾値、Gold、評価の規則、新しい送信先 |

## 3. データ

### 3.1 保存先の比較

| 案 | 内容 | 問題 | 判定 |
| ---- | ---- | ---- | ---- |
| registry の struct に field を足す | `NarrativeSceneScopeRegistryV1` に既定を入れる | struct は `deny_unknown_fields`（`core scope:42-52`）で、v1 の source token の入力（`core scope:176-199`）になっている。field を足すと全 binding の token が変わる。また、既定を変えるたびに registry の writer が全 binding の世代を進める（`scene_scope.rs:1507-1529`）。これは、ユーザーが B を選ぶときに示された説明（「既に作った場面は変わらない」）と合わない | 採らない |
| (a) `narrative_scope_registries` に token の外の列を足す | 同じ行に、token に入れない列を足す | 同じ行に 2 つの OCC（registry の `version` と既定の版）が並ぶ。registry の authority digest（`scene_scope.rs:719-897` の `read_scope_extension`）から既定を外す保証を、列ごとに書いて試験する必要がある | 次点 |
| (b) `project_settings` の key | 汎用の key-value（`migrate.rs:1094-1099`） | Native の汎用の key-value の writer（`domain_writes.rs:2266` 付近。key は renderer が選ぶ）が同じ表を書く。閉じた型と registry の所属の検証を、汎用の writer の外に置くことになる | 採らない |
| (c) 新しい表 | `narrative_scope_project_defaults` | 表が 1 つ増える（保存範囲の拡大。確認が要るのはどの案でも同じ） | **推奨** |

### 3.2 表の案（SCHEMA 44）

```sql
CREATE TABLE IF NOT EXISTS narrative_scope_project_defaults (
    project_id                TEXT NOT NULL PRIMARY KEY
        REFERENCES projects(id) ON DELETE CASCADE,
    schema_version            INTEGER NOT NULL CHECK(schema_version = 1),
    state                     TEXT NOT NULL CHECK(state IN ('set', 'none')),
    query_identity_json       TEXT
        CHECK(query_identity_json IS NULL OR (json_valid(query_identity_json)
          AND json_type(query_identity_json) = 'object')),
    material_constraint_json  TEXT
        CHECK(material_constraint_json IS NULL OR (json_valid(material_constraint_json)
          AND json_type(material_constraint_json) = 'object')),
    version                   INTEGER NOT NULL CHECK(version >= 1),
    source_token              TEXT NOT NULL CHECK(length(source_token) = 71
                                AND source_token GLOB 'sha256:*'),
    updated_at                TEXT NOT NULL,
    CHECK((state = 'set'  AND query_identity_json IS NOT NULL AND material_constraint_json IS NOT NULL)
       OR (state = 'none' AND query_identity_json IS NULL     AND material_constraint_json IS NULL))
);
```

- 行が無い状態と `state = 'none'` は、どちらも既定なし。「既定を外す」は行を消さずに `state = 'none'` にし、`version` を進める。行を消すと version が 1 からやり直しになり、A→B→A で同じ token に戻りうるので、消さない。JSON の列には `NarrativeSceneQueryIdentityV1`／`NarrativeSceneMaterialConstraintV1` の形（`deny_unknown_fields`。`core scope:54-68`）だけを入れ、「なし」を JSON の中で表さない。
- `source_token` の用途：既定の writer の OCC と、UI が読んだ既定と書く既定の照合に使う。値は `canonical_json_digest({contractId, projectId, state, queryIdentity, materialConstraint, version})`。registry の内容は入れない。既定の token は project の Scope authority にも binding の token にも入れない（§3.3 の 4）。作成の writer は token を照合せず、同じ transaction で行を読むだけにする。
- holder と audience は v1 で reader に固定するので、列を持たない。人物を既定にすると、人物の削除の拒否（`scene_scope.rs:977-1024` の `ensure_character_reference_mutation_allowed_in_tx`）を既定にも広げる必要がある。v1 では避ける。
- material 制約を query identity と別の列にしたのは、将来「本筋の材料をほかの層にも見せる」を選べるようにするため。v1 の writer は、2 列が同じ exact であることを要求する。
- 列追加と表作成の雛形は SCHEMA 43（`migrate.rs:4508`、:10137-10146）。版は `grimodex-core/src/lib.rs:3` の `SCHEMA_VERSION = 43` を 44 にする。merge の順で採番が変わりうる（K2/4 と同じ扱い）。

### 3.3 不変条件

1. `state = 'set'` のとき、既定の 3 軸は exact で、ref は同じ project の registry の member（書込み時に `validate_query_identity`／`validate_material_constraint` と同じ規則で検証する。`core scope:209-260`）。
2. registry の writer（`update_narrative_scene_scope_registry`、`scene_scope.rs:1420-1610`）は、既定が使う ref を消す更新を拒否する。検査は、既存の binding の検証（:1476-1481）と同じ transaction で行う。新しい error code の案は `NEX_SCENE_SCOPE_DEFAULT_REF_IN_USE`。既定を自動でクリアする案は、作者が気づかないまま既定が外れるので採らない。
3. 作成の writer は、次のどの場合も `unknown` を書き、作成自体は失敗させない：既定の行が読めない、型が壊れている、ref が registry に無い、project が違う。推測：作成を失敗させると、本文を書く操作が Scope の不整合で止まる。fail closed にするのは開示で、作成ではない。
4. 既定は project の Scope authority の digest（`read_scope_extension`）に入れない。既定の書込みの前後で authority の token が同じであることを、試験で固定する。

### 3.4 migration

- SCHEMA 44 は表を作るだけで、既存の project に行を入れない（理由は §5.2）。
- 既定の表を、次の 2 つの一覧に加える：generic SQL の拒否一覧（`src-tauri/crates/grimodex-db/src/execute.rs:4470-4500` 付近。`narrative_scope_registries` は :4491）、保護 writer の一覧（`policies/narrative/protected-writers.json:462-475` 付近）。
- schema の生成物も更新する：`src-tauri/crates/grimodex-core/src/workspace_schema.rs`、`src/db/schema.ts`、`src/db/generated/schema-contract.json`、`src/db/narrativeExtractionSchema.test.ts`。
- `profile_egress_policy.rs:322-330` の試験は、`narrative_scope_registries` などを「列挙に無い表」として確かめている。新しい表の分類は実装で決め、K3 の表の分類規則に従う（推測：registry と同じく列挙に入れない）。

### 3.5 「語彙の初期投入」と「既定の初期設定」を分ける

**語彙**は registry の ref（例：`timeline:main`）、**既定**は継承を起こす値。語彙だけを入れても挙動は変わらない（既定が無ければ新しい場面は `unknown`）。

#### 3.5.1 語彙の初期投入（推奨：入れる。U3 で既存の利用者のデータの変更を確認）

- 入れ方：`ensure_scope_registry_in_tx`（`scene_scope.rs:492-520`）が registry を初めて INSERT するとき、`default_registry()`（:90-97。今は 3 軸とも空）の代わりに、本筋の語彙 `timeline:main`／`worldline:prime`／`layer:manuscript` を入れる。値は Scope 欄の placeholder（`SceneScopeRegistryEditor.tsx:8-10`）と CP-4 の G-01 の setup（`docs/plans/nir1-lane-decisions/cp4-decisions.md:680` の DR-CP4-J-2 (1)）に合わせる。
- 効く範囲（registry の行がまだ無い project だけ。既にある行は `ON CONFLICT(project_id) DO NOTHING` で変わらない。:503-507）：
  - `project_create`（`domain_writes.rs:1686`）
  - サンプル（`sample_seed.rs:229`）
  - generic import（`src-tauri/crates/grimodex-db/src/import/commit.rs:163-167` が `INSERT INTO projects` を直接実行し、registry は最初の場面の作成のときに `scene_scope.rs:445` で作られる）
  - 修復時の lazy 生成（`scene_scope.rs:445`）
  - A1 の migration の backfill（`scene_scope.rs:536-539`。`migrate.rs:4535-4543` の `current < 36` のとき）
- backfill に効くことの意味：公開版の最後の schema は 2（`grimodex-core/src/lib.rs:4-8` の `LAST_PUBLIC_RELEASE_SCHEMA_VERSION = 2`）。**公開版から更新する利用者の既存の project には、すべて本筋の語彙が入る**。挙動は変わらない（その project の場面は `legacy-absent`。新しい場面も既定が無いので `unknown`）が、既存の利用者の DB に migration で入るデータが変わる。新しい workspace の `default-project`（`migrate.rs:1521-1527`）にも同じ経路で入る。schema 36〜43 の workspace（公開されていない開発版の利用者だけ。推測）の既存の project には入らない。
- harness を壊さない理由：
  - `unknown` の binding は query identity が 3 軸とも unresolved、material 制約が any（`scene_scope.rs:99-119`）なので、registry の ref を参照しない。registry の所属を要するのは exact だけ（`core scope:209-260`）。
  - 3 つの harness はどれも registry を配列ごと置き換える（`scripts/quality/nir1-graph-eval/frozen-setup-driver.mjs:742-746`、`setup-driver.mjs:372-388`、`electron/native/grimodex-node/src/nir1_final_request_eval/harness/workspace.rs:514-530`）。置換の検証（`scene_scope.rs:1476-1481`）は通る。
  - 凍結 driver の照合（`frozen-setup-driver.mjs:1975-1977`）は置換後の行を plan と比べるので、初期の中身に依らない。推測：受領書が置換前の registry の中身を記録していないことは、実装時に receipt の形で確かめる。
- 得るもの：
  - 語彙のある project では、作者が後で「本筋を既定にする」を押しても registry を変えずに済み、何も失効しない（§6）。公開版から更新した利用者の既存の project と、新しい workspace の `default-project` がこれにあたる。
  - `legacy-absent` の場面を保存するときに exact を選べるので、材料 §4 の「保存の罠」が起きにくくなる。罠とは、registry が空だと exact を選べず、`explicit`＋`unresolved` になること。
- 費用：
  - 初期の registry が空であることを前提にした試験の期待値が変わる（例：`scene_scope.rs:2109-2150` の、`default_registry()` を使う試験）。
  - Gate A2 の upgrade の fixture と試験（`src-tauri/crates/grimodex-db/tests/support/release_schema_fixture.rs` と、それを使う `migration_subprocess_crash.rs` など）が、更新後の registry の中身を照合していれば、期待値が変わる。照合しているかは確かめていない（§10.4）。

#### 3.5.2 既定の初期設定（推奨：β）

| 案 | 内容 | 利点 | 問題 |
| ---- | ---- | ---- | ---- |
| α 自動 | 全ての `project_create` と registry の初回 INSERT で、既定も入れる | 作者は何もしなくてよい | harness が壊れる。CP-4 の凍結 setup は、Scene を作ってから registry を fixture の ref に置き換える（`frozen-setup-driver.mjs:632-654` の `tree_node_create` の後に、:724-750 の `scope-registry`）。DP-H も同じ順（`harness/run.rs:211`→:235→:246-255→:263-273）。継承で `explicit`（`timeline:main`）になった binding を、置換後の registry で検証すると失敗し、setup が止まる。置換後の registry は G-02〜G-08 では `tl-main` など（DR-CP4-I-4 (5)、`cp4-decisions.md:640`）、DP-H では `timeline:v2-mainline`（`evals/nir1-packing/final-request.v2.json:86-88`）。直すには、harness の変更、CP-4 の再凍結、DP-H の freeze の変更が要る |
| **β 作成 UI だけ（推奨）** | `CreateProjectDialog` に「新しい場面を『本筋』で作る」を置き、`project_create` の payload の optional な typed field（例：`sceneScopeDefault: "main-line"`）で運ぶ。Native は同じ transaction で既定を書く | 凍結 harness は field を渡さないので、初期状態が今と同じになる。CP-4 は `src/features/project/api.ts:46-83` の `createProject` を `scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts:181` から呼び、DP-H は N-API の `project_create` を呼ぶ。UI からの作成（`projectStore.ts:693` の `createNewProject`、`ProjectMenu.tsx:81`）には効く | migration が作る `default-project`（`migrate.rs:1521-1527`）と generic import の project（`import/commit.rs:163-167`）は `project_create` を通らないので、既定なしのまま。新しい利用者の最初の project なので、最初の起動で 1 クリック（§7.1 の案内）が残る。語彙は入っているので、その 1 クリックでは何も失効しない |
| γ β ＋ bootstrap | β に加え、SCHEMA 44 の migration が「場面が 0 件で registry が版 1 の project」にだけ既定を入れる | 新しい workspace の最初の project も、最初から本筋 | L0 の setup は workspace の最初の project を使う（`scripts/quality/setup-nir1-retrieval.mjs:240-290` 付近）。その場面が `explicit` の本筋になり、L0 の R+IR の観測が変わりうる。L0 の再測定の要否の判断が要る。既存の workspace の空の project にも入る |

- 推奨は β。理由：
  - ユーザーが B を選ぶときに示された説明（既に作った場面は変わらない）と、凍結済みの harness の不変が両立する。
  - renderer の申告は開示の認可ではなく、新しい project の属性の初期値で、Native が型と registry の所属を検証する。同じことは既存の IPC（registry と Scene Scope の更新）でもできるので、新しい権限にならない（§8.3）。
- γ は、L0 への影響を確かめた後に integrator が提案できる。v1 では採らない（§10.3 の技術判断 T3）。
- 取り込みの扱い：取り込みで新しい project を作る経路（`src/features/import/importTarget.ts:41` が store の `createNewProject` を直接呼ぶ）と、今の project に取り込む経路（`importTarget.ts:10-15` の `"currentProject"`）がある。どちらでも、取り込んだ場面は Native が継承しない（origin `import`。§2.2 の 2 の (a)）。取り込みの画面のチェック「取り込みのあと、取り込んだ場面に既定の Scope を当てる」（既定はオフ。U2）が ON のときだけ、次を行う。
  - 新しい project なら、`createNewProject` に `sceneScopeDefault` を渡して既定を作る。
  - 取り込みの完了後に、取り込んだ場面へ既存の writer `narrative_scene_scope_update` をループで呼ぶ（§5.1 の「既定を当てる」と同じ操作。部分適用の表示も同じ）。
  - 今の project に既定が無ければ、チェックは出さない（設定画面への案内だけを出す）。
  - store の `createNewProject` の既定値をオンにする案は採らない。作者がチェックを見ないまま、取り込んだ原稿の全場面（回想の章を含みうる）が本筋になる（§8.1）。

### 3.6 export／snapshot／backup／restore

| 仕組み | 今 | B での扱い（推奨） | 根拠 |
| ---- | ---- | ---- | ---- |
| backup（workspace の DB 全体） | registry と binding を含む。restore の前検査は、欠けた binding を fail closed にする | 新しい表も DB に含まれる。SCHEMA 44 より前の backup を戻すと、migration が空の表を作り、既定なしになる | `backup_restore.rs` の試験 `restore_of_current_a1_backup_with_missing_binding_remains_fail_closed`（:3054 付近）、`migrate.rs:11190` 付近の試験名 |
| project snapshot | 捕える表の一覧（`SnapshotRestoreTable`、`project_snapshots.rs:470-620`）に Scope の表は無い。本文 restore は binding を作り直し `unknown` にする | 既定も捕えず、戻さない。既定は project の設定で、内容の版ではないと扱う。restore の後も今の既定が残る。作り直す binding は継承しない（§4.1） | `project_snapshots.rs:2897-2961`、:3707-3765（`assert_eq!(after.1, "unknown", "the default A1 marker")` は :3760） |
| ゴミ箱 | payload は renderer が作り、Scope を持たない。restore は新しい ID で場面を作る | 既定を当てない（§4.3） | `trash_bin.rs:136`、:294-420（`restore_id` は :300、binding は :408） |
| 本文の export（.md など） | Scope を出さない（推測） | 変えない | 未確認 |
| 既定の read の公開範囲 | — | 新しい IPC の read と write（§7）。restricted profile でも通す internal command に分類するかは、K3 の分類規則に従う。`electron/main/profileEgress.ts:487-489` の Scope の 3 command と同じ扱いを推奨 | `profileEgress.ts:470-500` |

## 4. 継承の経路

### 4.1 Scene を作る全ての経路（実物で列挙）

正本は 2 つ：writer の網羅の試験 `src-tauri/crates/grimodex-db/tests/narrative_scope_storage_authority.rs` の MANIFEST、`ensure_scene_scope_binding_in_tx` の呼出し元（`git grep`）。MANIFEST の `SceneCreate` は :222-226、:257-261、:320-324、:369-373、:488-492、:502-506、:530-534 付近、`ProjectRestore` は :466-478 付近。走査の範囲は `src-tauri/crates/*/src` の test でない code（同 :651-699）。test の中の呼出しは除いた（材料 §6 の注）。

renderer の呼出し元は、review-1 の P1・P2 と review-2 の P3-4 を受けて足した。`tree_node_create` は 1 つの Native の writer だが、renderer の呼出しによって origin、lineage、外部 source が違う。行を分けた。

| 経路 | 呼出し（file:line） | origin／lineage | 今 | B の推奨 | 理由 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| ツリーからの場面の作成 | renderer：`treeStore.ts:1174`（`createScene`）ほか、`src/features/tree/api.ts:404-445` の `createNode`（既定の origin は `human`、`writeContext.ts:90`）→ Native：`domain_writes.rs:3325` | human、lineage なし、外部 source なし | `unknown` | **継承** | 新しい場面。B の対象そのもの |
| マトリクスからの場面の作成 | `src/features/matrix/MatrixPanel.tsx:288` | human、lineage なし | `unknown` | **継承** | 作者の新しい場面 |
| 構成テンプレートの一括作成 | `src/features/grid/applyStructureTemplate.ts:108`（場面。:88 は folder） | human、lineage なし | `unknown` | **継承** | 作者が選んで作る新しい場面。U1 の「作者が新しく作った場面」に含むと明示する |
| スマホの空の project での自動作成 | `src/features/tree/PhoneEmptySceneBootstrap.tsx:19`（`interaction: "implicit"`） | human、lineage なし | `unknown` | **継承** | 空の project に作る最初の場面。U1 に含むと明示する |
| 削除の undo（同じ ID で作り直す。章の削除の undo を含む） | `treeStore.ts:1544-1559`（`restorePersisted`）、章は :1529 の `deleteTreeSubtree` | undo、lineage あり | `unknown` | **継承しない** | 回想に設定していた場面が、Ctrl+Z で本筋として戻るのを防ぐ（P1）。l6-l9:870（削除後の ID の再利用）、:873 |
| 作成の redo | `treeStore.ts:1381-1396`（`recreatePersisted`） | redo、lineage あり | `unknown` | **継承しない** | 履歴の再生。既定を変えた後の redo で、作成時と違う値が入るのを防ぐ |
| history-replay の route の作成 | `domain_writes.rs:3226-3233` が受ける route | route が `history-replay` | `unknown` | **継承しない** | 同上 |
| 取り込み（新しい project、今の project） | `src/features/import/importApi.ts:633-642`、`scan/scanImportOperations.ts:106-116` | import、lineage なし | `unknown` | **継承しない**（チェックが ON なら、完了後に既存の writer で当てる） | 取り込んだ原稿には回想の章が含まれうる。作者が場面を 1 つずつ作っていない（review-1 P2-2、review-2 P2-1 の (ii)）。U1、U2 |
| 外部 mount の同期 | `src/features/external-mount/mountManager.ts:1320-1335`（場面。`sourceUri`／`sourceMtime` を渡す）。:1005、:1225 は folder | human（writeContext を渡さない）、lineage なし、**外部 source あり** | `unknown` | **継承しない**（Native が外部 source で判定） | 同期は file の状態を写すもので、復元に近い。origin だけでは作者の作成と区別できないので、`source_uri`／`source_mtime` で判定する（review-2 P2-1 の (i)）。`createNode` に `sourceUri` を渡すのは今は mount だけ |
| ゴミ箱の renderer の restorer（今は未配線） | `src/features/trash-bin/restorers/scene.ts:54`。製品のコードからの呼出しは無く、`pickupHandlers.ts:16` が型を import するだけ | 今は writeContext を渡さず human。**配線するときは origin `restore`（route `restore-or-migration`）を要求する** | — | **継承しない**（Native が origin で判定） | 受入れ試験 R4 で固定する（review-1 P3-6、review-2 P2-1 の (iii)） |
| AI の木構造計画の適用 | `domain_writes.rs:5616`（`apply_ai_tree_plan`）。in-app agent からも呼べる（review の確認：`electron/main/ipc.ts:258-261`） | ai-apply。`redo` が false のときだけ | `unknown` | **継承**（`redo` が true なら継承しない） | 新しい場面。計画（model output）は Scope を指定できず、IR には人の承認が要る（§8.3） |
| 付箋の昇格 | `map_writes.rs:782`（`promote_sticky`） | 既定は human。undo／redo のとき継承しない（`map_writes.rs:1163-1169` で origin から cause を決める） | `unknown` | **継承**（forward だけ） | 新しい場面 |
| ゴミ箱からの復元（Native） | `trash_bin.rs:408`（`restore_scene_in_tx`） | 復元（新しい ID） | `unknown` | **継承しない** | §4.3 |
| project snapshot の本文 restore | `project_snapshots.rs:2946`（`apply_project_snapshot_restore`） | 復元 | `unknown` | **継承しない** | §4.3。l6-l9:873。binding が残る場合は :2955-2960 の refresh だけで、既定は入らない（どちらの場合があるかは §10.4） |
| 本文保存（欠けた binding の修復） | `scene_body.rs:379`（`save_scene_body_bundle`） | 修復（場面は既にある） | `unknown` | **継承しない** | 場面を作らない。binding が欠けた理由が分からない（不明な復旧。l6-l9:873） |
| 製品同梱サンプル | `sample_seed.rs:229`（registry）、:267（場面） | seed | `unknown` | v1 では**継承しない** | サンプルの内容に回想・作中作があるかを確かめていない。あれば出荷物で §8 の危険が起きる |
| 性能 lane の seed | `runtime_performance_seed.rs:617` | seed（開発用） | `unknown` | 継承しない | 性能の fixture を変えない |
| 容量の fixture | `narrative_extraction/nir1_capacity_fixtures.rs:477`、:497 | seed（試験用。MANIFEST に載る） | `unknown` | 継承しない | 試験の前提を変えない |
| migration の backfill | `migrate.rs:4542`（`backfill_scene_scope_storage_in_tx`、`scene_scope.rs:524-572`） | migration | `legacy-absent` | 変えない | l6-l9:865 |
| project の作成（registry） | `domain_writes.rs:1686` | — | 空の registry | 語彙を入れる（§3.5.1）。β の field があれば既定も | §3.5 |

材料 §4 は「呼出し元は製品コードでおよそ 8 箇所」とする。Native の binding を作る経路は 8 つ（作成、AI 計画、付箋、ゴミ箱、snapshot、本文保存、サンプル、性能 seed）で、数は合う。継承できる Native の writer はそのうち 3 つ。そのうち `tree_node_create` は、renderer の呼出しの種類で継承するものとしないものに分かれる。ユーザーの記録の素直な読み（「新しい場面は作成時の project の既定を受け継ぐ」）は全経路の継承とも読めるので、この絞り込みを U1 で確認する。複製の機能はツリーの code に見つからなかった（推測：無い）。

### 4.2 書き方

- `ensure_scene_scope_binding_in_tx(conn, project, scene, at)`（`scene_scope.rs:434-475`）に、作成の種類を表す閉じた引数を足す。案：`SceneScopeInit::NewSceneInheritProjectDefault`／`SceneScopeInit::UnknownRepairOrRestore`。bool にしない（呼出しの意図を読めるようにし、将来の復元経路が黙って継承しないようにする）。
- 継承の判定は、3 つの writer の中で、origin と lineage を検証した後に置く（`tree_node_create_with_authority` では :3269-3283 の `validate_tree_replay_lineage_in_tx`／`validate_tree_replay_target_in_tx` の後）。判定の関数を 1 つにまとめ、3 つの writer で共有する。案：`scene_scope_init_for_create(origin, original_transaction_id, undo_journal_id, route, redo, has_external_source)`。§2.2 の 2 の (a)(b)(c) を満たすときだけ `NewSceneInheritProjectDefault` を返し、それ以外はすべて `UnknownRepairOrRestore` を返す。
- `NewSceneInheritProjectDefault` のとき、同じ `conn`（同じ transaction）で既定と registry を読む。§3.3 の 1 を満たせば、次の binding を `insert_binding_in_tx`（:691-716）で書く：`compatibility_marker: Explicit`、`query_identity` と `material_constraint` は既定の exact、`knowledge_holder`／`audience` は reader、`version: 1`、新しい `scene_incarnation_id`。満たさなければ今の `unknown`（:461-472）。
- binding が既にあれば何もしない（:447-459 の早期 return。変えない）。
- renderer の field は足さない。改訂 1 の `sceneScopeInit` は、改訂 2 で (a)〜(c) を Native が判定するようにしたので削った。そのため、作成の command の payload と冪等の fingerprint（`canonical_write_payload_fingerprint`、`idempotency.rs:121-130`）は変わらない。将来、継承を止める field を足すなら、fingerprint に入る（再送で値が変わると `TREE_NODE_CREATE_REQUEST_CONFLICT`）ことと、`canonicalPayload`（`src/features/tree/api.ts:433`）に入れるかを、そのとき決める。`requireTreeNodeCreatePayload`（`ipcContract.ts:4255-4286`）は未知の key を拒否しないので、値域の検査を main に足す必要もある。
- feed：今の作成は場面の作成の event を出し、binding の作成に `scene-scope` の event は出さない（推測：`ensure` は feed を書かない。:434-475 に feed の呼出しが無い）。B でも変えない。X1/1 の routing は Scene の create を投影の identity に写す（`docs/plans/nir1-scene-scope-projection-proposal-1-draft.md:284` の節「完全な Source としての登録」の feed の routing の項）ので、投影の扱いも変わらない。
- 静的な試験（P3-7）：MANIFEST の class を分けるだけでは足りない。snapshot の restore は `ProjectRestore` の class で、本文保存は MANIFEST に無い（場面の INSERT ではない）。代わりに次の grep の試験を置く。
  - `NewSceneInheritProjectDefault` の定数は、許可した 3 関数の中の、`scene_scope_init_for_create` の結果で守られた分岐にだけ現れる。
  - `scene_scope_init_for_create` の定義が `NewSceneInheritProjectDefault` を返すのは、(a)(b)(c) を満たす 1 つの分岐だけ。
  - それ以外の `ensure_scene_scope_binding_in_tx` の呼出しは、すべて `UnknownRepairOrRestore`。
  
  実行時の分岐は、§10.2 の R1〜R4 で固定する。

### 4.3 復元の経路は「元の scope を保つ」か「既定を当てる」か

| 選択 | 中身 | 評価 |
| ---- | ---- | ---- |
| 今どおり `unknown`（**推奨**） | 復元・undo で戻した場面は未設定 | fail closed。l6-l9:873 と X1/1 の F19 に合う。作者は §7 の案内と 1 クリックで当てられる |
| 既定を当てる | 戻した場面を本筋にする | 消す前に回想・夢に設定していた場面が、黙って本筋に化ける。作者は「元に戻した」と思っているので気づきにくい。§8 の危険がもっとも強く出る |
| 元の scope を保つ | 削除時または snapshot の作成時に Native が binding の A1 を保存し、復元で新しい incarnation に写す | ゴミ箱の payload は renderer が作り（`trash_bin.rs:136`）、snapshot は Scope の表を捕えない（§3.6）。undo も今は旧 binding を記録していない（推測）。保つには、保存範囲を広げる新しい契約が要る。l6-l9:301 は restore 由来のデータを untrusted とする。B とは別の draftRef と確認が要る |

## 5. 既存の場面

### 5.1 既に `unknown` の場面

| 選択 | 中身 | 評価 |
| ---- | ---- | ---- |
| そのまま | 作者が設定するまで IR／Graph は出ない | 安全だが、B の前に作った project では効果が出ない |
| **作者の操作で当てる（推奨）** | 場面の Scope 欄の「既定を当てる」、章（folder）の「この章の未設定の場面に既定を当てる」、project の「未設定の場面すべてに既定を当てる」。どれも既存の writer `narrative_scene_scope_update`（`scene_scope.rs:1241-1418`）を場面ごとにループで呼ぶ | 作者が押すので「明示設定」の意味が保たれる。新しい 1 transaction の一括 writer にしないので、X1/1 の writer の閉じた一覧を広げない（材料 §5 の案 A の補足）。部分的に適用されうる（途中の失敗、OCC の不一致）ので、何件に当て何件に当てられなかったかを画面に出す |
| migration で当てる | 既存の `unknown` を一斉に本筋にする | 作者が決めていないものを決めたことにする度合いが最大。既存の project には既定が無いので、当てる値も migration が決めることになる。採らない |

- 対象は `unknown` の場面だけにし、既に `explicit` の場面は触らない（作者の設定を上書きしない）。
- 取り込みの画面のチェックが ON のとき（§3.5.2）も、取り込みの完了後に同じループを、取り込んだ場面に対して呼ぶ。
- 当てると、その場面の A1 の設定の変更になり、その場面に anchor する型付き Revision と本文の宣言が失効する（§6）。`unknown` の場面の Revision は IR／Graph にもともと使われていない（推測）ので失うものは小さいが、確認ダイアログで件数を示す。

### 5.2 既存の project の既定

- migration では入れない。入れると、それまで新しい場面が `unknown` で作られていた project で、作者が気づかないまま新しい場面が本筋になる（§8 の危険が、説明なしに始まる）。
- 既定は作者が設定画面（§7.1）で選ぶ。そのとき registry の更新が要るかは、利用者の種類で分かれる。
  - 公開版（schema 2）から更新した利用者の project と、新しい workspace の `default-project`：§3.5.1 で語彙が入っているので、registry の更新は要らない。何も失効しない。
  - schema 36〜43 の workspace の既存の project（開発版の利用者だけ。推測）と、作者が語彙を消した project：registry の更新が要り、その project の型付き Revision と宣言がすべて失効する（§6）。画面でそれを示す。

### 5.3 `legacy-absent` の場面

- そのまま残す（IR は出る、Graph は出ない。材料 §4）。
- 「既定を当てる」は `legacy-absent` から `explicit` への一方向の変更で、戻せない（`scene_scope.rs:1283-1289`）。章・project の一括の対象からは既定で外し、別のボタンと警告にする。
- 公開版から更新した利用者の `legacy-absent` の場面は、§3.5.1 で語彙が入るので、保存の罠が起きにくくなる。schema 36〜43 の workspace など registry が空の project では、罠が残る。Scope 欄で「registry が空のまま保存すると未解決の明示になり、IR が出なくなる」ことを、保存の前に示す（§7.3）。

## 6. 失効

前提（確認済み）：

- binding の v1 の token は registry 全体を含む（`core scope:176-199`）。
- registry の writer は、全 binding の version を進め、token を計算し直す（`scene_scope.rs:1507-1529`）。
- X1/1 の投影は binding の値と世代を含む。registry の変更で、全 anchor の型付き Revision が失効する（X1/1 draft :422-431）。
- K2/4 の宣言は、registry の変更でも失効する（l6-l9:251）。
- feed の transaction は、kind を問わず IR と Graph の Index を次の publish まで dirty にする（K2/4 の C17、`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md:148`）。ただし X1/3 で、本文だけの保存は Graph の Index を dirty にしなくなった（l6-l9:249）。

| 操作 | registry | 既存の binding | 型付き Revision・投影 | 本文の宣言 | Index | 対処 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| 新しい project の初期設定（β） | 作成時に語彙を入れる | 無い | 無い | 無い | feed なし（推測：`project_create` は Scope の feed を書かない） | 不要 |
| 語彙の初期投入（§3.5.1。backfill を含む） | registry の作成時だけ | 作成時は無い。backfill では `legacy-absent` の行を作る前後（同じ migration の中） | 無い（backfill の前の版の型付き Revision は、A1 の導入で既に資格を持たない。推測） | 無い | 変わらない | 不要 |
| 既定を設定・変更する（ref は registry にある） | 変えない | 変えない | 失効しない | 失効しない | 変えない（既定の writer は narrative の feed を書かない。下の注） | 不要。試験で token の不変を固定 |
| 既定を設定するために registry に ref を足す | 進む | 全場面の世代が進む | project の全件が失効 | 全件が失効 | dirty | 画面で事前に警告する。registry の更新は既存の writer で、作者の操作 |
| 新しい場面の作成（継承） | 変えない | 新しい行（新しい incarnation） | その場面の投影が新しく生まれる。ほかは変わらない | 新しい場面にはまだ無い | 作成の feed で今どおり | 不要（今と同じ） |
| undo／redo・復元・修復で `unknown` を書く | 今どおり | 今どおり | 今どおり | 今どおり | 今どおり | 変えない |
| 既存の `unknown` の場面に既定を当てる | 変えない | その場面の世代が進む | その場面に anchor するものだけ失効 | その場面の宣言が失効 | dirty | 確認ダイアログで件数を示す。章・project の一括では合計 |
| 既定が使う ref を registry から消す | 拒否 | — | — | — | — | error を画面で説明し、先に既定を変えるよう促す |

注：既定の writer が narrative の feed を書かない理由は、feed の transaction が kind を問わず IR と Graph の Index を dirty にするため（C17）。既定は Source を持たず、どの consumer の入力でもない。既定の変更の履歴は、canonical の change event（`crate::change_events::AppendChangeEvent`。`scene_scope.rs:31` で import）として残す方向を推奨する。残さないと「いつから本筋で作られたか」を後から追えない。記録する範囲（変更前後の値、時刻、request）は保存範囲の判断なので、draft の本文に書いて U4 で確認する（T9）。推測：canonical の event は narrative の feed ではないので、Index には効かない。

## 7. UI

### 7.1 project の既定の設定画面と、作成・取り込みの画面

- 場所：設定 > プロジェクト（`src/features/settings/categories/ProjectCategory.tsx`）。ここには既に物語の読みの軸（`phaseResolutionMode`、:79-83）がある。
- 中身：
  - 見出しと説明
  - 3 軸の選択（registry の語彙から選ぶ。「既定なし」も選べる）
  - registry に無い値を選んだときの警告（全件が失効する）
  - 「未設定の場面に既定を当てる」ボタン（§5.1）
- 作成ダイアログ（`src/features/project/CreateProjectDialog.tsx`）：チェックボックス「新しい場面を『本筋』で作る」。**既定オンかオフかは U2 で確認する**。オンの意味は、作者が場面ごとには触っていない場面にも、Native が `explicit`（設定済み）を書くこと（l6-l9:861、:870 の「明示」の意味に関わる）。推奨はオン。理由：オフでは、ユーザーが B を選んだ目的（何もしなくても本筋どうしで出ること）が既定の操作で実現しない。オンでも、作者は画面でチェックを見てから作るので、黙って決めたことにはならない。
- 取り込みの画面：チェックボックス「取り込みのあと、取り込んだ場面に既定の Scope を当てる」。推奨は既定オフ（U2）。理由：取り込む原稿の中身を作者が場面ごとに見ていない。ON のときは、取り込みの完了後に既存の writer で当てる（Native の継承ではない。§3.5.2）。
- 既定の無い project（既存の project と、β での `default-project`）を開いたとき、関連場面の欄か Scope 欄に一度だけ案内を出す。

文言の案：

| key の案 | 日本語 | English |
| ---- | ---- | ---- |
| `settings.project.sceneScopeDefault` | 新しい場面の Scope の既定 | Default scope for new scenes |
| `settings.project.sceneScopeDefaultHint` | 新しく作る場面は、この Scope で作られます。回想・夢・別の世界線・作中作の場面は、作ったあと場面ごとに変えてください。既定を変えても、既にある場面は変わりません。取り消し・やり直し・ゴミ箱・スナップショットで戻した場面、外部フォルダから同期した場面、取り込んだ場面は未設定になります（取り込みは画面で選べば、取り込みのあとに既定を当てます）。 | New scenes start with this scope. For flashbacks, dreams, other worldlines or stories within the story, change the scope of each scene after creating it. Changing the default does not change existing scenes. Scenes brought back by undo, redo, the trash or a snapshot, scenes synced from an external folder, and imported scenes start unset (for imports, you can choose to apply the default after importing). |
| `settings.project.sceneScopeDefaultNone` | 既定なし（新しい場面は未設定） | No default (new scenes start unset) |
| `settings.project.sceneScopeApplyUnset` | 未設定の場面に既定を当てる | Apply the default to unset scenes |
| `settings.project.sceneScopeRegistryWarning` | この値を使うには Scope の語彙に追加します。追加すると、このプロジェクトの承認済みの解釈と本文の宣言がすべて失効し、作り直しが必要になります。 | Using this value adds it to the scope vocabulary. This invalidates every approved interpretation and body declaration in this project; they must be recreated. |
| `project.create.sceneScopeMainLine` | 新しい場面を「本筋」で作る（あとで変えられます） | Create new scenes in the main line (you can change this later) |
| `import.sceneScopeApplyDefault` | 取り込みのあと、取り込んだ場面に既定の Scope（本筋）を当てる（回想などが含まれる場合は、あとで場面ごとに変えてください） | After importing, apply the default scope (main line) to the imported scenes (if they include flashbacks or similar, change those scenes afterwards) |

### 7.2 語彙の表示名

ref は識別子のまま保存し、既知の ref だけを表示名に写す。ref を訳すと registry の値が言語で変わるので、訳さない。

| ref | 日本語 | English |
| ---- | ---- | ---- |
| `timeline:main` | 本筋の時間 | Main timeline |
| `worldline:prime` | 本筋の世界線 | Main worldline |
| `layer:manuscript` | 本編 | Main narrative |
| （3 つの組） | 本筋 | Main line |

### 7.3 場面の Scope 欄の日本語化

- 今の状態：
  - `editor.sceneDetail.*` の key に英語の既定値を渡しているが、`ja.json` と `en.json` に key が無い（材料 §4。#783 の後も無い）。
  - `SceneScopeFields.tsx` の選択肢の `"Any"`、`"Unresolved"`（:42-43）と、軸の名前（:110 の `axis === "narrativeLayer" ? "layer" : axis`）は文字列の直書きで、key すら無い。
  - marker の表示（`SceneScopeEditor.tsx:321-324` の `draft.compatibilityMarker`）も生の値。
- 訳の案：

  | 原語 | 訳 |
  | ---- | ---- |
  | Scope | 適用範囲（Scope） |
  | Query | この場面の位置 |
  | Material | この場面を材料として見せる範囲 |
  | Any | 制約なし |
  | Unresolved | 未解決 |
  | timeline | 時間軸 |
  | worldline | 世界線 |
  | layer | 語りの層 |
  | `explicit` | 設定済み |
  | `unknown` | 未設定 |
  | `legacy-absent` | 以前からの場面（未設定） |
  | Scope registry | Scope の語彙 |
  | Holder | 知っている人 |
  | Audience | 読み手 |

- query と material の連動：Scope 欄で query の軸を変えたら、material の同じ軸も同じ値に追随させる。「材料の範囲を別に決める」を開いたときだけ追随を外す。query と material が食い違ったまま保存するときは、保存の前に警告する。理由は §8.4 の 4。
- 既定と同じ値の場面には「本筋（プロジェクトの既定）」のバッジを出す。比較は query と material の両方で行う。バッジは、既定の行と binding を比べて renderer で決め、保存はしない（推測：provenance の列を binding に足すと、binding の形と token が変わるので足さない）。
- `legacy-absent` で語彙が空のときは、保存の前に警告する（§5.3）。

### 7.4 IR が出ないときの案内（案 A の要素）

- 今の文言は `relatedScenes.irUnsupported`「この参照条件では承認済み解釈を検索できません。本文検索の結果を表示します。」（`src/locales/ja.json:4179`）で、`RelatedScenesSection.tsx:156-166` が `unsupported-query` のときに出す。
- wire の理由は閉じた union（`electron/shared/relatedScenesSearchWire.ts:86-93`）で、N-API は `supported_profile=false` を一律 `unsupported-query` にする（`electron/native/grimodex-node/src/related_scenes/begin.rs:115-119`）。理由を足すと閉じた一覧が変わり、契約の変更になる。
- 推奨：wire を変えない。関連場面の欄が既存の `narrative_scene_scope_read` で今の場面の marker を読み、文言を分ける。
  - `unknown`：「この場面の Scope が未設定のため、承認済みの解釈は出ません。［Scope を設定］［既定を当てる］」
  - `explicit` で軸に未解決がある：「この場面の Scope に未解決の軸があるため、承認済みの解釈は出ません。［Scope を開く］」
  - それ以外：今の文言（archived や読みの軸など、Scope 以外の原因がありうる。材料 §4）。
- 本筋以外の Scope の場面には、案内ではなく欄の注記として「この場面は本筋以外の Scope です。同じ Scope の場面の解釈だけが出ます。」を出す（推測：この場合は `unsupported-query` にならず、材料が絞られるだけ）。
- 案 A から含めるもの：案内の改善、1 クリックで既定を当てること、章・project の単位のループ。含めないもの：新しい 1 transaction の一括 writer（X1/1 の閉じた一覧を広げる）。

## 8. 開示の安全

### 8.1 危険

作者が回想・夢・別の世界線・作中作の場面の Scope を変え忘れると、その場面は本筋として作られる。その場面から承認した解釈（IR）や Entity／Relation（Graph）が、本筋の後ろの場面の参照に混ざる（材料 §2 の表）。たとえば夢の中の出来事が、現実の出来事として関連場面に出る。改訂 1 と 2 では、undo／redo、外部 mount、取り込みで戻った・入った場面を Native の継承の対象から外した。その分、作者が気づかないまま本筋に化ける経路は、草稿より減った。取り込みで当てるのは、作者が画面でチェックを ON にしたときだけ。

### 8.2 変わらない防御

- 読書順：材料は今の場面より前の場面に限る（l6-l9:877）。B は順位を変えない。
- 秘密：query の `allow_secrets: false`（`query_context.rs:197`）。B は秘密の扱いに触れない。
- 人の承認：IR／Graph の材料は承認済みの Revision だけ。AI が作った場面でも、承認しなければ材料にならない。
- material 制約を exact にする（§2.2 の 1）。今の `unknown` の既定の material は any（`scene_scope.rs:113-119`）。query だけを exact にして material を any のまま継承すると、作者が後で回想の場面の query だけを変えても、その場面の材料がどの query にも見える（材料 §5 の B の行）。material も exact にしておけば、作者が Scope 欄で両方を変えたとき、本筋の場面には出ない。CP-4 の setup も query と material を同じ値にしている（`setup-driver.mjs:390-412`）ので、測った条件と一致する。

つまり B で増えるのは「過去の場面の間で、層や世界線が混ざる」危険で、未来の情報や秘密が出る危険は増えない（材料 §2 の結論と同じ）。

### 8.3 脅威モデルへの影響

| 面 | 評価 |
| ---- | ---- |
| 新しい IPC（既定の read と write）と `project_create` の新しい field | renderer は既に `narrative_scene_scope_update` で、任意の場面に任意の explicit な Scope（material の any を含む）を書ける（`SceneScopeEditor.tsx:211-229`、`scene_scope.rs:1241-1418`）。既定の write はそれより弱い（未来の作成にだけ効き、exact に限る）。どちらも新しい権限を増やさない（既存の writer の検証の範囲からの読み）。作成の command には field を足さない |
| model output（AI の木構造計画） | 計画は場面を作れるが、Scope を指定できない（`apply_ai_tree_plan` の INSERT の列、`domain_writes.rs:5599-5611`）。継承される Scope は作者が決めた既定。材料になるには人の承認が要る。計画の redo は継承しない |
| undo／redo／history-replay、取り込み、同期、restorer | Native が origin、lineage、外部 source で判定し、継承しない（§2.2 の 2）。origin は renderer の申告で、main は origin を route に写すだけ（`ipc.ts:1898-1912`）。renderer が origin を `human` と偽れば、undo（lineage を持つ呼出しは lineage の検証が要る）以外の作成は作者の作成として扱われ、既定を受け継ぐ。それで書けるのは project の既定の値だけで、同じことは既存の Scope の writer でもできる。新しい権限ではない |
| cross-project、偽造の ref、stale な既定 | 作成の writer が同じ snapshot で project と registry の所属を検証し、外れれば `unknown`（§3.3） |
| dangling な既定から any への fallback | 起きない。`unknown` に落とす（§2.2 の 5） |
| 復元の経路での黙った継承 | 作成の種類の引数、判定の関数、grep の試験、実行時の試験で固定する（§4.2、§10.2） |
| 送信先 | 新しい送信先は無い。既存の規則の下で、IR の材料になる場面の数が増えるだけ（作者が手で設定した場合と同じ）。IR が外部の AI への要求にどこまで入るかは、この調査では追っていない（§10.4） |
| 保存範囲 | 新しい表で広がる。AGENTS の委任の外なので確認が要る |

### 8.4 軽減

1. 作成直後の表示：Scope 欄のバッジ「本筋（プロジェクトの既定）」（§7.3）。ツリーの場面行に、既定と違う Scope の印を出す案もある（推測：既定と同じ場面が大多数なので、違うほうに印を付けたほうが目立つ）。
2. 章単位の切替：章（folder）のメニューに「この章の場面の Scope を…にする」を置く（既存の writer のループ。§5.1 と同じ部分適用の表示）。
3. 設定画面、作成ダイアログ、取り込みの画面の説明文に、「回想・夢・別の世界線・作中作は場面ごとに変える」ことを書く（§7.1）。
4. 作者が直した後も残る混入への対処：
   - 状況：B の既定は query も material も exact（本筋）。作者が回想の場面の **query だけ** を回想に変え、material を本筋のまま残した場合を考える。
   - 型付き Revision：query を変えた時点で、A1 の設定の変更として、その場面に anchor する型付き Revision は失効する（X1/1 の編集ごとの表の「S の A1 設定」の行）。Graph も query の一致を求めるので、その場面を弾く（`nir1_graph/scenes.rs:814-833`）。
   - IR：材料側は material 制約だけを見る（`scene_scope.rs:1957-1977`。exact の本筋は、本筋の query の `Resolved` に一致する）。そのため、**変えた後に**その場面から承認した IR は、本筋の query に出続ける。変える前に承認した Chronicle の IR が使えなくなるかは、材料の scope control の種類（`scene_scope.rs:1925-1953`）によるが、追いきれていない（§10.4）。
   - 防ぎ方：§7.3 の連動（query を変えたら material を追随させる）と、食い違ったまま保存するときの警告。
5. 将来の選択肢（B の外。別の draftRef が要る）：
   - 章（folder）ごとの既定。保存の追加になる。
   - 直前の兄弟の場面の Scope を受け継ぐ作成。継承の規則の追加になる。
   - どちらも、回想の章の中で新しい場面を作るときの誤りを減らす。

## 9. 評価と公開への影響

| 対象 | 影響 | 再測定 |
| ---- | ---- | ---- |
| CP-4（Gold） | Gold は全場面を `explicit` にした状態だけで測った（DR-CP4-J-2、`cp4-decisions.md:680`）。値は `timeline:main`／`worldline:prime`／`layer:manuscript`、holder と audience は reader、query と material は同じ（`setup-driver.mjs:390-412`）。B の既定はこれと同じ形なので、製品の既定が測った条件に近づく。β なら、凍結 setup は `project_create` に field を渡さない。初期状態は「registry に語彙あり・場面は `unknown`」になり、その後の明示の書込みで今と同じ状態に着く | β では不要と読む（推測）。α では harness が止まるので、harness の変更と再凍結が要る（§3.5.2）。B の code が CP-4 の候補の commit に入るかで、凍結の規則上の扱いが変わりうる（未確認。T7） |
| G-04（Scope exact／unknown） | fixture（`evals/nir1-graph/g04-scope-exact-unknown.v2.json`）は Scope を明示で書く。Gold と期待値は変わらない（推測） | 不要（推測） |
| PUB-G の開示 | 材料 §5 は「新しい project では、作者が scope を設定するまで IR と Graph が出ない」を開示に入れるとした。B の後の文案は下に置く。開示の文言はユーザーの確認の対象で、確定は PUB-G の確認のときに聞く（§10.3 の注記） | — |
| K2/4（本文の宣言） | 規則は変えない。既定を受け継いだ場面も宣言できる。registry の変更で宣言が失効する規則（l6-l9:251）はそのまま | 不要 |
| X1/1・X1/3 | 失効の規則と投影の定義は変えない。継承で作った binding は、作成時の新しい incarnation として扱われる | 不要 |
| DP-H（拒否の試験） | harness は `project_create` に field を渡さない（`harness/run.rs:211-221`）。β なら初期状態は語彙だけが違う。負例の `scene-scope-unknown`（`harness/workspace.rs:557-567`）は、製品の writer で `explicit` から `unknown` を書く経路で、B の後も成り立つ（`scene_scope.rs:1283-1289` が拒否するのは `legacy-absent` への戻しだけ）。`excludedNegatives` の「unknown Scope は登録簿にない参照を受けない」（`evals/nir1-packing/final-request.README.md:57`）も変わらない | β では不要（推測）。α では harness の registry の置換が止まる（§3.5.2） |
| L0 | setup は workspace の最初の project を使う（`setup-nir1-retrieval.mjs:240-290` 付近）。β では既定が入らず、語彙だけなら挙動は今と同じ。γ では場面が本筋になり、R+IR の観測が変わりうる | β では不要。γ を選ぶなら要否の判断が要る |
| Gate A2（公開版からの更新） | §3.5.1 の語彙が backfill で入るので、upgrade の fixture と試験が更新後の registry を照合していれば、期待値が変わる | 再測定ではなく、試験の期待値の更新。照合しているかは未確認（§10.4） |
| 製品の journey 試験（`electron/scripts/nir1-scene-scope-projection-product-journey.mjs` など）と e2e | 作成ダイアログを通る試験は、チェックの既定の影響を受ける（推測） | 実装時に grep して直す |

PUB-G の開示の文案（B の後）：

> 作成ダイアログで「本筋」を選んで作った project では、場面は本筋の Scope で作られ、本筋の場面どうしで IR と Graph が出る。回想・夢・別の世界線・作中作の場面は、作者が Scope を変える必要がある。変え忘れると本筋の参照に混ざる。取り消し・やり直し・ゴミ箱・スナップショットで戻した場面、外部フォルダから同期した場面、取り込んだ場面（取り込みの画面で「既定を当てる」を選んだときを除く）、新しい workspace の最初の project と既存の project、B より前に作った場面は未設定のままで、設定するまで出ない。

## 10. 段取り、試験、確認点、確かめられなかったこと

### 10.1 PR の分け方（ユーザーの確認の後）

| PR | 中身 | 依存 |
| ---- | ---- | ---- |
| B-0（docs） | draftRef の本文（§2 を契約の文面にする）、独立レビュー、確認の記録、台帳の行の追加 | ユーザーの確認 |
| B-1（Rust） | SCHEMA 44 の表。既定の reader と writer（OCC、冪等、型の検証、registry の所属の検証）。registry の writer の拒否。`ensure_scene_scope_binding_in_tx` の作成の種類の引数。継承の判定の関数（origin、lineage、route、外部 source）と 3 writer での使用。語彙の初期投入。既定の変更の canonical の event（T9）。grep の試験と実行時の試験。protected-writers と generic SQL の拒否一覧 | B-0 |
| B-2（N-API・IPC） | 既定の read／write の command（`ipcContract.ts` に正本と main での再検証、`profileEgress.ts` の分類、`src/lib/` の wrapper）。`project_create` の optional field（β）。作成の command は変えない | B-1 |
| B-3（renderer） | 設定画面、作成ダイアログ、取り込みの画面のチェック（ON なら取り込みの完了後に既存の writer のループ）。Scope 欄の i18n、バッジ、query と material の連動。「既定を当てる」（場面・章・project のループ）。関連場面の案内 | B-2 |
| B-4（docs） | PUB-G の開示文の改訂、decisions の記録 | B-3 |

AGENTS の skill の対応：B-1〜B-3 は `refactor-cross-boundaries`（Rust・N-API・IPC・renderer の 2 層以上）を主にし、新しい command には `add-electron-command` を補助に使う。

### 10.2 試験の方針

**Rust（Native）**

- 既定のある project で、3 つの writer の forward の作成（origin `human`／`ai-apply`、lineage なし、外部 source なし、AI 計画は `redo=false`）が `explicit` を書く。
- 次の場合は `unknown`：既定が無い、dangling、別 project、origin `import`、`source_uri` か `source_mtime` を持つ作成、origin `restore`。
- 継承しない経路（ゴミ箱、snapshot、本文保存の修復、サンプル、seed）では、既定があっても `unknown`（`legacy-absent`）。
- 既定の書込みの前後で、全 binding の bytes、registry の行、project の Scope authority の token が同じ。
- registry から既定の ref を消す更新は拒否される。
- 既定の OCC の不一致と冪等の再送。`state = 'none'` への変更と、その後の再設定で token が戻らないこと。
- cold reopen の後も同じ。
- SCHEMA 43 から 44 への migration で、既存の project に既定の行が無いこと。公開版（schema 2）からの更新で、registry に語彙が入り、場面は `legacy-absent` のままであること。

**実行時の受入れ試験（P1。MANIFEST や grep では固定できない分岐）**

- R1：既定のある project で回想に設定した場面を削除し、undo（origin `undo`、lineage あり）で同じ ID に作り直すと、`unknown` になる。章（folder）ごと削除して undo した場合も、配下の全場面が `unknown`。
- R2：作成の redo（origin `redo`）、AI の木構造計画の redo（`redo=true`）、付箋の昇格の undo／redo、route が `history-replay` の作成は、既定があっても `unknown`。
- R3：取り込み（origin `import`）と外部 mount の同期（`sourceUri`／`sourceMtime` あり、origin `human`）は、Native の判定だけで `unknown` になる（renderer の協力に頼らない）。取り込みのチェックが ON のときは、取り込みの完了後のループで `explicit` になり、OFF のときは `unknown` のまま、を renderer の試験で固定する。
- R4：ゴミ箱の renderer の restorer（`trash-bin/restorers/scene.ts`）を配線した場合は、origin `restore` で呼び、`unknown` になる。origin `restore` でない呼出しを配線の PR の試験で落とす。今は未配線なので、配線する PR の受入れ条件にする（Native 側の origin `restore` の試験は今のうちに置く）。

**静的な試験**

- §4.2 の grep の試験（継承の定数の出現箇所と、判定の関数の分岐）。

**開示**

- 既定のある project で、本筋の場面どうしの IR と Graph の正例。
- query だけを回想に変えた場面（material は本筋のまま）と、両方を変えた場面で、材料に使えるかどうか。
- 読書順と秘密の既存の負例が変わらないこと。

**renderer**

- 作成ダイアログ・取り込みの画面の field の有無、設定画面の警告、ループの部分適用の表示、案内の分岐、query と material の連動。
- レイアウトに触れる場合は、CLAUDE.md のとおり `pnpm test:browser`。

**評価**

- β で、CP-4 の凍結 setup と DP-H の harness が、新しい初期状態（registry は語彙あり・場面は `unknown`）から最後まで通ることを、実装後に確かめる。Gate A2 の試験の期待値も確かめる。

### 10.3 確認点

#### ユーザーに聞く点（重要なもの。AskUserQuestion で 4 問以内）

| # | 問い | 選択肢（推奨を先頭） | 推奨の理由 |
| ---- | ---- | ---- | ---- |
| U1 | 新しい場面のうち、どれに project の既定（本筋）を受け継がせますか？ | (推奨) 作者や AI が新しく作った場面だけ：ツリー・マトリクスからの作成、構成テンプレートの一括作成、スマホの空のプロジェクトでの自動作成、AI の木構造計画、付箋の昇格。取り消し・やり直し・ゴミ箱・スナップショットで戻した場面、外部フォルダから同期した場面、取り込んだ場面、サンプルは未設定のまま／戻した場面や同期・取り込みの場面にも既定を当てる（作成の全経路）／もう少し説明がほしい | 戻した場面に当てると、回想に設定していた場面が Ctrl+Z やゴミ箱で本筋に化け、作者は「元に戻した」と思って気づかない。同期と取り込みは、作者が場面を 1 つずつ作っていない。記録の素直な読み（全経路）から絞るので、明示で確かめる |
| U2 | 「本筋で作る」の既定を、画面でどうしますか？ | (推奨) 新しいプロジェクトの作成画面は「新しい場面を本筋で作る」をオン、取り込みの画面は「取り込みのあと既定を当てる」をオフ／両方オフ／両方オン | オンでは、作者が場面ごとには触っていない場面にも「設定済み」が記録される（「明示」の意味の変更）。それでも作成画面は作者が見てから作るので、B の目的（何もしなくても本筋どうしで出る）を優先する。取り込みは原稿の中身を見ていないのでオフ。**注記**：新しい workspace に最初からある project と、汎用の取り込みで作る project は作成画面を通らないので、既定なしで始まる。最初の project では設定画面で 1 回押す必要がある（語彙は入っているので、押しても何も失効しない） |
| U3 | 既にあるデータはどうしますか？ | (推奨) 既存のプロジェクトと、既存の未設定の場面は自動で変えない。作者が設定画面と「既定を当てる」で当てる。公開版から更新する利用者の既存のプロジェクトには、本筋の語彙（Scope の選択肢）だけが入る。挙動は変わらない／語彙も入れない／既存のプロジェクトにも既定を入れる | 既定を黙って入れると、既存のプロジェクトで新しい場面が気づかれずに本筋になる。語彙だけなら挙動は変わらず、後で作者が既定を選んでも何も失効しない。ただし既存の利用者の DB に migration で入るデータが変わるので確かめる |
| U4 | 契約の確認：`nir1-scene-scope-default-proposal/1#scope-storage-authority` | 推奨のまま確認する／一部を変えてから確認／確認せず保留 | 新しい保存先（既定の表と、既定の変更の記録。T9）と契約の改訂は、AGENTS の委任の外。**U1〜U3 の回答を反映した draft を確定し、その SHA-256 を問いの文に書いて、別の問いとして聞く**（l6-l9:294 の Confirmation protocol は、1 問で 1 つの `draftRef#contractId` と SHA-256 を示すことを求める） |

U への注記：

- U4 の判断材料（B-lite との比較）：材料 §6 の B-lite は「作成の直後に renderer が既存の writer で既定を書く」案で、契約の文「新規は unknown」を動かさない。採らない理由は 3 つ。作成と Scope の書込みが別の transaction で原子性が無い（作成と書込みの間に IR の要求や crash が入りうる）。renderer の作成の経路にしか効かず、Native の経路（AI の木構造計画、付箋の昇格）に別の手当てが要る。既定の保存先は B-lite でも同じく要るので、確認が要ることは変わらない。
- PUB-G の開示：文案は §9 に書いた。開示の文言はユーザーの確認の対象なので、ここでは決めず、PUB-G の確認のときに聞く。

#### integrator の技術判断で決める点（決定を decisions 文書に記録する）

| # | 点 | 判断（推奨） | 理由 |
| ---- | ---- | ---- | ---- |
| T1 | 保存先 | 新しい表（§3.1 の (c)）。`state` の列で「なし」を表す | registry の token と分け、`deny_unknown_fields` と合わせる |
| T2 | material の既定 | query と同じ exact。Scope 欄で query を変えたら material を追随させる | any のままだと誤った場面の材料が全 query に見える。CP-4 の測定条件と同じ |
| T3 | 既定の初期設定の方式 | β（作成 UI だけ）。α は採らない。γ は L0 を確かめるまで採らない | 凍結 harness と L0 を変えない。帰結は U2 の注記で伝える |
| T4 | holder と audience | reader に固定（v1） | 人物の既定は削除の拒否を広げる必要がある |
| T5 | 継承の判定の実装 | 判定の関数を 1 つにまとめ（origin、lineage、route、外部 source）、作成の種類の閉じた引数、grep の試験、実行時の試験 R1〜R4 で固定する。renderer の field は足さない | 将来の経路が黙って継承しないようにする。renderer の協力に頼らない |
| T6 | registry との整合 | 使用中の ref の削除は拒否。dangling は `unknown` | 既定が黙って外れたり、any に落ちたりしないようにする |
| T7 | CP-4 の取り直しと B の merge の順 | CP-4 の取り直しの候補には B を含めない | 測る候補を動かさない。β なら setup は同じだが、凍結の規則の扱いを確かめていない |
| T9 | 既定の変更の記録と feed | narrative の feed は書かない。canonical の change event で変更の履歴を残す方向（記録の範囲は draft に書き、U4 で確認する） | feed は Index を dirty にする（C17）。履歴が無いと「いつから本筋で作られたか」を追えない |
| T10 | サンプル | v1 では継承させない（U1 の推奨に含まれる） | 中身を確かめていない |

（T8〔PUB-G の開示文〕は、改訂 2 で U の注記に移した。）

### 10.4 確かめられなかったこと

- CP-4 と DP-H の受領書が、置換前の registry の中身を記録・照合するか（語彙の初期投入の影響）。`frozen-setup-driver.mjs:518-546` は version を読む。中身の照合は、:1975-1977 の置換後のものだけを見た。全文は読んでいない。
- Gate A2 の upgrade の fixture と試験が、更新後の registry の中身を照合しているか。
- L0 の workspace の作り方（新しい workspace か、fixture の DB の複製か）と、L0 が IR を使うか。γ の影響の判断に要る。
- snapshot の本文 restore で、全ての場面の binding が作り直されるのか、置換された場面だけか。試験 `project_snapshots.rs:3707-3765` は 1 場面だけを見る。`ensure` は binding があれば何もしないので、B の判断には効かない。
- IR の材料が、外部の AI への要求（Packing）にどこまで入るか。B は既存の規則の下で材料になる場面を増やすので、送信の量が増えうる。
- A1 の設定を変えたとき、変える前に承認した Chronicle の IR が使えなくなるか（材料の scope control の種類による。§8.4 の 4）。
- サンプル（`src-tauri/resources/sample_project/`）の場面に、回想・作中作があるか。
- 削除の undo が journal の証明で旧 incarnation を継ぐ経路が、今の製品に無いこと（§2.2 の 3 の推測）。
- `promote_sticky` と `apply_ai_tree_plan` の undo の writer（レビューも確かめられなかった）。redo は lineage と flag で判定できることを確かめた。undo が場面を作り直す経路を持つかは追っていない。
- `api.createProject`（harness）と `createNewProject`（UI）の差を実機で確かめていない。β の field が harness に渡らないことは code の読みだけ。
- 既定の writer が canonical の change event を出すべきか（監査、timelapse、同期）。
- 材料 §6 の未確認点（Raw が Scope で絞られるか、legacy-absent の query の開示の細部、既存 project の件数、registry が空のまま保存したときの画面）は、この設計でも確かめていない。
- backup の restore（`backup_restore.rs`）が、復元する表の allowlist を持つか（持つなら、新しい表を足す必要がある）。
- 取り込みの完了後のループ（§3.5.2）で当てるとき、取り込みの途中の失敗や取消で、どの場面までが取り込まれたかを renderer が正しく列挙できるか。
- 行番号は `f36dd696` の版のもの。改訂 2 で足した行は `a8c5fa65` で確かめた（2 つの版で、引いた file は同じ）。
