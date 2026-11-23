# スナップショットの復元の書き込み停止を短くする（判断の記録）

- 対象：`src-tauri/crates/grimodex-db/src/project_snapshots.rs` の `apply_project_snapshot_restore`。大きい作品（場面 1,000・`scene_codex_mentions` 12 万行・変更履歴 100 万行）で本文を復元すると、書き込みが約 50〜80 秒止まる。最大の原因は、挿入した行ごとの所有の検査（`ensure_inserted_row_is_project_scoped`）を 1 件ずつ SQL で行うこと（場面数×行数に比例する）。次が、行ごとの表情報（存在・主キーの列・列の一覧）の引き直し。
- **この修正は、NIR-1 の残レーンの委任の外である。** 直し方は、ユーザーが確認 126（2026-11-23。PR #1029 の後すぐ、別の lane で直す）と確認 134（2026-11-23。下の表）で決めた。この文書は、その選択の範囲内の技術判断と信頼境界を記す。範囲を超える判断は、ここに書かず、ユーザーに伺う。決定の文言だけでは決められない点は、今の動きを変えない側で組む。
- この文書は、守りの試験の追加の段（**製品のコードを変える前**）で置いた。実装（所有の検査の置き換え）は次の段で行い、実装で決めた細部は後の DR として足す。
- 計画：`fusion-eval-data/design-notes/editor-scene-interpretation-2026-11-21/restore-insert-perf-plan.md`（試作と差分試験の結果は第 2〜5 節）。試作は scratchpad の複製で、この PR には取り込まない（実装の段で、PR #1029 の merge 後の master から作り直す）。
- 前の直し：[snapshot-restore-cross-scope-decisions.md](snapshot-restore-cross-scope-decisions.md)（DR-SRX。PR #1029）。この時間は PR #1029 より前からあり、PR #1029 は増やしていない。

## 1. ユーザーの決定（2026-11-23、確認 134）

| 確認 | 要旨 | この文書での扱い |
|---|---|---|
| N1 | 所有の検査を「1 行ずつ」から「まとめて 1 回で評価する形」に変えてよい。条件：拒む行・理由・エラー文言・先後は変えない。**守りの試験を先に足し、変更前の実装で合格し、守りを壊す変異で赤くなることを確かめてから、実装を変える** | DR-RIP-1〜5 |
| N2 | 時間の閾値を置かない。before／after を記録する | DR-RIP-6 |
| N3 | PR は 1 本。守りの試験は、同じ PR の最初の commit | DR-RIP-9 |
| N4 | 複合主キー表の、所有を判定する親列とは別の列の既存の穴は直さず、記録だけする | DR-RIP-8 |
| N5 | 変更履歴（`change_events.scene_id`）の退避・戻しは、N1 の効果を製品の経路で測ってから決める | DR-RIP-7 |

確認 126・134 の記録は contracts にある。この文書では要旨だけを書く（文言の正本は contracts）。

## 2. 信頼境界：なぜ検査を弱めないか

`ensure_inserted_row_is_project_scoped` は信頼境界である。保存済みスナップショットの aux 行（`project_snapshot_aux.payload_json` の `rows`）が、別の作品の親（board・場面・Snippet など）を指す場合を拒む。外部キーは作品を見ないので、親が実在すれば通ってしまう。次の検査では代わりにならない。

| 検査 | 守ること | この変更での扱い |
|---|---|---|
| `ensure_inserted_row_is_project_scoped`（挿入後に所有の連鎖を確かめる） | 保存済みスナップショットの aux 行が別作品の親を指す場合を拒む。親が消えた行も、遅延外部キーより前に理由つきで止める | **やり方だけを変える。** 同じ predicate（`AUX_SPECS`／`project_id`）を同じ表で SQLite に評価させる。エラー文言・先後は同じ |
| `ensure_restore_plan_is_snapshot_derived`（欠落・不一致・余分・重複） | renderer の plan と Native の正規 plan の食い違いを、ワイプの前に止める | 判定は変えない。表の情報の引き直しだけをやめる。**この検査は、保存済みスナップショットの子の行が別作品の親を指すことは防げない**（renderer の plan も Native の plan も、同じ保存済みの行から作るので一致する） |
| `ensure_snapshot_owned` | 別作品のスナップショット id で他作品のデータを復元する攻撃 | 触らない |
| apply 冒頭の payload 検査 | 選択範囲外の表・replace の誤用・別作品の `project_id` | 触らない |
| `insert_record` の列・値の検査 | 識別子の注入、存在しない列、スカラー以外の値 | 触らない。表の情報の引き直しだけをやめる |

