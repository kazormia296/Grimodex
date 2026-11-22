# スナップショットの復元で、選んでいない範囲のつながりが消える不具合（判断の記録）

- 対象：スナップショットの復元で、復元の範囲に選んでいない領域のつながり（出来事の参加者、場面の視点人物、Snippet の場面、伏線の位置、ラベル、地図の札、チャットのピン留め、ゴミ箱など）が、外部キーの CASCADE／SET NULL で消える不具合の修正。あわせて、Codex だけ・Snippet だけ・地図だけの復元で出所の記録（`authorship_spans`）が消えること、本文だけの復元が UNIQUE／FOREIGN KEY 違反で失敗する穴、復元が壊す変更履歴の hash chain、AI の未採用の本文の提案の扱い。
- この修正は、NIR-1 の残レーンの委任の外である。直し方（選んでいない範囲のつながりを、退避して戻す）は、ユーザーが選んだ（2026-11-22。確認 103・113〜117・121・122。記録は、枝 `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`、HEAD `fda13bb3d`）。この文書は、その選択の範囲内の、技術判断と信頼境界を記す。選択の範囲を超える判断は、ここに書かず、ユーザーに伺う。決定の文言だけでは決められない点は、いちばん保守的な側（今の動きを変えない側）で組み、PR 本文と作業の報告の「ユーザーに伺うこと」に書く。
- この文書の最初の版（DR-SRX-1〜14）は、製品のコードを変える前に置く。実装で決めた細部は、後の DR として足す。
- 前の直し（PR #1026、DR-SRC-1〜13）の文書：[snapshot-restore-feed-continuity-decisions.md](snapshot-restore-feed-continuity-decisions.md)。

## 1. 不具合

設計の調査（`fusion-eval-data/design-notes/editor-scene-interpretation-2026-11-21/wf52.json`。基点は #1026 の後の master）で、一時的な試験（実行後に削除）と読みで確かめた。製品のコードは、まだ変えていない。

### 1.1 実行で確かめたこと

- **選んでいない範囲のつながりが消える。** 復元は、選んだ範囲の根の表（`tree_nodes`、`codex_entries` など）を DELETE して入れ直す。外部キーの `ON DELETE CASCADE`／`SET NULL` が、選んでいない範囲の表の行を消す・NULL にする。豊かな合成状態で、範囲の持ち物を同一内容で入れ直す模擬（根の DELETE は製品と同じ SQL）をすると、退避なしでは範囲ごとに次の数の表が変化した（派生の索引を含む）：Codex 17 表、Body 23 表、Snippet 5 表、Map 2 表、Body＋Codex 27 表、全範囲 15 表。
- **Codex だけの復元の後、出来事・場面の編集が止まり続ける（PR #1026 の穴）。** Codex 項目の version が全て 0 で内容も同一だと、復元は実質 no-op（`no_op = true`、marker 0 件）になる。それでも、参加者（`event_participants`）が 2→0、出来事の主な人物・場所と、場面の視点人物・場所が NULL になり、出来事・場面の canonical snapshot の digest が head とずれる。marker が無いので DR-SRC-3 の免除も効かず、`NARRATIVE_CHANGE_FEED_DISCONTINUITY` で止まる。手で戻した模擬では、参加者＋出来事の列（出来事）、視点人物＋場所（場面）が揃うと、marker 0 件のまま通った。Codex 項目を writer で作ると version は 1 になり、復元で 0 に戻るので `no_op = false`（marker が書かれる）。
- **本文だけの復元が UNIQUE 違反で失敗する。** `authorship_spans` は `AUX_SPECS` で Body の持ち物だが、行は場面（`node_id`）・Codex（`codex_entry_id`・`phase_id`・`detail_value_id`）・Snippet・地図の付箋（`sticky_id`）のどれかを指す。本文の復元は場面を指す行だけを CASCADE で消し、canonical plan はスナップショットの全行を INSERT するので、Codex・Snippet を指す行は `authorship_spans.id` の UNIQUE 違反になる（Body だけ、Body＋Codex で Snippet の行が live のとき）。スナップショットの後に Snippet を消していると、入れ直す行が消えた Snippet を指して「not scoped to project」で失敗する。
- **Codex だけの復元で、出所の記録が消える。** `authorship_spans` の Codex を指す行が 1→0（`no_op = true` のまま）。
- **場面向けの AI 分析記録があると、本文だけの復元が失敗する。** 場面向けの `post_effect_runs` と、それを `run_id` で指す注釈がある作品で、本文だけの復元が `FOREIGN KEY constraint failed`（復元されず、run・注釈は 1 のまま）。project scope の run では通る。
- **復元が変更履歴の hash chain を壊す。** `change_events` の hash は `scene_id` を入力に含む。`tree_nodes` の DELETE で外部キーが `scene_id` を NULL にするので、検証側が NULL で再計算し、その行から hash mismatch になる。本文だけの復元の後、`scene_id` を持つ行 3 件が 0 件になり、mismatch が seq 1〜3 に出た。復元の前に保存した `(id, scene_id)` を、場面が在る行だけ戻すと mismatch は無くなった。**通常の場面削除でも同じ mismatch が出る**（復元と無関係の既存の穴。DR-SRX-13）。
- **本文の復元で、改稿履歴の一部が消える。** 場面の `content_versions` v1〜v3 のうち、スナップショットが指す v2 だけが残る（trigger `delete_cv_on_tree_node_delete`）。選んだ範囲の中の動き。
- **`change_events.scene_id` への UPDATE は、DB の側では拒まれない。** UPDATE を拒む trigger は無い。守りは、静的な書き手の検査（`validate-native-writer-ownership`、`validate-narrative-writers`）と、hash の再計算だけである。
- **Codex だけの復元が `FOREIGN KEY constraint failed` で失敗する場合がある（確認 121。この PR では直さない）。** スナップショットの時点で、Phase（場面ごとの設定の切り替え）の起点（`codex_entry_phases.anchor_node_id`）にしていた場面を、その後に削除した作品。Codex→Body の方向が live の id で絞られていないので、消えた場面を指す phase が入って外部キー違反になる。実際に動かして確かめた。
- 費用：debug build・ファイル DB（WAL）・合成データで、`change_events` 100 万行のとき、退避 9.2 秒＋戻し 9.3 秒（今の cascade の約 5 倍）。`scene_codex_mentions` 12 万行は、:memory: で退避 0.48 秒＋戻し 0.50 秒。DR-SRX-12 に詳細。

### 1.2 読んだだけ（実行していない）

- **地図だけの復元**で、`map_node_positions` の `snippet_id` が復元後に残る Snippet の id で絞られず、NULL に直すと「参照列がちょうど 1 つ」の CHECK に反するので、失敗するおそれがある（確認 121。この PR では直さない）。
- 復元で型（type）が変わった Codex 項目が、視点人物・参加者に残ること。type の規則が参加者・視点人物に見つからなかった（grep のみ）。確認 122 で、実際に動かして確かめ、結果を報告する（DR-SRX-13）。
- 派生の埋め込みの索引（`scene_chunks`・`codex_chunks`・`event_chunks`）は、復元の後に autoIndex の back-index が作り直すと読んだ（実行では未確認）。

### 1.3 作者から見える形

- 復元の後、場面の視点人物・出来事の参加者・Snippet の場面・伏線の位置・ラベルなどが、黙って外れる。確認の画面には何も出ない。
- Codex だけの復元の後、出来事・場面が編集できなくなることがある。
- 変更履歴（タイムラプスの検証）が、本文の復元の後に合わなくなる。
- データそのものは壊れない（外れるのは、つながりと、再生成できる記録）。

