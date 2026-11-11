# Graph の worker の registration の窓（drift）の判断記録

対象は、Graph の worker が registration を行う間（窓 W）に別の接続が commit すると、drift で失敗する件。
出所は 2026-11-10 の測定（dev の worktree `claude/dev-drift-window`、記録は
`fusion-eval-data/design-notes/db-connection-2026-11-07/` の `window-shortening-design.md` §2.3 と、
同 dev worktree の `nir1_graph/tests/drift_window.rs`）。基点は `origin/master` の `880d55f0`、
branch は `claude/graph-source-index-linear`。

この lane は窓を縮める実装の変更を 1 件ずつ進める。1 件目は SourceIndex の UNEXPECTED の 1 文だけ。
結果・述語・admission の上限・エラーの種類・停止の粒度・schema・閾値・契約・authority は変えない
（AGENTS.md の「委任に含まれないもの」のどれにも当たらない）。

## DR-GRW-1 SourceIndex の UNEXPECTED を、edge ごとの json 再解析から revision ごと 1 回の materialize にする

### 決定

`nir1_graph/candidates.rs` の `SOURCE_INDEX_UNEXPECTED_SQL`（`verify_complete_source_index` の 4 文目）だけを書き換える。

- 旧：edge ごとに `NOT EXISTS (SELECT 1 FROM json_each(r.payload_json,'$.bundle.entities') …)` で payload を解析し直す。
- 新：`QUALIFYING_REVISIONS` の後ろに 2 つの CTE を足し、revision ごとに 1 回だけ解析する。
  - `valid(id, project_id) AS MATERIALIZED`：`qualifying` から始め、`r` は主キーで引く。r だけに依る 6 つの JSON 条件
    （`json_valid`、schemaVersion、kind、producer、projectId、revisionId）を revision ごとに 1 回評価する。
    加えて、この project・この consumer_kind（`?7`）で `codex:%` の edge を 1 本以上持つ revision だけを通す（下の「edge の無い revision」）。
  - `entity_ids(rid, identity) AS MATERIALIZED`：`valid` の各 revision の `json_each` から `CAST('codex:' || entityId AS TEXT)` を 1 回だけ作る。
    `CAST` は値を変えない（`'codex:' || x` はもともと text か NULL）。`identity` に TEXT affinity を付け、SQLite が
    `(rid, identity)` の automatic index を作れるようにするために置く。affinity が無いと index は `rid` だけになり、probe のたびに revision の全 entity を走査する。
  - 本体：`valid` と edge を join し、`NOT EXISTS (SELECT 1 FROM entity_ids WHERE rid=v.id AND identity=edge.source_object_identity)` で見る。
    edge 側の条件（`edge.project_id=?1`、`edge.consumer_kind=?7`、`LIKE 'codex:%'`）は旧と同じ意味。
- 旧の文は `#[cfg(test)]` の oracle `SOURCE_INDEX_UNEXPECTED_PER_EDGE_ORACLE_SQL` として残し、新しい文と比べる。
- 他の 3 文（MALFORMED／MISSING／DUPLICATE）と `QUALIFYING_REVISIONS`、`source_index_sql`、文の順序、文の間の `control.check` は変えない。
- 変わらないもの：結果（`SELECT EXISTS` の 0／1）、述語の集合、bind する parameter（`?1`〜`?7`）、admission の上限、エラーの種類、停止（cancel／deadline）の粒度、schema、閾値、契約。

### 理由

- A2／C の測定：窓の中で別接続が commit すると、実 worker では 30／30 で REFUSED（drift）になる。W は大きい DB で 1〜5 s。
- SourceIndex の 4 文のうち UNEXPECTED の 1 文が、Q2044／R4 と Q8176／R16 の W の約 7 割を占める。
  edge ごとに payload を解析し直すので、時間は revision 内の material 数の二乗（Q²／R）になる。他の 3 文は各 3〜30 ms で、すでに線形。
- 測定（dev、release、SQLite 3.53.2、読取専用の新しい接続を毎回、10 回の p50）：

  | case | UNEXPECTED 旧 | UNEXPECTED 新（試作） | SourceIndex 4 文の合計 旧 → 新 |
  |---|---|---|---|
  | Q513／R3 | 55.3 ms | 1.6 ms | 59.4 → 5.6 ms |
  | Q2044／R4 | 672 ms | 5.9 ms | 687 → 21 ms |
  | Q8176／R16 | 2,682 ms | 23 ms | 2,743 → 82 ms |
  | Q2044／R1022 | 12.3 ms | 14.6 ms | 48.5 → 51.5 ms（二乗の部分が無い形で、変わらない） |

  この表の「新」は dev の試作（`entity_ids` に edge の有無の条件が無い版）の値。この PR の文は `valid` に edge の条件を足しているので、
  dev で同条件の測り直しが要る（gate）。この PR の文での窓 W の測定は gate 4 にある（R4 は約 0.95 s → 約 0.30 s、R16 は約 3.9 s → 約 1.2 s）。

### edge の無い revision（試作との差）

試作は全 `valid` revision の `entity_ids` を作る。edge の無い revision に壊れた entity（例：`"abc"` という文字列）があると、
`json_extract(entity.value,'$.entityId')` が `malformed JSON` で失敗する。旧の文は edge ごとにしか entity を読まないので、
edge の無い revision の entity は読まず、false を返す。この PR は `valid` に「`codex:%` の edge を 1 本以上持つ」条件を足し、
`entity_ids` を edge のある revision に限る（試験 `unexpected_in_one_pass_does_not_read_the_entities_of_a_revision_without_an_edge`）。
製品の連鎖では MALFORMED が先に止めるので顕在化しないが、文単体でも旧と同じ結果にする。

### 残る差（試験で固定した）

旧の文は、ある edge が名指す entity に当たった時点でその revision の entity の読みを止める。新しい文は、edge のある revision の entity を全部読む。
そのため、edge のある revision に非 object の entity（JSON として読めない文字列）があり、旧が先に edge に当たって読み終える入力では、
旧は false、新は `malformed JSON` になる（`a_non_object_entity_behind_a_revision_that_has_edges_fails_only_the_statement_not_the_proof`）。
この revision は MALFORMED（`entity.type<>'object'`）が先に true にするので、`verify_complete_source_index` の結果（`Ok(false)`）は旧と同じで、
UNEXPECTED には届かない。旧が error になる入力は、新も同じ error。

### 信頼境界（変わらない）

- 読むのは同じ表（`narrative_proposal_revisions`・`narrative_proposals`・`narrative_proposal_sets`・`narrative_extraction_runs`・`narrative_dependency_edges`）、
  同じ payload、同じ snapshot。payload を読むのは `qualifying`（現在の承認済みの typed Revision）の revision だけで、`valid` も `qualifying` から始めて `r` を主キーで引く。
  この性質は `registration_proof_parses_the_payload_of_nothing_but_its_subject` と、UNEXPECTED 単体の JSON 呼び出しの記録
  （`unexpected_in_one_pass_parses_the_payload_of_nothing_but_its_subject`）で確かめる。
- 新しい送信先・保存範囲・契約・authority・IPC・schema・依存は無い。接続・thread・lifecycle も変えない
  （文は同じ worker の同じ接続で、同じ `GraphWorkControl` の check の間に走る）。
- memory：CTE は SQLite の一時 b-tree（Q の heap）に載る。dev の試作の SQLite heap の peak（`sqlite3_status64`、statement 開始時からの上昇）は、
  UNEXPECTED の文単体で Q2044／R4 が約 0.75 → 1.87 MB、Q8176／R16 が約 0.76 → 1.88 MB。増えた分の原因は特定していない
  （`entity_ids` の Q×70 B では説明できない。json の解析結果の保持か automatic index かは推測）。proof 全体の peak（4 文の最大）で見ると、
  同じ dev の測定で、R4 は旧が DUPLICATE の 1.56 MB、新が UNEXPECTED の 1.87 MB（+0.31 MB）、R16 は旧が DUPLICATE の 2.18 MB で新の UNEXPECTED 1.88 MB を上回る（proof の peak は変わらない）。
  worker の Q は 16 MiB（`bin/support/c_query_fixed_allocator.rs` の `QUERY_BYTES`）で、proof は scratch の scope の外（Q）で走る。上限に対しては約 2% の差。

### やらないこと（別の決定）

- registration の pinned snapshot 化（B1）：drift の検査・READY の条件に触れるので別の決定。
- registration の読みの共有（B2）。
- postflight の比較の変更。
- drift を数えない扱い（(a′)）。
- schema の index（migration が要る案）。

### gate

1. oracle の同値性：旧の UNEXPECTED と新の文を、健全な fixture と壊した copy 35 種（合わせて 36 通り。下の 2 種の表で 72 件）で、(a) 文単体の EXISTS の値（または error）、
   (b) `verify_complete_source_index` の結果と error 文で比べる。実 schema の `UNIQUE(project_id, consumer_kind, consumer_key, source_object_identity)` を持つ表と、持たない表（DUPLICATE の synthetic）の両方で行う
   （`unexpected_in_one_pass_agrees_with_the_per_edge_statement_on_every_damage`）。DUPLICATE が実 schema の UNIQUE で入らない事実は
   `the_edge_table_of_the_real_schema_forbids_a_duplicate_proposal_revision_edge` と、同じ試験の「UNIQUE の表では DUPLICATE の挿入が拒否される」断言で表す。
2. plan の断言：`unexpected_in_one_pass_reads_each_payload_once_and_probes_the_entities_by_index`（`MATERIALIZE valid`／`entity_ids`、payload の列挙が 1 回、`SEARCH e USING AUTOMATIC COVERING INDEX (rid=? AND identity=?)`、
   旧は correlated subquery で materialize が無い対照）。既存の `registration_proof_parses_the_payload_of_nothing_but_its_subject` の plan の断言は、新しい plan でもそのまま成り立つ（変更なし）。
3. memory diagnostics：実 worker の固定 allocator で `native_worker_registration_*` の 2 本（ignored、`NIR1_C_QUERY_WORKER_BIN`）を通す。
   大きい DB の heap の山は、dev の測定値（上）だけで、official Q2 preseed の diagnostics は未実行。
4. dev で A2 の W を同条件で測り直す（この PR の文で）。結果（2026-11-10、release、各 30 回、writer なし、読取の接続は毎回新しい。
   PR の前は dev 枝 `84a110c3`、後は同じ dev の測定にこの PR の文を載せた `88397983`。2 つの枝の差は `candidates.rs` だけで、試験・fixture・回数は同じ。
   1 分平均の負荷は、前が開始 2.23・終了 2.29、後が開始 2.31・終了 1.33。
   記録は `drift-measure/drift-a2-base2-summary.txt` と `drift-a2-pra-summary.txt`。前回の A2〔`drift-a2-summary.txt`〕は負荷平均 4〜9 の下の値なので、比べるのに使わない）：

   | case | W p50 前 → 後 | W p95 前 → 後 |
   |---|---|---|
   | Q513／R3 | 126 → 76 ms（−40%） | 128 → 77 ms |
   | Q2044／R4 | 949 → 297 ms（−69%） | 960 → 305 ms |
   | Q2044／R1022 | 2,736 → 2,704 ms（−1%。二乗の部分が無い形で、対象外） | 2,786 → 2,721 ms |
   | Q8176／R16 | 3,877 → 1,198 ms（−69%） | 3,987 → 1,211 ms |
   | D2064／report-heavy | 3,130 → 2,995 ms（−4%） | 3,246 → 3,034 ms |

   縮んだ量（R4 −652 ms、R16 −2,678 ms）は、上の表の試作（edge の条件が無い版）で測った UNEXPECTED の文単体の縮み（−666 ms、−2,659 ms）とほぼ同じ。
   R1022 は二乗の部分が無く対象外で、−1% にとどまる。前後の負荷の差による影響は 1% 程度とみる（対照）。
   D2064 は p50 −135 ms・p95 −212 ms（−4%）。最後に走る case で後の run は負荷が下がっていたので、UNEXPECTED の分か負荷の差かは切り分けていない。
   R1022 と D2064 の W の主は Semantic 段（B1／B2 の対象）。byte-heavy は前後とも admission の上限で止まる（同じ）。

## DR-GRW-2 registration の表の存在確認を pinned snapshot の schema cache で答える（B1）

2026-11-10 の 2 件目。基点は `origin/master` の `67549453`（DR-GRW-1 を含む）、branch は `claude/graph-registration-pinned`。
冒頭の約束（結果・エラーの種類・停止の粒度などを変えない）のうち、この決定では、steps の上限・期限の境目の結果と、
停止を見つける時期・stage・エラーの種類（raw か typed か）が「変わる点」の 2〜4 の範囲で動く。閾値の値・schema・契約・authority は変えない。