実験での確認（計画の第 3・4 節）：検査を無効にして `map_stickies` の `board_id` を別作品の board に書き換えると、復元が成功し、付箋が別作品の board 配下に入った。冗長ではない。

### 2.1 守っていなかった試験（この段の動機）

計画の第 4.3 節：**所有の検査だけを無効にしても、既存の試験（`project_snapshots` の lib 試験、`snapshot_restore_cross_scope`、`snapshot_restore_feed_continuity`、`narrative_scope_storage_authority`）は 1 件も赤くならなかった。** エラー文言を assert する試験も無かった。このまま最適化すると、守りが壊れても気づけない。そこで、実装の前に守りの試験を足す（N1 の条件）。

### 2.2 守りの試験（`snapshot_restore_scope_guard.rs`）

**変更前の実装（枝 `claude/restore-insert-scope-batch`、master `7a0b64976`）で全件合格する。** 本物の `apply_project_snapshot_restore` を通し、保存済みスナップショットの aux の payload を書き換えて「改ざんされた DB file」を作る（renderer の plan は同じ書き換え後の行から作る）。別作品（`probe-p2`）には、`probe-p1` の全表の行の複製を作る（`x-<id>`。書き換えた親が実在し、外部キーが何も言わない状態）。

| 固定すること | 試験 |
|---|---|
| 12 表（`map_stickies`・`map_node_positions`・`map_edges`・`codex_entry_tags`・`codex_detail_values`・`scene_codex_mentions`・`scene_codex_pins`・`post_effect_annotations`・`scene_events`・`event_participants`・`foreshadow_setups`・`snippet_entry_tags`）と、`tree_node_labels`・`lint_ignored_diagnostics`・`foreshadow_payoffs`・`codex_entry_phases` の親が別作品の id のとき、**範囲が自分の scope のときも全 scope のときも**、`project snapshot insert for '<table>' is not scoped to project '<project>'` で拒否する。拒否のあと、全表の内容が拒否の前と一致し（rollback）、parked の残りが無い。書き換えを戻した同じ DB の復元は通る（対照） | `a_row_whose_parent_is_another_projects_is_refused` |
| 親が存在しない id でも、同じ文言で拒否する | `a_row_whose_parent_does_not_exist_is_refused_in_the_same_words` |
| `map_stickies` 701 行（塊の境界 199・200・399・400 と、先頭・最後）のどこに不正行があっても拒否する。複数の不正行、全行が不正でも拒否する。複合主キーの `scene_codex_mentions` 700 行でも同じ | `a_bad_row_is_refused_at_the_start_inside_the_edges_and_the_end_of_a_long_table`、`several_bad_rows_in_a_long_table_are_refused`、`a_bad_row_in_a_composite_key_table_is_refused_wherever_it_sits` |
| 2 表が不正なときは、plan 順で先の表の名前が出る（アルファベット順と違う組を含む。改ざんの順は問わない） | `when_two_tables_are_bad_the_first_in_plan_order_is_named` |
| 受入れ：全 scope・各 scope の復元が通り、aux の行がスナップショットのとおりに戻る。別作品の行は変わらない。1 表が 200 行を超える復元が通る | `a_restore_of_every_scope_goes_through_and_puts_every_aux_row_back`、`a_restore_of_each_single_scope_goes_through`、`a_table_longer_than_one_chunk_is_restored` |
| 複合主キーの表の復元と、所有の列の確認 | `composite_key_rows_are_restored_and_their_ownership_column_is_checked` |
| 存在しない表の skip、存在しない表への plan の行、主キーの無い表、`SnapshotRestoreTable` に無い表名の拒否（従来のエラー文言） | `a_table_that_does_not_exist_is_skipped`、`a_plan_row_for_a_table_that_does_not_exist_is_refused`、`a_table_without_a_primary_key_is_refused`、`a_table_the_restore_does_not_know_is_not_a_restore_table` |
| plan の検査：欠落・余分・不一致・plan 内の重複・スナップショット内の重複の各文言と、先後（欠落、余分、不一致の順） | `a_plan_that_omits_a_snapshot_row_is_refused`、`a_plan_with_a_row_outside_the_snapshot_is_refused`、`a_plan_row_that_differs_from_the_snapshot_is_refused`、`a_plan_with_a_row_twice_is_refused`、`a_snapshot_that_holds_a_row_twice_is_refused`、`the_plan_checks_run_in_the_order_missing_extra_mismatch` |
| `insert_record` の検査：存在しない列、SQL を注入する列名、スカラーでない値の文言と、列が値より先、挿入の失敗が所有の失敗より先 | `a_column_the_table_does_not_have_is_refused`、`a_column_name_that_would_inject_sql_is_refused`、`a_value_that_is_not_a_scalar_is_refused`、`a_column_check_comes_before_a_value_check`、`an_insert_fault_comes_before_an_ownership_fault` |
| 別作品の `project_id` の行の、戸口での拒否（所有の検査より前） | `a_plan_row_of_another_projects_is_refused_before_the_insert` |
| 改ざんされた行があっても、確認画面の context は読める | `the_context_of_a_restore_is_unchanged_by_the_hostile_rows` |
| **既知の穴を、今の動きのまま固定する**（DR-RIP-8。穴を塞ぐときに意図して直す） | `known_gap_a_composite_key_rows_second_parent_is_not_ownership_checked`、`a_composite_key_rows_second_parent_that_does_not_exist_stops_at_the_foreign_key` |

