# スナップショットの復元の後の、変更の記録の連続性（判断の記録）

- 対象：スナップショットの復元の後、編集と削除が `NARRATIVE_CHANGE_FEED_DISCONTINUITY` で失敗し続ける不具合の修正。
- この修正は、NIR-1 の残レーンの委任の外である。直し方（守りを、復元の前後に限って弱めること）は、ユーザーが選んだ（2026-11-22。確認 81。記録は、枝 `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`。確認 81 は commit `d107cb4ea`、確認 83〔本文を含む復元の 2 回目の失敗〕は `b1e0fe16c`、確認 88〔取り込みの取り消し・やり直しを、確かめた種類だけ拒否の対象から外す〕は `6fe47662a`。確認 88 までの全記録は contracts `512d1a508`）。この文書は、その選択の範囲内の、技術判断と信頼境界を記す。選択の範囲を超える判断は、ここに書かず、ユーザーに伺う。
- この文書の最初の版（DR-SRC-1〜5）は、製品のコードを変える前に置く。実装で決めた細部は、後の DR として足す。

## 1. 不具合（実行で確かめた。2026-11-22）

基点は `master` `e1aa06ec`。Native の公開の関数を直接呼ぶ試験で確かめた（Main の IPC は通していない）。

- 本体は、object ごとに、変更の記録の head（`narrative_change_object_heads`）を持つ。書き込みのたびに、head の after 状態と、今の行から作った before 状態の一致を確かめる（`narrative_extraction/change_feed.rs` の `ensure_event_history_continuity`）。
- スナップショットの復元は、行を消して入れ直す。変更の記録には、project 単位の marker（`project-restored`）を 1 件だけ書く。object ごとの head は動かさない（`policies/narrative/README.md` の決まり）。
- そのため、スナップショットを取った後に編集するか消したものは、復元の後、head と行が食い違う。次の書き込みが、連続性の検査で止まる。もう一度復元しても、直らない。
- 作者から見える形：年表の出来事、場面（題の変更、削除）、Codex の項目、Snippet が、復元の後、編集も削除もできない。データは壊れない。操作が拒まれ続ける。
- スナップショットを取った後に触っていないものは、復元の後も編集できる。
- プロットと伏線は、書き手が before を head から取る。編集は通る。消して復元で戻した後の編集は、別のエラーで失敗する。
- 場面の適用範囲（Scope）に編集の履歴があると、本文を含む復元そのものが拒まれる（以前から知られていた不具合。再現した）。
- 最新の公開の版の tag（`v2.0.10`）には、この検査が無い。公開済みの版には、当たらない見込みである。

## 2. 判断

### DR-SRC-1　直し方は、連続性の検査の側に置く（ユーザーが選んだ）

- 選ばれた形：復元をまたいだ食い違いは、連続性の検査で止めない（確認 81 の「B」）。
- 選ばれなかった形：復元が、変わった object ごとに変更の記録を足す（「A」）。
- 帰結（問いに書いた内容）：復元の後、まだ書き込んでいない object は、最初の 1 回だけ、食い違いの検査を通らない。守りが、復元の前後に限って弱くなる。すでに編集できなくなっている作品は、次の書き込みで、自動で直る。「復元の記録は marker 1 件だけ」という決まりは、改めない。

### DR-SRC-2　しないこと

- schema の版を上げない。migration を足さない。新しい列・表・索引を足さない。
- 閾値を変えない。
- 復元が、object ごとの変更の記録を足す形にしない。
- 保存の範囲と、送信先を広げない。

どれかが要ると分かったときは、実装せず、ユーザーに伺う。

### DR-SRC-3　免除の条件と、信頼境界

- 検査が食い違いを見つけたとき、その object の head が、その project の最新の復元の marker より古ければ、通す。「古い」は、変更の記録の通し番号（sequence）で比べる。
- 復元の後、その object に 1 度でも書き込みがあれば、head は marker より新しい。その後の食い違いは、今までどおり止める。
- 復元の marker が無い project の食い違いは、今までどおり止める。別の project の marker は、効かない。
- **免除は、呼び出し側の申告で決めない。** 引数、origin の文字列、経路の名前を、根拠にしない。DB の中の、marker の行と head の行だけで決める。
- 信頼する相手：Native の変更の記録の書き手と、DB の中の marker。marker を書けるのは、復元の書き手だけである（実装で確かめ、試験で固定する）。
- 残る危険：復元の後、まだ書き込んでいない object について、変更の記録を通らない行の書き換えがあっても、最初の 1 回は見つけられない。復元は、作者の操作でしか起きない。