### 決定

Graph worker の registration（`Nir1GraphReader::register_with_control_observed`）の read transaction の中で、
CQ-OPT（#657）が C-query に使っている `with_pinned_snapshot`（`nir1_pinned_snapshot.rs`）と
`table_exists` の近道（`sqlite3_table_column_metadata`。VM steps 0）を使う。

- scope は、nonpositive の query（`narrative_dependency_edges` の rowid の検査）の**後**から、
  `read_seal` の**後**までを包む。`finish_read` の ROLLBACK の前で閉じる。
- scope は scratch scope（割当器の scope）の外側（pinned が外、scratch が内）に置く。
- nonpositive の query は scope の外に置く。近道が答えてよいのは、この transaction で表を読む普通の文が
  走った後だけである。header PRAGMA（`ReadIdentity::read` の schema_version などの読み）は snapshot を
  固定するが、schema の cache と snapshot の cookie を比べない。表を読む普通の文が走ってはじめて SQLite は
  cookie を比べ、違えば cache を読み直す。nonpositive の query がその文で、scope の中の最初の存在確認より前に走る。
  この条件を、コードのコメントに書いた。
- 早期 return（nonpositive、Semantic 段の false、SourceIndex 段の false）と `?` は closure の内側で扱い、
  結果の値、stage の更新順、owner の check、エラーの型は変えない。
- 近道が答える表の存在確認は、Revision ごとの scene scope、declaration set（2 か所）、c2zc の marker など。
  健全な試験 fixture の registration 1 回で 12 回（SQL の下では `sqlite_master` の列の読みで 24 回。内訳は「呼び出しの内訳」）。

### 理由

registration は BEGIN DEFERRED の後で、nonpositive の query、Semantic 段、SourceIndex 段、`read_seal`、ROLLBACK の
順に進む。この間に別の接続が commit すると drift（`NIR1_GRAPH_REGISTRATION_DRIFT`、または postflight の不一致）で
失敗する。目的は、この窓を縮めること。

Semantic 段は Revision ごとに、`sqlite_master` を全件歩く表の存在確認を何度も走らせる。
`sqlite_master` には引ける index が無く、migrate 済みの workspace では 1 回が数千 steps になる
（CQ-OPT の実測で 1 回 2,224 steps、672 行）。これは Revision の中身を何も検証していない。
この費用を VM steps 0 にすれば、窓のうち Semantic 段の待ちが減る。

### CQ-OPT の範囲の反転と、その反証

CQ-OPT は「C-query だけ。registration は SQL のまま」と範囲を決めた
（`nir1_pinned_snapshot.rs` の旧 module doc、`docs/plans/nir1-c-query-acceptance-2026-10.md`）。
理由は、steps で停止を観測する経路は、存在確認が消費する steps が変わると停止の時期が変わるから、
全体に近道を置かないことだった（Chronicle の index publication は 1,000 steps の progress callback で止まる）。
この決定は registration について反転する。範囲は「registration と C-query の 2 つだけ」とする。

#### registration も steps で停止を観測する（反転の前提の訂正）

registration は、Chronicle と同じく steps で停止を観測する。`install_owner_with_stop` が 1,000 VM steps ごとの
owner の progress callback を入れており、その callback は stop の flag、期限、close、workspace generation、
foreground の待ちを見る（`narrative_maintenance_connection.rs:632-645`）。Rust 側の `check_active_work` や
JSON の読みも同じ callback を呼ぶ（`nir1_capacity.rs:179-196`）ので、callback の回数は「steps / 1,000」ではない。

違いは次の 2 点である。

1. **registration の停止は状態で決まる。ただし callback が見る条件は 2 種類あり、終わり方が違う。**
   - **owner の条件**（closed、stop、participant の終了、generation、期限、foreground の待ち。`narrative_maintenance_connection.rs:560-616`）：
     owner の `check()` も同じ状態を読む。callback で SQLite が中断されても、されなくても、registration の終わりの
     `registration_owner.check(CompleteRegistration)` が同じ typed の停止を返す。変わるのは、停止を**見る時期**
     （callback の何回目か）と、そのときの stage だけである。callback の回数は近道で減るので、停止は後の点で見つかる。
     停止が、近道の下の registration が終わった後にしか来ない場合は、registration が完了する
     （試験 `registration_state_stops_end_in_the_same_typed_stop_and_never_leak_the_scope`。この試験は owner の条件だけを模す）。
   - **reader の条件**（registration が積む callback の先頭の `control.check(GraphWorkStage::Row)` が見る `ReaderControl` の
     cancelled、epoch の変化、participant の `stop_requested()`。`nir1_graph.rs` の `install_owner_with_stop` と `ReaderControl::check`）：
     owner の `check()` は読まない。SQLite がこの条件で中断すると、closure の後の `registration_owner.check` が Ok を返すので、
     raw の SQLite の中断のまま返る。中断されずに Rust 側（`lifecycle.check`、`check_active_work`、postflight の `self.check()`）で
     見れば、typed の `Cancelled` になる。このため reader の条件では、近道でエラーの種類が raw と typed の間で動きうる
     （worker の分類では `CanonicalRegistrationSqliteError` と `CanonicalRegistration` の間）。
     worker では registration の間に reader の条件を立てる経路が無い（bin は `cancellation()` を渡さず、thread を起こさず、
     epoch を進める操作を呼ばず、participant は worker の中だけのもの。呼び出しの経路の確認による）。到達するのは in-process の試験と diagnostics だけである。
2. **Chronicle の publication は、停止点が試験で固定されている。** publication が 1,000 steps の callback で
   止まることを `nir1_participant_sql_publication_installs_only_after_clean_success` が固定している
   （固定しているのは「publication が steps の callback で止まること」で、近道を入れないことではない）。
   Chronicle の publication は registration と呼び出しの経路を共有しないので、registration に scope を置いても
   到達しない。Chronicle を SQL のままにする根拠は、呼び出しの経路が別であることと、停止点が試験で固定されていることである。

#### 反転の根拠（read-only の調査で確かめ、反証にもかけた）

- 製品で registration を呼ぶのは worker（`bin/nir1-c-query-worker.rs:229`）だけで、1 thread・同じ接続で動く。
  feature 付きの diagnostics（`nir1_graph_memory_diagnostics.rs:455` の `register_with_control`）と試験も
  registration を呼ぶので、近道に入り、その計測値（steps、callback の回数、`sqlite_master` の読み）は動く。
  Chronicle の publication など、steps で停止を観測する他の経路は、registration から到達しない。
- 近道に届くのは Semantic 段だけ。SourceIndex 段と `read_seal` は `sqlite_master` を読まない。
- scope の中の文は、読みと SAVEPOINT／RELEASE だけで、transaction を終えない
  （試験 `registration_scope_statements_never_end_the_transaction` が authorizer で、transaction 文は registration 自身の
  BEGIN と ROLLBACK だけであることを確かめる）。registration から到達する SQL の SAVEPOINT は
  試験 fixture では `narrative_project_scope_authority_snapshot`（`project_scope_authority.rs:300`）の
SAVEPOINT／RELEASE だけが観測された。他の SQL の SAVEPOINT（`source_revision.rs:908`、`scope_dependency_projection.rs:179`、
`scope_authority_runtime.rs:1159`）は、この fixture の registration では実行されず、到達するかどうかは入力の形による。
どれも SAVEPOINT／RELEASE か ROLLBACK TO＋RELEASE の形で、外側の transaction を終える文ではない。scratch scope は割当器の scope で、SAVEPOINT ではない。
  仮に transaction が終わっても、scope は接続と data version を記録しており、読み snapshot を持たない・
  data version が変わったときは SQL に戻る（`nir1_pinned_snapshot.rs` の既存の仕様と試験）。
- 近道と SQL の値が分かれうるのは、`sqlite_master.name` が定数と大文字小文字だけ違う DB のときだけ。
  C-query で既に受け入れている条件と同じである。

### 変わる点

1. **Semantic 段の VM steps と、SQLite 経由の owner callback の回数が減る。** 表の存在確認が 0 steps になる。
   callback は SQLite が 1,000 steps ごとに呼ぶほか、Rust 側の check も呼ぶので、減りは steps の減りに
   完全には比例しない（健全な fixture で 103 → 76 回）。CapacityBudget の 600M steps・180 s の値は
   変えないが、課金される作業が減る。見積りは R1022 で約 2,000 万 steps（上限の約 3%）。実測は「steps の実測」。
2. **steps の上限の境目では、Err から成功へ、通る方向にだけ動く。** Semantic 段は
   `CapacityBudget::supported()`（600M steps・180 s。`nir1_capacity.rs:11-12`）の下で動く
   （`is_complete_registered_with_scratch` の `with_capacity_scope`）。近道は課金される steps を減らすので、
   SQL 版なら `CapacityExceeded` になる境目の入力が、成功に変わりうる。逆に、SQL 版が通った入力が近道で
   上限に当たることは無い。CQ-OPT が C-query の steps の上限（100,000 steps）について同じ形を受け入れた先例がある
   （`docs/plans/nir1-c-query-acceptance-2026-10.md:329-334`。「値を変えずに steps を減らす最適化」で、
   `nir1_graph/tests/cq_opt.rs` の `before_cq_opt` は、最適化前には上限を超えていた入力が通ることを前提に、
   steps の上限を外して比較している）。registration の上限（600M steps）と実入力との距離は「steps の実測」に書く。
3. **停止を見つける時期と、reader の条件ではエラーの種類が動きうる。** 「CQ-OPT の範囲の反転と、その反証」の 1。
   owner の条件の停止は、終わりの `check()` が同じ typed の停止として返し、変わるのは時期と stage だけである。
   reader の条件の停止は、raw の中断と typed の `Cancelled` の間で動きうる（worker では到達しない）。
4. **worker の `registration_error_stage`（`bin/nir1-c-query-worker.rs:92-117`）で、raw の SQLite エラーと
   typed のエラーの割合が動きうる。** 近道は stage の更新順とエラーの型を変えない。ただし、表の存在確認の SQL が
   走らなくなるので、その statement 内で当たっていた SQLite の失敗（NOMEM や progress による中断など）は
   起きなくなり、残る失敗は残りの statement で当たる。このため、起動失敗の分類
   （`CanonicalRegistrationSqliteNoMem`、`CanonicalRegistrationSqliteError`、typed）の割合が変わりうる。
   これは worker の起動失敗の分類にだけ効く到達しない経路（製品の契約・復旧・利用者向けの文言に出ない）として扱う。
   上限・期限・停止に当たらない限り、registration の成否（true／false／Err）の判定は変えない（当たる場合は 2・3）。
5. **親の START_TIMEOUT（`c_query_worker.rs:32`、30 s）に対しては、通る方向にだけ動く。** registration が使う時間が
   減るだけで、増える経路は無い。
6. **大文字小文字の差。** 近道は SQLite の名前解決（大文字小文字を区別しない）に従い、SQL 版は `name = ?` の
   比較（BINARY）に従う。`sqlite_master.name` が定数と大文字小文字だけ違う DB では値が分かれうるが、
   これは C-query で既に受け入れている条件で、registration に新しい種類の差を足さない。

### 変わらない点

上限・期限・停止に当たらない限り、次は変わらない（当たる場合は「変わる点」の 2・3）。

- registration の結果（true／false／Err）、seal、失敗の種類、エラー文、stage の更新順、owner の `check()` の位置と回数。
- `set_registration_stage` の呼び出しの順序。
- scratch scope の中身と、registration の外側（identity の前後の読み、publish）。
- Chronicle の publication など、範囲の外の読み手は SQL のまま。
- 閾値の値（CapacityBudget の 600M steps・180 s、START_TIMEOUT 30 s、A2 の admission bytes など）。

### 信頼境界

- 呼び出し元は worker の 1 thread・同じ接続だけ（と、feature 付きの diagnostics と試験）で、renderer・main・MCP からは変わらない。
- scope は thread-local で、動的な extent（closure の実行中）に限られる。closure が終われば（unwind でも）
  元の値に戻る。接続の identity と pager の data version が scope の記録と違えば SQL に戻る。
- 近道は schema の cache が snapshot の schema と同じときだけ答える（最初の表を読む文が cookie を比べた後）。
  snapshot が固定されるのは `ReadIdentity::read` の最初の PRAGMA の時で、`BEGIN DEFERRED` だけでは固定されない。
  別接続の DDL は、identity の読みの後の commit は snapshot に見えず（snapshot の schema で答える）、
  BEGIN と identity の読みの間の commit は DRIFT になる。BEGIN の前の commit は、nonpositive の query が
  cache を snapshot に揃える。postflight の identity が、registration の間に DB が動いたことを従来どおり検出する。