## 2. ユーザーの決定（2026-11-22）

出典は contracts の `user-confirmation-2026-11-22-chronicle-scene-review-apply.md`（HEAD `fda13bb3d`）。要旨だけを書く。文言の正本は出典である。

| 確認 | 要旨 | この文書での扱い |
|---|---|---|
| 103 | 選んでいない範囲のつながりは、退避して戻す。指す先が復元の後に無くて戻せないものは、復元の確認の画面で件数を知らせる | DR-SRX-3〜6、10 |
| 113 | Codex だけ（Snippet だけ・地図だけ）の復元では、本文の出所の記録（`authorship_spans`）を、スナップショットの時点の記録に戻す（本文と Codex を一緒に復元するときの、今の動きと同じ） | DR-SRX-7 |
| 114 | 本文の復元で、AI の未採用の本文の提案（`prose_staging`）は、復元の前後で本文が同じ場面の分だけ残す。本文が変わった場面の分は外し、外れる件数を知らせる | DR-SRX-8 |
| 115 | 復元の間だけ、`change_events` の `scene_id` を退避して戻す処理を入れる。元の値に戻すことだけができる、限った関数にし、許可された書き手の file（`grimodex-db` の `change_events.rs`）の中に置く。戻した行の hash が合うことを、試験で確かめる | DR-SRX-9 |
| 116 | 復元で改稿履歴（`content_versions`）の一部が消える動きは、この修正では変えない | DR-SRX-11 |
| 117 | 本文の復元で、場面の適用範囲の設定（`narrative_scene_scope_bindings`）が、新しい incarnation の unknown で作り直される動きは、変えない（`scope-default-decisions.md` の M10・M20、x1-4 の DR-X1-4-22）。作り直される件数を、知らせる欄に出す | DR-SRX-5、10 |
| 121 | Codex だけの復元が外部キー違反で失敗する穴（phase の anchor が、後で消えた場面を指す）と、地図だけの復元の穴（`map_node_positions` の `snippet_id`）は、この PR では直さない（次の公開の前に、別の PR） | DR-SRX-13 |
| 122 | 復元で type が変わった Codex の項目が、視点人物・参加者に残る件は、実際に動かして確かめ、結果を報告する（決めない。今回の実装は「同じ id なら戻す」のまま） | DR-SRX-13 |

設計の `userDecisions` の既定との違い：設計は、確認 113 の回答が出るまで「今の出所の記録を残す」既定で組む、と書いていた。確認 113 の回答（スナップショットの記録に戻す）が出たので、この文書は回答のとおりにする。確認 103 の件数の欄に、設計は場面の適用範囲の設定を出さない形にしていたが、確認 117 が「作り直される件数を出す」と決めたので、出す（DR-SRX-10）。

## 3. 判断

### DR-SRX-1　この修正がしないこと

- schema の版を上げない。migration を足さない。新しい列・表・索引を足さない（`change_events(scene_id, timestamp)` の索引は既にある。DR-SRX-12）。
- 閾値を変えない。保存の範囲と送信先を広げない。新しい契約・authority を足さない（`change_events` の書き手は、既に許可された `change_events.rs` のままで、新しい書き手の file を作らない）。
- 復元が、object ごとの変更の記録を足す形にしない（DR-SRC-1・2 のまま。退避して戻した行は、復元の前後で値が同じなので、変更の記録に出さない）。
- 確認 116・117・121・122 の範囲は、動きを変えない（DR-SRX-11・13）。
- どれかが要ると分かったときは、実装せず、ユーザーに伺う。

### DR-SRX-2　直し方の全体：退避して戻す

復元の transaction の中で、次の順にする（今の復元の順序を変えず、退避と戻しの 2 点を足す）。

1. `feed_before` を捕える（今の位置。退避の前）。
2. `PRAGMA defer_foreign_keys = ON`。
3. **退避**：選んでいない範囲の子の行の、参照の列を、復元で消える根の id を指すものに限り、接頭辞つきの値に書き換える。
4. 根の DELETE（今の `delete_for_project` 群）。
5. 入れ直し（canonical plan の INSERT。場面の適用範囲の設定の作り直し、`ensure_scene_scope_binding_in_tx` と `refresh_scene_scope_source_token_in_tx` もここ）。
6. **戻し**：入れ直しの直後、`feed_after` の前に、親が同じ id で在る行を元の値へ戻し、戻らなかった行は、外部キー本来の動き（CASCADE なら行を DELETE、SET NULL なら NULL）にする。
7. `feed_after` を捕える。
8. commit の前に、`PRAGMA foreign_key_check` と接頭辞の残りの検査を行い、残れば復元を失敗させる。

`feed_before` が退避の前、`feed_after` が戻しの後なので、戻した行は変更の記録の差分に出ない。戻せなかった行があるときは、親が消えている＝選んだ範囲の表の digest が変わるので、`no_op` でなく marker が書かれる。念のため、`no_op` の判定に「戻せなかった行が 0 件」を足す（二重の守り）。

**今の master の退避との関係（コードを正として書く）。** 今の `project_snapshots.rs` には、`map_node_positions` の `tree_node_id`・`codex_entry_id` だけを接頭辞つきの値で退避する `park_map_reference`／`restore_parked_map_reference` と、`editor_stickies` を一時表（`temp.__grimodex_editor_sticky_restore_park`）にコピーして、復元の後に `INSERT OR IGNORE` で戻す `park_editor_stickies`／`restore_parked_editor_stickies` がある。後者は行のコピーなので、設計が「既存の park と同じ in place」と書いた点と、コードが食い違う（コードは 2 種類の形が混在する）。新しい実装は、両方を一般の仕組みに吸収し、`editor_stickies` も in place にする（行の主キー・`rowid`・`created_at` が変わらない）。吸収で、`editor_stickies` の phase の条件（同じ項目に属すること）が、列ごとの存在判定に変わる。phase の id は項目に固有なので実害は無い見込みだが、試験で確かめる。

**却下した案。**

- **一時表へ行をコピーして戻す。** `editor_stickies` の今の形。行の主キー・`rowid`・多段の子（地図の辺など）・FTS が、DELETE の CASCADE で先に消え、入れ直すと別物になる。メモリ上のコピーも同じ。大きい表（`change_events` 100 万行）では、コピーのほうが重い。
- **差分復元（スナップショットと live を比べて、変わった行だけ直す）。** 復元の意味（根の DELETE→入れ直し）と canonical plan の一致検査（renderer と Native の plan が同じ行を作ること）を変える。変更の範囲が、この修正の目的より大きい。
- **復元の間だけ外部キーを止める。** SQLite は transaction の中で `PRAGMA foreign_keys` を変えられない。変えられたとしても、CASCADE を止めると、選んだ範囲の中の子の行まで残ってしまう。

in place の退避は、子の参照の列を `'__grimodex_restore_park_<snapshotId>__' || col` に書き換える。この値は外部キーの親のどの行とも一致しないので、根の DELETE の CASCADE／SET NULL が当たらず、行は物理的に残る（主キー・`rowid`・`created_at`・FTS・多段の子の行も無傷）。SET NULL の列も、元の値は列自身が持つので、`(表, 主キー, 列, 元の値)` を別に持つ必要が無い。退避中も、持ち主の行は残る（持ち主が選ばれていない範囲の表で、根の DELETE の連鎖に入らない）。