### DR-SRC-4　復元の前の「元に戻す」の履歴が、復元の後の編集を巻き戻さないようにする

- 今は、復元の後の編集そのものが失敗する。そのため、復元の前の履歴が、復元の後の編集を巻き戻す道は、たまたま閉じている。
- 検査を直すと、この道が開く（実行で確かめた。復元の後の編集を、復元の前の履歴の「元に戻す」が、黙って巻き戻した）。
- 同じ PR で、この道を閉じる。schema は変えない。形は、実装の前の設計で決め、後の DR に書く。
- 作者から見える形：復元の後は、復元の前の操作を「元に戻す」で戻せない。

### DR-SRC-5　範囲の外

- プロットと伏線の、消して復元で戻した後の失敗。書き手が before を head から取る作りの問題で、別の不具合として扱う。
- 過去の変更の記録の書き換え。過去に食い違った作品の、一括の診断と修復。
- 場面の Scope の履歴があると復元そのものが拒まれる不具合は、同じ直しに自然に収まるなら含める。収まらないなら、範囲の外に置き、理由を後の DR に書く。

## 3. 残すもの

- 実装で決めた細部（marker の探し方、復元の scope での絞り、履歴の手当ての形、browser-mock の扱い）は、後の DR として足す。
- 受入れの試験の筋書きと、実行の結果は、PR の本文に書く。

## 4. 実装で決めた判断（DR-SRC-6 以降。2026-11-22。製品のコードを変える前に置く）

根拠：設計と反証（`fusion-eval-data/design-notes/editor-scene-interpretation-2026-11-21/wf41.json`）、2 回目の復元の形の調査（観測の試験を実行）、ユーザーの確認 81・83（枝 `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`、commit `b1e0fe16c`）。選択の範囲を超える判断は、ここに書かない。

### DR-SRC-6　免除の述語の正確な形

- 場所：`narrative_extraction/change_feed.rs` の `ensure_event_history_continuity`。head と今の行から作った before が食い違うときだけ、述語を 1 回引く。一致する通常の書き込みには SQL を足さない。
- 対象：DB の head の行（`narrative_change_object_heads`）から読んだ before と食い違うものだけ。同じ batch の前の event 由来の head（メモリ上）の食い違いは免除しない（同じ batch の 2 件目）。head の行が無い object は、今までどおり検査しない。
- 述語（読み取りだけ）：その project に、次をすべて満たす transaction が 1 件でもあれば通す。
  - `source_change_event_sequence` が、その object の head の `canonical_sequence` より**大きい**（strict。復元自身が書いた head は marker と同じ sequence なので、対象にならない）。
  - `origin = 'restore'` かつ `source_domain = 'project.snapshot.restore'`。
  - その transaction に、project 単位の復元の marker の event がある（object key の kind が `project`、`structuralImpact.event` が `project-restored`、`canonical_sequence` が transaction の `source_change_event_sequence` と等しい）。`semantic-epoch-reset` は含めない。
- 比べるのは sequence の大小だけ。最新の marker ではなく、head より新しい marker の存在を見る（復元が複数回あっても通る）。
- 通した書き込みは、今の行から作った before と after を、そのまま記録する（記録は偽らない）。head は既存の `upsert_object_head`（`canonical_sequence` の大小で更新）で新しい after に進む。次の書き込みでは head の sequence が marker を超えるので、述語は偽になり、厳格に戻る（免除は 1 回だけ）。
- **免除は、呼び出し側の申告で決めない**（DR-SRC-3 のとおり）。述語の入力は、DB にすでにある別の transaction の `origin`／`source_domain`／marker／sequence と、head の sequence だけである。呼び出しの引数と今書く transaction の `origin` は使わない。
- 止まり続けるもの：復元の履歴が無い project、別の project の marker、origin が Human／Migration の transaction、`source_domain` が `revision.scene.restore.renderer` など別の経路、`semantic-epoch-reset`、marker の後に書き込みがあった object、同じ batch の 2 件目。
- 費用：不一致のときだけ、1 object につき 1 回。索引は既存の `idx_narrative_change_transactions_project_sequence` と `idx_narrative_change_events_project_sequence` を使う。新しい索引は足さない。
- 限界（DR-SRC-3 から引き継ぐ）：pub の append を呼べる同一プロセスの Rust 書き手は、復元の形の transaction を偽造できる。本番で `source_domain = 'project.snapshot.restore'` を origin Restore で書くのは `project_snapshots.rs` の 1 か所だけで、source scan の試験で固定する。N-API／IPC／MCP からは append を呼べない。
- schema 22 より前の版で復元した記録は、origin が `migration` に写っており（`migrate.rs`）、対象外のまま。許すには偽造の窓が広がるので入れない。