- 新しい送信先、保存範囲、契約、authority、schema、依存、閾値の値の変更は無い。秘密・データの流れは変わらない。

### owner／lifecycle の表（GDX-PRECHECK-001）

worker（subprocess）が停止を観測する時期を変えるので、変更の前に次を確かめた。新しい経路・handle・待ち・状態は足さない。

| 項目 | B1 の前後 |
| --- | --- |
| 入口・開始 | worker の起動時の registration（`bin/nir1-c-query-worker.rs:229`）だけ。変えない |
| 再試行・Suspended | owner が失敗を数え 5 回で Suspended にする扱いは変えない。drift の判定（postflight の identity）も変えない |
| 再入 | scope は thread-local で入れ子にでき、内側の scope は自分の pin を記録し、closure の終わり（unwind を含む）で外側の値に戻す |
| admission の閉鎖 | admission の上限・順序・課金の順は変えない（存在確認は課金の対象の外の読み） |
| 開始待ちの作業 | 足さない |
| 有効な handle の所有 | 足さない（新しい thread・接続・statement の保持は無い） |
| 取消 | 観測する時期が動く（「変わる点」の 3）。owner の条件は同じ typed の停止で終わる |
| 有限の待ち | 親の START_TIMEOUT 30 s、DEFERRED_RELEASE_LIMIT 10 s は変えない。registration の時間が縮むので、通る方向にだけ動く |
| 終了の証拠 | 変えない（worker の終了と ROLLBACK。scope は ROLLBACK の前に閉じる） |
| error／timeout／onClosed の所有 | 起動失敗の分類（`registration_error_stage`）の割合が動きうる（「変わる点」の 4） |
| 保存される再開の状態 | 無い（scope は保存されない） |

ユーザー確認が要る項目（新しい送信先・保存範囲・閾値の緩和・契約・authority）には当たらないので、NIR-1 の委任の範囲の技術判断として記録する。

### 呼び出しの内訳（健全な試験 fixture）

試験 `registration_answers_alike_and_reads_no_schema_table_under_the_shortcut` が、`nir1_pinned_snapshot` の
`table_exists` の呼び出しを表の名前ごとに数えた（試験専用の記録）。健全な fixture の registration 1 回で 12 回：

| 表 | 回数 |
| --- | --- |
| `narrative_dependency_declaration_sets` | 3 |
| `narrative_dependency_declaration_entries` | 3 |
| `narrative_dependency_declaration_heads` | 3 |
| `narrative_scope_registries` | 1 |
| `narrative_scene_scope_bindings` | 1 |
| `schema_data_migrations`（c2zc の marker） | 1 |

SQL の下では、この 12 回が `sqlite_master` の列の読み（`type` と `name`）で 24 回に数えられる
（authorizer は列ごとに 1 回呼ばれる）。「24 回」は存在確認 12 回の列の読みであり、存在確認が 24 回あったのではない。
当初の見積り（1 Revision あたり scene scope 2、declaration 3 × 2 か所、c2zc 1 = 9 回）と違い、declaration の 3 表は
3 回ずつ読まれた。1 Revision あたりの回数と、Revision の数への比例は、この fixture では分けて確かめていない（推定）。
`scene_scope_default.rs` の `narrative_scope_project_defaults` の確認は、この registration からは呼ばれなかった
（呼び出しの記録に無い）。comment は他の 3 か所と揃えた。

### steps の実測

dev 枝 `claude/dev-drift-window-prb1`（commit `e9b6b7b9`、local のみ。試験 `drift_window::semantic_steps::semantic_stage_steps`、
release、`nir1-material-diagnostics`）で、registration の Semantic 段 1 回（`is_complete_registered_with_scratch`）で
`CapacityBudget`（`SQL_PROGRESS_LIMIT` = 600,000,000）に課金された VM steps を測った。registration と同じ形
（BEGIN、dependency-edge の表の読み 1 回、`with_pinned_snapshot` の中で Semantic 段）で、SQL 版は `with_sql_checks` の下。
各 size 3 回で、steps は SQL 版・近道版ともに 3 回とも一致した（決定的）。全件で結果は `Ok(true)`。

| size | SQL 版の steps | 近道版の steps | 差 | 減少 | 上限（600M）に対する割合 SQL → 近道 |
| --- | ---: | ---: | ---: | ---: | --- |
| Q513/R3/D0 | 307,549 | 242,659 | 64,890 | 21.1% | 0.051% → 0.040% |
| Q2044/R4 | 1,465,381 | 1,381,026 | 84,355 | 5.8% | 0.244% → 0.230% |
| Q2044/R1022 | 22,695,326 | 2,795,601 | 19,899,725 | 87.7% | 3.78% → 0.47% |
| Q8176/R16 | 5,839,705 | 5,521,770 | 317,935 | 5.4% | 0.97% → 0.92% |
| D2064/report-heavy | 16,744,472 | 3,374,757 | 13,369,715 | 79.8% | 2.79% → 0.56% |

- R1022 の差は約 1,990 万 steps で、DR の見積り（約 2,000 万 steps、上限の約 3%）と合う。
- 測った 5 形（admission の上限に近い R1022、Q8176、D2064 を含む）では、SQL 版は 600M の 4% 未満（25 倍以上離れている）で、
  「変わる点」の 2（境目で Err から成功へ動く）には当たらない。
- 近道で減る steps Δ は、存在確認の回数と `sqlite_master` の行数で決まる。Revision 数は admission の上限（1,024）で止まるので、
  この schema（672 行）では R1022 の約 2,000 万 steps が目安になる（Revision あたりの回数が一定という推定つき。schema に余分な
  object がある DB では Δ は大きくなる）。境目で結果が動くのは、SQL 版の総 steps が 600M−Δ から 600M の間にある入力だけである。
  総 steps は admission が抑えない量（場面・binding・relation の数など）にもよるので、admission の内側にそういう入力が無いことは
  確かめていない。値（600M・180 s）は変えず、課金される作業を減らすだけなので、閾値の緩和には当たらないと判断した
  （CQ-OPT が C-query の上限について同じ形を受け入れた先例と同じ扱い）。
- 差は、Revision 数（R）が多い size（R1022、report-heavy）で大きい。R が少ない size（R3、R4、R16）は 5〜21% で、
  Semantic 段の steps の大半は存在確認の外にある。
- 経過時間（cadence-one の progress handler つき、参考値）：R1022 は約 2.6 s → 2.0 s、report-heavy は約 2.8 s → 2.4 s、
  他は同程度。窓 W（registration 全体）への効果は gate の最後の項。

### gate

- 試験：`nir1_graph/tests/registration_pinned.rs` の 8 件。
  - 結果・seal・失敗の種類・エラー文・stage が、`with_sql_checks` の下と近道の下で同じ（健全、Semantic 段の
    失敗 5 種。このうち近道が答える経路は 4 種で、declaration set の表の欠落は表を直接読む文が先に落ちるのでエラー文の確認だけ）。
  - owner の `check()` で止まる場合（349 点。健全な registration の `check()` の回数）が、SQL 版と同じ結果になる。
  - 状態の停止（progress callback の k 回目に stop を立てる）が、SQL 版と近道版の両方で同じ typed の停止で終わり、
    scope が漏れない（stage は違いうる）。callback の回数の差の間では、近道版が完了すること。
  - 近道の下では registration が `sqlite_master` を読まず（`sqlite_master` の列の読みが SQL の下 24 回（存在確認 12 回）→ 0 回）、owner callback が減る。
    worker の経路（authority の接続）でも同じ。
  - scope が registration の外へ漏れない（接続が自分の読み snapshot の中で `table_exists` に `None` を返すことで確かめる。
    probe が失敗しうることの対照つき）。
  - schema cache が古い状態から始まる場合（前提として cache が古いことを断言）と、identity の読みの後に別接続が DDL を
    commit した場合で、近道が SQL と同じ値を返す。
  - scope の中の文は transaction を終えない（authorizer）。
  - 既存の `table_presence_is_answered_from_the_schema_cache_only_inside_the_pinned_scopes`
    （旧名 `…only_inside_the_c_query`）が、範囲の外の読みが SQL のままであることを引き続き固定する。
- 検証：`cargo clippy -p grimodex-db --all-targets -- -D warnings`、`cargo test -p grimodex-db --lib`
  の `nir1_graph::`、`nir1_pinned_snapshot`、`nir1_entity_relation_index`、`nir1_graph_index_maintenance`、
  実 worker の `native_worker_registration_*`（ignored。`NIR1_C_QUERY_WORKER_BIN`）。結果は PR 本文に書く。
- 窓 W の対の測定（2026-11-10、dev、release、各 30 回、writer なし。前は DR-GRW-1 を載せた `88397983`〔負荷 3.37→1.41〕、
  後はそれに B1 の `nir1_graph.rs` を載せた `724452b1`〔負荷 2.11→1.09〕。2 つの枝の差は `nir1_graph.rs` だけ。
  記録は `drift-measure/drift-a2-pra2-summary.txt` と `drift-a2-prb1-summary.txt`。前の値は DR-GRW-1 の gate 4 の「後」〔2,704 ms〕を再現した）：

  | case | W p50 前 → 後 | W p95 前 → 後 |
  |---|---|---|
  | Q513／R3 | 75.6 → 72.3 ms（−4%） | 76.5 → 73.1 ms |
  | Q2044／R4 | 298.8 → 292.5 ms（−2%） | 301.4 → 297.5 ms |
  | Q2044／R1022 | 2,704.6 → 2,063.4 ms（−24%） | 2,719.0 → 2,073.1 ms |
  | Q8176／R16 | 1,205.7 → 1,182.4 ms（−2%） | 1,212.9 → 1,190.1 ms |
  | D2064／report-heavy | 3,008.1 → 2,587.6 ms（−14%） | 3,016.9 → 2,603.6 ms |

  縮むのは Revision の多い形（R1022、D2064）で、上の steps の減り（87.7%、79.8%）と向きが合う。R の少ない形は数 % で、
  W の主は存在確認の外（SourceIndex 段、Revision の中身の読み・検査）にある。

## DR-GRW-3 registration の revision ごとの 5 文を、1 回の読みの間だけ再利用する（P′）

2026-11-10 の 3 件目。基点は `origin/master` の `6cf81d9b`（DR-GRW-1、DR-GRW-2 を含む）、branch は
`claude/graph-registration-stmt-reuse`。冒頭の約束（結果・エラーの種類・停止の粒度などを変えない）のうち、この決定で動くのは次の 3 つ。
steps と owner callback の回数が減る点（「変わる点」の 1・2。通る方向）、停止を見つける時期（3）、
そして **Q の使用量が、保持する program の分だけ増える点（4。通らない方向〔成功から NOMEM〕に動きうる）**。
加えて、lookaside を使う in-process の呼び出しでは、revision の少ない形の実時間が数 % 延びうる（「変わる点」の 7）。
閾値の値・schema・契約・authority は変えない。

### 決定

`nir1_entity_relation_index.rs` の `read_eligibility_source_counted` の revision ごとの loop が、revision ごとに
`conn.prepare` していた次の 5 文を、その関数の frame に置いた holder（`RevisionStatements`。5 つの
`Option<Statement<'_>>`）で再利用する。

| 文 | 呼び出し元 |
| --- | --- |
| octet_length の文（入力の長さ） | `read_revision_input_stats` |
| JSON の数え文（entity／relation／evidence／anchor の数） | `read_revision_input_stats` |
| Entity の payload_root の文（`SOURCE_BASIS_ENTITY_PREFLIGHT_SQL`） | `preflight_revision_source_basis` |
| Relation の payload_root の文 | `preflight_revision_source_basis` |
| live lengths の文 | `preflight_live_source_lengths` |

- **prepare は初回の使用時に、今と同じ呼び出し位置で行う。** 先にまとめて prepare しない（最初のエラーの順と、
  最初の revision で prepare が失敗する形のエラー文・stage を変えないため）。
- 2 回目以降は、同じ文を bind し直して使う。5 文はすべて位置引数（`?N`）だけで、rusqlite の名前の cache
  （`ParamIndexCache`）は空のまま。`Statement::query_row` の `Rows` は drop で `sqlite3_reset` するので、成功・
  エラー・途中で `?` で抜ける、のどの経路でも次の使用の前に reset されている（rusqlite 0.40.1。`Rows::drop`）。