試験が届かないところ（変更前の実装でもそうである）：

- コア表（`tree_nodes`・`codex_entries`・`snippets`）の所有の検査。canonical の plan が `project_id` を作品の値に固定するので、保存済みスナップショットの行では、別作品の行を指せない（主キーが衝突すれば、所有の検査の前に UNIQUE 違反で止まる）。
- `authorship_spans`：親を書き換えた行は、`reshape_authorship_inserts` が、復元する文書の行だけに絞るので、所有の検査に届く前に落ちる（拒否されない）。`foreshadow_setup_payoff_links` の `setup_id` を書き換えた行は、canonical の plan に無いので、plan の検査（余分）が先に拒む。
- 所有規則の無い表（`has no ownership rule`）：`SnapshotRestoreTable` が閉じた集合で、`AUX_SPECS` とコア表のどれかに必ず当たるので、公開 API からは届かない。
- 所有の検査の中の「表が存在しなければ黙って Ok」と、主キー無しの `has no primary key`、キー欠落の `is missing '<column>'`：plan の検査（`unavailable table`・`has no primary key`・`missing primary key`）が先に同じ入力を止めるので、所有の検査の側は到達しない。実装で到達の有無が変わる場合は、実装の段で試験を足す。

## 3. 変異への耐性

変異の結果は §7 に記録した。

## DR-RIP-1　やること・やらないこと

- やる（実装の段）：所有の確かめ方を、行ごとから、表ごとに 200 行の塊でまとめる。表の情報を復元ごとに 1 回だけ引く。`insert_record` は `prepare_cached` にする。
- やらない：拒む行・拒む理由・エラーの種類と文言・エラーの先後を変えない。schema の版、migration、列、索引、閾値、保存の範囲、送信先、書き手の authority を変えない。`change_events` の退避と戻し（DR-SRX-9）、feed、digest、binding は触らない。新しい契約・authority を足さない。

## DR-RIP-2　所有の確かめ方（案 1）

- 同じ predicate（`AUX_SPECS`／`project_id` の所有規則）を、同じ表で、SQLite に評価させる。主キーの比較は bind 値を SQLite に比較させる（列 affinity の規則も従来どおり）。Rust 側で値を比較し直さない。
- 塊ごとに、最初に所有の外だった行の位置を求める。plan 順で最初の不正行を、従来のループのその位置（その行の scene binding の前）でエラーにする。複数の表が不正でも、従来と同じ表のエラーにする。
- エラー文言：`project snapshot insert for '<table>' is not scoped to project '<project>'`、所有規則が無い表は `has no ownership rule`、主キーが無い表は `has no primary key`、キー欠落は `is missing '<column>'`。表が存在しなければ黙って Ok。いずれも変えない。
- 選ばなかった案：検査の削除（守りの削除。§2）、plan の導出検査に任せる（同上）、Rust の集合による検査（predicate の二重管理と、型・affinity の違いで拒む行が変わる危険）、SQL の書き換え（JOIN や一時表。意味の保証が弱い）、試験の側で checkpoint を切る（製品の動きと別）。

