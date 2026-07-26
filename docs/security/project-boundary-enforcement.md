# プロジェクト境界の強制モデル (project-boundary enforcement)

アーキテクチャ監査 2026-07 の defer 項目「**project 境界の backend 強制**」に対する
現状評価と設計判断の記録。結論から言うと、**真の脅威面 (MCP) は既に backend で
強制され回帰テスト済み**であり、残る in-app 書込面 (agent_writes) の active-project
照合は「限定価値 + FE 配線 + race リスク」につき意図的に defer する。

## 背景

Grimodex は **1 workspace = 1 SQLite DB**、その中に複数プロジェクトが `project_id`
列で同居する構造。監査は「project スコープが FE のクエリビルダ頼みで backend が
強制していない」= foreign な `project_id` を送れば横断読み書きされうる、と指摘した。

実際にはサーフェスごとに強制姿勢が異なる。以下が現状の正確な整理。

## 3 サーフェスの強制姿勢

### 1. MCP サーバ (別プロセス・信頼できない呼び出し元) — ✅ backend 強制済み + テスト済み

`src-tauri/crates/grimodex-mcp/`。別プロセスとして DB を開くため、呼び出し元 (外部
MCP クライアント) は信頼できない。ここは**最小権限で backend 強制**されている。

- **プロジェクト pin**: `GrimodexServer.current_project`（`server.rs`）を spawn 時の
  `--project` で pin。既定は単一プロジェクト pin。
- **`select_project` ゲート**: `--all-projects` なしでは拒否（`tools/project.rs`、
  `list_projects` も pin を尊重）。
- **全 read-by-id が project スコープ**: `WHERE ... project_id = ?` を必ず付す
  （`db.rs` の get_scene_meta / get_scene_content / get_codex_entry_full /
  get_foreshadow_detail、`tools/scene.rs` の propose_scene_body など）。scope は
  呼び出し元供給ではなく `server.project_id()` から取る。
- **回帰テスト**: クレート内に XPROJ アサーションが多数（scene_meta /
  codex_entry_full / scene_content / chat_messages / attribution /
  foreshadow_detail ×2 / **propose_scene_body 書込経路 (本 doc と同時追加)**）。
  read-by-id の `project_id` フィルタが外れたら赤くなる。

→ 監査が懸念した「read-by-id ホール」は既に塞がれ、テストで固定されている
（[[grimodex-mcp-xproj-read-by-id-hole]] 参照）。

### 2. agent_writes (in-app AI エージェントの書込コマンド・renderer 供給) — FE 信頼 + scoped-SQL

`src-tauri/src/commands/agent_writes.rs`（18 コマンド）。各コマンドは payload の
`project_id`（FE の `getCurrentProjectId()` 由来）を受け取り、自身の SQL の
`WHERE` / `INSERT` に必ず適用する。cross-project の participants / event scope 漏れは
PR#229 で修正済み（[[grimodex-agent-writes-xproj-scope-fix]]）。

**backend の active-project 照合は未導入**。すなわち backend は payload の
`project_id` を信頼し、それが「今アクティブなプロジェクト」と一致するかを
突き合わせない。

### 3. raw db_execute (drizzle sqlite-proxy の生 SQL) — FE スコープ

FE は `db_execute` / `db_execute_batch` に**生 SQL 文字列 + params**を送る
（`src/db/client.ts`）。project スコープは FE のクエリビルダ / raw SQL が
`useTreeStore.projectId` を注入し fail-closed で担保する。backend は任意 SQL を
実行するのみで、どのプロジェクトの操作かを知らない。

## なぜ raw db_execute は backend 強制できないか

sqlite-proxy が「生 SQL 文字列を送って実行」する契約であるため、backend で行値
スコープ (`project_id = <active>`) を強制するには、送られた任意 SQL を parse して
述語を検証するか、rusqlite authorizer を使うしかない。前者は schema drift に弱く
偽陽性/偽陰性のリスクが高い。後者はテーブル/列粒度までで**行値スコープを表現
できない**。per-project view + base table 権限剥奪も、FE が base table 名を直接
参照するため破綻する。

→ 現実解は「FE スコープを制御として維持し、強制は typed surface (MCP /
agent_writes) に寄せる」。raw db_execute の backend 強制は、生 SQL 契約を捨てて
機微な読み書きを typed コマンドへ移行する別イニシアチブ (15 人日超) が必要で、
本 defer のスコープ外。

## agent_writes の active-project ガード — 意図的 defer とその理由

監査の「in-app 面も backend 強制せよ」に応える形は、backend に active-project を
持たせ agent_writes で `payload.project_id == active_project` を照合すること。
だが本監査 defer の第1スライスでは**見送る**。理由:

1. **security boundary にならない**: renderer は `payload.project_id` と
   `set_active_project` の**両値を供給**できる。compromise した renderer は両方を
   偽装できるため、このガードが防げるのは **FE のバグ**（stale な projectId を
   掴む等、XPROJ-1 級）だけ = consistency / bug-catch であって境界防御ではない。
2. **net-new な FE 配線**: backend には現状 project の概念が無く
   (`WorkspaceState` は workspace 粒度のみ)、project 切替を backend に伝える既存
   チョークも無い。`set_active_project` コマンド + `projectStore.loadProject` /
   `reloadProjectData` への配線 + 18 コマンドの計測が要る。
3. **race リスク**: project 切替の最中に発行済みの正当な in-flight write を
   誤って reject しうる。

### 推奨ロールアウト (follow-up として実施するなら)

1. `WorkspaceState` に `active_project: Mutex<Option<String>>` + `set_active_project`
   コマンドを追加し、`reloadProjectData`（全 project アクティベーションのチョーク）
   から配線する。
2. agent_writes の共有ラッパ (`with_db_project` 等) で mismatch を**まず
   shadow (tracing::warn, 非 fatal)** で検出する。active_project 未設定時は
   fail-open。これで破壊リスクゼロのまま XPROJ バグ検出のテレメトリを得る。
3. shadow ログがクリーンと確認できたら **reject へ flip**。project 切替 race の
   誤 reject を避けるため、既存の `switching` quiesce ロジックを鏡像する。
4. cross-project が正当な機能 (プロジェクト一覧 / 横断検索) は明示 exempt。

## 現状評価 (この doc の結論)

監査の「project 境界 backend 強制」は、**信頼できない真の脅威面 (MCP) では既に
強制 + テスト済み**。in-app 面 (agent_writes) は FE 信頼 + scoped-SQL + PR#229
hardening で運用され、raw db_execute は sqlite-proxy 契約上 backend 強制が原理的に
非現実的。残る active-project ガードは上記の限定価値のため follow-up として defer
する。関連: [[grimodex-master-security-audit]] / [[grimodex-arch-audit-defer-execution]]。
