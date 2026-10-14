# CP-1 decisions（NQG2 frame、全件の typed projection、worker の中での pin join）

- base：worktree `claude-nir1-cp1`、branch `claude/nir1-cp1`、HEAD `0e041537`（CR-1＋CR-1b。未 merge）。この文書を書いた時点でコードは変更していない。
- 委任：U3。計画 `610-pr-c-query-nir-valiant-thunder.md` の Wave 2、CP-1 行（:249）。設計の正本候補は DSN（`claude/nir1-contracts` の未 commit の `docs/plans/nir1-dsn-2026-10.md`）の §2（274-355）と、§8 の D-07〜D-09（681-683）。仕様は scene-connection 候補（この worktree の `docs/plans/nir1-c-scene-connection-candidate.md`）の §1（14-36）、§2（38-54）、§5（133-160）、§6（162-181）。
- 資源契約：proposal/6 の2行（`graph-limited-binding` と `nir1-defensive-resource-limits`）は確認済み。
  - 記録：integrator の `scratchpad/confirmations/K1.md`（受領 2026-10-12T23:58+0900、draft SHA-256 `5528f4e091ca087c0f1e071039c6bcede9d3d7cde1422ac1bfd852ee1d8d6b4b`）。
  - この SHA-256 が `git show ba7ceb46:docs/plans/nir1-l6-l9-contract-proposal-6-draft.md | sha256sum` と一致することは確かめた。ユーザーの発言そのものは見ていないので、確認の事実は integrator の記録に依拠する。
- 行番号は HEAD `0e041537` のもの。略記は次のとおり。
  - `graph.rs` = `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph.rs`
  - `frame.rs`、`scenes.rs`、`cqw.rs`（c_query_worker.rs）、`candidates.rs`、`tests.rs`、`oracle.rs`（oracle_tests.rs）、`memory.rs` = 同じ `nir1_graph/` の下
  - `bin` = `src-tauri/crates/grimodex-db/src/bin/nir1-c-query-worker.rs`、`core` = `src-tauri/crates/grimodex-core/src/narrative_nir1.rs`、`migrate.rs` = `src-tauri/crates/grimodex-db/src/migrate.rs`
  - `p6` = proposal/6 の draft（ba7ceb46）、`cand` = scene-connection 候補、`DSN` = 上記の DSN

## 0. 停止条件（HOLD）の判定

| 条件 | 判定 | 根拠 |
|---|---|---|
| 閾値や上限の変更が要る | 該当しない | 固定値（512、16×32、100,000 steps、100 ms、wait 0、2hop／12／144／8、`FRAME_BYTES`）はすべて据え置く。pin の行・page・bytes・steps・期限は、固定値の共有の残りの中で数える（§5.1）。新しく足す上限は frame の Scene 節の bytes の1つだけで、確認済みの `nir1-defensive-resource-limits`（p6:139-176）の規則で選ぶ（§5.3）。pin 件数の独立した定数は置かない（§5.4）。N_F は既定の 8（DSN D-08）で、逸脱案（N_F>8）は採らない |
| schema の変更が要る | 該当しない | 使うのは既存の `idx_scene_codex_pins_entry`（migrate.rs:1654）と、`tree_nodes`（migrate.rs:530）と `narrative_scene_scope_bindings`（migrate.rs:4094）の PK だけ。事前計測で、使う SQL はすべて SEARCH になった（§5.2） |
| 委任外の6項目 | 該当しない | 新しい送信先はない（既存の worker→parent の pipe。NQG1 も Entity の label と Evidence の quote を運んでいる）。保存はしない。閾値は緩めない。製品公開はない（A-1。`#[napi]` と IPC は足さない）。認可は削除しない。新しい authority もない（pin は locator のまま扱う。資格判定は parent の CB-4／CP-3a が行い、frame は parent が検査するまで信用しない） |

結論：HOLD には当たらない。§11 に、既定のまま進められる確認事項を挙げる。

## 1. 採る設計（DSN §2.1：worker の中で join）

すべて `query_in_snapshot`（graph.rs:1616-1988）の中で行う。次の3つは既存の Graph と共有する。

- 同じ snapshot：`BEGIN DEFERRED`（graph.rs:892）から `finish_read` の ROLLBACK（graph.rs:955）まで。終わった後の `ReadIdentity` の照合（graph.rs:956-1009）が pin の読取も覆う。
- 同じ予算：`QueryUsage`（graph.rs:1421-1484）を1つだけ使う。
- 同じ実行制御：`CapacityBudget`（100,000 steps と 100 ms。graph.rs:854、880-938）と、1,000 steps ごとの progress hook、Rust の境界の `control.check`。

手順：

1. BFS（graph.rs:1662-1934）と、`ordered_nodes`／`ordered_edges` の組立て（1942-1950）は変えない。
2. 到達 Entity の順位を付ける（SQL なし）。`ordered_nodes` のうち hop≥1 のもの（最大 11 件）について、`ordered_edges` から最小 path を求め、tuple の前半（hop、path の edge ID 列、Entity ID）で順位を付ける（§6）。
3. pin を列挙する。順位の順に、Entity ごとに `idx_scene_codex_pins_entry` を keyset で読む（1 page 16 行、rowid の昇順）。Scene ごとに、最初に現れた Entity（順位が最小）を代表にする。seed（hop 0）の pin は読まない。
4. 完了を確かめてから並べる。全 Entity の列挙が予算の内側で終わったら、(順位, Scene ID) の昇順に並べ、先頭 N_F=8 件（core:32 の `MAX_GRAPH_SCENES`）を選ぶ。`scene_total` は相異なる Scene の数とする。
5. 先頭 8 件についてだけ token を読む。
   - `tree_nodes` の `version` と `updated_at`（token は `v{version}@{updated_at}`）。
   - A1 binding の `scene_incarnation_id` と `source_token`（行がなければ None）。
   - `content`（本文）は読まない。`read_scene_source_bounded`（scenes.rs:343-448）は worker から呼ばない。
6. 応答の Graph に `scene_total` と `scenes` を足し、NQG2 で返す。
   - 2〜5 のどこかで資源が尽きたら、Graph 全体を unavailable にする。reason は `query-worker-work-scene-limit…`、区分は `limit`（§7）。部分的な結果は返さない。

関数の置き場所（予定）：

- graph.rs
  - `rank_reached_entities`（手順 2）と `join_scene_pins`（手順 3〜5。`&mut QueryUsage` と `&mut dyn GraphWorkControl` を受け取る）。
  - 型 `Nir1GraphSceneAssociation` を足し、`Nir1QualifiedGraph`（graph.rs:228-235）に `scene_total` と `scenes` を足す。
- scenes.rs
  - `read_scene_pin_page_with_admission` を新設する。candidates.rs:81-128 の `read_candidate_page_with_admission` と同じ形にし、既存の `read_scene_pin_page`（214-282）はその薄い wrapper にする。
  - has-more の probe `scene_pins_remain`、先頭 8 件の token を読む `read_scene_frame_tokens`、`pin_page_scratch_bytes`。
- frame.rs：NQG2 の encode と validate、typed projection、reason の allowlist（§3、§4、§7）。

## 2. 代替案との比較（D-07）