## DR-RIP-3　表の情報のキャッシュ

- 表の存在、主キーの列、列の一覧を、復元ごとに 1 回だけ引く。`normalized_insert`（expected と incoming の 2 回）、`insert_record`、所有の検査が使う。
- 復元をまたいで持たない。復元の transaction 内で DDL が走らない前提を、コメントと試験で固定する（実装の段）。`insert_record` の外部呼出し（snapshot 作成側 3 か所）は、呼出しごとに空のキャッシュを使い、従来と同じ挙動。

## DR-RIP-4　エラーの先後と失敗の扱い

- 所有の検査は、挿入の後・scene binding のループの前に、全行ぶんまとめて行う。キー欠落・非スカラー・所有規則なし・主キーなしは、行位置つきのエラーにして、先後を従来と一致させる。
- SQLite の実行時エラー（prepare 失敗など）は、その表の最初の行の位置つきの遅延エラーにして、先後を従来と一致させる（反証の low 指摘の対応）。正しい schema では起きない。
- binding が書く表（`narrative_scene_scope_bindings`・`narrative_scope_registries`・`grimodex_write_clock`）は、所有の predicate が読む表に影響しない（トリガーを確認済み）。

- **前提（DR-SRX-25）**：退避の窓の中で動く code は、根の DELETE・`insert_record`・`ensure_inserted_row_is_project_scoped`・場面の適用範囲の 2 関数だけで、どれも退避した列を読まない。まとめ評価の新しい照会も、退避した列を読まない形にする（実装の段で確かめ、この節に足す）。
- **先後で固定していないもの**：所有の検査の失敗と scene binding の失敗の先後（今は行ごとに、行 i の検査、行 i の binding、行 i+1 の検査の順。まとめ評価では全行の検査が先に走るので入れ替わりうる）。binding の失敗を作る入力が作りにくく、試験は無い。実装の段で、試験を足すか、PR 本文に残る制限として書く。

## DR-RIP-5　守りの試験を先に足す（この段）

- 実装の前に、守りの試験（`tests/snapshot_restore_scope_guard.rs`）を足し、変更前の実装で合格することを確かめた（§2.2）。同じ PR の最初の commit にする（N3）。
- 守りを弱める変異を一時的に入れ、新しい試験と既存の試験のどれが赤くなるかを記録した（§7）。赤くならなかった変異は、試験を足して赤くなるようにした（足した試験も、変更前の実装で合格する）。
- 実装の後に、同じ変異を、新しい実装の同じ意味の箇所へ入れ直す（所有の検査の無効化、キー条件を外す、最終塊を飛ばす、先頭行だけ検査、塊の境界の誤り）。結果を PR 本文に載せる。

## DR-RIP-6　性能の記録と閾値

- 閾値を置かない（N2）。性能は ignored の測定試験で記録し、閾値の assert は置かない（負荷で 70 から 32 秒まで動く）。PR 本文に、低負荷・release・同じ DB 形・交互 2 回ずつの before／after を載せる。時間の目標はユーザーが決める。
- 試作の参考値：apply 本体 53.6／51.7 秒から 18.5／18.6 秒（別に checkpoint 約 6〜9 秒）。

## DR-RIP-7　残る時間の扱い

- `change_events.scene_id` の退避と戻し（約 9〜14 秒）と、同期 checkpoint は、この PR で触らない。退避と戻しは PR #1029 の DR-SRX-9（確認 115。元の値に戻すことだけができる限った関数）の設計に関わる。**N1 の効果を、製品の経路（WorkspaceAuthority。背景 checkpoint あり。試験の Database::new は背景 checkpoint が無いので、その経路の測定を代わりにしない）で測ってから決める**（N5。確認 134 の文言）。決めるときは、確認 115 の範囲を超えない形（例えば行ごとの UPDATE を、同じ値を戻す 1 文にする）を測ってから、改めて伺う。
- feed の capture・digest（約 3.9 秒）と、場面ごとの定数項（約 2.5 秒）も触らない。

