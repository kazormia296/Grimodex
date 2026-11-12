# CQ-AVAIL の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQA-1 | 2026-10-14 | CQ-AVAIL | Graph の node の同一性から Scope を外し、Scope は binding（Revision）ごとに持つ。本当の版の矛盾だけを ENDPOINT_VERSION_CONFLICT に残す。worker の frame の版を上げて node が binding ごとの Scope を運べるようにし、内側の上限は proposal/6 の規則で決めて記録する | actor と受信先は変えない。A3 は Revision ごとに評価済みで、edge は exact binding を持つ（post-B §6.3 に合う）。frame の全体の上限は変えない | 代表の版に畳む（§6.3 に触れるので [precheck]）。何もしない（場面ごとの review で中心人物が常に unavailable） | 現実形の検証（opus、read-only）：実装の欠陥で委任の範囲 | 該当なし | 不要（worker の lifecycle は変えない） | 記録済み（実装前） |
| DR-CQA-2 | 2026-10-14 | CQ-AVAIL | node 上限・edge 上限・版の衝突に型付きの理由を与え、空の Graph を worker でも available（寄与 0）として返す | 拒否の条件は変えない。in-process と worker の結果を揃える | 空の Graph を typed unavailable に揃える（可用性の記録で常に unavailable の状態が増える） | 同上 | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-3 | 2026-10-14 | CQ-AVAIL | project 単位の読取（Scope authority の tree、binding、registry、epoch、query scene、POV）を query で1回だけ読み、1回だけ admit する。Revision に結び付く行は Revision ごと。読取を減らさずに課金だけを減らすことはしない | 上限の値は変えない。post-B の「request-local で重複検証を抑える」に合う。読取と課金を1対1に保つ | 課金だけ減らす（閾値の緩和で [precheck]）。何もしない（2件目の Revision で 512 を超える） | 同上 | 該当なし（値も数え方の対象も変えず、実際の読取を減らす） | 不要 | 記録済み（実装前） |
| DR-CQA-4 | 2026-10-14 | CQ-AVAIL（レビュー指摘の修正） | Full workload allocation の worker.q512 の reviewed inventory を、新しい Q512 fixture（materials 164、registry の参照 5、材料の無い Scene 60）で再導出する。式は pages = 679 + 21×materials + 93 + refs に、材料の無い Scene の項（Scene ごとに tree_nodes／FTS／Scene binding の 20 の table・index 面に 1 page ずつ）を足す。式の導出は schema-contract.json と sqlite_master の数え直しによる。派生する fullMemoryRisk の「other-full-consumers」の DB 項と、その合計の試験定数、docs/pr610-full-workload-risk.md の数値も合わせる。journey の inventory（schema baseline + 旧 Q512 の mutation image の size class）は再導出しない | 資源の見積りを増やす方向だけ（安全側）。新しい送信先、保存範囲、閾値の緩和は無い。dataset は独立 review が前提なので、変更は PR 本文と台帳に残す | 式を変えず 679 + 21×164 + 93 + 5 = 4,221 pages にする（Scene 項なし。材料の無い Scene 60 の tree／Scene binding の行を見積りから落とす）。journey の inventory も新 Q512 に合わせて再導出する（製品 journey は C-query fixture を使わないので根拠が無い） | 指摘 P2（レビュー）が方針を示した | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-5 | 2026-10-14 | CQ-AVAIL（レビュー指摘の修正） | DR-CQA-3 の「読取と課金は 1 対 1」を、読取の回数（statement）の単位に限定する。Scope extension の LEFT JOIN が読む principal の Codex 行（knowledge holder／audience が character の binding あたり最大 2 行）は課金に入っていない既存の会計の穴で、本変更が増やしたものではない。課金は厳しくせず、残る制約として台帳に記録する。あわせて、課金された rows を製品側で観測する試験（test-only の hook）に置き換える | 上限の値は変えない。課金を厳しくする案は、DISCLOSURE_GLOBAL_ROWS_SQL の追加で A3 の観測 slot と steps の基準値が動き、別 lane の範囲になるので採らない | 課金に principal の行を足す（委任の範囲だが、SQL steps と診断 slot に波及する）。何もしない（台帳の「保守的な上限」が実際と食い違う） | 指摘 P3（レビュー）が両案を示した | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-6 | 2026-11-11 | C-query の場面数の壁（A-α）。枝 `claude/cquery-binding-join`（DR-GRW-5＝#862 の head の上） | Scope extension の binding の SELECT から `LEFT JOIN tree_nodes` を外し、`sceneOwned` を authority が読んだ nodes の「project の Scene の id の集合」で決める（読取 −N_b）。`DISCLOSURE_GLOBAL_ROWS_SQL` の binding の行の乗数を 2→1 にする（課金 −N_b。課金−実読の差 N_t−P は不変）。閾値（2,048 ほか）・bytes の乗数・tree の×2 は変えない | 上限の値は変えない。行の数では、課金されていなかった join の N_b を読まなくし、CQ-AVAIL から残っていた binding の 2 回目の N_b の課金を外す（下の「×2 の由来と、委任の判断」）。文の単位では binding の表の読みは減らず課金だけが減るので、DR-CQA-3 の線の内とは断じず、2026-11-11 にユーザーが承認した A-β（課金を実読に合わせる）の一部として扱う（統合者の判断）。同じ snapshot の読みだけ。新しい送信先・保存・契約・authority・schema は無い | 課金だけ減らす（緩和で [precheck]）。A-β（課金を実読に合わせる。確認が要る）。join を残す（床は 489 のまま） | 設計調査（`cquery-scene-wall-2026-11-11.md` §2、§4、§5.2）が A-α を「委任内の見込み」とした。実装後に advisor（read-only）に諮り、停止条件 1 の読み替え、床の限定、試験の allowlist 化、記述の訂正の指摘を受けて反映した | 承認済みの A-β の範囲（課金を実読に合わせる。2026-11-11 ユーザー決定）。値・新しい閾値・契約は変えない。principal の行を数える残りは A-β の PR で入れる | 不要（thread・handle・取消点・再開の状態を足さない。下の節） | 記録済み（実装と同じ commit に記録） |
| DR-CQA-7 | 2026-11-12 | C-query の場面数の壁（A-β。行の課金を実読に合わせる）。枝 `claude/cquery-charge-actual`（DR-CQA-6＝#869 の head `f7ece285` の上） | `DISCLOSURE_GLOBAL_ROWS_SQL` の `tree_nodes` の COUNT の乗数を 2→1 にし（authority が tree を読むのは 1 回）、projects と query Scene の COUNT の乗数を 1→2 にし（query はこの 2 行を各 2 回読む）、principal の Codex 行 P（Scope extension の binding の SELECT が `LEFT JOIN codex_entries kh`／`au` で読む行）を数える文 `SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL` を `preflight_project_reads` に足す（×1。kh と au は別に数える）。P の文は extension の SELECT と同じ join の文（macro で 1 つの文字列）から作り、binding を読んで `COUNT(kh.id)+COUNT(au.id)` を返す。bytes の乗数・閾値（2,048 ほか）・registry・binding の×1・join の tree 行の 0 は変えない | 上限の値と bytes の乗数は変えない。数える行を実際に読む行に合わせるだけで、実読を下回る数え方は作らない（P は実読と同じ join の結果。join が行を見つけた後に落とす形〔別 project の character、character でない entry〕は、CHECK や FK を切って書いた DB にしか無く、数えない）。新しい送信先・保存・契約・authority・schema・依存は無い。同じ snapshot の中の読みが 1 文増える（binding を project 単位で 1 回走査し、codex を主キーで引く） | 表 `DISCLOSURE_GLOBAL_ROWS_SQL` に行を足す（診断の slot が 9 に衝突し、material rows と bytes の slot を全部ずらす）。binding の COUNT 文を `COUNT(*)+COUNT(kh.id)+COUNT(au.id)` にして 8 行のまま保つ（依頼の「文を足す」から外れる）。P を課金せず tree だけ×1 にする（実読を下回る緩和で承認の外）。bytes も×1 にする（4 Revision の台帳の壁が動くので別の決定） | 着手前に advisor（read-only）に 1 回諮り（表の外に足す、slot は末尾の 23、P の文は extension の FROM を写す、512 の扱い、床は bisect で取り直す）、実装と測定の後にもう 1 回諮った（feature 付きの試験と clippy の取り直し、pin の確認、時間の対照の書き方、DR の記述の根拠、512 の説明、最終 HEAD での verify:quality の取り直し）。指摘は反映した | 2026-11-11 にユーザーが承認した A-β（「二重の読みを省き、読む行と数える行を同じだけ減らします（約 652 場面、委任内の見込み）。その上で、数える行を実際に読む行に合わせます（約 978 場面）。後者は、数え方の緩和に当たります。上限 2,048 の値は変えません。」）の範囲の**行（rows）の課金だけ**。bytes の乗数は変えない（別の決定）。値・契約・新しい閾値・D2・B・100 ms の壁・主人公級は含まない | 不要（thread・handle・取消点・再開の状態を足さない。下の節） | 記録済み（実装と同じ commit に記録） |
| DR-CQA-8 | 2026-11-12 | C-query の場面数の壁（A-β の bytes。共有読みの bytes の課金を実際に読む bytes に合わせる）。枝 `claude/cquery-bytes-actual`（origin/master `a067f7f7`＝DR-CQA-7 #871 の上） | `DISCLOSURE_GLOBAL_BYTES_SQL` の共有読みの 7 文（Revision に結び付く decision の文は対象外）を、query の経路（`Nir1ProjectReads::load`）が実際に返させる列の bytes を、実際に読む回数だけ数える形に直す。tree：authority が読む 6 列（`version`・`updated_at` は読まないので外す）を ×1（旧 ×2）。registry：2 文が読む列（`registry_version`、JSON 3 つ、`version`×2、`source_token`×2、`updated_at`）を ×1（旧は全体 ×2 で `source_token` が実質 ×4、`version` なし）。binding：extension の SELECT が返す 10 列（`version` を足す）を ×1（旧 ×2）と、join が成り立った principal の Codex 行の `id`（`kh.id`／`au.id`。extension が flag に評価する列）を足す。query Scene：`version` を足す（`read_retrieval_scene_source` が読む）。Epoch：`epoch_number` を足す。projects・POV の Codex の `type` は変えない。述語だけで読む列（`project_id`、`node_type`、`context_mode`、principal の Codex の `project_id`・`type` など）は、既存のどの文とも同じく数えない。表は 8 行のまま（診断の slot を動かさない）。閾値（2,048、2 MiB、6,291,456、Q、100 ms ほか）・rows の課金は変えない | 上限の値は変えない。数える bytes を実際に読む列の bytes に合わせる（旧は読まない列を足し、同じ読みを 2 回数え、読む列を数えていなかった。下回る数え方は作らない）。これは 2026-11-11 にユーザーが承認した「数える行を実際に読む行に合わせます」の bytes 側（DR-CQA-7 が別の決定に残したもの）で、2026-11-12 の「全て並列に実装して下さい」の指示の範囲。同じ snapshot の中の読みだけ。新しい送信先・保存・契約・authority・schema・依存は無い。binding の bytes の文が principal の Codex 行を主キーで引く join を持つ（P の文と同じ join の macro。読む行は P の文の分だけ増え、新しい読みではなく既存の extension の読みと同じ行） | bytes の乗数だけ変える（読まない列と読む列の食い違いが残り、「実読に合う」とは言えない）。表に文を足す（診断の slot が衝突）。述語の列も数える（既存の文との一貫性がなく、tree の `project_id` など全行の 36 B を足すことになる。承認の範囲を超えて厳しくなる） | 着手前に advisor（read-only）に 1 回諮り（列ごとの照合、registry の乗数 0 の読み替え、述語の列の除外を DR に明記、試験の oracle は製品の文の返す値と摂動、`a_query_loads_the_scene_bindings_in_one_statement` の書き直し、時間切れを壁として数えない、bytes の壁は行が少なく bytes が大きい形で確かめる）。指摘は反映した。実装と測定の後にもう 1 回諮った（lifecycle の binary が dev の 10 s の lease の写しにならないこと、timing_plan の腕の commit、最終 tree での clippy、DR の未記入の節、UUID の p4、効果の書き方〔733 は admission の壁で、100 ms の lease で通るかは未確認〕）。指摘は反映した | 承認済みの A-β（課金を実読に合わせる。2026-11-11）の bytes 側。値・新しい閾値・契約は変えない。主人公級・100 ms・Q の壁・D2・B は含まない | 不要（thread・handle・取消点・再開の状態を足さない。下の節） | 記録済み（実装と同じ commit に記録） |