| 観点 | A：worker の中で join（採用） | B：parent 側で join（DSN §2.4） |
|---|---|---|
| snapshot | path と pin が同じ read transaction に入る。終わった後の identity の照合も1回で済む | path は worker の snapshot、pin は parent の snapshot になる。post-B §4.2（別 transaction の検証結果を未検証のまま結合しない）を守るには、path の資格を parent で全件読み直す必要があり、C-query の分離が意味を失う |
| 予算 | 既存の QueryUsage（512 行、16×32、6 MiB、100,000 steps、100 ms）の内側。事前計測では pin 1 件あたり約 60 steps で、496 件でも約 3.2 万 steps（§5.2） | parent の read に、新しい上限（K1b）と、新しい ReadIdentity の bracket が要る |
| 100 ms の lease | admission→lease の内側に入る | lease の外になる。lease を保持したまま読めば child の reap が遅れる。drop した後なら snapshot がない |
| 接続の競合 | worker 専用の read-only 接続だけを使う | parent の DB mutex を Raw と取り合う。現在の `CQueryWorkerOwner` は query 用の DB 接続を持たない（cqw.rs:610-）ので、接続の取り回しも新たに要る |
| C-resource の証跡 | worker と frame が変わる。最終 head で lifecycle と opt-in の lane を再 dispatch する（どちらの案でも CP-1 は再 dispatch する。計画:249） | worker は変わらない |
| process 境界を越えるデータ | pin の metadata（ID、token、rowid、created_at）。本文は含まない。NQG1 も label と quote を運んでいる | なし |
| 実装量 | frame の版上げ、全件の投影、scenes.rs の配線 | parent の reader、予算、identity の照合を新設する |

ほかに検討した案：

- B の build 時に pin の adjacency を持つ案：cand §1（:23）と §10（:303）が禁じる「永続 adjacency」にあたるので採らない。
- worker は到達 Entity だけを返し、parent が pin を読む案：B の一種で、欠点も同じ。
- PM の mark や mention cache から引く案：cand §1 の表で不採用になっている。

結論は A。scene-connection 候補 §5 の「同じ owner、同じ snapshot、同じ予算」（cand:142、148-150）に合う。

### 2.1 advisor の結論（integrator 経由で受領。2026-10-13）

結論は A（worker の中で join）。D-07 の確度を「中」から「高」に上げる。根拠の要約：

1. snapshot：`BEGIN DEFERRED`（graph.rs:892）から ROLLBACK（:955）までの1つの read transaction と、終了後の `ReadIdentity` の照合（:956-1009）と registration-drift の判定が、path と pin を同じ identity で覆う。B では path の資格（A2／A3 の 9 token）を parent で読み直すことになり、cand §5 で未診断の別接続 identity parity に Graph 全体の整合を預ける。A では parity の問題は CB-4 が採用する最大 8 件の再検証にだけ残る。
2. 予算：pin の行・page・bytes は既存の QueryUsage と CapacityBudget の内側に入る（cand §5「同じ予算へ account し、追加の Scene 接続予算を外付けしない」）。B は K1b の新しい上限と fail-safe を parent に要する。
3. 100 ms の lease：A は admission→lease の内側で完結し、DSN §1 の owner thread 設計に合う。
4. C-resource の証跡：どちらの案でも最終 head で lane を再 dispatch するので、B の利点は実質ない。
5. Raw の接続との競合：A の worker は専用の read-only 接続だけを使い、parent の DB mutex を取らない。
6. process 境界を越えるデータ：pin の metadata だけ。本文は載せない（`read_scene_source_bounded` は worker から呼ばず、CB-4 専用に項目単位の expect を付ける）。新しい送信先・保存・authority はない。
7. all-or-nothing：1つの予算と1か所の失敗面で強制できる。

A の代償（どちらも記録済み）：(a) pin の多い Entity で 512 行／32 page の共有予算が尽きやすい（§5.6。S2／CP-2a で率を測る）。(b) parent の validate が Scene 節を検証する分の作業（N_F=8 と `MAX_SCENE_SECTION_BYTES` で有界）。

## 3. NQG2 の layout（確定版）

整数はすべて little-endian。`text` は `u32` の長さに UTF-8 の bytes が続く。`optional<text>` は先頭 1 byte が 0（None）か 1（Some）で、Some なら text が続く。NQG1 の部分の符号化（frame.rs:15-166）は変えない。

```text
magic           [u8;4]  "NQG2"            "NQG1" は NIR1_GRAPH_FRAME_VERSION、それ以外は NIR1_GRAPH_FRAME_MAGIC で拒否
status          u8      1=available / 0=unavailable（ほかの値は拒否）
project         text
query_scene     text
available:
  scope_revision  text    空でない
  generation      i64     > 0（今は parent の cqw.rs:1869-1873 で見ている。validate に移す）
  seed            text    空でない
  node_count      u16     ≤ 12（MAX_GRAPH_NODES）
  edge_count      u16     ≤ 144（MAX_GRAPH_EDGES）
  nodes[node_count]       NQG1 と同じ
  edges[edge_count]       NQG1 と同じ
  scene_total     u16     ≤ 512（MAX_GRAPH_RECORDS）。診断専用
  scene_count     u16     = min(scene_total, 8)
  scenes[scene_count]:    tuple の狭義昇順
    scene_id              text            空でない
    scene_incarnation     optional<text>  Some なら空でない
    scene_source_token    text            空でない（tree_nodes の "v{version}@{updated_at}"。本文ではない）
    scene_scope_token     optional<text>  Some なら "sha256:" と小文字 hex 64 桁（DDL の CHECK、migrate.rs:4089-4092 と同じ）
                                          scene_incarnation と Some／None が一致すること
    pin_rowid             i64             > 0
    pin_entry_id          text            path の終点であり、hop が path_hop の node であること
    pin_created_at        text
    path_hop              u8              1..=2
    path_edge_count       u8              = path_hop
    path_edge_index       u16 × path_edge_count   各値 < edge_count
unavailable:
  reason          text    allowlist の値だけ（§7）
（末尾に余りがないこと）
```

その後、wire 上では `NQGC1`（frame.rs:13）が続く。これは変えない（D-09）。

validate（`pub fn validate(bytes) -> Result<FrameView>`）の規則：

- 全体を1回で走査し、heap の allocation をしない（Vec、String、Box、format! を使わない）。node の開始 offset `[u32; 12]` と edge の開始 offset `[u32; 144]` を stack の表に記録し、path の検査と投影の random access に使う。
- 長さの上限 `bytes.len() ≤ FRAME_BYTES`（frame.rs:420）と、末尾に余りがないこと（frame.rs:474）は今のまま保つ。
- Scene 節について次を検査する。
  - Scene 節の長さ（scene_total から最後の scene まで）が `MAX_SCENE_SECTION_BYTES`（§5.3）以下であること。
  - path がつながっていること。1本目の edge は seed から辿れる。2本目の edge は1本目の到達先から辿れる。終点は `pin_entry_id`。
    - 「辿れる」は BFS と同じ規則にする（graph.rs:1843-1846、1873-1877）。`from == u` なら到達先は `to`、`symmetric` で `to == u` なら到達先は `from`。
  - 途中の到達先が hop=1 の node であること。
  - scene の並びが tuple（§6）の狭義昇順であること。隣り合う2件だけを比べればよく、狭義なので Scene ID の重複も同時に排除できる。
  - `scene_count = min(scene_total, 8)` であること。
- 違反は `NIR1_GRAPH_FRAME_*` で拒否する。`NIR1_GRAPH_FRAME_SCENE_PATH`、`…_SCENE_ORDER`、`…_SCENE_COUNT`、`…_SCENE_LIMIT`、`…_SCENE_TOKEN`、`…_REASON`、`…_VERSION` を新設する。

encode（`pub fn encode(&Nir1GraphResponse) -> Result<Vec<u8>>`。signature は変えないので、bin:383 は変更不要）：

- 既存の `Writer`（frame.rs:15-46）の `FRAME_BYTES` 検査を保つ。
- Scene 節は、書く前に長さを checked arithmetic で計算し、`MAX_SCENE_SECTION_BYTES` を超えたら拒否する。
- unavailable の reason も allowlist で検査し、外れていれば拒否する。worker の内部の文言が frame に漏れないようにするため。
- 長さの計算は `scene_association_bytes(...)` に一本化し、worker の事前検査（§5.3）も同じ関数を使う。