### DR-SRX-3　退避する列は、導出する。固定の一覧との照合の試験で見張る

- 退避の列は、手で書き並べない。範囲の集合 S ごとに、実行時に `PRAGMA foreign_key_list` と範囲の持ち主（`AUX_SPECS` の `owner` と、根の表）から導く。
  1. S の根の表の DELETE と、S が持つ表の CASCADE をたどって「消える表」の集合を作る。
  2. 消える表を親にする外部キーの列を `PRAGMA foreign_key_list` から取る。
  3. そのうち、子の表の持ち主が S に含まれないものだけを、退避の列とする。直接の外部キーと 2 段目を混同せず、親が消える表を全部拾う（反証で、`scene_lens_data.target_id` が `tree_nodes` への直接の CASCADE であることが分かり、run の列だけでなく `target_id` も退避の列に入れる形に直した）。
  4. 除外（DR-SRX-5）を除く。
- `authorship_spans` だけは、列ごとに持ち主を決める（DR-SRX-7）：`node_id`→Body、`codex_entry_id`・`phase_id`・`detail_value_id`→Codex、`snippet_id`→Snippet、`sticky_id`→Map。
- 表名・列名は、定数の一覧から静的な文を生成する。表名を変数にした動的 SQL は、`validate-native-writer-ownership` の検査をすり抜けるので使わない。一覧を定数にし、静的な文を作る関数の試験で固定する。
- **見張り**：導出した退避の列を、範囲ごとの固定の期待一覧と照合する試験を置く。schema が変わって導出が変わると、試験が失敗し、人間が分類し直す（親が消える表と持ち主の分類を決め直す）。`scene_lens_data.target_id` の漏れの再発を、この照合で防ぐ。設計の調査では、導出した列の数が、範囲ごとに Body 20、Codex 20、Snippet 5、Map 2、Foreshadow・Labels・Lint 0、Body＋Codex 31、全範囲 22 だった。ただし、設計と反証で数が食い違った（Codex 20／21、Body 20／21、全範囲 22／20）。持ち主の振り分けの違いと見られるが、導出が見えない。実装で、分類を人間が確定してから期待一覧に固定する。この食い違いの解消も、この試験で見張る。
- 根の表への RESTRICT／NO ACTION は、`codex_types` を指す 4 列だけで、範囲内（設計の調査）。範囲外に増えたら、照合の試験が失敗する。

### DR-SRX-4　戻しの規則

退避した列の元の値 v について、復元の後の実際の DB で、親の表に `id = v` の行が在れば、v に戻す。無ければ、その外部キーの `ON DELETE` の動き（CASCADE なら行を DELETE、SET NULL なら列を NULL）を、自分で実行する。全列について、「戻す」をまとめて先に、「片付ける」を後でまとめて行う。

- 選んだ範囲の親は、スナップショットの行が入れ直されるので、スナップショットに在る id だけが残る。選んでいない範囲の親は、触らないので全て残る。
- 「同じ id なら同じもの」とみなす（場面の中身が別の版でも、つながりは戻す）。type が変わった項目の扱いは確認 122（DR-SRX-13）。
- 選んだ範囲の表の行は、スナップショットの値が優先で、退避の対象にしない（退避した値で上書きしない）。Body と Codex を同時に選ぶ場合、Body 持ち・Codex 持ちの表は退避せず、今の canonical plan の入れ直し（Codex を選べば絞り込みなし、選ばなければ live の Codex を指す行だけ）がそのまま働く。退避は選ばなかった範囲の表だけなので、主キーは衝突しない。
- 戻しの条件は、接頭辞の範囲検索（`col >= prefix AND col < prefix || '~'`）にして、索引を使う。`substr` 形は索引が効かず、全表走査になる（費用の実測で確かめた。DR-SRX-12）。**ただし、索引が在る列だけ**である。実スキーマの `EXPLAIN QUERY PLAN` では、退避の列 39 本のうち 10 本（`chat_sessions` の 3 列、`events` の 3 列、`lint_action_log.scene_id`、`map_node_positions` の 2 列）は索引が無く、子の表の全表走査になる（DR-SRX-22）。小さい表が大半で、`lint_action_log` は追記専用の記録のため、大きい作品では 1 回の復元で 6 回走査する。索引は schema の変更なので、この PR では足さない（DR-SRX-1）。
- 多段の子（`foreshadow_setup_payoff_links`、`map_edges` など）は、退避中も親の行が残るので、残る。指す先が無い親の行だけが DELETE され、その子が CASCADE で消える。
- 件数の数え方（DR-SRX-10）は、この規則と同じ関数（消える親の id の計算）を共有する。

### DR-SRX-5　除外

| 除外 | 理由 |
|---|---|
| 派生の埋め込みの索引（`scene_chunks`・`codex_chunks`・`event_chunks`） | `content_hash` で検証される索引で、復元後の本文では古い埋め込みは使えない。back-index が作り直す（読みのみ）。作者に見える変化は無い見込み |
| 場面の適用範囲の設定（`narrative_scene_scope_bindings`） | 確認 117。復元では、新しい incarnation の unknown で作り直し、復元前の eligibility token を失効させる契約（`scope-default-decisions.md` の M10・M20、DR-SDEF-6・7、x1-4 の DR-X1-4-22、journey `snapshot-body-restore-recreates-bindings`）。戻すと、契約を改める別の起案になる。**作り直される件数は、知らせる欄に出す**（DR-SRX-10） |
| 改稿履歴（`content_versions`） | 確認 116。DR-SRX-11 |

派生の索引 3 表と束縛は、退避の列の導出から外す。束縛は、導出の対象から外すことを定数で明示し、照合の試験に「意図して除外」と書く。

### DR-SRX-6　戻すが、件数には出さないもの

次は、退避して戻す（確認 103 の範囲）。親が無くて消える・NULL になるものは、通常の削除と同じ動きで、作者の判断に効かない記録なので、確認の画面の件数に出さない：`change_events.scene_id`、`ai_usage.scene_node_id`、校閲の行動記録（`lint_action_log.scene_id`）、派生のキャッシュ（`scene_beat_pov_cache` など）。

件数に出すもの（作者が気づきにくい種類も含む）：出来事の参加者、出来事の主な人物・場所、場面の視点人物・場所、場面の Codex の pin・言及、伏線と Codex の紐づき、Snippet のタグ、Snippet の場面、伏線の仕込み・回収の場面、場面のラベル、Phase の起点、校閲の無視、地図の札、エディタの付箋、チャットのピン留め・アンカー、ゴミ箱、取り込んだ出来事の承認（SRD/1 の RD6 の一種）、AI の分析記録、AI の本文の提案、場面の適用範囲の設定（確認 117）。種類の固定 id は DR-SRX-10。

### DR-SRX-7　出所の記録（`authorship_spans`）の則（確認 113）

