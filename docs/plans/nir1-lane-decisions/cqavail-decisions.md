# CQ-AVAIL の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQA-1 | 2026-10-14 | CQ-AVAIL | Graph の node の同一性から Scope を外し、Scope は binding（Revision）ごとに持つ。本当の版の矛盾だけを ENDPOINT_VERSION_CONFLICT に残す。worker の frame の版を上げて node が binding ごとの Scope を運べるようにし、内側の上限は proposal/6 の規則で決めて記録する | actor と受信先は変えない。A3 は Revision ごとに評価済みで、edge は exact binding を持つ（post-B §6.3 に合う）。frame の全体の上限は変えない | 代表の版に畳む（§6.3 に触れるので [precheck]）。何もしない（場面ごとの review で中心人物が常に unavailable） | 現実形の検証（opus、read-only）：実装の欠陥で委任の範囲 | 該当なし | 不要（worker の lifecycle は変えない） | 記録済み（実装前） |
| DR-CQA-2 | 2026-10-14 | CQ-AVAIL | node 上限・edge 上限・版の衝突に型付きの理由を与え、空の Graph を worker でも available（寄与 0）として返す | 拒否の条件は変えない。in-process と worker の結果を揃える | 空の Graph を typed unavailable に揃える（可用性の記録で常に unavailable の状態が増える） | 同上 | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-3 | 2026-10-14 | CQ-AVAIL | project 単位の読取（Scope authority の tree、binding、registry、epoch、query scene、POV）を query で1回だけ読み、1回だけ admit する。Revision に結び付く行は Revision ごと。読取を減らさずに課金だけを減らすことはしない | 上限の値は変えない。post-B の「request-local で重複検証を抑える」に合う。読取と課金を1対1に保つ | 課金だけ減らす（閾値の緩和で [precheck]）。何もしない（2件目の Revision で 512 を超える） | 同上 | 該当なし（値も数え方の対象も変えず、実際の読取を減らす） | 不要 | 記録済み（実装前） |
| DR-CQA-4 | 2026-10-14 | CQ-AVAIL（レビュー指摘の修正） | Full workload allocation の worker.q512 の reviewed inventory を、新しい Q512 fixture（materials 164、registry の参照 5、材料の無い Scene 60）で再導出する。式は pages = 679 + 21×materials + 93 + refs に、材料の無い Scene の項（Scene ごとに tree_nodes／FTS／Scene binding の 20 の table・index 面に 1 page ずつ）を足す。式の導出は schema-contract.json と sqlite_master の数え直しによる。派生する fullMemoryRisk の「other-full-consumers」の DB 項と、その合計の試験定数、docs/pr610-full-workload-risk.md の数値も合わせる。journey の inventory（schema baseline + 旧 Q512 の mutation image の size class）は再導出しない | 資源の見積りを増やす方向だけ（安全側）。新しい送信先、保存範囲、閾値の緩和は無い。dataset は独立 review が前提なので、変更は PR 本文と台帳に残す | 式を変えず 679 + 21×164 + 93 + 5 = 4,221 pages にする（Scene 項なし。材料の無い Scene 60 の tree／Scene binding の行を見積りから落とす）。journey の inventory も新 Q512 に合わせて再導出する（製品 journey は C-query fixture を使わないので根拠が無い） | 指摘 P2（レビュー）が方針を示した | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-5 | 2026-10-14 | CQ-AVAIL（レビュー指摘の修正） | DR-CQA-3 の「読取と課金は 1 対 1」を、読取の回数（statement）の単位に限定する。Scope extension の LEFT JOIN が読む principal の Codex 行（knowledge holder／audience が character の binding あたり最大 2 行）は課金に入っていない既存の会計の穴で、本変更が増やしたものではない。課金は厳しくせず、残る制約として台帳に記録する。あわせて、課金された rows を製品側で観測する試験（test-only の hook）に置き換える | 上限の値は変えない。課金を厳しくする案は、DISCLOSURE_GLOBAL_ROWS_SQL の追加で A3 の観測 slot と steps の基準値が動き、別 lane の範囲になるので採らない | 課金に principal の行を足す（委任の範囲だが、SQL steps と診断 slot に波及する）。何もしない（台帳の「保守的な上限」が実際と食い違う） | 指摘 P3（レビュー）が両案を示した | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-6 | 2026-11-11 | C-query の場面数の壁（A-α）。枝 `claude/cquery-binding-join`（DR-GRW-5＝#862 の head の上） | Scope extension の binding の SELECT から `LEFT JOIN tree_nodes` を外し、`sceneOwned` を authority が読んだ nodes の「project の Scene の id の集合」で決める（読取 −N_b）。`DISCLOSURE_GLOBAL_ROWS_SQL` の binding の行の乗数を 2→1 にする（課金 −N_b。課金−実読の差 N_t−P は不変）。閾値（2,048 ほか）・bytes の乗数・tree の×2 は変えない | 上限の値は変えない。行の数では、課金されていなかった join の N_b を読まなくし、CQ-AVAIL から残っていた binding の 2 回目の N_b の課金を外す（下の「×2 の由来と、委任の判断」）。文の単位では binding の表の読みは減らず課金だけが減るので、DR-CQA-3 の線の内とは断じず、2026-11-11 にユーザーが承認した A-β（課金を実読に合わせる）の一部として扱う（統合者の判断）。同じ snapshot の読みだけ。新しい送信先・保存・契約・authority・schema は無い | 課金だけ減らす（緩和で [precheck]）。A-β（課金を実読に合わせる。確認が要る）。join を残す（床は 489 のまま） | 設計調査（`cquery-scene-wall-2026-11-11.md` §2、§4、§5.2）が A-α を「委任内の見込み」とした。実装後に advisor（read-only）に諮り、停止条件 1 の読み替え、床の限定、試験の allowlist 化、記述の訂正の指摘を受けて反映した | 承認済みの A-β の範囲（課金を実読に合わせる。2026-11-11 ユーザー決定）。値・新しい閾値・契約は変えない。principal の行を数える残りは A-β の PR で入れる | 不要（thread・handle・取消点・再開の状態を足さない。下の節） | 記録済み（実装と同じ commit に記録） |
| DR-CQA-7 | 2026-11-12 | C-query の場面数の壁（A-β。行の課金を実読に合わせる）。枝 `claude/cquery-charge-actual`（DR-CQA-6＝#869 の head `f7ece285` の上） | `DISCLOSURE_GLOBAL_ROWS_SQL` の `tree_nodes` の COUNT の乗数を 2→1 にし（authority が tree を読むのは 1 回）、principal の Codex 行 P（Scope extension の binding の SELECT が `LEFT JOIN codex_entries kh`／`au` で読む行）を数える文 `SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL` を `preflight_project_reads` に足す（×1。kh と au は別に数える）。P の文は extension の SELECT と同じ join の文（macro で 1 つの文字列）から作り、binding を読んで `COUNT(kh.id)+COUNT(au.id)` を返す。bytes の乗数・閾値（2,048 ほか）・registry・binding の×1・join の tree 行の 0 は変えない | 上限の値と bytes の乗数は変えない。数える行を実際に読む行に合わせるだけで、実読を下回る数え方は作らない（P は実読と同じ join の結果）。新しい送信先・保存・契約・authority・schema・依存は無い。同じ snapshot の中の読みが 1 文増える（binding を project 単位で 1 回走査し、codex を主キーで引く） | 表 `DISCLOSURE_GLOBAL_ROWS_SQL` に行を足す（診断の slot が 9 に衝突し、material rows と bytes の slot を全部ずらす）。binding の COUNT 文を `COUNT(*)+COUNT(kh.id)+COUNT(au.id)` にして 8 行のまま保つ（依頼の「文を足す」から外れる）。P を課金せず tree だけ×1 にする（実読を下回る緩和で承認の外）。bytes も×1 にする（4 Revision の台帳の壁が動くので別の決定） | 着手前に advisor（read-only）に 1 回諮った（表の外に足す、slot は末尾の 23、P の文は extension の FROM を写す、512 の扱い、床は bisect で取り直す）。実装後にもう 1 回諮る | 2026-11-11 にユーザーが承認した A-β（「数える行を実際に読む行に合わせる（約 978 場面）。数え方の緩和に当たる。上限 2,048 の値は変えない」）の範囲の**行（rows）の課金だけ**。bytes の乗数は変えない（別の決定）。値・契約・新しい閾値・D2・B・100 ms の壁・主人公級は含まない | 不要（thread・handle・取消点・再開の状態を足さない。下の節） | 記録済み（実装と同じ commit に記録） |

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
`the_floor_of_a_bare_one_revision_project_is_n_available_and_n_plus_1_refused`（床の N／N＋1）、`measure_the_bare_floor`（ignore の測定）。

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

