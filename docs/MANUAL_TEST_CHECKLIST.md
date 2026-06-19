# Grimodex 手動デバッグチェックリスト

リリース前 / 大きめの変更後の手作業確認用。  
各項目は **ゴールデンパス → 主なエッジケース → 副作用監視** の順。  
DevTools の Console / Network / Performance タブ、Tauri のターミナルログを開いた状態で実施すること。

## 0. 事前準備

- [ ] `pnpm tauri dev` 起動。Rust ビルド警告・パニック・`unwrap` 由来エラーが出ていない
- [ ] DevTools Console にエラーなし（Source Map 警告除く）
- [ ] WAL ジャーナル (`*.db-wal`, `*.db-shm`) がプロジェクト DB と同階層に作成されている
- [ ] 既存プロジェクトを 1 つ開いた状態でスナップショットを取り、ロールバック可能にしておく
- [ ] テスト用に「空プロジェクト」と「データ盛り済プロジェクト」を 2 つ用意

## 1. 起動・プロジェクト管理

- [ ] 初回起動: Onboarding Preflight が表示され、ステップ完走で閉じる
- [ ] プロジェクト新規作成: 名前バリデーション、重複名警告
- [ ] プロジェクト切替: Tree / Grid / Chat / Codex の中身が完全に入れ替わる（前プロジェクトの残骸が出ない＝projectScoping）
- [ ] プロジェクト削除 → ゴミ箱経由
- [ ] 起動時に最後に開いていたプロジェクトが復元される
- [ ] DB マイグレーションログ確認 (`migrate_tree_nodes_note_context` 等が一度だけ走る)
- [ ] サンプルプロジェクト投入 → Codex / Foreshadow / Beats が正しく seed される

## 2. レイアウト / Panel システム

- [ ] パネル on/off トグル（左/右/中央）。アニメ後にコンテンツが残らない / 消えない
- [ ] Splitter ドラッグでサイズ変更、ダブルクリックでリセット
- [ ] Layout preset 切替（執筆 / Codex 重視 / 校閲 等）。クロスフェードが破綻なし
- [ ] パネルを Stripe にドラッグで移動。Drop indicator が正しい帯に出る
- [ ] Stripe band を右クリック → コンテキストメニュー
- [ ] **Editor 閉 + center tool 全閉** で Stripe の Editor アイコンが残る（最近の修正 bb50e873）
- [ ] Side dock toggle、Bottom corner toggle
- [ ] ウィンドウリサイズで track 計算が破綻しない
- [ ] フルスクリーン / ウィンドウ最小化 → 復帰

## 3. Tree（章・シーン構造）

- [ ] 章作成・シーン作成・フォルダ作成
- [ ] リネーム（Enter 確定 / Esc キャンセル）、空文字バリデーション
- [ ] D&D 並べ替え（章間移動、フォルダ内、ネスト深い箇所）
- [ ] 複数選択 → 一括移動 / 削除
- [ ] 右クリックメニュー全項目（複製、ゴミ箱、エクスポート対象切替等）
- [ ] ツリー展開状態がプロジェクト再オープン後も保持される

## 4. Editor (TipTap)

### 4.1 基本入力

- [ ] 日本語 IME 入力中に確定前テキストが消えない
- [ ] タイピング coalesce が効き、保存が高頻度に走らない
- [ ] Undo / Redo（履歴ボタン + ⌘Z / ⌘⇧Z）
- [ ] 大量貼り付け（5万字程度）で固まらない
- [ ] シーン切替で前シーンが保存される（dirty フラグ消失）
- [ ] Tab 切替・閉じる時の Unsaved ダイアログ

### 4.2 リッチ機能

- [ ] ルビ（Ruby）: 挿入 / 解除 / 範囲選択挿入
- [ ] 圏点（EmphasisDots）
- [ ] シーン区切り (SceneBreakNode)
- [ ] Beat ノード挿入、Inline Synopsis 編集
- [ ] Find / Replace バー（⌘F）: 全置換、正規表現、前後ナビ
- [ ] Focus mode: 段落以外がフェードアウト → 解除で復帰
- [ ] Typewriter scroll: カーソルが画面中央付近に維持
- [ ] Cursor overlay / character fade アニメ
- [ ] Vertical preview（縦書きプレビュー）
- [ ] 文字数カウント / マイルストーン通知

### 4.3 連続空行 / Markdown 往復

- [ ] 連続空行 (`\n\n\n`) を含むシーンを編集 → 保存 → 再オープンしても本文が変わらない
- [ ] **既知**: 既存 file-backed mount の `A\n\n\nB` は編集→保存で `<p></p>` baked になる
      （memory: empty-paragraph-pmarkdown-baked）

### 4.4 コメント / 校閲注釈