### DR-SRC-7　復元した scope で絞らない

- 設計は、object の種類を復元の scope に写して絞る案だった。反証で、scope をまたぐ cascade と合わないと分かった（実行で確かめた）：Codex だけの復元で、出来事の参加者が全部消える（`event_participants` が 2 から 0）。Body だけの復元で、Snippet の `scene_id` が NULL になる（`tree_nodes` の削除の `ON DELETE SET NULL`）。絞ると、どちらも復元の後に止まり続ける。
- 確認 81 の技術判断（ユーザーに伝えた）のとおり、絞らない。「head が、その project の復元の marker より古ければ通す」。これは「最初の 1 回」の範囲内で、窓の広さは確認 81 の範囲である。
- 帰結（残る危険）：復元の後、まだ書き込んでいない object は、復元と無関係の、変更の記録を通らない行の書き換え（実例は MCP の events の UPDATE）も、最初の 1 回は見つけられない。確認 81 の弱点そのもので、PR 本文にも実例を書く。
- Codex だけの復元が出来事の参加者を消すこと自体は、別の不具合（範囲の外）。ここでは直さず、記録だけする。

### DR-SRC-8　本文を含む復元の 2 回目の失敗（DEF-1）の形と信頼境界

- 確認 83 の指示どおり、先に「例外を足さずに直せる形」を調べた（観測の試験を実行）。結論：無い。
  - 「消す前の本当の before を捕まえて使う」形は、行がある場面では成り立つ。しかし、復元の開始時に行が無い場面（スナップショットの後に削除された場面。場面の削除は scene-scope の event を書かないので、head だけが残る）で Scope 編集の履歴があるものは、捕まえる before が存在せず、今の master でも 1 回目から失敗する。before を head の after に写す形は、検査が常に通るので、免除と同じ。head を消す形は、復元が object ごとの記録を触るので範囲外（DR-SRC-2）。
  - 復元の中の記録（marker・scene-scope の更新・宣言の消去）には、marker が無い復元 transaction が実在する（本文が同じ net no-op の復元でも scene-scope の更新は出る）。そのため、marker で通す形は成り立たない。
- 採る形（確認 83 の形）：
  1. `change_feed.rs` に、`pub(crate)` の入口 `append_snapshot_restore_in_tx` を足す。中身は今の `append_canonical_and_narrative_change_in_tx` と同じ処理。既存の pub の入口は、免除なしのまま（`Normal`）。`AppendNarrativeChangeTransactionInput` に field は足さない。
  2. 入口は、`origin == Restore` と `source_domain == 'project.snapshot.restore'` を確かめ直し、満たさなければ失敗する。
  3. 免除は、その batch の中の、object key の kind が `scene-scope` の event だけ。head は通常どおり新しい after に進む。`scene-body-declaration` と project の marker は、既存の免除のまま。ほかの種類は免除しない。
  4. `project_snapshots.rs` は、append の呼び出し 1 行だけをこの入口に変える。復元の SQL・scene-scope の更新・保存される値（binding の version／incarnation／digest）は変えない。