## 4. typed projection の API（「先頭だけ」の公開をやめる）

`FrameView` の `first_node`（frame.rs:254-265）と、`NodeView::first_binding` と `EntityView::first_evidence`（224-253）を削除する。代わりに、全件を辿れる typed な投影を置く。

- 投影は `validate` だけが作る。field は private にし、検査していない bytes から作れないようにする。
- 各 iterator は、検査済みの bytes を同じ規則で読み直し、`Result` で返す。失敗は起きないはずだが、起きた場合も panic せずに閉じる側へ倒す。

```rust
// frame.rs（pub）
pub fn validate(bytes: &[u8]) -> Result<FrameView<'_>>;
pub struct FrameView<'a> { /* project, query_scene, outcome */ }
impl<'a> FrameView<'a> {
    pub fn project(&self) -> &'a str;
    pub fn query_scene(&self) -> &'a str;
    pub fn outcome(&self) -> &FrameOutcome<'a>;
    pub fn graph(&self) -> Option<&GraphView<'a>>;
    pub fn unavailable_reason(&self) -> Option<UnavailableReason>;
}
pub enum FrameOutcome<'a> { Available(GraphView<'a>), Unavailable(UnavailableReason) }

impl<'a> GraphView<'a> {                      // bytes、section の offset、node と edge の offset 表を持つ
    pub fn scope_revision(&self) -> &'a str;
    pub fn generation(&self) -> i64;          // > 0 は validate が保証する
    pub fn seed(&self) -> &'a str;
    pub fn node_count(&self) -> usize;  pub fn nodes(&self) -> Nodes<'a>;   // Item = Result<NodeView<'a>>
    pub fn edge_count(&self) -> usize;  pub fn edges(&self) -> Edges<'a>;   // Item = Result<EdgeView<'a>>
    pub fn edge(&self, index: usize) -> Result<EdgeView<'a>>;               // O(1)。path の解決に使う
    pub fn scene_count(&self) -> usize; pub fn scenes(&self) -> Scenes<'a>; // Item = Result<SceneView<'a>>。tuple の昇順
    pub fn diagnostic_scene_total(&self) -> usize; // 診断専用。資格判定、順位、採否に使わない（DSN §2.2）
    pub fn scene_path(&self, scene: &SceneView<'a>) -> Result<ScenePath<'a>>; // traversal 順の edge と向き
}
pub struct NodeView<'a>   { pub entity: EntityView<'a>, pub hop: u8, /* bindings */ }    // bindings()、binding_count()
pub struct EntityView<'a> { pub id: &'a str, pub kind: &'a str, pub label: &'a str, pub source: &'a str,
                            pub scope: ScopeBindingView<'a>, /* evidence */ }               // evidence()、evidence_count()
pub struct ScopeBindingView<'a> { pub reading: ScopeView<'a>, pub story: ScopeView<'a>, pub auto: ScopeView<'a>,
                                  pub phase: &'a str, pub reveal: &'a str, pub pov: Option<&'a str>,
                                  pub authority_revision: &'a str }
pub struct EdgeView<'a>     { pub relation: RelationView<'a>, pub from: EntityView<'a>, pub to: EntityView<'a>,
                              pub binding: BindingView<'a> }
pub struct RelationView<'a> { pub edge_id: &'a str, pub from_entity_id: &'a str, pub to_entity_id: &'a str,
                              pub relation_type: &'a str, pub directionality: Directionality,
                              pub source_token: &'a str, /* evidence_ids */ }               // evidence_ids()
pub struct BindingView<'a>  { /* 9 token すべて: revision_id, decision_id, decision_token, freshness_token,
                                 scope_authority_revision, query_scene_source_token, query_scene_scope_token,
                                 query_scene_incarnation_id, reveal_state_token */ }
pub struct SceneView<'a> { pub scene_id: &'a str, pub scene_incarnation_id: Option<&'a str>,
                           pub scene_source_token: &'a str, pub scene_scope_token: Option<&'a str>,
                           pub pin: PinView<'a>, pub path: PathRef }
pub struct PinView<'a> { pub rowid: i64, pub entry_id: &'a str, pub created_at: &'a str }
pub struct PathRef { /* hop: u8, edges: [u16; 2] */ }            // hop()、edge_indices() -> &[u16]
pub struct ScenePath<'a> { /* steps: 1〜2 件の PathStep { edge_index, edge: EdgeView<'a>, from: &'a str, to: &'a str } */ }
pub enum UnavailableReason { /* §7 */ }      // Copy。Display は allowlist の文字列を返す
pub enum UnavailableCategory { Limit, Timeout, Stale, RegistrationUnavailable, Invalidated, Cancelled, Failed }

// cqw.rs（pub）
pub struct CQueryWorkerUnavailable { pub reason: UnavailableReason }
// anyhow::Error に包んで返す。Display は今の文字列「NIR1_GRAPH_WORKER_UNAVAILABLE: {reason}」（cqw.rs:1867）を保つ。CP-2a は downcast して区分を得る
```

parent の資格判定と再検証（DSN §2.3）は CP-3a／CB-4 の担当なので、CP-1 では入れない。CP-1 では、その入口として次のものを用意する。

- (a) の照合に使う `generation` と `scope_revision`。
- (b) の照合に使う代表 path の `scene_path` と、各 edge の 9 token（`BindingView`）。
- (c) の照合に使う `PinView` と Scene の3つの token。`PinView` は `recheck_scene_pin`（scenes.rs:288-333）の `ScenePinLocator` に写せる。

cqw.rs も追従する。

- frame の受理（cqw.rs:1853-1887）は純関数 `accept_published_frame(bytes, request)` に切り出す。NQG1 と allowlist 外の拒否を、process なしの単体試験で確かめるため。
- `request_bound_q2_frame_for_test`（2496-2531）と `unavailable_test_frame`（3057-3064）を NQG2 と新しい API に合わせる。今の試験用の reason `"r"` は allowlist 外なので、`query-invalidated` に変える。

## 5. 予算の配分

### 5.1 消費の表（固定値の共有の残りから差し引く）

| 対象 | QueryUsage.rows（≤512） | QueryUsage.bytes（入力。≤6 MiB） | pages（≤32） | steps（≤100,000）の見積り | 取消と期限の確認 |
|---|---|---|---|---|---|
| pin の page（Entity ごとに keyset。1 page 16 行） | 返った行数 | `octet_length` で数える scene_id＋entry_id＋created_at。materialize の前に計上する | +1 | 基礎 約52＋1 行あたり 約23 | page の前と各行で `check()`（scenes.rs:234、247、265、270）。SQLite の中は 1,000 steps ごとの hook |
| pin の point 読取（行ごと。scenes.rs:267-280） | 0（page で計上済み） | 0（同上） | 0 | 約37／行 | 各行で `check()` |
| page の bind 引数（Entity ID） | 0 | `entity_id.len()` を page ごとに計上（候補と同じ。graph.rs:1675） | 0 | — | — |
| has-more の probe（行か page が尽きたときだけ。候補の graph.rs:1676-1680 と同じ形） | 0 | 0 | 0 | 約45 | 前に `check()` |
| 先頭 8 件の token（tree_nodes と A1 binding を、長さ→値の順に読む） | tree_nodes で 1。binding は行があれば 1 | 長さで計上（`v`＋`@`＋i64 の桁数＋`updated_at`、incarnation、scope token） | 0 | 約78／Scene | 各読取の前 |

