# 案 B の設計草稿：新しい場面の Scope の既定を「project の既定を受け継ぐ」にする（`scope-storage-authority` の改訂案）

| 項目 | 内容 |
| ---- | ---- |
| 状態 | **設計草稿（draft）。未確認。契約の確定でも実装の承認でもない**。独立レビューの後、ユーザーに確認を求める |
| 基点 | `origin/master` `f36dd696`（#783）。記録は `origin/claude/nir1-contracts` `2cddfb14` |
| ユーザーの決定 | `2cddfb14` の `docs/plans/nir1-cp4-records/user-confirmation-2026-11-03-scope-default-first.md` の追記：質問 2 の回答「B：project の既定を受け継ぐ (推奨)」。記録は「この回答は設計の着手の承認で、契約の改訂・実装の承認ではない」と書く |
| 材料 | `origin/claude/nir1-contracts:docs/plans/nir1-fusion-records/scope-default-material-2026-11-04.md`（以下「材料」） |
| 調べ方 | git object を読むだけ（`git show`／`git grep`）。build・test・起動はしていない |
| 表記 | 行番号は特記が無ければ `origin/master` の版。パスは repo 相対。`scene_scope.rs` は `src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs`、`core scope` は `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs`、`l6-l9` は `docs/plans/nir1-l6-l9-execution-plan.md`。**推測**と書いたものは私の読みで、コードや文書で確かめていない |

## 0. 要点

- project ごとに「場面の Scope の既定」を Native が持つ。中身は 3 軸（timeline／worldline／narrativeLayer）の exact な ref。保存先は新しい表にする。registry の外に置くので、既定を変えても既存の場面と registry の token は変わらない（§3）。
- 新しい場面を作る経路では、Native が同じ transaction で既定を読み、`explicit` の binding を書く。値は query identity も material 制約も同じ exact な ref、holder と audience は reader。既定が無いか registry と合わないときは今どおり `unknown` にする。`any` には落とさない（§2、§4）。
- 復元の経路（ゴミ箱・project snapshot）、本文保存での欠けた binding の修復、migration は**継承しない**。今どおり `unknown`／`legacy-absent` にする（§4）。
- 「語彙の初期投入」と「既定の初期設定」は分けて扱う。既定を全ての `project_create` で自動で入れる（α）と、CP-4 の凍結 setup と DP-H の harness が registry の置換で止まる（§3.5、§9）。推奨は β で、作成ダイアログの経路だけが既定を入れる。
- 既存の project と既存の `unknown` の場面には、migration で既定を当てない。作者の操作（設定画面、場面ごとまたは章ごとの「既定を当てる」）にする（§5）。
- 開示の主な危険は、回想・夢・別の世界線・作中作の Scope を作者が変え忘れ、本筋の IR／Graph に混ざること。読書順と秘密の防御は変わらない。表示と章単位の操作で軽減する（§8）。
- 新しい保存先を足すので、AGENTS の委任の外（保存範囲の拡大と新しい契約）にあたる。新しい draftRef の確認が要る（§2）。

## 1. 目的と範囲、変えないもの

### 1.1 目的

今の製品では、新しい場面の Scope binding は `compatibility_marker: unknown` で作られる（`scene_scope.rs:461-472`。marker は :464）。関連場面の IR は、query の場面が `unknown`、または `explicit` でも query の軸に `unresolved` が残ると `ScopeUnsupported` で出ない（`retrieval_admission/query_context.rs:120-133`）。材料側も `unknown` の場面を拒否する（`scene_scope.rs:1955-1956`）。Graph は target の場面が `explicit` で、query の軸が exact に一致することを求める（`nir1_graph/scenes.rs:787-833`）。このため作者が場面ごとに registry を作り、3 軸を選ばないと、IR も Graph も出ない（材料 §4）。

案 B は、project に既定の Scope を持たせ、新しい場面が作成時にそれを `explicit` で受け継ぐようにする。作者が何もしなくても、本筋の場面どうしで IR と Graph が働く状態から始められるようにする。

### 1.2 範囲

- 契約 `scope-storage-authority` に新しい draftRef の差分を足す（§2）。
- project の既定の保存、作成経路での継承、既定の読み書きの IPC、UI（§3〜§7）。
- 既存の場面の扱い、失効、開示の安全、評価への影響、段取り（§5〜§10）。

### 1.3 変えないもの

| 変えないもの | 根拠 |
| ---- | ---- |
| `unknown`／`unresolved` の fail closed。query 側の `ScopeUnsupported`、材料側の `ScopeUnsupported`、Graph の `explicit` 要件 | `query_context.rs:120-133`、`scene_scope.rs:1955-1956`、:1966-1977、`nir1_graph/scenes.rs:787-833`。l6-l9:304「unknown／unresolvedはfail closedにする」 |
| query identity に `any` を作らない | `core scope:222-225`（`queryIdentity.{name} cannot be any`）、l6-l9:857 |
| ADR 009 の any と unresolved の区別 | 材料 §2、`docs/adr/009-narrative-scope-relation-contract.md`。B は any も unresolved も新しく作らず、exact だけを書く |
| 読書順の制約（材料は今の場面より前の場面に限る）と秘密を出さないこと | l6-l9:877 の「IR/Graph材料のstrict reading-before-S2を維持」、`query_context.rs:197` の `allow_secrets: false` |
| 案 D（`unknown` を any や legacy-absent と同じに扱う）を採らない | 材料 §5「案 D を推奨しない理由」。l6-l9:302 の In-scope attacks「unknownからanyへのfallback」 |
| `legacy-absent` の意味と、`explicit`／`unknown` から `legacy-absent` へ戻せないこと | `scene_scope.rs:1283-1289`、`core scope:142-164` |
| registry を変えると全場面の Scope 世代が進み、型付き Revision がすべて失効する規則（X1/1 の Q2） | `docs/plans/nir1-scene-scope-projection-proposal-1-draft.md:422-431`、`scene_scope.rs:1507-1529` |
| 復元は旧資格を復活させない。snapshot の本文 restore は binding を作り直す | l6-l9:299（clear／undo／restore）、X1/1 の F19、`project_snapshots.rs:3707-3765` |
| binding の行の形（列と `NarrativeSceneScopeBindingV1`）、v1 の source token の式 | `core scope:84-97`、:176-199。B は binding の形を変えない |
| 閾値、Gold、評価の規則、凍結済みの trace の file | 委任の外（AGENTS「閾値の緩和」）。§9 |

### 1.4 B を入れても IR が出ない残りの条件（B は解かない）

- 材料にする過去の場面が `unknown`（材料 §4。B の前に作った場面）。§5 で作者の操作で当てられるようにする。
- 場面が archived（`query_context.rs:63`）。
- 読みの軸が reading でない（`query_context.rs:94-95`）。新しい project の `phase_resolution_mode` は既定 `'auto'`（`src-tauri/crates/grimodex-db/src/migrate.rs:529`）で、全場面に story の key が付くと story に倒れる（`narrative_extraction/disclosure_precheck/scene_axis.rs:48-49`）。
- `legacy-absent` の場面は IR は出るが Graph は出ない（材料 §4 の表）。
- 承認済みの Revision が無ければ、どの Scope でも IR は出ない（推測ではなく前提：IR は人の承認を要する）。

## 2. 契約の改訂

### 2.1 draftRef と確認の扱い