- 行は、どの文書の範囲を指すかで、持ち主が決まる（列ごと。DR-SRX-3）。
- **入れ直す行は、「行が指す文書の範囲を選んでいるもの」に限る。** 選んでいない範囲を指す行は、live に既に在るので入れ直さず、退避して戻す。これで、本文だけの復元の UNIQUE 違反と、消えた Snippet を指す行の「not scoped to project」が起きなくなる。選んだ範囲の行は、スナップショットの記録に戻す。
- **Codex だけ・Snippet だけ・地図だけの復元でも、その範囲の出所の記録を、スナップショットの時点の記録に戻す**（確認 113。本文と Codex を一緒に復元するときの、今の動きと同じ）。今は canonical plan にこれらの行が無く（`authorship_spans` の `AUX_SPECS` の `owner` が Body のため）、live の行が消えて、`no_op = true` のまま 1→0 になる。
- 実装は、Native の `apply_project_snapshot_restore` の中で完結させる。canonical plan と renderer の plan の一致検査に影響しないよう、renderer と browser-mock の plan の構築は変えない（plan の形を変える案は、`projectSnapshotApi.ts` の `restoreStructural` と `test-support/snapshot_restore.rs` の再導出まで同時に変える必要があるので却下）。入れ直すのは、スナップショットの `project_snapshot_aux` の `authorship_spans` の行のうち、指す文書が復元後に在る（project に属す）ものだけ。
- 1 行が複数の列で別の範囲を指す場合は、いちばん保守的な側に倒す（選んでいない範囲を指す列が 1 つでもあれば、入れ直さず、退避して戻す＝今の動きを変えない側）。schema の CHECK を実装時に読んで、そのような行が作れるかを確かめる。作れて、決定の文言だけでは決まらないときは、ユーザーに伺う。
- 出所の記録（human／ai／unknown）は、挿入テキストの source metadata の保存契約（AGENTS.md の実装の境界）に当たるので、戻す則を試験で固定する。

### DR-SRX-8　AI の未採用の本文の提案（`prose_staging`）の則（確認 114）

- 本文の復元で、場面の版が 0 に戻る。自動適用の stale 検知は版の一致だけなので、元の本文に対する提案が、入れ替わった本文に通ってしまうおそれがある（設計の調査。読み）。
- 決定：**復元の前後で本文が同じ場面の分だけ、提案を残す。本文が変わった場面の分は外し、外れる件数を知らせる。**
- 形：`prose_staging.scene_id` を退避する。「本文が同じ」の判定は、復元の前（退避の前）の live の本文と、スナップショットの本文を、本文そのものの同一（hash または全文の比較。実装で決める。決めたら、後の DR に書く）で比べる。版の一致では比べない。同じと判定した場面の分だけ戻し、それ以外は、外部キー本来の動き（場面の DELETE による行の削除）のままにして、件数を `lossNotices` に出す。
- AI の分析記録（`post_effect_runs`・`scene_lens_data`）は、スナップショットの注釈が run を指すので、本文の復元を通すために戻す（場面向けの run の FOREIGN KEY 違反を直す。`scene_lens_data.target_id` も退避の列に入れる。DR-SRX-3）。分析記録の扱いは確認 114 の範囲外だが、確認 103 の一般則（退避して戻す）の適用で、決定の範囲内である。
- 元の本文に対する分析・baseline が、入れ替わった本文に付いたまま残り得ること（設計の risks）は、この修正では変えない（確認 103 の一般則。残るものとして DR-SRX-13 に書く）。

### DR-SRX-9　`change_events` の限った書き込みの信頼境界（確認 115）

`change_events` は append-only の保護表（`policies/narrative/protected-writers.json`、writer `narrative.authority`、enforcement `active`）で、書き手の許可は `scripts/quality/validate-native-writer-ownership.mjs` の `WRITER_TO_MODULES`（`grimodex-db/src/change_events.rs` を含む）で決まる。`project_snapshots.rs` は許可に入っていない。UPDATE を拒む trigger は無く、守りは静的な検査と hash の再計算だけである。

- **置き場所**：`grimodex-db` の `change_events.rs` の中に、`pub(crate)` の関数を 2 つ置く。`project_snapshots.rs` は、この 2 つを呼ぶだけで、`change_events` に SQL を書かない。新しい書き手の file を作らない。保護表の台帳・許可の一覧は変えない。
- **誰が呼べるか**：`pub(crate)` なので、同じ crate の code だけ。呼び手は `project_snapshots.rs` の復元だけ。呼び手が増えたら失敗する source scan の試験（DR-SRC-8 と同じ形。入口の名前を数え、`#[cfg(test)]` を除く）を置く。
- **何ができるか（書けること）**：
  - 退避：`UPDATE change_events SET scene_id = <prefix> || scene_id WHERE project_id = ? AND scene_id IN (その作品の全場面の id)`。本文の復元は、その作品の全場面の行を DELETE して入れ直す（残る場面の行も、一度は `SET NULL` に当たる）ので、対象は**全場面**である（この文書の最初の版は「復元で消える場面の id」と書いたが、実装が正しい。DR-SRX-12 も同じ）。接頭辞は、関数が snapshot id から作る。呼び手は文字列を渡さない（型で包む）。
  - 戻し：接頭辞つきの値の行について、`tree_nodes` に元の id が在れば、元の値（接頭辞を外した値）に戻す。在らなければ NULL にする（外部キー本来の動きで、通常の場面削除と同じ）。
- **何が書けないか**：`scene_id` 以外の列（`sequence`・`prev_hash`・`hash`・`payload`・`timestamp`・`event_uid` など）には触れない。`scene_id` に、「接頭辞を足した自分自身の値」「それを外した元の値」「NULL」以外を書けない。任意の値を書く入口が無い。行の INSERT・DELETE はしない。
- **検出**：`scene_id` は hash の入力（`change_events.rs` の `HashBody`）に含まれる。誤った値の書き込みは、hash の再計算（`src/features/timelapse/hashChain.ts` と、その試験）で検出できる。復元の後、戻した行の hash が合うことを、試験で確かめる（確認 115 の条件）。**実際に効く静的な守りは、`restore_links/tests.rs` の source scan の試験**（呼び手と、`change_events.rs` の UPDATE の代入列が `scene_id` だけであること）である。`validate-native-writer-ownership.mjs` の `DML_RE` は、`UPDATE <表>`（空白 1 個）を検出しない既存の隙があり（点検で実行して確かめた。この PR より前からある）、この文書の最初の版が挙げた「静的な検査が守る」は、`UPDATE` については成り立たない。正規表現を直すと既存の Rust に 20 件超の違反が出るので、**別の PR**で扱う（この PR は直さない）。
- **追加で残る危険**：復元の transaction の中で、接頭辞つきの値が `change_events` に残る間（退避から戻しまで）、その行の hash は合わない。その間の読み取り（入れ直しの hook、`feed_after` の捕捉）が `change_events.scene_id` を読まないことを、実装で確かめる。commit の前の検査（接頭辞の残りの検査）で、残れば復元を失敗させる。復元は作者の操作でしか起きない。同一 process の悪意のある code は、この試験そのものも書き換えられるので、この守りが止めるのは、過失と単純な迂回まで。
- **この判断を、NIR-1 の委任の外として扱う理由**：新しい書き込みの権限を足す（authority の拡大）ので、確認 115 の範囲に限り、委任には載せない。範囲を広げる要求（`change_events` の別の列、別の呼び手）が出たときは、ユーザーに伺う。

### DR-SRX-10　件数の欄（`lossNotices`）の形