- 入力 bytes は、page ごとに `SceneJoinBudget::admit` と `QueryUsage::admit` の両方へ、同じ時点（`octet_length` の後、point 読取の前）で計上する。
- `SceneJoinBudget`（scenes.rs:22-74）は `join_scene_pins` の中で1回だけ作り、全 Entity、全 page、全 token の読取で共有する（scenes.rs:22-24 のコメントどおり、候補ごとには作らない）。上限は phase の開始時の共有の残りにする。
  - `max_rows = 512 − usage.rows`
  - `max_bytes = MAX_GRAPH_INPUT_BYTES − usage.bytes`
- retained（ledger）には、既存の慣例どおり、入力とは別に保持の分を計上する（graph.rs:1709-1712 と同じ）。
  - page ごとの scratch：`Vec<PinLengths>` と `Vec<ScenePinLocator>` の容量（16）。
  - 相異なる Scene を map に入れる前：`retained_string(scene_id)`＋`retained_string(created_at)`＋entry の大きさ＋map の node の見積り（8×usize）。
  - 並べ替えの前：`Vec` の容量（scene_total 件分）。
  - association（最大 8 件）：文字列と path の `Vec<u16>`。
- 期限（100 ms）と steps は phase ごとに分けず、共有する。phase の開始時に `control.check(Page)`、並べ替えの前に `Sort`、token の前に `Source`、終わりに `ResultAssembly` を確かめる。
- phase で起きた資源系の失敗には、文脈 `NIR1_GRAPH_SCENE_LIMIT` を付けて、区分 `limit` に寄せる（§7）。対象は scenes.rs の `NIR1_GRAPH_SCENE_*_LIMIT`、`QueryUsage` の `NIR1_GRAPH_QUERY_RESOURCE_LIMIT`、`…_READ_LIMIT`、`…_INPUT_LIMIT`、`…_RETAINED_LIMIT`、page と行の枯渇、Scene 節の bytes の超過。
  - `ValidationTerminated`（steps、期限、取消）には付けない。既存の分類（`steps`→limit、`deadline`→timeout）を優先させるため。

### 5.2 事前計測（設計用の見積り。値は実装後に測り直す）

- 方法：`scratchpad/cp1-measure/scripts/pin_steps.py`、出力は `…/data/pin_steps.out`。Python sqlite3 3.53.4（bundled は 3.53.2）を使い、`set_progress_handler(n=1)` で VM の命令数を数えた。
  - 列の並びは実 schema を写した。`content` が `updated_at`、`archived_at`、`version` の前にある。
  - worker と同じく `cache_size=-128`、`mmap_size=0` にし、read-only で接続した。
  - Scene の本文は 200 B、20 KB、200 KB の3通りで測った。
- plan：
  - page の SQL（scenes.rs:148-157）は `SEARCH entry (id=?)`→`SEARCH p USING INDEX idx_scene_codex_pins_entry (entry_id=? AND rowid>?)`→`SEARCH scene (id=?)` の順で、TEMP B-TREE はない。`INDEXED BY` の有無で plan は変わらない。
  - point 読取は `INTEGER PRIMARY KEY (rowid=?)`、token は PK、binding は PK `(project_id=? AND scene_id=?)`。
- steps：
  - 空の page は 52。16 行は 2 page で、page 414＋point 611。17 行は 2 page で、435＋629。
  - 600 行は 38 page で、page 14,046＋point 22,200 ≈ 1 行あたり 60。
  - probe は 45。先頭 8 件の token は合計 624。
  - 本文の大きさで steps は変わらない。
- wall（Python の overhead を含む）：600 行で約 9.3〜10.1 ms。本文が 200 KB でもほぼ同じ（`archived_at` が NULL なら、overflow の page を辿らない）。token の読取は、本文が 200 B で 0.22 ms、200 KB で 0.92 ms。`updated_at` と `version` は `content` より後ろにあり、overflow の chain を辿るため。8 件に限るので有界である。
- 上界の見積り：pin の行は「512 − 走査の行」と「(32 − 候補の page) × 16」のうち小さい方を超えない。最大でも 496 行で、steps は約 496×60＋31×52＋624 ≈ 3.2 万（100,000 の約 32%）。

### 5.3 新しい上限：frame の Scene 節の bytes（`MAX_SCENE_SECTION_BYTES`）

- 値の案：16,384 B。frame.rs の pub const として置き、worker の事前検査、encode、validate の3か所で同じ定数を使う。
- 根拠：
  - association 1件の長さは `(4+|scene_id|) + (1+[4+|incarnation|]) + (4+|source_token|) + (1+[4+|scope_token|]) + 8 + (4+|entry_id|) + (4+|created_at|) + 2 + 2×path_edge_count`。
  - UUID の ID、ミリ秒付きの ISO 時刻、sha256 の scope token、2 hop で計算すると 270 B になる。incarnation が `legacy:{scene_id}` なら 277 B。8 件と header で約 2.2 KB。
  - 16 KiB は典型の約 7 倍で、ID が 256 B 程度に伸びても収まる。
  - `FRAME_BYTES`（約 1.55 MB。cqw.rs:198-205）の約 1% なので、node と edge の容量をほとんど奪わない。
  - parent の作業も N_F（8件）とこの上限で抑えられる。
  - sample project の ID（`sample-scene-2`、`sample-codex-cup` など。`src-tauri/resources/sample_project/v2.sql:190-200`）はさらに短い。
- 規則（p6:161-170）への適合：
  1. 有限である。
  2. 取消できる。算術の検査だけで待ちを作らず、前後の `check` と hook が取消を観測する。
  3. allocation の前に検査する。worker は token の長さ（`octet_length`）から association の長さを先に足し、上限を超えるなら値を materialize しない。encode は書く前に、validate は走査中に検査する。
  4. fail-safe にする。worker は Graph 全体を `scene-limit`（区分 limit）にし、parent は `NIR1_GRAPH_FRAME_SCENE_LIMIT` で frame を拒否する。
  5. 値は実測から選ぶ。実装後に、G-01 と同じ形の fixture（UUID の ID）と sample project の pin で長さを測り、最大値の 4 倍を下回らないことを確かめて、ここと PR に記録する。
  6. 7. 厳しくする変更は自由だが、merge の後に緩めるには再確認を要する。
  8. 物理的な証明は求めない。
- 境界の試験：ちょうど 16,384 B は通り、16,385 B は拒否されることを、worker、encode、validate のそれぞれで確かめる。

### 5.4 pin の件数：独立の定数は置かない（共有の残りを上限とする）

- 決定：pin の件数の上限は、固定値の共有の残りとする。具体的には「512 − 走査と token の行」と「(32 − 候補の page) × 16」のうち、先に尽きる方。新しい定数は足さない。
- 理由：
  - pin の行は、不適格な行と同じく read／admission を消費する（cand:148-150、l6-l9:497）。page も「query 全体で 32 page まで」（p6:109）に含まれる。そのため、固定値がそのまま件数を有界にしている。
  - 事前計測では、上界（496 行）でも steps の約 32%、数 ms に収まる。共有の残りより小さい独立の上限は、資源の上界を変えずに可用性を下げるだけになる。規則 6 の「正例の受入れを保つ範囲」にも反する。
- 採らなかった案：
  - `MAX_GRAPH_SCENE_PIN_ROWS` を 256 か 496 にする案：上の理由で不採用。
  - pin の page を 32 page に数えない案：「query 全体で 32 page」の固定値を広げることになり、再確認を要するので不採用。
- 実装後の再計測：Rust（bundled SQLite、release）で、0／16／17／256／最大の pin、本文 200 B と 200 KB、Entity 11 件への分散について、steps と wall を測る。上界が 100,000 steps か 100 ms に迫ると分かった場合は、規則 5 に従い、実測から独立の上限を選んでここに記録する。