## DR-CQA-6 の詳細（2026-11-11）

基点は PR #862（DR-GRW-5）の head `43dbdcf3`、枝は `claude/cquery-binding-join`。設計の正本は
`fusion-eval-data/design-notes/db-connection-2026-11-07/cquery-scene-wall-2026-11-11.md` の §2、§4、§5.2「A-α」と、§5.2 末尾の「S の修正 1b との順序」
（1b＝DR-GRW-5 が先、A-α はその上。同じ関数を触るため）。
**値（上限・閾値・契約・authority・admission の閾値・schema）は変えない。**

### 決定

1. `scene_scope.rs` の `read_scope_extension_entries` の SELECT から `LEFT JOIN tree_nodes s` を外す。SELECT は 12 列（`sceneOwned` を除く）を返し、
   `sceneOwned`（raw の 11 列目）は `ProjectSceneIds`（project の `node_type='scene'` の node の id。archived を含む。sort して `binary_search`）で決めて、
   `SqlValue::Integer(0/1)` として 11 列目に差し込む。`rawDigest` が見る 13 列の値は旧と同じ。
2. 呼出し元 `project_scope_authority.rs` の `load_live_project_scope_authority_in_snapshot` は、`derive_live_scene_projection` の後で
   `scene_ids_of(&nodes)`（Scene の id を 1 つの buffer に写した集合。確保は buffer と span の 2 つ）を作ってから `drop(nodes)` する（下の「時間の対照と、集合の形」）。
   DR-GRW-5 の `drop(nodes)` は、集合を残す形に置き換わる（`scenes` の drop は変えない）。
3. `nir1_graph/input.rs` の `DISCLOSURE_GLOBAL_ROWS_SQL` の `COUNT(*) narrative_scene_scope_bindings` の乗数を 2→1 にする。
   bytes の乗数、tree の行の×2、registry、projects、query Scene、POV、Epoch は変えない。
4. 旧の join の SQL は `#[cfg(test)]` の oracle（`SCOPE_EXTENSION_LEGACY_JOIN_SQL`、`SceneOwnership::LegacyJoin`、
   `load_live_project_scope_authority_with_legacy_join`）として残し、新旧を比べる。

### 数え方の変化

| | 読取（query 1 本の実読） | 課金（`preflight_project_reads`） |
|---|---|---|
| 旧 | N_t（authority の tree）＋ N_b（binding）＋ N_b（join の tree 行）＋ P ＋ 2R ＋ 3 | 2N_t ＋ 2N_b ＋ 2R ＋ 3 |
| 新 | N_t ＋ N_b ＋ P ＋ 2R ＋ 3（**−N_b**） | 2N_t ＋ N_b ＋ 2R ＋ 3（**−N_b**） |
| 課金−実読 | N_t − P | N_t − P（**不変**） |

読取と課金を同じ N_b だけ減らす。project ごとに見れば、課金−実読の差は変わらない。principal の Codex 行 P を課金しない穴（DR-CQA-5）は、そのまま残る（A-β の範囲）。
**ただし通る project の範囲が広がるので、課金が実読を下回ったまま通る query の実読の最大は上がる**（独立レビューの P2-1）。P＞N_t の形（binding あたり平均 1 件を超える character の principal）では、
旧は拒否、新は通る 490〜652 場面の project がある。例：bare に P＝2N_b を足した形の実読は、旧の床 489 で約 2,463 行、新の床 652 で約 2,626 行（2,048 からのはみ出しは約 415→約 578 行）。
P≤N_b の形では実読＜課金≤2,048 で、問題は無い。この広がりは、A-β で principal の行を数えるまで残る。

### ×2 の由来と、委任の判断（独立レビューの P2-1 の後に書き直した）

- 由来（コードと履歴で確認）：post-B（`fb967eb9`）の A3 は、Revision ごとに Scope authority を全件 2 回 load していた（`validate_live_sources` の中の load と、`evaluate_nir1_entity_relation_disclosure` の中の load）。
  tree×2・binding×2 は「authority を 2 回 load する」ことの課金で、binding の bytes が×2 なのもこれと合う。join で読む tree の行は、当時から課金されていなかった（P と同じ種類の穴）。
  CQ-AVAIL が load を 1 回にしたとき、×2 は「旧来のまま」残った（台帳 `nir1-c-query-acceptance-2026-10.md` の 363 行付近）。
- したがって A-α は、正確には「課金されていなかった読み（join の N_b）を読まなくし、CQ-AVAIL から残っていた過大な課金（binding の 2 回目の N_b）を外す」変更である。行の数では差し引きが合う。
  DR-CQA-5 は「1 対 1」を文（statement）の単位に限っていて、その単位では binding の表の読みは減らず、binding の課金だけが減る。
- 判断（統合者）：これは DR-CQA-3 の「課金だけ減らす」に当たりうるので、委任の内とは断じない。2026-11-11 にユーザーが承認した A-β（数える行を実読に合わせる＝数え方の緩和）の一部であり、
  その承認の範囲として進める。A-β の残り（tree×2→×1、join の tree 行と principal の行を数える）は別の PR で入れ、その前に設計 §7 の 5・8・9（現実の形、孤立した binding、principal の分布）を測る。
  上の「広がり」が A-β までの間だけ残ることを、ユーザーに報告する。
bare の fixture（N_t＝n＋1、N_b＝n、P＝0）の shared は 4n＋19 から 3n＋19 になる。

### 等価性の根拠

- 旧の条件：`s.id = b.scene_id AND s.project_id = b.project_id`（`tree_nodes.id` は主キーなので 0〜1 行）と `s.node_type='scene'`。`archived_at` は見ない。照合は BINARY
  （`tree_nodes.id` に COLLATE は無い）。新：同じ project の node 全件（authority の SELECT は `WHERE project_id=?1` で archived を含む）のうち `node_type='scene'` の id の集合。
  `b.project_id = ?1` なので `s.project_id = b.project_id` は「その project の node」と同じ。主キーが一意なので、集合の membership と join の結果は一致する。
- binding の `scene_id` が Text でない行（BLOB）は、旧は TEXT と BLOB が等しくならず 0。新は 0。
  列は TEXT affinity で、整数は '7' の text として保存されるので、Text の経路に入る（旧と同じ）。`scene_id` は NOT NULL なので NULL の行は作れない（試験では作れない。
  コードは Text 以外を 0 にする）。
- 「missing or belongs to another project」の error は同じ位置・同じ文（loop の中の closure は diff に無い）。行の順（`ORDER BY b.scene_id`）も変えない。
  closure の error は loop の match で捨てられ、digest に入るのは `unavailable` の entry の `rawDigest`（13 列の raw。`sceneOwned` を含む）だけである。error の文は外から見えないので、等価性の対象は `rawDigest` を含む entry の一致である（error の文の一致は、この試験では確かめていない）。
- 集合の照合は SQL の `ORDER BY id` の並びに頼らず、`ProjectSceneIds::from_unsorted` が sort と dedup をする。
- **transaction**：ただ 1 つの入口 `load_live_project_scope_read` が、nodes の読みと extension の読みを同じ `SAVEPOINT narrative_project_scope_authority_snapshot` の中に置く
  （autocommit で呼ばれても、SAVEPOINT が transaction を始め、最初の読み〔`projects`〕で snapshot が決まる）。したがって、どの入口でも nodes と extension は同じ snapshot で、
  join の頃と同じ時点の tree を見る。`load_live_project_scope_authority`（collect なし）と `..._with_scene_bindings` のどちらもこの入口を通り、autocommit の入口で nodes と extension の間に
  別の snapshot が入る経路は無い。

### query の経路で binding の表に触れる文（停止条件 1 の確認）

作業の依頼は「query の経路で、extension 以外の binding の表を読む文が走るなら止める」だった。**文字どおりには、extension 以外にも binding の表に触れる文がある。**
SQLite の authorizer（文を prepare するときに、その文が読む列の許可を求める）で、query 1 本の間に準備された文を数えた
（`a_query_loads_the_scene_bindings_in_one_statement`。列と文の数の全体を完全一致で固定している）。authorizer が数えるのは prepare の回数で、実行の回数ではない。query の経路に `prepare_cached` は無く、実行の回数は既存の probe の試験 `project_level_reads_are_made_once_and_charged_as_made` が断言している。

| 文 | binding の表に触れ方 | 課金 | ×1 への影響 |
|---|---|---|---|
| extension の SELECT（`SCOPE_EXTENSION_SQL`） | binding の行を全部読む（`version` を読む唯一の文） | `COUNT(*)` の行（乗数 2→1） | 本変更の対象。1 回だけ |
| preflight の `COUNT(*)` | 読む列は `project_id` だけ | 課金の文そのもの | 無し |
| preflight の bytes の SUM（`octet_length`。`version` は読まない） | binding の payload の列を `octet_length` で読む | bytes（乗数 2。変えない） | 無し。旧も同じ会計 |
| Scene join の場面ごとの token の 2 列（`scenes.rs` の `SCENE_BINDING_LENGTHS_SQL`、`SCENE_BINDING_SQL`） | pin された場面の `scene_incarnation_id` と `source_token` | `SceneJoinBudget`（場面ごとに `1 + binding の有無` 行）で別に課金 | 無し（shared の ×1 とは別の会計）。この試験の query は場面を pin しないので、この読みは試験で走らせていない（コードの読みで確認） |

別の reader `preload_material_scene_scopes`（同じ 13 列。`scene_scope.rs`）は、呼出し元が `retrieval_admission.rs`（`build.rs` を含む）と `nir1_chronicle_index/build.rs` で、
Graph の query（`query_in_snapshot`、`Nir1ProjectReads::load`）からは呼ばれない。query の経路で走らないことの根拠は、呼出し元の読みと、上の authorizer の列挙（`version` が 1 回）である。
preflight の 2 文は旧も新も読むが、課金の側の文で、旧来どちらの会計にも「読取」としては入っていない（本変更が増やした読みではない）。
したがって ×1 が過少課金になる文は見つからなかった。ただし「extension の 1 つだけ」は成り立たないので、この読み替えは統合者の判断を要する（報告に明記した）。

### 床の限定

床の 652／653 は、実 worker の process ではなく、worker の構成（`worker_reader`、`query_for_worker_with_maintenance_deadline`）を in-process で動かした値である。
admission の式と文は worker と同じコードで、同じ試験を乗数 2 に戻すと実 worker の実測（489／490。`drift-measure/cquery-scenes-2026-11-11`）を再現した。
実 worker でも測った（dev、`fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/cquery-binding-join-2026-11-11/`）：652 場面で available、653 場面で `candidate-record-limit`。
query の Q 高水位は 489 場面と 652 場面で同じ 3,814,832 B（22.74%。load の前の床の値で、load の peak はこの下にあり見えない）。4 Revision（p4:300000）の 352／353 は動かなかった。