- draftRef の案：`nir1-scene-scope-default-proposal/1`、contractId `scope-storage-authority`。
- 既存の 4 行（proposal/3 の baseline、X1/1、X1/3、K2/4。l6-l9:229、:247、:249、:251）は置き換えず、この行を加算で並べる。X1/1・X1/3・K2/4 の差分とは互いを前提にしない。
- AGENTS の委任（NIR-1 の残レーンの技術判断）は「保存範囲の拡大」「新しい契約・authority」を含まない（`AGENTS.md`「作業範囲と完了」）。B は project の既定という新しい保存項目を足すので、ユーザーの確認が要る。確認の手続は l6-l9:294 の Confirmation protocol（2026-10-25 の緩和後）に従う。

### 2.2 Delta（案）

1. **project の場面 Scope の既定**。Native が project ごとに 0 または 1 つの既定を持つ。中身は閉じた型で、query identity の 3 軸がすべて exact、material 制約は query identity と同じ exact、holder と audience は reader に固定する（v1）。既定が無い状態は「既定なし」で、今の挙動と同じになる。
2. **作成時の継承**。新しい incarnation を発行する作成の経路のうち、閉じた一覧（§4 の「継承する」の行）だけが、同じ transaction の同じ snapshot で既定と registry を読む。既定があり、その ref が registry の member なら、binding を `explicit`、既定の値、version 1 で書く。それ以外は `unknown` で書く。renderer は作成時の Scope を申告しない。
3. **継承しない経路**。復元（ゴミ箱、project snapshot の本文 restore）、欠けた binding の修復（本文保存）、migration の backfill、性能 lane の seed は、今どおり `unknown`／`legacy-absent` を書く。l6-l9:873「markerのない部分snapshot、不明な復旧」は `unknown` のまま。
4. **既定の変更は既存の場面を変えない**。既定の書込みは binding、registry、project の Scope authority の token のどれにも入らない。既存の Revision、Index、宣言を失効させない。
5. **registry との不変条件**。既定の ref は registry の member でなければ書けない。registry の writer は、既定が使っている ref を消す更新を拒否する（既存の binding と同じ扱い。`scene_scope.rs:1476-1481`）。万一 dangling になっても（例：古い backup）、作成時の継承は `unknown` に落とし、any には落とさない。
6. **新しい project の初期設定**。`project_create` の payload の optional な typed field（§3.5 の β）で「本筋」を選んだときだけ、同じ transaction で registry に本筋の語彙を入れ、既定を書く。場面はまだ無いので依存は無い。
7. **L6 の表の読み方**（l6-l9:870「新規、複製、import、削除後のID再利用｜…Scope markerは未設定なら`unknown`」）。「未設定」を「場面にも project にも既定が無い」と読む。project の既定から Native が書いた binding は、作者の設定に由来する明示設定として `explicit` で表す。marker の値の集合と意味の区別（l6-l9:861）は変えない。
8. **変えないもの**：§1.3 のすべて。

### 2.3 actor・攻撃・防御・受入れ（proposal/3 の行への追加）

- Trusted actors：変えない（Native、既存の project の Scope authority、同じ transaction の journal と失効）。既定の writer と reader は Native に置く。
- Untrusted actors：今の一覧（renderer の Scope／profile／incarnation の申告、model output、stale な UI・cache・restore 由来のデータ。l6-l9:301）に、renderer が申告する既定の値と、`project_create` の初期設定の field を加える。どちらも開示の認可の根拠にせず、Native が registry の所属と型を検証する。
- In-scope attacks（追加）：別 project の既定の参照、registry に無い ref を持つ既定、dangling な既定から any への fallback、復元の経路での黙った継承、既定の変更で既存の場面が書き換わること。
- Mandatory defenses（追加）：作成の writer は既定と registry を同じ snapshot で読み、exact な project と ref を要求する。継承できなければ `unknown`。継承するかどうかは作成の種類（§4）で Native が決め、呼出し側の値で決めない。既定の書込みは binding と token を書かない。
- Acceptance（追加）：Positive：既定のある project で各作成経路が `explicit` を書き、cold reopen 後も同じ値。IR と Graph が本筋の場面どうしで出る。Negative：既定なし・dangling・別 project では `unknown`。復元と修復の経路は既定があっても `unknown`。既定の変更で既存の binding の bytes と token が変わらない。registry から使用中の ref を消す更新は拒否。Recovery：既定の行が壊れていれば既定なしとして扱い、作成は `unknown`。

### 2.4 確認台帳の行の新旧の対照

| 欄 | 今（proposal/3、l6-l9:229 と :296-305） | 案 B の新しい行（加算） |
| ---- | ---- | ---- |
| contractId | `scope-storage-authority` | 同じ |
| draftRef／confirmedRef | `nir1-l6-l9-contract-proposal/3` | `nir1-scene-scope-default-proposal/1`（確認後に confirmedRef） |
| 保存するもの | project の registry と、場面ごとの閉じた binding | 上に加えて、project ごとの場面 Scope の既定（新しい表。§3） |
| 新しい場面の marker | 「未設定なら`unknown`」（l6-l9:870） | 既定があれば作成の経路で `explicit`（既定の値）。無ければ `unknown` |
| 復元・不明な復旧 | `unknown`（l6-l9:873） | 変えない |
| 既定の変更の効果 | （項目なし） | 既存の場面、registry、token、Revision、宣言を変えない |
| registry の更新 | 全 binding の世代を進め、依存を失効（X1/1 Q2） | 変えない。既定が使う ref の削除を拒否する条件を足す |
| In-scope attacks | cross-project、偽造・stale token、unknown→any、ID reuse／restore 混入、stale result（l6-l9:302） | 加えて §2.3 の 5 項 |
| Mandatory defenses | 同じ snapshot での検証、renderer を根拠にしない、unknown／unresolved は fail closed（l6-l9:304） | 加えて §2.3 の 4 項 |
| 開く lane | A1 など | B-1〜B-4（§10.1） |
| 確認していないもの | — | Graph・local 送信・activation UI の公開、閾値、Gold、評価の規則、新しい送信先 |

## 3. データ

### 3.1 保存先の比較

| 案 | 内容 | 問題 | 判定 |
| ---- | ---- | ---- | ---- |
| registry の struct に field を足す | `NarrativeSceneScopeRegistryV1` に既定を入れる | struct は `deny_unknown_fields`（`core scope:42-52`）で、v1 の source token の入力（`core scope:176-199`）。field を足すと全 binding の token が変わる。既定を変えるたびに registry の writer が全 binding の世代を進める（`scene_scope.rs:1507-1529`）ので、「既定を変えても既存の場面は変わらない」というユーザー決定と矛盾する | 採らない |
| (a) `narrative_scope_registries` に token の外の列を足す | 同じ行に、token に入れない列を足す | 同じ行に 2 つの OCC（registry の `version` と既定の版）が並ぶ。registry の authority digest（`scene_scope.rs:719-897` の `read_scope_extension`）から既定を外す保証を、列ごとに書いて試験する必要がある | 次点 |
| (b) `project_settings` の key | 汎用の key-value（`migrate.rs:1094-1099`） | Native の汎用の key-value の writer（`domain_writes.rs:2266` 付近。key は renderer が選ぶ）が同じ表を書く。閉じた型と registry の所属の検証を、汎用の writer の外に置くことになる | 採らない |
| (c) 新しい表 | `narrative_scope_project_defaults` | 表が 1 つ増える（保存範囲の拡大。確認が要るのはどの案でも同じ） | **推奨** |

