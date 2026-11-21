# K3/2 の Graph の行の改訂（Graph を restricted なしでも出す）の実装の判断の記録

- 正本：`docs/plans/nir1-d2a-graph-unrestricted-proposal-1-draft.md`（K3/2R-1）。
  - ユーザーの確認は 2026-11-20、contracts `11dc9eda` の確認 2：「確認し、D2a の前提も外す」。
  - この PR は §3.7 の「Native の 3 か所」と、その wire・guidance・試験・文書。
- 委任：NIR-1 の残レーン（C-product、D-final の追補）の worker／owner／lifecycle の技術判断。確認済みの actor・防御・受信先・受入れの範囲から出ない。
  - 新しい送信先、保存範囲の拡大、閾値の変更、製品の公開、新しい契約・authority は無い。
  - wire に新しい語を足さない（理由コードは既存の語に寄せる）。
- 実装前の調査（read-only）：`fusion-eval-data/design-notes/k25-k32-understand-2026-11-21/journal.jsonl` の K32-sec5・K32-tests-pin・点検と、`fusion-eval-data/design-notes/parallel-abc-2026-11-21/journal.jsonl` の B。
- 前提：K2/5 の PR-1（#996、master `a9f1d540`）の後に乗る。

## 信頼境界（変えないもの）

- 公開の gate：`PRODUCT_GRAPH_PUBLISHED`（false）と `NIR1_GRAPH_UI_ENABLED`（false）は変えない。この PR は Graph を公開しない。
- Graph の応答は画面だけに使う。AI の送信・Packing・履歴・export・audit に載せない（K2/4 の Mandatory defense 2）。
- IPC の台帳、`nir1-publication`／`nir1-restricted-only` の区分、D-final と local 生成の restricted 限定（`with_authorized_preparation`）、外へ出す経路の閉鎖は変えない。
- restricted の挙動（identity と stop barrier の要求）は変えない。

## 判断

- **K32R-1　共通の判定**：Native の判定を純関数 1 つ（`profile_gate`）にまとめる。
  - restricted かつ停止を確かめていないときだけ `Some(NotActivated)` を返す。unrestricted では `in_flight_stopped` が構成上つねに true なので、閉じない。
  - 呼ぶ場所は 4 か所：
    - `nir1_graph_product.rs` の admit_and_route
    - owner thread の admit
    - `related_scenes/graph.rs` の gate_reason（click からも呼ばれる）
    - serve_query の query の直前（K32R-2）
- **K32R-2　barrier をまたぐ worker**（調査で見つかった点）
  - 条件を外すと、unrestricted の間に作られた worker（prepare 中、READY、query 中）が、activation の barrier をまたいで残りうる。activation の経路も stop barrier も、Graph の owner に触れない。
  - 対処は (b) とする。serve_query で、cancel の検査の後、`worker.query` の前に owner thread で `profile_gate` を見る。閉じていれば `NotActivated` を返し、その worker を**退役させる**（READY に戻さない）。
  - 新しい非同期・timer・process は足さない。
  - (b) が保証するのは、「barrier を見た後に、新しい worker も query も始めない」こと。検査と query の開始の間の短い隙間と、barrier をまたぐ prepare は残る。
    - 残っても安全な理由は 3 つ。worker の入力に profile 由来の状態は無く、読みは手元の DB だけで、送信は無い。結果の返却は gate_reason と `PublicationGuard.finish` が閉じる。cache の key は `caller_epoch` で分かれる。
  - **READY の再利用は `caller_epoch` の一致で絞る**（実装の後の追加）。
    - 作った時点の `status.caller_epoch` を、worker の admit（`admit` の返り値）から slot の session に記録する。
    - `serve_ready` は、記録した epoch が今の caller の epoch（cache key の `caller_epoch`）と違えば、query を渡さず、既存の rekey の経路（`Command::Retire`、`pending_rekey`）で退役させ、cold の worker を作り直す（今の begin は `warming`。busy の answer と cause の hook は閉じた集合で S4 が pin するので足さない）。
    - `serve_query` も、profile を読むときに同じ比較をし、違えば query せず退役させる（`invalidated`）。activation（停止確認まで済み）が、begin の後・query の開始の前に入る場合に当たる。
    - 新しい非同期・timer・process は足さない。slot の lock は profile の mutex を放した後に取り、入れ子にしない。
    - これで、unrestricted で作った worker が、activation（first restricted で `caller_epoch` が +1）の後に restricted の caller へ答えることはない。
    - それでも残る隙間：検査と query の開始の間（短い）と、barrier をまたぐ prepare。結果の返却は `gate_reason` と `PublicationGuard.finish` が閉じる。
  - (c)（activation で Graph を退役させる、stop barrier の対象に Graph を足す）は、Graph の owner と activation の新しい結合になり、脅威モデルの変更なので採らない。
  - K3/2 の :162・:303・:325 の「activation の完了の前に Graph を作らない」の読み替え：主の文は draft §3.2 の確認済みの文「restricted 向けの Graph の結果を activation の完了の前に返さない（finish と owner の admit）」。補足が「barrier の間に新しい worker と query を始めない。activation の前に作った worker は、caller_epoch が変わったら使わない」。詳しくは下の「実装で決めた読み替え」。