### 変わる点

- 1 Revision の bare の形（設計 §3.1 の p:300000）の床：489 → **652**（実測。N で available、N＋1＝653 で `candidate-record-limit`）。予測は 652〜653。
  式は 37＋(3n＋19)＋13＋t ≤ 2,048（t＝20〜23）。旧の 489 は同じ試験を乗数 2 に戻して再現した（489 で available、490 で `candidate-record-limit`）。
- Q（設計 §5.1 の見込みは、通る最大で A 約 8.2〜8.4 MB、C で約 10〜11 MB）：この変更は DR-GRW-5（1b）の上に載せるので、query の load の Q は 1b の後の傾きで増える。実測は上の床の節のとおり。
- 読取が N_b 行減るので、extension の SELECT の VM steps も減る（上限・基準値の変更は不要。全件の試験が通る）。
- 集合 `ProjectSceneIds`（Scene の id を写した 1 つの buffer と、場面あたり 16 B の span）が生きる。
  集合は extension の間だけでなく、`build_narrative_project_scope_authority_v1` の間も生きる。DR-GRW-5 は nodes 全体を drop していたので、その分だけ保持が増える。非 Scene の node と各 node の他 field は引き続き早く解放される。
  実 worker の registration の S 高水位は、489 場面で不変、5,004 場面で +150,122 B、20,004 場面で +600,122 B（約 30 B/場面）。すべて READY し、registration の Q は不変だった。

### 時間の対照と、集合の形（2026-11-11、dev の実 worker）

- 最初の実装は、Scene の id の String を nodes から move して `Vec<String>` で持った。4 Revision（p4:300000）の 352・337 場面で、基点（`43dbdcf3`＋harness）と交互に各 8 本流すと、
  `NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`（100 ms）が A-α 12／16 本、基点 2／16 本で、worker 内の query_ms は約 13〜14 ms 長かった。
- 内訳：admit の回数・種類・値、評価した Revision、候補 page、frame の bytes、Q 高水位は両腕で同じで、読む量は増えていない。scope の load の段ごとの時間にも差は無かった。
  違ったのは allocator の fragment の数（QUERY_DONE の時点で A-α 362〜402、基点 267〜295）。場面ごとの小さい String が、固定の Q heap に散って残り、その後の確保が遅くなったと見ている（推測）。
- id を 1 つの buffer に写す形（診断用の変形）では、fragment は 344〜353、query_ms の中央値は 84.5 ms（基点 83、最初の実装 90.5）で、増えの約 6 ms が戻った。製品の形はこれに合わせた。
  残りの約 +1.5 ms と fragment の差は説明できていない。
- 製品の形（`&nodes` から 1 つの buffer に写してから `drop(nodes)`）で取り直した（基点と交互に各 8 本、loadavg 2.3〜4.2）：時間切れは 352 場面で 3／8 対 2／8、337 場面で 3／8 対 4／8（計 6／16 対 6／16）。
  worker 内 query_ms の中央値は 87 対 83 ms、89.5 対 88.5 ms で、差は run のばらつきと同程度。fragment の数は基点より約 60〜70 多いまま（原因は未確認）。
  1 Revision の床は製品の形でも 652 で available、653 で `candidate-record-limit`、Q 高水位は同じ 3,814,832 B。
- 4 Revision・約 340〜350 場面の形は、基点でも 100 ms の期限に数割の確率で当たる（設計の「時間の壁」。本変更の範囲外）。
- 記録：`fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/cquery-binding-join-2026-11-11/results.md`（「対照」「対照 2」「内訳」の節）。

### 変わらない点

- 閾値（`MAX_GRAPH_QUERY_RECORDS` 2,048 ほか）、bytes の乗数、tree の×2、registry の読取回数（`SHARED_REGISTRY_READS`）、候補 page と共有読みが同じ枠を使う規則。
- 結果・digest（extension の digest と authority の revision_token）・`scene_bindings`・`unavailable` の entry とその `rawDigest`・error の種類と位置・SQL の bind。
- 4 Revision の形（p4:300000）は peak の台帳 6,291,456 B が先に尽きるので 352 のまま（設計 §5.1。本変更の対象外）。
- 課金−実読の差 N_t−P。principal の行の穴（DR-CQA-5）。

### 信頼境界

呼び出し元と入力は変わらない（同じ接続、同じ thread、同じ snapshot の中の読みだけ）。新しい送信先、保存範囲、契約、authority、schema、依存、閾値の緩和は無い。
digest に入る bytes は同じなので、renderer・main・MCP から見える token も変わらない。課金の変化の扱いは、上の「×2 の由来と、委任の判断」のとおり（承認済みの A-β の一部）。

### owner／lifecycle の表（GDX-PRECHECK-001）

新しい thread、接続、待ち、状態、handle、取消点、再開の状態は無い。`ProjectSceneIds` は関数の中のローカルの値で、`?` と unwind で drop される。

| 項目 | 前後 |
| --- | --- |
| 入口・開始・再試行・再入・admission・取消・有限の待ち | 変えない（admission の閾値は同じ。数える行が N_b 減る） |
| 有効な handle の所有 | 足さない |
| 終了の証拠 | 変えない |
| error／timeout／onClosed の所有 | 変えない。新しい失敗の経路は足さない |
| 保存される再開の状態 | 無い |

### 試験の期待値の変更（binding ×2 → ×1）

| 場所 | 旧 → 新 |
|---|---|
| `nir1_graph/input.rs` `DISCLOSURE_GLOBAL_ROWS_SQL` の binding の乗数 | 2 → 1 |
| `input.rs` の `disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope` | shared 8（tree 2、registry 2、bindings 2、project 1、query Scene 1）→ 7。admission の rows 10 → 9 |
| `input.rs` の `disclosure_material_counts_preserve_duplicate_entity_and_pov_joins` | rows 16 → 15。行の上限の拒否を試す値 15 → 14 |
| `nir1_graph/tests/cq_avail.rs` `rows_charged_by_the_seed_query` | `shared = 2·tree + 2·bindings + 2·registry + 1 + 1 + epoch` → `2·tree + bindings + …`（製品の課金を観測する `a_revision_costs_its_own_rows_and_none_of_the_shared_ones` など、全件が新しい式で通る） |
| `nir1_graph/tests.rs` `Q512_SHARED_ROWS`（Q512／R2：62 場面、N_t＝N_b＝62、registry 6） | 263 → 201（263 − N_b、N_b＝62） |
| 同 `REGISTRY33_SHARED_ROWS`（2 場面、N_t＝N_b＝2、registry 33） | 77 → 75 |
| 同 Q512 の charged rows（`CANONICAL_CHARGED_ROWS` を case ごとの `charged_rows` に置換） | Q512：512 → 450。registry33：512 → 510 |
| 同 `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` の `unrelated_seed_edges` | 1,537 → 1,599（450＋1,599＝2,049） |

新しい試験：`scene_scope_ownership_tests.rs`（新旧の等価）、`cq_avail.rs` の `a_query_loads_the_scene_bindings_in_one_statement`、
`the_floor_of_a_bare_one_revision_project_is_n_available_and_n_plus_1_refused`（床の N／N＋1）、`measure_the_floor`（ignore の測定。DR-CQA-7 で `measure_the_bare_floor` から改名し、`CQ_FLOOR_SHAPE` で形を選ぶ）。

### 試験

- **等価（`scene_scope_ownership_tests.rs`）**：旧の join（oracle）と新の集合で、各行の entry（`rawDigest` を含む）、`scene_bindings`、registry、extension の digest、
  authority の `revision_token` が一致する。healthy、archived の場面、note・folder を指す binding、別 project の場面を指す binding、存在しない scene_id、
  BLOB の scene_id（FK と CHECK を OFF にして作る）、接頭辞だけ違う・大文字小文字だけ違う id、整数の scene_id。unavailable の数も固定する（0、0、1、2、3、4、5、7）。
  集合の変異（`n1` を集合に足す）で試験が落ちることを確かめた。
- **読取**：extension の statement が `tree_nodes` を読まないこと（`EXPLAIN QUERY PLAN` と、authorizer が許可を求める table の列挙）。
  query 1 本で binding の `version` を読む statement は extension の 1 つだけ（`a_query_loads_the_scene_bindings_in_one_statement`）。
  ほかに binding の表に触れるのは、課金そのものの COUNT と bytes の SUM（`version` は読まない）と、Scene join の場面ごとの token 2 列で、いずれも別の課金を持つ。
- **床**：bare の 1 Revision（実 fixture `same_entity_product_fixture`、12 Entity、300 kB の要約、短い id の場面）で、乗数 2 に戻すと 489／490、新は **652／653**
  （652 で available、653 で `candidate-record-limit`。式では 653〜659 が `candidate-record-limit`、660 以上が `disclosure-record-limit`（実測は 653、656 が candidate、662、675、700 が disclosure））。

### 検証の結果（2026-11-11、commit の時点）

- `cargo test -p grimodex-db --lib` 全件：**2,652 passed、0 failed、57 ignored**。
  `cargo clippy -p grimodex-db --all-targets -- -D warnings`：通る。
- `scripts/nir1-c-query-worker-ci.sh lifecycle`：26 case の `test result: ok`（終了コード 0）。registry33 は shared 75、admitted 510 で通る。
- Q512（実 worker。lifecycle の外なので、同じ手順〔`nir1-material-capacity fixture`、worker の build、2 つの ignored test〕を手で実行）：
  `native_worker_returns_canonical_512_a3_eligible_seed_local_graph` は shared 201、admitted 450 で通る。
  `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` は candidate_rows 1,601（2＋1,599）で `disclosure-record-limit` を返す。
  既定の lane 全体（`nir1-c-query-worker-ci.sh` の引数なし）と practical-retention は実行していない。
- `fnm exec --using=22 pnpm -s verify:quality`：通る（終了コード 0）。
- 床の 652／653 は in-process（上の「床の限定」）。実 worker の 652／653 と Q は未測定。
- 試験の限界：`scene_id` が NULL の行は NOT NULL 制約のため作れず、新旧の比較に入っていない（コードは Text 以外を 0 にする）。
  Scene join の binding 読みは、この lane の query（場面を pin しない）では走らない。

## DR-CQA-7 の詳細（2026-11-12）

基点は DR-CQA-6（PR #869）の head `f7ece285`（master に merge 済みの `5e4f1342`）、枝は `claude/cquery-charge-actual`。この文書が `3e3d2c75` と書く commit は master への rebase 後は `d072b93e` で、製品の SQL と式は同じ（rebase で変わったのは土台だけ）。その後の commit が、独立レビューの指摘（projects と query Scene の乗数、試験、記述）を直している。設計の正本は
`fusion-eval-data/design-notes/db-connection-2026-11-07/cquery-scene-wall-2026-11-11.md` の §2、§4、§5.1〜5.2 の「A-β」。
仮実装（dev 枝 `claude/dev-cquery-real-shapes` の `68195c5d`）の床の実測（`drift-measure/cquery-real-shapes-2026-11-12/results.md`）が、この PR の予測値の出所。
**値（上限・閾値・契約・authority・admission の閾値・schema）と bytes の乗数は変えない。**

### 承認と範囲

