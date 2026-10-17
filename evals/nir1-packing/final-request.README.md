# 最終 request 評価の fixture 版1（DP-H／DPH-2）

`nir1-final-request-packing-eval`（K6/2。2026-10-17 Session B1 で確認済み。`docs/plans/nir1-final-request-eval-proposal-2-draft.md`）のうち、DP-H が測る 9 case（P-01、P-02、P-04、P-05、P-06、P-07、P-08、P-10、P-11）の正例 variant と拒否 variant、観測前に固定した期待値、固定（freeze）の記録をまとめる。D1 の `fixtures.json`（合成 token、64 token の予算）とは別で、DP-1 の証跡でも P-12 の証跡でもない。

## 置いたもの

| file                                       | 内容                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `final-request.v1.json`                    | fixture 本体（版1）。case ごとの材料（`setup`）、正例・拒否 variant、期待値（`expected`）、除外した負例（`excludedNegatives`）、harness 向けの手順（`setupContract`、variant の `setup.steps`）。 |
| `final-request.freeze.v1.json`             | 固定の記録。fixture、README、parity ベクトル、scorer の 4 module、独立期待値 review の sha256 と、context 予算の式・各 request の余裕を持つ。                                                     |
| `final-request.expectation-review.v1.json` | 独立期待値 reviewer の記録。reviewer が approve するまで `verdict` は `changes-required` のままで、freeze は `pending-review` のまま確定にしない。                                                |
| `final-request.README.md`                  | この文書。                                                                                                                                                                                        |

契約（欄の形と検査）は `scripts/quality/nir1-packing/final-request/contract.mjs`、採点は同 `scorer.mjs`。期待値の導出規則は `scripts/quality/nir1-packing/final-request/fixture-derive.mjs`（Native を動かさない純関数。fixture の整合は同 `fixture.test.mjs` が固定する）。

## 事前登録の原則

- 期待値は、estimator（`estimate_nir1_context_tokens` と TS の `estimateTokens`）、A2／A3（`evaluate_nir1_entity_relation_disclosure`）、D-final（`prepare_local_chat_request_inner`、`read_and_pack_native_a2_context_in_tx_with_raw_charge`）、renderer（`render_plain_chat_payload_from_material`）の規則と draft から導く。Native の packer、renderer、D-final を実行していない。Native の receipt、payload、capture を見ていない（`nativeOutputObservedBeforeFreeze=false`、`authorSeparation.nativeReceiptProvidedToAuthor=false`）。
- 観測と期待が食い違っても期待値を観測に合わせて直さない。FAIL か HOLD として記録し、fixture の改版が要るなら新しい版（観測した材料を使わない）を作り、独立 review をやり直す。
- fixture の author は harness、baseline、capture の実装者と別にする。reviewer は author とも実装者とも別で、read-only。
- P-12 の harness 確認用の診断 case（`diagnosticCases`）は置かない（任意の項目で、置くと P-12 の材料の設計が先に固定される）。DPH-3／DPH-4 が必要と判断したら、freeze の前に限って別の材料で足す。

## case と variant

正例 variant は Raw（Scene 本文）と承認済み IR だけで、history 枠は N/A（入力 0 件）、Graph は使わない。IR は「Codex Entity 1 件だけの typed Revision」で、Revision 1 件が atomic group 1 件（statement、negation、attribution、evidence、qualification の 5 entry）になる。canary は承認の注記（`decisionJson.note`）と内部 metadata（`proposalKey`）に埋め、payload に現れてはならない。

| case | task                            | 正例 variant                                                                    | 拒否 variant（ineligible な 1 件を足す）                                                     |
| ---- | ------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P-01 | 文体・voice の Raw＋IR          | `p01-positive`（IR 2 件）                                                       | なし（draft の表は「他 case の材料と Raw 欠落は出力の検査」）                                |
| P-02 | 文体・語彙の Scope consistency  | `p02-positive`（IR 2 件）                                                       | `scope-authority-changed`、`source-stale`。unknown Scope は除外                              |
| P-04 | 台詞・attribution／Evidence     | `p04-positive`（IR 2 件）                                                       | なし。別 Revision の approval と Evidence 欠落は除外                                         |
| P-05 | 描写・Scope filtering           | `p05-positive`（IR 2 件）                                                       | なし。unknown Scope は除外                                                                   |
| P-06 | 描写・isolation                 | `p06-positive`（IR 2 件）                                                       | `source-stale`、`approval-cancelled`                                                         |
| P-07 | exact quote／anchor             | `p07-positive`（IR 2 件。Evidence の quote 中の引用を exact quote に含む）      | なし（draft の表は拒否 variant なし）                                                        |
| P-08 | exact quote の Source／approval | `p08-positive`（IR 2 件）                                                       | `approval-cancelled`、`scope-authority-changed`。Freshness 未評価は除外                      |
| P-10 | 長距離関係・再評価              | `p10-positive-scope`、`p10-positive-source`、`p10-positive-decision`（各 2 段） | 各 binding の `old-revision-after-<binding>-change`。revision と freshness の binding は除外 |
| P-11 | 構造・required slots            | `p11-positive`（IR 3 件）                                                       | `scope-authority-changed`。Freshness 不一致は除外                                            |

