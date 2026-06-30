# Codex 関係グラフ走査 MCP ツール（get_codex_relation_graph）設計

> 関連: MCP 全体 = `docs/Grimodex_MCPサーバー設計書.md`（現行 40 ツール・XPROJ/license/`--readonly` ゲート）。
> 関連: 既存 curated context = `src-tauri/crates/grimodex-mcp/src/tools/context.rs`（`get_writing_context`。**意図的に "no codex relation BFS"**）。
> 関連: Rust 移植 + fixture parity の前例 = `get_chronicle_state`（`src-tauri/crates/grimodex-mcp/src/chronicle_snapshot.rs`、`2026-06-28-chronicle-context-injection-design.md` §C7）。
> branch（実装着手時）: `feat/codex-relation-graph-mcp`
>
> **発端**: 「オントロジー / GraphRAG を Claude Code に持たせる」記事を Grimodex に当てられるか、という検討。記事の "型付き関係グラフをエージェントに辿らせる" という核は Grimodex の `codex_relations` で既に**データとしては**満たされているが、**それを外部 MCP から辿る経路が存在しない**ことが並列検証で判明した。本 spec はその唯一欠けている能力＝関係グラフ走査ツールの設計。

---

## 1. 背景・現状（recon ground-truth, 2026-06-30 並列検証・敵対 verify 済み）

> **読み方:** 元の検討文（記事適用分析）が「設計書上はっきりしない」とヘッジした 3 点を、5 並列の読み取り検証 + 統合でファクトチェックした結果。**前提の 2 つが楽観的に誤っていた**ため、本 spec はそれを反映した接地版になっている。

### 確定事実（コード根拠つき）

1. **`codex_relations` は実在する型付き有向辺テーブル。** `src/db/schema.ts:1197-1226` = `{id, projectId, fromCodexId, toCodexId, relationType, label, depthHint, sourceMapEdgeId, createdAt, updatedAt}`。`idx_codex_relations_project / _from / _to` の 3 インデックスあり。走査の土台は揃っている。
2. **MCP は関係を一切辿れない（0 本）。** `grimodex-mcp` クレートに `codex_relations` 参照ゼロ。`get_writing_context` のモジュール doc（`tools/context.rs:1-14`）が *"no codex relation BFS / children / phase resolution"* を **v1 の意図的カット**と明記。`collect_codex_layer`（`context.rs:392-466`）は本文への部分文字列スキャンのみ。
3. **`find_related_entries` は関係辺を辿らない。** `db.rs:1185-1248` = `name/summary/aliases/tags_cache` への `LIKE` 検索（語彙的近傍）で、`codex_relations` を一度も読まない。記事が期待した「関係を辿る関連探索」ではない。
4. **アプリ内の関係注入は意図的に 1 ホップ。** `chatStore.ts:2651` / `:1276` が `expandCodexRelationsBFS(..., { maxDepth: 1 })`。`DEFAULT_MAX_RELATION_DEPTH = 2`（`relationExpansion.ts:6`）を**わざと 1 に上書き**。理由コメント `chatStore.ts:2644-2645`「深さ2の"相手の相手"（師匠のライバル等）は現シーンとほぼ無関係なノイズ」。→ **「2-3 ホップに伸ばす」案は既に検証して却下された設計を覆すことになる**（後述 D2）。
5. **走査ロジックの参照実装は TS に存在。** `expandCodexRelationsBFS`（`relationExpansion.ts:49-135`）= 双方向隣接・visited 集合・depth 上限・件数上限・`relationVia` ラベル付き。Rust へ移植可能。ただし **agent / MCP ツールには未露出**で、用途は in-app コンテキスト組立のみ。
6. **`relation_type` は完全な自由テキスト。** `schema.ts:1210` = `text('relation_type').notNull().default('custom')`。検証・allowlist・enum なし。書き込み経路は `slugifyRelationType()`（`relationExpansion.ts:22-26`、任意文字列を小文字+下線スラグ化）か素通し（`codexRelationApi.ts createCodexRelation`）。Map 辺ラベル昇格も任意ラベル由来。UI の `PRESET_KEYS`（friend/family/lover/enemy/mentor/servant）は**提案のみ**。
7. **"先例" として挙がった `postEffectAnnotationRelations` の enum は DB 制約ではない。** `schema.ts:1911` も `text('relation_type')`。enum 値はコメント + TS union（`PostEffectRelationType`）だけで CHECK 制約なし。しかも実際に書かれるのは `contradiction` のみ（`post_effect.rs:2826` ハードコード）。→ **"軟 enum（規約）" の前例**であり、ハード enum の前例ではない。
8. **フェーズは関係の可視性を変えない（直交）。** `codexEntryPhases`（`schema.ts:942-967`）は `summary/content/contextMode` を物語アンカー（`anchorNodeId`）で上書きするだけ（`phaseResolver.ts:99-179`、`anchorNodeId ≤ currentScene` の順次適用）。関係の membership には関与しない。→ 元分析の「フェーズで関係の時間変化を表現＝記事より先行」は**誤り**。「友人→敵」を関係レベルで時系列管理する仕組みは無い。
9. **event_relations は無型のバイナリ因果辺。** `schema.ts:1499-1517` = `{projectId, causeEventId, effectEventId}`。`relation_type` 列なし。→ "型付きグラフ" は **codex に限った話**で年表イベント辺には当てはまらない。**本ツールの対象は `codex_relations` のみ**（event の因果は既存 `add/remove_event_relation` + `get_event_detail` の管轄）。
10. **XPROJ + fail-closed の再利用可能イディオムが既にある。** read-by-id は `WHERE id=? AND project_id=?`（`db.rs:1192`）、秘匿は `... AND secret=0` で「存在しない」扱い（`event_exists`、`db.rs:2215-2222`）。**ただし codex には `secret` 列が無い** → 秘匿は `context_mode` で表現される（`schema.ts:188` = `'always' | 'mentioned' | 'suppress' | 'hidden'`）。