2026-11-11 にユーザーが選んだ文面（逐語）：「二重の読みを省き、読む行と数える行を同じだけ減らします（約 652 場面、委任内の見込み）。その上で、数える行を実際に読む行に合わせます（約 978 場面）。後者は、数え方の緩和に当たります。上限 2,048 の値は変えません。」
この承認の範囲は**行（rows）の課金だけ**で、bytes の乗数は一切変えない。bytes を変えると 4 Revision の peak の台帳の壁（352／353）が動き、
p4 の時間の余裕が無い形に当たるので、別の決定にする。DR-CQA-6 は A-β の一部（binding の×1）を先に入れていて、本 DR がその残り（tree の×1 と principal の行）。

### 決定

1. `nir1_graph/input.rs` の `DISCLOSURE_GLOBAL_ROWS_SQL` の `COUNT(*) tree_nodes` の乗数を 2→1 にする。authority の tree の読みは 1 回（project の全 node。folder・note・archived を含む。tree の検証に要る）。
   2 は A3 が Revision ごとに authority を 2 回 load していた頃の課金（DR-CQA-6 の「×2 の由来」）。
2. principal の Codex 行 P を数える文 `SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL`（`scene_scope.rs`）を `preflight_project_reads` に足す（×1）。
   `SELECT COUNT(kh.id) + COUNT(au.id) FROM narrative_scene_scope_bindings b LEFT JOIN codex_entries kh … LEFT JOIN codex_entries au … WHERE b.project_id = ?1`。
   - join の 2 句（`project_id` が同じ、`type='character'`、`id = CASE WHEN json_valid(<json>) THEN json_extract(<json>, '$.ref') ELSE NULL END`）は、extension の `SCOPE_EXTENSION_SQL` と
     同じ macro `scope_extension_principal_joins!()` の 1 つの文字列から作る。2 つの文は別の join を持てない。kh と au は別に数える（同じ character を両方が指せば 2 行）。
   - 文は表 `DISCLOSURE_GLOBAL_ROWS_SQL` の外に置き、`preflight_project_reads_inner` で表の後に 1 回走らせる（×1）。表は 8 行のまま（`len() == 8` の assert は不変）。
     表に足すと、診断の slot（行は `1 + index`＝1〜8、9 は material rows、bytes は 10〜、material bytes は 18〜）が 9 で衝突して全部ずれ、
     `REVISION_DECISION_CHARGES` の `"A3 global rows 7"` ほかの番号にも波及するため。
   - 診断の slot は末尾の 23 を使い（`A3_SQL_QUERY_COUNT` 23→24、`QueryA3SqlObservation.timings_ns` の長さ 23→24、`nir1_graph_memory_diagnostics.rs` の試験の期待値）、既存の slot は動かさない。
     slot 0 は空のまま（Linux probe が「A3 SQL 到達」の印に読むので、ここに別の文を置かない）。
3. `projects` の COUNT と query Scene の `tree_nodes` の COUNT の乗数を 1→2 にする（独立レビューの P2-1。コードで確かめた）。query の経路は
   - projects の行を 2 回読む：`load_live_project_scope_authority_in_snapshot` の `SELECT 1 FROM projects`（`project_scope_authority.rs`）と、`read_retrieval_scene_source`（`retrieval_admission/scene_source.rs`。projects と query Scene の join）。
   - query Scene の tree 行を、authority の全件読み（N_t）とは別に 2 回読む：`read_retrieval_scene_source` と `read_scene_viewpoint`（`nir1_entity_relation.rs`。`pov_character_id`）。
   - どれも `Nir1ProjectReads::load`（`nir1_entity_relation/project_reads.rs`）が 1 回の query の中で走らせる（`load_a3_query_context` が 2 つを呼ぶ）。
   tree×1 にするまでは tree×2 の余りが吸収していた差で、tree×1 では課金が実読を定数 2 行下回る。承認は「実読に合わせる」なので、下回る形を残さず、乗数を実読に合わせた。
   POV の Codex 行（`read_scene_viewpoint` の codex の 1 回）と最新 Epoch（`read_current_epoch` は `Nir1ProjectReads::load` の 1 回。以後は共有の値）は再読が無く、×1 のまま。
   設計 §4.2 の「実読」の式の定数 3（projects 1、query Scene 1、Epoch 1）は、projects と query Scene の再読を見落としていた。
4. 変えないもの：binding の COUNT の×1（DR-CQA-6）、join の tree 行の 0（DR-CQA-6）、registry・POV・Epoch、bytes の乗数、閾値。

### 数え方の変化

| | 読取（query 1 本の実読） | 課金（`preflight_project_reads`、旧＝DR-CQA-6 の後） |
|---|---|---|
| 旧（A-α） | N_t ＋ N_b ＋ P ＋ 2R ＋ 2（projects）＋ 2（query Scene）＋ 1（Epoch）（＋ POV 1）。DR-CQA-6 の表の「＋3」は projects と query Scene の再読を見落としていた | 2N_t ＋ N_b ＋ 2R ＋ 3（＋ POV 1） |
| 新（A-β） | 同じ（**不変**） | N_t ＋ N_b ＋ **P** ＋ 2R ＋ **2 ＋ 2** ＋ 1（＋ POV 1） |
| 課金−実読 | 旧の課金−旧の実読の式：N_t − P − 2。新：**0** | 旧：N_t − P − 2（DR-CQA-6 の「N_t − P」は −2 を落としていた）。新：**0**（P が実読の join の結果と同じ） |

bare（N_t＝n＋1、N_b＝n、P＝0、R の項は 14、Epoch 1）の shared は A-α の 3n＋19 から 2n＋20 になる。principal が全部 character（P＝2N_b）の形は 4n＋20 で、
1 Revision の床は A-α の 652 より下がる（下の「変わる点」）。

### 等価性（P の数え方＝extension の join）

- extension の SELECT は binding ごとに `kh` と `au` を `LEFT JOIN` し、join が成り立つ（`CASE WHEN kh.id IS NOT NULL`）列を最後の 2 列に返す。P の文はその FROM 句をそのまま使い、
  joined id を `COUNT` するので、P ＝ extension の最後の 2 列の合計。
- 試験（`scene_scope_principal_rows_tests.rs`）で固定する：同じ join の文字列（macro の出力が 2 つの文で一致する）、P の文の plan（binding は project の index、codex は id〔主キー〕で seek し、`TEMP B-TREE`・`AUTOMATIC` が無い。`EXPLAIN QUERY PLAN` の行を assert する）、
  各形で「課金の P ＝ extension の SELECT が返す flag の合計＝ 手で数えた期待値」：reader だけ 0、holder だけ 1、audience だけ 1、同じ character を kh と au が指して 2、別の character で 2、
  別 project の character 0、character でない type（location）0、`$.ref` が無い・null・存在しない id・数値の ref・`{"kind":"reader"}`・不正な JSON・空文字・配列（CHECK を OFF にして書く）0、
  有効な principal の隣の無効な値が有効な方の行を消さないこと、project をまたがないこと（p2 の binding は p1 の P に入らない）。
- 製品の課金そのものの観測（`cq_avail.rs` の `the_tree_and_the_principals_codex_rows_are_charged_once_each`）：同じ場面の bare と、character の principal（20 場面で＋40 行）、folder・note（＋22 行）の差を、
  query の admission（`QueryUsage::rows`）で確かめる。budget の fixture の期待値の helper（`rows_charged_by_the_seed_query`）も、principal を別の数え方（subselect の join）で足して製品の課金と突き合わせる。
- **「実読」の定義**：P は **join が成り立った行**（flag が 1 になる行）の数。SQLite は codex を主キーで引くので、ref が別 project の entry や character でない entry を指す binding では、
  その行に触れてから join の条件で落とす。落ちた行は P に入らない（依頼の定義＝extension の join に従う）。そのような ref は通常の経路では作られず
  （binding が参照している character は、削除も type の変更も `NEX_SCENE_SCOPE_CHARACTER_REFERENCED` で拒否される。`scene_scope.rs` の試験を読んだ範囲で、本 PR では実行して確かめていない）、
  あっても最大 2N_b 行の差で、1 行の主キーの seek 1 回の読み。これを数える案は取らなかった。
  通常の経路では作れない根拠：`validate_principal_ownership`（principal の ref が project の character であることの検証）と、`NEX_SCENE_SCOPE_CHARACTER_REFERENCED`（参照中の character の削除・type 変更の拒否）。
  したがって「実読を下回らない」は、**CHECK や FK を切って書いた DB のこの形を除く**。

### 信頼境界

呼び出し元と入力は変わらない（同じ接続、同じ thread、同じ snapshot の中の読みだけ）。P の文は `project_id` 1 つを bind し、binding と codex を読んで整数 1 つを返す（本文・principal の値は出さない）。
新しい送信先、保存範囲、契約、authority、schema、依存は無い。**課金の変化の扱い**：tree×1 は数え方の緩和（2026-11-11 の承認の範囲）。P を足すのは数え方を厳しくする側（実読を下回らないため）。
閾値の緩和ではなく、bytes は変えない。

### owner／lifecycle の表（GDX-PRECHECK-001）

新しい thread、接続、待ち、状態、handle、取消点、再開の状態は無い。P の文は `preflight_project_reads` が既に持つ接続で、binding の COUNT と同じ位置（表の直後）で 1 回走る同期の文で、
`?` で失敗が呼び出し元に戻る（診断 slot 23 の `error_slot` に印が付く）。

| 項目 | 前後 |
|---|---|
| 入口・開始・再試行・再入・admission・取消・有限の待ち | 変えない（admission の閾値は同じ。数える行が tree で N_t 減り、P の分増える） |
| 有効な handle の所有 | 足さない |
| 終了の証拠 | 変えない |
| error／timeout／onClosed の所有 | 変えない。P の文の失敗は表の文の失敗と同じ経路（`?`）で戻る |
| 保存される再開の状態 | 無い |

P の文は tree と binding の COUNT を admit した後（rows が 2,048 以下であることを確かめた後）に走るので、走査する binding は高々 2,048 行。
DR-CQA-5 が波及先に挙げた steps の基準値には、動いたものが無い（絶対値で pin した試験は無く、steps を見る試験は「共有読みで増えない」という相対の断言で、全件が通る。ignore の試験は測定の記録だけ）。

### 変わる点

- **A-α 比で、principal が多い形は通る場面数が下がる（principal が全部 character の形で 652→約 491）。失敗の方向。**
  A-α は P を数えず tree を×2 にしていたので、P の多い形は実読より課金が少ないまま通っていた（DR-CQA-5 の既知の穴）。本 DR は実読と同じにするので、その形は厳しくなる。
  principal が全部 character の形は実読ベースで 2,048 に近づくのが本当で、A-α の 652 場面は課金が実読を下回っていた分の余裕だった。
- **foreign key を切って書かれた DB では、A-α の前（binding×2、tree×2）より厳しくなりうる**（最大 N_b−N_t 行）。課金の差は「新−A-α の前＝P−N_t−N_b」で、P≤2N_b なので N_b≤N_t の project では
  どの形も A-α の前より厳しくならない（dev の調べ：全形で成り立つ）。N_b＞N_t になるのは、孤立した binding（scene の node が無い）が残る DB だけで、通常の経路では残らない
  （schema は `scene_id REFERENCES tree_nodes(id) ON DELETE CASCADE`、書き込みと MCP の接続は `foreign_keys=ON`、tree node の削除は binding も消す。dev の調べ：コードを読んだ判定で、実行はしていない）。
  FK を切って書かれた DB と、project が食い違う binding の 2 つの異常の形だけが、この最大 N_b−N_t 行の対象。
