# NIR-1 C-body 契約提案 proposal/5（draft）: 本文の宣言の廃止と、Graph の追加の場面の開示

Status: 確認済み（2026-11-20、確認の記録 contracts `11dc9eda`）。確認後はこの bytes の SHA-256 を台帳に記録し、本文は編集しない。内容を変えるときは新しい draftRef にする。K2/4 の 2 行を置き換える（台帳に注記を足す。K2/4 の本文は書き換えない）

調べた範囲：read-only。基点は worktree `pubg5-dr20`（草案作成時 HEAD `5ba4c6f1`、origin/master `7835427b` の子孫）。行番号は `5ba4c6f1` のもの。仕上げで worktree は `04202c37` に進んでいたが、`project_reads.rs:153-159`、`scenes.rs:787-845`、`ja.json:4155`、`sceneScopeDefaultTranslations.ts:30-36`、`observation-prep.mjs` の `SOURCE_PINS` は読み直して一致した。K2/4 の file は `efc30cca…`（確認済みの sha と一致、`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md`）。実行、build、起動はしていない。確かめていないものは【推測】、fixture と file を機械的に読んだだけのものは【読みのみ】と書く。

## 0. 位置づけ

| 項目 | 値 |
| --- | --- |
| draftRef | `nir1-c-body-disclosure-proposal/5`。`nir1-c-body-disclosure-proposal/4`（K2/4、確認 2026-10-17 Session B2）の 2 行を置き換える |
| contractId | `graph-target-scene-body-disclosure`（改訂）、`scope-storage-authority`（K2/4 の Scene Scope v2 の差分の改訂）。確認は contractId ごとに 1 段落（§8。確認 1 の同じ回答が両方に及ぶ） |
| 根拠 | ユーザーの決定 2026-11-19 深夜（contracts `5e02e4f2`、`user-confirmation-2026-11-19-ai-disclosure-and-pubg-scope.md` の回答 2）と、2026-11-20 未明の 2 つの追記（草案の確定に要る 4 点、A1 の回答）。Fable の設計相談 §4.3、§4.6（`secret-ai-masking-consult-2026-11-19/fable-consult.md`）、A1 の相談（`pubg-pivot-2026-11-19/fable-a1-consult.md`）。棚卸し `secret-reveal-protection-inventory-2026-11-19/report.md`。整合の点検 `consistency-check-v2.md`（草案の作業材料は contracts の外の `/home/grimodex/fusion-eval-data/design-notes/pubg-pivot-2026-11-19/`。この file が正本）。確認の記録は contracts `11dc9eda` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-20-pubg-pivot-confirmations.md` の確認 1（`claude/nir1-contracts` の commit。この枝は master に merge しないので hash で引く）。決定記録の contracts `5e02e4f2` も同じ |
| 委任の外であること | 確認済みの契約（K2/4）の改訂、製品の認可（作者の宣言）の削除、保存の契約の改訂。ユーザーの確認が要り、2026-11-20 に確認された（§8） |
| この draftが確認しないもの | PUB-G の公開、restricted の要否の変更（`electron/native/grimodex-node/src/nir1_graph_product.rs:1302-1304` の `ProfileNotRestricted`。別の draftRef `nir1-d2a-graph-unrestricted-proposal/1`。2026-11-20 に確認済みで、この draft は触れない）、AI への送信（excerpt は今までどおり AI の request・Packing・履歴・export・audit に載せない）、R／IR／path の開示の変更、関連シーンの未来の場面（J10、PUB-G の後の別枠）、最後の凍結の開始 |

### 0.1 ユーザーの回答（記録）

次の 4 点と A1 は、2026-11-20 未明にユーザーが回答済みである（決定記録の 2 つの追記）。この draft はその回答を本文に反映する。再び選んでいただく点ではない。

- 本文の宣言を廃止する。veto（secret な foreshadow、secret な Chronicle event、Scene と beat の POV による拒否）も廃止する。決めてから凍結する。
- **A1（Scene Scope の一致）は残す。公開の後に見直す。** Fable の相談の後の回答。
- #968（OS ダイアログの廃止）は閉じた（2026-11-20、merge せずに閉じた）。DR-CB2-17 の分析はこの draftに引き継ぐ（§6）。
- コードの撤去は PUB-G の後。凍結の前は reader の判定（宣言の読込、束縛の照合、veto、quarantine）だけを外す。2 列は残して使わない。migration はしない。

## 1. 要点と、回答済みの選択

廃止するものは、ユーザーの決定どおりに次の 2 つである。

- 作者の本文全体の宣言。Graph-only の本文を開示する唯一の authority という K2/4 の位置づけ。
- veto（secret な foreshadow、secret な Chronicle event、Scene と beat の POV による拒否）。

Graph の追加の場面（Graph-only target）は、宣言と veto の判定をしない。位置の正しさ（A1 と読む順）と結果の整合性は守る。「R と同じ」ではない点が 1 つあり、§1.1 に最初に書く。

### 1.1 決定 2（「R と同じ扱い」）との差：A1 を残す（K2R-1、回答済み）

決定 2 の文言は「veto も外し、Graph の追加の場面を R と同じ扱いにする」である。この draftは 1 点だけ R と違う。**Graph の追加の場面には、A1（今の場面と同じ区分かの一致）を残す。R は A1 を見ない**（`src/features/related-scenes/selectRelatedScenes.ts:136-140`。R は読む順で前かだけを見る）。

残す理由（Fable の説明）：

- A1 は秘密の仕組みではない。場面の区分（時間軸、世界線、語りの層、知っている人、読み手）が今の場面と同じかを確かめる、関連の質のための選別である。秘密と未来は別の仕組みが守る（`scope-default-material-2026-11-04.md:47-52`、`FED/scope-b/design-rev2.md:454`）。veto（印があれば無条件で出さない）とは種類が違う。
- Graph の中で、path は Scope の照合を通ったのに、行き先の場面は通っていない状態を避ける（`nir1_entity_relation.rs:3023-3034`、`:3276-3317`）。pin は区分の情報を持たず、worker は pin を並べるだけなので、pin で届いた場面の区分を確かめるのは target の A1 だけである（`nir1_graph.rs:316-323`、`:2420-2588`）。
- 追加枠は 1 つで、候補は関連の強さの順ではなく、到達した人物の順と場面の ID の順に見て最初に通った 1 件を採る（`nir1_graph.rs:2360-2364`、`:2504-2517`、`judge.rs:143-159`）。A1 を外すと、区分の合わない場面が合う場面の代わりに枠を取りうる。
- 確認済みの「設定の無いものは閉じる」という防御に、Graph-only target の例外を足さずに済む（台帳 `nir1-l6-l9-execution-plan.md:463-465`、SDEF/1:63-67）。
- (b) で新しく出る挙動は、G-01〜G-08 のどの case にも候補がなく、凍結の評価が一度も見ない（§4.1）。
- 公開の後に緩めるのは出る場面が増えるだけで済み、締めるより易しい。

秘密の扱いと G-01〜G-08 の結果は、残しても外しても変わらない【fixture の読みのみ】。位置づけは「正しい答え」ではなく「保守的な既定」で、**公開の後に見直す**。見直しの選択肢は、外す、または以前からの場面（legacy）だけ通す（`scope-storage-authority` の proposal/3 の「legacy 移行の限定互換」と同じ向き）。IR と path の Scope の扱い、J11（PUB-G の後の、IR と Graph の作者視点）とまとめて見る。

A1 に含まれる 4 つの成分（`nir1_graph/scenes.rs:787-847`）：

| 成分 | 行 | 意味 |
| --- | --- | --- |
| 設定済みであること | `:791-794` | marker が explicit。未設定（unknown）と、以前からの場面（legacy-absent）は出さない |
| 位置の一致 | `:816-824` | 時間軸、世界線、語りの層が今の場面と同じ値 |
| 材料として見せる範囲 | `:825-833` | material の制約が「制約なし」か、今の場面と同じ値 |
| 知っている人、読み手 | `:834-841` | 今の場面と同じ |

同じ関数の残り（project と Scene の ID、incarnation、Scope の token：`:795-815`）は frame の整合で、読む順（`:842-845`）と合わせて、A1 の残す・外すと無関係に残る。

**作者に見える結果**（PUB-G の案内にも書く。§7）：

- 作者が Scope 欄で別の時間軸、世界線、語りの層にした場面は、追加枠に出ない。
- 「知っている人」「読み手」を人物に変えた場面は、今の場面が同じ設定でない限り、引き続き出ない。**これは視点人物（POV）の記録による拒否（廃止する veto）とは別の判定である。** 視点の veto が見るのは場面詳細の「視点」欄と beat の視点の記録で、A1 が見るのは Scope 欄の別の項目（`SceneScopePrincipals.tsx:28-45`、`ja.json:4140-4142`）。
- 設定の無い場面（取り込み、復元、取り消しで戻した場面、以前からの場面）は、追加枠に出ない。
- R は別の世界線の場面を今も出す（R は A1 を見ない）。A1 が守るのは Graph の追加の 1 枠だけである。
- 副作用【コードの読み。実測なし】：frame に載るのは先頭 8 件で、8 件が全部 A1 で落ちると、9 件目より後に合う場面があっても追加は 0 件になる。

### 1.2 回答済みの選択（K2R-1〜K2R-4）

| 呼び名 | 点 | 回答（2026-11-20 未明） | 本文での扱い |
| --- | --- | --- | --- |
| K2R-1 | target の A1 | **残す。公開の後に見直す** | §1.1、§2.1、§3 |
| K2R-2 | コードの撤去の時期 | **PUB-G の後。凍結の前は reader の判定だけ外す** | §5 |
| K2R-3 | Scene Scope v2 の 2 列 | **残して使わない。migration なし** | §2.3 |
| K2R-4 | #968 | **閉じた（merge せず、2026-11-20）。DR-CB2-17 の分析を引き継ぐ** | §6 |

この 4 点以外（診断 run の作り替え、PR の分け方、harness の改版の細部）は、NIR-1 の委任の範囲で integrator が決める。ただし閾値は変えない。

「R と同じ」は判定の種類が同じという意味で、順序の取り方まで同じではない。R の「読む順で前」は renderer が `sceneOrder` で決める。story／auto のモードでは story 順になりうる（`selectRelatedScenes.ts:136-140`、`fetchNir1RelatedScenes.ts:194`、`codex/context/sceneTimeIndex.ts:344-361`）。Graph-only の順序は Native が authority の `reading_rank` から取る（`judge.rs:306`）。この食い違いは今回直さない。

## 2. 置き換えるもの（K2/4 のどこを廃止し、どこを残すか）

### 2.1 `graph-target-scene-body-disclosure`

K2/4 の Delta（`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md:173`）は、次の 2 つを要点にしている。

1. 作者の宣言を、Graph-only の本文を開示する唯一の authority にする。
2. 返却時と click 時に、新しい read で再検証する。

/5 は 1 を廃止する。2 は残し、宣言なしの形に直す。

/5 の Delta の案は次のとおり。「Graph-only target の title、本文の先頭の非空行の excerpt、その anchor への遷移を、作者の操作なしで Related Scenes の共通追加 1 枠に出す。出す条件は、live で archive されていない Scene であること、読む順で query より前であること、A1 の判定（設定済みであること、位置・材料の範囲・知っている人・読み手が今の場面と一致すること）に通ること、結果の整合性の判定に通ることだけにする。」

#### 判定ごとの扱い（`src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/scene_disclosure/judge.rs`）

| 判定（行） | /5 での扱い |
| --- | --- |
| 識別子の形（`:256`） | 残す。整合性 |
| live で archive されていない Scene（`:262-273`） | 残す。整合性 |
| A1 の読取と authority の revision（`:280-304`） | 残す。位置の正しさ |
| reading が前（`:306`、`scenes.rs:842-845`） | 残す。位置の正しさ |
| A1 の 4 成分（`validate_scene_scope` の `:791-794`、`:816-841`。§1.1 の表） | **残す（K2R-1）。公開の後に見直す。** 「知っている人」「読み手」の一致を含む |
| frame の整合（`validate_scene_scope` の `:795-815`。project と Scene の ID、incarnation、scope token） | 残す。整合性。A1 の成分とは別の行として扱う |
| 宣言の読取（`:327-335`） | 廃止 |
| 束縛の照合（`:387`。宣言の digest、workspace ID、canonical locator） | 廃止 |
| veto の記録（`:395-405`）と、本文の beat POV の veto（`body.rs:190-198`） | 廃止 |
| quarantine（`:411`、`scene_disclosure.rs:124`、`related_scenes_requalification.rs:371` の `drop_graph_only_if_quarantined`、`graph_response.rs:354`、`graph_response.rs:570`） | 廃止。COMMIT の結果が不明になるのは宣言の書込みだけで、宣言の writer がなくなれば原因が消える |
| frame の token の一致（`:416`、`body.rs:182`） | 残す。本文の保存後、Index が追いつくまで出さない仕組みは、宣言の失効の代わりにこれが担う |
| pin の再確認（`:446`）、path の再検証（`:457`） | 残す。整合性 |
| 本文の読取の上限（K1b。`body.rs:124`） | 残す。veto の行の上限（`judge.rs` の `SCENE_BODY_VETO_MAX_ROWS`）は使われなくなる。上限の削除は緩和ではなく、使う機能の削除 |
| 追加枠の条件（Raw が 8 件未満、かつ IR が共通枠を使っていない。`scene_disclosure.rs:57-72`） | 残す。G-03、G-05、G-06 で結果が変わらないのは、この条件による（§4.1） |
| 宣言の digest で本文を束縛（`body.rs:152-175`） | 廃止。本文は、frame の token と、返却時に読んだ digest、range（`BodyFacts`）で束縛する |
| click の再検証（`click.rs:86-87`） | `declaration_id` と `declaration_token` の比較を外す。`BodyFacts` の比較（`click.rs:98` 付近の `body.facts != binding.body`）と title digest の比較は残す。click の handle は宣言なしでも、返却と click の間の変更を検出できる |
| `GraphOnlySceneBinding` の `declaration_id`、`declaration_token`（`eligible.rs:46-47`） | 廃止。Native の内部の値で、renderer には出ない |

そのほかに残すもの。

- all-or-nothing（R+IR の path の付加の不一致は Graph の寄与を全体で 0 にする。Graph-only の失敗は追加 1 枠を出さないだけ）。
- 閉じた集合の 1 つの理由 code（画面には理由が出ない。K2/4:225）。
- Mandatory defense 2、つまり excerpt を AI の request、Packing、履歴、export、audit、event、診断、log、cache に載せないこと。**これを外すと新しい送信先になるので、/5 でも残す。**
- 診断に載せるのは、target を識別しない件数だけ。

#### path 側の開示は変えない

path の根拠（Entity 名、relationType、Evidence の quote）の規則は、この draftの範囲外で、変えない。具体的には次のものである。

- secret な foreshadow の link と payoff の位置による Revision の拒否（`nir1_entity_relation.rs:3505-3555`）。
- Entity の POV による拒否（`:3641-3654`）。
- Entity の story／auto／phase の未来の拒否（`:3608-3627`）。
- hidden と suppress の Codex Entry の除外（`:1305`、`:3646`、`:4030`、`:4097`、`:4239`、`:4514`）。

G-07 の N3、N4（`g07-fs-hask`、`g07-fs-nim`。reveal の前の secret）はこの path 側に依存する。**「veto を外す」を path の規則まで外すと読まないこと。**外すと G-07 の Gold が動き、凍結のやり直しになる（`fable-consult.md` §4.6 の「IR の admission・Graph の path の開示を緩める」の行）。path 側を緩める判断は PUB-G の後で、別の契約。

### 2.2 `scope-storage-authority`（Scene Scope v2）

K2/4 の差分（`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md:432` 以降）は、`narrative_scene_scope_bindings` に宣言の nullable な 2 列を足し、その writer（宣言、取消、restore のクリア）、feed の kind、失効の規則を置いた。/5 はこの差分を次のように改訂する。

- 2 列は **物理的には残し、意味を持たせない**。どの reader も読まない。既存の DB に非 NULL の値があっても無視する（unreleased の dev DB だけの可能性が高い。公開済みの schema は 2、`src-tauri/crates/grimodex-core/src/lib.rs:8`。gate は PUB-G まで閉じているので、利用者の DB に宣言はない【推測】）。
- 新しい宣言の writer と、その feed の書込みは置かない（撤去は PR-2。それまでは gate で閉じたまま inert）。
- restore のクリア（`backup_restore.rs:597`、`project_snapshots.rs:3009`、`revision_restore.rs:273`）は、列が残る間は無害なので、PR-2 まで触らない。
- feed の kind `scene_body_declaration` と object key の変換（`change_feed.rs:1445`、`:2922`、`:3248`）は、過去の event が読めなくなることを避けるため、残す。
- 保存の範囲は広がらない。縮小でもない（列は残る）。
- Scene Scope の binding、registry、project の既定は変えない（A1 を残すので、IR と path と target が使い続ける）。「unknown／unresolved は fail closed」「unknown から any への fallback の禁止」は、Graph-only target にも引き続き及ぶ。

### 2.3 列と migration（K2R-3、回答済み：残して使わない、migration なし）

- 列は SCHEMA 43 で入り、現在は SCHEMA 46（`grimodex-core/src/lib.rs:3`）。checkpoint が 2 列の存在を要求している（`grimodex-core/src/workspace_schema.rs:840`、`:1266-1280`）。
- 列を消すには、migration（`grimodex-db/src/migrate.rs:10341` の repair は列を足す側）、schema の版上げ、Drizzle の契約（`src/db/schema.ts:2497`、`src/db/generated/schema-contract.json`）、backup の過去の版の復元（`backup_restore.rs:3197`）の整合が要る。
- 残して NULL のままにするコストは、物理的に空の 2 列だけ。
- 公開の後に DROP するかは別の lane（PR-3、任意）で決める。この draft は migration を要求しない。

### 2.4 そのほかの要素の扱い

| 要素 | 場所 | /5 の扱い |
| --- | --- | --- |
| writer、取消（revoke）、state の入口 | `electron/native/grimodex-node/src/body_declaration_entry.rs:143,202,314,425`、`lib.rs:13774-13810`、IPC `electron/shared/ipcContract.ts:921-935,7596,10154-10202`、`electron/main/profileEgress.ts:498-500` | PR-2 で撤去。それまで Native の gate（`PrePublicationEntry::SceneBodyDeclaration`、`main_grant.rs:169`）で閉じたまま。**PUB-G の承認はこの gate を開けない**と /5 に書く |
| `MainGrantKind::BodyDeclaration` | `main_grant.rs:53-77` | PR-2 で撤去。`ProfileActivation` と共有する基盤（`MainGrantInFlight`、TTL）は残す。`PrePublicationEntry` の添字（`:189-210`）の振り直しに注意 |
| UI（宣言のセクション） | `src/features/editor/sceneMeta/bodyDeclaration/`（5,433 行）、`SceneScopeEditor.tsx:574`、定数 `bodyDeclarationAvailability.ts:13`（`false`） | PR-2 で撤去。それまで閉じたまま。`nir1GraphAvailability.ts:8` の「`BODY_DECLARATION_UI_ENABLED` と同じ承認で開ける」という注記は、PR-1 で直す（PUB-G で開けるのは Graph の UI だけになる） |
| 既定を当てる確認文 | `src/features/scene-scope-default/sceneScopeDefaultTranslations.ts:33-34`（「承認済みの解釈と本文の宣言は失効します」） | 「本文の宣言」は廃止で意味がなくなる。公開前に文言から外す（PR-1 か PR-2。公開に出る文言なので PR-2 では遅い。**PR-1 で直す**）。承認済みの解釈の失効（SDEF/1:58）は残る |
| Main の CI seam | `electron/main/bodyDeclarationCiSeam.ts`、`electron/main/index.ts:808-834` | harness の宣言の段を外した後（S4 の枝。§5）、PR-2 で撤去 |
| 確認ダイアログ | `electron/main/mainGrant.ts`（宣言の経路。`:39`、`:46`） | #968 は閉じた（§6）。PR-2 で宣言の経路ごと撤去 |
| `display.rs`（確認の文面の生成） | `src-tauri/crates/grimodex-db/src/narrative_extraction/scene_body_declaration/display.rs` | PR-2 で撤去。ただし `scene_body_title_digest` は judge と click が使う（`judge.rs:27`、`click.rs:21`）ので、残す側（title の digest を計算する小さな関数）へ移す（PR-1） |
| veto の実装、facts、state、binding、limits、commit_outcome | `scene_body_declaration/veto.rs` ほか。db crate 全体で約 11,063 行（試験を含む） | PR-2 で撤去 |
| renderer の保護（Drizzle から列を書けない） | `src-tauri/crates/grimodex-db/src/execute.rs:3468` 付近 | 残す。列が残る間は防御として有効で、害がない |
| 評価用の `variant.declaration` の印 | `scripts/quality/nir1-graph-eval/constants.mjs:261-358` | S4 の枝（§5） |

## 3. 脅威モデルの改訂（確認を求める）

K2/4 の Trusted／Untrusted／In-scope／Out-of-scope／Mandatory defenses のうち、変わるものだけを示す。

### 3.1 「画面は全部開示」との関係（確認で過大に読まれないための節）

ユーザーの決定「画面はもちろん全て開示して問題ない認識です」は、この draftでは **Graph の追加の 1 枠の判定（宣言と veto）の廃止**に適用する。画面の判定のすべてを外すという意味には適用しない。/5 の後も、画面には次の判定が残る。

| 残る判定 | 理由 | いつ変えるか |
| --- | --- | --- |
| 位置の正しさ（読む順で前、A1 の 4 成分）。マスクではなく正確さ（J1 の「『これまで』の前後や Phase の位置の正しさは守る」と同じ側） | 別の世界線の場面などを「これまで」に混ぜないため | A1 は公開の後に見直す（§1.1） |
| **path 側の secret／POV／hidden／phase の規則**（§2.1 の「path 側の開示は変えない」） | G-07 の Gold（N3、N4。`reading-future`、`secret-not-revealed`）がこの規則に依存する。**PUB-G の前に変えると G-07 の Gold が動き、最後の凍結のやり直しになる**（`fable-consult.md` §4.6） | PUB-G の後。別の契約（IR の admission とあわせて） |
| IR の admission | この draftの範囲外（変えない） | PUB-G の後 |

結果として、/5 の後も、画面全体が「全部開示」になるわけではない。R は判定なしで出し、Graph の追加の 1 枠は宣言と veto の判定をやめ、Graph の path の根拠と IR は今までの判定を残す。確認文（§8）は、この限定を明記する。さもないと、ユーザーが path と IR の判定まで外す内容に同意したと読まれる。

### 3.2 Trusted actors

- 「Main のダイアログを確定した操作者を作者とみなす」という新しい信頼仮定は、不要になる。Native の reader と writer のうち、writer は撤去されるので、Native の reader だけが残る。
- 評価用の CI seam を、承認する者として扱う項も、PR-2 で不要になる。

### 3.3 新しい信頼仮定（1 つ）

- 作者のプロジェクト内の場面を、作者自身の画面に出すことは、作者の同意を要しない。根拠はユーザーの決定「画面は全部開示して問題ない」と、R が同じ範囲を既に判定なしで出していること（`related-scenes-secret-exposure-2026-11-19/report.md`、`selectRelatedScenes.ts`、`grimodex-semantic/src/search.rs:186-195`）。renderer は Scene の本文をもともと読める（`src/features/tree/api.ts:1000-1009`）。

### 3.4 In-scope attacks から外れるもの

- 宣言の偽造、確認の偽造と再送、ダイアログの title の偽装、評価用 seam の悪用、宣言の持ち越し（restore、複製、ID の再利用）、壊れた宣言の利用、取消の悪用、COMMIT の結果が不明なときの誤判定。いずれも対象の機構がなくなる。
- 宣言が失効した後の開示。frame の token の不一致で、同じ結果になる。

### 3.5 In-scope attacks に足す・残すもの

- AI や MCP が書いた pin、Relation、Entity で、追加枠に出る場面を選ばせること。害は、作者自身の過去の場面の title と先頭行が、作者自身の画面に出ることだけで、R が出せる範囲を超えない。AI の request、Packing、履歴、export、audit への混入は、Mandatory defense 2 が防ぐ。
- 返却の後、click の前の本文の変更（TOCTOU）。`BodyFacts` の比較で防ぐ（残す）。
- **「unknown、legacy、unresolved を any として扱うこと」**（K2/4:196 の後半）。A1 を残すので、In-scope の攻撃として引き続き残す。「宣言で A1 を緩めること」は宣言と一緒に無くなる。

### 3.6 Out-of-scope に足すもの

- **秘密、phase の判定をしないこと、および視点人物（POV）の記録による拒否をしないこと**自体。ここで外す「視点の判定」は POV の記録による拒否（場面詳細の「視点」欄と beat の視点の記録）に限る。A1 の「知っている人」「読み手」の一致は残る（§1.1）ので、「視点の判定を全部しない」とは読まない。作者の秘密の扱いについては、ユーザーの決定（J1）が「画面は全部開示」である。この draftで変えるのは、画面の追加 1 枠の判定だけである。
- 伏線、年表の secret と、POV と、hidden の印を、画面の追加枠の理由に使わないこと。AI への送信での扱いは、別の契約（J1〜J7）。

### 3.7 変わらない防御

- Mandatory defense 2（excerpt を AI 送信・Packing・履歴・export に載せない）、3（parent の再検証と all-or-nothing）、5（返却時と click 時の再検証）、8（K1b の上限、allocation の前に検査）、9（閉じた 1 つの理由 code）。
- 「設定の無いものは閉じる」（unknown／legacy／unresolved は追加枠に出ない）。
- 「Graph の製品公開」はこの draftで許可しない。公開条件（A3 + B + C。D2a は確認 2 で外した）と Session C-1 の承認は別。restricted の条件の解除（`caller-profile-egress` の Graph の行の改訂）と、公開条件から D2a の前提を外すことは、確認 2（2026-11-20）で外した。それは別の draftRef `nir1-d2a-graph-unrestricted-proposal/1` で確認済みで、/5 は触れない。

## 4. CP-4 の評価への影響

### 4.1 G-01〜G-08 の追加の場面は入れ替わらない見込み（**fixture の読みと機械的な数え上げで、Graph も reader も実行して確かめていない**）

数えた対象は、各 variant の `expectations.arms.rPlusIr.sceneIds`、`graph.nodes`、`pins`、`scenes[].readingOrder`、`slotClass` である。「候補」とは、到達した Entity に pin されていて、R+IR に無く、読む順で query より前の場面のこと。これは、宣言を外すと新しく採用されうる場面を数えたものである。結果は次のとおり。

| variant | R+IR | 候補（宣言を外した場合） | 期待値の追加 | 変化 |
| --- | --- | --- | --- | --- |
| G-02 base | probe、attach | `g02-tamsin-first`（読む順 30）だけ | `g02-tamsin-first` | なし。`g02-rook-decoy`、`g02-dace-decoy` は pin 先の Entity（Rook、Dace）が graph の node でなく到達しない |
| G-04 base（fixture v2） | control | `g04-lio-landing`（20）だけ | `g04-lio-landing` | なし。`g04-lio-market` は pin がなく候補にならない |
| G-07 base | probe、attach | `g07-pell-dock`（40）だけ | `g07-pell-dock` | なし。`g07-rhea-reveal`、`g07-late`（secret の payoff の場面）には pin がない。`g07-attach`（Rhea に pin）は R+IR に入っている |
| G-08 base-usable | control、attach | `g08-cass-attic`（20）だけ | `g08-cass-attic` | なし |
| G-08 graph-recovered | 同上 | `g08-cass-attic` だけ | `g08-cass-attic` | なし |
| G-08 の 3 つの unusable | 同上 | Graph が unavailable で node なし | なし | なし |
| G-01 v1 | `g01-question` | `g01-mira` だけ（fixture の pin は `g01-mira` の 1 つ） | `g01-mira` | なし |
| G-03 base | 8 件（raw-full） | `g03-hollis-ward`（60） | なし | 候補はあるが追加枠が閉じている（Raw が 8 件）。追加枠の条件が効く |
| G-05 base | `g05-control`、`g05-xan-watch`（IR が共通枠を使用） | `g05-pia-ridge`（30） | なし | 同上（IR が枠を使用） |
| G-06 base | 8 件（raw-full） | `g06-bram-galley`（60） | なし | 同上（Raw が 8 件） |

- seed の pin（`evals/nir1-graph/seed-pin-addendum.v2.json` の `seedPins`）が足すのは、問いの Scene から seed の Entity への pin である。pin 元は query の Scene 自身で、reading の判定（`candidate_rank >= query_rank`、`judge.rs:306`）で必ず落ちるので、候補にならない。
- **A1 を残す（K2R-1）ので、A1 で落ちる場面の扱いは今までと同じで、結果は変わらない。** G-case に A1 で落ちる target の候補は 1 つもない（`g04-rv-alt`、`g04-rv-unresolved`、`g04-rv-unknown`、`g04-rv-holder` は pin がなく、G-04 の Scope の負例 N1〜N4 は path の材料の側で落ちる）。addendum は 5 つの追加の場面とも A1 が explicit で query と一致すると書く（`evals/nir1-graph/declaration-addendum.v2.json` の `declarationsNote`。G-04 の `g04-lio-landing` は Scope の既定で explicit）。G-01 は fixture に Scope の欄がなく、凍結の setup が全場面を同じ値の explicit にする（`frozen-setup-plan.mjs:622-644`）。【addendum と fixture の記述の読みのみ。Scene Scope の実際の値は確かめていない】
- 宣言と veto を外しても結果は変わらない。5 つの追加の場面は foreshadow、POV、Chronicle event を持たない（addendum の `vetoRecords: []`）。
- **注意（G-03、G-05、G-06）。** この 3 つは、宣言を外すと候補が現れる。追加枠の条件（`scene_disclosure.rs:57-72`）が閉じているから結果が変わらない。この条件を将来緩めると、G-03、G-05、G-06 の期待値が動く。/5 は追加枠の条件を変えない。
- A1 を残すことで、A1 の負例（別の世界線、未設定、知っている人の不一致）の CB-4 の試験は反転せず、そのまま残る。測るのは reader の挙動で、(b)（A1 を外す）を選ぶ場合に比べて凍結の改版が少ない。

### 4.2 改版が要るもの（最後の凍結に入れる改版の一覧）

1. **宣言の addendum 2 本の置き換え。**
   - 対象は `evals/nir1-graph/declaration-addendum.v2.json`（`status: frozen-after-independent-review`）と `evals/nir1-g01/setup-addendum.v3.json`。
   - 消すだけにはできない。宣言と無関係な次の内容を、宣言なしの新しい版（例：setup addendum v4）へ移す。
     - `bSealProcedure`（B の seal の手順）。
     - `rAndRirSetup`（R と R+IR の setup）。
     - Index の metadata の前後の照合は、宣言の段のためのものなので消す。
     - 期待する excerpt の範囲は、fixture（`addedScene.sceneExcerpt.canonicalUtf16Range`）にあるので、addendum の写しは消す（Fable の報告による。この draftでは fixture の該当の欄を開いていない【推測】）。
   - 宣言の値、veto の記録、`declarationValues`、`declarations`、`declarationPlace`、`declarationApproval` は消す。
2. **診断の run。**
   - K24-G01-N1、K24-G02-N1、K24-G04-N1、K24-G07-N1、K24-G08-N1 は「宣言しない run では追加の場面が返らない」という期待で、反転する。
   - K24-G01-N2〜N4（再保存と restore の後の宣言の失効）は、失効する宣言がなくなるので、廃止する。本文の変更と frame の不一致は、reader の試験（frame の token）で足りる。
   - 置き換え：宣言も veto の記録も持たない run が、通常の Gold の run そのものになる。追加の診断は、「宣言の 2 列が非 NULL でも結果が同じ」の 1 本があればよい【推測】。
   - S2 の `evals/nir1-graph/observation-prep.v1.json` の `boundFiles[1]`、`d1.addenda`、`d1.runs`、`diagnosticRuns`（上の N 系 8 本）を取り直す。S2 の取り直しは最後の凍結で予定済み（`cp4-final-freeze-prep-2026-11-19/inventory.md` の #2。Fable の報告による）なので、追加の凍結は要らない。
3. **trace 2 本。**
   - `evals/nir1-graph/trace-editing.v1.json`、`trace-browsing.v1.json` の `project.setup` の文に「K2/4 の宣言の段は declarationPlace (ii)」とある（各 1 か所）。bytes が `boundFiles` で束縛されている（`observation-prep.mjs:46-52` の `OBSERVATION_PREP_FILES`）ので、文の改版が要る。
   - trace は問いの Scene（`g02-query`）の編集と browse だけで、追加の場面の excerpt を測らない。測る指標への影響はない【trace の読みのみ】。
4. **seed の pin の addendum。** `seed-pin-addendum.v2.json` の `declarationOrder` の文。bytes が束縛されている。
5. **harness。**
   - `scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts:74-77,381-405`（宣言の API の import と `declaration` の段）。
   - `runner.mjs`、`receipt.mjs:129-161,1010-1040`（`assertDeclarationCurrent`、`declaration` の record）。
   - `constants.mjs:261-358`（`declaration` の印）。
   - `trace-runner.mjs`、`trace-frozen.mjs`、`frozen-k64-plan.mjs`、`frozen-k64-run.mjs`、`frozen-setup-plan.mjs`、`g01-negatives.mjs`、`g01-negative-run.mjs`、`g01-negative-preview.mjs`、`pubg16-e2e-run.mjs` の宣言の段。
   - 各 `*.test.mjs`。
   - `outcome.mjs:205-208` の `cb4-inputs` の判定は、そのまま使える。ただし前提条件は「CB-4 が POV と story position を要求しない」ことで、veto を外すと常に成り立つ。fixture の前提条件の集合は変えない（`evals/nir1-graph/README.md:94`）。
   - **この harness の file の多くは S4 が pin している**（`observation-prep.mjs` の `SOURCE_PINS`。たとえば `frozen-setup-plan.mjs`（`:859`）、`renderer/cp4-harness.ts`（`:896`）、`g01-negatives.mjs`／`g01-negative-run.mjs`／`g01-negative-preview.mjs`（`:1009` 付近）。`receipt.mjs`、`constants.mjs`、`trace-runner.mjs`、`frozen-k64-*.mjs` も後続の pin に移っている旨のコメントがある）。したがって単独の PR で merge しない（§5）。
6. **seam の receipt。** 宣言の段の receipt（env の名前、nonce の digest、承認した grant の数、binding の digest）は、harness が宣言しなくなれば不要になる。宣言の record の schema（`receipt.mjs:1010-1040`）が `g-case-gold` の宣言の run に要求していたものを外す。
7. **CB-4 の負例の試験（Rust）。**
   - 対象は `scene_disclosure/tests.rs`（1,545 行）、`body_tests.rs`（996 行）、`exit_tests.rs`（918 行）、`invalidation_tests.rs`（1,208 行）。
   - 消すものは、宣言なし、片方の列、未知の版、token の不一致、v1 の値以外、veto、宣言の失効（title の A→B→A、章の移動、restore、複製、workspace の移動）、seam、gate、取消。
   - 残すものは、A1 の条件（設定済み、位置、材料の範囲、知っている人・読み手の不一致、unknown、legacy。`tests.rs:503`、`:521`、`scenes.rs:1132`）、reading、pin と path の不一致、frame の不一致、click の TOCTOU、資源の上限、診断と log への非漏洩、AI の request への非混入、unavailable の 1 つの code。
   - 足すものは、veto の記録（secret の foreshadow、secret な event、POV）がある場面でも出ること（宣言と veto を外したことの固定）、宣言の列が非 NULL でも壊れていても結果が変わらないこと、本文の保存の後は Index が追いつくまで出ず、追いついたら新しい excerpt で出ること。
8. **文書。** G-01〜G-08 の addendum を参照する計画書（`docs/plans/nir1-lane-decisions/cb2-decisions.md`、`cb3-decisions.md`、`cb4-decisions.md`、`cp4-decisions.md`）と継続計画の記載。PUB-G の前提一覧（`pubg-prereq-inventory-2026-11-03.md`）の #41（ダイアログ）は不要になる。
9. **画面の文言。** 既定を当てる確認文の「本文の宣言は失効します」（§2.4）。製品の PR（PR-1）で直す。評価の対象ではない。

### 4.3 凍結に関する扱い

- 凍結は「公開の直前の 1 回」で、ユーザーの決定（contracts `ee391d50`）。ユーザーの回答 2 のとおり「決めてから凍結」する：この draft が確認され（2026-11-20）、reader の PR（PR-1）が merge され、S4 の枝の改版（§5）の準備ができるまで、最後の凍結を始めない。
- 過去の測定（s7r1、s9d1 など）は、宣言ありの harness で取った参考値になる。期待される追加の場面は同じなので、数値の読み替えは要らない見込みだが、正式の記録としては最後の凍結が取り直す。
- 品質の閾値、Gold、期待値、fixture の bytes は変えない。fixture の凍結（`freeze.v2.json`）は addendum を束縛しない（addendum の `purpose`）ので、fixture 側は動かない。

## 5. コードの撤去の範囲と PR の切り方（K2R-2、回答済み）

回答は「撤去は PUB-G の後。凍結の前は reader の判定だけ外す。列は残して使わない。migration なし」である。

| PR | 中身 | 凍結・merge との関係 |
| --- | --- | --- |
| PR-1（reader。製品の PR） | §2.1 の判定表のとおりに `scene_disclosure/*` と `graph_response.rs`、`related_scenes_requalification.rs` を直す。宣言、束縛、veto、quarantine を外し、click の handle の宣言の欄を外す。title の digest 関数を移す。CB-4 の試験の組み替え（§4.2 の 7）。既定を当てる確認文の文言（§2.4）。writer、UI、grant、seam には触れない（inert のまま） | 凍結の前に、通常の PR として merge する（製品の file は S4 の pin に含まれない。`EVAL_CLOSURE_EXCLUSIONS` が「shared CI and product」を除外している。`observation-prep.mjs:849`、`:1224`）。ただし merge の前に `observation-prep.test.mjs` が通ることを確かめる【推測】 |
| **S4 の枝（harness と evals と S2 の改版）** | §4.2 の 1〜6：harness が宣言の API を使わなくなる、addendum の新しい版、S2 の取り直し、trace と seed の pin の addendum の文、seam の receipt。確認済みの Graph の restricted 条件を外す draftRef（`nir1-d2a-graph-unrestricted-proposal/1`）の harness の改修（`join.mjs`、`followup.test.mjs`、`availability.test.mjs` など）も、同じ枝に積む | **単独の PR として merge しない。** S4 が pin する harness の file を変える PR は、S4 の枝に積み、merge commit で一緒に取り込む（単独で merge すると PR の CI は merge 前の master 基準で通るが、merge 後の master の `observation-prep.test` が落ち、取り消しても直らない。2026-11-07 の C7 #826 の失敗）。前例の S4 の PR（#779 など）は harness の変更を S4 の枝の中に入れていた。**この枝は最後の凍結の準備の一部で、凍結と測定の前に作る。** 以前の草案にあった「PR-H（harness と evals）を凍結の前に単独で merge する」は取り下げる |
| PR-2（撤去） | Native の entry、grant の kind、IPC、preload、Main の seam、renderer の UI と wrapper、db crate の writer と veto と display、restore のクリア、validator（`scripts/quality/validate-native-writer-ownership.mjs`、`validate-change-feed-writers.mjs`、`validate-narrative-writers.mjs`、`policies/narrative/protected-writers.json` の関連の行）。K3/2 の「宣言 UI」の route 区分の行。規模は Rust 約 17,000 行（db の宣言 11,063 行＋disclosure の試験）、Native 約 1,000 行、Electron と renderer の TS 約 9,000 行（試験を含む）で、合計約 25,000 行の削除 | **PUB-G の後。** S4 の枝が harness の宣言の import を外した後なので、PR-2 は pin 済みの file に触れない見込み。ただし `native-architecture.mjs`（`observation-prep.mjs:1159-1161` の pin）、`eval-native-build.mjs`（`:1032`）など、S4 が pin する file を PR-2 が変えるかは、PR-2 の前に `observation-prep.test.mjs` で確かめる【推測】。「到達不能」であることを PR-1 の DR に書く |
| PR-3（列の DROP、任意） | SCHEMA の版上げ、migration、Drizzle の契約の更新 | 公開の後。DROP すると決めた場合だけ（K2R-3 は「残す」と回答済みなので、今は不要） |

migration は PR-1、S4 の枝、PR-2 のどれにも要らない。

**PR-1 の前に確かめること（項目）**：PR-1 が merge され S4 の枝が未 merge の間、master の harness（宣言の段）と CB-4 の診断 N1 は、宣言がもう効かないので期待と合わなくなる。この間の master の CI（`observation-prep.test.mjs`、診断の試験）が通るかを、PR-1 の前に確かめる。現状は【推測】で、確かめていない。通らなければ、PR-1 と S4 の枝の取り込みの順か、その間の試験の扱いを、PR-1 の DR で決める（技術判断）。

順序は PR-1（merge）→ S4 の枝（harness と evals と S2 の改版、凍結、測定。merge commit で取り込み）→ PUB-G の公開 → PR-2。

## 6. #968（OS ダイアログの廃止、DR-CB2-17）の扱い（K2R-4、回答済み：閉じた）

- #968 は、宣言の OS 確認ダイアログを、画面の 5 チェックと宣言ボタンに替える PR だった（head `0c0f9b01`、`claude/pubg41-declaration-no-os-dialog`）。ユーザーの回答で、2026-11-20 に merge せずに閉じた。
- 閉じた理由：/5 が確認されれば、#968 の対象（宣言の確認）がなくなる。PR-2 で消す code を整えるだけで、製品の挙動が変わらない。K2/4 の draft の改版の要否を #968 は「未確認」としていた（PR の本文）が、/5 がその答えになる。
- DR-CB2-17 の分析は、この draftが引き継ぐ。つまり、OS ダイアログの廃止という方向（宣言の確認を Main の OS ダイアログに依らない）は、宣言そのものの廃止で包含される。
- W6（旧 W6 はダイアログの timeout、fake timer を使う試験）の flake は master 上にある。`electron/main/bodyDeclaration.pipeline.spec.ts:1136` に W6 が残っていて、master の Full（run 44504931616）と #957 の ci.yml で flake の元だった（#968 の本文）。この flake の修正だけを先に入れたい場合は、W6 の置き換え部分だけを別の PR に切り出す。PR-2 で spec ごと消えるので、公開までの間に CI の枠を詰まらせるなら先に切り出す。
- 参考：この draft が確認されなかった（K2/4 のまま）場合は、宣言の UI と確認ダイアログの扱いを改めて決める（#968 を開き直すか、別の PR にする）。今回は確認された。

## 7. PUB-G の開示と案内に書くこと（Fable の A1 の指摘 12）

PUB-G の開示の項目と、作者への案内に、次を入れる。いずれも A1 を残す（K2R-1）ことと、Graph の前提条件から来る。

1. **今の場面が未設定、または以前からの場面だと、Graph 自体が出ない**（`nir1_entity_relation/project_reads.rs:153-159`。今の場面が explicit で解決済みでなければ `a3-query-scope-unavailable`）。restricted の条件を外しても、これは残る。作者が「既定を当てる」操作（SDEF/1:52-54）をするか、既定を設定した project で新しい場面を書くまで、Graph は出ない。以前からの場面では IR は出る。
2. **更新前の原稿は、既定を当てるまで追加枠に出ない。** 公開版から更新した project の、更新の前からある場面は「以前からの場面」（legacy-absent）のままで、A1 が通さない（`scenes.rs:791-794`）。出すには、設定画面の「以前からの場面にも既定を当てる」を押す（`SceneScopeDefaultSection.tsx:299`、`ScopeDefaultApplyPanel.tsx:28-34`、`:151-156`）。**押すと元に戻せず**（`ja.json:4155`）、**その場面に結びついた承認済みの解釈が失効する**（`sceneScopeDefaultTranslations.ts:33-34`、SDEF/1:58）。
3. 作者が Scope 欄で別の時間軸、世界線、語りの層にした場面と、「知っている人」「読み手」を人物に変えた場面は、追加枠に出ない。設定の無い場面（取り込み、復元、取り消しで戻した場面）も出ない。理由は画面に出ない（理由の code は 1 つにまとめる）。
4. R（本文の類似）は、これらの場面を今も出す。追加枠の判定は Graph の 1 枠だけである。
5. 追加枠は 1 つで、候補は関連の強さの順ではなく到達した人物の順と場面の ID の順。Raw が 8 件の場合と、IR が共通枠を使っている場合は、追加枠が開かない。
6. 以前からの project で Graph をどう動かすか（1 と 2 の扱い）は、公開の後の見直し（A1 を外すか、legacy だけ通すか）の材料になる。【PUB-G の前提一覧に載っているかは未確認】

## 8. 確認の記録（2026-11-20）

確認の記録（contracts `11dc9eda`、確認 1）。問いは、点検の指摘（技術語を減らす、二重の確認をやめる、重要な変更に絞る）に合わせて、統合者が平易にまとめた。ユーザーの回答は「**この内容で確認する（推奨）**」。確認文の正確な入力は要らず、同意の回答を確認として扱う（2026-10-25 の確認の緩和）。確認は contractId ごとに 1 段落で、同じ回答が 2 つの contractId の両方に及ぶ。

### `graph-target-scene-body-disclosure`（K2/4 の改訂）

Graph が足す 1 件の場面は、本文の宣言と veto（秘密の印と視点人物（POV）の記録による拒否）をやめ、作者の操作なしで出す。**秘密の印と POV 記録の判定をしない（読む順の判定は残る）。** 求めるのは、読む順で今の場面より前であることと、A1（今の場面と同じ世界線・時間軸・語りの層・材料として見せる範囲・知っている人・読み手。公開の後に見直す）、live で archive されていない場面であること、結果の整合性の判定（frame、pin、path、返却時と click 時の再検証）、追加枠の条件だけである。出すのは title・本文の先頭の 1 行・その位置への移動だけで、AI の request、Packing、履歴、export、audit には載せない。path の根拠の規則（secret な foreshadow、POV、hidden、phase）と IR の admission は変えない。したがって「画面の判定をすべて外す」ことではなく、Graph の追加の 1 枠の宣言と veto を外すことに限る（§3.1）。評価（G-01〜G-08）の追加の場面は入れ替わらない見込みだが、**これは fixture の読みと機械的な数え上げで、Graph も reader も実行して確かめていない**（§4.1）。実行での確認は最後の凍結で行い、閾値は変えない。

### `scope-storage-authority`（K2/4 の Scene Scope v2 の差分の改訂）

宣言の 2 列は残して使わない（どの reader も読まない）。migration はしない。宣言の writer、UI、grant、seam のコードの撤去は PUB-G の後で、それまでは gate で閉じたまま（PUB-G の承認はこの gate を開けない）。Scene Scope の binding、registry、project の既定は変えない。保存の範囲は広がらず、縮小でもない。

### 許可しないもの

PUB-G の公開、restricted の要否の変更（別の draftRef）、AI への送信（excerpt は今までどおり AI に載せない）、R／IR／path の開示の変更、関連シーンの未来の場面（J10）、最後の凍結の開始、閾値の変更。片方の contractId だけを確認した場合は、その contractId だけを置き換える（もう一方は K2/4 のまま。この場合は宣言の列の扱いと reader の整合が崩れるので、integrator が再度伺う）。今回は 2 つとも確認された。

### 確認の対象にしないもの（integrator の技術判断。実装前に確かめる）

- PR-1 の merge から S4 の枝の merge までの間の master の CI の確かめ（§5）。
- 位置の正本の寄せ方、PR の分け方、harness と評価の改版の細部。ただし閾値は変えない。

## 9. 未確認

- 実行はしていない。§4.1 の「入れ替わらない」は fixture の読みと機械的な数え上げで、Graph も reader も動かしていない。Scene Scope の実際の値は addendum の記述から。
- fixture の `addedScene.sceneExcerpt` が excerpt の範囲の正本であること（addendum の `expectedExcerpt` が写しにすぎないこと）は、Fable の報告による。この draftでは fixture の該当の欄を開いていない。
- G-01 の addendum の `afterMutationReadings` と、各 harness の宣言の段の実装の細部（`trace-runner.mjs` ほか）は、grep の件数と文言の確認だけで、中身を読んでいない。
- S4 が pin する file の範囲：harness の主な file が `SOURCE_PINS` に載っていることは `observation-prep.mjs` で確かめた。PR-1 が触る製品の file がどれも pin に載らないこと、PR-2 が `native-architecture.mjs`、`eval-native-build.mjs` など pin 済みの file を変えるかは、PR の前に `observation-prep.test.mjs` で確かめる。
- PR-1 の merge から S4 の枝の merge までの間の master の CI（`observation-prep.test.mjs`、診断の試験）が通るか（§5 の項目）。【推測】
- 公開済みの DB に宣言の非 NULL の行がないこと（gate が閉じている、公開済み schema は 2）。【推測】
- Graph-only の候補を作る pin が、hidden の Codex Entry を経由しないこと。path 側が hidden を除外している（`nir1_entity_relation.rs:1305` ほか）ので、通常は経由しない【推測】。Codex hidden の漏れの修正は PR #981、「これまで」の前後の修正は PR #976 で、どちらも merge 済み（2026-11-19）。この draft の範囲外。
- 「Graph が restricted なしで動くこと」（決定 3、案 A）は別の draftRef（`nir1-d2a-graph-unrestricted-proposal/1`、`caller-profile-egress` の Graph の行の改訂。2026-11-20 に確認済み）で、この draft の範囲外。reader の変更は restricted の条件と独立に作れる。ただし S4 の枝の harness の改修は両方を同じ枝に積む（§5）。
- 実際の project に、別の世界線・層・人物の設定を使う作者と、設定の無い場面がどれだけあるかは分からない（Fable の A1 の相談でも未確認）。A1 の見直し（公開の後）の材料にする。
- K1b の veto の行の上限の定数（`SCENE_BODY_VETO_MAX_ROWS`）の扱い。削除は緩和に当たらないと読むが、K1 の確認済みの表の文言は確かめていない。
- 回答 2 の J8 を選んだときにユーザーが見た文面（Fable の D-4）は、Scope の一致を調べていない。この draft は A1 を、ユーザーの別の回答（2026-11-20 未明）で残すと決めた。
