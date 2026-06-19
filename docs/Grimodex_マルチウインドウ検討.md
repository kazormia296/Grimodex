# Grimodex マルチウインドウ（参照窓）検討（2026-06-13 調査）

> ユーザー要望「マルチディスプレイ環境（4K + FullHD×2）で、特定の項目を別ウィンドウに常時表示しておきたい」を受けた実現性・ROI 調査メモ。3 軸（パネル棚卸し／窓間データ同期インフラ／Tauri 側の窓生成機構）を read-only で並列調査。全主張は file:line で裏取り済み（investigator 3 並列）。
>
> **本メモのアーキテクチャ判断は Grimodex 自前のコード（`external_mount/watch.rs` の broadcast emit、`externalWriteFeed`、screenshot panel-only 経路、共有 DB）のみを根拠とする。外部 OSS 実装は参照していない。**

## TL;DR

**「編集できる別窓」は低 ROI・高リスク＝やらない。「読み取り専用の参照窓」は工数=中（大ではない）で、defer 候補。**

- 現状 **マルチウインドウ機能は一切未実装**。`tauri.conf.json:14` のウィンドウ定義は 1 枚のみ、実コードで触る window API は `WindowControls.tsx` の `getCurrentWindow()`（既存窓の最小化/最大化/閉じる）だけ。
- **編集 detach（タブを別窓へ）は別タスク**として切り離す。TipTap インスタンスは webview の DOM に密結合で窓を跨げず、2 窓同一シーン編集は共有 DB 同一行を last-writer-wins で潰す＝過去の本文消失系バグと同型。multi-writer 調停が前提で**大**。
- **read-only 参照窓**は、この機能を普通は高くする 3 要素（窓間データ共有・パネル単独描画・変更通知）が**既に揃っている**ため工数=中。
- 着手判断: **今は defer**。出荷待ち backlog 優先。要望者層＝マルチモニタの本気ユーザー＝ドッグフーディング対象と合致するので「永久封印」ではなく「スコープ確定済みの backlog」として残す。

## スコープ定義

| | 内容 | 判定 |
|---|---|---|
| **IN** | read-only の参照窓。worldbuilding/継続性チェック系パネルを別モニタに常時表示し、編集中シーンに追従して情報を出す | 工数=中。本メモの対象 |
| **OUT** | エディタ（本文）の別窓 detach、参照窓からの本文編集・書き戻し | 工数=大。multi-writer 調停が前提。別タスク（§6） |

## 1. どのパネルを出すか（参照価値の棚卸し）

18 パネル（`src/features/layout/panelIds.ts:3-20` 列挙 → `panelComponents.tsx:30-47` で component、`panelRegions.ts:10-26` で region マップ）を「常時表示の参照窓」観点で分類。`editor` は中央執筆面でスコープ外。

### 高価値（read 優位・glanceable・write は意図的）

| パネル | file | 価値 | 備考 |
|---|---|---|---|
| **Codex Quick** | `src/features/tree/CodexQuickPanel.tsx:14` | 高 | アクティブシーンに自動追従し、必要な用語/設定だけ出す。最軽量・read-mostly。**第一候補** |
| **Related Scenes（関連シーン）** | `src/features/related-scenes/RelatedScenesPanel.tsx:36` | 高 | アクティブシーンに自動追従し、類似/関連シーンを hybrid 検索で提示。read 専用・glanceable で参照窓向き |
| **Foreshadow（伏線）** | `src/features/foreshadow/ForeshadowPanel.tsx:259` | 高 | 未回収の設定を常時可視化。落とし防止。write は `setSetupStrength` 等の意図操作のみ |
| **Matrix（シーン×キャラ出現表）** | `src/features/matrix/MatrixPanel.tsx:39` | 高 | 「X は 3 章以降出てる？」を一目で。継続性チェック。write は明示的セル toggle のみ |
| **Timeline** | `src/features/timeline/TimelinePanel.tsx:17` | 高 | 時系列/構成の俯瞰。drag で storyTime 変更（`updateStoryTime` :116-138）はあるが意図操作 |
| **Codex 本体** | `src/features/codex/CodexManagementPanel.tsx:1` | 高（read 限定） | 設定資料の全文・検索・タグ。ただし編集ペイン内蔵（`EditorPane` :1146）なので read 用途に限定する前提 |

### 中価値