- 通る場面数（1 Revision。実 worker 構成の in-process の二分探索。dev の仮実装の値と一致）：

  | 形 | A-α の前 | A-α（DR-CQA-6） | **新（A-β）** |
  |---|---:|---:|---:|
  | bare（短い id、reader、folder 1） | 489 | 652 | **978** |
  | folder＋note（10 場面ごとに folder、場面と同数の note。N_t≈2.1n） | 316 | 377 | **632** |
  | principal が全部 character（P≈2N_b。base の 4 場面は reader のまま） | 489 | 652 | **491** |

  folder・note の形は、N_t を実読と同じ×1 にした分で A-α の 377 から上がる（632）が、bare の 978 には届かない（tree の行が 1 場面あたり約 2.1 行あるため）。
  principal が全部 character の形は、実読ベースで課金されるので A-α の 652 から下がる（上の「A-α 比で…」）。半分の binding だけ character（P≈N_b）の形は、dev の仮実装の in-process で 654（A-α の 652 とほぼ同じ）。製品形では測っていない。
  principal の分布は、実データが無くて測れなかった（この機械の実 workspace に character の principal は 0 件。dev の調べ）。最悪の形（全部 character）を実測した。
- **2〜3 Revision などで、新しく行の壁を越えて通る形は、load によっては型付きの拒否ではなく 100 ms の時間切れになりうる**（どちらも部分 Graph を出さない unavailable）。
  本 DR は行の壁を動かすので、A-α では行の壁で拒否されていた形が通るようになり、その形は時間の壁（約 100 ms）に近づく。時間の対照は静かな時間帯の 1 回だけ（p4 の 352・337 場面）。
- 4 Revision（p4:300000）の 352／353 は動かない見込み（peak の台帳が先に当たり、bytes を変えないため）。実測は下記。
- 診断の slot の長さ（23→24）。

### 期待値の変更

| 場所 | 旧（A-α）→ 新 |
|---|---|
| `nir1_graph/input.rs` `DISCLOSURE_GLOBAL_ROWS_SQL` の tree の乗数 | 2 → 1 |
| `input.rs` `A3_SQL_QUERY_COUNT`、`nir1_graph_memory_diagnostics.rs` の `timings_ns` の長さと試験の期待値 | 23 → 24（slot 23 が P、slot 0 は空のまま） |
| `input.rs` `DISCLOSURE_GLOBAL_ROWS_SQL` の projects と query Scene の乗数 | 1 → 2 |
| `input.rs` の `disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope` | shared 7（tree 2、registry 2、bindings 1、project 1、query Scene 1）→ 8（tree 1、project 2、query Scene 2）、admission の rows 9 → 10 |
| `input.rs` の `disclosure_material_counts_preserve_duplicate_entity_and_pov_joins` | rows 15 → 16、行の上限の拒否を試す値 14 → 15 |
| `input.rs` の `disclosure_rejects_auxiliary_row_cardinality_before_materialization` | 足す note の数 1,024 → 2,048（tree が×1 なので、同じ拒否を起こすのに要る行の数） |
| `input.rs` の plan の試験 | 文の数 3＋10＋8＋8＋5 に P の文 1 を足す |
| `nir1_graph/tests/cq_avail.rs` `rows_charged_by_the_seed_query` | `2·tree + bindings + 2·registry + 1 + 1 + …` → `tree + bindings + principals + 2·registry + 2 + 2 + …` |
| 同 `a_query_loads_the_scene_bindings_in_one_statement` | audience_json 4→6、knowledge_holder_json 4→6、project_id 5→8（P の文が 2 つの principal 列と project_id を名指す） |
| 同 `BARE_FLOOR_SCENES` | 652 → 978（新たに folder＋note の 632、principal が全部 character の 491 の試験） |
| `nir1_graph/tests.rs` `Q512_SHARED_ROWS`（62 場面、N_t＝N_b＝62、principal は reader） | 201 → 141（−N_t、＋2。projects と query Scene の再読） |
| 同 `REGISTRY33_SHARED_ROWS`（2 場面） | 75 → 75（−N_t＝−2、＋2） |
| 同 Q512／registry33 の charged rows | 450 → 390、510 → 510 |
| 同 `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` の `unrelated_seed_edges` | 1,599 → 1,659（390＋1,659＝2,049） |

**「512」の扱い**：Q512／registry33 の `charged_rows`（512 から A-α で 450／510 になった値）は、これらの fixture が former limit の 512 に合わせて作られた名残で、
受入れの閾値としての意味は持たない（今の query の上限は 2,048 で、fixture は dataset hash に束縛されていて詰め直せない。コメントにも A-α から「そのまま」とある）。
台帳（`nir1-c-query-acceptance-2026-10.md` の RB-5 や PF-1 の「Q512（charged rows 512）」）は、100 ms の lease の下で実 worker が frame を返すことの確認に使う。
受入れの意味を持つのは **2,049 の拒否**（上限 2,048 ちょうどの 1 つ上）で、これは `unrelated_seed_edges` を詰め直して同じ値（2,049）に保った（A-α の 1,537→1,599 と同じ扱い。本 DR は 1,659）。
Q512／registry33 の fixture の行は下げた（390／510。registry33 は A-α と同じ 510 に戻った）が、同じ fixture が同じ frame を同じ 100 ms の内に返すことは lifecycle で確かめる。
台帳の「512 行の実 work が大きい形でも期限に収まる」（registry33、E=144）の「実 work」は、読む行（A2 288、A3 145、registry 66）で、本 DR では**変わらない**。変わったのは数え方だけ（512→510〔DR-CQA-6〕→510〔本 DR。tree の−2 と projects・query Scene の＋2 が相殺〕）。
fixture を詰め直して 512 に戻すと dataset hash が動く（fixture は hash に束縛されている）ので、A-α と同じく期待値を下げた。これは統合者が覆せる判断で、覆す場合は fixture を作り直して hash を取り直す。

### やらないこと

- bytes の乗数（binding の bytes×2、tree の bytes×2 など）の変更：別の決定。4 Revision の台帳の壁（352）が動く。
- D2（共有読みの別枠）、B（上限 2,048→4,096）、100 ms の壁、主人公級の行の壁、S の修正：本 DR の外。
- principal を課金しない緩和、join で落ちた行を数える案。
- Linux probe の「A3 SQL 到達」の bit（`timings_ns[0]`）は、slot 0 が空なので今も常に偽。既存の問題で、本 DR では直さない（slot 0 を空のままにしたのは、probe の出力の形を変えないため）。

### 試験

- **P の数え方（`scene_scope_principal_rows_tests.rs`、10 件。`"ref":7` と id `'7'` の character がある形で、両方の文が同じ 1 を返す試験を含む）**：上の「等価性」のとおり。各形で「課金の P ＝ extension の SELECT が返す kh／au の flag の合計＝期待値」を断言する。
- **課金の観測（`cq_avail.rs`）**：`the_tree_and_the_principals_codex_rows_are_charged_once_each`（admission の差：principal が character で＋2×20、folder・note で＋22）、
  `rows_charged_by_the_seed_query`（別の数え方の principal を足した期待値と、製品の課金の突き合わせ。`a_revision_costs_its_own_rows_and_none_of_the_shared_ones`、
  `query_records_at_2048_is_available`、`query_records_at_2049_refuses_the_whole_graph` ほか全件）、
  `a_query_loads_the_scene_bindings_in_one_statement`（authorizer の列挙。P の文の分だけ増える）。
- **床（`cq_avail.rs`）**：bare の `the_floor_of_a_bare_one_revision_project_is_n_available_and_n_plus_1_refused`（978／979）、
  `the_floor_with_folders_and_notes_is_n_available_and_n_plus_1_refused`（632／633）、`the_floor_with_character_principals_is_n_available_and_n_plus_1_refused`（491／492）。
  拒否の理由のコードは完全一致（`query-worker-work-candidate-record-limit-pre-cleanup-work-failed-candidate-record-limit`。shared の拒否〔`disclosure-record-limit`〕ではない）。
  character の形は fixture の P が 2×追加場面であることを断言する（P が 0 に落ちると別の床で通るため）。値は `measure_the_floor`（ignore の測定、`CQ_FLOOR_SHAPE`）の二分探索で取り直した（仮実装の値は写していない）。
- `input.rs`：admission の rows、診断の slot 23（観測・失敗・overflow）、plan（P の文を含む）、行の上限の拒否。

### 検証の結果（2026-11-12、独立レビューの指摘を直した commit の時点）

- `cargo test -p grimodex-db --lib` 全件：**2,668 passed、0 failed、58 ignored**。`cargo clippy -p grimodex-db --all-targets -- -D warnings`：通る。
- `cargo test -p grimodex-db --lib --features nir1-material-diagnostics -- nir1_graph::input nir1_graph_memory_diagnostics nir1_capacity principal_rows`：**69 passed、0 failed、1 ignored**
  （診断の slot 23 と 24 個の配列の試験 `observed_a3_keeps_admission_and_fixed_sql_slots`・`query_stage_observation_preserves_missing_timings_and_failure_flags`、plan の試験を含む）。
  feature 付きの `cargo clippy` は、本 PR が触っていない関数（dead code、引数の数）の 7 件で落ちる。基点では取り直していない。
- `scripts/nir1-c-query-worker-ci.sh lifecycle`：26 case の `test result: ok`（終了コード 0）。registry33 は shared 75、admitted 510 で通る。
- Q512（実 worker。lifecycle の外なので、同じ手順〔`nir1-material-capacity fixture`、worker の build、2 つの ignored test〕を手で実行）：
  `native_worker_returns_canonical_512_a3_eligible_seed_local_graph` は shared 141、admitted 390 で通る。
  `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` は candidate_rows 1,661（2＋1,659）、shared 141 で `disclosure-record-limit` を返す。
  既定の lane 全体（`nir1-c-query-worker-ci.sh` の引数なし）と practical-retention は実行していない。
- `fnm exec --using=22 pnpm -s verify:quality`：通る（終了コード 0。最終の commit で取り直した）。
- 床の 978／632／491 は in-process（worker の構成〔`worker_reader`、`query_for_worker_with_maintenance_deadline`〕を同じ process で動かした値。admission の文と式は worker と同じコード）。bare の 978／979 は実 worker でも取り直した（次の節）。
- **P の文の SQL の VM 命令数**（in-process、floor の形。`measure_the_principal_rows_statement_steps`〔ignore〕。progress handler を 1 命令ごとに呼んだ回数）：
  bare の 978 場面で 36,224 命令（P＝0）、全部 character の 491 場面で 23,075 命令（P＝974）。binding の COUNT は 2,948／1,487 命令。P の文は binding 1 行あたり約 37〜47 命令（2 つの JSON の検査と 2 回の主キーの seek）で、
  `QUERY_SQL_STEPS`（600,000）の約 6%（bare の 978 場面）。1 query で足す分はこの 1 文だけ。

### 実 worker の測定（2026-11-12、dev の実 worker、PR の前）

dev 枝 `claude/dev-cquery-charge-actual-measure`（`ff2d4f81`＝本 DR の最初の commit〔rebase 前の `3e3d2c75`〕＋測定 harness `274a56da` の cherry-pick。製品コードは変えず、push・PR なし）。
**この節の測定は、projects と query Scene を×1 の課金にした最初の commit のもの**（bare の床が 979）。その後、独立レビューの指摘で両方を×2 にした（bare の床は 978）ので、bare の床だけ実 worker で取り直した（下の「取り直し」）。ほかの値（folder＋note・character の床、p4 の 352／353、時間の対照、P の文の単独の時間）は、行の課金が +2 だけ違い、読む行・bytes・時間は同じなので取り直していない。記録：
`fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/cquery-charge-actual-2026-11-12/results.md`（raw、集計、binary の sha256、build log）。