### 検証で却下/格下げした案（元分析の 3 改善）

| 元の改善案 | 検証後の判定 | 帰結 |
|---|---|---|
| **#1** codex_relations を一級グラフ走査ツールとして MCP 公開 | **真の欠損（greenfield）**。効果高/工数中 | **本 spec の本丸。** |
| **#2** 関係注入を 2-3 ホップ多段化 | **却下済み設計の蒸し返し**（事実4）。単独価値なし | #1 ツールの `depth` パラメータ（既定 1・上限 2）に**吸収**。in-app 注入は 1 ホップ据え置き |
| **#3** relation_type を enum 制約 | ハード enum は自由ラベル（Map 辺）を壊す（事実6/7）。表示ラベル以上の意味を今は持たない | **軟正準語彙**（TS const + UI dropdown + 自由入力フォールバック）に格下げ。#1 ツールが `relation_types` フィルタで初めて消費者になる |

---

## 2. 目的（接地版）

- **A. プロジェクト横断クエリの直読化** — 「このキャラの変更の影響範囲」「敵対関係を整理」を、全シーン本文を grep する代わりに**型付き辺を辿るだけ**で返す。MCP の棲み分け（横断分析）に合致。
- **B. 多ホップ関係推論の確定情報化** — 「A は B の敵、B は C の盟友」を AI が推測で埋める代わりに、確定した辺として（上限つきで）渡す。
- **C. in-app コンテキストとの能力差の縮小** — 現状 MCP は codex 関係 0 ホップ。本ツールで「明示要求時のみ N ホップ」を pull 提供する（push 注入は in-app の 1 ホップ据え置き = D2）。

**非目的（明示）**:
- 関係の**作成/編集**は対象外（read-only）。relation は UI / Map 辺昇格のみで作る現状を維持（D1）。
- **push 注入の多段化はしない**（事実4 のノイズ知見を尊重）。本ツールは pull（明示 ToolCall）専用。
- event_relations / foreshadow / post-effect は対象外（既存ツールの管轄）。

---