- 行が無い場面（スナップショットの後に削除された場面で Scope 編集の履歴があるもの）の scene-scope の記録も、確認 83 の「復元の処理が書く、場面の適用範囲の記録」に入れる。免除を、行が無い場面だけに狭めない。復元の transaction の中の、kind が scene-scope の記録の全部が対象。
- 信頼境界：この免除だけは、DR-SRC-3 の「DB の事実だけで決める」にならない。marker がまだ DB に無い時点の判定だからである。代わりに、(a) 型（`pub(crate)`。外部 crate・N-API・IPC・MCP からは呼べない。renderer が渡せるのは復元の request／snapshot／scopes で、免除の有無・origin・source_domain は渡せない）、(b) origin／source_domain の再確認、(c) kind が scene-scope だけ、の 3 つで狭める。DR-SRC-3 への例外は、確認 83 でユーザーが選んだ範囲に限る。
- 正直な限界：既存の pub の append（外部 crate から呼べる）は免除を持たない。同一プロセスの Rust 書き手が復元の形の transaction を作っても、免除は得られない（検査は厳格なまま）。入口が `pub(crate)` であること、`project_snapshots.rs` 以外から呼ばれないことを、source scan の試験で固定する。
- 副作用：2 回目以降の復元が成功し始めるので、復元の他の経路（Revision の unavailable 化、epoch、timelapse の baseline）が繰り返し走る。既存の試験が通ることを確かめる。

### DR-SRC-9　復元の前の「元に戻す」・「やり直し」を拒む

- 形：Undo／Redo の変更の記録を書く唯一の入口（`append_narrative_change_transaction_in_tx`）で、lineage root の forward transaction より新しい、その project の復元の marker があれば拒む。エラーの接頭辞は `NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE`（固定）。journal replay、typed writer の inverse（codex／domain／map／extraction／renderer replay）、取り込みの `undo_commit`／`redo_commit` は、すべてこの append を通る（**取り込みの取り消し・やり直しのうち、確かめた種類だけは、確認 88 で拒否の対象から外した。DR-SRC-12。** 以下の「拒む」は、それ以外の replay〔確かめていない種類の取り込みの取り消し・やり直しを含む〕の話である）。schema は変えない（journal に列を足さない）。
- 判定は、同じ request の再送の確認（`existing_result`）の後に置く。復元の後でも、すでに記録した結果の再送は、その結果を返す。
- 復元の scope では絞らない（DR-SRC-7 と同じ理由。復元の成功の後は renderer 全体が reload されるので、作者から見える動きとも同じ）。拒むのは「元の書き込みが、復元の marker より古い」ものだけで、復元の後に行った操作の undo／redo は通る。本文が同じ net no-op の復元は marker を書かないので、何も拒まない。
- 作者から見える動き：復元の後は、復元の前の操作を「元に戻す」「やり直し」で戻せない（当初は AI の適用の取り消しを含めたが、**確かめた種類の取り込みの取り消し・やり直しは DR-SRC-12 で対象から外した**。それは取り込みの専用の守りで扱う。確かめていない種類は、拒んだまま）。復元の成功の後は renderer が reload され、履歴は消えるので、main window では今も同じ。別窓に残った履歴からの操作は、この拒否で止まる。
- renderer は変えない。エラーの符号が既存の分類（version conflict など）に誤って当たらないことは、`src/lib` の分類で確かめる。
- 残る危険：`change_event_uid` が無い public-floor 期の legacy journal は、replay 時に forward が新しく作られるので拒めない。`undo.rs` が maintenance_events 空のとき append を呼ばない経路は、行を変えないので影響しない。

### DR-SRC-10　範囲の外・残るもの

- 場面の削除が scene-scope の event を書かない（head が古いまま残る）こと、復元で消える場面の古い head：直さない（削除の writer の変更、または復元が object ごとの記録を触ることになる。DR-SRC-2）。同じ id の場面を新しく作って Scope を編集する経路で、DISCONTINUITY が残る可能性がある（今も同じ）。
- プロット・伏線（書き手が before を head から取る）：直さない。今の挙動を固定する試験にとどめる。
- Codex だけの復元が出来事の参加者を消すこと（データの別の不具合）。
- 過去の変更の記録の書き換え、壊れた作品の一括診断・修復（次の書き込みで直る）。
- 実 Electron の journey（`nir1-scene-scope-projection-product-journey.mjs`）：rich project の復元が成功し始めるので、その後の assertion が初めて rich に当たる。未検証（Electron は起動しない）。Full が赤なら修正 PR。
- schema の版上げ、migration、新しい列・表・索引、閾値の変更、保存範囲の拡大は、していない。

### DR-SRC-11　browser-mock（実装の後に追記）