- **`project_snapshot_restore_context` の応答に、省略できる欄 `lossNotices` を足す。** 型：`Array<{ kind: string; count: number }>`。Rust は `#[serde(default)]`、renderer 側の型は省略可能にする。命令は増やさない（`profileEgress.ts` の own-data-read のまま）。N-API・`ipcContract` の引数は増やさない。応答に欄を足すだけなので、main の parse と N-API の型の形は変わらない。**今の renderer（古い画面）が、欄の無い応答と、欄の有る応答の両方を読めること**を、試験で固定する。
- **`kind` は、作者向けの種類の固定 id**（表名にしない）。実装で決める。種類の候補：`event_participants`、`event_primary_or_location`、`scene_pov_or_location`、`scene_codex_links`、`foreshadow_codex_links`、`snippet_tags`、`snippet_scene_link`、`foreshadow_scene_links`、`scene_labels`、`phase_anchor`、`lint_ignores`、`map_placements`、`chat_pins_or_anchors`、`trash_items`、`ai_scene_proposals`、`analysis_records`、`imported_event_approvals`、`scene_scope_bindings_reset`。未知の `kind` は、画面側が「そのほか n 件」で扱う（画面は次の PR）。
- **数え方**：context が既に持つ canonical plan（`build_canonical_restore_plan`）から、復元後に残る親の id の集合を作る（選んだ範囲の親は plan の行の id、選んでいない範囲の親は live の id）。「消える親」＝今の live の id − 復元後に残る id（通常は、スナップショットの後に作ったものだけで小さい）。その id を指す退避の列の行を、子の表ごとに、重複なく数える（1 行が 2 列で当たっても 1 件）。読み取りだけで、一時表は使わない。SQLite の変数の上限に合わせて chunk する。
- **件数は、apply と同じ関数を共有する。** 「スナップショットに `events`／`project_calendar` の aux が無ければ削除しない」分岐（apply の `snapshot_has_aux`）を共有しないと、誤った件数が出る。2 段目の行の数え方（親の行が消えて、その子が CASCADE で消える分）は、DR-SRX-4 の規則と同じにする。
- **確認 117 の件数**：本文の復元で、全場面の適用範囲の設定が作り直される件数を、`scene_scope_bindings_reset` として出す（件数の数え方は、実装で決める。作り直される束縛の数と一致させ、決めたら後の DR に書く）。設計は、これを件数に出さない形にしていたが、決定が優先する。
- **確認 114 の件数**：本文が変わった場面の `prose_staging` の件数を、`ai_scene_proposals` として出す。
- **復元の結果（`ApplyProjectSnapshotRestoreResult`）に、`dropped` の内訳**（同じ `kind` の配列）を足す。`#[serde(default)]` で、古い idempotency の応答（欄の無い保存済みの結果）も読める。**事前の件数と一致することを、実行時の検査と試験で固定する**（同じ入力・同じ状態なら一致する。確認を開いてから押すまでに作品が変わると、実際と食い違い得る。画面は「確認を開いたときの件数」と明記する。次の PR）。実行時の不一致は、復元を失敗させるのでなく、結果の内訳を実際の値にする（件数は参考の通知で、復元の成否の条件にしない）。
- SRD/1 の RD6（`approvalLossCount`）は、別の欄にせず、`lossNotices` の 1 件（`kind: 'imported_event_approvals'`）にできる。起案者に伝える。
- 画面（`ProjectSnapshotModal`、locale、browser-mock の表示）は、この PR に含めない（次の PR-B）。型の契約（`electron/shared/ipcContract.ts`、N-API の d.ts、`src/lib` の wrapper の型）が Native の応答の型に追随する必要があるなら、通る最小限だけ直す。`#[napi]` の doc コメントや型を変えたら、d.ts を再生成する。

### DR-SRX-11　変えない動き（確認 116・117）

- **改稿履歴（`content_versions`）**（確認 116）：本文・Codex・Snippet の復元の後、改稿履歴にスナップショットが指す版だけが残る動き（trigger による削除）は、変えない。選んだ範囲の中の動きで、確認 103（選んでいない範囲）の外。改稿履歴の扱いを変えると、保存の意味が変わる。退避に入れない。trigger を止めない。件数にも出さない。
- **場面の適用範囲の設定**（確認 117）：本文の復元で、新しい incarnation の unknown で作り直される動きは、変えない。復元前の eligibility token は失効する。作り直される件数だけ、知らせる欄に出す（DR-SRX-10）。
- schema・閾値・DR-SRC-1〜13 の判断（免除の述語、復元専用の入口、復元より古い Undo／Redo の拒否）は、変えない。

### DR-SRX-12　費用

- 設計の調査の測定（**debug build**・合成データ）：
  - :memory:、`scene_codex_mentions` 12 万行：退避 0.48 秒＋戻し 0.50 秒。`change_events` 20 万行：退避 0.67 秒＋戻し 0.72 秒。今の cascade は、`DELETE FROM codex_entries` 0.45 秒、`DELETE FROM tree_nodes` 1.25 秒で、同じ桁。
  - ファイル DB（WAL）：`change_events` 100 万行で、**退避 9.2 秒＋戻し 9.3 秒**（今の cascade の約 5 倍）。:memory: の値から延長した見込みより、約 2.6 倍悪い。戻しの条件が `substr` 形だと索引が効かず全表走査になる。
- 対策：戻しの条件を、接頭辞の範囲検索にする（DR-SRX-4）。`change_events(scene_id, timestamp)` の索引が既にあるので、新しい索引は足さない（DR-SRX-1）。退避は、`project_id` と `scene_id IN (その作品の全場面の id)` で絞る（`scene_id` を持つ行だけ。この文書の最初の版は「消える場面だけ」と書いたが、残る場面の行も、場面の DELETE で `SET NULL` に当たるので、全場面が正しい。費用は、その分の測定を使う）。
- **release build・ファイル DB（WAL）で測り直す**。結果（形・行数・秒）は、PR 本文と、後の DR に書く。測り直しで時間が復元の許容を超えると分かったときは、実装を止めて、ユーザーに伺う（閾値は動かさない）。
- 復元の transaction が長くなるので、書き込みの待ち（他の writer）への影響は、実装で確かめる（SQLite は書き手が 1 つ。復元は既に 1 transaction で、新しい待ちの種類を足さない）。

### DR-SRX-13　残るもの（この修正が直さない・確かめるもの）

1. **Codex だけの復元が、`FOREIGN KEY constraint failed`（「復元できません」）で失敗する穴（確認 121）。** スナップショットの時点で Phase の起点にしていた場面を、その後に削除した作品。実際に動かして確かめた。canonical plan と renderer の plan を同時に変える別の PR になり、確認 103 の「退避して戻す」の外。**次の公開の前に、別の PR で直す**（時期は、ユーザーが main session で決める）。この PR の動きは今までどおり（該当する作品では、失敗する）。
2. **地図だけの復元の穴（確認 121）。** `map_node_positions` の `snippet_id` が絞られない（読みのみ）。`snippet_id` を NULL に直すと「参照列がちょうど 1 つ」の CHECK に反する。**次の公開の前に、別の PR で直す。** この PR の動きは今までどおり。
3. **復元で type が変わった Codex 項目が、視点人物・参加者に残る件（確認 122）。** 退避して戻す則は「同じ id なら戻す」で、type は見ない。この PR の実装は、この則のままにする。実際に動かして確かめ、結果（残るか、害があるか）を報告する。結果は、PR 本文と、この文書の追記に書く。害があると分かっても、動きは、ユーザーが決めるまで変えない（確認 124 で、残すと決定）。
4. **通常の場面削除で、変更履歴の hash chain が壊れる（復元と無関係）。** 場面を削除するだけで `change_events.scene_id` が SET NULL になり、hash が合わなくなる設計の穴。この PR が直すのは、復元で「場面が残るのに壊れる」分だけ。復元で無くなる場面を指す `change_events` の `scene_id` は、親が無いので NULL のまま（通常の削除と同じ）。
5. **改稿履歴の一部が復元で消える動き（確認 116）、場面の適用範囲の設定が作り直される動き（確認 117）。** 変えない。
6. **復元で Codex 項目の version が 0 に戻ることによる、古い画面の `baseVersion` との衝突**（DR-SRC-12 の既知の動き）。変えない。
7. **元の本文に対する分析・baseline が、入れ替わった本文に付いたまま残り得ること。** 変えない（DR-SRX-8）。
8. **プロット・伏線の、消して復元で戻した後の失敗**（DR-SRC-10 のとおり別 lane）。変えない。
9. **「Codex の復元が出来事の参加者を消す」**：この修正で直る（DR-SRC-7 と DR-SRC-10 が「別の不具合」として残した件）。DR-SRX-14。