- [ ] テキスト範囲選択 → コメント追加
- [ ] ホバーで CommentHoverPopover 表示
- [ ] コメント削除 / 解決
- [ ] Annotation（PostEffect）が編集後も範囲を追従

## 5. Tab system

- [ ] 複数タブ同時オープン（10 個以上）
- [ ] タブ並べ替え D&D
- [ ] タブグループ作成 / 解除
- [ ] 右クリック「他を閉じる」「右を閉じる」等
- [ ] 再起動後にタブ復元

## 6. Grid パネル

- [ ] Chapter 列 / Loose 列 / Container 列の表示
- [ ] シーンカード D&D（列内、列間、Container 内外）
- [ ] **D&D 後にカード位置が再フェッチでブレない**（memory: grid-movenode-residual）
- [ ] 60ms 級 longtask 観察（許容範囲内、memory: grid-dnd-longtask）
- [ ] 複数選択 → 一括 PoV / ラベル / ステータス変更
- [ ] Structure template 適用
- [ ] Card body の Codex chip / Foreshadow indicator / Label dots 反映
- [ ] Display toolbar の表示項目切替が即時反映
- [ ] Chapter picker popover、列リネーム、列削除
- [ ] フォルダカード操作
- [ ] **クリックで固まらない**（tiktoken init 済、memory: click-freeze-ensureTokenizer）

## 7. AI Chat

- [ ] 各 provider（OpenAI/Anthropic/local 等）で送受信
- [ ] Model picker 切替で価格表示が変わる
- [ ] Streaming 中の停止 / 再開
- [ ] 履歴パネルで過去会話を選択 → 復元
- [ ] Context 注入（シーン本文 / Codex / Foreshadow）。**方向ラベル**と長さ上限が機能（最近の修正 1090d3ce/dbe295ea）
- [ ] HTML コメントが escape されてプロンプトに混入しない
- [ ] サマリー生成 / 圧縮
- [ ] Spotlight suggestion / Agent suggestion の表示
- [ ] CLI / Codex 連携 API
- [ ] AI policy: 機能ごとに有効/無効が反映される

## 8. Codex

- [ ] Codex エントリ作成（人物/場所/組織/設定 等の型）
- [ ] 種別 seed が空プロジェクトでも 1 回だけ走る
- [ ] 本文中 `@mention` で候補表示・確定挿入
- [ ] 本文中の固有名詞をマッチして CodexHighlight が下線表示
- [ ] CodexPopover でホバー詳細
- [ ] Codex relation の追加 / 削除（**決定論的順序**、最近の修正 dbe295ea）
- [ ] 抽出ダイアログ: チャットから Codex 候補抽出
- [ ] Codex management panel: ソート、フィルタ、子要素 budget
- [ ] 文字クラス境界（漢字/かな/英数）でのマッチ精度
- [ ] Codex内部整合チェッカー: 別名衝突、重複/自己参照リレーション検出
- [ ] チェッカー指摘を × で dismiss（非表示）し、状態が project 単位で永続化される
- [ ] 非表示にした指摘は折りたたみ末尾の「再表示」で復帰可能

## 9. Foreshadow（伏線）

- [ ] 伏線作成 / ラベル自動派生
- [ ] エディタ上のマーク表示・ホバー popover
- [ ] チャプタータブで一覧
- [ ] Foreshadow panel: 状態フィルタ、stale 検出
- [ ] Foreshadow レーダータブ: 全伏線の回収状況を俯瞰、フィルタと状態別集計
- [ ] Past setup 提案
- [ ] Chapter 監査 (`auditChapter`)
- [ ] シーン内 foreshadow context 表示
- [ ] FK 診断エラーが出ない（最近の修正 dbe295ea）
- [ ] ピン外し時の例外処理（最近の修正 dbe295ea）
- [ ] Save anchors: 編集後もマーク位置が追従

## 10. Snippets

- [ ] スニペット作成 / 編集 / 削除
- [ ] エディタ内挿入

## 11. Labels

- [ ] ラベル作成 / 色変更 / 削除
- [ ] シーン/章/Codex への付与
- [ ] LabelDots がカードに反映

## 12. Beat システム

- [ ] Beat ノードを scene 内に配置
- [ ] PlacedBeatList / UnplacedBeatItem
- [ ] Beat の D&D 配置
- [ ] Beats Header
- [ ] Synopsis suggestion

## 13. Lint

- [ ] Lint 実行 → 該当箇所に下線
- [ ] Lint disable mark / block attr
- [ ] Gutter プラグインのアイコン
- [ ] 日本語ルール（typo confusable 含む、ローカル変更中）
- [ ] Auto resolve on fix（PostEffect 連動）

## 14. Post-effects（校閲・注釈）

