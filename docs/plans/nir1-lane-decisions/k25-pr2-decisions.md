# K2/5 PR-2（本文の宣言のコードの撤去）の判断の記録

- 正本：`docs/plans/nir1-c-body-disclosure-proposal-5-draft.md`（K2/5。§5 の表の「PR-2（撤去）」）。前の記録は [k25-pr1-decisions.md](k25-pr1-decisions.md)（K25P1-1〜8）。
- 分け方の起案：`fusion-eval-data/design-notes/cp4-final-freeze-prep-2026-11-19/pr2-split-draft-r2.md`（2-pre／2a／2b1／2b2／2c。第 2 次の反証 F1〜F11 の反映済み）。
- この記録は、PR-2 の最初の 1 本 **2-pre**（K25P1-3 の前提の移動）の mutation の前の記録。以降の PR（2a〜2c）の判断は、同じ file に K25P2-n として足す。
- 委任：NIR-1 の残レーン（C-body）の技術判断。確認済みの actor・防御・受信先・受入れの範囲から出ない。
  新しい送信先、保存範囲の拡大、閾値の変更、製品の公開、新しい契約・authority は無い。

## 信頼境界（2-pre で変えないもの）

- 宣言の writer・UI・grant・seam・IPC・Native の entry は、2-pre では触れない。Native の gate `PrePublicationEntry::SceneBodyDeclaration` と `BODY_DECLARATION_UI_ENABLED = false` で閉じたまま。
- reader の判定・K1b の上限・title の digest・archived の判定は、値も形も変えない（置き場所だけ変える）。
- 公開の旗（`PRODUCT_GRAPH_PUBLISHED`、`NIR1_GRAPH_UI_ENABLED`）は変えない。

## 判断

- **K25P2-1　PR-2 を公開の前に寄せる（ユーザーの決定）**
  - ユーザーは 2026-11-23 に、PR-2（宣言のコードの撤去）を Graph の公開の後でなく**公開の前**に進めると決めた（contracts `7a64b1cc`）。
    これは、台帳 `nir1-l6-l9-execution-plan.md:371・497` と K2/5 §5 の「撤去は PUB-G の後」を、時期の点で改めるユーザーの決定である。
    K2/5 の draft（sha256 に束縛）は編集しない。台帳の補足と確認の記録は統合者が足す。
  - 固定の制約は変わらない。S4 が pin する harness の file には PR-2 が触れない。製品の宣言の撤去（2a〜2c）は、S4 の枝が `cp4-harness.ts` の宣言の import と seam の env・receipt root を外した後。
  - 2-pre は撤去でなく移動なので、S4 の枝を待たない（起案 §3.1・§4.2）。
- **K25P2-2　2-pre の範囲**：K25P1-3 の前提（title の digest、`archived_in_chain`、K1b の定数 3 つを、消えない場所へ移す）だけ。
  - 移す対象：`scene_body_title_digest`（domain `grimodex/narrative-scene-body-title/1`）、`archived_in_chain`、`SCENE_BODY_READ_MAX_BYTES`（64 KiB）、`SCENE_BODY_READ_PEAK_MAX_BYTES`（64 MiB）、`SCENE_BODY_TITLE_MAX_BYTES`（8,192）。
  - 消さない使い手（`body.rs`・`click.rs`・`judge.rs`、`body_tests.rs`・`tests.rs`・`exit_tests.rs`、Native の `graph_response.rs`／`graph_response_tests.rs`）の import 元を `nir1_graph` へ付け替える。
  - **削除なし、値の変更なし**、domain の文字列は変えない。新しい file は作らない（K25P1-3 の理由 2。manifest と impact を動かさない）。
  - 消す側の使い手（`veto.rs`、`facts.rs`、`display_tests.rs`、`veto_tests.rs`）は変えない。消す `display.rs`／`limits.rs` は、移した先を re-export する形で 2b2 まで残し、2b2 でまとめて消す（再 export の先に消さない使い手が残らない）。
  - 消す定数（`SCENE_BODY_VETO_MAX_ROWS`、`VETO_ROW_LIMIT_MARKER`、`VETO_CONTENT_LIMIT_MARKER`）は reader が使わないので動かさない。
- **K25P2-3　移し先と可視性**：reader から見える既存の module `nir1_graph.rs`（`mod.rs` の `pub mod nir1_graph;` は cfg なし）。
  - title の digest と K1b の定数 3 つ：cfg なしの `pub` で `nir1_graph.rs` に直接定義する。feature なしの使い手（`veto.rs`、`display_tests.rs`、`veto_tests.rs`、`scene_body_declaration.rs` の再 export）が、消す module の中にいるため。
    Native は既に `grimodex_db::narrative_extraction::nir1_graph::…` を import しているので、同じ path から読める。
  - `archived_in_chain`：`#[cfg(feature = "native-current-human-capture")] pub(in crate::narrative_extraction) fn` として `nir1_graph.rs` に置く（起案 §2.8 の (i)）。使い手（`facts.rs`、`judge.rs`、`exit_tests.rs`）が全部 feature の下で、feature なしの build には item 自体が無く `dead_code` の余地が無い。
    `scene_body_declaration.rs` の `pub(in …) use facts::archived_in_chain` は外し、`facts.rs` は `nir1_graph` から直接 import する。
  - **K25P1-3 の字面「cfg なしの既存 module」の読み（起案 F7）**：「module が cfg なしで compile される」と読む（`nir1_graph.rs` は cfg なし）。item が feature の cfg の下でよい理由は、使い手が全部 feature の下で、K25P1-3 の目的が「消す module の中でなく、消えない場所に置く」ことだから。
    字面どおり item も cfg なしの `pub` にする (ii) は、`pub(in …)` のままだと feature なしで使い手が無く `dead_code`（`-D warnings`）になり、SQL を持つ関数が feature なしの build にも入るので採らない。