基点は DR-CQA-6（PR #869）の head `f7ece285`、枝は `claude/cquery-charge-actual`。設計の正本は
`fusion-eval-data/design-notes/db-connection-2026-11-07/cquery-scene-wall-2026-11-11.md` の §2、§4、§5.1〜5.2 の「A-β」。
仮実装（dev 枝 `claude/dev-cquery-real-shapes` の `68195c5d`）の床の実測（`drift-measure/cquery-real-shapes-2026-11-12/results.md`）が、この PR の予測値の出所。
**値（上限・閾値・契約・authority・admission の閾値・schema）と bytes の乗数は変えない。**

### 承認と範囲

2026-11-11 にユーザーが選んだ文面：「数える行を実際に読む行に合わせる（約 978 場面）。数え方の緩和に当たる。上限 2,048 の値は変えない」。
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
3. 変えないもの：binding の COUNT の×1（DR-CQA-6）、join の tree 行の 0（DR-CQA-6）、registry・projects・query Scene・POV・Epoch、bytes の乗数、閾値。

### 数え方の変化

| | 読取（query 1 本の実読） | 課金（`preflight_project_reads`、旧＝DR-CQA-6 の後） |
|---|---|---|
| 旧（A-α） | N_t ＋ N_b ＋ P ＋ 2R ＋ 3 | 2N_t ＋ N_b ＋ 2R ＋ 3 |
| 新（A-β） | N_t ＋ N_b ＋ P ＋ 2R ＋ 3（**不変**） | N_t ＋ N_b ＋ **P** ＋ 2R ＋ 3 |
| 課金−実読 | — | 旧：N_t − P。新：**0**（P が実読の join の結果と同じ） |