### DR-SRX-14　PR #1026（DR-SRC-7・10）との関係

- DR-SRC-7 は、Codex だけの復元が出来事の参加者を全部消すことを、「別の不具合（範囲の外）」として記録した。DR-SRC-10 も同じ項目を「範囲の外・残るもの」に挙げた。この修正が、その不具合を直す（参加者は、復元の後に親が在れば戻る）。
- **Codex の中身が同じ Codex だけの復元（実質 no-op）の後に、出来事・場面の編集が止まり続ける不具合は、この直しで解ける。** 退避して戻すと、参加者・主な人物・場所・視点人物・場所が、復元の前後で同一になり、digest が head と合う。marker に頼らず、DR-SRC-3 の免除も使わない。
- #1026 の試験 `tests/snapshot_restore_feed_continuity.rs` の `codex_only_restore_that_empties_participants_leaves_the_event_writable` は、参加者が消える動きを前提にしている。この PR で、名前と assert を、参加者が残る動きに直す。ほかの全件（`DR-SRC-9` の Undo／Redo の拒否、`narrative_scope_storage_authority.rs`）は、そのまま通ること。
- #1026 の免除の述語・復元専用の入口・復元より古い Undo／Redo の拒否（DR-SRC-6〜9）は、変えない。復元の marker の書き方（project の marker 1 件、`scene-scope`・`scene-body-declaration` の event）も、変えない。
- この修正は、#1026 の merge の後の master から切った枝で行う。

## 4. 受入れの試験（要旨。PR 本文に実行の結果を書く）

- 範囲（Body・Codex・Snippet・Map・Foreshadow・Labels・Lint・Body＋Codex・全範囲）×表の行列：選んでいない範囲の行が、復元の前後で同一（派生の索引 3 表と束縛を除く）。`foreign_key_check` の違反が 0。
- 指す先が復元の後に無くなる場合：親が無い行が、外部キー本来の動きになる。件数が、実際に外れた件数と一致する。
- 件数の欄と復元の結果の内訳の一致。欄の無い応答を読めること。
- 実質 no-op の Codex だけの復元の後に、出来事・場面の編集が通ること（DR-SRX-14）。
- 戻した行の hash chain が合うこと（確認 115）。通常の場面削除では合わないままであること（変えない動きの固定）。
- 出所の記録：本文だけの復元が UNIQUE 違反にならないこと、Codex だけ・Snippet だけ・地図だけの復元で、スナップショットの記録に戻ること（確認 113）。
- `prose_staging`：本文が同じ場面の分が残り、変わった場面の分が外れて件数に出ること（確認 114）。場面向けの `post_effect_runs`・`scene_lens_data` があっても、本文の復元が通ること。
- 確認 116・117 の動きが変わらないこと。
- rollback と再送（idempotency）。
- 退避の列の導出と固定の期待一覧の照合。`change_events` の限った関数の呼び手の source scan。
- `validate-native-writer-ownership`、`validate-narrative-writers`、および検証の適用条件（Native の変更）に従った検査。release build での費用の測り直し。
- 書き手が無い表は、SQL で状態を作ることを試験に明記する。

## 5. 作者から見える動き（この修正）

- 復元の後も、選んでいない範囲のつながり（出来事の参加者、場面の視点人物、Snippet の場面、伏線の位置、ラベル、地図の札、チャットのピン留めなど）が残る。指す先が復元の後に無くて戻せないものだけが外れ、その件数が、復元の確認の画面に出る（画面は次の PR。この PR では、Native の応答の欄まで）。
- Codex だけ（Snippet だけ・地図だけ）の復元で、本文の出所の記録（人／AI の色分け）が、スナップショットの時点の記録に戻る。
- 本文の復元で、AI の未採用の本文の提案は、本文が変わらなかった場面の分だけ残る。
- 本文の復元の後の変更履歴の検証が、場面が残る限り合う。
- 今までどおりの動き：改稿履歴の一部が復元で消える。場面の適用範囲の設定が初期値に戻る。通常の場面削除で変更履歴の検証が失敗する。Codex だけ・地図だけの復元が失敗する場合がある（確認 121。次の公開の前に別の PR）。

## 6. PR の分け方

- **PR-A（Native だけ）**：退避と戻し、`lossNotices`・`dropped` の欄、試験、判断の文書（この文書）。型の契約（`electron/shared/ipcContract.ts`、N-API の d.ts、`src/lib` の wrapper の型）は、Native の応答に追随する必要があるなら、通る最小限だけ。
- **PR-B（画面。PR-A の merge の後）**：`ProjectSnapshotModal`、locale、browser-mock の表示、画面の試験。

## 7. 実装で決めたこと（DR-SRX-15〜）

この節は、実装の途中で決めた細部を足す（1〜6 の判断を変えない）。点検の結果に依るもの（出所の記録・提案の本文の比べ方・件数の細部・費用の測定）は、点検の後にここへ足す。

### DR-SRX-15　退避の列は固定の一覧で持ち、導出は試験で行う（DR-SRX-3 の実装）

- 実装は、実行時に `PRAGMA foreign_key_list` から導出せず、`restore_links.rs` の `PARK_COLUMNS`（表・列・親・`ON DELETE`・表を持つ範囲・作者向けの種類）を固定の定数にした。SQL の文は、定数から作る（表名・列名を呼び手の値にしない）。理由：(1) `validate-native-writer-ownership` の静的な検査をすり抜ける動的な表名を避ける（DR-SRX-3 の第 3 項と同じ）、(2) 新しい外部キーが、分類されないまま退避の対象に入って動きを変えることを避ける、(3) 復元のたびに `PRAGMA` を読まない。
- 見張り：`restore_links/tests.rs` が、実スキーマの外部キーと表の持ち主（`AUX_SPECS` と根の表）から、**7 範囲の全 127 通りの組合せ**で退避の列を導出し、固定の一覧と照合する。新しい外部キー・列名の変更・`ON DELETE` の変更・持ち主の変更で試験が落ち、人が分類し直す。範囲の外から、復元で消える根の表を `RESTRICT`／`NO ACTION` で指す外部キーが現れたときも落ちる。固定の一覧に入れない外部キーは、理由つきの定数（`NOT_PARKED`）にする：`change_events.scene_id`（DR-SRX-9）、`prose_staging.scene_id`（DR-SRX-8）、派生の索引 3 表と場面の適用範囲の設定（DR-SRX-5）。`authorship_spans` は、行ごとに指す文書で決める（DR-SRX-7）ので、列では扱わない。
- DR-SRX-3 が書いた、設計と反証の導出の列の数の食い違い（Codex 20／21、Body 20／21、全範囲 22／20）は、この導出で解消した。数は schema とともに変わるので、この文書には固定しない。照合の試験が正である。