### 3.2 表の案（SCHEMA 44）

```sql
CREATE TABLE IF NOT EXISTS narrative_scope_project_defaults (
    project_id                TEXT NOT NULL PRIMARY KEY
        REFERENCES projects(id) ON DELETE CASCADE,
    schema_version            INTEGER NOT NULL CHECK(schema_version = 1),
    query_identity_json       TEXT NOT NULL CHECK(json_valid(query_identity_json)
                                AND json_type(query_identity_json) = 'object'),
    material_constraint_json  TEXT NOT NULL CHECK(json_valid(material_constraint_json)
                                AND json_type(material_constraint_json) = 'object'),
    version                   INTEGER NOT NULL CHECK(version >= 1),
    source_token              TEXT NOT NULL CHECK(length(source_token) = 71
                                AND source_token GLOB 'sha256:*'),
    updated_at                TEXT NOT NULL
);
```

- 行が無い＝既定なし。「既定を外す」は行の削除ではなく、OCC を保つために tombstone（例：`query_identity_json` に `{"kind":"none"}`）にするか、行を消して version を別に持つかは実装で決める（推測：消すと A→B→A で token が戻りうるので、tombstone が安全）。
- holder と audience は v1 で reader に固定するので列を持たない。人物を既定にすると、人物の削除の拒否（`scene_scope.rs:977-1024` の `ensure_character_reference_mutation_allowed_in_tx`）を既定にも広げる必要がある。v1 では避ける。
- material 制約を query identity と別の列にするのは、将来「本筋の材料をほかの層にも見せる」を選べるようにするため。v1 の writer は 2 列が同じ exact であることを要求する。
- 列追加と表作成の雛形は SCHEMA 43（`migrate.rs:4508`、:10137-10146）。版は `grimodex-core/src/lib.rs:3` の `SCHEMA_VERSION = 43` を 44 にする。merge の順で採番が変わりうる（K2/4 と同じ扱い）。

### 3.3 不変条件

1. 既定の 3 軸は exact で、ref は同じ project の registry の member（書込み時に `validate_registry` と同じ規則で検証。`core scope:99-120`）。
2. registry の writer（`update_narrative_scene_scope_registry`、`scene_scope.rs:1420-1610`）は、既定が使う ref を消す更新を、既存の binding の検証（:1476-1481）と同じ transaction で拒否する。新しい error code の案：`NEX_SCENE_SCOPE_DEFAULT_REF_IN_USE`。既定を自動でクリアする案は、作者が気づかないまま既定が外れるので採らない。
3. 作成の writer は、既定の行が読めない、型が壊れている、ref が registry に無い、project が違う、のどれでも `unknown` を書き、作成自体は失敗させない（推測：作成を失敗させると、本文を書く操作が Scope の不整合で止まる。fail closed の対象は開示で、作成ではない）。
4. 既定は project の Scope authority の digest（`read_scope_extension`）に入れない。試験で、既定の書込みの前後で authority の token が同じであることを固定する。

### 3.4 migration

- SCHEMA 44 は表を作るだけで、既存の project に行を入れない（理由は §5.2）。
- 既定の表を generic SQL の拒否一覧（`src-tauri/crates/grimodex-db/src/execute.rs:4470-4500` 付近。`narrative_scope_registries` は :4491）と、保護 writer の一覧（`policies/narrative/protected-writers.json:462-475` 付近）に加える。schema の生成物（`src-tauri/crates/grimodex-core/src/workspace_schema.rs`、`src/db/schema.ts`、`src/db/generated/schema-contract.json`、`src/db/narrativeExtractionSchema.test.ts`）も更新する。
- `profile_egress_policy.rs:322-330` の試験は `narrative_scope_registries` などを「列挙に無い表」として確かめている。新しい表の分類は実装で決め、K3 の表の分類規則に従う（推測：registry と同じく列挙に入れない）。

### 3.5 「語彙の初期投入」と「既定の初期設定」を分ける

**語彙**は registry の ref（例：`timeline:main`）、**既定**は継承を起こす値。語彙だけを入れても挙動は変わらない（既定が無ければ新しい場面は `unknown`）。

#### 3.5.1 語彙の初期投入（推奨：入れる）

- `ensure_scope_registry_in_tx`（`scene_scope.rs:492-520`）の初回 INSERT で、`default_registry()`（:90-97。今は 3 軸とも空）の代わりに本筋の語彙 `timeline:main`／`worldline:prime`／`layer:manuscript` を入れる。値は Scope 欄の placeholder（`SceneScopeRegistryEditor.tsx:8-10`）と CP-4 の G-01 の setup（`docs/plans/nir1-lane-decisions/cp4-decisions.md:680` の DR-CP4-J-2 (1)）に合わせる。
- 効く範囲：`project_create`（`domain_writes.rs:1686`）、サンプル（`sample_seed.rs:229`）、migration の backfill（`migrate.rs:4542`。新しい workspace の `default-project`〔`migrate.rs:1521-1527`〕を含む）、修復時の lazy 生成（`scene_scope.rs:445`）。既に行がある project（既存の project）には効かない（`ON CONFLICT(project_id) DO NOTHING`、:503-507）。
- harness を壊さない理由：`unknown` の binding は query identity が 3 軸とも unresolved、material 制約が any（`scene_scope.rs:99-119`）なので、registry の ref を参照しない。exact だけが所属を要する（`core scope:209-260`）。3 つの harness はどれも registry を配列ごと置き換える（`scripts/quality/nir1-graph-eval/frozen-setup-driver.mjs:742-746`、`setup-driver.mjs:372-388`、`electron/native/grimodex-node/src/nir1_final_request_eval/harness/workspace.rs:514-530`）ので、置換の検証（`scene_scope.rs:1476-1481`）を通る。凍結 driver の照合（`frozen-setup-driver.mjs:1975-1977`）は置換後の行を plan と比べるので、初期の中身に依らない（推測：受領書が置換前の registry の中身を記録していないことは、実装時に receipt の形で確かめる）。
- 得るもの：新しい workspace の `default-project` では、後で作者が「本筋を既定にする」を押しても registry を変えずに済み、何も失効しない（§6）。`legacy-absent` の場面を保存するときに exact を選べるので、材料 §4「保存の罠」（registry が空だと exact を選べず、`explicit`＋`unresolved` になる）が起きにくくなる。
- 費用：初期の registry が空であることを前提にした試験（例：`scene_scope.rs:2109-2150` の `default_registry()` を使う試験）の期待値が変わる。

#### 3.5.2 既定の初期設定（推奨：β）