bare（N_t＝n＋1、N_b＝n、P＝0）の shared は 3n＋19 から 2n＋18 になる。principal が全部 character（P＝2N_b）の形は 2n＋18 に 2n を足して 4n＋18 で、
1 Revision の床は A-α の 652 より下がる（下の「変わる点」）。

### 等価性（P の数え方＝extension の join）

- extension の SELECT は binding ごとに `kh` と `au` を `LEFT JOIN` し、join が成り立つ（`CASE WHEN kh.id IS NOT NULL`）列を最後の 2 列に返す。P の文はその FROM 句をそのまま使い、
  joined id を `COUNT` するので、P ＝ extension の最後の 2 列の合計。
- 試験（`scene_scope_principal_rows_tests.rs`）で固定する：同じ join の文字列（macro の出力が 2 つの文で一致する）、P の文の plan（binding と codex を主キーで引き、`TEMP B-TREE`・`AUTOMATIC` が無い）、
  各形で「課金の P ＝ extension の SELECT が返す flag の合計＝ 手で数えた期待値」：reader だけ 0、holder だけ 1、audience だけ 1、同じ character を kh と au が指して 2、別の character で 2、
  別 project の character 0、character でない type（location）0、`$.ref` が無い・null・存在しない id・数値の ref・`{"kind":"reader"}`・不正な JSON・空文字・配列（CHECK を OFF にして書く）0、
  有効な principal の隣の無効な値が有効な方の行を消さないこと、project をまたがないこと（p2 の binding は p1 の P に入らない）。