- **使うたびに（Ok でも Err でも）reset の後で `Statement::clear_bindings()` を呼ぶ**（独立レビューの P2-1）。rusqlite は
  `&str` を `SQLITE_TRANSIENT` で bind する（SQLite が写しを持ち、次の bind まで残す）。revision id の長さは
  6 MiB の入力上限でしか縛られず（worker の承認済みの revision でも約 0.9 MiB まで通りうる）、reset だけでは 5 文が
  直前の revision の id の写しを Q に持ち続け、次の revision の basis の山（w:600000 で 11.3 MB）と重なる。
  `clear_bindings` で、保持する性質を旧形（finalize）と同じ「program だけ」に戻した。実測（試験
  `held_statements_do_not_keep_the_values_of_the_last_revision`）：512 KiB の id の revision の後、保持中の 5 文の
  `MemUsed` は短い id のときと同じ 147,984 B。`clear_bindings` を外すと 2,771,224 B（512 KiB × 5 の写し）になって
  この試験が落ちる（一度外して確かめた）。
- 試験専用に、slot ごとに最初の使用の SQL を覚え、2 回目以降に違う SQL が来たら panic する（slot の取り違えの検出。P3-1）。
- holder は `read_eligibility_source_counted` のローカルで、return と unwind の両方で drop（finalize）する。
  loop の後の、source index の組み立て（`graph_source_from_roster*`）の**前**に明示的に drop し、
  SourceIndex・postflight・ROLLBACK・scratch の seal の前に必ず終わる。
- 5 文の呼び出し元は `read_eligibility_source_counted` だけ。この関数の入口は 4 つある（コードで確かめた）。
  1. worker の registration：`read_eligibility_source_with_control_and_scratch`（scratch scope あり）。
  2. `read_eligibility_source_with_control`（scratch なし、admission なし）。上流は
     `source_revision.rs:269-290`（`resolve_source_revision_with_control_and_reads` が Entity／Relation eligibility の
     Source の読みで呼ぶ。`conn.is_autocommit()` なら `unchecked_transaction` を張り、そうでなければ呼び出し側の
     transaction の中で読む）で、その上流は `resolve_source_revision_with_control` を呼ぶ
     `v2_apply_sources.rs:93`、`verify_coverage.rs:353`、`reconciliation_envelope.rs:607/657`、
     `resolve_source_revision_with_validation_context` 経由の `commit.rs:550/611`（Apply。コメントのとおり
     `BEGIN IMMEDIATE` の下）、`restore_rebuild.rs` の `resolve_current_source_state_with_control(_and_reads)`
     （583、1932。`source_revision.rs:433-445` で `resolve_source_revision_with_control_and_reads` に届くことを確かめた）。`incremental_freshness.rs:310` の `LifecycleGraphControl` と `commit.rs:122` の
     `StandaloneForegroundValidationControl` は、これらの経路に渡される control の実装である（呼び出し元ではない）。
     加えて `nir1_capacity_diagnostics.rs` の測定と `read_eligibility_source`（`#[allow(dead_code)]`）。
  3. B の build／publish：`read_eligibility_source_for_native_build`（admission あり）。
  4. diagnostics：`source_capacity_usage`（feature `nir1-material-diagnostics`）。
  すべて同じ holder を通る。**要件は `!conn.is_autocommit()`（transaction の中であること）だけで、read transaction とは
  限らない。foreground の write transaction（Apply の `BEGIN IMMEDIATE`）の中でも走る。** holder はその関数の中で作り、
  戻る前に drop するので、transaction の commit／rollback は常に holder の drop の後になる（write transaction の中で
  保持した statement が commit を妨げることは無い。reset 済みで `clear_bindings` 済み）。
  holder なしの経路は残さない（残すと同じ SQL を 2 つの形で持ち、oracle の形が製品に残る）。5 つの関数は holder を
  引数に取り、それぞれの単体試験は使い捨ての holder を渡す。
- **使わないもの**: rusqlite の `prepare_cached` と、接続の cache 容量の変更。cache の key（`Arc<str>`）と LRU の
  node は Rust の割当で、scratch scope の中で S に割り当てられて scope の後も残り、zero-live の seal を壊す。
  cache は接続全体の設定なので lane の外の利用者にも及ぶ。（なお authorizer の付け外しは cache を無効にするのではなく、
  `sqlite3_set_authorizer` が接続の statement を失効させ、次の step で再 prepare させる。P′ の holder も、読みの途中で
  authorizer を付け外しすれば再 prepare されて効果が消える〔結果は同じ〕。registration の読みの途中では付け外ししない。）
- 試験専用の seam `with_fresh_statements`（`#[cfg(test)]`、thread-local。DR-GRW-2 の `with_sql_checks` と同じ型）で、
  文ごとに prepare し、使い終わりに finalize する今の形に戻せる。製品の build には入らない。

### 理由

registration の窓 W は、大きい DB では revision ごとの prepare が支配的な成分の 1 つである
（`window-shortening-next-2026-11-10.md`。推測は R1022 で約 0.5〜0.65 s、D2064 で約 1.05〜1.25 s。実測は「W の対の測定」で、
worker と同じ lookaside 0 の条件で R1022 −0.78 s、D2064 −1.51 s）。SQL の text は revision によらず同じで、違うのは bind する値だけなので、
1 回の読みの間 compile 済みの program を持てば、prepare の費用は初回だけになる。
DR-GRW-1（SourceIndex の線形化）、DR-GRW-2（表の存在確認）と同じく、挙動を変えずに窓を縮める。

### DR-CQL-13 との関係

DR-CQL-13 は、Entity の文を finalize してから次の文を prepare する前提で、Entity の大きさの写しが同時に Q に
残らないことを数えていた（`entity_items` の MATERIALIZED）。reuse でも、reset で実行時の memory
（ephemeral 表、`Mem` の buffer、auxdata、値の写し）は解放されるので、その意図は保たれる
（`sqlite3VdbeReset`→`Halt`→`closeAllCursors`）。残るのは compile 済みの program、bind 値、SQL の写しだけで、
5 文で 0.13〜0.15 MB（`StatementStatus::MemUsed`。「memory」）。コメントの文言は「finalize」から「reset」に直した
（`SOURCE_BASIS_ENTITY_PREFLIGHT_SQL` の doc と `preflight_revision_source_basis` の注記）。

### 変わる点

1. **registration と B の build の VM steps と owner callback の回数が減る。** prepare は steps に課金される
   （SQLite 3.53 の `sqlite3ProgressCheck` の 4 か所。DR-GRW-2 の「変わる点」の 1 と同じ形）。reuse では revision 数 N に対して
   各文の prepare が N 回から 1 回になる。減る見込みだが、未測定である。試験の小さい fixture（4 revision）では owner callback の回数は両形で同じ（306 回）だった。
   理由は推測で、SQLite が progress callback を 1,000 steps ごとに呼び、Rust 側の check も呼ぶので、prepare の steps の差が
   この小さい入力では 1,000 に届かない、と考えている。steps の数値の前後比較はしていない（「gate」の 6）。大きい DB での実時間の差は「W の対の測定」に記録した。
2. **steps の上限の境目では、Err から成功へ、通る方向にだけ動く。** 課金される作業が減るだけで、
   増える経路は無い（DR-GRW-2 の「変わる点」の 2 と同じ）。この効果は、1 の入口のすべて（registration、B の build、
   Apply・Freshness・Verify・Restore の eligibility の読み。foreground の write transaction の中を含む）に及ぶ。
   実時間の期限（180 s など）の境目は、worker（lookaside 0）では通る方向だが、lookaside を使う in-process の入口では、
   revision の少ない形で実時間が数 % 延びうるので、失敗の方向にも動きうる（「変わる点」の 7）。
3. **停止を見つける時期が動きうる。** owner の `check()` は同じ位置・同じ回数で走る（試験で全 stop point の
   Outcome が一致）。SQLite の progress callback が数える steps が減るので、k 回目の callback の位置が変わる。
   終わりは同じ typed の停止で、seal は無く、handle は残らない。
4. **Q の使用量が増える。通らない方向にも動く。** 保持する 5 文の compile 済みの program の分で、`MemUsed` の合計
   約 0.13〜0.15 MB（試験の実測 128,984〜152,344 B）。reuse は読みの間ずっと program を持つので、Q の上限（16 MiB）の
   境目では、**成功から NOMEM の方向**に動きうる（旧形は文ごとに finalize して、持ち越さなかった）。worker の実 process の
   registration の Q 高水位は「memory」の表（最大 +0.48 ポイント）で、85% の条件に対する余裕を実測で確かめた。
   `clear_bindings` により、持ち越すのは program だけで、revision の id の長さには依存しない。
5. **worker の起動失敗の分類（`registration_error_stage`）の割合は、prepare 中の NOMEM／中断が減る分だけ動きうる。**
   これは worker の起動失敗の分類にだけ効く到達しない経路で、DR-GRW-2 の 4 と同じ扱い。
6. **親の START_TIMEOUT（30 s）に対しては、通る方向にだけ動く。**
7. **lookaside を使う in-process の呼び出しでは、revision の少ない形の実時間が数 % 延びうる。** 保持する program が
   接続の lookaside の枠（SQLite の既定）を占め、大きい revision の処理の小さい割当が通常の malloc に回ると考えている
   （推測。下の「W の対の測定」で、lookaside 0 にすると延びが消え、B1 側だけが lookaside 0 で遅くなることと合う）。
   worker は `SQLITE_CONFIG_LOOKASIDE 0,0` なので、worker の registration には当たらない。当たるのは in-process の入口
   （eligibility の読みの上流、B の build、diagnostics）で、測った形では R4 +2.5〜4.1%（+8〜12 ms）、R16 +2.7〜4.3%（+32〜51 ms）。
   結果・閾値・期限の値には関わらない（steps は減る方向）。

### 変わらない点

次は変えない（試験で固定）。

- registration と B の source read の結果（`Ok(roster, digest)`／Err）、seal、失敗の種類、エラー文、stage の更新順、
  owner の `check()` の位置と回数。
- 文・stage・admission の課金の順（CQ-LIM-2。`read_revision_input_stats` の B の component guard → A2 の admission、
  `capacity.input` の順）、最初のエラーの順。最初の revision で prepare が失敗する形は、同じ文で同じエラー文。
- 5 文の SQL、bind の値と順序、返す値と判定。`revision_is_approved`（例外経路だけで走る 6 つ目の文）は reuse の対象の外。
- 閾値の値（CapacityBudget の 600M steps・180 s、START_TIMEOUT 30 s、A2 の admission bytes、Q 16 MiB、85%）。
- B の build／publish／Verify／Rebuild の結果と admission の確認の位置。

### 信頼境界

- 呼び出し元は「決定」の 4 つの入口（worker の registration、eligibility の読みの上流〔Apply・Freshness・Verify・Restore。
  foreground の write transaction を含む〕、B の build、diagnostics）と試験で、renderer・main・MCP からは変わらない。
  どの入口も `!is_autocommit()` の transaction の中で、同じ接続・同じ thread で呼ぶ。
- holder は 1 回の読み（`read_eligibility_source_counted` の 1 呼び出し）の間だけ生き、その関数の frame に閉じる
  （thread をまたがない。`Send`／共有の経路は無い）。transaction の終わり（commit／ROLLBACK）と接続を閉じる前に、
  必ず drop される。
- 保持するのは compile 済みの program だけで、payload・envelope・live source の本文は reset で、直前の revision の
  bind 値（revision id、project id）は `clear_bindings` で、使うたびに解放される。
- 新しい送信先、保存範囲、契約、authority、schema、依存、閾値の値の変更は無い。秘密・データの流れは変わらない。

### owner／lifecycle の表（GDX-PRECHECK-001）

DR-GRW-2 の表の「statement の保持は無い」は、この決定で「関数の中で保持し、return と unwind で finalize する」に変わる。

| 項目 | P′ の前後 |
| --- | --- |
| 入口・開始 | worker の起動時の registration、B の build、Apply・Freshness・Verify・Restore の eligibility の読み、diagnostics。変えない |
| 再試行・Suspended | 変えない（失敗を数える owner の扱い、drift の判定も同じ） |
| 再入 | holder は呼び出しごとのローカルで、入れ子の読みは別の holder を持つ。共有しない |
| admission の閉鎖 | admission の上限・順序・課金の順は変えない。`ensure_current` の位置も同じ |
| 開始待ちの作業 | 足さない |
| 有効な handle の所有 | **足す。** 5 つの prepared statement を、`read_eligibility_source_counted` の frame の holder が持つ。作るのは最初の使用時、終わりは return・`?`・unwind の drop（finalize）。loop の後の SourceIndex・postflight・commit／ROLLBACK・seal の前に終わる（foreground の write transaction の中の呼び出しでも、その transaction の終わりの前）。thread・接続・他の handle は足さない |
| 取消 | owner の `check()` と progress callback で、これまでの typed の停止で終わる。停止を見つける時期が動く（「変わる点」の 3）。停止のとき statement は reset 済みか、使用中なら unwind／戻りの drop で finalize される |
| 有限の待ち | 親の START_TIMEOUT 30 s、DEFERRED_RELEASE_LIMIT 10 s は変えない |
| 終了の証拠 | 変えない（worker の終了と ROLLBACK。statement は ROLLBACK の前に finalize 済み。接続に残る statement が無いことは試験で数える） |
| error／timeout／onClosed の所有 | 起動失敗の分類は「変わる点」の 5。statement の finalize の結果は捨てる（rusqlite の `Statement` の drop の既存の扱い。`sqlite3_finalize` が返すのは直前の実行のエラーの再掲で、各使用のエラーは `query_row` が既に返している）。DR-GRW-2 までの `Connection::query_row` の statement と同じ扱いで、新しい失敗の経路は足さない |
| 保存される再開の状態 | 無い（holder は保存されない） |