## DR-RIP-8　既存の穴（この PR では直さない）

- 複合主キー表（`tree_node_labels.label_id`、`event_participants.codex_entry_id`、`foreshadow_codex_links.codex_entry_id`、`scene_codex_mentions.codex_entry_id`、`scene_codex_pins.entry_id`、`map_node_positions.tree_node_id`、`authorship_spans.codex_entry_id` ほか）で、所有を判定する親列とは別の列が別作品を指す行を、変更前も変更後も通す。所有の predicate が 1 つの親列だけを見るため。変更前後で出力が行単位に一致する（試作の差分試験で確認）。
- 確かめたこと（この段の試験）：この穴に届くのは、その親の scope も一緒に復元する場合だけである（`scene_codex_mentions.codex_entry_id` は Body＋Codex、`tree_node_labels.label_id` は Labels＋Body）。親の scope を復元しない復元では、canonical の plan がその行を落とすので、plan の検査（余分）が先に拒む。別の親が存在しない id のときは、所有の検査ではなく、遅延外部キー（`Error code 787`）が commit で拒む。
- 直すと拒む行が変わるので、この PR では直さない（N4）。穴を今の動きのまま固定する試験（`known_gap_...`）を置いた。塞ぐときは、決定の記録とともに意図して直し、その試験も更新する。ユーザーが別 lane を決めるまで、PR 本文に明記する。脅威は、スナップショット表への書込み権限（DB file の改ざん）を要するので小さい。

## DR-RIP-9　PR の順序

- PR #1029 の merge の後に、master から枝を切る（この枝は `7a0b64976` から）。`project_snapshots.rs` が重なるので、それ以前には始めない。試作の patch は当てず、作り直す。
- PR は 1 本（N3）。最初の commit が守りの試験（変更前の実装で合格）と、この判断の記録。次の commit が実装。commit は作業ブランチで、変更ファイルを明示して stage する。master に直接 commit／push しない。
- この作業記録（[nir1-continuation-2026-10.md](../nir1-continuation-2026-10.md)）に、ID と記録先を載せた（この lane は NIR-1 の委任の外なので、ID を載せることへのユーザーの個別の了承は取っていない。PR #1029 の DR-SRX と同じ扱いにした）。

## 4. 委任との関係

この lane は、NIR-1 の残レーンの委任に含まれない。委任に含まれないもの（秘密・データの新しい送信先、保存範囲の拡大、閾値の緩和、製品公開、製品認可の削除、新しい契約・authority）は、この変更に含まない。この変更は、拒む行・理由・文言・先後を変えない実装の最適化であり、`change_events` の書き込みの権限（確認 115）にも触れない。

## 5. 未実施・範囲外

- 実装（所有の検査の置き換え、表の情報のキャッシュ）。次の段。
- 性能の測定（この段では測らない）。
- 差分試験（変更前後の復元結果のハッシュの一致。実装の段で、ignored の試験として足す）。
- `change_events` の退避・戻し、同期 checkpoint、feed の capture（DR-RIP-7）。
- 複合主キー表の別列の所有の検査（DR-RIP-8。N4：直さず記録だけ〔確認 134〕。別 lane にするかは未決）。

## 6. 試験の置き場所

- `src-tauri/crates/grimodex-db/tests/snapshot_restore_scope_guard.rs`（`cargo test -p grimodex-db --test snapshot_restore_scope_guard`）。`snapshot_restore_cross_scope.rs` の `new_db`・`seed_rich`・`snapshot`・`plan`・`restore` の作り方を複製した（別の試験 file の helper は import できない）。

## 7. 結果（変異の実験）

