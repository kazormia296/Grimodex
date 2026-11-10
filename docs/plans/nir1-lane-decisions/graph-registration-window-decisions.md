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