| 案 | 内容 | 利点 | 問題 |
| ---- | ---- | ---- | ---- |
| α 自動 | 全ての `project_create` と registry の初回 INSERT で既定も入れる | 作者は何もしなくてよい | harness が壊れる。CP-4 の凍結 setup は Scene を作ってから registry を fixture の ref に置き換える（`frozen-setup-driver.mjs:632-654` の `tree_node_create` の後に :724-750 の `scope-registry`）。DP-H も同じ順（`harness/run.rs:211`→:235→:246-255→:263-273）。継承で `explicit`（`timeline:main`）になった binding を、置換後の registry（G-02〜G-08 の `tl-main` など〔DR-CP4-I-4 (5)、`cp4-decisions.md:640`〕、DP-H の `timeline:v2-mainline`〔`evals/nir1-packing/final-request.v2.json:86-88`〕）で検証すると失敗し、setup が止まる。直すには harness の変更、CP-4 の再凍結、DP-H の freeze の変更が要る。サンプル（`sample_seed.rs:267`）も本筋になる |
| **β 作成 UI だけ（推奨）** | `CreateProjectDialog` に「新しい場面を『本筋』で作る」を既定オンで置き、`project_create` の payload に optional な typed field（例：`sceneScopeDefault: "main-line"`）で運ぶ。Native は同じ transaction で語彙と既定を書く | 凍結 harness は field を渡さない（`src/features/project/api.ts:46-83` の `createProject` を `scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts:181` が呼ぶ。DP-H は N-API の `project_create`）ので、初期状態が今と同じ。UI からの作成（`projectStore.ts:693` の `createNewProject`、取り込み〔`src/features/import/importTarget.ts:41`〕、`ProjectMenu.tsx:81`）には効く | migration が作る `default-project`（`migrate.rs:1521-1527`）は `project_create` を通らないので既定なしのまま。新しい利用者の最初の project なので、最初の起動で 1 クリック（§7.1 の案内）が残る |
| γ β ＋ bootstrap | β に加え、SCHEMA 44 の migration が「場面が 0 件で registry が版 1 の project」にだけ既定を入れる | 新しい workspace の最初の project も最初から本筋 | L0 の setup は workspace の最初の project を使う（`scripts/quality/setup-nir1-retrieval.mjs:240-290` 付近の `SELECT id FROM projects ORDER BY created_at,id LIMIT 1` と `tree_node_create`）。その場面が `explicit` 本筋になるので、L0 の R+IR の観測が変わりうる。Raw が Scope で絞られないなら Raw の基準は変わらないが、材料 §6 のとおり未確認。L0 の再測定の要否の判断が要る。既存の workspace の空の project にも入る |

- 推奨は β。理由：ユーザー決定の「既定を変えても既存の場面は変わらない」と、凍結済みの harness の不変が両立する。renderer の申告は開示の認可ではなく、新しい project の属性の初期値で、Native が型と registry の所属を検証する。同じことは既存の IPC（registry と Scene Scope の更新）でもできるので、新しい権限にならない（§8.3）。
- γ は L0 への影響を確かめた後に選べる。ユーザーの確認点にする（§10.3 の Q2）。
- β の field の置き場：取り込み（`src/features/import/importTarget.ts:41`）は `CreateProjectDialog` を通さず store の `createNewProject` を直接呼ぶ。field をダイアログだけが渡す形なら、取り込みで作る project は既定なしになる。store の `createNewProject` の既定値をオンにすると、作者がチェックを見ないまま、取り込んだ原稿の全場面（回想の章を含みうる）が本筋になる（§8.1）。推奨は、取り込みの画面にも同じチェックを出して、作者が明示で選ぶ形にすること（§10.3 の Q13）。

### 3.6 export／snapshot／backup／restore

| 仕組み | 今 | B での扱い（推奨） | 根拠 |
| ---- | ---- | ---- | ---- |
| backup（workspace の DB 全体） | registry と binding を含む。restore の前検査は欠けた binding を fail closed にする | 新しい表も DB に含まれる。SCHEMA 44 より前の backup を戻すと migration が空の表を作り、既定なしになる | `backup_restore.rs` の試験 `restore_of_current_a1_backup_with_missing_binding_remains_fail_closed`（:3054 付近）、`migrate.rs:11190` 付近の試験名 |
| project snapshot | 捕える表の一覧（`SnapshotRestoreTable`、`project_snapshots.rs:470-620`）に Scope の表は無い。本文 restore は binding を作り直し `unknown` にする | 既定も捕えない・戻さない。既定は project の設定で、内容の版ではないと扱う。restore の後も今の既定が残る | `project_snapshots.rs:2897-2961`、:3707-3765（`assert_eq!(after.1, "unknown", "the default A1 marker")` は :3760） |
| ゴミ箱 | payload は renderer が作り、Scope を持たない。restore は新しい ID で場面を作る | 既定を当てない（§4.3） | `trash_bin.rs:136`、:294-420（`restore_id` は :300、binding は :408） |
| 本文の export（.md など） | Scope を出さない（推測） | 変えない | 未確認 |
| 既定の read の公開範囲 | — | 新しい IPC の read と write（§7）。restricted profile でも通す internal command に分類するかは K3 の分類規則に従う（`electron/main/profileEgress.ts:487-489` の Scope の 3 command と同じ扱いを推奨） | `profileEgress.ts:470-500` |

## 4. 継承の経路

### 4.1 Scene を作る全ての経路（実物で列挙）

正本は writer の網羅の試験 `src-tauri/crates/grimodex-db/tests/narrative_scope_storage_authority.rs` の MANIFEST（`SceneCreate` は :222-226、:257-261、:320-324、:369-373、:488-492、:502-506、:530-534 付近。`ProjectRestore` は :466-478 付近）と、`ensure_scene_scope_binding_in_tx` の呼出し元（`git grep`）。走査の範囲は `src-tauri/crates/*/src` の test でない code（同 :651-699）。test の中の呼出し（`backup_restore.rs`、`chronicle_bulk.rs`、`execute.rs`、`revision_restore.rs`、`agent_writes.rs` など。材料 §6 の注）は除いた。

| 経路 | 呼出し（file:line） | 種類 | 今 | B の推奨 | 理由 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 場面の作成（ツリーからの作成、取り込み、外部 mount の同期を含む。推測：取り込みと同期もこの writer を通る） | `domain_writes.rs:3325`（`tree_node_create_with_authority`） | 作成 | `unknown` | **継承** | 新しい場面。ユーザー決定の対象そのもの |
| AI の木構造計画の適用 | `domain_writes.rs:5616`（`apply_ai_tree_plan`） | 作成 | `unknown` | **継承** | 新しい場面。計画（model output）は Scope を指定できず、IR には人の承認が要る（§8.3） |
| 付箋の昇格 | `map_writes.rs:782`（`promote_sticky`） | 作成 | `unknown` | **継承** | 新しい場面 |
| ゴミ箱からの復元 | `trash_bin.rs:408`（`restore_scene_in_tx`） | 復元（新しい ID） | `unknown` | **継承しない** | §4.3 |
| project snapshot の本文 restore | `project_snapshots.rs:2946`（`apply_project_snapshot_restore`） | 復元（binding の作り直し） | `unknown` | **継承しない** | §4.3。l6-l9:873 |
| 本文保存（欠けた binding の修復） | `scene_body.rs:379`（`save_scene_body_bundle`） | 修復（場面は既にある） | `unknown` | **継承しない** | 場面を作らない。binding が欠けた理由が分からない（不明な復旧。l6-l9:873） |
| 製品同梱サンプル | `sample_seed.rs:229`（registry）、:267（場面） | 作成（seed） | `unknown` | v1 では**継承しない**（確認点 Q8） | サンプルの内容に回想・作中作があるかを確かめていない。あれば出荷物で §8 の危険が起きる。サンプルで IR が働くのは作者が抽出・承認したときだけ |
| 性能 lane の seed | `runtime_performance_seed.rs:617` | seed（開発用） | `unknown` | 継承しない | 性能の fixture を変えない |
| 容量の fixture | `narrative_extraction/nir1_capacity_fixtures.rs:477`、:497 | seed（試験用。MANIFEST に載る） | `unknown` | 継承しない | 試験の前提を変えない |
| migration の backfill | `migrate.rs:4542`（`backfill_scene_scope_storage_in_tx`、`scene_scope.rs:524-572`） | migration | `legacy-absent` | 変えない | l6-l9:865 |
| project の作成（registry） | `domain_writes.rs:1686` | registry の作成 | 空の registry | 語彙を入れる（§3.5.1）。β の field があれば既定も | §3.5 |