## 3. 全体設計

| チャネル | 方向 | 表面 | 本 spec での扱い |
|---|---|---|---|
| **① 外部 MCP read ツール** | pull | `src-tauri/crates/grimodex-mcp/src/tools/codex.rs` + `server.rs` | **Phase 1（本体）** |
| ② アプリ内 agent ツール parity | pull | `toolDefinitions.ts` + `toolExecutors.ts` | Phase 2（任意・§3.9 parity 維持のため推奨） |

**背骨**:
1. **到達ノードの discovery は TS `expandCodexRelationsBFS` を正本**とし、Rust に移植。`get_chronicle_state` と同じ「TS derive ↔ Rust 移植 + 共有 fixture で drift gate」方式（D5）。
2. **出力形は in-app と意図的に異なる。** in-app は prompt 注入用のフラット `CodexContext[]`。MCP は**グラフ推論用に `root + nodes[] + edges[]`** を返す。parity gate は「到達ノード集合 + hop 距離」と「返却サブグラフ内の可視辺集合」で取り、出力の byte 一致は要求しない（D5 注記）。

---

## 4. Component 詳細

### C1. ツール定義 `get_codex_relation_graph`（read-only）

`get_writing_context` / `find_related_entries` と同じ rmcp パターンで `server.rs` に登録（`#[tool_router]` impl 内に `#[tool(description=...)]` async fn、`tools::codex::get_codex_relation_graph(self, params.0).await` へ転送。前例 = `server.rs:223-232`）。

**入力（params struct, `tools/codex.rs`）**:

既存 MCP ツールは `entry_id` / `type_slug` など **snake_case** を公開しているため、本ツールもそれに揃える。params struct に `#[serde(rename_all="camelCase")]` は付けない。予約語だけ `#[serde(rename = "...")]` を使う。

| パラメータ | 型 | 既定 | 意味 |
|---|---|---|---|
| `entry_id` | string（必須） | — | 起点 codex エントリ id。**他プロジェクト/不明 id は `root:null` の空グラフ**（fail-closed・存在 oracle 化を防ぐ） |
| `depth` | int | `1` | 走査ホップ数。`0..=2` にクランプ。**ハード上限 2**（事実4 のノイズ知見。超過要求は 2） |
| `direction` | enum `out`\|`in`\|`both` | `both` | `from→to` 順方向 / 逆 / 両方。in-app BFS は実質 `both`（双方向隣接） |
| `relation_types` | string[]? | なし | 辺を `relation_type`（slug 正規化後）で絞る。**#3 軟語彙の唯一の消費者**。未指定、または trim 後に有効値が 0 件なら全型 |
| `scene_anchor_id` | string? | なし | scene node id。指定時 `phaseResolver` 相当でフェーズ解決し、アンカーより未来のネタバレ override を出さない |
| `max_nodes` | int | `30` | root を除くノード予算。`0..=30` にクランプ。`MAX_MENTIONED_CODEX=30`（`context.rs:30`）に揃える |
| `max_edges` | int | `120` | edge 予算。`0..=200` にクランプ。密グラフ/重複 relation で payload が膨らむのを防ぐ |

**出力（`#[derive(Serialize)] #[serde(rename_all="camelCase")]`、`CallToolResult::success` に JSON 文字列）**:

```
{
  "root":  { id, name, type } | null,
  "nodes": [ { id, name, type, summary, hopDistance } ],   // summary は phase 解決後・truncate 済み
  "edges": [ { id, fromCodexId, toCodexId, relationType, label, fromHopDistance, toHopDistance } ],
  "meta":  { truncated: bool, nodesDropped: int, edgesDropped: int, charCount: int, depthReached: int }
}
```