- **床（1 Revision。N は available、N＋1 は型付きの拒否 `candidate-record-limit`。worker は abort せず frame まで進んだ。各 3 回同一）**：bare **979／980**、folder＋note **633／634**、character（P＝2×追加場面）**491／492**。in-process の二分探索の値と一致。
- **query の Q 高水位**：bare 979 は 4,199,070 B（25.03%。A-α の 652 は 3,814,832 B）、folder＋note の 633 と character の 491 は 3,814,832 B（22.74%）。worker 内 query_ms は 49〜50、39〜41、36〜37 ms。
- **4 Revision（p4:300000）の 352／353 は動かない**：352 は available、353 は `other`（retained）。bytes を変えていないため。
- **時間の対照（p4 の 352・337 場面、A-β 対 A-α〔基点 `383b8568`＝A-α＋harness〕、各腕 8 本、AB／BA の交互、開始時の loadavg 1.34、run の 1 分値は 1.2〜1.3）**：
  時間切れは A-β 0／16、A-α 0／16。worker 内 query_ms の中央値／最大は 352 場面で 79.5／80 対 85／86 ms、337 場面で 79.5／81 対 85／86 ms。owner の往復は 107〜108 対 108〜112 ms。
  harness（worker bin、allocator、`nir1_graph.rs` の trace）は両腕で同一（`git diff 383b8568 ff2d4f81` で確認）で、差は A-β の変更だけ。A-β の worker 内の時間は最大 81 ms で、期限 100 ms との差は約 19 ms 残った。
  A-β の方が約 5 ms 短かったが、追加の文が速くなる理由は無いので、binary 間のばらつきの範囲と読み、追加の文のコストは A／B の対照からは分離できていない（DR-CQA-6 の対照にも説明できない数 ms の差がある）。
  追加の文だけの時間は下の「P の文の単独の時間」で別に測った。
  DR-CQA-6 の対照（loadavg 2.3〜4.2）では両腕とも 6／16 が時間切れだった。時間の余裕が無い形は load しだいで 100 ms に当たる点は A-α と同じで、本 DR は変えていない。
- **取り直し（bare の床。dev 枝 `claude/dev-cquery-charge-actual-measure2`＝製品の commit `d601bad3`＋`274a56da` の cherry-pick〔`9904bad5`〕）**：bare は **978 が available（Q 高水位 4,198,623 B、worker 内 49〜50 ms）、979 が型付きの拒否 `candidate-record-limit`**（各 3 回同一。worker は abort せず frame まで進んだ）。in-process の二分探索の値（978）と一致。
- **P の文の単独の時間**（release、4 Revision の 352 場面の project、200 回の中央値。dev 枝の `cq_principal_rows_statement_cost`、`p-statement.jsonl`）：
  principal が reader だけなら 0.15 ms、全部 character（P＝690）なら 0.44 ms（binding の COUNT は 0.016 ms）。期限の余裕（約 19 ms）に対して小さい。
- 限界：3 形の床だけ（半分だけ character・UUID・長い title は in-process の dev の測定のみ）。時間の対照は静かな時間帯の 1 回。principal の分布は実データが無く測れていない。

## DR-CQA-8 の詳細（2026-11-12）

基点は origin/master の `a067f7f7`（DR-CQA-7＝#871 を merge した後）、枝は `claude/cquery-bytes-actual`。設計の正本は
`fusion-eval-data/design-notes/db-connection-2026-11-07/cquery-scene-wall-2026-11-11.md` の §3.2〜3.4（4 Revision の台帳の壁、bytes の壁、Q と時間）、§4、§5.2「A-β」の bytes（:316）。
**値（上限・閾値・契約・authority・admission の閾値・schema）と rows の課金は変えない。変えるのは `preflight_project_reads` が共有読みに課す bytes の数え方だけ。**

### 承認と範囲

2026-11-11 にユーザーが選んだ文面（逐語）：「二重の読みを省き、読む行と数える行を同じだけ減らします（約 652 場面、委任内の見込み）。その上で、数える行を実際に読む行に合わせます（約 978 場面）。後者は、数え方の緩和に当たります。上限 2,048 の値は変えません。」
DR-CQA-7 はこのうち行（rows）だけを入れ、bytes は「4 Revision の台帳の壁（352）が動き、p4 の時間の余裕が無い形に当たる」ので別の決定に残した。2026-11-12 にユーザーは、残る壁（bytes の課金、主人公級、100 ms）を「全て並列に実装して下さい」と指示した。
本 DR はその bytes の課金。数え方の緩和に当たる（読まない列と二重の読みを数えるのをやめる）が、「実際に読む bytes」を下回らないことを試験で固定する。

### 「実際に読む bytes」の定義（先に決める）

- **数える**：query の経路の読みの文が**結果として返す、または SELECT 句で値として評価する列**の値の長さ（`octet_length`。整数の列は文字列表記の長さ）を、その文が**実際に実行される回数**だけ。
- **数えない**：WHERE／ON の述語だけで使う列（tree の `project_id`・`node_type`、binding の `project_id`、POV の Codex の `project_id`・`context_mode`、principal の Codex の `project_id`・`type`）。既存の全ての文がこの定義で、述語の列は数えていない
  （tree の全行の `project_id` 36 B を足すと承認の範囲を超えて厳しくなる）。この除外は DR に明記し、試験の authorizer の列挙（「課金に無い列＝述語だけ」）で機械的に示す。
- 読む回数は `Nir1ProjectReads::load` を 1 回の query に 1 回だけ走る（`project_level_reads_are_made_once_and_charged_as_made`）。文ごとに実行回数を数える。

### 列ごとの照合（コードで確かめた実際の読み）

| 読み（文の位置） | 返す・評価する列 | 旧の課金 | 新の課金 |
|---|---|---|---|
| authority の tree（`project_scope_authority.rs` の SELECT） | `id`、`parent_id`、`node_type`、`sort_order`、`story_time_order`、`archived_at`。`version`・`updated_at` は読まない | 8 列（`version`・`updated_at` を足していた）×2 | 6 列 ×1 |
| registry（`read_registry_in_tx`＋`read_registry_row` の 2 文） | 1 文目：`registry_version`、JSON 3 つ、`version`、`source_token`。2 文目：`version`、`source_token`、`updated_at` | 6 列（`version` なし。`source_token` は文の中で×2）の和を `SHARED_REGISTRY_READS`（2）で×2 | `registry_version`＋JSON 3＋`updated_at` を ×1、`version` と `source_token` を ×2（乗数は 1） |
| binding（`SCOPE_EXTENSION_SQL`） | `scene_id`、`scene_incarnation_id`、`compatibility_marker`、JSON 3 つ（`query_identity`・`material_constraint`・`knowledge_holder`）、`audience_json`、`version`、`source_token`、`updated_at`。principal の join は `kh.id`／`au.id` の flag を評価する | 9 列（`version` なし）×2、join の Codex 列は 0 | 10 列 ×1＋join が成り立った `kh.id`／`au.id` |
| projects（`read_retrieval_scene_source` の join） | `phase_resolution_mode`。authority の `SELECT 1 FROM projects` は列を返さない | 1 列 ×1 | 同じ |
| query Scene（`read_retrieval_scene_source` と `read_scene_viewpoint`） | scene source：`version`、`updated_at`、`content`、`archived_at`。viewpoint：`pov_character_id`（別の列なので再読の bytes は無い） | `version` なしの 4 列 ×1 | `version` を足した 5 列 ×1 |
| POV の Codex（`read_scene_viewpoint`） | `type` | 1 列 ×1 | 同じ |
| 最新 Epoch（`get_current_epoch`） | `id`、`epoch_number`、`reason`、`created_at` | `epoch_number` なし | `epoch_number` を足す |

rows の課金で DR-CQA-7 が見つけた「projects と query Scene の再読」（projects を 2 回、query Scene を別々の列で 2 回）は、bytes では**列が別**（projects：authority は列を返さない。query Scene：scene source と viewpoint は別の列）なので、同じ列の再読は無い。コードで確かめた。

### 決定

1. `DISCLOSURE_GLOBAL_BYTES_SQL` の共有読みの 7 文を上の「新の課金」の形にする。表は 8 行のまま（decision の PerRevision の文は変えない）。診断の slot 10〜17 は動かさない。
2. 乗数は全文 1。registry の「2 文分」は文の中に書く（乗数 0＝`SHARED_REGISTRY_READS` の読み替えは bytes の表では使わない）。
3. binding の bytes の文は `scene_scope.rs` の `SCOPE_EXTENSION_BINDING_BYTES_SQL` とし、P の文（`SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL`）と同じ `scope_extension_principal_joins!()` の 1 つの文字列から作る。extension の SELECT・P の文・この文は別の join を持てない。
4. 変えないもの：rows の課金、decision の bytes の文、`INPUT_BYTES`（2 MiB）、`MAX_GRAPH_INPUT_BYTES`（6,291,456）、`SHARED_REGISTRY_READS`（rows の表が使う）、Q・100 ms・600M steps ほかの閾値。

### 信頼境界

呼び出し元と入力は変わらない（同じ接続、同じ thread、同じ snapshot の中の読みだけ）。binding の bytes の文は `project_id` 1 つを bind し、binding と codex を読んで整数 1 つを返す（本文・principal の値は出さない）。
新しい送信先、保存範囲、契約、authority、schema、依存は無い。課金の変化の扱い：読まない列と二重の数えを外すのは数え方の緩和（2026-11-11 の承認の範囲）。読む列（`version`、`epoch_number`、principal の `id`）を足すのは厳しくする側。

### owner／lifecycle の表（GDX-PRECHECK-001）

新しい thread、接続、待ち、状態、handle、取消点、再開の状態は無い。文の数は変わらず、同じ接続・同じ位置で `?` により失敗が戻る。

| 項目 | 前後 |
|---|---|
| 入口・開始・再試行・再入・admission・取消・有限の待ち | 変えない（admission の閾値は同じ。数える bytes が実読に合う） |
| 有効な handle の所有 | 足さない |
| 終了の証拠 | 変えない |
| error／timeout／onClosed の所有 | 変えない。新しい失敗の経路は足さない |
| 保存される再開の状態 | 無い |

### 変わる点

- **1 場面あたりの共有読みの bytes（`preflight_project_reads` の課金。in-process の実 fixture の傾き、N=200 と 400 の差）**：

  | 形（1 Revision） | 旧 | 新 | 比 |
  |---|---:|---:|---:|
  | bare（短い id、reader、folder 1） | 約 1,010 B | 約 486 B | 0.48 |
  | UUID の id（場面・folder・note） | 約 1,134 B | 約 548 B | 0.48 |
  | folder＋note＋character の principal＋UUID | 約 1,476 B | 約 703 B | 0.48 |

  （固定分は約 1.05 KB から約 0.56 KB。4 Revision でも同じ傾き〔bare 約 489 B、UUID 約 549 B〕。値は `measure_the_shared_bytes`〔ignore〕で取り直せる）
  半分より少し上なのは、読む列を足した分（binding の `version`・principal の Codex の `id`、query Scene の `version`、Epoch の `epoch_number`）と、registry の `version` を足した分。