### 試験（`nir1_graph/tests/registration_statements.rs`、`nir1_entity_relation.rs`）

- 同値性の oracle（`with_fresh_statements`）：健全な形、basis の不一致、live lengths が None、A2 の limit、
  6 MiB 超の component、不適格な候補（rejected、pending、rejected で 6 MiB 超、current revision の行が無い proposal）が
  混じる形、最初の revision で prepare が失敗する形（3 通り。件ごとに、壊した slot の前までの `prepares` と、各 slot を
  何回使ったか〔`attempts`〕を断言する。`input lengths` は、元の試験では roster の page の statement が先に落ちて loop に
  届いていなかったので、page が読まない `narrative_proposal_decisions` を壊す形に直した）、Semantic 段の失敗 5 種（declaration 表の欠落は loop の前で終わり holder が作られない、registry・binding・marker 行の欠落は 4 revision を読み終えた後に false で終わり〔prepare 1 回対 4 回〕、migration 表の欠落は最初の revision の marker の確認で終わる〔両形とも各文 1 回で、reuse は通らない〕）、capacity fixture の不適格 5 種（decisionless、rejected、
  source-drift、stale-freshness、scope-drift／report-missing-source）。結果・seal・失敗の種類・エラー文・stage・
  scope の閉じを比べる。
- 古い値を返し続ける回帰の検出（`a_reused_statement_answers_for_the_revision_in_front_of_it`）：3 番目の revision だけが、
  JSON の数え文（レコード数が上限超）、Relation の basis の文（Relation の basis 行だけ改ざん）、live lengths の文
  （payload と basis が同じ古い Source token を持つ）のどれか 1 つの答えだけ変わる形にし、5 文の答え（`stage_trace`）が
  両形で同じで、3 番目が期待どおり（`stats=None`、`basis=false`、`live=None`）、他の 3 つが健全であることを見る。
  行の無い candidate（`.optional()` の None）の後に健全な revision が続く形も同じ方法で見る。
- seam が素通りしていないこと（`alike`）：oracle 側の `MemUsed` が `[0;5]`、使用回数が両形で同じ、3 回以上使った slot では
  oracle の prepare が reuse より多い。
- DR-CQL-13 の性質（各文が次の文の前に reset されている）：owner の `check()` のたびに、Revision と basis の表を読む
  statement が `sqlite3_stmt_busy` でないことを、既定の CI で断言する（`read_with` の `LiveProbe`）。
- STAT4（`analyzed_statistics_change_no_answer`）：`ANALYZE` して `sqlite_stat4` を持つ DB（sqlite_stat4 の表は作られた）で
  registration は両形で同じ結果、`RePrepare` は 5 文とも 0、prepare は 1 回のまま。この fixture（等価条件の主キー・
  一意 index の検索だけ）では、bind の値で plan が変わらないので再 prepare は起きない。SQLite が `RePrepare` を起こす
  のは、stat4 を使う range 条件や LIKE／GLOB の parameter が値で plan を変える場合で、5 文の SQL には無い。起きれば
  効果（prepare の削減）が消えるだけで、結果は変わらない。
- prepare の回数：4 revision で、reuse は 5 文とも 1 回、oracle は 4 回。実行回数（`StatementStatus::Run`）は 4、SQLite の
  自動 re-prepare（`RePrepare`）は 0。13 候補の capacity fixture でも 1 回対 13 回。
- 停止の掃引：owner の `check()` の k 回目（最初の 100、stride、最後の 30）と、progress callback の k 回目で止めて、
  両方の形が同じ typed の停止で終わり、seal が無く、handle が残らない。
- handle の寿命：`sqlite3_next_stmt` で数えた statement が、成功・エラー・check／callback の停止・panic の unwind
  （check は最初の 100、13 ごと、最後の 30 の位置）の後で、読みの前と同じ。反証できる形として、counter が `prepare_cached` の残りを数えること、
  reuse の形が loop の途中で 5 つ多く持ち、oracle は多くないことも見る。
- 既存の `registration_reads_each_revision_in_the_scratch_scope_and_checks_outside_it` を、3 revision の fixture にして、
  prepare 時の authorizer だけでなく、実行時（progress callback で、実行中の statement を `sqlite3_next_stmt` と
  `sqlite3_stmt_busy` で列挙）に、大きい document に触れる statement が scope の中で走っていることと、再利用された
  statement が最後の revision でも scope の中で走ることを見る形に強めた。

### 試験の限界（正直な記録）

- progress callback の回数は、試験の fixture（4 revision）では両形で同じ（306 回）だったので、停止の掃引の
  「両者の回数の間の k」の分岐は走っていない（回数が違う大きい fixture では走る作りだが、確かめていない）。
- prepare の回数と `RePrepare` の断言は、ordinary reader の registration と IDX の直接呼び、B の build で行った。
  worker reader（`register_with_worker_maintenance`）の経路では、結果が緑であること（lifecycle の B2・B4 など）だけを見ている。
- heap の試験は debug build の in-process で、process 全体の SQLite heap の差であり、worker の Q の区間ごとの high water ではない。

### memory

- 5 文の `StatementStatus::MemUsed` の合計：seed の fixture と payload 形（counted 600,000 B、A2 2,034,277 B）の
  どちらでも、`clear_bindings` を入れた後は `[13,984, 30,208, 41,440, 31,048, 31,304]`、合計 147,984 B（0.15 MB。
  入れる前は 152,344 B）。4 revision の registration の後は 128,984 B。payload の大きさにも、revision の id の長さにも
  依存しない（program は SQL で決まる）。
- SQLite の heap の high water（in-process の代理。`SQLITE_STATUS_MEMORY_USED`、step ごとに reset。payload 形の同じ revision
  を 3 回読む。試験 `the_sqlite_heap_peak_of_each_step_rises_by_no_more_than_the_held_programs`。counter が process 全体なので
  `#[ignore]` にして `--test-threads=1` で単独に実行する）：各 step の peak の上昇は、oracle（文ごとに prepare）対 reuse で
  最大 +0.10 MB（input stats +0.01〜0.09 MB、basis +0.04〜0.08 MB、live +0.08〜0.10 MB）。preflight（basis）の peak は
  process 全体の heap で 18,385,120 B（oracle）→ 18,469,096 B（reuse、+83,976 B）。差は保持する 4〜5 文の program の分で、
  step が組んだものではない（この値は `clear_bindings` を入れる前の測定。入れた後に再測はしていない）。
- **Q の high water（実測。worker の実 process の registration、READY までの全域、release、各形 2 回で bytes が一致）。**
  計測は dev 枝 `claude/dev-q-hw-measure`（計測 instrumentation の commit `a39315b9`。製品の commit は載せていない）。
  Q は 16 MiB（16,777,216 B）。前は DR-GRW-3 の前（`6cf81d9b` 相当）、後は `clear_bindings` を入れた最終の commit
  （`5d5bc0fa` の cherry-pick `5055ab40`）。

  | 形 | 前（B／%） | 後（B／%） | 増加 |
  | --- | --- | --- | --- |
  | payload 形 w:400000 | 8,464,300（50.45%） | 8,505,899（50.70%） | +41,599 B（+0.25 ポイント） |
  | payload 形 w:600000 | 11,680,284（69.62%） | 11,721,883（69.87%） | +41,599 B（+0.25 ポイント） |
  | B4（payload 形 3 件） | 11,680,646（69.62%） | 11,760,840（70.10%） | +80,194 B（+0.48 ポイント） |
  | 製品形の上限近傍 p:682000 | 7,058,189（42.07%） | 7,139,466（42.55%） | +81,277 B（+0.48 ポイント） |

  - 最大は 70.10%（B4）で、条件（85% 以下）に対して 14.9 ポイントの余裕がある。READY の `available` は 15,019,232 B
    （p:682000 は 15,019,104 B）。
  - 前の値は DR-CQL-14 の表（w:600000 で 67.4%＝11,309,614 B）より一律に約 +370 KB 高い。DR-CQL-14 以降（10-18 以降）の
    master の変更による READY 時の常駐分の増加で、P′ とは無関係（P′ の前の commit で測った値）。
  - 増加は 41.6〜81.3 KB で、`MemUsed` の合計（約 0.13〜0.15 MB）より小さい。worker では Q に載るのは SQLite の割当のうち
    registration の間に同時に生きているものだけで、program の一部は peak の時点で別の文の memory と重ならない、または
    lookaside（worker では 0）でなく通常の割当で数えられるため、と考える（未確認）。
  - `clear_bindings` を入れる前の commit（`4615b442`）での値は、w:400000 8,506,229、w:600000 11,722,213、B4 11,761,264、
    p:682000 7,139,841 B で、入れた後は 330〜424 B だけ減った。実測の revision の id は短いので、この差は小さい。
    id が長い revision（512 KiB）では、入れない場合に保持が 2.6 MB 増える（試験で確認）ので、`clear_bindings` は
    長い id に対する上限の保証である。
- **in-process の heap の差の位置づけ**：上の in-process の +0.10 MB は、process 全体の heap の差を debug build で
  測ったもので、lookaside が効く区間を含む。worker は lookaside が 0 なので、worker の値は上の実測を正とする。
  in-process の値は、保持が program 数十〜百数十 KB の規模に収まることの確認に使うだけで、Q の予測には使わない。

### W の対の測定（2026-11-10〜11、dev、A2 の harness、release、各 30 回、writer なし）

前は DR-GRW-2 の測定の「後」と同じ `724452b1`（B1 の測定枝）、後はそれに P′ の製品 2 ファイル（`5d5bc0fa` の
`nir1_entity_relation_index.rs`、`nir1_entity_relation.rs` と同一）だけを載せた `d7d7432f`。harness は in-process で、
既定では SQLite の lookaside が効く。3 列目は、測定の試験の冒頭で SQLite を一度 shutdown し、process 全体を
`SQLITE_CONFIG_LOOKASIDE 0,0`（worker と同じ）にした run（切り替えは dev の `f58d3936`／`2d2fd68f`。製品コードは同じ）。
記録は `fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/` の `drift-a2-prb1b`／`drift-a2-prp`（1 回目）、
`drift-a2-prp2`／`drift-a2-prb1c`（逆順）、`drift-a2-prb1-nolook`／`drift-a2-prp-nolook2`（lookaside 0）。開始時の負荷は 1.4〜3.2。

| case | W p50 前 → 後（1 回目） | 逆順（後を先に） | lookaside 0（worker と同じ） |
|---|---|---|---|
| Q513／R3 | 73.1 → 74.8 ms（+2.2%） | 73.7 → 74.2 ms（+0.6%） | 77.3 → 74.3 ms（−3.9%） |
| Q2044／R4 | 295.3 → 307.5 ms（+4.1%） | 297.1 → 304.6 ms（+2.5%） | 311.4 → 305.8 ms（−1.8%） |
| Q2044／R1022 | 2,063.5 → 1,468.3 ms（**−28.8%**） | 2,092.3 → 1,455.0 ms（−30.5%） | 2,273.8 → 1,494.8 ms（**−34.3%**） |
| Q8176／R16 | 1,192.7 → 1,243.6 ms（+4.3%） | 1,202.5 → 1,234.7 ms（+2.7%） | 1,265.0 → 1,238.3 ms（−2.1%） |
| D2064／report-heavy | 2,596.6 → 1,240.5 ms（**−52.2%**） | 2,600.3 → 1,229.3 ms（−52.7%） | 2,776.8 → 1,263.3 ms（**−54.5%**） |

- 結果はすべて `ok_true`（両形とも）。`Q2044／byte-heavy` は前後とも登録前に `err_other` で終わる形（入力上限）で、W を持たない。
- p95 は p50 と同じ向き（例：D2064 2,604.6 → 1,244.8 ms、R1022 2,077.6 → 1,476.2 ms）。
- 縮みは推測（R1022 −0.5〜−0.65 s、D2064 −1.05〜−1.25 s）より大きい。prepare に加えて、文ごとの finalize と
  authorizer の呼び出し（harness は観測用の authorizer を付けている）の回数も減るためと考える（未分解）。