### DR-SRX-16　外部キー違反の検査は「復元が増やしていないこと」を見る（DR-SRX-2 の 8 の実装）

- `PRAGMA foreign_key_check` は、復元の前から在る違反まで数える。SQLite の commit 時の遅延検査（`defer_foreign_keys`）は、その transaction が足した違反だけを見る。復元を後者より厳しくすると、外部キーを切って作られた古い DB（取り込みなど）の復元が、これまで通っていたのに止まる。
- そこで、退避の前に、触る表ごとの違反の数を控え、戻しの後に**増えていなければ**通す。増えたときは、理由つきで復元を失敗させる。接頭辞の残りの検査は、そのまま（1 つでも残れば失敗）。
- 試験：`a_dangling_reference_the_work_already_had_does_not_stop_a_restore`。

### DR-SRX-17　確認 122 の観測：type が変わった Codex 項目（決めていない。現在の動きの記録）

- 実際に動かして確かめた（試験 `observation_a_codex_restore_that_changes_a_type_keeps_the_entry_where_it_was`）。スナップショットの後に type が変わった項目（人物↔場所）を、Codex だけで復元すると、type はスナップショットの値に戻る。その項目は、**場面の視点人物・出来事の主な人物・参加者・場所に、そのまま残る**。結果として、視点人物が場所の項目になる、場所が人物の項目になる、といった型違いが起きる。何も報告されず、`lossNotices`／`dropped` にも出ない。
- 守りは、場面の適用範囲の束縛が参照する人物だけ（`NEX_SCENE_SCOPE_CHARACTER_REFERENCED`。`scene_scope.rs`）である。視点人物・参加者・場所の type を見る所は、復元にも writer にも無い（実際に動かして確かめた）。以前は、復元がこれらのつながりを全部消していたので、型違いは起きなかった（代わりに、つながりの消失が起きていた）。
- **決定（2026-11-23。確認 124）：残す（今の動きのまま）。** 残して件数を知らせる、外して件数に出す、は選ばれなかった（どの欄にどの種類が合うかの規則を、新しく決める必要があるため）。試験は、この動きを固定する。動きを変えるときは、この試験を直す。

### DR-SRX-18　型の契約

- N-API（`electron/native/grimodex-node`）は、応答を JSON 文字列で返す形で、署名も `#[napi]` の doc コメントも変えていないので、d.ts の再生成は要らない。
- renderer の型（`src/features/revision/projectSnapshotNative.ts`）に、省略できる欄 `lossNotices`（コンテキスト）と `dropped`（復元の結果）と、型 `RestoreLossNotice` を足した。`ipcContract.ts`・main の検査・browser-mock は変えない（画面は PR-B）。古い画面が欄の有る応答を、新しい画面が欄の無い応答（古い Native、保存済みの再送の結果）を読めることを、試験で固定した（TS：`projectSnapshotNative.test.ts`、Rust：`a_result_stored_before_the_dropped_list_existed_still_reads`、`an_exact_retry_returns_the_stored_result_with_what_was_dropped`）。

### DR-SRX-19　執筆の記録の起案（HSR/1）との関係（将来の PR への申し送り。この PR は変えない）

- HSR/1（執筆の記録の「どの場面か」を鎖から切り離して直す起案。未確定）は、`change_events` に外部キーでない列 `scene_ref` と、`AFTER UPDATE OF scene_id` の trigger（`scene_id` が NULL になる直前の値を `scene_ref` に写す）を足す案である。統合者の点検（`peer-review-integrator-hsr1-20261123.md`）の実験で、親の DELETE による `ON DELETE SET NULL` でも、この trigger は発火した。
- したがって、HSR/1 が入った後は、この PR の `RestoreSceneIdParking` の UPDATE も、同じ trigger を発火させる。退避（`scene_id` を接頭辞つきの値にする）は、`scene_id` が NULL にならないので写らない。**戻しの 2 本目**（復元の後に場面が無い行を NULL にする）は、`OLD.scene_id` が接頭辞つきの値なので、そのままでは**接頭辞つきの値が `scene_ref` に入る（黙った破損）**。
- HSR/1 の PR は、(1) trigger に「接頭辞つきの値を写さない」条件（`NOT LIKE`）を足す、(2) 戻しの 2 本目を「接頭辞を外した値を `scene_ref` に書き、`scene_id` を NULL にする」1 文に直す、(3) 接頭辞（trigger の `LIKE` の文字列と `RESTORE_PARK_ROOT`）の二重管理を試験で固定する、(4) この PR の source scan の試験（`restore_links/tests.rs`。代入する列が `["scene_id"]` だけ）と `a_normal_scene_delete_still_breaks_the_hash_of_that_scenes_rows` を直す、必要がある。
- (2) は `scene_id` 以外の列（`scene_ref`）を書く。DR-SRX-9（確認 115：`scene_id` だけを退避して戻す）の範囲を広げるので、**HSR/1 の確認で、ユーザーに伺う**（新しい書き込みの権限の拡大。委任の外）。
- 注記：退避は、その作品の**全場面**の行を対象にする（復元で消える場面だけではない）。HSR/1 の下書きの §2.1 は、この点を直す。

### DR-SRX-20　点検で見つかり、この PR で直したこと

実装の点検（read-only の 4 観点＋確かめ直し。実行で再現したものだけ）で見つかり、直した。

1. **events の aux が無い古いスナップショットで本文を復元すると、`scene_events`（場面と出来事の結び付き）が黙って全部消える。** `events` を DELETE しない分岐（`snapshot_has_aux("events")` が偽）では、出来事の表は置き換えられず、`scene_events.scene_id`（`tree_nodes` への `CASCADE`）だけが場面の DELETE で消え、入れ直す元の行も無い。`PARK_COLUMNS` に `scene_events.scene_id`（持ち主は Body。events の aux が有れば置き換えられるので退避しない。無ければ退避する）と、作者向けの種類 `event_scene_links` を足した。導出の見張りの試験を、events の aux が有る場合と無い場合の両方（7 範囲の 127 通り×2）にした。従来の動きと同じ取りこぼしで、この PR が悪化させたものではないが、この PR が直す不具合と同じ種類である。
2. **残した AI の提案（確認 114）の `base_version` が、復元後の場面の版と食い違う。** 場面は、計画の版（0）で入れ直され、元の版を持ち越さない。提案は残るが、作った時の版を指したままで、今すぐ stale になり、のちに場面の版がその数に達すると、本文が別でも有効に見える。本文は同じと判定した場面の提案なので、復元後の場面の版に合わせる（`status = 'proposed'` の行だけ。`prose_staging.base_version` だけを書く）。DR-SRX-8 の補足である。
3. **親の id が退避の接頭辞で始まる行があると、戻した行が「退避中のまま」と誤認される。** 到達性はほぼ無い（製品が採番する id は UUID）が、IPC は任意の文字列を受ける。復元は、何かを書く前に、親の表のどれかに接頭辞の根で始まる id が在れば、理由つきで失敗する。
4. **`no_op` の二重の守り（DR-SRX-2）。** 外れた行が有るのに Feed の対象が空（`no_op`）になる状態は、作れなかったが、実装が無かった。外れた行が有って Feed の対象が空のときは、「何も変わらなかった」と返さず、失敗にする。

### DR-SRX-21　点検で見つかり、この PR では直さないこと（残るもの）

