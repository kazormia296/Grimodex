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
