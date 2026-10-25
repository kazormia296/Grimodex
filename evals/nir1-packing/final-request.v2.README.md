# 最終 request 評価の fixture 版2（DP-H の置換版。S1）

版2 は、freeze の前に Native に観測されて失効した版1（`final-request.v1.json`、DR-DPH-70）を置き換える DP-H の fixture である。版1 の file と README（`final-request.README.md`）は HOLD の履歴として変えずに残し、この README は版2 だけを説明する。K6/3（`nir1-final-request-eval-proposal/3`、2026-10-25 にユーザーが確認）の「変える点」14 により、置換版を版2、DD-1 が足す版を版3 と読む。版2 の記録が名乗る draftRef は `nir1-final-request-eval-proposal/2` のまま（K6/3 の「引き継ぐもの」2）。判断の記録は `docs/plans/nir1-lane-decisions/dp-h-decisions.md` の DR-DPH-90 以降。

## 置いたもの

| file                                                               | 内容                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `final-request.v2.json`                                            | 版2 の fixture（9 case、23 variant、29 request。材料、setup の手順、期待値、除外した負例）                                                        |
| `final-request.v2.README.md`                                       | この README（材料、導出、予算の式、固定の手順）                                                                                                   |
| `final-request.expectation-review.v2.json`                         | 独立期待値 review の記録の雛形（`verdict: changes-required`、`status: not-reviewed`、全 case `pending`）。中身は S2 の reviewer が書く            |
| `final-request.freeze.v2.json`                                     | freeze 記録（`status: pending-review`、`nativeOutputObservedBeforeFreeze: false`、`supersedes` で版1 を引く）。frozen にするのは S3 の integrator |
| `scripts/quality/nir1-packing/final-request/fixture-derive.v2.mjs` | 期待値を fixture の材料から導く純粋な関数（X1-3 の後の規則。コードの出典つき）                                                                    |
| `scripts/quality/nir1-packing/final-request/fixture.v2.test.mjs`   | 版2 の整合試験（期待値が導出と一致すること、材料の再利用がないこと、記録の束縛）                                                                  |

parity ベクトルは版1 と同じ `final-request-baseline-parity.v1.json` を束縛する（fixture の材料に依存しない。DR-DPH-77）。

## 事前登録の原則

- 期待値は、X1-3 の後の製品のコード（base は origin/master `352474d4`）を読んで、Native を一度も動かさずに導いた。cargo、Electron、harness の試験は走らせていない。
- 作者は `dph-v2-fixture-author (claude-opus-5-5, independent)` で、版1 の作者（`dph-2-fixture-author …`）とも、版1 の harness 実装者 4 名とも、S0 の実装者（`dph-s0-builder (versioned contract and gate)`）とも別である。作者は版1 の receipt、DPH-4 の観測の結果、case ごとの判定、`hold.json`、`.artifacts/` を見ていない（見たもの、見なかったものは DR-DPH-90）。
- 材料（logical ID と text）は全部新しい。版1 の論理 ID と一致する ID、版1 の材料 text と一方が他方を含む text を使っていない（`replacedMaterialReuseErrors`。1 文字の Codex 名など短い材料も含む）。同じ種類の材料も作り直した（Scope の登録簿の ref、canary、chat session の題名を含む）。
- 期待値を観測に合わせて直さない。直す必要が出たら、観測の前に限り、fixture を直して review をやり直す。

## case と variant

構成は K6/2 の DP-H の表と D1 の各 task の class を引き継ぐ（版1 と同じ数と種類。DR-DPH-92）。各 case は anchor Scene 1 つと query Scene 1 つを持ち、Revision は Codex Entity 1 件だけを持つ型付き Revision（atomic group 1 つ）である。

| case | task                            | 正例の Revision                                   | 拒否 variant（負例と作り方）                                                                                                                                |
| ---- | ------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-01 | 文体・voice の Raw＋IR          | 吹き師（character）、工房の語り（lore）           | —                                                                                                                                                           |
| P-02 | 文体・語彙の Scope consistency  | 塩田（location）、鐘番の決まり（lore）            | scope-authority-changed（登録簿に ref を足す）、source-stale（負例の Codex の summary を更新）、unknown-scope（負例専用 anchor の Scope を unknown にする） |
| P-04 | 台詞の attribution／Evidence    | 星図係（character）、台長（character）            | —（除外 2 件）                                                                                                                                              |
| P-05 | 描写の Scope filtering          | 蜂場（location）、面布（item）                    | unknown-scope（負例専用 anchor の Scope を unknown にする）                                                                                                 |
| P-06 | 描写の isolation                | 製本所（location）、麻糸（item）                  | source-stale、approval-cancelled（承認の取消）                                                                                                              |
| P-07 | exact quote／anchor             | 銘板（item）、時計塔（location）                  | —                                                                                                                                                           |
| P-08 | exact quote の Source／approval | 運行規程（lore）、信号所（location）              | approval-cancelled、scope-authority-changed（除外 1 件）                                                                                                    |
| P-10 | 長距離関係・再評価              | 閘門（location）を stage ごとに準備               | binding（scope／source／decision）ごとに正例と、stage 2 に旧 Revision を足す拒否                                                                            |
| P-11 | 構造・required slots            | 祭り（lore）、世話役（character）、橋（location） | scope-authority-changed（除外 1 件）                                                                                                                        |