- **2 段目の損失は、件数に含めない。** 退避した列の行が、親が無くて削除・NULL になったときに、その行を親とする子（`map_edges`、`foreshadow_setup_payoff_links`、`post_effect_annotations.run_id` ほか）が、連鎖して消える・NULL になる。数えるのは、退避した列の行だけ。特に、`post_effect_runs.scope_target_id` が消える側（フォルダなど）を指し、`scene_lens_data.target_id` が残る場面を指すとき、残る場面の分析データが、件数に出ないまま消える（`run_id` の `CASCADE`）。
- **場面の適用範囲の設定の件数（`scene_scope_bindings_reset`）の定義。** 「復元される場面のうち、いま束縛を持つものの数」である（設定が初期値に戻る場面の数）。束縛が無かった場面（新しく作られるだけ）と、復元で無くなる場面の束縛（場面の削除の結果）は数えない。DR-SRX-10 が「決めたら書く」とした定義の記録である。
- **出所の記録だけが変わる Codex・Snippet・地図だけの復元は、持ち主の行が同じなら `no_op` になる。** 出所の記録（`authorship_spans`）は持ち主の表が Body なので、Feed の状態に入らない。製品の経路は、持ち主の行（Codex は version と updated_at、Snippet・地図は保存）を一緒に変えるので、この状態を作れない（確かめ直しで確認）。DR-SRX-7 の補足。
- **出所の記録の aux だけが無い構造スナップショットは、作れない**（構造つきの判定は aux が 1 行でも在るかで、作成は全 aux を書く。反証された）。aux が全く無い古いスナップショットは、構造つきの復元を拒否する（この PR より前から）。
- **「本文が同じ」は、文字列の完全一致**。空文字と `'{}'`、空白だけの違いは「違う」と見なす（同じものを違うと見る向き＝安全側。違う本文を同じと見ることは起きない）。
- **`restore_links.rs` の SQL は、固定の定数から作る動的な文で、保護表（`tree_nodes`・`events`・`snippets`・伏線系ほか）に書く。** `validate-native-writer-ownership` は、`format!` で組んだ表名を読まないので、この file は許可された書き手の一覧に載っていない。守りは、固定の一覧と、スキーマとの照合の試験（DR-SRX-15）である。許可の一覧を変えるのは台帳の変更になるので、この PR ではしない。以前の `park_map_reference`（`project_snapshots.rs`）も同じ形だった。
- **外部キー違反の検査は、「増えていないこと」を、表ごとの件数で比べる**（DR-SRX-16）。1 件が直り、別の 1 件が増えたときは、検出できない（SQLite の commit 時の検査は検出する）。復元の前から違反が在る作品を止めないことを優先した。

### DR-SRX-22　release での費用の測定（DR-SRX-12 の測り直し）

- 形：ファイル DB（WAL。ext4）、release build、場面 1,000（半分に 2 KB の本文）、Codex 項目 500、`scene_codex_mentions` 12 万行、`prose_staging` 3,000 行、出来事 2,000（参加者 6,000）、Snippet 200、地図の札 1,500、`change_events` 100 万行（200 場面に分散）。DB は 282 MB。同じ DB・同じ試験で、変更前（`HEAD~1`）と、この変更を比べた。ほかの担当が同時に動いていて、負荷は 6〜22（壁時計は ±10〜25%。CPU 時間のほうが安定）。
- 結果（秒）：

| 復元 | 変更前（CPU／壁） | この変更（CPU／壁） |
|---|---|---|
| 本文だけ（`apply`） | 70.7／77.6 | 69.3／80.5 |
| 全範囲（`apply`） | 74.6／83.9 | 72.6／84.1 |
| Codex だけ（`apply`、単独 2 回） | 0.87／3.6 | 1.86／4.8 |
| 確認（`context`）。本文 | 0.02〜0.03 | 0.36〜0.72 |

  `change_events` の退避と戻し（100 万行）は、それぞれ 5.6 秒（debug の 9.2 秒より速い）。`scene_codex_mentions` は 0.8 秒ずつ。WAL は、本文の復元で 138 MB → 207 MB（+50%）。
- **この PR が足す費用は小さい**：本文の復元は誤差の範囲、Codex だけは +1.1 秒（`scene_codex_mentions` 12 万行を退避して戻すため。以前は CASCADE で消していた）、確認は +0.4〜0.6 秒（正準の計画を作って件数を数えるため。1 回の確認につき 1 回）。閾値は決めていない（DR-SRX-12 の「閾値は動かさない」のとおり）。測定者の意見は、「この PR の費用では、実装を止めない」。
- **以前からの費用（この PR の責任ではない）**：この大きさの作品で、本文の復元は、書き込みを約 70〜80 秒止める（`scene_codex_mentions` が 0 行でも約 21 秒）。原因は、挿入のたびに行う `ensure_inserted_row_is_project_scoped`（場面数に比例する存在検査）で、1 行あたり 500 場面で 0.084 ms、1,000 場面で 0.17 ms、2,000 場面で 0.41 ms（場面数×言及の数に比例）。ほかに、行ごとの `sqlite_master`・`PRAGMA table_info` の再実行がある。この間、ほかの接続（MCP、worker）は `busy_timeout` 5 秒を超えると `SQLITE_BUSY` になる。**直すなら別の lane**（表ごとの集合検査に置き換える）。ユーザーに、時期を伺う。
- 索引：39 列のうち 10 列が全表走査（DR-SRX-4）。ほかの 29 列、`change_events`、`prose_staging` は索引を使う。
- 点検で直した細部：`prose_staging_plan` が本文の読みのエラーを握りつぶして「本文が違う」と見なしていたので、本当のエラー（busy・I/O）は復元を止める形にした（「その場面が無い」だけを「違う」とする）。場面ごとの `SELECT` 1 回（N+1）は、そのまま（確認と復元で 2 回）。
- 測っていないこと：Windows・macOS・別のファイルシステム、実物の計画の作り手（renderer）、50 KB 以上の本文での `PlanFacts` のメモリ、大きい `lint_action_log`・`ai_usage`・`trash_items`・`post_effect_runs`・`scene_lens_data` の時間、`SQLITE_BUSY` の実際の衝突、`reshape_authorship_inserts` の大きい `authorship_spans` での費用。

### DR-SRX-23　実装の後のユーザーの決定（2026-11-23）

記録は contracts の `user-confirmation-2026-11-22-chronicle-scene-review-apply.md`（確認 124〜126）。

| 確認 | 決定 | この文書での扱い |
|---|---|---|
| 124（確認 122） | 復元で種類が変わった Codex 項目は、つながりを残す（今の動きのまま） | DR-SRX-17・13 の 3。試験で現在の動きを固定したまま |
| 125（確認 116） | 復元で中間の改稿履歴が消える動きは、今のまま | DR-SRX-11 のまま。調査（ほかのスナップショットが指す版は、外部キー〔`RESTRICT`〕と trigger の `NOT IN` で守られ、実験でも消えない。消えるのはどのスナップショットも指さない中間の版だけ）は、contracts の記録に要旨を置いた |
| 126 | 大きい作品（場面 1,000・Codex の言及 12 万）の本文の復元が書き込みを約 70〜80 秒止める件（DR-SRX-22）は、**この PR の後すぐ、別の lane で直す** | 別の PR。挿入のたびの `ensure_inserted_row_is_project_scoped`（場面数に比例する存在検査）と、行ごとの `sqlite_master`・`PRAGMA table_info` の再実行を、表ごとの集合検査に置き換える。プロジェクトの範囲の検査（別の作品の行を入れさせない）の意味は変えない |