- 製品の課金そのものの観測（`cq_avail.rs` の `the_tree_and_the_principals_codex_rows_are_charged_once_each`）：同じ場面の bare と、character の principal（20 場面で＋40 行）、folder・note（＋22 行）の差を、
  query の admission（`QueryUsage::rows`）で確かめる。budget の fixture の期待値の helper（`rows_charged_by_the_seed_query`）も、principal を別の数え方（subselect の join）で足して製品の課金と突き合わせる。
- **「実読」の定義**：P は **join が成り立った行**（flag が 1 になる行）の数。SQLite は codex を主キーで引くので、ref が別 project の entry や character でない entry を指す binding では、
  その行に触れてから join の条件で落とす。落ちた行は P に入らない（依頼の定義＝extension の join に従う）。そのような ref は通常の経路では作られず
  （principal の ref は character の id で、削除時に参照は無効化される）、あっても最大 2N_b 行の差で、1 行の主キーの seek 1 回の読み。これを数える案は取らなかった。

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
  | bare（短い id、reader、folder 1） | 489 | 652 | **979** |
  | folder＋note（10 場面ごとに folder、場面と同数の note。N_t≈2.1n） | 316 | 377 | **633** |
  | principal が全部 character（P≈2N_b。base の 4 場面は reader のまま） | 489 | 652 | **491** |

  folder・note の形は、N_t を実読と同じ×1 にした分で A-α の 377 から上がる（633）が、bare の 979 には届かない（tree の行が 1 場面あたり約 2.1 行あるため）。
  principal が全部 character の形は、実読ベースで課金されるので A-α の 652 から下がる（上の「A-α 比で…」）。半分の binding だけ character（P≈N_b）の形は 654（A-α と同じ）。
  principal の分布は、実データが無くて測れなかった（この機械の実 workspace に character の principal は 0 件。dev の調べ）。最悪の形（全部 character）を実測した。
- 4 Revision（p4:300000）の 352／353 は動かない見込み（peak の台帳が先に当たり、bytes を変えないため）。実測は下記。
- 診断の slot の長さ（23→24）。

### 期待値の変更

| 場所 | 旧（A-α）→ 新 |
|---|---|
| `nir1_graph/input.rs` `DISCLOSURE_GLOBAL_ROWS_SQL` の tree の乗数 | 2 → 1 |
| `input.rs` `A3_SQL_QUERY_COUNT`、`nir1_graph_memory_diagnostics.rs` の `timings_ns` の長さと試験の期待値 | 23 → 24（slot 23 が P、slot 0 は空のまま） |
| `input.rs` の `disclosure_admits_cumulative_inputs_and_bounds_body_phase_and_scope` | shared 7（tree 2、registry 2、bindings 1、project 1、query Scene 1）→ 6（tree 1）、admission の rows 9 → 8 |
| `input.rs` の `disclosure_material_counts_preserve_duplicate_entity_and_pov_joins` | rows 15 → 14、行の上限の拒否を試す値 14 → 13 |
| `input.rs` の `disclosure_rejects_auxiliary_row_cardinality_before_materialization` | 足す note の数 1,024 → 2,048（tree が×1 なので、同じ拒否を起こすのに要る行の数） |
| `input.rs` の plan の試験 | 文の数 3＋10＋8＋8＋5 に P の文 1 を足す |
| `nir1_graph/tests/cq_avail.rs` `rows_charged_by_the_seed_query` | `2·tree + bindings + 2·registry + …` → `tree + bindings + principals + 2·registry + …` |
| 同 `a_query_loads_the_scene_bindings_in_one_statement` | audience_json 4→6、knowledge_holder_json 4→6、project_id 5→8（P の文が 2 つの principal 列と project_id を名指す） |
| 同 `BARE_FLOOR_SCENES` | 652 → 979（新たに folder＋note の 633、principal が全部 character の 491 の試験） |
| `nir1_graph/tests.rs` `Q512_SHARED_ROWS`（62 場面、N_t＝N_b＝62、principal は reader） | 201 → 139（−N_t） |
| 同 `REGISTRY33_SHARED_ROWS`（2 場面） | 75 → 73 |
| 同 Q512／registry33 の charged rows | 450 → 388、510 → 508 |
| 同 `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` の `unrelated_seed_edges` | 1,599 → 1,661（388＋1,661＝2,049） |