variant ごとに別 workspace（namespace は `isolation.workspaceId` に `/<variantId>` を付ける）。

### 拒否 variant の code と reason の導出（観測の前）

拒否 variant は正例の Revision ID の列の末尾に ineligible な 1 件を足す。D-final は ID の列を先頭から順に A2／A3 にかけ、最初の不適格で `anyhow::bail!("NIR1_NATIVE_A2_UNAVAILABLE:{reason}")` する（`nir1_packing.rs` の `read_and_pack_native_a2_context_in_tx_with_raw_charge`）ので、足した 1 件の reason だけが出る。reason は A2 の入口 `read_typed_revision_core_with_scope_authority`（`nir1_entity_relation.rs`）が上から順に返す値で決まる。

| 負例（negative）          | 承認の後に行う書込み（`invalidate-negative`／`binding-change`）                                                                                                                                                              | 最初に落ちる gate                                                                                                                      | reason                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `approval-cancelled`      | 承認済みの Revision の唯一の Decision `approved` に、`decision: rejected` を 1 件足す（`ensure_nir1_entity_relation_decision_is_appendable` が許す「単一の人間による取消」）                                                 | proposal の status が `approved` でない                                                                                                | `revision-not-human-approved` |
| `source-stale`            | その Revision の Codex Entity の summary を `codex_update` で変える（`updated_at` が変わる）                                                                                                                                 | `validate_live_sources` が Entity の source token（`codex:<id>@<updated_at>`）の不一致で失敗し、A2 が全部の失敗を 1 つの reason に写す | `source-revision-changed`     |
| `scope-authority-changed` | Scope の登録簿に timeline の参照 `timeline:alt` を足す（`narrative_scene_scope_registry_update`。どの Scene の Scope も変えない）。project の Scope authority revision（tree と Scene Scope の extension の digest）が変わる | `validate_live_sources` → `validate_scope_binding` が `authorityRevision` の不一致で失敗                                               | `source-revision-changed`     |

code は常に `NIR1_NATIVE_A2_UNAVAILABLE`。A3 の gate（`a3-material-scope-mismatch` など）は A2 の後なので、承認の後に Scope authority が動く負例では A2 が先に返す。このため `scope-authority-changed` と `source-stale` は同じ reason になるが、どちらも同じ規則から一意に導ける。

P-10 の拒否 variant は、変更の後に request 2 へ旧 Revision の ID を新 Revision の ID の後に足す。旧 Revision の reason は、変更が `scope`（登録簿への追加）なら `source-revision-changed`、`source`（Entity の summary の更新）なら `source-revision-changed`、`decision`（旧 Revision の承認の取消）なら `revision-not-human-approved`。

### 除外した負例（`excludedNegatives`）

draft は「reason を規則から一意に導けない負例は拒否 variant にせず、DD-1 の混在 variant だけで測る」と定める。除外は fixture の `excludedNegatives` に理由つきで書いてある（unknown Scope は Scene Scope の writer が登録簿にない参照を受けない、別 Revision の approval と Evidence 欠落は製品の writer で作れない、Freshness は Source／Scope の gate が先に落ちるため Freshness だけの状態に到達できない、P-10 の revision と freshness の binding は製品の writer が単独で変えられない）。

## 期待値の導出（`fixture-derive.mjs`）

1 つの Revision の entry（`expected.codexEntries`）は、製品のコードの規則を手で当てて書いた template で、runtime の値だけを `{{<kind>:<logicalId>}}` にしている。