材料 §4 は「呼出し元は製品コードでおよそ 8 箇所」とする。上の表で場面の binding を作る製品の経路は 8 つ（作成、AI 計画、付箋、ゴミ箱、snapshot、本文保存、サンプル、性能 seed）で、数は合う。継承するのはそのうち 3 つ。複製の機能はツリーの code に見つからなかった（`src/features/tree` の grep。推測：無い）。

### 4.2 書き方

- `ensure_scene_scope_binding_in_tx(conn, project, scene, at)`（`scene_scope.rs:434-475`）に、作成の種類を表す閉じた引数を足す。案：`SceneScopeInit::NewSceneInheritProjectDefault`／`SceneScopeInit::UnknownRepairOrRestore`。bool にしない（呼出しの意図を読めるようにし、将来の復元経路が黙って継承しないようにする）。
- `NewSceneInheritProjectDefault` のとき、同じ `conn`（同じ transaction）で既定と registry を読み、§3.3 の 1 を満たせば次の binding を `insert_binding_in_tx`（:691-716）で書く：`compatibility_marker: Explicit`、`query_identity` と `material_constraint` は既定の exact、`knowledge_holder`／`audience` は reader、`version: 1`、新しい `scene_incarnation_id`。満たさなければ今の `unknown`（:461-472）。
- binding が既にあれば何もしない（:447-459 の早期 return。変えない）。
- feed：今の作成は場面の作成の event を出し、binding の作成に `scene-scope` の event は出さない（推測：`ensure` は feed を書かない。:434-475 に feed の呼出しが無い）。B でも変えない。X1/1 の routing は Scene の create を投影の identity に写す（`docs/plans/nir1-scene-scope-projection-proposal-1-draft.md:284` の節「完全な Source としての登録」の feed の routing の項）ので、投影の扱いも変わらない。
- MANIFEST の `SceneCreate` を「継承する」「継承しない」の 2 class に分け、各行の本文に対応する引数の定数が現れることを試験で固定する（今の `assert_body_contains(hit, &["ensure_scene_scope_binding_in_tx"])`、同 :979 の拡張）。新しい作成経路は class を選ばないと試験が落ちる。

### 4.3 復元の経路は「元の scope を保つ」か「既定を当てる」か

| 選択 | 中身 | 評価 |
| ---- | ---- | ---- |
| 今どおり `unknown`（**推奨**） | 復元した場面は未設定 | fail closed。l6-l9:873 と X1/1 の F19 に合う。作者は §7 の案内と 1 クリックで当てられる |
| 既定を当てる | 復元した場面を本筋にする | ゴミ箱に入れる前に回想・夢に設定していた場面が、黙って本筋に化ける。作者は「元に戻した」と思っているので気づきにくい。§8 の危険がもっとも強く出る |
| 元の scope を保つ | 削除時または snapshot の作成時に Native が binding の A1 を保存し、復元で新しい incarnation に写す | ゴミ箱の payload は renderer が作り（`trash_bin.rs:136`）、snapshot は Scope の表を捕えない（§3.6）。保つには保存範囲を広げる新しい契約が要る。l6-l9:301 は restore 由来のデータを untrusted とする。B とは別の draftRef と確認が要る |

## 5. 既存の場面

### 5.1 既に `unknown` の場面

| 選択 | 中身 | 評価 |
| ---- | ---- | ---- |
| そのまま | 作者が設定するまで IR／Graph は出ない | 安全だが、B の前に作った project では効果が出ない |
| **作者の操作で当てる（推奨）** | 場面の Scope 欄の「既定を当てる」、章（folder）の「この章の未設定の場面に既定を当てる」、project の「未設定の場面すべてに既定を当てる」。どれも既存の writer `narrative_scene_scope_update`（`scene_scope.rs:1241-1418`）を場面ごとにループで呼ぶ | 作者が押すので「明示設定」の意味が保たれる。新しい 1 transaction の一括 writer にしないので、X1/1 の writer の閉じた一覧を広げない（材料 §5 の案 A の補足）。部分的に適用されうる（途中の失敗、OCC の不一致）ので、何件に当て何件に当てられなかったかを画面に出す |
| migration で当てる | 既存の `unknown` を一斉に本筋にする | 作者が決めていないものを決めたことにする度合いが最大。既存の project には既定が無いので、当てる値も migration が決めることになる。採らない |

- 対象は `unknown` の場面だけにし、既に `explicit` の場面は触らない（作者の設定を上書きしない）。
- 当てると、その場面の A1 の設定の変更になり、その場面に anchor する型付き Revision と本文の宣言が失効する（§6）。`unknown` の場面の Revision は IR／Graph にもともと使われていない（推測）ので、失うものは小さいが、確認ダイアログで件数を示す。

### 5.2 既存の project の既定

- migration では入れない。入れると、それまで新しい場面が `unknown` で作られていた project で、作者が気づかないまま新しい場面が本筋になる（§8 の危険が、説明なしに始まる）。
- 作者が設定画面（§7.1）で既定を選ぶ。registry に本筋の語彙が無い既存の project では、registry の更新が要り、project の型付き Revision と宣言がすべて失効する（§6）。画面でそれを示す。

### 5.3 `legacy-absent` の場面

- そのまま残す（IR は出る、Graph は出ない。材料 §4）。
- 「既定を当てる」は `legacy-absent` から `explicit` への一方向の変更で、戻せない（`scene_scope.rs:1283-1289`）。章・project の一括の対象からは既定で外し、別のボタンと警告にする。
- 語彙の初期投入（§3.5.1）は既存の registry に効かないので、既存の project で材料 §4 の保存の罠は残る。Scope 欄で「registry が空のまま保存すると未解決の明示になり IR が出なくなる」ことを、保存の前に示す（§7.3）。

## 6. 失効

前提（確認済み）：binding の v1 の token は registry 全体を含む（`core scope:176-199`）。registry の writer は全 binding の version を進め token を計算し直す（`scene_scope.rs:1507-1529`）。X1/1 の投影は binding の値と世代を含み、registry の変更で全 anchor の型付き Revision が失効する（X1/1 draft :422-431）。K2/4 の宣言は registry の変更でも失効する（l6-l9:251）。feed の transaction は kind を問わず IR と Graph の Index を次の publish まで dirty にする（K2/4 の C17、`docs/plans/nir1-c-body-disclosure-proposal-4-draft.md:148`。X1/3 で本文だけの保存は Graph を外した、l6-l9:249）。