- **4 Revision（p4:300000）の peak の台帳の壁は 352 から 733 場面に動く**（in-process の二分探索。N は available、N＋1 は `query-worker-work-other-pre-cleanup-work-failed-other`＝台帳の拒否で、旧と同じ理由。
  台帳 6,291,456 B のうち A2 の入力 約 949 KB×4 などの固定分が約 5.94 MB、残る約 0.356 MB を共有読みの bytes が使う：旧 1,010 B/場面で 352、新 486 B/場面で 733。式の予測〔約 700〕と合う）。
  実 worker（lease を 10 s に上げた dev の binary。下の節）でも 733 は available、734 は同じ理由の拒否。
  上の 733 は短い id（場面 `x00000` など）の値。**製品の id は UUID なので、UUID の id（場面・folder・note）の p4 も取り直した：旧の数え方 314／315、新 651／652**（in-process の二分探索。N＋1 は同じ `other`。1 場面あたり約 548 B）。
- **1 Revision の行の壁（bare 978、folder＋note 632、character 491）は動かない**（行は変えていない。bytes の壁が後ろに退いただけ）。既存の床の試験が全件そのまま通る。
- **bytes の壁（1 Revision で共有読みの bytes が 2 MiB に届く場面数。上の傾きと切片からの線形外挿）は後ろへ動く**：bare 約 2,076→約 4,314、UUID 約 1,848→約 3,826、folder＋note＋character＋UUID 約 1,421→約 2,983。
  どの形でも行の壁（978／632／491）より後ろなので、今は行が先に当たる。bytes の壁は、行が少なく bytes が大きい形（長い JSON、大きい query Scene の content）で型付きの止めとして残る：
  - 単体（`the_shared_bytes_are_refused_one_byte_over_the_preflight`）：query Scene の content で共有読みの bytes が `INPUT_BYTES`（2 MiB）ちょうどで通り、＋1 で `NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT`。
  - query 全体（`shared_bytes_over_the_preflight_refuse_the_whole_graph`）：共有読みの bytes 1 MiB で available、2 MiB＋1 で部分 Graph なしの unavailable。worker の frame の理由は `query-worker-work-other-pre-cleanup-work-failed-other`
    （台帳の拒否と同じ `other`。bytes の拒否にも台帳の拒否にも固有の理由は無く、これまでと変わらない。設計 §3.3 の「型付き」はエラー文字列の意味で、frame の理由が個別に付くという意味ではない）。
- **失敗の方向（時間）**：p4 で新しく通る 353〜733 場面は、これまで台帳の拒否（typed ではない `other`）で止まっていたが、**100 ms の期限に近い形**（p4 の 352 場面で worker 内 約 80〜85 ms〔DR-CQA-7〕）に新しく入る。
  通る場面数が増える分、load によっては台帳の拒否（`other`）が 100 ms の時間切れ（`NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`。どちらも部分 Graph を出さない unavailable）に置き換わりうる。
  実際、実 worker（100 ms の lease のまま。loadavg 約 25 の時間帯）の p4 の 733・734 場面は両方とも時間切れだった（**時間は測っていない。load が高く、値として読まない**）。時間の対照は timing_plan に手順を書いた（`needs_timing`）。
  steps の面では余裕がある（下の「steps」）。
- **Revision ごとの 2 MiB の preflight（`INPUT_BYTES − shared_bytes`）が、同じだけ広がる**（共有読みが使う分が約半分になる）。1 Revision の own の bytes（A2 の payload 以外、decision など）が使える量が増える。
- **worker でない経路（ordinary reader）**：`admit_transient_material_reserve` の見積り（`raw_bytes × TRANSIENT_JSON_MULTIPLIER ＋ rows × TRANSIENT_BYTES_PER_ROW`）の raw_bytes に共有読みの bytes が入るので、その見積りも約半分になる。
  worker の経路は固定の arena が代わりをする（この見積りは使わない）。設計 §5.2 の C4（台帳が共有読みの実際の保持を数えず、raw の入力 bytes×2 で代用している会計の穴）は、代用の量が約半分になった分だけ広がる（実際の保持は約 1.5〜2 KB/場面、課金は約 0.49 KB/場面）。
  worker の経路は physical な Q（下の実 worker の Q）で守られる。C4 の穴は変えず、記録を更新するだけ（台帳に足した項）。
- **steps**（in-process、`measure_the_shared_preflight_steps`〔ignore〕。progress handler を 1 命令ごとに呼んだ回数）：binding の bytes の文が principal の Codex 行を主キーで引く join を持つので、共有 preflight は増える。

  | 形 | 共有 preflight 旧 | 新 | query 全体（新。steps の上限を外して測定） | `QUERY_SQL_STEPS` 600,000 に対する比 |
  |---|---:|---:|---:|---:|
  | 1 Revision bare 978 場面 | 116,965 | 152,203（＋35,238） | 235,424 | 39% |
  | p4 の 733 場面 | 87,810 | 114,228（＋26,418） | 219,578 | 37% |
  | 1 Revision character 491 場面 | 63,882 | 85,484 | 140,456 | 23% |

  binding 1 行あたり約 36 命令（2 つの JSON の検査と 2 回の主キーの seek。DR-CQA-7 の P の文と同じ join）。steps の上限には余裕がある。
- **診断の slot・A3 の SQL の文の数**：変わらない（表は 8 行のまま。slot 10〜17）。

### 期待値の変更

| 場所 | 旧 → 新 |
|---|---|
| `nir1_graph/input.rs` `DISCLOSURE_GLOBAL_BYTES_SQL` の tree の文 | 8 列×2 → 6 列×1（`version`・`updated_at` を外し、乗数 2→1） |
| 同 registry の文 | 乗数 0（`SHARED_REGISTRY_READS`＝2 で全体×2。`source_token` は実質×4、`version` なし）→ 乗数 1、`version`×2・`source_token`×2・その他×1 を文の中に書く |
| 同 binding の文 | `scene_id` ほか 9 列×2 → `scene_id` ほか 10 列（`version` を足す）×1＋`kh.id`・`au.id`（`SCOPE_EXTENSION_BINDING_BYTES_SQL`。`scene_scope.rs`） |
| 同 query Scene の文 | `version` を足す |
| 同 Epoch の文 | `epoch_number` を足す |
| `input.rs` `disclosure_tests` の fixture の schema | `narrative_scope_registries` と `narrative_scene_scope_bindings` に `version INTEGER` を足す（実 schema にある列。文が読むので要る） |
| `nir1_graph/tests/cq_avail.rs` `a_query_loads_the_scene_bindings_in_one_statement`（authorizer の列挙） | `audience_json` 6→8、`knowledge_holder_json` 6→8、`project_id` 8→10（bytes の文が extension と同じ join を持つ）、`version` 1→2（bytes の文と extension の各 1。2 が「load は 1 回」の印。2 回 load すれば 3） |
| 同 p4 の床 | 新しい試験。352（旧の数え方）／353、733／734（新）|
| 1 Revision の床（`BARE_FLOOR_SCENES`＝978、632、491）・`Q512_SHARED_ROWS` ほか rows の値 | 変更なし |

台帳（`nir1-c-query-acceptance-2026-10.md`）の bytes の乗数の記述（「tree×2、registry×2、binding×2」の bytes 側）と、上限の値は変わらないという注記を更新した。

### やらないこと

- 述語だけで読む列（`project_id`、`node_type` など、tree の全行の 36 B 等）を数える：既存の全ての文の定義と合わない。承認の範囲を超えて厳しくなる。
- worker の frame の理由に bytes の拒否・台帳の拒否の個別の理由を付ける（契約の変更）。
- C4（共有読みの実際の保持を台帳に足す）、D2、B（上限 2,048 の値）、100 ms の壁、主人公級の行の壁、S の修正、Q の枯渇：本 DR の外。
- 時間の測定（他の lane が並行で cargo を回している間は値が崩れる）：手順だけを timing_plan に書いた。

### 試験

- **bytes の課金＝返す値の長さ（`input.rs` の `disclosure_tests`。列ごとに長さを変えた fixture）**：
  - `shared_bytes_are_the_columns_each_read_returns_once_each`：tree（読まない `version`・`updated_at`・別 project の node を数えない）、registry（`version`・`source_token`×2）、binding（`version`、join が成り立つ principal の `id` だけ。location を指す ref は数えない）、projects、query Scene、POV、最新の Epoch（古い Epoch を数えない）の合計を、長さの違う literal で足した値と等しい。
  - `shared_bytes_follow_exactly_the_columns_that_are_read`：読む列を 10 B 伸ばすと課金がちょうど 10 B（`source_token`・registry の `version` は 2 回読むので 2 倍）増え、読まない列（folder の `updated_at`・`version`・`content`、古い Epoch の `reason`）は不変。principal の ref が character の entry を指すと `id` の長さだけ増える。
  - `the_shared_byte_statements_run_once_each`：bytes の表の乗数が全て 1。
  - `the_shared_bytes_are_refused_one_byte_over_the_preflight`：2 MiB ちょうどと＋1。
  - 既存の plan の試験（`a2_a3_plans_seek_the_seed_revision_without_table_scans_or_temp_sorts`）が新しい文を含めて通る（`TEMP B-TREE`・`AUTOMATIC` なし）。
- **principal（`scene_scope_principal_rows_tests.rs`）**：bytes の文と extension が同じ join の文字列（macro）を持つ。extension の SELECT が返す 10 列の長さと、flag が 1 の join の `id`（＝ ref）の長さを Rust で足した値が、reader だけ・holder だけ・audience だけ・同じ character を両方・別の character・別 project や location を指す ref・数値の ref・不正な JSON・配列の各形で bytes の文と一致する。
  character の principal は reader より `id` の長さと JSON の差だけ増える。plan は binding を project の index で、Codex を主キー（`sqlite_autoindex_codex_entries (id=?)`）で seek する。
- **実 DB の oracle（`cq_avail.rs` の `shared_bytes_equal_what_the_reads_return_on_a_product_project`）**：folder・note・UUID の id・character の principal・POV・長い content の project で、課金が、statement ごとの返す値の長さを Rust で足した値（registry の 2 文、principal の Codex 行を binding 自身の JSON で決める、など）と等しい。
  `Nir1ProjectReads::load` 1 回が SQLite に認可を求める（表, 列）の全てと回数を pin し、課金に無い列が述語だけであること（`project_id`、lookup の `id`・`node_type`、join の `type`、`context_mode`）と、binding の `version` を読む statement が 1 回（load 1 回）であることを示す。
  旧の数え方（`with_legacy_shared_bytes`）より新しい課金が小さいことも断言する。
- **床の N／N＋1（`cq_avail.rs`。理由のコードは完全一致）**：1 Revision の bare・folder＋note・character（978／632／491、`candidate-record-limit`。変更なし）、
  4 Revision の新 733／734（`other`）と旧の数え方 352／353（`with_legacy_shared_bytes`。旧の数え方でも 352 になることが、動いたのは数え方だけだという根拠）。
- **bytes の壁（query 全体）**：`shared_bytes_over_the_preflight_refuse_the_whole_graph`（1 MiB で available、2 MiB＋1 で部分 Graph なしの unavailable、理由は `other`）。
- 測定用の ignore の試験：`measure_the_shared_bytes`（形ごとの bytes と 1 場面あたり）、`measure_the_floor`（`CQ_FLOOR_REVISIONS`、`CQ_FLOOR_SHAPE` に `uuid`、`CQ_FLOOR_LEGACY=1`）、`measure_the_shared_preflight_steps`（共有 preflight と query 全体の steps）。

### 実 worker の測定（2026-11-12、dev の実 worker、PR の前。**lease を 10 s に上げた dev の binary の値**）