Scenes/Tree（構造俯瞰だが主ナビゲータ＝グローバル `activeSceneId` を駆動）／Snippets（コピー元の棚だが detail は編集可）／Attribution（read-only 著者率ダッシュボードだが定期確認メトリック）／Writing Stats（`src/features/writing-stats/WritingStatsPanel.tsx:18`。執筆量/ヒートマップ/完走ペースの read-only メトリクスだが glanceable よりは定期確認向き）／Kouetsu 校閲（read-out 中心だがアクション志向）／Map・相関図（関係/世界の参照価値は高いが React Flow が node drag を即 persist＝誤編集リスク `MapCanvas.tsx:615,869,1255,1698`）。

### 不適（常時表示の受動窓に向かない）

Chat / Chat History（フォーカスを奪う AI 入力・ナビ）／Command Center Results（`src/features/commandCenter/CommandCenterResultsPanel.tsx:24`。入力前提の一時 UI＝検索結果リスト、選択でエディタが飛ぶ）／Grid（最重量 dnd、並べ替えが即 persist で誤操作・無駄）／Trash Bin（たまに使う復旧ツール＋背景 prune）。

### 現実的な参照窓ロードアウト

**Codex Quick ＋ Foreshadow ＋ Matrix（or Timeline）**。必要なら Codex 本体を read 用途で追加。

## 2. 窓間データ同期（既存資産で大半が解決）

### 2.1 ストアは窓を跨がないが、ストアはただの DB キャッシュ

全グローバル状態は Zustand（feature ごと 1 ストア、中央ストア無し）。`create()` は module-scoped singleton ＝ **別 WebviewWindow（別 JS realm）はストアの新規コピーを持ち、`set()` は伝播しない**。

しかし**真の source of truth はストアではなく Rust 側 SQLite**。ストアは `db_execute` で hydrate されるキャッシュにすぎない。よって窓 B は「ストアを共有」する必要はなく、**自分のストアを共有 DB から hydrate ＋ いつ再 hydrate するかを知る**だけでよい。

### 2.2 既に存在する 3 つの資産

| 資産 | file | 効能 |
|---|---|---|
| **共有 DB（`db_execute`）** | `src/db/client.ts:9` → `src-tauri/src/database.rs:13` | drizzle sqlite-proxy が全クエリを単一 `Mutex<Connection>`（WAL）へ。**DB は既に全窓共有**。窓 B が read するのは同じ invoke を撃つだけで**コード変更ゼロ** |
| **`externalWriteFeed`（change_events ポーリング）** | `src/features/concurrency/externalWriteFeed.ts:243`（起動 `projectStore.ts:165`） | 750ms ごとに `change_events` を `sequence>cursor AND sessionId!=self` で取得し、tree/codex/snippet/foreshadow を再ロード。MCP/エージェントの second-writer 用に作った仕組み。窓 B は自前 sessionId を持つので**窓 A の書き込みが窓 B には「外部書き込み」に見え、自動再ロードされる** |
| **Rust→全窓 broadcast emit** | `src-tauri/src/external_mount/watch.rs:165-190`（FE: `useExternalMountListener.ts`） | `app.emit(channel, payload)` は Tauri v2 で**全ウィンドウへ配信**。debounce→typed channel→全窓 listen→re-sync の形が既に動いている。**「project データが変わった」汎用 emit の理想テンプレ** |

### 2.3 推奨同期アーキテクチャ（HYDRATE + INVALIDATE）

Rust+SQLite を既存の単一 source of truth として、参照窓は **hydrate（共有 DB から自前ロード）＋ invalidate（再ロード契機）** だけ。

- **Hydrate（流用・ほぼ 0）**: 窓 B が `treeStore.reloadTreeOrThrow`（`treeStore.ts:565`）/ `codexStore.loadEntries` 等をそのまま呼ぶ。共有 DB への純粋な再 fetch なので無改修で動く。
- **Invalidate（2 案）**:
  - **案 A（最安・v1 推奨の初手）**: 窓 B で `startExternalWriteFeed(projectId)` を回す。自前 sessionId のおかげで窓 A の書き込みを 750ms ポーリングで自動反映。**新トランスポート不要**。
  - **案 B（本命・低遅延）**: `external_mount/watch.rs:190` のテンプレを流用し、mutating command（or `timelapse_append_batch`）時に `app.emit("data://changed", {projectId, domains})`。全窓配信→窓 B が `lib/tauri.ts:58` で listen→再 hydrate。750ms 遅延と後述の timelapse 依存を解消。

**初手は案 A、本番は案 B**。窓 B は v1 では read-only に固定し write-back は考えない。