- [ ] Typo fix 提案 → 受諾 / 拒否
- [ ] Annotation 追加 → エディタに反映
- [ ] Consistency 注釈
- [ ] Annotation の範囲解決（編集後の追従）
- [ ] Annotation 詳細パネル

## 15. Kouetsu（校閲）パネル

- [ ] Comments / Issues / Editorial タブ切替
- [ ] Issues scope bar
- [ ] 校閲フローの一連動作

## 16. Command Center / Command Palette

- [ ] ⌘K で起動
- [ ] シーン / Codex / Foreshadow / コマンドを横断検索
- [ ] プレビュー popover
- [ ] 結果クリックで該当箇所へ遷移
- [ ] フィルタバー

## 17. Import

- [ ] Markdown フォルダ import: タグマッピング、競合解決
- [ ] Novelcrafter import
- [ ] Kakuyomu import: マークアップ保持
- [ ] Import 後にツリー / Codex / Foreshadow が一貫

## 18. Export

- [ ] Export dialog: 章/シーン選択ツリー
- [ ] プリセット適用、ユーザープリセット保存
- [ ] Ruby フォーマット切替（kakuyomu / novelup / 青空 等）
- [ ] Validation エラー表示
- [ ] **Zip export**: hardBreak が `  \n` で出力される（memory: archive-strict-hardbreak）
- [ ] Generate export publish 経路（注: 一部 defer 中）

## 19. External Mount（file-backed scenes）

- [ ] 外部フォルダをマウント
- [ ] **並行 init で overlap エラーが出ない**（最近の修正 fce86d11）
- [ ] 編集 → ディスクへ writeBack
- [ ] 外部ファイル変更を検知して再読込
- [ ] アンマウント / 再マウント
- [ ] markdown breaks 設定の整合（memory: markdown-breaks-migration）
- [ ] ハッシュベースのリネーム検出

## 20. Trash Bin

- [ ] シーン/章/Codex/Foreshadow を削除 → ゴミ箱に入る
- [ ] 復元 → 元の位置に戻る
- [ ] 完全削除（purge）
- [ ] エディタからの D&D trash capture

## 21. History / Revision

- [ ] 編集履歴の Undo/Redo（HistoryButtons）
- [ ] Revision history modal: 過去スナップショットを表示
- [ ] Project snapshot 作成 / 復元
- [ ] スコープ別スナップショット

## 22. Timeline / Map / Matrix

- [ ] Timeline パネル: イベントの時系列表示・編集
- [ ] Map パネル: 場所ノードと関係線
- [ ] Matrix パネル: 行列ビュー、セル編集
- [ ] 大量データでスクロール・ズーム劣化なし

## 23. Writing Stats / 完走ペースメーカー

- [ ] 直近ペース計算（last 30日の暦日平均）→ 完走予定日表示
- [ ] 目標文字数設定 → 必要ペース表示（締切基準）
- [ ] 日別進捗トラッキング（streak、active days、today/last7/last30 集計）
- [ ] 本日の目標（daily goal）設定 → 進捗バー表示
- [ ] ヒートマップ表示（過去 N 週の日次活動の可視化）
- [ ] 締切に対する「間に合う/遅れる」判定と残り日数表示
- [ ] 文字数の内訳（人間 / AI / 不明）の棒グラフ
- [ ] AI 使用量統計（生成回数・推定コスト）
- [ ] パネルのリロードボタン、統計の最新化

## 24. Semantic Search

- [ ] 自然文クエリで関連シーン / Codex がヒット
- [ ] embeddings インデックスの再構築
- [ ] Lindera 辞書ロード成功（CI 赤の memory 確認）

## 25. Settings

- [ ] 各カテゴリ（プロジェクト・エディタ・AI・表示・キー・データ・Codex・マップ・Linter・使用法・ライセンス・概要）切替
- [ ] 保存 → 再起動後も反映
- [ ] AI policy preset 切替
- [ ] ショートカット変更

## 26. Onboarding

- [ ] Preflight card のステップ進行
- [ ] Sample tour 起動 / スキップ
- [ ] Spotlight が UI 要素に正しくアタッチ
- [ ] Tour gate（条件分岐）

## 27. Legal / Licenses

- [ ] About / Licenses パネルで OSS ライセンス一覧表示
- [ ] NOTICE / Third-party licenses リンクが開く

## 28. AI 運用ツール

- [ ] トークン予算 ETA: 月間上限設定、消化率ビジュアル、日次レート / 月末予測表示
  - [ ] 予算超過 / 接近時に非ブロッキング警告が表示される
  - [ ] 予算未設定時は警告が出ない
- [ ] プロンプト再利用ライブラリ: テンプレート作成 / 編集 / 削除、本文プレビュー、使用カウント表示
  - [ ] 新規テンプレート追加 → PromptTemplateEditorDialog 起動
  - [ ] テンプレート一覧表示と即座の適用可否