**「512」の扱い**：Q512／registry33 の `charged_rows`（512 から A-α で 450／510 になった値）は、これらの fixture が former limit の 512 に合わせて作られた名残で、
受入れの閾値としての意味は持たない（今の query の上限は 2,048 で、fixture は dataset hash に束縛されていて詰め直せない。コメントにも A-α から「そのまま」とある）。
台帳（`nir1-c-query-acceptance-2026-10.md` の RB-5 や PF-1 の「Q512（charged rows 512）」）は、100 ms の lease の下で実 worker が frame を返すことの確認に使う。
受入れの意味を持つのは **2,049 の拒否**（上限 2,048 ちょうどの 1 つ上）で、これは `unrelated_seed_edges` を詰め直して同じ値（2,049）に保った（A-α の 1,537→1,599 と同じ扱い。本 DR は 1,661）。
Q512／registry33 の fixture の行は下げた（388／508）が、同じ fixture が同じ frame を同じ 100 ms の内に返すことは lifecycle で確かめる。

### やらないこと

- bytes の乗数（binding の bytes×2、tree の bytes×2 など）の変更：別の決定。4 Revision の台帳の壁（352）が動く。
- D2（共有読みの別枠）、B（上限 2,048→4,096）、100 ms の壁、主人公級の行の壁、S の修正：本 DR の外。
- principal を課金しない緩和、join で落ちた行を数える案。

### 試験

- **P の数え方（`scene_scope_principal_rows_tests.rs`、9 件）**：上の「等価性」のとおり。各形で「課金の P ＝ extension の SELECT が返す kh／au の flag の合計＝期待値」を断言する。
- **課金の観測（`cq_avail.rs`）**：`the_tree_and_the_principals_codex_rows_are_charged_once_each`（admission の差：principal が character で＋2×20、folder・note で＋22）、
  `rows_charged_by_the_seed_query`（別の数え方の principal を足した期待値と、製品の課金の突き合わせ。`a_revision_costs_its_own_rows_and_none_of_the_shared_ones`、
  `query_records_at_2048_is_available`、`query_records_at_2049_refuses_the_whole_graph` ほか全件）、
  `a_query_loads_the_scene_bindings_in_one_statement`（authorizer の列挙。P の文の分だけ増える）。
- **床（`cq_avail.rs`）**：bare の `the_floor_of_a_bare_one_revision_project_is_n_available_and_n_plus_1_refused`（979／980）、
  `the_floor_with_folders_and_notes_is_n_available_and_n_plus_1_refused`（633／634）、`the_floor_with_character_principals_is_n_available_and_n_plus_1_refused`（491／492）。
  拒否の理由のコードは完全一致（`query-worker-work-candidate-record-limit-pre-cleanup-work-failed-candidate-record-limit`。shared の拒否〔`disclosure-record-limit`〕ではない）。
  character の形は fixture の P が 2×追加場面であることを断言する（P が 0 に落ちると別の床で通るため）。値は `measure_the_floor`（ignore の測定、`CQ_FLOOR_SHAPE`）の二分探索で取り直した（仮実装の値は写していない）。