## 3. 設計上の割り切り・避けるべき罠

- **割り切り（重要）**: `activeSceneId` 等の結合状態は DB 行を持たず伝播経路が無い — `projectStore.currentProjectId`（`projectStore.ts:31`）、`tabStore.activeTabId`（`tabStore.ts:42`）、`focusedContentEditorStore.currentEditorRef`（DOM 結合の live Editor、窓を跨げない）。よって**窓ごとのシーン文脈は無い**。参照窓は「**今編集中のシーンに追従**」が自然形。「編集中とは別シーンを固定参照」したいなら per-window scene 状態の新設が要る（＋工数）。今回の要望（「この項目を常時表示」）は追従型でほぼ満たせる。
- **罠（latent bug）**: 案 A の `change_events` 発行は **timelapse フラグに gate**されている（`recorder.ts:242` で timelapse OFF 時 `recordChangeEvent` は no-op、flag は `toggle.ts:34` 既定 ON だがユーザー切替可、OFF→ON で履歴 wipe）。timelapse を切ると参照窓が**静かに stale 化**する。→ 本番は案 B（Rust broadcast emit）にして timelapse 非依存にするか、change_events 発行を timelapse gate から切り離す。
- **プロジェクト切替**: `projectStore.loadProject`（`projectStore.ts:75`）は重い orchestration（feed 停止→`currentProjectId` 更新→reloadProjectData→recorder 再 init→feed 再開、世代トークンで race guard）。窓 B は別 projectStore を持ち窓 A の切替を知らない → project 切替の broadcast＋窓 B 側の teardown/再 hydrate が要る。2 窓が別プロジェクトを指す状態は UI 不整合の温床（DB 接続は共有、change_events は project スコープなので cursor は綺麗に分岐する）。

## 4. Tauri 側の窓生成機構

### 4.1 現状の窓設定

`src-tauri/tauri.conf.json:12-31`。`app.windows[0]` は単一前提で 1 要素（`decorations:false`, `transparent:true`, `macOSPrivateApi:true`, `zoomHotkeysEnabled:false`, 800×600）。CSP は `app.security.csp`（:28）で**アプリ全体共通＝全窓継承**、`ipc:`/`http://ipc.localhost` 許可済み。macOS は `tauri.macos.conf.json:5-22` で decorations/titleBar をオーバーライド。

- **継承する**: CSP / macOSPrivateApi / frontendDist（同一 index.html）はプロセス共通。
- **継承しない**: `windows[0]` の各プロパティ。JS から `WebviewWindow` 生成時は transparent/decorations を個別指定が必要（指定しないと glass-shell 前提の現 UI が崩れる）。

### 4.2 capability の決定的ギャップ

capability は `src-tauri/capabilities/default.json` 1 本のみで `"windows": ["main"]`（:5）に scope。付与権限に **`core:webview:allow-create-webview-window` が無い**（`core:default` 不含）→ **現状 JS からの窓生成は ACL で拒否される**。これが前提作業の floor。

参照窓（label 例 `"reference"`）に必要なこと:
1. 生成側（main）の capability に `core:webview:allow-create-webview-window` を追加。
2. 新 label を権限付与対象に。(a) `default.json` の `"windows"` を `["main","reference"]` に拡張、または (b) `capabilities/reference.json` を新規作成し最小権限（`core:default`, `core:event:allow-listen/allow-emit`, `core:window:allow-start-dragging`, `core:window:allow-close`）に絞る。read-only なので dialog/window-state は省略可。
3. `gen/schemas/`・`acl-manifests.json` は生成物、手編集しない。

### 4.3 パネル単独描画（前例あり）

URL ルーターは存在しない（`main.tsx:59-65` が単一 `<App/>` をマウント、`App.tsx` は `useWorkspaceStore.view` で出し分けるのみ）。**だがパネル単体描画の前例が既にある**＝スクリーンショット撮影モード:

- `screenshotBootstrap.ts:23-43` の `getScreenshotPanelId()`/`isScreenshotCapture()` が localStorage を読み、`App.tsx:672-674` が `<LayoutShell hidden screenshotPanelId={...}/>`、`LayoutShell.tsx:177-190` が stripe/grid を全スキップし単一 `<SlotView panelId={...}/>` をフルスクリーン描画。
- **これが「窓 B が Codex/Timeline だけ描く」のほぼ完成形**。`?panel=codex`（or `getCurrentWindow().label`）で同型の panel-only 分岐を追加すれば `SlotView`/`EditorArea` をそのまま再利用できる。

