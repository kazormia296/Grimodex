# K2/5 PR-1（Graph の追加の場面の reader から、本文の宣言・束縛・veto・quarantine を外す）の判断の記録

- 正本：`docs/plans/nir1-c-body-disclosure-proposal-5-draft.md`（K2/5。ユーザーの確認は 2026-11-20、contracts `11dc9eda` の確認 1）。
  - この PR は §5 の表の「PR-1（reader。製品の PR）」にあたる。
  - 順序は PR-1（merge）→ S4 の枝（harness・evals・S2 の改版、凍結、測定）→ PUB-G の公開 → PR-2（撤去）。
- 委任：NIR-1 の残レーン（C-body）の技術判断。確認済みの actor・防御・受信先・受入れの範囲から出ない。
  - 新しい送信先、保存範囲の拡大、閾値の変更、製品の公開、新しい契約・authority は無い。
- 実装前の調査（read-only）：`fusion-eval-data/design-notes/k25-k32-understand-2026-11-21/journal.jsonl`（workflow `wf_d1147825-48b`、4 本の調査と点検 1 本）。

## 信頼境界（変えないもの）

- 公開の gate：`PRODUCT_GRAPH_PUBLISHED`（false）と `NIR1_GRAPH_UI_ENABLED`（false）は変えない。この PR は Graph を公開しない。
- Graph の応答は、AI の送信・Packing・履歴・export・audit に載せない（K2/4 の Mandatory defense 2 のまま）。
- 宣言の writer、取消、state の入口、`MainGrantKind::BodyDeclaration`、宣言の UI、Main の CI seam、確認ダイアログには触れない。
  - どれも Native の gate（`PrePublicationEntry::SceneBodyDeclaration`）と `BODY_DECLARATION_UI_ENABLED = false` で閉じたままで、PR-2 で撤去する。
  - PUB-G の承認は、この gate を開けない。
  - この PR の後、reader はこれらの値を読まないので、writer が書いても判定には届かない。
- A1 の一致（`nir1_graph/scenes.rs` の `validate_scene_scope`）、読む順、frame の token の一致、pin の再確認、path の再検証、K1b の上限（本文と title）、archived と空の本文の拒否は残す。
- 名前は同じだが別物のものは消さない：C-query の worker／owner の fence の `quarantined`（`nir1_graph_product.rs`、`graph_tests.rs`）。

## 判断

- **K25P1-1　判定から外すもの**（K2/5 §2.1 の判定表のとおり）
  - 宣言の読込（`judge.rs` の `read_scene_body_declaration`、`body.rs` の `reverify_candidate` の再読）。
  - 束縛の照合（`SceneBodyDeclarationCurrentFacts` と `scene_body_declaration_binding_mismatches`）。
  - veto（`scene_body_declaration_veto_records`／`scene_body_declaration_veto`）。
  - 宣言の quarantine（`GraphDisclosureWorkspace::is_quarantined` と、その呼出し：`judge.rs`、`body.rs`、`click.rs`、db の `related_scenes_requalification.rs` の `drop_graph_only_if_quarantined`、Native の `graph_response.rs`）。
  - click の handle の宣言の欄（`GraphOnlySceneBinding` の `declaration_id`／`declaration_token`）。
  - 返却と click の間の変更は、返却時に読んだ `BodyFacts`（source token、2 つの digest、range）と title の digest で検出する。これは宣言の digest でなく、返却時に読んだ値に束縛される。
- **K25P1-2　診断の `Count` から 3 値を消す**：`Quarantined`、`DeclarationUnavailable`、`Veto`（一覧は 21→18）。
  - `BindingMismatch` は click の照合と body の token の一致で使い続けるので残す。
  - 根拠：pin 済みの harness（`scripts/quality/nir1-graph-eval/`、`scripts/quality/nir1-graph/`）は、この 3 つの語を読んでいない（grep で確認。harness の `counters` は owner の counters で別物）。
- **K25P1-3　title の digest、`archived_in_chain`、K1b の定数 3 つは PR-1 で移さない**。
  - draft は title の digest の移動を PR-1 に入れていたが、3 種とも同じ扱いにして PR-2 の前提に回す。
  - 理由 1：digest だけを移すと、残り 2 種（`facts.rs:206` の `archived_in_chain`、`limits.rs` の定数）に同じ罠が残る。
  - 理由 2：新しい file を作ると `evals/quality-manifest.yaml` と impact が動く。
  - 理由 3：今の置き場所（`scene_body_declaration/display.rs`、`facts.rs`、`limits.rs` と `scene_body_declaration.rs` の再 export）のままで、PR-1 の reader は正しく動く。
  - **PR-2 の前提**：`display.rs`、`facts.rs`、`limits.rs` を消す前に、この 3 種を reader から見える cfg なしの既存 module に移す（domain の文字列は変えない）。
- **K25P1-4　試験は file を消さず、改名もせずに組み替える**（manifest の存在検査のため）。宣言の失効を主題にした試験（invalidation の E 群など）は、次の性質の試験に置き換える。
  - 宣言も veto も無い場面が、追加の枠に出る。秘密の伏線、秘密の Chronicle の event、Scene と beat の POV があっても出る。
  - 次のときは出ない：A1 の不一致、読む順が前でない、frame の token の不一致（本文の保存の後、Index が追いつくまで）、archived、title が上限を超える。
  - 返却と click の間に本文か title が変わると、click を拒否する。