- `summary` の content フォールバックは `CONTENT_FALLBACK_CHARS=200`（`context.rs`）に倣う。
- **`meta` で drop を必ず開示**（`context.rs` の `*_dropped` 規約＝「呼び手が char 数を見て trim」。無言ドロップ禁止）。
- root 自身は `nodes` に含めず `root` に分離（in-app は seed を visited に入れて結果から除外する＝`relationExpansion.ts:91` と整合）。`entry_id` が不明/他プロジェクトなら `{ root:null, nodes:[], edges:[], meta:{...0...} }` を返し、理由文字列は出さない。
- `edges[]` は root + `nodes[]` の返却サブグラフ内で、両端が可視・返却済みの関係だけを返す。予算外/秘匿ノードへの dangling edge は返さない。

### C2. 走査ロジック（TS BFS の Rust 移植）

`relationExpansion.ts:49-135` の不変条件をそのまま移植する:

1. **双方向隣接の構築** — 各 `rel` を `from→{to, "from {fromName} via {label}"}` と `to→{from, "to {toName} via {label}"}` の両方向で隣接に積む（`relationExpansion.ts:69-88`）。`direction` パラメータで `out`/`in` のときは discovery 用の隣接だけ片方向にする（in-app には無い拡張）。出力 edge の向きは常に DB の `from_codex_id → to_codex_id` を保つ。
2. **visited 初期化** — `visited = {seed} ∪ excludeIds`（MCP では excludeIds は空でよい。seed=root）。
3. **キュー BFS** — 直接隣接 `depth=1`、以降 `depth = cur.depth + 1`。`cur.depth >= depth(param)` で打ち切り。`nodes.length >= max_nodes` で全体打ち切り（`relationExpansion.ts:103,123,128`）。
4. **ラベル** — `label = sanitize_relation_text(rel.label?.trim() || rel.relationType)`。最低限 `--` → `- -` は TS と同じにする（`relationExpansion.ts:35-36`）。JSON 文字列として返すため、ユーザー入力の意味までは破壊しない。`relation_types` フィルタは `slugify(relationType)` で比較（`relationExpansion.ts:22-26` と同じ正規化を Rust で再実装）。
5. **`edges[]`** — discovery 完了後、`{root} ∪ returned nodes` を endpoint 集合として、両端が集合内にある可視 relation を返す（induced subgraph）。`fromHopDistance` / `toHopDistance` は各 endpoint の hop（root=0）。これにより spanning-tree だけを返して兄弟間/逆向きの既存辺を落とす不完全グラフを避け、同時に予算外・秘匿 endpoint の存在を漏らさない。
6. **edge 予算と順序** — `edges[]` は `min(fromHopDistance,toHopDistance)` → `max(...)` → `relationType` → `id` の安定順で並べ、`max_edges` 超過分は落として `meta.edgesDropped` に出す。edge drop は endpoint 名/summary 追加取得の前ではなく、可視・返却済み endpoint に絞った後に行う。

> **移植注記**: TS は文字数を UTF-16 code unit、Rust は Unicode scalar value で数える（`get_chronicle_state` と同じ理論差分）。fixture は truncation を発火させない範囲に収め、parity gate に出さない（§6）。

### C3. ネタバレ/秘匿フィルタ（codex 版・chronicle とは別物）

**codex に `secret` 列は無い**ため `event_exists` の `AND secret=0`（`db.rs:2217`）はそのまま使えない。codex の秘匿は `context_mode` で表現する:

- **常時除外**: `context_mode IN ('hidden','suppress')` のエントリは nodes/edges に出さない（辺の相手がこれなら、その辺も落とす）。
- **`scene_anchor_id` 指定時**: `phaseResolver.resolveCodexState` 相当を Rust 移植し、各ノードの `summary` を**アンカー時点の状態**に解決（`anchorNodeId ≤ currentScene` の phase のみ適用＝`phaseResolver.ts:148`）。`context_mode_override` も解決し、解決後が `hidden/suppress` なら除外。アンカー未来の override は出さない（フラッシュバック誤適用防止）。
- **順序軸**: scene order はプロジェクトの `projects.phase_resolution_mode` に従う。`reading` は `computeGlobalSceneOrder`（folder DFS + `sort_order`）、`story` / `auto` は `computeSceneTimeIndex`（`story_time_order` 設定済みを先、未設定は reading-order 末尾）を Rust 側に移植する。現行 MCP の `TreeNode` DTO は `story_time_order` を持たないため、専用 query/DTO を追加する。
- **anchor 不明時**: `scene_anchor_id` が空/他プロジェクト/scene 以外/削除済みなら、TS `resolveCodexState` の `sceneOrder` miss と同じく base 状態を返す（エラーや理由文字列で存在 oracle を作らない）。
- **`scene_anchor_id` 無指定時**: base の `context_mode` / `summary` を使用（phase 未解決）。これは `--readonly` 外部クライアントが「全体像を素で見る」用途。**ただし `hidden/suppress` 除外は常に適用**。