| 操作 | registry | 既存の binding | 型付き Revision・投影 | 本文の宣言 | Index | 対処 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| 新しい project の初期設定（β） | 作成時に語彙を入れる | 無い | 無い | 無い | feed なし（推測：`project_create` は Scope の feed を書かない） | 不要 |
| 語彙の初期投入（§3.5.1） | 作成時だけ | 無い（作成時） | 無い | 無い | 変わらない | 不要 |
| 既定を設定・変更する（ref は registry にある） | 変えない | 変えない | 失効しない | 失効しない | 変えない（既定の writer は narrative の feed を書かない。下の注） | 不要。試験で token の不変を固定 |
| 既定を設定するために registry に ref を足す | 進む | 全場面の世代が進む | project の全件が失効 | 全件が失効 | dirty | 画面で事前に警告。registry の更新は既存の writer で、作者の操作 |
| 新しい場面の作成（継承） | 変えない | 新しい行（新しい incarnation） | その場面の投影が新しく生まれる。ほかは変わらない | 新しい場面にはまだ無い | 作成の feed で今どおり | 不要（今と同じ） |
| 既存の `unknown` の場面に既定を当てる | 変えない | その場面の世代が進む | その場面に anchor するものだけ失効 | その場面の宣言が失効 | dirty | 確認ダイアログで件数。章・project の一括では合計 |
| 既定が使う ref を registry から消す | 拒否 | — | — | — | — | error を画面で説明し、先に既定を変えるよう促す |
| 復元・修復で `unknown` を書く | 今どおり | 今どおり | 今どおり | 今どおり | 今どおり | 変えない |

注：既定の writer が narrative の feed を書かない理由は、feed の transaction が kind を問わず IR と Graph の Index を dirty にするため（C17）。既定は Source を持たず、どの consumer の入力でもない。監査のために canonical の change event（`crate::change_events::AppendChangeEvent`。`scene_scope.rs:31` で import）を残すかは実装で決める（推測：残しても Index には効かない）。

## 7. UI

### 7.1 project の既定の設定画面

- 場所：設定 > プロジェクト（`src/features/settings/categories/ProjectCategory.tsx`）。ここには既に物語の読みの軸（`phaseResolutionMode`、:79-83）がある。
- 中身：見出し、説明、3 軸の選択（registry の語彙から。「既定なし」も選べる）、registry に無い値を選んだときの警告（全件の失効）、「未設定の場面に既定を当てる」ボタン（§5.1）。
- 作成ダイアログ（`src/features/project/CreateProjectDialog.tsx`）：チェックボックス「新しい場面を『本筋』で作る」を既定オン。
- 既定の無い project（既存の project と、β での `default-project`）を開いたとき、関連場面の欄か Scope 欄に一度だけ案内を出す。

文言の案：

| key の案 | 日本語 | English |
| ---- | ---- | ---- |
| `settings.project.sceneScopeDefault` | 新しい場面の Scope の既定 | Default scope for new scenes |
| `settings.project.sceneScopeDefaultHint` | 新しく作る場面は、この Scope で作られます。回想・夢・別の世界線・作中作の場面は、作ったあと場面ごとに変えてください。既定を変えても、既にある場面は変わりません。 | New scenes start with this scope. For flashbacks, dreams, other worldlines or stories within the story, change the scope of each scene after creating it. Changing the default does not change existing scenes. |
| `settings.project.sceneScopeDefaultNone` | 既定なし（新しい場面は未設定） | No default (new scenes start unset) |
| `settings.project.sceneScopeApplyUnset` | 未設定の場面に既定を当てる | Apply the default to unset scenes |
| `settings.project.sceneScopeRegistryWarning` | この値を使うには Scope の語彙に追加します。追加すると、このプロジェクトの承認済みの解釈と本文の宣言がすべて失効し、作り直しが必要になります。 | Using this value adds it to the scope vocabulary. This invalidates every approved interpretation and body declaration in this project; they must be recreated. |
| `project.create.sceneScopeMainLine` | 新しい場面を「本筋」で作る（あとで変えられます） | Create new scenes in the main line (you can change this later) |

### 7.2 語彙の表示名

ref は識別子のまま保存し、既知の ref だけ表示名に写す（ref を訳すと registry の値が言語で変わるので、訳さない）。

| ref | 日本語 | English |
| ---- | ---- | ---- |
| `timeline:main` | 本筋の時間 | Main timeline |
| `worldline:prime` | 本筋の世界線 | Main worldline |
| `layer:manuscript` | 本編 | Main narrative |
| （3 つの組） | 本筋 | Main line |

### 7.3 場面の Scope 欄の日本語化

- 今は `editor.sceneDetail.*` の key に英語の既定値を渡しているが、`ja.json` と `en.json` に key が無い（材料 §4。#783 の後も無い）。さらに `SceneScopeFields.tsx` の選択肢の `"Any"`、`"Unresolved"`（:42-43）と軸の名前（:110 の `axis === "narrativeLayer" ? "layer" : axis`）は文字列が直書きで、key すら無い。marker の表示（`SceneScopeEditor.tsx:321-324` の `draft.compatibilityMarker`）も生の値。
- 訳の案：Scope＝適用範囲（Scope）、Query＝この場面の位置、Material＝この場面を材料として見せる範囲、Any＝制約なし、Unresolved＝未解決、timeline＝時間軸、worldline＝世界線、layer＝語りの層、`explicit`＝設定済み、`unknown`＝未設定、`legacy-absent`＝以前からの場面（未設定）、Scope registry＝Scope の語彙、Holder＝知っている人、Audience＝読み手。
- query と material の連動：Scope 欄で query の軸を変えたら、material の同じ軸を同じ値に追随させる（「材料の範囲を別に決める」を開いたときだけ外す）。query と material が食い違ったまま保存するときは、保存の前に警告する。理由は §8.4 の 4。
- 既定と同じ値の場面には「本筋（プロジェクトの既定）」のバッジを出す。比較は query と material の両方で行う（既定の行と binding を比べて renderer で決める。保存はしない。推測：provenance の列を binding に足すと binding の形と token が変わるので、足さない）。
- `legacy-absent` で語彙が空のときの保存の前の警告（§5.3）。

### 7.4 IR が出ないときの案内（案 A の要素）

- 今の文言は `relatedScenes.irUnsupported`「この参照条件では承認済み解釈を検索できません。本文検索の結果を表示します。」（`src/locales/ja.json:4179`）で、`RelatedScenesSection.tsx:156-166` が `unsupported-query` のときに出す。
- wire の理由は閉じた union（`electron/shared/relatedScenesSearchWire.ts:86-93`）で、N-API は `supported_profile=false` を一律 `unsupported-query` にする（`electron/native/grimodex-node/src/related_scenes/begin.rs:115-119`）。理由を足すと閉じた一覧が変わり、契約の変更になる。
- 推奨：wire を変えず、関連場面の欄が既存の `narrative_scene_scope_read` で今の場面の marker を読み、文言を分ける。
  - `unknown`：「この場面の Scope が未設定のため、承認済みの解釈は出ません。［Scope を設定］［既定を当てる］」
  - `explicit` で軸に未解決がある：「この場面の Scope に未解決の軸があるため、承認済みの解釈は出ません。［Scope を開く］」
  - それ以外：今の文言（archived や読みの軸など、Scope 以外の原因がありうる。材料 §4）。
- 「本筋以外の Scope の場面」には、案内ではなく欄の注記として「この場面は本筋以外の Scope です。同じ Scope の場面の解釈だけが出ます。」を出す（推測：これは `unsupported-query` にならず、材料が絞られるだけ）。
- 案 A から含めるもの：案内の改善、1 クリックで既定を当てること、章・project の単位のループ。含めないもの：新しい 1 transaction の一括 writer（X1/1 の閉じた一覧を広げる）。