- [ ] A/B テスト: プロンプト / モデル比較パネル、採用ボタン
  - [ ] AbComparePanel で 2 構成を横並び表示
  - [ ] モデルラベル / プロンプト variant の表示
  - [ ] 採用（onAdopt）処理が反映

## 29. パフォーマンス / 安定性監視

- [ ] DevTools Performance で 1 分タイピング録画: 大きな longtask（>200ms）がない
- [ ] Memory tab: 30 分操作してリーク傾向がない
- [ ] 大量シーン（200+）のプロジェクトで Grid / Tree 開閉
- [ ] **Release ビルドで CSP 違反が出ない**（memory: csp-ipc-fallback。`connect-src` に `ipc: http://ipc.localhost`、`script-src` に `'wasm-unsafe-eval'` が必要）
- [ ] Rust 側 panic / `unwrap` の発生有無（ターミナルログ）

## 30. リグレッション固定ポイント（過去事故）

- [ ] file-backed mount overlap (fce86d11)
- [ ] Stripe の Editor アイコン消失 (bb50e873)
- [ ] Chat HTML コメント escape / FK 診断 / ピン例外 / relation 決定論 (dbe295ea)
- [ ] Context 注入の方向ラベル・長さ上限 (1090d3ce)
- [ ] Grid click 固まり（tiktoken prefetch）
- [ ] Framer Motion clip-path 補間（open 側 inset(-200px)）
- [ ] projectStore.test.ts のテスト分離問題（フルスイートでのみ落ちる、許容）

## 31. MCP 連携（本体バイナリ統一）

- [ ] 設定 → AI → **MCP 連携** に「この作品 / 全作品（ローカル用）」× 「読み取り専用 / ポリシー準拠」の
      コピーボタンが表示される（トグルではなく各ボタン＝即時コピー）
- [ ] ワークスペース未 open 時はボタンが disabled、open 時は有効
- [ ] 「この作品・読み取り専用」押下で `.mcp.json` がクリップボードへ。`command` が実 spawn 可能な本体パス
      （macOS は `…/Contents/MacOS/Grimodex`、Linux AppImage は `$APPIMAGE` の元ファイル）、
      `args` が `["mcp","--workspace","<dir>","--project","<現在のID>","--readonly"]`
- [ ] 「ポリシー準拠」押下では `--readonly` が**付かない**（書込は AI ポリシーに委譲）。
      「全作品」押下では `--project` の代わりに `--all-projects` が入る
- [ ] **統合パス（本体経由）**: `Grimodex mcp --workspace <ws> --readonly`（dev は
      `cargo run -- mcp …`）で stdio に `initialize` + `tools/list` を流し、現状 28 ツールが返る
      （プロジェクト管理 2 + read 20 + write 6）。GUI ウィンドウは開かない
- [ ] **プロジェクトスコープ（既定=pinned）**: `list_projects` が **bound 1 件のみ**返す。
      `select_project` を呼ぶと「pinned… start with --all-projects」エラー（他作品の id/title を漏らさない）
- [ ] **`--all-projects`（ローカル/信頼用）**: 付けて起動すると `list_projects` が全作品を列挙、
      `select_project(<別id>)` で切替成功。切替後に当該プロジェクトの read-by-id が読める。
      存在しない id は not found。クラウド用途では付けない（付けるなら `--readonly` 併用）
- [ ] **残置 standalone bin**: `cargo run -p grimodex-mcp -- --workspace <ws> --readonly` が
      従来どおり動く（repo-root `.mcp.json` の dev 設定も）
- [ ] **write gate**: `--readonly` 時に write 6 ツール（`create_foreshadow` / `update_foreshadow` /
      `create_snippet` / `create_codex_entry` / `update_codex_entry` / `propose_scene_body`）がエラー応答
- [ ] **XPROJ**: project A スコープのクライアントから project B の scene_id/entry_id を
      read-by-id しても not found（本体統一でエンドユーザー到達面が増えた点に注意）
- [ ] 🔴 **[要実機] Windows release**: GUI-subsystem 本体を実 MCP クライアントが spawn して
      stdio で tools/list が取れる（debug=console は容易だが release を証明しない）
- [ ] Linux headless: 本体は `libwebkit2gtk` を load-time リンクするため webkit 無し環境では
      `mcp` サブコマンドが起動しない（lean bin を使う）ことを確認・記録

---

## 実施記録テンプレ

```
日付: YYYY-MM-DD
コミット: <sha>
環境: dev / release
所要時間: __ min
NG 項目:
  - 項目番号 / 症状 / 再現手順 / 期待
TODO:
  -
```