- `input.rs`：admission の rows、診断の slot 23（観測・失敗・overflow）、plan（P の文を含む）、行の上限の拒否。

### 検証の結果（2026-11-12、commit の時点）

- `cargo test -p grimodex-db --lib` 全件：**2,667 passed、0 failed、57 ignored**。`cargo clippy -p grimodex-db --all-targets -- -D warnings`：通る。
- `scripts/nir1-c-query-worker-ci.sh lifecycle`：26 case の `test result: ok`（終了コード 0）。registry33 は shared 73、admitted 508 で通る。
- Q512（実 worker。lifecycle の外なので、同じ手順〔`nir1-material-capacity fixture`、worker の build、2 つの ignored test〕を手で実行）：
  `native_worker_returns_canonical_512_a3_eligible_seed_local_graph` は shared 139、admitted 388 で通る。
  `native_worker_refuses_exact_2049_seed_local_unrelated_reverse_index_edges` は candidate_rows 1,663（2＋1,661）、admitted 1,966 で `disclosure-record-limit` を返す。
  既定の lane 全体（`nir1-c-query-worker-ci.sh` の引数なし）と practical-retention は実行していない。
- `fnm exec --using=22 pnpm -s verify:quality`：通る（終了コード 0）。
- 床の 979／633／491 は in-process（worker の構成〔`worker_reader`、`query_for_worker_with_maintenance_deadline`〕を同じ process で動かした値。admission の文と式は worker と同じコード）。実 worker の測定は次の節。

### 実 worker の測定（2026-11-12、dev の実 worker、PR の前）

dev 枝 `claude/dev-cquery-charge-actual-measure`（`ff2d4f81`＝本 DR の commit `3e3d2c75`＋測定 harness `274a56da` の cherry-pick。製品コードは変えず、push・PR なし）。記録：
`fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/cquery-charge-actual-2026-11-12/results.md`（raw、集計、binary の sha256、build log）。

- **床（1 Revision。N は available、N＋1 は型付きの拒否 `candidate-record-limit`。worker は abort せず frame まで進んだ。各 3 回同一）**：bare **979／980**、folder＋note **633／634**、character（P＝2×追加場面）**491／492**。in-process の二分探索の値と一致。
- **query の Q 高水位**：bare 979 は 4,199,070 B（25.03%。A-α の 652 は 3,814,832 B）、folder＋note の 633 と character の 491 は 3,814,832 B（22.74%）。worker 内 query_ms は 49〜50、39〜41、36〜37 ms。
- **4 Revision（p4:300000）の 352／353 は動かない**：352 は available、353 は `other`（retained）。bytes を変えていないため。
- **時間の対照（p4 の 352・337 場面、A-β 対 A-α〔基点 `383b8568`＝A-α＋harness〕、各腕 8 本、AB／BA の交互、開始時の loadavg 1.34、run の 1 分値は 1.2〜1.3）**：
  時間切れは A-β 0／16、A-α 0／16。worker 内 query_ms の中央値／最大は 352 場面で 79.5／80 対 85／86 ms、337 場面で 79.5／81 対 85／86 ms。owner の往復は 107〜108 対 108〜112 ms。
  A-β が足した preflight の文（binding ごとの JSON の読み）は、100 ms の期限の余裕（約 15 ms）を食わなかった（A-β の方が約 5 ms 短かった。原因は未確認）。
  DR-CQA-6 の対照（loadavg 2.3〜4.2）では両腕とも 6／16 が時間切れだった。時間の余裕が無い形は load しだいで 100 ms に当たる点は A-α と同じで、本 DR は変えていない。
- 限界：3 形の床だけ（半分だけ character・UUID・長い title は in-process の dev の測定のみ）。時間の対照は静かな時間帯の 1 回。principal の分布は実データが無く測れていない。