### 4.4 軽量 bootstrap（DB 再 open 不要）

通常起動は `open_workspace`（`workspace/store.ts:175-229`）で DB open + 多数 migration を走らせるが、**DB は Rust プロセス側 `WorkspaceState` に既に開いている**ため窓 B は再 open 不要。窓 B が要るのは:

1. `useProjectStore.getState().initCurrentProject()`（`projectStore.ts:52-64`、`listProjects()` を共有 DB から読むだけ）で project id 確定。
2. 対象 store の load（Codex なら `codexStore.loadEntries`、Timeline なら timeline load）— `bootstrapScreenshotWorkspace()`（`screenshotBootstrap.ts:49-54`）と同パターン。
3. settings/theme は `settingsStore.loadAll()` ＋ `App.tsx:140-176` のテーマ/フォント effect を流用。

全 Tauri command は `tauri::State<'_, WorkspaceState>` を取るだけで呼び出し元窓を問わない → 参照窓からの read invoke はそのまま通る。

## 5. 工数見積

**読み取り専用 Codex/Timeline 参照窓 = 中（M）**:

| 作業 | 規模 |
|---|---|
| capability に webview-create 権限＋reference 窓権限を追加 | 小 |
| `WebviewWindow` 生成 ＋ URL/label スイッチ | 小 |
| panel-only マウント分岐（screenshot 前例に倣う） | 小〜中 |
| 窓 B の軽量 bootstrap（initCurrentProject→対象 store load＋theme） | 小〜中 |
| 窓間データ同期 listen の新設（案 A 流用 or 案 B emit） | 中（front 発 emit/listen は現状ゼロからの新設） |

**編集サーフェスを含めると一気に大**（§6）。

### 単一窓前提の残骸（要対応 or 省略）

- `src-tauri/src/lib.rs:33` `get_webview_window("main")`（vibrancy）は label 決め打ち。参照窓の vibrancy は別配線（read 窓なら不要かも）。
- capability `default.json:5` `["main"]` 固定（最大の作業ポイント）。
- window-state プラグイン（`lib.rs:69`）の `window-state:*` 権限が "main" 限定 → 参照窓は要追加 or 省略。

## 6. editor detach がスコープ外である根拠

- TipTap は `EditorPane.tsx:509` の `useEditor` でペインごとに**その窓の JS context にローカルなインスタンス**として生成、ProseMirror state・NodeView・編集中 doc が webview DOM に密結合 → 窓間でシリアライズ移送不可。
- 保存経路も窓ローカル（`editorSaveRegistry`＝flush 正本、linear 用 `linearEditorStore.registerEditor`）。2 窓で同一シーン編集 → 各 TipTap が独立 doc を持ち、それぞれの unmount/pending flush が共有 DB 同一行へ書き戻し → **last-writer-wins で本文消失**（drizzle sqlite-proxy は invoke ごと独立で read-after-write 保証無し）。
- 帰属追跡（human/ai/unknown）も単一編集サーフェス前提で、複数窓の編集主体を 1 doc に統合する契約が無い。

→ 別窓は**読み取り専用の参照パネルに限定**するのが正しい線引き。編集 detach は multi-writer 調停・doc 所有権の単一化が前提の別タスク。

## 7. 推奨 / 次の一歩

- **判断**: 今は **defer**（出荷待ち backlog 優先）。スコープ確定済みの backlog として保持。
- **やるときの最小形**: read-only 参照窓（Codex Quick / Foreshadow / Matrix / Timeline 限定）、同期は案 A 初手→案 B 本命、bootstrap は screenshot 前例流用、編集 detach は別タスク。
- **避ける罠**: timelapse OFF で案 A が静かに死ぬ → 本番は案 B（Rust emit）。
- **PoC の最短経路**: capability に webview-create 付与 → `WebviewWindow("reference", {url:"index.html?panel=codexQuick", transparent:true, decorations:false})` 生成 → `App`/`LayoutShell` に panel-only 分岐追加 → `initCurrentProject`＋`loadEntries`＋theme → `startExternalWriteFeed` を窓 B でも回す。

---

> 調査根拠: investigator 3 並列（panel inventory / sync infra / tauri mechanics）、全 file:line 裏取り済み。本メモ作成時点でマルチウインドウ関連コードは存在しない（grep: WebviewWindow / popout / secondary は実コードヒット無し）。