| 部分                  | 規則（出典）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| statement             | `{"entity":{...},"family":"nir1.entity-relation@1","kind":"entity","materialEvidence":[...]}`（キーは UTF-16 順、`canonical_json_string`）。Entity は `build_live_typed_bundle` の形：`entityType`＝Codex の type、`label`＝name、Evidence は summary 全体（`startUtf16=0`、`endUtf16`＝UTF-16 長）、`scope` は `reading=exact scene:<anchor Scene>`、`story=any(nir1-entity-relation-review)`、`auto=notApplicable(typed-review-input)`、`phase=draft`、`reveal=reader`、`pov=null`、`authorityRevision`＝project の Scope authority revision。 |
| negation／attribution | `{"atomicPart":"<part>","family":"nir1.entity-relation@1","status":"not-represented-by-this-family"}`（`closed_marker`）                                                                                                                                                                                                                                                                                                                                                                                                                         |
| evidence              | `{"entityId":...,"family":...,"kind":"entity-evidence","materialEvidence":[...]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| materialEvidence の行 | `evidenceRef=nir1:evidence:codex:<Entity ID>`、`documentRef=sourceKey=codex:<Entity ID>`、`quote`＝summary、`quoteDigest=sha256:<quote の UTF-8 の sha256>`、`revisionToken`＝Entity の source token（`build_typed_material_basis`）                                                                                                                                                                                                                                                                                                             |
| qualification         | `{"actorId":"electron:human-review","actorKind":"human","approval":"human-approved","authorityScope":"project/<project>/proposal/<proposal>/revision/<revision>","decision":"approved","decisionId":...,"proposalId":...,"recordId":<Entity ID>,"revisionId":...}`（`qualification_text`、`derive_decision_authority`、`append_human_decision`）                                                                                                                                                                                                 |

Revision が Codex Entity 1 件だけなのは、`build_live_typed_bundle` が Entity を ID の昇順に並べ、ID は writer が作る UUID なので、複数の Entity や Relation を持つ Revision の entry の順を観測の前に書けないため。Relation を持つ Revision は DD-1 の版2に回す。複数の Revision を渡す request の entry の順は、渡した Revision ID の列の順（`pack_candidate_context` は元の候補の順に選ぶ）。

### placeholder の解決（DPH-4 の harness が setup receipt に書く値）

| placeholder                                                                           | 値                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{runtimeId:<logical>}}`                                                             | idMap の runtimeId。project（`<slug>-project`）、Scene（`<slug>-scene-anchor`、`<slug>-scene-query`）、Codex Entity（`<slug>-ent-<key>`）。Codex Entity の ID を writer の `entry_id` で指定するか、返った ID を使うかは harness が決める |
| `{{revisionId:<revision>}}`、`{{proposalId:<revision>}}`、`{{decisionId:<revision>}}` | `nir1_entity_relation_revision_prepare` が返す Revision／proposal の ID、承認の Decision の ID（idMap の拡張欄）                                                                                                                          |
| `{{sourceToken:<Entity の logicalId>}}`                                               | その stage の最後の書込みの後の、Codex 行の source token `codex:<Entity ID>@<updated_at>`（runtimeValues。source は `product-reader-function`）                                                                                           |
| `{{revisionToken:<slug>-scope-authority}}`                                            | その stage の最後の書込みの後の、project の Scope authority revision（`sha256:<hex>`。runtimeValues。同上）                                                                                                                               |

値は setup の後の DB の状態から読み、request の出力から読まない（scorer が `source` を検査する）。

## context 予算の式（freeze 記録にも同じ式を書く）

```
contextBudgetTokens = contextWindowTokens
  - (fixedSystemTokens + userTokens + envelopeTokens + outputTokens + safetyMarginTokens + separatorReserveTokens)
```

- route は `model=dph-fixture-local-model`、`contextWindowTokens=16384`、`outputTokens=1024`。値は既存の D-final の試験（`nir1_prepared_request.rs` の `configure_local_route`）の route と同じで、新しい製品の上限ではない。
- `fixedSystemTokens=531`（固定 template `nir1-local-chat-system-ja-v1` の 2 file と空の block で作る system prompt の推定値）、`envelopeTokens=10`（`4×2+2`）、`safetyMarginTokens=32`、`separatorReserveTokens=171`（`MAX_PACKING_ITEMS` 512 個の改行の推定値）。`userTokens` は case の `userMessage` の推定値。
- `selectedTokens = estimateTokens(rawText) + Σ estimateTemplateTokens(entry.text)`。template の placeholder は `maxLength` の ASCII 文字として数える（UUID は 36、token は 128）ので、実際の entry の token 数はこの値以下。余裕（`marginTokens`）は freeze 記録に request ごとに書いてあり、すべての正例 request で選択する group が全部収まる（予算の余裕が大きいので、packer は候補を全部採る）。