- revision の少ない形（R3、R4、R16）は、lookaside が効く条件では数 % 遅く、順を逆にしても残る。lookaside 0 では
  5 形とも後が速い（R1022・D2064 以外は −1.8〜−3.9%）。P′ の値は lookaside の有無でほぼ同じで、B1 だけが lookaside 0 で
  遅くなる（「変わる点」の 7）。製品の registration は worker（lookaside 0）で走るので、R1022 と D2064 は大きく縮み、
  revision の少ない形は差なし〜数 % 減と見る（lookaside 0 の対は各 1 回で、system malloc の in-process の代理。実 worker の W ではない）。
- lookaside 0 の対は各 1 回で、B1 側の run は負荷 3.18 で始まった。

### gate

1. 同値性の oracle：上の試験（`registration_statements::`）。既定で 16 件（+ ignore の heap 1 件）、capacity fixture の 1 件は feature `nir1-material-diagnostics` が要る。`cargo test -p grimodex-db --lib` 全件：2,624 passed、0 failed、55 ignored。
2. 停止の掃引：同上。
3. handle の寿命：同上。
4. 既存の試験の強化：`nir1_entity_relation::tests::registration_reads_each_revision_in_the_scratch_scope_and_checks_outside_it`。
5. memory：release の worker binary（`heavy.sh cargo build --locked --release … --bin nir1-c-query-worker`）に対し、
   `scripts/nir1-c-query-worker-ci.sh lifecycle`（26 case。fixture の builder、Q2／Q512 の preseed、case ごとの
   test process を含む）を実行し、26 case すべてが緑（exit 0）。registration と memory に関わる case は
   `native_worker_uses_a_payload_shaped_revision_near_the_preflight_limit`（B2。scratch の zero-live seal を含む）、
   `native_worker_registers_multiple_payload_shaped_revisions`（B4）、
   `cq_avail::native_worker_registers_multiple_product_shaped_revisions`（4 revision）、
   `native_worker_registration_does_not_load_a_revision_over_the_preflight_limit`、
   `native_worker_registration_refuses_a_payload_shaped_revision_before_it_runs_out_of_memory`、
   `native_worker_uses_a_candidate_*`、`native_worker_refuses_the_whole_graph_*`、
   `native_worker_returns_canonical_512_a3_eligible_registry33_seed_local_graph`。
   （最終の commit でも lifecycle 26 case が緑。）
   B4 の `query after READY: NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME` は DR-CQL-13 の再測と同じ typed の期限で、
   test は緑（B4 は registration を試験する）。
6. steps：数値の前後比較はしていない。prepare の steps が revision ごとから初回だけになる向き（減る方向だけ）は、
   SQLite 3.53 の `sqlite3ProgressCheck` の位置から独立レビューで確かめた。owner の `check()` の位置と回数は試験で同じ。
7. W の対の測定（下の節）。
8. DR：この文書。owner／lifecycle の表を上のとおり書き直した。

### やらないこと（別の決定）

- 文字どおりの P（worker の allocator のモデルを変える、本体の接続の cache 容量を変える）。
- b-2（DR-CQL-13 を戻す）、b-3（admission が動きうる）、a-2（registration 専用の共有読み。DR-GRW-4）、b-1。
- `revision_is_approved` の文の再利用（例外経路だけ）。

## DR-GRW-4 registration の project 単位の読み 3 群を、1 回の読みの間だけ lazy に覚える（a-2）

2026-11-11 の 4 件目。基点は `origin/master` の `8a7f4ceb`（DR-GRW-1〜3 を含む）、branch は
`claude/graph-registration-shared-reads`。設計の正本は
`fusion-eval-data/design-notes/db-connection-2026-11-07/window-shortening-a2-2026-11-11.md`（read-only で起案。事実と推測を分けて書いたもの）。
冒頭の約束（結果・エラーの種類・停止の粒度などを変えない）のうち、この決定で動くのは次の 5 つ。
steps と progress callback の回数が減る点（「変わる点」の 1。通る方向）、
**今は起動上限（START_TIMEOUT 30 s、capacity の 180 s）を超える形が通るようになる点（2・3）**、
S の peak が最大で memo 1 個分上がりうる点（4。通らない方向）、停止を見つける時期（5）、
revision の少ない形で W が 2〜3% 延びる点（6。実時間の期限の境目は失敗の方向にも動きうる）。
閾値の値・schema・契約・authority・admission は変えない。

### 決定

`nir1_entity_relation_index.rs` の `read_eligibility_source_counted` の revision ごとの loop の 3 つ目の `in_scratch`
（A2 の typed reader `read_nir1_entity_relation_revision_current_for_graph_index`）が、revision ごとに読み直している
**revision・scene・proposal を bind しない project 単位の読み**を、その関数のローカルの memo で 1 回に減らす。
範囲は **Graph reader の registration だけ**。鍵は `SourceCapacity::registration_a2_limit.is_some()`
（worker の registration と、in-process の `Nir1GraphReader::register_with_control` の両方が `nir1_graph.rs` の 1 か所から渡す）。

共有する 3 群は、互いに独立した lazy な cell（`OnceCell`）に置く。

| 群 | 文 | 今の呼び出し位置（revision あたり） |
| --- | --- | --- |
| scope authority | SAVEPOINT／projects の存在／tree_nodes 全件／registry（2 文）／scene bindings／RELEASE の 7 文（`load_live_project_scope_authority_with_scene_bindings`。bind は project_id と定数の名前だけ） | `validate_live_sources` の None 枝。1 回 |
| epoch | 最新の Semantic Epoch（`read_current_epoch`。bind は project_id だけ） | `typed_run_matches_current_epoch` が 2 回、`read_typed_canonical_freshness` が 1 回。計 3 回 |
| c2zc の marker | `read_c2zc_cutover_marker`（`schema_data_migrations` の 1 行。bind は定数だけ） | `read_typed_canonical_freshness`。1 回 |

- **読みは今と同じ呼び出し位置で、最初に使う時にする。先読みはしない。** 手前で unavailable になる revision
  （revision-not-current など）では、今も memo でも何も読まない。最初のエラーの順と位置は動かない。
- **覚えるのは Ok だけ。Err は覚えず、次の revision でも今と同じく読み直す。** scope authority の Err は、停止以外は
  `source-revision-changed` に丸められてその revision だけが skip される（次の revision は進む）ので、Err を覚えると
  一過性の失敗（SQLITE_INTERRUPT、Q の NOMEM）の 1 回が後続の全 revision の skip に化ける。Ok(None)（epoch が無い）は値として覚える
  （結果は `revision-restore-invalidated` で決定的）。停止（`is_validation_terminated`）は覚えずにそのまま返す。
- memo は `read_eligibility_source_counted` のローカル（`RegistrationProjectReads`。3 つの `OnceCell` と project の `&str`）。
  中身は scratch scope の中（3 つ目の `in_scratch`）で作り、**作った後は伸ばさない**（`OnceCell::set` は move だけ。S の buffer は
  scope の外では realloc できない）。`LiveScope` は memo に持たず、revision ごとに `Cow::Borrowed` で作る（C-query の Some 枝と同じ。
  `anchor_tokens` は今と同じく revision ごとに scope の中で作られて消える）。
- memo は loop の後の `drop(statements)` と同じ位置で drop する。SourceIndex の組み立て・postflight・ROLLBACK・scratch の seal の前で、
  return と unwind でも関数を抜けるときに drop される（scope の外での dealloc は可。`scratch_live` は減る）。
- typed reader の内部は、`shared: Option<&Nir1ProjectReads>` を 3 値の enum `ProjectReadSource`
  （`Unshared`／`Query(&Nir1ProjectReads)`／`Registration(&RegistrationProjectReads)`）に替える。`From<Option<&Nir1ProjectReads>>` で
  None→`Unshared`、Some→`Query` に写し、`Query` の枝は今の Some のコードのまま。そのため C-query、D-final、Apply、Freshness、
  Verify、Restore、B の build、diagnostics など他の caller は、型の上で今と同じ枝を通る。`Registration` を作れるのは新しい入口
  （`read_nir1_entity_relation_revision_current_for_graph_index` に足す引数）だけで、試験の caller は None を渡す。
- 試験専用の seam `with_unshared_project_reads`（`#[cfg(test)]`、thread-local。DR-GRW-3 の `with_fresh_statements` と同じ型）で、memo を作らず
  typed reader に `Unshared` を渡す形に戻せる。`Unshared` の枝は他の caller のために製品に残る変更前の経路そのもの
  （revision ごとに scope を 1 回、epoch を 3 回、marker を 1 回読む）なので、oracle が変更前の形と一致することはコードの同一性で保証される。

### 理由

registration の窓 W は、場面の多い project では revision ごとの project 単位の読みが支配する。消える作業は「場面数 × revision 数」に
比例し、registration の経路には場面数を縛る admission が無い。**測定の事実**（2026-11-11、dev、release、
`drift-measure/a2-scenes-2026-11-11/summary.txt`）：今のコード（`8a7f4ceb`）では、実時間が約 34 µs × 場面数 × revision 数で、
R1022＋1,000 場面の worker は READY まで 38.5 s かかり START_TIMEOUT（30 s）を超える。R1022＋2,000 場面では index の build が
180 s の capacity deadline で落ちる。R4 では 20,000 場面でも W は約 3.1 s。この形の fixture での縮みの上限は R1022 で約 0.26 s、
D2064 で約 0.21 s（場面が少ない形の見込み。場面の多い project ではこれより大きく効く）。

### 変わる点

1. **registration の VM steps と progress callback の回数が減る。** 共有する 3 群（revision あたり scope の 7 文＋3＋1 文と、それぞれの
   prepare）の分が、2 回目以降の revision で消える。**Rust の owner check（`check_graph_work`、`check_active_work`）は回数も位置も変わらない**
   （共有する読みの中に `check_active_work` は無い。`project_scope_authority.rs`、`scene_scope.rs`、`semantic_epoch.rs`、`migrate.rs` の marker の読みで確認）。
   観測点の無い区間のうち、scope の load の中の Rust の処理（derive、検証、digest）も消える。revision 1 の区間は今と同じで、
   観測の無い最長の区間は延びない。
2. **steps の境目は、通る方向にだけ動く。** 課金される作業が減るだけで、増える経路は無い。
   実時間の期限（START_TIMEOUT 30 s、180 s など）の境目は、revision の多い形や場面の多い形では通る方向に大きく動く（3）。
   一方で revision の少ない形では W が数 % 延びるので、失敗の方向にも動きうる（6）。
3. **今は起動上限を超える形が通るようになる。** 場面数 × revision 数がおよそ 80 万〜170 万の帯（R1022＋1,000 場面の 102 万を含む）は、
   index は build できるが、今は worker の起動（registration）が START_TIMEOUT（30 s）を超える。a-2 では、**場面数が約 4,800 未満の場合**
   （S の枯渇の上限。「memory」）に通る**見込み**である。帯全体は測っていない。測ったのは R1022＋1,000 場面の 1 形で、worker の READY までの wall が
   38.4 s から 1.3 s になった（前は START_TIMEOUT 30 s を超え、後は 1.3 s。「W の対の測定」）。
   **B の build は変えない**（「変わらない点」）ので、R1022＋2,000 場面（204 万）で index の build が 180 s の capacity deadline で落ちる形は、a-2 でも変わらない。
   **閾値の値（600M steps、180 s、30 s、A2 bytes、Q 16 MiB、85%）は変えない。** この扱い（通る範囲が広がること）は
   2026-11-11 にユーザーが確認した（「進める」）。
4. **S の peak が、最大で memo 1 個分上がりうる（通らない方向）。** 今は authority が revision の bundle・material と同時に生き、load の瞬間に
   一時領域（tree の Vec、binding の生の行、digest 用の `Vec<Value>`、bindings の clone）が重なる。memo は一時領域を持たないが、
   authority が envelope の parse の段（今は authority が生きていない段）とも重なる。設計上の上界は「新しい peak − 今の peak ≤ memo の大きさ」だが、
   **これは allocator（worker の Talc）の断片化を数えていない**ので、保証ではなく設計上の見込みである。実測（「memory」）では S の高水位は
   増えず、むしろわずかに減った（R4＋S4500 で 72.5% → 71.6%、R1022＋1,000 場面で 16.3% → 15.3%）。上限（allocated 約 51 MB）は変わらない。
   S には承認済みの合格条件が無い（Q の 85% に当たる線が無い）ので、測った値は今と並べて報告し、線は置かない。