- **K25P2-4　元の場所の扱い**：`display.rs` と `limits.rs` の定義は消し、`pub use crate::narrative_extraction::nir1_graph::{…}` に置き換える。
  `scene_body_declaration.rs` の再 export（`pub use display::{… scene_body_title_digest …}`、`pub use limits::{…}`）はそのまま通る。2b2 で `display.rs`／`limits.rs` ごと消すときに再 export も外す。
- **K25P2-5　S4 との関係と bytes**：2-pre は S4 の枝を待たない。
  - renderer bundle の bytes は変わらない見込み（Rust だけで、`src/`・`electron/main` を触らない）。S4 の pin する file にも触れない。
  - **Native の build の bytes は変わる**（`graph_response.rs` の import と db crate の item の置き場所が変わる）。値の挙動は同じ。最後の凍結の前に入れるのが筋で、PR-2 の他の PR と同じく、測った製品との差としては「到達不能な部品の移動」として PR 本文に書く。
  - 旧 harness での Graph の dev／正式の run を止める規則（K25P1-8）は、S4 の枝の merge まで続く。2-pre はこれを変えない。
- **K25P2-6　検証の方針**：既存の試験が移動を保証する（K1b の上限の試験、title digest の試験、`archived_in_chain` の試験）。
  3 filter（`scene_disclosure`／`related_scenes_requalification`／`scene_body_declaration`）の件数は PR-1 head と**同じ**であること。feature なしと feature ありの両方の clippy、Native の clippy（ci.yml と同じ形）、`validate:architecture`、native-architecture の試験を確かめる。

## 検証（実装の後に追記する）

- 2-pre（基点 `origin/master` `f09d6d938`、2026-11-23、手元）
  - db の 3 filter（`cd src-tauri && cargo test -p grimodex-db --features native-current-human-capture --lib <filter> -- --test-threads=1`）：件数は PR-1 head と同じ。
    - `narrative_extraction::nir1_graph::scene_disclosure`：94 passed、1 ignored（68 s）
    - `narrative_extraction::nir1_graph::related_scenes_requalification`：34 passed（13 s）
    - `narrative_extraction::scene_body_declaration`：112 passed、1 ignored（55 s）
  - clippy（`-D warnings`）
    - db、feature なし：`cargo clippy -p grimodex-db --all-targets -- -D warnings` は通った（`nir1_graph.rs` の追加分に `dead_code`／`unused_imports` なし）。
    - db、feature あり：`--features native-current-human-capture` は、diff の外の 5 件（`nir1_packing.rs`、`nir1_packing_tests.rs`、`nir1_generation.rs`。PR-1 の記録と同じ）で非 0。触った file の警告は 0。
    - Native：`cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings`（ci.yml と同じ）と、features なしの `--all-targets` の両方が通った。
  - Native：`cargo test related_scenes` は 134 passed（PR-1 head の 125 から、master の進みで増えた分）。
  - Node 22：`node --test` で observation-prep 111 pass、native-architecture と eval-fixtures の 2 file で 36 pass（26＋10）。`pnpm -s validate:architecture` は通った。

## 2-pre の独立の反証（2026-11-23、判断の記録を見せずに差分だけを見た）
- 判定は ok。値・意味は不変（title digest の domain とキー順、K1b の 3 定数、`archived_in_chain` の CTE は逐字で一致）、二重定義なし、feature の有無の両方で clippy `-D warnings` が通る（standalone MCP を含む）、付け替えの漏れなし。
- R4（medium、反映）：2b2 で `scene_body_declaration` を消す前に、本番の Graph の reader に残る依存が無いことを固定する検査が無かった。`nir1_graph/tests.rs` に `production_graph_sources_do_not_reference_the_body_declaration_module` を足した（`nir1_graph.rs` と `nir1_graph/` の下の、試験でない `.rs` に `scene_body_declaration::` が現れないこと）。`click.rs` に参照を 1 行足すと落ちることを確かめてから戻した。試験の file の依存（`writer_support_tests`、`test_support`、quarantine 系）は 2b2 で付け替える（起案 r2 §2.4.1）。
- R5（low、反映）：付け替えた `use` の並びを rustfmt の順に直し、`nir1_graph.rs` の新しい block の後に空行を入れた。
- 実装の途中で、実装役が自分の作った空の一時 file（`README.md.tmp`）を消すために、禁じていたシェルの `rm` を 1 回使った。repo の file には影響なし。