- **K32R-3　理由コード**：restricted で停止を確かめていないときは、既存の `not-activated` を返す。
  - `profile-not-restricted` は、出ない語として enum と wire に残す。
  - renderer は `not-activated` で Graph を描かず、R／IR だけを出す。
  - S4 が pin する `join.mjs` の集合は、両方の語を同じ setup-defect の集合に持つので、CP-4 の分類は変わらない。
  - `profile-not-restricted` を前提にした renderer の Graph 側の activation の案内（T-1 の 1 つ）は、出なくなる。draft §3.2 のとおりで、案内の部品と翻訳の撤去は別に行う。
  - `warming` などに寄せる案は、renderer が来ない graph-ready を待つので採らない。
- **K32R-2 の補足　profile の `unavailable_reason` は見ない**：unrestricted の profile が `unavailable`（`ActivationFailed`、`StateFileUnwritable`）でも、Graph は閉じない。R／IR と同じ扱いで、`gate_reason` と `profile_gate` は `ProfileEgressStatus.unavailable_reason` を読まない。Graph の応答は画面だけで、送信が無いため。
- **K32R-4　click の handle**：finish が失敗した後に、click の handle が lease に残らないようにする。
  - Await の経路で、`PublicationGuard.finish` を `keep_click` の前に行う。
  - `#[napi]` の doc コメントを変えたら、`index.d.ts` を再生成する（#949 の前例）。
  - 固定している試験：`related_scenes/graph_tests.rs` の `a_payload_discarded_by_the_recheck_keeps_no_click_handle`（`keep_once_returned` の単体：activation の後の `finish` の失敗で closure が走らない）と、`the_entry_recheck_comes_before_the_click_handle_is_kept`（source の順序と、keeping の後に失敗する段が無いこと）。
  - 限界：`graph_continue(Await)` を、graph-only の行を返す fixture で通す結合試験は足せなかった。`Assembled::Available` の `click` が `Some` になる eligible な行は database crate の fixture でしか作れず（`graph_response_tests.rs` の注記のとおり）、`ClickEntry` は node crate から作れない。lease も `real_lease`（`build_tests.rs`）の別 registry では `owned()` に当たらない。unrestricted のまま path／graphOnly が返ることは、`an_unrestricted_profile_starts_a_query_when_the_gate_is_open`（await の Ready まで）と `gate_reason` の試験で、wire の返却の手前までを固定している。
- **K32R-5　触らない形**（S4 の pin 済みの `native-architecture.mjs` と S2 の validator が、作業ツリーの text を見るため）
  - 名前と形を変えない：`graph_response::Assembled`、`classify`。
  - 触れない：`related_scenes/graph.rs` の eval の snippet、`begin_probed`／`publication_open`／Busy の hook／`PRODUCT_GRAPH_PUBLISHED`、`useNir1RelatedScenes.ts`、`settings/types.ts`、`export const NIR1_GRAPH_UI_ENABLED = false as const;` の行。
- **K32R-6　文書**
  - この PR で K3/2 と DSN を改訂する範囲は、draft §3.2 の言い換え（K32R-2）だけにする。
  - DSN の理由コードの表の 1 行（K32R-3 の帰結。`profile-not-restricted` が出なくなる）と、§1.2、§1.5、§3.3、§4.2、§4.3 も合わせた。
  - K3/2 の draft 本体と、この改訂の draft（proposal/1）は bytes が束縛されているので触らない。:162・:303・:325 の読み替えは、この文書の「実装で決めた読み替え」に書いた。
  - 実装計画と実行計画の公開条件「A3＋B＋C＋D2a」から D2a を外す（確認 2）。
  - 台帳の bytes の束縛には触れない。
- **K32R-7　CP-4**：測定は restricted のまま。unrestricted の parity の測定は、最後の凍結（S4 の枝）で足す。harness は変えない。