dev 枝 `claude/dev-cquery-bytes-measure`（worktree `/home/grimodex/worktrees/Grimodex/claude-dev-cquery-bytes-measure`。push・PR なし）。製品の commit `25709a3e`（本 DR の最初の commit。後の commit は試験と文書と空行だけで、製品の文・式は同じ）
＋測定 harness `274a56da` の cherry-pick（`398888c3`。`cq_avail.rs` の衝突は `extra_scenes + DEV_EXTRA_SCENES.load(...)` の形で解いた）。
`QUERY_DEADLINE`（100 ms）を 10 s に上げる 1 commit（`edfb312c`）を載せた binary で測った。**これは N／N＋1 と Q を load に左右されず取るための dev 専用の変更で、製品の lease は 100 ms のまま**（`a90dec3d` で 100 ms に戻した。腕 A の定義）。
binary（release、sha256）：testbin `19d18dcfaf02be5feaf9c704b5196a3258ed133fb3223307262769e699054d6e`、worker `549a3a19b9042fb9c8196be933c78962619dacf007330319af46b2b1b6de212a`（`/tmp/claude-1000/bytes-actual-lift/`）。
raw：`/tmp/claude-1000/cquery-bytes-actual-results/`（`l-lift.jsonl`、`llog-lift.txt`、`runl.sh`、`binaries-lift.sha256`）。手順は `cq_avail::cquery_scenes_boundary`（実 worker で prepare→READY→query 1 本。場面数＝p は 4＋S、p4 は 7＋S）。**時間は測っていない**（harness の `query_ms` は load の高い時間帯の値で、読まない）。

| 形 | 場面数 | 結果 | Q の高水位（`q_hw_since_ready`、`allocated_bytes`） | Q（16 MiB）に対する比 |
|---|---:|---|---:|---:|
| p4:300000 | 352 | available | 5,262,849 B | 31.4% |
| p4:300000 | **733** | **available** | **5,746,244 B** | **34.3%** |
| p4:300000 | 734 | `other`（台帳。`query-worker-work-other-pre-cleanup-work-failed-other`）。worker は abort せず frame（89 B）まで進んだ | 5,746,691 B | 34.3% |
| p:300000（1 Revision） | 978 | available | 4,198,623 B | 25.0% |
| p:300000（1 Revision） | 979 | `candidate-record-limit`（変更なし） | 4,199,070 B | 25.0% |

- p4 の Q は 352→733 場面で約 483 KB（381 場面で 1 場面あたり約 1.27 KB）増える。Q の 85% の線（C 基準 14.26 MB。A→C は約 1.31 倍）に対して、733 場面は A 5.75 MB（C 換算 約 7.5 MB＝約 45%）で、余裕がある。**Q は 733 場面で blocking にならない**。
- 1 Revision の 978／979 と Q は DR-CQA-7 の値と同じ（bytes を変えても行の壁と Q は動かない）。
- **100 ms の lease のまま（`/tmp/claude-1000/bytes-actual/{testbin,worker}`、sha256 `8ad682f0…`／`4003ee87…`、loadavg 約 25 の時間帯、各 1 回）**：p の 978 は available、979 は `candidate-record-limit`（変更なし）。
  **p4 の 733・734 は両方 `NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`（時間切れ）**。load が高く 1 回なので時間の値としては読まず、「353〜733 場面が製品の lease で通るか」は未確認とする（timing_plan）。

### 時間の対照の手順（未実施。`needs_timing`）

他の lane が並行で cargo を回している間（loadavg 15〜27）は時間の値が崩れるので、この段では測っていない。静かな時間帯に次を行う。

- 腕 A＝本 PR の製品コード（`25709a3e`）＋harness ＋ 100 ms の lease：dev 枝 `claude/dev-cquery-bytes-measure` の `a90dec3d`（`QUERY_DEADLINE` は 100 ms。`edfb312c` を打ち消した後の先端）。
  腕 B＝master `a067f7f7`＋同じ harness（`274a56da` の cherry-pick。衝突は同じ形で解く）：dev 枝 `claude/dev-cquery-bytes-measure-base` の `443027e6`（worktree `/home/grimodex/worktrees/Grimodex/claude-dev-cquery-bytes-measure-base`。構文だけ確かめ、build は未確認。master の素の build は `/tmp/claude-1000/bytes-lifecycle/B/` にある）。
- 腕ごとに `cargo test --release -p grimodex-db --lib --no-run` と `cargo build --release -p grimodex-db --bin nir1-c-query-worker` を別の worktree の target で作り（`.fingerprint` の `grimodex-*` を消してから）、`/tmp/claude-1000/bytes-ctrl/{A,B}/{testbin,worker}` に置いて sha256 を記録する。
- case（`cquery_scenes_boundary`、`CQ_REPS=1`）と本数：各 case、各腕 8 本、AB／BA の交互、各 run の開始時に loadavg（1 分値）が 3 未満になるまで待ち、run ごとの loadavg を記録する（`drift-measure/cquery-binding-join-2026-11-11/ctrl3.sh` の形）。
  - `p4:300000+S345`（352 場面）と `p4:300000+S330`（337 場面）：A・B とも available になる形。worker 内 `query_ms`（`QUERY_DONE` の trace）と owner の往復、時間切れの本数を A 対 B で比べる（binding の bytes の文に join が入った分の差）。
  - `p:300000+S974`（1 Revision の 978 場面）：A・B 各 8 本。join は全 query に効く（共有 preflight は約 3.5 万命令の増加）ので、1 Revision の形でも対照を取る。
  - A だけ：`p4:300000+S393`、`+S493`、`+S593`、`+S726`（400／500／600／733 場面。B は 353 以上で台帳の拒否になる）。各 8 本。時間切れ（`NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`）と available の本数を数え、通る場面数が 100 ms で頭打ちになる位置を決める。
- 判断：A の 352／337／978 の時間が B より悪化しない（ばらつきの範囲）こと、A の p4 で時間切れが出始める場面数。時間切れが 353〜733 の早い所から出るなら、p4 の実効の壁は台帳の 733 ではなく 100 ms で決まり、台帳の拒否（`other`）が時間切れ（これも部分 Graph なしの unavailable）に置き換わるだけで、通る形が増える効果は時間の壁までに限られる。

### 検証の結果（2026-11-12、最終の tree の製品コード〔`25709a3e` の文・式〕）

- `cargo test -p grimodex-db --lib` 全件：**2,679 passed、0 failed、60 ignored**（ignore は測定用。DR-CQA-7 の 58 から、新しい ignore の測定 2 件〔`measure_the_shared_bytes`、`measure_the_shared_preflight_steps`〕を足した 60）。
- `cargo clippy -p grimodex-db --all-targets -- -D warnings`：通る（最終の tree で取り直した）。
- `cargo test -p grimodex-db --lib --features nir1-material-diagnostics -- nir1_graph::input nir1_graph_memory_diagnostics nir1_capacity principal_rows`：通る（診断の slot の試験、観測付きの preflight の試験を含む）。結果は `feat2.log`（下の raw の置き場）。
- `scripts/nir1-c-query-worker-ci.sh lifecycle`：
  - **標準の script は、load の高い時間帯（loadavg 約 22）に 2 回とも 15 番目の case `native_worker_uses_a_payload_shaped_revision_near_the_preflight_limit` で `NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`（100 ms の lease の時間切れ）で止まった**（その前の 14 case は通過）。
    原因の切り分け：同じ試験を、本変更の binary（A）と master `a067f7f7` の binary（B）で交互に 6 本ずつ、loadavg 約 16 で実行した。**A は 2／6 通過、B（変更なし）は 1／6 通過**で、どちらも同じ時間切れ。この case は load で不安定で、本変更が原因ではない（log：`lifecycle-ab-payload-shaped.txt`）。
  - そのため、この 1 case だけ最大 20 回の再試行を付けた script の写し（scripts の下に一時的に置き、commit せず削除した）で全 case を流し直した：**26 case とも `test result: ok. 1 passed`（終了コード 0）。再試行は 1 回も使わなかった**（開始時 loadavg 約 15.6）。script の写し以外は標準と同じ。標準の script がこの環境の load で通らない点は、静かな時間帯に標準の script で取り直す必要がある（未実施）。
  - 使った binary は本変更の build（sha256：testbin `b94445b9111f1ffa30807e476b0771115cd6afeb0bdd2379e12d8e90cbf41154`、worker `c8bac9571a11785d068535cda0df72182c573dee6b932cc3bffc512867dfe4e8`。lift 版〔`19d18dcf…`／`549a3a19…`〕とは別。`.fingerprint` の `grimodex-*` を消してから build した）。
- `fnm exec --using=22 pnpm -s verify:quality`：通る（終了コード 0）。1 回目は無関係の `browser-mock.persistence-contract.test.ts` が vitest の 5 s の timeout で落ち（load が高い時間帯）、空いてから取り直した 2 回目が通った。
- 未実行：標準の lifecycle の通し（上のとおり）、lane の既定の全体と `practical-retention`、hosted CI（Quick／Full）、実 worker の時間の対照（timing_plan）、実 worker で 100 ms の lease のまま p4 の 733 場面が通るかの確認。
- 測定の raw と binary（push しない dev のもの）：`/tmp/claude-1000/cquery-bytes-actual-results/`（床・shared bytes・steps の in-process の出力、実 worker の jsonl、lifecycle の log、sha256）、`/tmp/claude-1000/bytes-actual/`（100 ms の binary）、`/tmp/claude-1000/bytes-actual-lift/`（lease を上げた binary）、`/tmp/claude-1000/bytes-lifecycle/{A,B}/`（lifecycle の A／B の binary）。

### 時間の対照（2026-11-12、dev の実 worker・release・100 ms の lease・静かな時間帯。上の手順を実施した結果）

腕 A＝`a90dec3d`（本 PR の製品コード＋harness）、腕 B＝`443027e6`（master `a067f7f7`＋同じ harness）、AB／BA 交互、各 case 各腕 8 本、各 run の開始時 loadavg 1 分値は 1.22〜2.36（3 未満。run ごとの値は raw の load.txt）。binary の sha256 は A testbin `8ad682f0…`・A worker `4003ee87…`（前回の 100 ms 版と一致）、B testbin `f1e64c97…`・B worker `53cf7cbd…`。記録：`/home/grimodex/fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/timing-bytes-2026-11-12/`（results.md、raw、load.txt）。

- **A 対 B（352・337・978 場面）：全 24 本 available、時間切れ 0 本。** worker 内 query_ms の中央値（最大）は p4 352 場面で A 80（87）／B 79.5（81）、p4 337 場面で A 80（80）／B 78（83）、p 978 場面で A 50（51）／B 50（52）。owner の往復の中央値は A 105／104.5／59 ms、B 107／106／58.5 ms。差は中央値で 2 ms 以内で向きも揃わず、**join の追加でばらつきの範囲を超える悪化は無い**。
- **A だけ（p4）：400／500／600／650／673／700／716 場面は各 8/8 available**（worker 81／85／88／89／90.5／91／92 ms の中央値）。**726 場面と 733 場面は 8 本中 5 本が時間切れ（`NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME`）、3 本が available**（worker 内は 92〜94 ms で、通る本と時間切れの本で差が無い）。
- したがって **p4 の実効の壁は台帳の 733 ではなく 100 ms の期限で、716〜726 場面の間**にある。台帳の拒否（`other`）が時間切れ（どちらも部分 Graph なしの unavailable）に置き換わり、通る形が増える効果は 352 → 約 716 場面まで。本番の lease（100 ms）で 733 場面は通らない（5/8）。1 場面刻みの境と、時間切れが worker 内の時間で説明できない理由（owner 側の寄与か。推測）は未測定。
- 標準の `scripts/nir1-c-query-worker-ci.sh lifecycle` を静かな時間帯（開始時 loadavg 1.43）に標準のまま取り直した：exit 0、26 case 全部成功（前回の 15 番目の case の不安定は再現せず）。