## 8. 開示の安全

### 8.1 危険

作者が回想・夢・別の世界線・作中作の場面の Scope を変え忘れると、その場面は本筋として作られる。その場面から承認した解釈（IR）や Entity／Relation（Graph）が、本筋の後ろの場面の参照に混ざる（材料 §2 の表）。たとえば夢の中の出来事が現実の出来事として関連場面に出る。

### 8.2 変わらない防御

- 読書順：材料は今の場面より前の場面に限る（l6-l9:877）。B は順位を変えない。
- 秘密：query の `allow_secrets: false`（`query_context.rs:197`）。B は秘密の扱いに触れない。
- 人の承認：IR／Graph の材料は承認済みの Revision だけ。AI が作った場面でも、承認しなければ材料にならない。
- material 制約を exact にする（§2.2 の 1）。今の `unknown` の既定の material は any（`scene_scope.rs:113-119`）。query だけ exact にして material を any のまま継承すると、作者が後で回想の場面の query だけを変えた場合でも、その場面の材料がどの query にも見える（材料 §5 の B の行）。material も exact にすれば、作者が Scope 欄で両方を変えたとき、本筋の場面には出ない。CP-4 の setup も query と material を同じ値にしている（`setup-driver.mjs:390-412`）ので、測った条件と一致する。

つまり B で増えるのは「過去の場面の間で、層や世界線が混ざる」危険で、未来の情報や秘密が出る危険は増えない（材料 §2 の結論と同じ）。

### 8.3 脅威モデルへの影響

| 面 | 評価 |
| ---- | ---- |
| 新しい IPC（既定の read と write）と `project_create` の新しい field | renderer は既に `narrative_scene_scope_update` で任意の場面に任意の explicit な Scope（material の any を含む）を書ける（`SceneScopeEditor.tsx:211-229`、`scene_scope.rs:1241-1418`）。既定の write は、それより弱い（未来の作成にだけ効き、exact に限る）。新しい権限は増えない（推測ではなく、既存の writer の検証の範囲からの読み） |
| model output（AI の木構造計画） | 計画は場面を作れるが Scope を指定できない（`apply_ai_tree_plan` の INSERT の列、`domain_writes.rs:5599-5611`）。継承される Scope は作者が決めた既定。材料になるには人の承認が要る |
| cross-project、偽造の ref、stale な既定 | 作成の writer が同じ snapshot で project と registry の所属を検証し、外れれば `unknown`（§3.3） |
| dangling な既定から any への fallback | 起きない。`unknown` に落とす（§2.2 の 5） |
| 復元の経路での黙った継承 | 作成の種類の引数と MANIFEST の class で固定する（§4.2） |
| 送信先 | 新しい送信先は無い。既存の規則の下で IR の材料になる場面の数が増えるだけ（作者が手で設定した場合と同じ）。IR が外部の AI への要求にどこまで入るかは、この調査では追っていない（§10.4） |
| 保存範囲 | 新しい表で広がる。AGENTS の委任の外なので確認が要る |

### 8.4 軽減

1. 作成直後の表示：Scope 欄のバッジ「本筋（プロジェクトの既定）」（§7.3）。ツリーの場面行に、既定と違う Scope の印を出す案もある（推測：既定と同じ場面が大多数なので、違うほうに印を付けたほうが目立つ）。
2. 章単位の切替：章（folder）のメニューに「この章の場面の Scope を…にする」（既存の writer のループ。§5.1 と同じ部分適用の表示）。
3. 設定画面と作成ダイアログの説明文に「回想・夢・別の世界線・作中作は場面ごとに変える」ことを書く（§7.1）。
4. 作者が直した後も残る混入への対処：B の既定は query も material も exact（本筋）。作者が回想の場面の **query だけ** を回想に変え、material を本筋のまま残すと、Graph は query の一致を求めるので弾く（`nir1_graph/scenes.rs:814-833`）が、IR の材料側は material 制約だけを見る（`scene_scope.rs:1957-1977`。exact の本筋は本筋の query の `Resolved` に一致する）ので、回想から承認した IR が本筋の query に出続ける。§7.3 の連動（query を変えたら material を追随）と、食い違いの保存前の警告で防ぐ。
5. 将来の選択肢（B の外。別の draftRef が要る）：章（folder）ごとの既定、直前の兄弟の場面の Scope を受け継ぐ作成。どちらも回想の章の中で新しい場面を作るときの誤りを減らすが、保存の追加（folder の既定）か、継承の規則の追加（兄弟）になる。

## 9. 評価と公開への影響

| 対象 | 影響 | 再測定 |
| ---- | ---- | ---- |
| CP-4（Gold） | Gold は全場面を `explicit` にした状態だけで測った（DR-CP4-J-2、`cp4-decisions.md:680`）。値は `timeline:main`／`worldline:prime`／`layer:manuscript`、holder と audience は reader、query と material は同じ（`setup-driver.mjs:390-412`）。B の既定はこれと同じ形なので、製品の既定が測った条件に近づく。β なら凍結 setup は `project_create` に field を渡さず、初期状態は今と同じで、その後の明示の書込みで同じ状態に着く | β では不要と読む（推測）。α では harness が止まるので、harness の変更と再凍結が要る（§3.5.2）。B の code が CP-4 の候補の commit に入るかで、凍結の規則上の扱いが変わりうる（未確認。§10.3 の Q12） |
| G-04（Scope exact／unknown） | fixture（`evals/nir1-graph/g04-scope-exact-unknown.v2.json`）は Scope を明示で書く。Gold と期待値は変わらない（推測） | 不要（推測） |
| PUB-G の開示 | 材料 §5 は「新しい project では、作者が scope を設定するまで IR と Graph が出ない」を開示に入れるとした。B の後の案：「作成ダイアログで作った新しい project では、場面は本筋の Scope で作られ、本筋の場面どうしで IR と Graph が出る。回想・夢・別の世界線・作中作の場面は、作者が Scope を変える必要がある。変え忘れると本筋の参照に混ざる。既存の project、復元した場面、B より前に作った場面は未設定のままで、設定するまで出ない」 | — |
| K2/4（本文の宣言） | 規則は変えない。既定を受け継いだ場面も宣言できる。registry の変更で宣言が失効する規則（l6-l9:251）はそのまま | 不要 |
| X1/1・X1/3 | 失効の規則と投影の定義は変えない。継承で作った binding は作成時の新しい incarnation として扱われる | 不要 |
| DP-H（拒否の試験） | harness は `project_create` に field を渡さない（`harness/run.rs:211-221`）。β なら初期状態は今と同じ。負例の `scene-scope-unknown`（`harness/workspace.rs:557-567`）は製品の writer で `explicit` から `unknown` を書く経路で、B の後も成り立つ（`scene_scope.rs:1283-1289` は `legacy-absent` への戻しだけを拒否）。`excludedNegatives` の「unknown Scope は登録簿にない参照を受けない」（`evals/nir1-packing/final-request.README.md:57`）も変わらない | β では不要（推測）。α では harness の registry の置換が止まる（§3.5.2） |
| L0 | setup は workspace の最初の project を使う（`setup-nir1-retrieval.mjs:240-290` 付近）。β では既定が入らず、語彙だけなら挙動は今と同じ。γ では場面が本筋になり、R+IR の観測が変わりうる | β では不要。γ を選ぶなら要否の判断が要る |
| 製品の journey 試験（`electron/scripts/nir1-scene-scope-projection-product-journey.mjs` など）と e2e | 作成ダイアログを通る試験は既定オンの影響を受ける（推測） | 実装時に grep して直す |