### 5.5 N／N+1 の意味（試験で固定する）

- 行：pin と token の行が、共有の残りにちょうど収まれば available。1 行でも超えれば `scene-limit`。
  - 行が 512 に達し、その Entity にまだ pin がない場合は、候補と同じく probe で確かめて完了とする。scenes.rs:230-233 の「残り行 0 なら拒否」に当たらないよう、呼出し側で probe を先に行う。
- page：32 page で完了すれば available。33 page 目が要れば（probe が true なら）`scene-limit`。
- bytes：入力の残りか、retained の ledger（6 MiB）の残りを超えたら `scene-limit`。
- Scene 節：§5.3 のとおり。

### 5.6 可用性の注意（CP-2a と S2 の診断で測る）

- pin の多い Entity（主人公など）が到達 Entity に含まれると、512 行と 32 page の共有予算で Graph 全体が `limit` になりやすい。これは「完全列挙できないなら返さない」（cand:178-179、DSN §2.1）の帰結である。CP-1 は契約どおりに実装し、S2／CP-2a で `limit` の率と `scene_total` の分布を測る。緩める（pin 用の別予算を設ける、打ち切りを許す）には固定値か意味の変更が必要で、K1 の再確認を要する。
- `archived_at` が NULL でない Scene の pin と、token の読取は、本文の overflow page を辿る。この分は steps に表れない。100 ms を超えれば `deadline`（区分 timeout）になり、fail-safe である。

## 6. tuple の比較

- 比較は `<[u8] as Ord>::cmp`（`str::as_bytes` の辞書順。prefix は短い方が先）で行う。locale、名前、Gold、score は使わない。UTF-8 の byte 順は Unicode の scalar 順と一致するが、UTF-16 の code unit 順とは異なる（例：U+FF5E と U+1F600）。試験でこの差を固定する。
- 到達 Entity E の代表 path：
  - hop(E)=1：seed から E へ辿れる edge e のうち、(e.edge_id, frame の edge index) が最小のもの。
  - hop(E)=2：各 hop=1 の X について、上と同じ規則で X の最良の e1 を決める。そのうえで、X から E へ辿れる e2 について (e1.edge_id, e2.edge_id, e1 の index, e2 の index) が最小のもの。e1.edge_id が先に比べられるので、X ごとに最良の e1 を先に決めても、全組の最小と一致する。
  - hop は BFS の最短距離（graph.rs:1878-1887）で、tuple の最初の要素なので、最小 path は常に最短 path になる。最短でない walk（hop=1 の Entity への 2 本の path、自己 loop）は代表にならない。
  - frame の edge index は、`edges` の BTreeMap の key（revision_id, edge_id）の順（graph.rs:1660、1950）。同じ edge ID が別の Revision に現れたとき（ID の列が完全に同じとき）だけ、tie-break として使う。決定的である。
- 順位：rank(E) = (hop, 代表 path の edge ID 列, E の Entity ID) の昇順。Entity ID は node ごとに一意なので、全順序になる。
- Scene の tuple：(rank(E), scene_id)。Scene S の代表は、S に pin を持つ E のうち rank が最小のもの。cand §6 の tuple（hop、edge ID 列、Entity ID、Scene ID）の最小と同値である。E を固定すれば path の最小は rank に含まれ、Scene ID は最後の要素なので。
- 列挙の順を rank の昇順にし、各 Scene は最初に現れたときだけ記録する。こうすると、後から代表を置き換える処理は要らない。並べ替えは、BTreeMap（scene_id の順）を `Vec` にして、rank で安定 sort すれば (rank, scene_id) の順になる。
- parent の validate は、隣り合う scene を (path_hop, edge ID 列, pin_entry_id, scene_id) で比べ、狭義の昇順を要求する。edge ID は offset 表から O(1) で引く。

## 7. reason の allowlist と区分（DSN §1.5 の対応表を CP-1 で固定する）

frame に載せてよい unavailable の reason は、次の閉じた集合だけにする。それ以外は encode も validate も拒否する。

- 固定の 6 個：`reader-unavailable`、`registration-required`、`registration-project-mismatch`、`seed-not-found`、`registration-drift`、`query-invalidated`。
  - `query-budget-or-validation-failed` は reader の経路（worker でない経路）だけの値（graph.rs:987、1038）なので、frame の集合には入れない。
- 組立て型：`query-worker-{site}-{cause}{status}`（graph.rs:1214-1241）。
  - site は `work` か `post-stamp`。
  - cause は 17 個：`sqlite-nomem`、`candidate-record-limit`、`revision-record-limit`、`disclosure-record-limit`、`read-record-limit`、**`scene-limit`（新設）**、`deadline`、`deadline-or-steps`、`steps`、`validation-capacity-exceeded`、`validation-context-unavailable`、`validation-cancelled`、`validation-closed`、`validation-workspace-generation-changed`、`validation-foreground-preempted`、`validation-cleanup-failed`、`other`。
  - status は 4 種：空、`-pre-cleanup-work-ok`、`-pre-cleanup-work-failed-{cause}`、`-pre-cleanup-deadline-already-crossed`。
  - 合計 680 通りに固定 6 個を足した 686 通り。すべて有限で、private な文言は入らない。
- 実装：
  - `WorkerSite`、`WorkerCause`、`PreCleanup`、`UnavailableReason` を frame.rs の enum にする。graph.rs の `worker_refusal_cause`（1243-1290）は文字列の代わりに `WorkerCause` を返すように改め、組立てと解析が同じ定義を使うようにする。
  - marker 表（graph.rs:1255-1267）に `NIR1_GRAPH_SCENE_LIMIT`→`scene-limit` を足す。
  - 解析は allocation なしで行う。`deadline` と `deadline-or-steps` のように前方が一致するものは、「cause の直後が空か `-pre-cleanup-` で始まる」ことで区別する。
- 区分（UnavailableCategory。製品の理由への写像。owner 側の `warming`、`busy` などは CP-2a で決める）：

| frame の reason | 区分 |
|---|---|
| `reader-unavailable` | cancelled |
| `registration-required` | registration-unavailable |
| `registration-project-mismatch` | failed |
| `seed-not-found` | invalidated |
| `registration-drift` | stale |
| `query-invalidated` | timeout（worker では reader の取消経路が実際にはなく、実態は cleanup 後の期限超過（graph.rs:1010-1020）であるため） |
| 組立て型 | 実効 cause で決める。status が `work-failed-{c}` なら c、`deadline-already-crossed` なら deadline、それ以外は cause |
| 実効 cause が record-limit の4種、`scene-limit`、`steps`、`validation-capacity-exceeded`、`sqlite-nomem` | limit |
| 実効 cause が `deadline`、`deadline-or-steps` | timeout |
| 実効 cause が `validation-cancelled`、`validation-closed`、`validation-foreground-preempted` | cancelled |
| 実効 cause が `validation-workspace-generation-changed` | invalidated |
| 実効 cause が `validation-context-unavailable`、`validation-cleanup-failed`、`other` | failed |

- 既存の文言は変えない。lifecycle の試験は文字列で照合しているため（tests.rs:3152-3154、4527）。

## 8. dead_code の解除