> phase 解決は `get_writing_context` が v1 でカットした処理（`context.rs:10-11`）なので、これは新規移植作業（C5 の get_chronicle_state とは別の resolver）。工数見積りに含める。

### C4. プロジェクトスコープ（XPROJ・必須）

`db.rs` の read 関数として実装し、**全クエリに `project_id = server.project_id()`**:

- 起点取得: `SELECT ... FROM codex_entries WHERE id=?1 AND project_id=?2`。`QueryReturnedNoRows → Ok(empty graph)`（`db.rs:1199-1200` イディオム）。
- 辺取得: `SELECT ... FROM codex_relations WHERE project_id=?` を起点に BFS（隣接は in-memory 構築でも、ホップごとに `from/to IN (...)` でも可。グラフが大きい場合の後者は要計測）。
- **二次 FK 再スコープ**: 辺の相手エントリを読むときも `AND project_id=?` を再適用（[[grimodex-mcp-xproj-read-by-id-hole]] の教訓 = スコープ済み行から辿っても gate を効かせる）。

### C5. parity gate（drift 防止）

`get_chronicle_state` と同じ方式（`2026-06-28-chronicle-context-injection-design.md` §C7）:

- 共有 fixture `src/features/codex/fixtures/relation-graph/*.json`（entries + relations + phases + anchor + params → expected graph）。
- **TS 側**: `expandCodexRelationsBFS`（+ phase 解決 + induced `edges[]` 収集の薄いアダプタ）で fixture を通し expected と比較。
- **Rust 側**: 移植版で同 fixture を通し deep-equal assert。
- gate 対象 = **到達ノード集合 + hopDistance + endpoint hop 付き edges 集合**。truncate の char 数だけは UTF-16/USV 差分があるため fixture では非発火（C2 注記）。

### C6. アプリ内 agent ツール parity（Phase 2・任意だが推奨）

MCP 設計書 §3.9 は in-app/MCP の能力 parity を規律として持つ。本ツールも対応する agent ツールを足すのが筋:

- `toolDefinitions.ts` `AGENT_TOOLS` に `get_codex_relation_graph` read 定義、`READ_ONLY_TOOL_NAMES` に追加。
- `toolExecutors.ts` に executor（既存 `expandCodexRelationsBFS` をそのまま使い、nodes/edges 形に整形）+ `READ_ONLY_EXECUTORS`。
- `toolProtocolParse.ts` の `MUTATING_TOOL_NAMES` には入れない。Hermes body-channel の read 許可に自然に残ることを `toolProtocolParse.test.ts` / `toolExecutors.test.ts` で確認。
- `toolExecutors.test.ts` / `toolDefinitions.test.ts` の同期 + XPROJ test。`aiLiveHarness.ts` の mock read-only executor が固定ツール数を前提にしている場合は同時更新。
- Context Creator は現状 `search_codex` / `list_codex_by_type` / `search_codex_by_tags` / `search_snippets` の明示 allowlist なので、自動的には増えない。採用するなら `CREATOR_TOOLS` に明示追加し、候補提案のノイズを別途検証する。
- これは push 注入（1 ホップ据え置き）とは別の **pull ツール**。agent が明示的に「関係を辿って」と要求したときだけ N ホップを返す。

> Phase 1（MCP）と Phase 2（in-app）は同 PR スタックで並走可。#1 のスコープを締めるなら Phase 1 のみでも出荷可能（MCP は外部横断クエリが主用途のため、そちらを先に通す）。