- **K32R-8　lease の Graph の slot と click の handle も `caller_epoch` で束縛する**（反証の F1）
  - 反証で見つかった穴：`caller_epoch` の防御は owner の worker（`worker_caller_epoch`）と cache の key にだけ掛かっていた。lease の `GraphSlot::Cached(projection)`、deliver 済みの `GraphSlot::Pending(ticket)`、click の handle には束縛が無かった。
    - 手順 A：unrestricted の `related_scenes_begin` が epoch N の ticket か cache hit を slot に入れる → activation が完了 → restricted の新しい identity が同じ owner／ticket で `related_scenes_graph_continue`（Await）を呼ぶ。`admit`、`claim`、`await_graph_joined`（`edge_epoch` だけ照合）、`current_operation`、`gate_reason`、`PublicationGuard.finish` はすべて通り、epoch N の projection が restricted の caller に返る。
    - 手順 B：unrestricted で `graph_continue` が成功して handle が lease に残る → activation の完了 → lease の TTL（300 s）以内に Graph-only の行を click → `nir1_evidence_qualify` → `graph_response::click` が `gate_reason`、`current_operation`、`current_request` しか見ないので、qualified と範囲が restricted の caller に返る。
    - 契約の Negative (3)「activation の完了の前に作った restricted 向けの Graph の結果を返さない」を破る。
  - 直し方：
    - `GraphState::start`（slot を作る所）が、owner へ渡す前の `status.caller_epoch` を slot に記録する。渡す前に読むので、owner が見た epoch より新しくなることは無い（隙間があっても slot を捨てる側に倒れる）。
    - `graph_gate_reason(state, graph)`＝`gate_reason` に「記録した epoch が今の `caller_epoch` と違えば `Invalidated`」を足した関数を使う。違えば `discard_if_rebound` が slot の projection と click の handle を捨て、ticket を `Cancelled` で終える（cache に載らない）。
    - 呼ぶ場所：`await_request` の claim の後、待った後の gate、結果が出る所の gate の 3 か所と、`graph_response::click` の冒頭と返す直前の 2 か所。
    - wire に新しい語は足さない（既存の `invalidated`）。`graph_response::Assembled`／`classify` の名前と形、`related_scenes/graph.rs` の eval の snippet は変えていない。
    - 新しい非同期・timer・process は足さない。activation の経路から related scenes の lease は触らない（lease の側が自分の slot を、使う所で照合するだけで、新しい結合は無い）。
  - 試験（`related_scenes/graph_tests.rs`）：
    - `a_cache_hit_made_unrestricted_is_not_returned_after_an_activation`（(a)）、`a_delivered_ticket_made_unrestricted_is_not_returned_after_an_activation`（(b)）、`a_slot_of_the_same_caller_epoch_is_returned_as_before`（(d)。unrestricted のままと、restricted の epoch が同じ場合）、`a_slot_made_after_the_activation_is_bound_to_the_new_epoch`、`the_click_and_the_await_check_the_caller_epoch_binding`（click と await の呼び出し位置を source で固定）。
    - 限界：`graph_continue(Await)` と `nir1_evidence_qualify` を lease の結合で通す試験は、K32R-4 と同じ理由（`Operation` と `ClickEntry` は database crate の型で node crate から作れない）で足せなかった。(a)(b) は slot の状態と `await_graph` までを通し、(c) の handle の廃棄は `discard_if_rebound`（slot と同じ関数）と呼び出し位置の source の試験で固定している。handle が Some の行の dynamic な廃棄は未確認。
  - 同時に弱かった試験を直した：`p7_an_unrestricted_profile_goes_on_to_the_worker_after_registration` は `is_some()` でなく `Available` を確かめる。`;` を落として緩めていた source の照合は、closure の中に `;` を戻して元の形に戻した。

## 反証の結果（F2〜F4）

- **F2　activation の予約の間（段 1〜3）にも Graph を作る**：unrestricted の間は、worker を作り query するので、段 1〜3 の間にも Graph の slot ができる。作ること自体は K32R-2 の言い換え（主の文は「返さない」）の範囲。返却は K32R-8（`caller_epoch` の束縛）と、Main の完了時の照合（`PublicationGuard.finish`）が閉じる。
- **F3　unrestricted で `unavailable` でも閉じない**：profile が `unavailable`（`ActivationFailed`、`StateFileUnwritable`）でも Graph は閉じない。R／IR と同じ扱いで、Graph の応答は画面だけに使い送信が無いため（K32R-2 の補足のとおり）。
- **F4　barrier の間の理由が変わる**：restricted で停止を確かめていない間の理由が `profile-not-restricted` から `not-activated` に変わる。`PROFILE_ACTIVATION_UI_ENABLED` が on なら出ていた activation の案内が、barrier の間は出なくなる。§3.5 (5) に対する wire の変化で、K32R-3 の帰結として受け入れる（案内の部品と翻訳の撤去は別に行う）。