- graph.rs:20-27 の `mod scenes` の module 単位の `expect(dead_code)` を外す。
- worker が使うようになる項目：`SceneJoinBudget`（の一部）、`ScenePinLocator`、`read_scene_pin_page(_with_admission)` と、新設する probe、token の読取、scratch。
- parent（CB-4）だけが使う予定の項目には、項目単位で `#[cfg_attr(not(test), expect(dead_code, reason = "parent-side CB-4 reader; the worker never reads Scene bodies"))]` を付ける。対象は `recheck_scene_pin`、`read_scene_source_bounded`、`first_non_empty_anchor`、`SceneSourceLocator`、`SceneSourceBinding`、`SceneBodyAnchor`、`SceneScopeExpectation`、`validate_scene_scope`、`matches_axis`、`matches_query_axis`、`digest`、`source_metadata_bytes`、`PIN_POINT_LENGTHS_SQL`、`SceneJoinBudget::remaining_bytes` など。どれを付けるかは clippy の結果で確定させる。
  - これで「worker から本文を読まない」ことが型の上でも見える。
  - 機能 flag（`nir1-material-diagnostics`、`nir1-c-query-test-seam`）を有効にした build でも、これらの項目は使われない（grep で確認済み）。expect が外れないことは、§10 の clippy の補助で確かめる。
- `mod memory` の expect（graph.rs:10-16）と memory.rs は許可ファイルの外なので変えない。memory.rs の `retained_graph`（272-）は scenes を数えないが、非 test では未接続のため影響しない。

## 9. 変更するファイル（予定）と dataset

| ファイル | 変更 |
|---|---|
| frame.rs | NQG2、投影、allowlist、定数 `MAX_SCENE_SECTION_BYTES`、試験 |
| scenes.rs | with_admission の page、probe、token の読取、scratch、`INDEXED BY idx_scene_codex_pins_entry`、項目単位の expect、試験 |
| graph.rs | association の型、`join_scene_pins`、`rank_reached_entities`、`WorkerCause` への切替え、`scene-limit`、module 単位の expect の削除 |
| cqw.rs | 受理を純関数に切り出す、`CQueryWorkerUnavailable`、試験の追従 |
| tests.rs、oracle.rs | 投影 API への追従、Gold を NQG2 に、新しい試験 |
| bin | 変更なしの見込み（encode の signature は変えない。seam は nodes と edges だけを見る：bin:333-339、353-359、374-381） |
| core | 変更なし（`MAX_GRAPH_SCENES` を参照するだけ） |
| electron/native/grimodex-node | 変更なし（frame を読む箇所がない。grep で確認） |
| candidates.rs、input.rs | 変更なしの見込み |

- `scripts/local-ci-full-workload-allocation.json` の sources に、上の変更予定ファイルは1つも載っていない。載っている `scripts/nir1-c-query-worker-ci.sh` と `nir1_capacity_fixtures.rs` は変えない。
- A-1：`nir1_graph_query` は `NIR1_GRAPH_NOT_ACTIVATED` のまま（`electron/native/grimodex-node/src/lib.rs:11674-11676`）。互換の入口 `read_nir1_graph` も `registration-required` のまま（graph.rs:2083-2089）。

## 10. 試験計画

frame.rs（単体）：

- `nqg2_round_trip_projects_every_node_edge_binding_and_scene`：複数の node と edge、evidence、binding（9 token）、scene（1 hop と 2 hop、symmetric の逆向き、incarnation が Some と None）を持つ応答を encode し、validate して投影したものが、元の応答の全 field と一致すること。
- `nqg2_rejects_every_strict_prefix_and_any_trailing_byte`：全長より短いすべての prefix と、末尾に 1 byte 足したものを拒否すること。
- `nqg2_rejects_nqg1_frames`：NQG1 の正しい frame（現行の Gold、tests.rs:1636-1700 の形）が `NIR1_GRAPH_FRAME_VERSION` で拒否されること。magic だけを NQG2 に替えたもの（Scene 節がない）は `TRUNCATED` で拒否されること。
- `nqg2_scene_invariants_reject_corrupt_associations`（表駆動）：次のそれぞれを拒否すること。
  - 件数：count > 8、count ≠ min(total, 8)、total > 512。
  - path：hop が 0 か 3、edge_count ≠ hop、index ≥ edge_count、path がつながらない、終点 ≠ pin_entry、pin_entry が node でないか hop が違う、途中の到達先が hop 1 でない。
  - 順序：順序の逆転、Scene の重複。
  - token と値：scope token の形式違い、incarnation と scope token の Some／None の不一致、rowid ≤ 0、空の Scene ID、generation ≤ 0。
- `nqg2_scene_section_cap_admits_n_and_refuses_n_plus_one`：16,384 B と 16,385 B の境界を、encode と validate の両方で確かめる。
- `unavailable_reason_allowlist_round_trips_all_686_and_rejects_others`：全組合せを組み立てて解析し、元に戻ること。次を拒否すること：`private detail`、`r`、空文字、`query-budget-or-validation-failed`、前後に文字を足したもの、未知の cause と status。
- `encode_and_validate_refuse_non_allowlisted_reasons`
- `unavailable_reason_categories_match_the_cp1_table`：§7 の表を固定する。
- 既存の2件（frame.rs:493-530）は NQG2 と allowlist に合わせて残す。

scenes.rs（単体）：

- 既存の6件（scenes.rs:638-887）は保つ。
- `pin_sqls_use_entry_index_keyset_without_scan_or_temp_btree`：EXPLAIN QUERY PLAN で、page、probe、point、token、binding の各 SQL を固定する。CR-1 の CQ-2 試験の形に倣い、負の対照（index のない列での読取は SCAN になる）も置く。
- `pin_page_admission_sees_octet_lengths_before_point_reads`：admission の hook が受け取る (rows, bytes) が `octet_length` の合計と一致すること。hook が失敗したら point 読取に進まないこと。
- `frame_tokens_read_lengths_first_and_absent_binding_is_none`
- `pins_remain_probe_matches_page_filters`：archive 済みの Scene と別 project の行を数えないこと。

graph.rs の join（tests.rs。私有項目に触れる単体試験）：

- 合成した node と edge で：`reached_entity_rank_orders_hop_then_edge_ids_then_entity`、`representative_path_uses_byte_order_and_frame_index_tie_break`（並行 edge、2つの Revision に同じ edge ID）、`symmetric_edges_traverse_both_ways_for_paths`。
- 実 DB の Fixture（tests.rs:77-176）に、registration の前に Scene と pin を足して：
  - `scene_join_enumerates_zero_sixteen_and_seventeen_pins_across_keyset_pages`：page 数と `scene_total` を確かめる。
  - `scene_join_excludes_seed_pins`：seed だけの pin では寄与 0。同じ Scene に hop 1 の pin もあれば、代表は hop 1 の Entity。
  - `scene_join_dedups_each_scene_to_its_minimum_tuple`：hop 1 と hop 2、edge ID、Entity ID の各段で確かめる。
  - `scene_join_orders_scene_ids_by_utf8_bytes`：U+FF5E と U+1F600、`Z` と `a`。
  - `scene_join_truncates_to_eight_and_reports_scene_total`：pin 10 件で count 8、total 10、先頭 8 件が byte 順。
  - `scene_join_budget_is_graph_wide_not_per_entity`：2 つの Entity で、累積で上限に達すること。
  - `scene_join_rows_n_available_n_plus_one_limit`、`scene_join_pages_n_available_n_plus_one_limit`、`scene_join_bytes_exhaustion_is_limit`、`scene_join_scene_section_n_available_n_plus_one_limit`：QueryUsage を先に計上しておき、境界を作る。
  - `scene_join_cancellation_returns_no_partial_result`：k 回目の `check` で失敗させる。
  - `scene_join_never_reads_scene_body`：SQLite の authorizer（execute.rs:3 の hooks と同じ API）で、`tree_nodes.content` の Read が1件もないこと。
  - `scene_join_steps_do_not_follow_unrelated_pins`：別の Entity の pin を 0／600／6,000 件に増やしても、steps と admission が変わらないこと。CQ-2 の形に倣い、B-tree の末端の差は ±1 を許す。
  - `graph_with_pin_overflow_is_unavailable_without_partial_graph`：reader の経路では `status=unavailable` で `graph=None`。test 専用の helper で、worker の経路に長い期限を与えて走らせ、reason が `query-worker-work-scene-limit…` で区分が limit であること。
  - `scene_join_output_is_deterministic`：同じ DB で2回 query して frame の bytes が一致すること。pin を逆順に挿入しても出力が同じであること。
  - テスト用の Scene を足しても、A3 の資格（読書順、Scope）が変わらないことを、追加の前後で nodes、edges、bindings が一致することで確かめる（sort_order を末尾にし、親は root にする）。