5. **停止を見つける時期が動きうる。** owner の `check()` は同じ位置・同じ回数で走る（試験で全 stop point の結果が一致）。SQLite の
   progress callback の k 回目の位置は、steps が減るので変わる。終わりは同じ typed の停止で、seal は無く、handle は残らない。
   memo で消えるのは、2 回目以降の読みでだけ起こりうる非決定的な失敗（SQLITE_INTERRUPT、Q の NOMEM）で、停止は直後の観測点で捕まる。
   **非決定的な失敗が起きたときは、結果も動く。** 例えば Q の NOMEM が revision k（k > 1）の scope の load で起きると、今はその revision が
   `source-revision-changed` で skip され registration は `Ok(false)` になるが、memo では k 回目の load が無いので `Ok(true)` になる。
6. **revision の少ない形では、W が 2〜3% 延びる（失敗の方向にも動きうる）。** 測定（dev、lookaside 0、各 30 回、ABBA の 2 run）で、Q513/R3 が +2.0／+2.2%、
   R4 が +2.1／+3.1%、R16 が +2.1／+2.9%（+1.5〜35 ms）。worker と同じ lookaside 0 でも、2 つの順序でも再現した（lookaside ありでも +1.8〜2.4%）。
   **原因は未確認**（memo の確保・参照の固定費、または code layout の差と推測する）。steps は R4 で 1,380,660 → 1,379,552 とほぼ同じで、増えた形は無い。
   実時間の期限（180 s など）の境目は、こうした形では失敗の方向にも動きうる（DR-GRW-3 の「変わる点」の 4・7 と同じ書き方）。
   測った revision の少ない形の worker の起動は、場面 4,500 でも約 1 s で、START_TIMEOUT（30 s）からは遠い。steps の境目は通る方向にだけ動く（2）。

### 変わらない点

次は変えない（試験で固定）。

- **決定的な入力では**、registration の source read の結果（`Ok(roster, digest)`／Err）、seal、失敗の種類、エラー文、stage の更新順、owner の `check()` の位置と回数。
  非決定的な失敗（SQLITE_INTERRUPT、Q の NOMEM）が 2 回目以降の読みで起きる場合は、「変わる点」の 5 のとおり結果が動きうる。
- **他の入口（Apply・Freshness・Verify・Restore・B の build／publish・diagnostics、C-query などの typed reader の他の caller）の挙動**
  （steps、callback の回数、読みの回数、エラー、`nir1_capacity_diagnostics.rs` の記録済みの測定）。広げるなら別の DR で、
  それぞれの試験と測定を見たうえで決める。**例外は feature 付きの diagnostics の `register_with_control`
  （`nir1_graph_memory_diagnostics.rs:455`）**で、registration を呼ぶので memo を通り、その registration の elapsed と steps は動く
  （DR-GRW-2 の「反転の根拠」と同じ。diagnostics の記録済みの値は取り直しが要る）。
- 共有しない読み：run の `semantic_epoch_id`（2 回／revision。run_id を bind する）、publisher Run の検証、revision row、Decision、
  payload／envelope、codex entry／relation、POV、freshness row・edges・declaration・digest（すべて revision／entity／edge に固有）。
  `pending::read` の cursor と head は project 単位だが、5 か所の他の caller（Chronicle は steps で停止を観測する）に及ぶので外す（a-2b として別の決定）。
- 3 群の SQL、bind の値と順序、返す値と判定。`LiveScope` の作り方（revision ごと）。admission の上限・順序・課金の順・`ensure_current` の位置。
- SAVEPOINT／RELEASE の目的（autocommit の caller に 1 つの snapshot を与える）は、最初の読みが今と同じ関数を呼ぶので変わらない
  （typed reader は autocommit を拒否するので、registration では入れ子になるだけで意味を持たない）。
- 閾値の値、schema、契約、authority、依存。

### 信頼境界

- 呼び出し元は registration（worker と in-process の `register_with_control`）と試験だけで、renderer・main・MCP からの経路は変わらない。
  どちらも `!is_autocommit()` の transaction（`BEGIN DEFERRED`、`with_pinned_snapshot` の中）で、同じ接続・同じ thread。
- **snapshot の中で不変**：memo の寿命は `read_eligibility_source_counted` の 1 回の呼び出しに閉じる。その間に同じ接続に書く経路は無い
  （typed reader の経路は SAVEPOINT／RELEASE 以外は読みだけ。owner と progress の callback は SQL を実行しない。B の
  `GraphReadAdmission::ensure_current` は接続の source revision を読むだけ）。他の接続の書込みは、最初の読みで固定された WAL snapshot には見えない。
  worker の接続は `query_only=ON`。
- 保持するのは 1 回の読みの間の memory だけで、保存しない。新しい送信先、保存範囲、契約、authority、schema、依存、閾値の値の変更は無い。
  秘密・データの流れは変わらない。

### owner／lifecycle の表（GDX-PRECHECK-001）

| 項目 | 前後 |
| --- | --- |
| 入口・開始 | worker の起動時の registration と、in-process の `register_with_control`。他の入口は変えない（`registration_a2_limit` が None の入口は `Unshared`） |
| 再試行・Suspended | 変えない |
| 再入 | memo は呼び出しごとのローカルで、入れ子の読みは別の memo を持つ（共有しない） |
| admission の閉鎖 | 上限・順序・課金の順・`ensure_current` の位置は変えない。memo は何も拒まない |
| 開始待ちの作業 | 足さない |
| 有効な handle の所有 | 足さない。memo は SQLite の handle を持たず、Rust の値（authority、bindings、epoch、bool）だけを持つ。作るのは最初の使用時（scratch scope の中）、終わりは loop の後の drop・`?`・unwind（seal の前） |
| 取消 | owner の `check()` と progress callback は、これまでの typed の停止で終わる。停止を見つける時期だけが動く（「変わる点」の 5）。停止の Err は覚えない |
| 有限の待ち | 親の START_TIMEOUT 30 s、DEFERRED_RELEASE_LIMIT 10 s は変えない（通る範囲が広がる。「変わる点」の 3） |
| 終了の証拠 | 変えない（worker の終了、ROLLBACK、zero-live の seal。memo は ROLLBACK と seal の前に drop 済み） |
| error／timeout／onClosed の所有 | 実行時に到達する新しい失敗の経路は足さない。Err は覚えず、今と同じ経路で伝わる。足したのは `NIR1_ENTITY_RELATION_REGISTRATION_READS_MISMATCH` だけで、memo が別の project の読みに使われていないことを確かめる**到達しない防御の検査**（`read_eligibility_source_counted` は memo を自分の `project` で作って同じ `project` を渡すので、製品の経路では起きない。起きても typed の Err になるだけで、値は変えない） |
| 保存される再開の状態 | 無い（memo は保存されない） |

### 試験（`nir1_graph/tests/registration_shared_reads.rs`、既存の関連試験）

oracle は `with_unshared_project_reads`。型（`Outcome`／`Run`／`register`／`alike`）は `registration_statements.rs` のものに倣い、同じ fixture の helper
（`multi_fixture`、`scan_order`、`add_decided`、`execute`、`live_statements`、`OVER_6_MIB_PAD`）を `pub(super)` にして流用した。新しい試験は 18 件
（既定 16 件、feature `nir1-material-diagnostics` が要る 1 件、実 worker の binary が要る `#[ignore]` の 1 件）。

1. 同値性（結果・seal・失敗の種類・エラー文・stage・scope の閉じ・owner の check の回数・Rust 側の `check_active_work` の回数・statement の残りが一致し、
   registration の source read が返す roster と digest が一致し〔結果が `Ok(false)` で終わる形では roster と digest が結果に出ないので、`alike` の中で
   `read_eligibility_source_with_control_and_scratch(.., Some(REGISTRATION_A2_LIMIT))` を両形で呼んで比べる〕、memo の callback が oracle を超えず、memo の読みが oracle の読みを超えない）：
   - 健全な 4 revision。読みの回数は、memo で AuthorityTree・ScopeExtension・RegistryFull・RegistryRow・C2zcMarker が各 1、CurrentEpoch が 1。
     oracle で各 4、CurrentEpoch が 12（`shared_reads_are_made_once_and_the_oracle_makes_them_per_revision`）。
   - 3 番目の revision が壊れた 4 形：basis の不一致、A2 の上限超（`NIR1_GRAPH_REGISTRATION_REVISION_INPUT_LIMIT`）、6 MiB 超の component、
     live lengths が None（`registration_answers_alike_for_each_shape_of_revision`）。
   - 不適格の混在（rejected、pending、6 MiB 超の rejected。`..._ineligible_revisions_are_mixed_in`）。
   - 最初の revision が epoch の読みの手前で unavailable になる形（proposal の status を rejected にする。意図は typed reader の `revision-not-human-approved` だが、typed reader に届いたのか手前の step で skip されたのかは、読みの回数だけでは区別できない）。
     memo は AuthorityTree と CurrentEpoch を各 1 回（最初の読みは 2 番目の revision）、oracle は 3 回と 9 回、C2zcMarker は 3 回
     （`..._first_revision_ends_before_the_first_shared_read`）。
   - Semantic 段の失敗 5 種（`registration_semantic_failures_answer_alike`）。
2. 読みの回数の範囲（`only_the_registration_shares_its_reads`）：`registration_a2_limit` が None の入口（`read_eligibility_source_with_control`、
   B の `prepare_graph_index_build`、`..._with_scratch` の None）は、memo の seam があってもなくても N のまま（AuthorityTree 等が 4、CurrentEpoch が 12）。
   limit が Some の入口だけが 1 になる。
3. Err を覚えない：
   - 決定的な Err（registry の行を全部消す／registry の表を改名する）は、両形で結果が同じで、AuthorityTree が両形とも N（4）。
     場面の多い project でも同じ（N＝5）。
   - 一過性の Err（authorizer で、scratch scope の中で最初に準備される `tree_nodes` の読みを 1 回だけ拒む）：revision 1 が skip されて結果は両形で同じ（`Ok(false)`）。
     memo の AuthorityTree は 2（失敗した 1 回と、成功して覚えた 1 回）、oracle は 4。
   - epoch の Err（`narrative_semantic_epochs` の読みを 1 回拒む。`a_failure_of_the_epoch_read_ends_both_forms_alike_at_its_first_read`）は、両形で同じ Err、同じ stage（SemanticIndex）。
     Err で registration 全体が終わるので「覚えない」ことそのものは見えない。固定するのは、`CurrentEpoch` の probe が両形とも 1（先読みも読み直しも無い）であること。
4. 停止：owner の `check()` の k 回目（最初の 100、13 ごと、最後の 30。計 1,153 check の健全な registration）は両形の結果が一致。
   progress callback の k 回目（最初の 40、7 ごと）は両形とも typed の停止で終わり seal が無く statement が残らない（memo と oracle の回数の間の k は、
   oracle だけが止まり memo は完了する）。状態による停止を、最初の scope の load の文を準備する瞬間に raise する形（`a_stop_in_the_first_scope_load_ends_typed_in_both_forms`）。
5. scope の閉じ（`the_shared_reads_are_made_inside_the_scratch_scope`）：authorizer で、tree・epoch・marker・scene bindings の読みの scope の外の回数が両形で等しいこと
   （`tree_nodes` は 0）、scope の中の回数が memo で 1 回分、oracle でその読みの回数（probe の AuthorityTree・CurrentEpoch・C2zcMarker・ScopeExtension）倍であることを確かめる。
   **これは既存の `registration_reads_each_revision_in_the_scratch_scope_and_checks_outside_it` の強化ではなく、新しい試験である**（既存の試験は DR-GRW-3 の
   強化のまま変えていない。その試験の `read_nir1_entity_relation_revision_current_for_graph_index` の呼び出しには `None` を足しただけ）。
6. 場面数の多い fixture（既定は 100 場面と anchor を散らした 6 revision。環境変数 `GRW_SCENES` で広げられる。場面と scope binding の両方を足す）：
   結果が同じで、各共有読みが 1 回（oracle は revision 数）、memo の callback が oracle より少ない。owner の check と callback の stride の停止、
   anchor の場面が消えた形、seal の一致も通す。
7. capacity fixture（feature 付き。Q513/R3/D10 と D2064/report-heavy）：registration の入口（limit が Some）の source read が、memo と oracle で同じ結果になる。
   読みは memo で各 1 以下、oracle は Q513 で AuthorityTree 9・CurrentEpoch 23、D2064 で 4・12。