## 実装で決めた読み替え（2026-11-21。K32R-2）

この PR で決めた、K3/2 の :162・:303・:325 の「activation の完了の前に Graph を作らない」の読み替え。K3/2 の draft 本体（`nir1-d2a-activation-proposal-2-draft.md`）と、この改訂の draft（`nir1-d2a-graph-unrestricted-proposal-1-draft.md`。SHA-256 `148fc995…` が台帳の K3/2R-1 の行と contractId の行に束縛されている）は、どちらも bytes が束縛されているので触らない。この節が、その 3 箇所の読み方になる。draft の末尾への追記は、束縛の更新が要るため行わなかった（束縛の更新は委任の外）。

- 主の文は、§3.2 の確認済みの文のとおり：**restricted 向けの Graph の結果を activation の完了の前に返さない**（`PublicationGuard.finish` と owner の `admit`）。「Graph を作らない」は、unrestricted の間は Graph を作る（worker を作り query する）ので成り立たない。
- 補足：
  - barrier の間に新しい worker と query を始めない（owner の `admit` と、query の開始の直前の `profile_gate`）。
  - activation の前に作った worker は、`caller_epoch` が変わったら使わない（READY の再利用と query の開始で epoch を比べ、違えば退役させて cold の worker を作り直す）。
  - 検査と query の開始の間の短い隙間と、barrier をまたぐ prepare は残る。worker の入力に profile 由来の状態は無く、読みは手元の DB だけで、送信は無い。結果の返却は `gate_reason` と `finish` が閉じる。
- 新しい契約・authority は足さない。Graph の owner と activation を結合する案（activation で Graph を退役させる、stop barrier の対象に Graph を足す）は、脅威モデルの変更なので採らなかった。

## 受入れ 2・3・4 を固定している既存の試験（mode に依らない根拠）

draft §3.5 の受入れ 2・3・4 は、新しい試験を足さず、既存の試験が mode に依らず固定している。

- 受入れ 2（AI 送信・Packing・履歴・export・audit に Graph の応答が載らない）
  - `related_scenes/graph_response_tests.rs` の `the_graph_only_text_has_no_path_to_the_request_packing_or_evaluation_outputs`：D-final／local 生成／送信方針／transport／`profile_egress.rs` の source に `graph_response`、`related_scenes::graph`、`ClickEntry`、`GraphOnlyRow` の名前が無いことを `include_str!` で見る。つまり Graph-only の text を持てるのは `graph_response` と operation の slot だけ、という構造の試験で、profile の状態を引かない。
  - `nir1_graph_dfinal_tests.rs` の `a13_worker_text_and_scene_association_reach_neither_the_request_nor_its_diagnostics`：worker の sentinel の text と Scene の関連が、request の canonical payload と診断に出ないこと。`Rig` は profile の mode を設定せず、payload の byte を走査するだけなので、mode に依らない（D-final 自体は restricted 限定で、unrestricted は受入れ 4 により届かない）。
- 受入れ 3（新しい送信先が無い）
  - `electron/main/d2aNirPublication.test.ts` と `d2aRouteClasses.test.ts` の `d2aRouteLedgersForTest` の台帳の試験：`d2aRouteLedgersForTest().nir1Publication` が NIR の 7 command と一致することを固定する。台帳は静的な表で、profile の mode を持たない。この PR は台帳を変えない。
- 受入れ 4（unrestricted で D-final と local 生成が Graph の owner に届かない）
  - `nir1_graph_product_tests.rs` の `with_authorized_preparation_still_refuses_an_unrestricted_profile_with_the_graph_gate_open`：Graph の gate を開いても `with_authorized_preparation` が unrestricted を拒否し、closure が走らないこと（この試験が確かめるのはここまで）。
  - 実際に Graph の owner への到達を止めているのは、`nir1_prepared_request.rs` の `napi_unrestricted_capture_and_retirement_are_legacy_only_without_db_writes`：unrestricted の capture が legacy-only になり、DB に書かない。

## 検証

実装時（最初の実装の後）と、`caller_epoch` の絞り・begin 経路の試験・試験名の変更を足した後（2026-11-21）の結果を並べる。