---

## 5. セキュリティ（XPROJ scoping・必須）

- read-by-id: `WHERE id=?1 AND project_id=?2`。不明/他プロジェクト id → 空グラフ（not-found を返さず空で fail-closed・存在 oracle 防止。`event_exists` 思想を codex に適用）。
- 秘匿: codex は `secret` 列が無いため `context_mode IN ('hidden','suppress')` 除外 + phase 解決後の再判定（C3）。chronicle の `secret=0` ロジックは**流用不可**。
- 二次 FK（辺の相手・名前）: スコープ済み行から辿っても `project_id` gate 再適用（[[grimodex-mcp-xproj-read-by-id-hole]]）。
- license / `--readonly`: **read-only ツールなので license gate も `--readonly` ブロックも対象外**（read は常時許可・MCP 設計書 §7）。`MUTATING_TOOL_NAMES` には**載せない**（write ではない）。
- DoS: `depth ≤ 2` ハードクランプ + `max_nodes ≤ 30` + `max_edges ≤ 200` で走査量と payload を上限。大グラフでの辺クエリコストは実装時に計測（事実: `idx_codex_relations_from/_to` あり）。
- exfil 注記: ピン留め（`--project`）は「どの作品を見せるか」を守るが、見せた作品の関係グラフがクラウドへ出ること自体は防げない（MCP 設計書 §7 と同じ前提。秘匿原稿はクラウド MCP に繋がない）。

---

## 6. テスト方針

### 純関数 / 移植（Rust + TS）
- BFS: depth 0/1/2、上限クランプ（depth=5→2、負数→0）、`max_nodes` 打ち切り + `meta.nodesDropped`。
- direction: `out`/`in`/`both` で到達集合が変わること。
- 循環グラフ（A↔B↔C↔A）で visited が無限ループを防ぐこと。
- `relation_types` フィルタ（slug 正規化込み・大文字/空白差を同一視＝`codexIntegrity.test.ts:193` 相当）。
- 秘匿: `hidden/suppress` ノード除外 + その辺の除外。
- edges: 返却 endpoint 内の induced edge を返すこと、予算外/秘匿 endpoint への dangling edge を返さないこと、edge id で重複 relation を区別できること、`max_edges` 超過時に安定順で落として `meta.edgesDropped` を出すこと。
- phase: `scene_anchor_id` 指定時のアンカー前/後 override、未来 override 不出、`context_mode_override` で解決後除外、`phase_resolution_mode=reading/story/auto` の順序差、anchor 不明時は base 扱い。
- fixture parity（TS ↔ Rust deep-equal、§C5）。

### MCP（Rust 統合）
- XPROJ: 他プロジェクト `entry_id` → 空グラフ。辺の相手が他プロジェクト → 出ない。
- `--readonly` でも呼べる（read）。`tools/list` 件数が現行 40 → 41（read 24 → 25）になる。
- 出力 JSON schema（nodes/edges/meta）の安定性。

### in-app（Phase 2 採用時）
- `READ_ONLY_*` 1:1、`MUTATING_*` に**入らない**こと、Context Creator に出ない/出すの方針確認。

### その他
- 幾何なし → browser test 不要。
- ai-verification: tool 経路の transport 登録（[[grimodex-ai-path-verification]]）。

---

## 7. フェーズ計画（PR 分割）

- **Phase 1（MCP・1 PR）**: C1 ツール定義 → C2 BFS 移植 → C3 秘匿/phase フィルタ → C4 XPROJ → C5 fixture parity → §6 テスト。**read-only・出荷可**。目的 A/B。
- **Phase 2（in-app parity・任意・別 PR）**: C6。既存 `expandCodexRelationsBFS` を nodes/edges アダプタ + agent ツール登録で露出。目的 C。
- **Phase 3（#3 軟語彙・任意・別 PR）**: relation_type の TS 正準語彙 const + UI dropdown（自由入力フォールバック維持）。`relation_types` フィルタの実効性が上がる。Phase 1 が消費者を作って初めて価値が出る順序。