基点：枝 `claude/restore-insert-scope-batch`（master `7a0b64976`）、製品のコードは変更前のまま。`project_snapshots.rs` に変異を **一時的に** 1 つずつ入れ、新しい試験（`snapshot_restore_scope_guard`、29 件）と、既存の 4 つ（`snapshot_restore_cross_scope` 34 件、`snapshot_restore_feed_continuity` 38 件、`narrative_scope_storage_authority` 6 件、lib の `project_snapshots` 35 件）を回した。変異のたびに原本から元に戻し、`git diff --stat` が空であることを確かめた。変異なしでは、5 つとも全件合格。

| 変異 | 新しい試験 | 既存の 4 つ |
|---|---|---|
| (a) 所有の検査を常に Ok | 8 件が赤（親が別作品・親が不在・長い表・複合キーの表・plan 順・確認画面の context ほか） | **全部合格（赤にならない）**。守られていなかった |
| (b) 主キーの条件を外す（表に所有の行が 1 つでもあれば通す） | 3 件が赤（長い表の位置・複数の不正行・複合キーの長い表）。1 行だけの表では、外しても結果が変わらないので、長い表の試験でだけ検出する | 全部合格 |
| (c1) plan の最後の行だけ検査しない | 2 件が赤（`a_row_whose_parent_...` の 2 つ。出所の記録を除いた変種）。**最初の版の試験では、赤にならなかった**（復元が出所の記録の行を plan の最後に足すので、不正行が最後にならない）。出所の記録を除いた変種を足して、赤になるようにした | 全部合格 |
| (c2) 各表の最後の行だけ検査しない | 7 件が赤 | 全部合格 |
| (d1) plan の最初の行だけ検査する | 8 件が赤 | 全部合格 |
| (d2) 各表の最初の行だけ検査する | 3 件が赤（長い表の位置・複数の不正行・複合キーの長い表） | 全部合格 |
| (e) plan の導出検査：欠落の検査を無効 | 2 件が赤（`a_plan_that_omits_a_snapshot_row_is_refused`、検査の先後） | lib の 1 件が赤（`restore_rejects_omitted_snapshot_rows_before_wiping_live_data`）。ほかは合格 |
| (e) 同：余分の検査を無効 | 2 件が赤（`a_plan_with_a_row_outside_the_snapshot_is_refused`、検査の先後） | 全部合格 |
| (e) 同：不一致の検査を無効 | 1 件が赤（`a_plan_row_that_differs_from_the_snapshot_is_refused`） | lib の 2 件が赤（`restore_plan_cannot_rebind_a_snapshot_child_to_another_project`、`restore_rejects_same_snapshot_key_with_tampered_content`） |
| (e) 同：plan 内の重複の検査を無効 | 1 件が赤（`a_plan_with_a_row_twice_is_refused`） | 全部合格 |
| (e) 同：存在しない表の検査を無効 | 1 件が赤（`a_plan_row_for_a_table_that_does_not_exist_is_refused`） | 全部合格 |
| (e) 同：スナップショット内の重複の検査を無効 | 1 件が赤（`a_snapshot_that_holds_a_row_twice_is_refused`） | 全部合格 |
| (f) `insert_record` の列の検査を無効（存在しない列・識別子の注入） | 4 件が赤（存在しない列、列名の注入、列が値より先、挿入の失敗が所有の失敗より先） | 全部合格 |
| (f) 同：スカラーでない値の検査を無効 | 1 件が赤（`a_value_that_is_not_a_scalar_is_refused`） | 全部合格 |

- **今まで守られていなかったもの**（既存の 4 つが、どの変異でも赤くならなかった）：所有の検査の全部（a〜d）、plan の検査の余分・plan 内の重複・存在しない表・スナップショット内の重複（e）、`insert_record` の列・値の検査（f）。欠落と不一致は、lib の試験が既に固定していた。
- 赤くならなかった変異（c1）は、試験を足して赤くした（足した試験も、変更前の実装で合格する）。変異の入れ方は、新しい実装（塊でまとめる形）では、同じ意味の箇所に入れ直す（DR-RIP-5）。塊の境界の誤りは、塊の大きさ（200）をまたぐ位置（199・200・399・400）の試験が検出する（現在の 1 行ずつの実装では、塊が無いので、この種の変異は新しい実装でしか入れられない）。
- 試験の所要時間：変更前の実装で約 46 秒（debug、並列、他のセッションと同居の負荷のもとで）。