- `worker_refusal_reason_is_allowlisted_by_site_cause_and_pre_cleanup_status`（tests.rs:4961-5065）は enum 化に合わせて改め、`scene-limit` の行を足す。
- 投影 API を使う既存の試験（tests.rs:3451、3661、3731-3768、3825、4615-）と、Gold（tests.rs:1636-1700。NQG2 にし、末尾に `scene_total=0`、`scene_count=0` の 4 byte を足す）を追従させる。lifecycle の試験の名前は変えない（CI の `--exact` が名前で照合するため）。

oracle.rs：

- 既存の3つの正例（545-614）の期待値に、`"sceneTotal": 0, "scenes": []` を足す。
- `seed_local_two_hop_scene_associations_match_independent_projection` を新設する。two_hop の fixture に、次の pin を Fixture の入力として入れる：bob→B1、third→T1、alice（seed）→A、bob と third の両方→S。
  - 期待値は入力と canonical な binding metadata だけから作る：Scene は B1、S、T1 の順。S の代表は bob で path は [0]、T1 の path は [0, 1]。A は除外し、total は 3。
  - reader の出力は参照しない。

cqw.rs：

- `parent_frame_acceptance_rejects_nqg1_and_non_allowlisted_reason`（`accept_published_frame`）。
- 既存の reader thread の試験は、NQG2 の unavailable frame（reason は `query-invalidated`）で通ること。

実行する command（cwd に依存しないよう、絶対 path の worktree で、`CARGO_BUILD_JOBS=4` を付ける）：

1. `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::nir1_graph`（oracle の試験を含む）。
2. `cargo clippy --manifest-path src-tauri/Cargo.toml -p grimodex-db --all-targets -- -D warnings`
3. 補助：`cargo clippy --manifest-path src-tauri/Cargo.toml -p grimodex-db --all-targets --features nir1-material-diagnostics,nir1-c-query-test-seam -- -D warnings`。feature を有効にしたときに expect と cfg が崩れないかを見る。
4. `env -u TMPDIR -u TMP -u TEMP bash scripts/nir1-c-query-worker-ci.sh lifecycle` で 13/13。release build が要る。fixture はどれも seed だけの Graph（tests.rs:1907、4162、4255）なので、pin の phase は走らず、frame が 4 byte 増えるだけになる見込み。
5. 計測（ignored の試験。release）：§5.2 の再計測と §5.3 の長さの計測。値、環境、窓（他の build と重なっていないか）を、ここと PR に記録する。
6. 任意：`frame-lifecycle`、`trailing-data`、`partial-terminal-marker` の各 mode をローカルで回す。hosted の再 dispatch は integrator が行う（計画:249）。

## 11. 未解決事項と integrator への確認（どれも既定のまま進められる）

1. query の Scene 自身の pin を除外するか。既定は除外しない。cand §6 の tuple を全 pin にそのまま適用し、D-08 の「worker で資格の一部を判定しない」に合わせる。除外すれば、必ず不適格になる 1 枠の浪費を防げる。G-01 は query Scene に pin を持たないので（cand:217-218）、CP-0 の期待値には影響しない。
2. pin の page を 32 page に数えるか。既定は数える（固定値「query 全体で 32 page」の厳密な読み）。数えない案は固定値の拡大になるので、K1 の再確認が要る。
3. `MAX_SCENE_SECTION_BYTES` の値。既定の案は 16,384 B。実装後の計測で確定し、PR に記録する。
4. frame 全体が `FRAME_BYTES` を超えたときの扱い。今は encode が失敗し、worker が frame なしで異常終了する。そのため `limit` ではなく worker の失敗として現れる。bin の挙動を変えることは CP-1 の許可（版の追従だけ）の外なので、CP-2a での区分付け（`failed` か `worker-unavailable`）に回す。
5. D-07 の advisor の結論は受領した（§2.1。A、確度 高）。D-08 の advisor の結論は未取得。DSN 自体も再レビュー待ち（DSN:3）。
6. CB-4／K2 への入力：Scene の source token `v{version}@{updated_at}` には ABA がある（DT-3 の decisions §1(a)）。frame は incarnation と scope token も運ぶが、再検証で本文の digest まで束縛するかは CB-4 と K2 で決める。pin の rowid は再利用されうるが、`created_at` を含めて照合する（scenes.rs:677-701 の試験）。
7. 区分 `query-invalidated`→timeout の割当て（§7）。worker の外で reader が取り消された場合と区別したいなら、reason を2つに分ける必要があるが、既存の文言が変わるので CP-1 ではしない。

## 12. 実装の記録（2026-10-13）

### 12.1 計画どおりに実装したもの

- frame.rs：NQG2（§3 の layout）、`SceneAssociationLengths`（encode、worker の事前検査、試験が同じ算術を使う）、`MAX_SCENE_SECTION_BYTES = 16,384`、全件の typed projection（§4。`Records` iterator と `edge(i)` の O(1) 参照、`scene_path`）、reason の allowlist（`WorkerSite`、`WorkerCause`（17）、`PreCleanup`、`UnavailableReason`（686 通り）、`UnavailableCategory`。Display と parse は allocation なし）。
- graph.rs：`Nir1GraphSceneAssociation`、`Nir1QualifiedGraph.scene_total`／`scenes`、`rank_reached_entities`、`join_scene_pins`（`query_in_snapshot` の中。同じ snapshot、QueryUsage、control）、`scene_join_failure`（資源系の失敗に `NIR1_GRAPH_SCENE_LIMIT` を付ける。`ValidationTerminated` には付けない）、worker reason の enum 化（`worker_refusal_cause` は `WorkerCause` を返し、marker 表の先頭に `scene-limit`）、固定 6 個の reason を `UnavailableReason` から生成。module 単位の `expect(dead_code)` は削除した。
- scenes.rs：`read_scene_pin_page_with_admission`（`budget.admit` の直後、point 読取の前に caller の admission）、`scene_pins_remain`（page と同じ filter の EXISTS）、`read_scene_frame_tokens`（長さ→値。`content` は SELECT しない）、`pin_page_scratch_bytes`、page と probe に `INDEXED BY idx_scene_codex_pins_entry`。
- cqw.rs：純関数 `accept_published_frame`、`CQueryWorkerUnavailable`（Display は従来の `NIR1_GRAPH_WORKER_UNAVAILABLE: {reason}`）。試験の frame を NQG2 と allowlist の reason に追従。
- bin、core、electron/native/grimodex-node、candidates.rs、input.rs は変更なし（§9 の見込みどおり）。A-1：`#[napi]`、IPC、製品入口の変更なし。

### 12.2 計画から外れた点と追加した点（理由つき）