- **K25P1-5　画面の文言**：既定を当てる確認文と registry の警告から「本文の宣言」の語を外す。
  - 対象は ja と en の 8 か所（`sceneScopeDefaultTranslations.ts` と `ja.json`／`en.json`）。
  - 承認済みの解釈の失効（SDEF/1）の文は残す。
  - あわせて `nir1GraphAvailability.ts` の「`BODY_DECLARATION_UI_ENABLED` と同じ承認で開ける」の注記を直す。PUB-G で開けるのは Graph の UI だけになる。`bodyDeclarationAvailability.ts` のコメントの「PUB-G が同時に開ける」も同じ理由で直す。
- **K25P1-6　触らない形**（S4 の pin 済みの `native-architecture.mjs` と S2 の validator が、作業ツリーの text を見るため）
  - 名前と形を変えない：`graph_response::Assembled`、`classify`。
  - 触れない：`related_scenes/graph.rs` の eval の snippet、`begin_probed`／`publication_open`／Busy の hook／`PRODUCT_GRAPH_PUBLISHED`、`useNir1RelatedScenes.ts`、`settings/types.ts`、`export const NIR1_GRAPH_UI_ENABLED = false as const;` の行。
- **K25P1-7　CI で走らない試験の扱い**
  - CB-4 の db の試験（`narrative_extraction::nir1_graph::scene_disclosure`、`::related_scenes_requalification`、`narrative_extraction::scene_body_declaration`）は feature `native-current-human-capture` の下にある。今の `ci.yml` の integration shard の filter の一覧（`cargo test (native-current-human-capture library tests)`）に入っていないので、PR・Quick・Full・夜間のどれでも走らない。
  - そのため、PR-1 の検証は手元の feature つきの実行で行い、command と件数と所要時間を PR 本文に残す。
  - CI への追加（filter の追記）は別の小さい PR で検討する。所要時間を測ってから、shard の枠に収まるかで決める。
- **K25P1-8　PR-1 の merge から S4 の枝の merge まで**
  - CI の試験としては、宣言の段で落ちない見込み（読み）。根拠は、S4 の pin の path がすべて `scripts/quality/` の下にあることと、closure の歩きが `src/`・`electron/` の境界（`isSharedClosureBoundary`）で止まること（`observation-prep.mjs` の pin と除外の節）。
  - PR head で `observation-prep.test.mjs`、`native-architecture.test.mjs`、eval-fixtures の試験を回して確かめる。
  - その間は、旧 harness（宣言の段がある）で Graph の dev／正式の run を走らせない。K24-G01-N1〜N4、cb4-inputs、Gold の宣言の段は意味を失う。これは作業記録と引き継ぎで共有する。

## 検証（実装の後に追記する）

- 基線（素の master `2978c01e`、2026-11-21、手元）
  - `cd src-tauri && cargo test -p grimodex-db --features native-current-human-capture --lib <filter> -- --test-threads=1`
    - `narrative_extraction::nir1_graph::scene_disclosure`：98 passed、1 ignored（試験 70 s、build を含めて 243 s）
    - `narrative_extraction::nir1_graph::related_scenes_requalification`：34 passed（14 s）
    - `narrative_extraction::scene_body_declaration`：112 passed、1 ignored（54 s）
  - Node 22 の `node --test`
    - `scripts/quality/nir1-graph/observation-prep.test.mjs`：111 pass（262 s）
    - `scripts/quality/nir1-graph-eval/native-architecture.test.mjs`：26 pass
    - `scripts/quality/eval-fixtures.test.mjs`：10 pass
- PR head（基点 `2978c01e` の上、2026-11-21、手元）
  - 同じ command
    - `scene_disclosure`：94 passed、1 ignored（65 s）
      - 基線より 4 件少ない。`tests.rs` で 10 本を消し、6 本を足した。
      - 消した試験のうち、宣言・veto・quarantine の性質を見ていたものは、K25P1-4 の 3 つの性質の試験に統合した。統合の先は、宣言の 2 列を読まないこと、writer の quarantine が reader を止めないこと、秘密の記録と POV で隠れないこと、記録の行の上限が無くなったこと。
      - 重なっていた 2 本は消した。
      - `body_tests.rs` の増減は 0。宣言の digest との照合の 1 本を消し、click が宣言・記録・writer の quarantine の変化で拒否されないことの 1 本を足した。
      - invalidation の E 群は同数で、主題を「古い応答の click を拒否する」に組み替えた。
    - `related_scenes_requalification`：34 passed
      - 閉じた枠の試験は、宣言の欄の読みの代わりに、候補の本文・pin・A1 の行の読みが開いた枠より少ないことを確かめる形にした。
    - `scene_body_declaration`：112 passed、1 ignored（writer 側は変えていない）
  - clippy
    - db：`cargo clippy -p grimodex-db --features native-current-human-capture --all-targets -- -D warnings` は、diff の外の 5 件（`nir1_packing.rs`、`nir1_packing_tests.rs`、`nir1_generation.rs`）で非 0。触った file の警告は 0。
    - Native：`cd electron/native/grimodex-node && cargo clippy --all-targets -- -D warnings` は通った。
    - 手元の rustfmt は、手を付けていない多数の file にも差分を出す（toolchain の版の違い）。CI は `cargo fmt` を回さない。
  - 試験
    - Native：`cargo test related_scenes` は 125 passed。
    - renderer：文言の試験 4 file を vitest で回し、13 passed。
  - Node 22
    - `node --test` で observation-prep、native-architecture、eval-fixtures の 3 つを回し、147 pass（基線と同じ 111＋26＋10）。
    - `pnpm -s validate:architecture` は通った。