- browser-mock の連続性の検査（`src/lib/browser-mock.ts` の `insertBrowserNarrativeChange`）にも同じ不具合があった。vitest で再現した（`tree_node_patch`、本文の復元の後の 2 回目の書き込みが `continuity mismatch`）。そのため、Native の DR-SRC-6 と DR-SRC-9 と同じ形を入れた（head の `canonical_sequence` を読み、head がその project の復元の marker より古い食い違いを 1 回通す。復元より古い Undo／Redo を同じ符号で拒む）。scope では絞らない。
- 復元専用の入口（DR-SRC-8）は mock に入れない。mock の復元は project の marker だけを書き、scene-scope の記録を書かないので、DEF-1 は mock には無い。
- renderer の分類（`isVersionConflictError`）は、新しい符号を version conflict に数えない（試験で固定）。拒まれた replay は履歴を clear して error を出す既存の経路に入る。renderer の表示は変えない。

## 5. 取り込みの「取り消し」「やり直し」（DR-SRC-12。2026-11-22。製品のコードを変える前に置く）

根拠：ユーザーの確認 88（枝 `claude/nir1-contracts` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`）。確認 88 は、DR-SRC-9 の拒否の対象から AI 抽出の「取り込みの取り消し」（`narrative_extraction_undo_commit`）と「やり直し」（`narrative_extraction_redo_commit`）を外すことを決めた。条件は、取り込みの専用の守りで復元の後の編集が巻き戻らないことを、試験で確かめること。確かめられなければ外さない。選択の範囲を超える判断は、ここに書かない。

### DR-SRC-12　取り込みの取り消し・やり直しを、確かめた種類だけ、DR-SRC-9 の拒否の対象から外す

**改訂（2026-11-22。同じ DR-SRC-12 の実装を、確認 88 の条件に合わせて狭めた）**：最初の実装は、述語が取り込みの commit の種類を問わず拒否の対象から外していた。確認 88 の条件は「専用の守りで、復元の後の編集が巻き戻らないことを、試験で確かめてから外す。確かめられなければ、外さずに、あらためて伺う」であり、確かめていない種類まで外すことは、この条件に合わない。そのため、述語に **種類の条件を足し、確かめた種類だけを外す**。確かめていない種類は、復元の後は、今までどおり拒む（`NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE`）。確かめていない種類を新しく確かめて広げることは、この改訂ではしない（別の作業。確認 88 の範囲に収まるが、試験が先）。以下の本文のうち、「種類を問わず」と読める箇所は、この改訂の記述（「外し方」の種類の条件、「残るもの」）が優先する。

**確かめたこと（実行した。拒否を外した状態で、実際の復元 `apply_project_snapshot_restore` を通した。復元の marker は手で作っていない）**

取り込みの専用の守りが何を比べるか（`narrative_extraction/undo.rs` を読んだ）：

- 取り消し：journal の全 entity について、何も書く前に `preflight_undo_entity` を回す（同じ transaction。1 つでも拒めば全体が拒まれる）。Chronicle の出来事（`event`）は、`collect_event_snapshot`（行の全列、参加者、場面の紐づき〔incarnation token を含む〕、因果の関係）を、`createdAt`／`updatedAt` を除いて、取り込んだ時の snapshot と比べる（`NEX_COMMIT_EVENT_EDITED`）。Codex の項目の作成と patch は、版だけを比べる（`NEX_COMMIT_ENTRY_EDITED`）。
- やり直し：出来事は「まだ存在すれば拒む」（`NEX_COMMIT_EVENT_EDITED`）、Run があれば現在の年表の catalog の一致も確かめる（`NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT`）。Codex の項目の作成は「まだ存在すれば拒む」、patch は beforeSnapshot と今の行の照合。出来事は取り込んだ時の snapshot から作り直す（既存の行を上書きしない）。

筋書きと結果（試験は `tests/narrative_extraction.rs` の `commit_undo_after_restore`、`tests/codex_narrative_commit.rs`）：

- (a) 取り込み → スナップショット → 出来事を編集 → 復元（Body）→ 出来事を編集 → 取り消し：`NEX_COMMIT_EVENT_EDITED` で拒まれ、復元の後の編集が残る。
- (b) 取り込み → スナップショット → 編集 → 復元（Body）→ 編集せず取り消し：**拒まれる**（`NEX_COMMIT_EVENT_EDITED`）。Body の復元は場面の紐づき（`scene_events`）の incarnation token を振り直すので、出来事が取り込んだ時の snapshot と一致しない。安全な側の拒否で、実害は無い（出来事は残る）。出来事に触れない復元（Codex の scope）の後なら、取り消しもやり直しも通る（出来事と紐づきが消え、戻る）。出来事に触れない復元の後に出来事を編集してから取り消すと拒まれ、編集が残る。
- (c) 取り込み → スナップショット → 取り消し → 復元（出来事が戻る）→ 編集 → やり直し：拒まれ（出来事が既に存在する）、復元の後の編集が残る。編集が無くても拒まれ、出来事を二重に作らない。取り込みの前のスナップショットへ復元して出来事が消えた後のやり直しは、取り込んだ出来事だけを作り直し、ほかの内容（場面）は変えない。
- (d) 取り込み → スナップショット → 出来事を画面で消す → 復元（戻る）→ 取り消し：拒まれ（(b) と同じ原因）、戻った出来事が残る。復元で戻した出来事を編集してから取り消しても拒まれ、編集が残る。
- (e) Codex：復元（Codex の scope）は項目の版を 0 に戻す（復元の行に版が無い）。取り込んだ時の版（作成なら 1）と一致しないので、復元の直後の取り消しは `NEX_COMMIT_ENTRY_EDITED` で拒まれる。**ただし、復元の後の編集で版が 1 に戻ると、版だけを比べる専用の守りは通る**（作成・patch とも）。この衝突は、変更の記録の連続性の検査（取り消しの before は取り込んだ時の状態、head は復元の後の編集）が `NARRATIVE_CHANGE_FEED_DISCONTINUITY` で止める。編集は残り、項目は消えず、patch の要約も戻らない。Codex の側では、専用の守りだけでは足りず、連続性の検査が実質の守りになる。
- (f) 3 つの出来事を取り込み、出来事に触れない復元の後に、一部だけを編集（題名、参加者、場面の紐づきの解除のそれぞれ）：取り消し全体が `NEX_COMMIT_EVENT_EDITED` で拒まれ、3 つの出来事と紐づきが残り、commit の状態は `applied` のまま。
- (g) 場面の Chronicle patch（`temporal.scene.metadata.patch`）の取り込み（版 0 → 1。スナップショットは取り込みの前）→ Body の復元（場面の版は 0）→ 作者が場面を編集（`tree_node_patch`、版 1 = 取り込んだ時の版と一致）→ 取り消し：専用の守り（版だけ）は通るが、連続性の検査が `NARRATIVE_CHANGE_FEED_DISCONTINUITY` で止め、編集は残る。（試験 `tests/temporal_constraint_commit.rs` の `commit_undo_after_restore`。）
- (h) 出来事の Chronicle patch（`temporal.event.metadata.patch`）：(g) と同じ形（復元で版 0、復元の後の編集で版 1 が衝突）。`NARRATIVE_CHANGE_FEED_DISCONTINUITY` で止まり、編集は残る。
- (i) Codex の detail value の patch（`codex.detail.value.set`、版 1 → 2。スナップショットは取り込みの前）→ Codex の復元（版 1）→ 作者が `detail.value.upsert`（版 2 = 取り込んだ時の版と一致）→ 取り消し：専用の守りは通るが、`NARRATIVE_CHANGE_FEED_DISCONTINUITY` で止まり、編集は残る。（試験 `tests/codex_narrative_commit.rs` の `undo_of_a_detail_value_patch_after_a_codex_restore_and_a_later_edit_is_stopped_by_the_feed`。）
- 以上の確かめた種類（出来事の作成、Codex の項目の作成・patch、場面と出来事の Chronicle patch、detail value の patch）では、復元の後の編集が黙って消える・巻き戻る筋書きは見つからなかった。**外すのは、この種類だけである。**
- **守りの実体**：版だけを比べる種類（Codex の項目・detail value・場面と出来事の Chronicle patch）で、復元の後の編集と版が衝突しても止まるのは、変更の記録の連続性の検査（head の after と今の before の一致）が働くからである。**この守りは、書き込みが head を通ること（製品の Rust の書き手は全部通る）に依存する。** head を書かない書き込み（SQL の直書きなど）を挟んで版が一致すると、連続性の検査は止めず、取り消しが復元の後の値を取り込みの前に戻す。点検では、(i) の作者の編集を head を書かない `UPDATE` に替えて確認した（取り消しが通り、値が戻り、版が 3 になった）。ここでは再実行していない。点検の報告では、製品の Rust の書き手はどれも Feed を通る（全部の書き手をここで再確認してはいない）。実害は、SQL の直書きなど Feed を通らない書き込みに限る。

**外し方（呼び出し側の申告に頼らない）**

- `append_narrative_change_transaction_in_tx` の DR-SRC-9 の拒否に、「この Undo／Redo は取り込みの commit の replay か」を DB の事実で見分ける述語 `replays_an_apply_commit` を足す。真なら拒否しない。判断の根拠は、lineage root（replay される forward transaction）の DB の行と、その行が指す commit と journal の行、およびその commit の操作の行だけである。root が、同じ project の `cause_kind = 'forward'`、`origin = 'ai-apply'`、`source_domain = 'narrative.commit.apply'`、`commit_id`／`journal_id` が今の Undo／Redo の commit／journal と一致し、`narrative_apply_commits` と `narrative_commit_journals` に同じ commit の行があること。呼び出しの引数の `commit_id`／`journal_id` は、**root の行の commit／journal と一致するかを確かめるためにだけ読む**（commit の root を replay するなら commit を名指すしかない。名指さなければ偽。引数の申告を信じて真にはしない）。今の transaction の `origin`／`source_domain` は使わない。
- **種類の条件（改訂で足した）**：commit が含む操作の種類を、次の 2 つの DB の行で確かめ、**両方が、確かめた種類だけ**のときに真にする。(1) journal（`narrative_commit_journals.after_json` の `entities`。取り消し・やり直しが実際に replay する行）の全 entity の `(entityKind, opKind)` が、確かめた組 `(event, create)`、`(codex_entry, create)`、`(codex_entry, patch)`、`(temporal_scene_chronicle, patch)`、`(temporal_event_chronicle, patch)`、`(codex_detail_value, patch)` のどれかであること（`opKind` が無い entity は、undo.rs と同じく `create` として読む）。entity が 0 件、`after_json` が欠ける・読めない・`entities` が配列でない場合は偽。(2) `narrative_apply_operations.operation_kind`（その commit の全行）が、`chronicle.event.create`、`codex.entry.create`、`codex.entry.patch`、`temporal.scene.metadata.patch`、`temporal.event.metadata.patch`、`codex.detail.value.set` のどれかで、1 行以上あること。**確かめた種類と確かめていない種類が 1 つの commit に混ざるときは偽（拒む。安全な側）。** detail value の作成（`codex_detail_value` の `create`）は確かめていないので、(1) が弾く（`codex.detail.value.set` は作成にも patch にも使われるので、種類は journal の `opKind` で決める）。journal の entity の種類は、書き手（`commit.rs`）が commit のときに決め、取り消し・やり直しは更新しても kind を変えない（`update_journal_after`）。述語の否定の試験は `change_feed_restore_entry_tests.rs` の `replays_an_apply_commit_predicate`（origin・source_domain・cause_kind・commit／journal の食い違い・名指しなし・別 project・種類〔確かめていない entity、混ざった commit、journal の欠落・不正、操作の行の欠落・確かめていない種類〕の各形で偽）。復元を通した確かめていない種類の試験は、`plot_thread_narrative_commit.rs`・`foreshadow_narrative_commit.rs`・`temporal_constraint_commit.rs`・`codex_phase_detail_commit.rs` にある（復元の marker の後の取り消し・やり直しが `NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE` で拒まれ、何も変わらない）。
- 呼び出しの引数に「復元を無視する」の印は足さない。新しい入口（`pub(crate)` の関数）も足さない。`append_narrative_change_transaction_in_tx` の型は変えない。schema・migration・列・索引は変えない。
- 本番で `commit_id` と `journal_id` を持つ Undo／Redo を書くのは、`narrative_extraction/undo.rs` の取り込みの取り消し・やり直しだけである（source を `commit_id: Some` で検索した。他の typed writer の replay は commit を名指さない）。

**信頼境界**

- N-API・IPC・MCP から呼べる別の Undo は、この述語に当たらない。journal の replay（`agent_undo_journal`）と typed writer の inverse は commit を名指さないので、述語が偽になり、今までどおり `NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE` で拒まれる（`tests/snapshot_restore_feed_continuity.rs` の既存の試験が固定している）。commit を名指す Undo は、既存の検査（original が同じ commit に属すること、journal が commit に属すること）を通らなければ書けず、述語はさらに root が commit の本物の apply であることを DB で確かめる。
- 述語が真でも、連続性の検査（DR-SRC-6）は外れない。復元の後に書いた object は head が marker より新しいので、取り消しの before との食い違いは `NARRATIVE_CHANGE_FEED_DISCONTINUITY` で止まる。
- 正直な限界（DR-SRC-6 から引き継ぐ）：pub の append を呼べる同一プロセスの Rust 書き手は、commit の root を名指す Undo を直接書ける（取り込みの専用の守りと拒否を飛ばせる）。この書き手は、元から任意の行を書けるので、新しい権限ではない。

**作者から見える動き**

- **確かめた種類の commit だけ**、復元の後も、取り込みの取り消し・やり直しを押せる。確かめていない種類〔Codex の phase、semantic binding、場面の story-order、Plot thread、Foreshadow、時間の node・constraint・projection、detail value の作成、Codex の関係、bind-existing〕を含む commit は、復元の後は今までどおり `NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE` で拒まれ、何も変わらない（混ざった commit も拒む）。確かめた種類の結果は次のどれか。(1) 出来事に触れない復元（Codex の復元など）の後は、取り消し・やり直しが今までどおり通る。(2) 出来事を含む復元（Body の復元）の後は、取り消しが「取り込んだ後に編集されている」の系統の符号（`NEX_COMMIT_EVENT_EDITED` など）で拒まれる。以前は `NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE` だった。出来事は残る。(3) 復元の後に編集した出来事・項目は、取り消しで消えない・戻らない。(4) 取り込みの前のスナップショットへ復元して出来事が消えた後のやり直しは、出来事を作り直す（作者が押したときだけ）。
- 復元の成功の後は renderer が reload され、履歴は消える。main window では、この違いは、別窓に残った履歴からの操作でだけ見える。

**残るもの**

- **確認 88 の条件（専用の守りで、復元の後の編集が巻き戻らないことを、試験で確かめてから外す）は、確かめた種類についてだけ満たした。** 述語は、確かめた種類だけを拒否の対象から外す（上の「種類の条件」。最初の実装は種類を問わず外していたが、改訂で絞った）。確かめた種類は、出来事（Chronicle の作成）、Codex の項目（作成・patch）、場面と出来事の Chronicle patch、detail value の patch である。
- **確かめていない種類は、拒んだまま**（復元を通した試験を足していない。確かめられなかった筋書き）：Codex の phase（create／patch）、semantic binding、場面の story-order（`temporal.story-order.materialize`）、Plot thread（thread／marker／branch）、Foreshadow、時間の node・constraint・projection、detail value の作成、Codex の関係（`codex.relation.create`）、bind-existing。これらは版などの比較（`undo.rs` の `preflight_undo_entity`）と連続性の検査で守る点は同じだが、復元の後の編集で版が一致する場合に連続性の検査が止めることは、この種類では確かめていない。Plot・Foreshadow は書き手が before を head から取る（DR-SRC-10）ので、連続性の検査が働かない可能性がある。確認 88 の条件のとおり、確かめていない種類は外さず、述語の対象を確かめた種類に絞った（改訂）。確かめた種類を広げるには、その種類ごとに、復元を通した試験（復元の後の編集で版が一致する筋書きを含む）で確かめてから、述語の表（`change_feed.rs` の `REPLAY_EXEMPT_ENTITIES`／`REPLAY_EXEMPT_OPERATIONS`）に足す。足すときは、確認 88 の範囲か、あらためてユーザーに伺うかを、その時に決める。
- 復元の行に版が無い scope（Codex の項目、場面、Snippet）は、復元で版が 0 に戻るので、版だけを比べる守りは、復元の後の編集と衝突し得る。衝突は連続性の検査が止める（確かめた種類で確認済み。上の「守りの実体」の限界つき）。
- browser-mock は、`narrative_extraction` の commit の取り消し・やり直しを持たないので、変えない。