8. 実 worker（`#[ignore]`。`native_worker_registers_a_project_of_many_bound_scenes`）：1,000 の bound 場面と 13 revision（anchor を散らす）の project で、worker の registration が
   READY に届く（zero-live の seal が通る）。**`scripts/nir1-c-query-worker-ci.sh lifecycle` には足していない。** 足すと、Full admission が script の sizing source digest を
   pin しているので `ci-pause.test.mjs` の「Reviewed Full workload data …」が落ちる（一度足して確かめ、戻した）。digest と reviewed workload data の更新は別の決定にする。
   release の worker binary に対して手で走らせる：`NIR1_C_QUERY_WORKER_BIN=src-tauri/target/release/nir1-c-query-worker cargo test --release -p grimodex-db --lib narrative_extraction::nir1_graph::tests::registration_shared_reads::native_worker_registers_a_project_of_many_bound_scenes -- --ignored --exact --nocapture --test-threads=1`
9. 他の caller の回帰：既存の試験群を全件で走らせる（gate の 2）。`cq_avail` の `project_level_reads_are_made_once_and_charged_as_made` は、
   probe の `C2zcMarker` を数える位置を `Unshared` と registration だけにして（Query の枝は数えない）、期待値を変えずに通す。

### 試験の限界

- progress callback の k 回目は、memo と oracle で回数が違うので揃えて比べられない（結果の種類だけを比べる）。4 revision の fixture では
  memo 304 回、oracle 306 回（差 2 回）で、「両者の回数の間の k」の分岐は走るが 1 点だけ。場面の多い fixture（100 場面、7 revision）では差が大きい
  （この試験は `shared.callbacks < unshared.callbacks` を断言する）。
- 場面の多い fixture の既定は 100 場面で、START_TIMEOUT・180 s の境目の移動そのもの（場面数 × revision 数が約 80 万〜170 万の帯）は試験では見ない。
  `GRW_SCENES`、`GRW_WORKER_SCENES` で広げて手元で走らせられるが、既定の gate には入れていない。境目の移動は dev の測定（W の対の測定）で見る。
- S の高水位は、試験（in-process の heap）では測れない。実 worker の試験（1,000 場面、13 revision の READY）は、zero-live の seal が通ることを見るだけで、
  S の高水位の値は出さない。値は dev の測定で得た（「memory」。dev 専用で PR に含めない）。
- 一過性の Err の試験は、authorizer で最初の `tree_nodes` の準備を拒む形（scratch scope の中で最初に準備される読み）で、SQLITE_INTERRUPT や NOMEM
  そのものを起こしてはいない。「Err を覚えない」は読みの回数（失敗した 1 回と成功した 1 回）と結果の一致で固定している。
- 最初の scope の load の文の実行中に止まる形は、authorizer による raise（文の準備の瞬間）で近似している。progress callback が文の途中の
  VM step で止める形は、k の掃引（最初の 40 点と 7 ごと）が含む。
- 「Epoch の不一致」（新しい epoch を足す）は、Semantic 段で registration が loop の前に終わるので、memo の読みを通らず、同値性の試験には入れていない。

### memory

- memo の大きさは live の場面数で決まる（場面ごとの mapping、binding、registry）。epoch は String 3 つ、c2zc は bool。
  1 場面あたり 1〜3 KB は**推測**（未測定）。測定の事実は、今のコードで場面あたり約 10 KB の S を使うこと（`summary.txt`。revision 数にほぼ依存しない）。
- **既知の制限（この DR の範囲外）：今のコードでも、約 4,800 場面で worker が S の枯渇で abort する。** revision が 1 個でも起き、計測なしの製品 worker
  （`8a7f4ceb`）で S5000 で再現した。原因は、場面あたり約 10 KB の S を使うこと。これは a-2 の後に別 lane で扱う（2026-11-11、ユーザー決定）。
  測定の材料は `drift-measure/a2-scenes-2026-11-11/summary.txt`。
- **S と Q の高水位の測定（事実。dev、release、Linux、実 worker で READY まで、各形 2 回で同値）。** 前は `32a9090a`、後は `e15f4aba`。2 つの差は、
  製品 4 ファイル（`nir1_entity_relation.rs`、`nir1_entity_relation/project_reads.rs`、`nir1_entity_relation_index.rs`、`nir1_capacity.rs`）が
  `aea3e728` と同じ版であること（と test 専用の呼び出し側の 1 行）だけ。材料は
  `fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/a2-after-2026-11-11/summary.txt`。
  - **Q は、すべての形で前後が同値**（最大は B4 の 11,760,840 B、70.1%。85% の条件の内）。後で前回 READY の形が abort したものは無い。
  - **S は増えない。** R4＋S4500：72.5% → 71.6%（48,633,347 → 48,043,728 B）、R1022＋1,000 場面：16.3% → 15.3%（10,943,176 → 10,256,314 B）。
    p（1 revision）の形、w:600000、b4 は同値。
  - **S の上限（allocated 約 51 MB）は変わらない。** R4＋S4750 は前が abort（S の alloc 失敗）で、後が READY（S 75.3%）。R4＋S5000 は前後とも abort（失敗時の S は約 51.02 MB で同じ）。
    つまり R4 で上限に届く場面数が 4,500〜4,750 から 4,750〜5,000 に動いただけで、約 4,800 場面の制限は残る（別 lane）。
  - S が減る理由（R4 の形だけ）は未調査。revision ごとの statement の再 prepare が減ったためと推測する。
  - 「変わる点」の 4 の増分（memo 1 個分、断片化を含む）は、測った形では現れなかった。測っていない形（R1022＋2,000 場面は前の build が不可、p4）の増分は未確認。

### W の対の測定

dev の A2 の harness（`a2-scenes-harness.patch`。dev 専用で PR に含めない）による前後の測定（2026-11-11、release、Linux、各 run の前に他の重い処理なし）。
前は `32a9090a`、後は `e15f4aba`。差は製品 4 ファイルが `aea3e728` と同じ版であることだけ（「memory」）。材料は
`fusion-eval-data/design-notes/db-connection-2026-11-07/drift-measure/a2-after-2026-11-11/summary.txt`。以下は事実で、原因の推測は別に書く。

**Semantic 段の steps**（registration 1 回、pinned-snapshot、rep 間で同一）：

| 形 | 前 steps | 後 steps | 増減 |
| --- | --- | --- | --- |
| R4 | 1,380,660 | 1,379,552 | -0.08% |
| R1022 | 2,671,039 | 2,307,523 | -13.6% |
| R1022＋1,000 場面 | 92,607,039 | 2,395,523 | -97.4% |

増えた形は無い（R4＋S の各形も 15〜42% 減った）。場面 × revision の項は消え、場面あたり 88 steps が 1 回だけ残る
（R1022＋1,000 場面 − R1022 ＝ 88,000）。600M に対する割合は R1022＋1,000 場面で 15.43% → 0.40%。

**W（registration 全段、in-process、writer なし、各 30 回、全 attempt が ok_true。lookaside 0、ABBA の 2 run）の p50（ms）：**

| 形 | 前（2 run） | 後（2 run） | 差 |
| --- | --- | --- | --- |
| Q513/R3 | 73.5／73.0 | 75.0／74.6 | +2.0／+2.2% |
| R4 | 302.6／300.1 | 309.1／309.5 | +2.1／+3.1% |
| R1022 | 1,475.7／1,464.3 | 1,215.3／1,217.7 | -17.6／-16.8% |
| R16 | 1,223.6／1,215.2 | 1,249.1／1,250.3 | +2.1／+2.9% |
| D2064 | 1,244.3／1,237.3 | 1,029.9／1,033.3 | -17.2／-16.5% |

lookaside ありでも同じ向き（R1022 -18.3%、D2064 -17.0%、小さい形 +1.8〜2.4%）。

**R1022＋1,000 場面**（lookaside 0）：in-process の W p50 は 34,206 → 1,259 ms（-96.3%）。worker の wall（実 process、READY まで）は 38.4 s → 1.3 s
（前は START_TIMEOUT 30 s を超え、後は 1.3 s）。index の build は不変（約 460 s。registration ではない）。

**推測・未確認：** revision の少ない形（Q513・R4・R16）の +2〜3% は、2 つの順序、lookaside あり・なしのいずれでも再現した（p95 の幅約 1〜2% より大きい）。
原因は未確認で、memo の固定費か code layout と推測する（「変わる点」の 6）。R16 と D2064 の steps は測っていない。
worker の係数 37 µs×S×R の外挿は後は成り立たない（新しい外挿は取っていない）。

### gate

結果は 2026-11-11（基点 `8a7f4ceb` に本 PR の commit を載せたもの）。

1. 同値性・Err の非保存・読みの回数・停止の掃引・scope の閉じ・場面数の多い fixture：新しい試験（`registration_shared_reads::`）。既定で 16 件が通る。
   feature `nir1-material-diagnostics` 付きで 17 件（capacity fixture の 1 件が増える）。実 worker の 1 件は `#[ignore]`（3 を見よ）。
2. 既存の試験：`cargo test -p grimodex-db --lib` 全件で **2,640 passed、0 failed、56 ignored**（DR-GRW-3 の記録は 2,624 passed、55 ignored。増えた 16 件は新しい既定の試験、
   ignored の 1 件は実 worker の試験）。関連の群（`registration_`、`cq_avail`、`cq_opt`、`oracle_tests`、`nir1_graph_index_maintenance`、`project_read`、`freshness_share`、
   `query_context_reuse`、`nir1_entity_relation::`）：242 passed、0 failed、11 ignored。feature 付きの `registration_`：57 passed、0 failed、5 ignored。
   `cargo clippy -p grimodex-db --all-targets -- -D warnings`：通る。
   レビューの指摘（roster と digest の比較、`check_active_work` の counter、scope の中外の回数、epoch の試験の名前）を直した後の HEAD でも、同じ件数で通った
   （全件 2,640 passed・0 failed・56 ignored、feature 付き 57 passed・5 ignored、clippy 通過、実 worker の `#[ignore]` の試験は READY で 1 passed、
   `scripts/nir1-c-query-worker-ci.sh lifecycle` は master と同じ 26 case 緑）。
   （初回の全件で、`cq_avail::project_level_reads_are_made_once_and_charged_as_made` が、probe の `C2zcMarker` を Query の枝でも数えたために落ちた。数える位置を
   `Unshared` と registration だけにして直し、期待値は変えていない。）
3. worker の実 process：`heavy.sh cargo build --locked --release … --bin nir1-c-query-worker` の後に `bash scripts/nir1-c-query-worker-ci.sh lifecycle`：
   26 case すべてが緑（DR-GRW-3 と同じ case。新しい実 worker の試験を 1 case として足した 27 case の版で走らせ、全件が緑。その後に script の変更だけを戻した〔「試験」の 8〕）。
   新しい `native_worker_registers_a_project_of_many_bound_scenes` は 1,000 場面・13 revision で READY（zero-live の seal が通る。3.65 s）。その後の seed の query は
   disclosure の record 上限で refuse された。READY が検証の対象。この試験は lifecycle の外で、手で走らせる。
4. steps：dev の前後比較（実施済み。「W の対の測定」）。R4 -0.08%、R1022 -13.6%、R1022＋1,000 場面 -97.4%、増えた形は無い。共有読みの中に Rust の `check` が無いことは
   コードで確認し、owner の `check()` の回数と位置、Rust 側の `check_active_work` の回数（`cfg(test)` の専用の counter。progress callback と混ざらない）は、
   試験で両形が一致する（健全な 4 revision の registration の 1,153 check を、k ごとに掃引）。
5. memory：dev で S・Q の高水位を前後で測った（実施済み。「memory」）。Q は全形で前後同値、S は増えない。S に合否の線は置かない。
6. W の対の測定：実施済み（「W の対の測定」）。R1022 -17%、D2064 -17%、R1022＋1,000 場面 38.4 s → 1.3 s。revision の少ない形は +2〜3%（「変わる点」の 6）。
7. `fnm exec --using=22 pnpm -s verify:quality`：通る（node の試験 587 pass・0 fail・1 skip、vitest 853 pass、narrative writers ok）。
8. DR：この文書。

### やらないこと（別の決定）

- 他の入口（Apply・Freshness・Verify・Restore・B の build・diagnostics）への拡大。
- `pending::read` の cursor と head の共有（a-2b）。
- `is_complete_registered_with_control_unmetered` の k=0 の epoch を memo の初期値に使うこと（loop の中の最初の読みが消え、「同じ呼び出し位置で読む」から外れる。得は 1 文だけ）。
- run の `semantic_epoch_id` の共有（run_id を key にすれば共有できるが、今回はしない）。
- 場面数の admission の追加（今通る入力を拒むので確認が要る。採らない）。S の枯渇（約 4,800 場面）の解消（別 lane）。
- 実 worker の試験を `scripts/nir1-c-query-worker-ci.sh lifecycle` に足すこと（Full admission の sizing source digest と reviewed workload data の更新が要る。別の決定）。
- memo が一定の大きさを超えたら保持しない上限（結果を変えず何も拒まないので委任内だが、gate で S の余裕が足りないと分かった場合の対処として残す。今は入れない）。