> ハード DB enum（CHECK 制約）は採用しない。Map 辺ラベル昇格の自由 `custom` を壊すため（事実6/7）。

---

## 8. 設計判断（検証反映・確定）

| ID | 決定 | 理由 |
|---|---|---|
| **D1** | **read-only。** relation 作成ツールは追加しない（UI / Map 辺昇格のみ） | 現状 relation は構造編集の産物。AI 自動生成は別議論。read 専用なら license/`--readonly`/MUTATING の write ゲートを増やさず、攻撃面を小さく保てる |
| **D2** | **depth 既定 1・ハード上限 2。** push 注入（in-app）の 1 ホップは据え置き | 改善案 #2 の「2-3 ホップ」は `chatStore.ts:2644-2645` で検証の上**却下済み**（ノイズ）。多ホップは「明示 pull・上限つき」でのみ許す。ノイズ知見は qualitative（計測データではない）が、無条件に覆すのは不可 |
| **D3** | **秘匿は `context_mode IN ('hidden','suppress')` 除外 + phase 解決。** chronicle の `secret=0` は流用しない | codex に `secret` 列が無い（事実10）。phase 解決は `get_writing_context` が v1 カットした新規移植（`context.rs:10`） |
| **D4** | **`relation_types` フィルタを設け、語彙は軟正準化（#3）。ハード enum はしない** | 自由ラベル（Map 辺昇格）を壊さない。relation_type は現状表示ラベル止まり（事実6）で、フィルタ消費者ができて初めて意味が出る |
| **D5** | **discovery は TS `expandCodexRelationsBFS` を正本に Rust 移植 + 共有 fixture で drift gate。** 出力 byte 一致は非要求（到達集合 + hop + induced edges で gate） | `get_chronicle_state` の実績パターン。in-app はフラット注入用 / MCP は nodes+edges のグラフ用で出力形が異なるため、不変条件（到達性 + 返却サブグラフ）で parity を取る |
| **D6** | **対象は `codex_relations` のみ。** event_relations / foreshadow / post-effect は対象外 | event 辺は無型（事実9）で既存 `get_event_detail` 等の管轄。混在させるとツール責務が膨らむ |
| **D7** | **Phase 1 = MCP 単独で出荷可。** in-app parity（C6）は任意の後続 | MCP の主用途は横断クエリ（記事のコスト削減が効く本丸）。in-app は既に 1 ホップ push があり緊急度が低い |

---

## 9. 未解決 / 着手前に潰す点

- **効果の未検証**: relation_type は現状「表示ラベル」でしかなく、グラフ走査が執筆コンテキスト品質を実際に上げるかは**消費者（#3 や下流プロンプト）次第で未実証**。Phase 1 出荷後に実クエリで read 経路のコスト/有用性を計測する（記事の "$1.26→$0.62・3倍速" は 1 リポジトリ・1 クエリ種の一例で、Grimodex で同等が出る保証はない）。
- **大グラフのクエリコスト**: `idx_codex_relations_from/_to` はあるが、ホップごと `IN (...)` 展開 vs 全 relation in-memory BFS のどちらが速いかは未計測。Phase 1 で両方プロトタイプし計測。
- **phase 解決の Rust 移植コスト**: `resolveCodexState`（`phaseResolver.ts:99-179`）+ `computeGlobalSceneOrder` / `computeSceneTimeIndex` の順序正本を Rust に持ち込む必要。`projects.phase_resolution_mode` と `tree_nodes.story_time_order` を読む専用 query/DTO も要る。`get_chronicle_state` の anchor 解決と一部重なるので流用余地を調査。
- **in-app push を 1 ホップ→「型フィルタ付き 2 ホップ」に上げる余地**（D2 の脇道）: もし将来やるなら hop≥2 を `relation_types` で絞る or relevance scoring を噛ませ、`chatStore.ts:2644` のノイズ問題に直接答える形にする。本 spec のスコープ外。