- Rust（`electron/native/grimodex-node`）
  - `cargo test` 全体：919 passed／7 ignored → **923 passed／7 ignored**（新しい試験 4 本：`a_begin_query_does_not_start_across_the_barrier_and_its_worker_is_retired`、`a_ready_worker_made_unrestricted_is_not_reused_after_activation`、`a_ready_worker_of_the_same_epoch_is_reused`、`a_queued_query_of_a_worker_from_an_older_epoch_is_not_started`）。
  - `cargo test nir1_graph_product` 139 passed／1 ignored。`cargo test related_scenes` 129 passed。
  - `cargo test --features nir1-graph-eval nir1_graph_eval`：20 passed → 20 passed。
  - `cargo clippy --all-targets -- -D warnings` は feature なしとありの両方で成功。
- node（Node 22）
  - quality-workflow／nir1-graph contract：57 pass → 57 pass。`native-architecture.test.mjs` 26 pass。
  - observation-prep／native-architecture／eval-fixtures は 147 件で、`observation-prep` の `S2 追補 … the bytes pins hold every non-test harness file …` が 1 件落ちる。原因は `origin/master`（`ce1b621f`）がこの枝の base（`a9f1d540`）より進んでいて、`isAncestor(origin/master, HEAD)` が成り立たないこと（この PR の変更とは無関係。master の取り込みで解消する見込み）。
  - この PR が足した `caller_epoch` の拒否の answer が `busy` だと、`native-architecture` の「Busy の answer と cause の hook の数が合う」検査（12 answers, 11 hooks）が落ちたので、`warming` に改めた（上の K32R-2）。
- `index.d.ts` は `napi build` で再生成し、差分は doc コメントの 3 行だけ。
- `validate:architecture` と `fnm exec --using=22 pnpm -s verify:quality` は成功。
- K32R-8（反証の F1 の直し）の後（2026-11-21）：
  - `cargo test` 全体 **928 passed／7 ignored**（923 → 新しい試験 5 本）。`cargo test nir1_graph_product` 139 passed／1 ignored、`cargo test related_scenes` 134 passed、`cargo test --features nir1-graph-eval nir1_graph_eval` 20 passed。
  - `cargo clippy --all-targets -- -D warnings` は feature なしと `nir1-graph-eval` ありの両方で成功。
  - Node 22 の `native-architecture.test.mjs` 26 pass。
  - `p7_an_unrestricted_profile_goes_on_to_the_worker_after_registration` は `Available` を確かめる形に直した。
  - 未確認：click の handle が Some の行の動的な廃棄と、`graph_continue(Await)`／`nir1_evidence_qualify` を lease の結合で通す試験（K32R-8 の「限界」）。
- K3/2 の draft（SHA-256 `a16e8b25…` が台帳と manifest に束縛）と、この改訂の draft（SHA-256 `148fc995…` が台帳に束縛）は編集していない。

## 再反証の結果（2026-11-21。DR を見せない独立の反証。判定は「軽微のみ」）

- F1 は閉じている。
  - activation の後は、lease の slot（Cached・deliver 済みの Pending）と click の handle から、restricted の caller に何も返らない。
  - 同じ形の別の経路（owner の cache、ticket、worker、graph-ready の後の取り直し、D-final）も残っていない。
  - unrestricted の通常の経路も壊れていない。
- 軽微 1（直した）：`await_request` の K32R-8 の再検査が、cache hit の window の guard（`CachedWindowRelease`）より前にあった。そのため、gate が閉じた早期 return で window が残りえた（LP-GATE の「全 exit で解放」に反する）。
  - 再検査を guard の後ろへ移した。
  - source の順序の試験に「guard < 最初の gate」を足した。
- 軽微 2（限界として残す）：`await_request` と `click` を、実際の Graph-only の行の handle を持つ lease で通す試験は無い。`ClickEntry` が node crate から作れないため。
  - 単体の試験と source の順序の試験で固定している。
  - `inner.click = None` は、`discard_if_rebound` が冪等なので、冗長な防御である。
- 注記（範囲外、別の lane）：`qualify_evidence` の R／IR の navigation の側は、unrestricted で作った lease の handle を、restricted の caller でも通す。
  - 既存の挙動で、K3/2 の Negative (3)（Graph の規則）の範囲外である。
  - 同じ形の「activation より前に作った結果が後に返る」経路なので、扱うなら別の lane で起案する。
- 修正の後の検証（`electron/native/grimodex-node`）
  - `cargo test related_scenes` 134 passed、`cargo test --features nir1-graph-eval nir1_graph_eval` 20 passed。
  - clippy は 2 通り（feature なし、nir1-graph-eval あり）とも通過。
  - Node 22 の `native-architecture.test.mjs` 26 pass。