## 10. 段取り、試験、確認点、確かめられなかったこと

### 10.1 PR の分け方（ユーザーの確認の後）

| PR | 中身 | 依存 |
| ---- | ---- | ---- |
| B-0（docs） | draftRef の本文（§2 を契約の文面に）、独立レビュー、確認の記録、台帳の行の追加 | ユーザーの確認 |
| B-1（Rust） | SCHEMA 44 の表、既定の reader と writer（OCC、冪等、型の検証、registry の所属の検証）、registry の writer の拒否、`ensure_scene_scope_binding_in_tx` の作成の種類の引数と 3 経路の継承、語彙の初期投入、MANIFEST の class の分割、protected-writers と generic SQL の拒否一覧 | B-0 |
| B-2（N-API・IPC） | 既定の read／write の command（`ipcContract.ts` に正本と main での再検証、`profileEgress.ts` の分類、`src/lib/` の wrapper）。`project_create` の optional field（β） | B-1 |
| B-3（renderer） | 設定画面、作成ダイアログ、Scope 欄の i18n とバッジ、「既定を当てる」（場面・章・project のループ）、関連場面の案内 | B-2 |
| B-4（docs） | PUB-G の開示文の改訂、decisions の記録 | B-3 |

AGENTS の skill の対応：B-1〜B-3 は `refactor-cross-boundaries`（Rust・N-API・IPC・renderer の 2 層以上）を主にし、新しい command は `add-electron-command` を補助に使う。

### 10.2 試験の方針

- Rust：3 つの継承経路で既定があれば `explicit`、無い・dangling・別 project なら `unknown`。継承しない 5 経路では既定があっても `unknown`（`legacy-absent`）。既定の書込みの前後で、全 binding の bytes、registry の行、project の Scope authority の token が同じ。registry から既定の ref を消す更新は拒否。既定の OCC の不一致と冪等の再送。cold reopen の後も同じ。SCHEMA 43 から 44 への migration で既存の project に行が無いこと。
- MANIFEST：作成の種類の class を分け、未分類の新しい作成経路を落とす。
- 開示：既定のある project で、本筋の場面どうしの IR と Graph の正例。query だけ回想に変えた場面（material は本筋のまま）と、両方を変えた場面の材料の可否。読書順と秘密の既存の負例が変わらないこと。
- renderer：作成ダイアログの field の有無、設定画面の警告、ループの部分適用の表示、案内の分岐。レイアウトに触れる場合は CLAUDE.md のとおり `pnpm test:browser`。
- 評価：β で、CP-4 の凍結 setup と DP-H の harness が今の初期状態（registry は語彙あり・場面は `unknown`）から最後まで通ることを、実装後に確かめる（語彙の初期投入の影響の確認を含む）。

### 10.3 ユーザーの確認が要る点

| # | 点 | 推奨 | 理由 |
| ---- | ---- | ---- | ---- |
| Q1 | `nir1-scene-scope-default-proposal/1#scope-storage-authority` の確認 | 独立レビューの後に確認 | 新しい保存先と契約の改訂は委任の外 |
| Q2 | 既定の初期設定：α／β／γ | β | harness と L0 を変えず、ユーザー決定と両立する。γ は L0 の影響を確かめてから |
| Q3 | 語彙の初期投入（registry の初回 INSERT に本筋の語彙） | 入れる | 挙動を変えずに、bootstrap の project の 1 クリックを失効なしにし、保存の罠を減らす |
| Q4 | material の既定を query と同じ exact にする | する | any のままだと誤った場面の材料が全 query に見える。CP-4 の測定条件と同じ |
| Q5 | 復元（ゴミ箱・snapshot）は `unknown` のまま | `unknown` | 既定を当てると回想が黙って本筋に化ける。元を保つのは別の契約 |
| Q6 | 既存の `unknown` の場面 | 作者の操作（場面・章・project のループ）。migration しない | 作者が決めたことにする。新しい一括 writer を作らない |
| Q7 | 既存の project の既定 | migration で入れない。設定画面と一度だけの案内 | 新しい場面が黙って本筋になるのを避ける |
| Q8 | 製品同梱サンプル | v1 では継承させない | サンプルの内容（回想・作中作の有無）を確かめていない |
| Q9 | AI の木構造計画と付箋の昇格も継承するか | 継承する | 新しい場面で、作者の既定と同じ扱いが自然。材料には人の承認が要る |
| Q10 | holder と audience を reader に固定（v1） | 固定 | 人物の既定は削除の拒否を広げる必要がある |
| Q11 | PUB-G の開示文の改訂（§9） | 改訂する | 新しい既定と、変え忘れの危険を開示する |
| Q12 | CP-4 の取り直しと B の merge の順 | CP-4 の取り直しの候補には B を含めない | 測る候補を動かさない。β なら setup は同じだが、凍結の規則の扱いを確かめていない |
| Q13 | 原稿の取り込みで作る project にも既定を入れるか | 取り込みの画面に同じチェックを出し、作者が選ぶ | 黙って入れると、取り込んだ回想の章まで本筋になる。入れないと取り込みの project で効果が出ない |
| Q14 | Scope 欄で query を変えたら material を追随させる | 追随させる（別に決めたいときだけ外す） | query だけ直すと、IR では回想の材料が本筋に出続ける（§8.4 の 4） |

### 10.4 確かめられなかったこと

- 作成ダイアログ以外で `tree_node_create` を呼ぶ経路（取り込み、外部 mount の同期、MCP）が、全て `tree_node_create_with_authority` を通るか。MANIFEST の走査（`src-tauri/crates/*/src`）は Rust の writer を閉じるが、renderer 側の呼出し元は列挙していない。
- `api.createProject`（harness）と `createNewProject`（UI）の差を、実機で確かめていない。β の field が harness に渡らないことは code の読みだけ。
- CP-4 の凍結 setup と DP-H の受領書が、置換前の registry の中身を記録・照合するか（語彙の初期投入の影響）。`frozen-setup-driver.mjs:518-546` は version を読む。中身の照合は :1975-1977 の置換後だけを見たが、全文は読んでいない。
- L0 の workspace の作り方（新しい workspace か、fixture の DB の複製か）と、L0 が IR を使うか。γ の影響の判断に要る。
- snapshot の本文 restore で、全ての場面の binding が作り直されるのか、置換された場面だけか（試験 `project_snapshots.rs:3707-3765` は 1 場面だけを見る）。
- IR の材料が外部の AI への要求（Packing）にどこまで入るか。B は既存の規則の下で材料になる場面を増やすので、送信の量が増えうる。
- サンプル（`src-tauri/resources/sample_project/`）の場面に回想・作中作があるか。
- 既定の writer が canonical の change event を出すべきか（監査、timelapse、同期）。
- 材料 §6 の未確認点（Raw が Scope で絞られるか、legacy-absent の query の開示の細部、既存 project の件数、registry が空のまま保存したときの画面）は、この設計でも確かめていない。
- 行番号は `f36dd696` の版のもの。