拒否 variant の last request は、正例の Revision ID の列の後ろに負例を 1 件だけ足す。P-10 の reject は stage 2 で `[新, 旧]` の順に渡す。

### 拒否 variant の code と reason（観測の前に導いた）

code は常に `NIR1_NATIVE_A2_UNAVAILABLE`（caller が列を渡す D-final は `RevisionUnavailablePolicy::Reject`。`nir1_packing.rs:1759-1760`、3752-3755）。reason は失効させる書込みで決まる（`fixture-derive.v2.mjs` の `REASON_BY_WRITE`）。

| 書込み                                                                                                                                          | reason                        | 根拠（`src-tauri/crates/grimodex-db/src/narrative_extraction/`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| decision-cancel（単一の人間の `rejected`）                                                                                                      | `revision-not-human-approved` | 追記の規則 `repository.rs:5742-5743`、status の更新 5675-5681 と 5995、reader `nir1_entity_relation.rs:2450-2452`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| codex-update（負例の Codex の summary）                                                                                                         | `source-revision-changed`     | `validate_live_sources` の source token 4008-4013、reader 2642-2646                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| scene-scope-registry-update（登録簿に ref を追加）                                                                                              | `source-revision-changed`     | 全 binding の version が進み投影の `scopeGeneration` が動く（`scene_scope_projection.rs:90`、230。試験 `x13_registry_ref_addition_invalidates_every_revision`）、`validate_scope_binding` 4102-4113、reader 2642-2646。A3 の `a3-scope-authority-stale`（2895-2902）は A2 の後の二重の防御で届かない                                                                                                                                                                                                                                                                                                                                                                                                |
| scene-scope-unknown（負例専用 anchor の Scene Scope を `compatibilityMarker: unknown`、query identity の 3 軸を unresolved に書く。DR-DPH-106） | `source-revision-changed`     | writer は legacy-absent への戻りだけを拒み（`scene_scope.rs:1283-1289`）、version を 1 進める（1312-1315）。core の `validate_binding` は 3 軸 unresolved の unknown を受け（`grimodex-core/src/narrative_scene_scope.rs:165-172`）、`read_scope_extension` は検証済みの binding として authority に含める（`scene_scope.rs:832-863`）。投影は marker、query identity、`scopeGeneration` を持つ（`scene_scope_projection.rs:82-94`、225-236）ので token が動き、`validate_scope_binding` の `NIR1_SCOPE_AUTHORITY_STALE`（4107-4113）が reader で `source-revision-changed`（2642-2646）。A3 は A2 が available のときだけ走る（2785-2803）ので、A3 の reason（読み順、material scope）には届かない |

負例は正例の最初の準備より前に準備・承認・失効させる。正例はその後に準備するので、登録簿の更新は正例の投影を動かさない。 unknown-scope の負例は、その拒否 variant だけが持つ負例専用 anchor Scene（`setup.scenes`、`role: negative-anchor`）に準備し、unknown はその Scene にだけ書く。正例の anchor と query の Scope は変わらない。正例の forbidden には、case の anchor に準備される負例だけを並べ、負例専用 anchor の負例は並べない（正例の期待値は版2 の review が承認した形のまま。DR-DPH-108）。

### 除外した負例（`excludedNegatives`）

6 件（P-04 の別 Revision の approval と Evidence 欠落、P-08 の Freshness 未評価、P-11 の Freshness 不一致、P-10 の revision と freshness の binding）。理由は X1-3 の後のコードで書き直した（DR-DPH-93）。どれも DD-1 の混在 variant に回る。P-02／P-05 の unknown-scope は、最初は除外したが、S2 の指摘と S0c の schema（DR-DPH-99〜106）で拒否 variant にした（DR-DPH-107）。

## 期待値の導出（`fixture-derive.v2.mjs`）