1. **pin の rowid が 0 以下なら列挙を拒否する**（追加）：keyset は rowid 0 の後から始まるので、0 以下の pin は黙って飛ばされ、列挙が不完全になる。各 Entity の最初の page と probe（cursor 0）の前に、`entry_id=? AND rowid<=0` の EXISTS を index で確かめ、あれば `NIR1_GRAPH_SCENE_INVALID_PIN_CURSOR`（区分 failed）で Graph 全体を unavailable にする。製品の writer は正の rowid しか作らない（候補の registration が `rowid<=0` を拒否するのと同じ考え方）。
2. **先頭 8 件の選び方**：全件の `Vec` と stable sort の代わりに、rank の順に BTreeMap（scene_id の順）を走査して 8 件で止める（最大 11×512 の比較）。結果は (rank, scene_id) の順で §6 と同じ。並べ替え用の `Vec` を作らないので、その retained の計上も不要になった。
3. **validate の Scene ID の重複**：§3 の「狭義の昇順なので重複も排除できる」は、隣り合う同じ key にしか効かない。別の Entity を経由する同じ Scene（key が違う）は狭義の昇順を満たしうるので、先頭からの Scene ID を固定長の表に記録し、重複を `NIR1_GRAPH_FRAME_SCENE_ORDER` で拒否する（最大 8×8 の比較、allocation なし）。
4. **validate の node ID の重複**：pin の Entity の hop を一意に引けるよう、node ID の重複を `NIR1_GRAPH_FRAME_NODE_DUPLICATE` で拒否する。正しい worker は BTreeMap の key で node を作るので重複しない。header の検査は `NIR1_GRAPH_FRAME_SCOPE`／`_GENERATION`／`_SEED`。
5. **dead_code の expect の位置**：rustc は `allow`／`expect(dead_code)` の付いた項目を生存の起点として扱うので、§8 の列挙どおりに全項目へ付けると、起点から使われる項目（`SceneBodyAnchor`、`SceneSourceBinding`、`SceneSourceLocator`、`SceneScopeExpectation`、`digest`、`first_non_empty_anchor`、`matches_axis`、`matches_query_axis`、`source_metadata_bytes`、定数3つ、`PIN_POINT_LENGTHS_SQL`）の expect が unfulfilled になった。項目単位の expect は起点の `recheck_scene_pin`、`read_scene_source_bounded`、`validate_scene_scope` と、試験だけが使う `SceneJoinBudget::rows`／`bytes` に限った。`read_scene_pin_page` は試験専用の薄い wrapper として `#[cfg(test)]` にした。
6. **clippy**：`FrameOutcome` に `#[allow(clippy::large_enum_variant)]`（GraphView は 144 件の offset 表を持つ stack 上の 688 B。Box にすると validate が allocation する）。`read_scene_pin_page_with_admission` は引数 8 個なので、既存の慣例どおり `#[allow(clippy::too_many_arguments)]`。
7. **試験の fixture の知見**：Scene は live の Scope authority（tree source generation と scene scope extension digest）に入るので、試験用の Scene と A1 binding は typed Revision を作る前に足す必要がある（後から足すと material の `authority_revision` が古くなり A3 で不適格になる）。pin は Scope authority に入らないので registration の前ならいつ足してもよい。

### 12.3 新しい上限の実測（`nir1-defensive-resource-limits` 規則 5）

環境：Linux 7.2.9、rustc 1.96.1、bundled SQLite、`cargo test --release`（ignored 試験 `measure_scene_join_capacity_and_frame_bytes`）。窓：他のレーンの build と重なっていた（load average 約 10）。wall は 5 回の最小値で、重なりのため上振れしうる。steps は cadence 1 の progress handler で数えた（wall とは別の実行）。

| 測定 | 値 |
|---|---|
| Scene 節：sample project の pin 6 件（実 ID、RFC 3339 ns の updated_at、A1 binding あり、2 hop） | association 最大 247 B、節 1,469 B、最大値で 8 件なら 1,980 B |
| Scene 節：G-01 形の UUID 8 件（A1 binding あり、2 hop） | association 最大 273 B、節 2,188 B |
| 上限 `MAX_SCENE_SECTION_BYTES` | 16,384 B（UUID 形 8 件の 7.5 倍。規則 5 の「最大値の 4 倍以上」を満たす）。N=16,384 は通り、N+1 は worker（`scene-limit`）、encode、validate のそれぞれで拒否される（試験あり） |
| join：pin 0（1 Entity） | 93 steps、56 µs、(rows, bytes, pages)=(0, 1, 1) |
| join：pin 16 | 1,539 steps、0.27 ms、(24, 762, 2) |
| join：pin 17 | 1,596 steps、0.28 ms、(25, 796, 2) |
| join：pin 256 | 16,524 steps、1.7 ms、(264, 8,937, 17) |
| join：pin 496（32 page を使い切る上界） | 31,509 steps（100,000 の 31.5%）、3.2 ms、(504, 17,112, 32) |
| 本文 200 KB（同じ件数） | steps は同じ。wall もほぼ同じ（token の読取は 8 件だけ） |
| join：11 Entity × 31 pin | 22,024 steps、2.2 ms、(349, 13,581, 22) |

- pin 1 件あたり約 63 steps で、§5.2 の事前計測（約 60）と合う。上界でも steps と期限に余裕があるので、§5.4 のとおり pin 件数の独立の定数は置かない。

### 12.4 未解決事項（追加）

- §11 の 1〜7 は変わらない（D-08 の advisor の結論は未取得）。
- 0 以下の rowid の pin を拒否する区分は `failed`（`other`）にした。製品で起きない前提の fail-closed なので、CP-2a で区分を変える必要はない見込み。

### 12.5 検証（最終 head。すべて `CARGO_BUILD_JOBS=4`、`--locked`）

| command | 結果 |
|---|---|
| `cargo test -p grimodex-db --lib narrative_extraction::nir1_graph`（debug） | 101 passed、0 failed、33 ignored |
| `cargo clippy -p grimodex-db --all-targets -- -D warnings` | 成功（警告 0） |
| 補助：同じ clippy に `--features nir1-material-diagnostics,nir1-c-query-test-seam`（`-D warnings` なし） | 成功。警告 64 件はすべて既存の箇所（`ReaderConnection::as_ref`、input.rs の preflight、bin の support など）で、HEAD と同じ件数。変更した項目への警告と unfulfilled expectation はなし |
| `env -u TMPDIR -u TMP -u TEMP bash scripts/nir1-c-query-worker-ci.sh lifecycle`（base の script そのまま） | 3 回とも 11 passed の後、`native_worker_retires_after_real_child_rust_oom` が失敗（`signal=Some(9)`、または cleanup の期限超過）。`set -e` のため 13 件目の SQLite NOMEM は未実行 |
| 同じ lifecycle を CR-1 の後続 commit `0c9064a0` の script で（`git show` した内容を変更せずに gitignore 下へ置いて実行し、実行後に削除） | 14/14 passed（13 件＋`ordinary_reader_registers_and_queries_fixed_q2_fixture`）。OOM の case も SIGABRT を観測して通過 |
| `frame-lifecycle`／`trailing-data`／`partial-terminal-marker` の各 mode | 3/3、1/1、1/1 |
| script の既定 mode（C-resource lane。Q2 と Q512 の canonical Gold の byte 比較、Q513 と SQL steps 超過の reason を含む） | 11/11 passed、exit 0 |
| `measure_scene_join_capacity_and_frame_bytes`（release、ignored） | §12.3 の値を再現 |

- lifecycle の OOM の失敗は環境の問題で、CP-1 の変更とは無関係と判断した。この host の `core_pattern` は systemd-coredump への pipe で、base の script の `ulimit -c 0` では core dump が止まらない。そのため child の SIGABRT 終了が owner の cleanup 期限（500 ms）を越え、SIGKILL として観測される。これは CR-1 の `0c9064a0`（`prlimit --core=1:1`）が直した既知の問題で、この worktree の base `0e041537` には入っていない。OOM の seam は request を読んだ直後、query と frame の前で abort するので、CP-1 の変更は通らない。integrator が CR-1 の merge 後の head で lane を再 dispatch すれば、この差は解消する見込み。