## harness 向けの手順（`setupContract`、`setup`、variant の `setup.steps`）

scorer と contract validator は読まない欄で、DPH-4 の harness が読む。

- `cases[].setup`：project、Scene（`anchor` が先、`query` が後。reading 順＝配列の順で、chat session の `node_id` は `query`）、Codex Entity（type、name、summary）。拒否 variant の `setup.codexEntities` はその variant だけの追加の Entity。Scene と Codex の本文は 1 行で、JSON の escape が要る文字を含まない。
- `setupContract.sceneScope`：全 Scene に同じ explicit の Scope（登録簿 `timeline:main`／`worldline:prime`／`layer:manuscript`。既存の D-final の試験の `configure_scene_scope` と同じ）。
- `steps`：順に実行する。`prepare`／`approve`（正例の Revision）、`prepare-negative`／`approve-negative`／`invalidate-negative`（拒否 variant の負例。正例の準備より前）、`binding-change`（P-10 の stage 2。stage 2 の最初の準備より前）。書込みの種類（`write`）は `decision-cancel`、`codex-update`、`scene-scope-registry-update`。
- 承認の `decisionJson.note` と `proposalKey` に canary（`canaries[]`）が入っている。
- runtimeValues の行は variant の `setup.runtimeValues` に、必要な (kind, logicalId, stage) を挙げてある。

## 固定の手順（独立期待値 review の後）

1. 独立期待値 reviewer（author でも実装者でもない別 agent。read-only。Native の出力を見ない）が、fixture を製品のコードと draft に照らして review し、`final-request.expectation-review.v1.json` に verdict（`approve`／`changes-required`）、`requiredChanges`、`cases[]`、`fixtureSha256`（review した fixture の bytes）を書く。reviewer が確かめる点は次。
   - `nir1_packing.rs` の `accepted_ir_group`、`qualification_text`、`closed_marker` と、`nir1_entity_relation.rs` の `build_live_typed_bundle`、`build_typed_material_basis` に照らした entry の template（`fixture-derive.mjs` と `fixture.test.mjs`）。
   - 拒否 variant の reason の導出表（上）。特に `scope-authority-changed` が A3 でなく A2 の `source-revision-changed` で落ちること。
   - 除外した負例の理由。
   - context 予算の式と余裕、P-10 の stage 2 の forbidden（前の stage の ID と text）。
2. `changes-required` なら author が fixture を直す（Native の出力は使わない）。直したら review をやり直す。
3. `approve` になったら、integrator が freeze 記録を確定にする（`status: frozen`、`reviewVerdict: approve`、`frozenAt`、review record の sha256 の更新）。freeze 記録は fixture、README、parity ベクトル、scorer の 4 module、review record の sha256 を束縛する。確定した commit は、この fixture の材料で Native を実行するどの run の commit よりも前（祖先）に置く。
4. 確定の後に fixture、README、review record、scorer を変えたら、全 case が失効する（新しい版を作る）。

## 前提（DPH-4 への引き継ぎ）

導出は base `1dbf6eec`（D-final と DF+ を含む）の製品のコードを読んで行った。次を前提にしている。崩れたら fixture の改版（新しい版）と review のやり直しが要る。

- `codex_create` が summary を一字も変えずに保存し、`codex_update` が `updated_at` を必ず更新する。
- `nir1_entity_relation_revision_prepare` が書く Evidence は Entity の summary 全体で、1 Entity につき Evidence 1 件。
- 承認の後に Scope の登録簿を更新すると、project の Scope authority revision が変わる。
- 正例の Revision は、すべての書込みの後に準備して承認するため、準備の時点で Freshness が fresh である必要がある。`narrative_extraction::run_incremental_freshness_cycle` のような製品の関数で書込みの後の change feed を処理する必要があるかを DPH-4 が最初に確かめる。製品の writer と reader の関数だけで fresh にできなければ、実装を止めて報告する（直接の DML は許されない）。
- origin/master の `74d95028`（CB-1。Scene 本文の宣言の保存、schema v43）は、この fixture の導出に使った規則を変えない見込みだが、run の commit で `nir1_packing.rs` と `nir1_entity_relation.rs` の該当箇所を読み直す。