5 部分（statement、negation、attribution、evidence、qualification）の形は `group_parts`／`accepted_ir_group`（`nir1_packing.rs:3369-3419`）と `adapt_typed_revision_candidates`（3499-3531）、`closed_marker`、`qualification_text` に従う。X1-3 の後に変わったのは Entity の `scope.authorityRevision` で、project の Scope authority revision ではなく、**anchor Scene の Scene Scope 投影の token** である（`build_live_typed_bundle`、`nir1_entity_relation.rs:4319-4337`。値は `SceneScopeProjectionV1` の canonical JSON の `sha256:<hex>`）。そのほか（Entity の形、Evidence は Codex の summary 全体、material の Evidence の行、qualification の actor と `authorityScope`、payload の entry の順）は X1-3 の前と同じであることを、出典の箇所を読んで確かめた（DR-DPH-91）。

### placeholder（harness が setup receipt に書く値）

| placeholder                                                    | 値                                                  | 読み方                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `{{runtimeId:<case>-project}}`、`…-scene-anchor`、`…-entity-*` | project、Scene、Codex Entity の ID                  | id map                                                                                                           |
| `{{revisionId:…}}`、`{{proposalId:…}}`、`{{decisionId:…}}`     | Revision、proposal、Decision の ID                  | id map（prepare と approve の event）                                                                            |
| `{{revisionToken:<case>-anchor-projection}}`                   | anchor Scene の Scene Scope 投影の token（71 文字） | stage の Revision の Entity の Scope binding が持つ値（`runtimeValues`。stage の最後の書込みの後、capture の前） |
| `{{sourceToken:<case>-entity-*}}`                              | Codex の source token `codex:<id>@<updated_at>`     | live の Codex 行（`runtimeValues`）                                                                              |

`runtimeValues` は正例の期待値（entry と、後の stage の forbidden）が名指す stage にだけ置く。拒否の request は template を持たない。

### P-10 の stage 2

stage 2 は binding を変えた後に新しく準備・承認した Revision だけを渡し、stage 1 の Revision ID と entry ID、新しい stage の材料にない旧 entry の text（前の stage の値で解決する）を forbidden にする。scope と decision の binding では旧と新の statement と evidence の template が同じ文字列になるので、forbidden の text は旧 qualification だけになる（scope では投影の token が stage で変わるが、同じ template を forbidden に置くと期待の entry と重なるので置けない）。source の binding では summary が変わるので、旧 statement、旧 evidence、旧 qualification を forbidden にする。

## context 予算の式（freeze 記録にも同じ式を書く）

`contextBudgetTokens = contextWindowTokens - (fixedSystemTokens + userTokens + envelopeTokens + outputTokens + safetyMarginTokens + separatorReserveTokens)`。route は `dph-fixture-local-model`、window 16384、output 1024（既存の D-final の試験の route で、製品の上限ではない）。fixedSystemTokens 531、envelope 10、safety margin 32、separator 171（`nir1_prepared_request.rs:1679-1699`、`payload.mjs` の `contextBudgetTokens`）。case ごとの予算は 14,573〜14,589 token（userTokens は 27〜43）。各正例 request の selectedTokens（Raw と全 entry。placeholder は上限の ASCII 長で数える）は 1,014〜2,916 で、余裕は 11,668 token 以上。request ごとの値は freeze 記録の `contextBudget.perRequest` にある。

## 固定の手順（独立期待値 review の後）

1. S2 の独立期待値 reviewer（作者でも、版1 の作者と実装者でも、S0 の実装者でもない者。read-only。Native の出力を見ない）が、fixture を製品のコードと draft に照らして review し、`final-request.expectation-review.v2.json` に verdict、`requiredChanges`、`cases[]`、`fixtureSha256`（review した bytes）を書く。確かめる点は、DR-DPH-91〜93 の出典と、この README の導出表、予算、P-10 の forbidden。
2. `changes-required` なら作者が fixture を直す（Native の出力は使わない）。直したら review をやり直す。
3. `approve` になったら、S3 の integrator が freeze 記録を確定にする（`status: frozen`、`reviewVerdict: approve`、`frozenAt`、review 記録の sha256 の更新、reviewer の名前）。その commit は、この fixture の材料で Native を実行するどの run の commit よりも前（祖先）に置く。S4 の前に Rust の gate（`harness/freeze.rs`）を版2 の path に合わせる（S0b、DR-DPH-81）。
4. 確定の後に fixture、README、review 記録、scorer、parity ベクトルを変えたら、版2 は失効する（新しい版を作る）。
