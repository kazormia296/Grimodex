# Grimodex 手動デバッグチェックリスト

リリース前 / 大きめの変更後の手作業確認用。  
各項目は **ゴールデンパス → 主なエッジケース → 副作用監視** の順。  
DevTools の Console / Network / Performance タブと Electron main process のターミナルログを開いた状態で実施すること。

## 0. 事前準備

- [ ] native 変更後は `pnpm napi:build`、通常は `pnpm electron:dev` で起動。preload / main / N-API のロードエラーや Rust panic が出ていない
- [ ] DevTools Console にエラーなし（Source Map 警告除く）
- [ ] `window.grimodex.shell === "electron"`。renderer から Node API が見えず、preload API だけが公開されている
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

- [ ] Chromium で日本語 IME 入力中に確定前テキストが消えず、確定時に重複しない
- [ ] Linux Wayland セッションで横書き・縦書きの変換候補位置、composition、確定後の caret が崩れない（可能なら XWayland とも比較）
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

- [ ] 指摘（受信箱）/ コメント / ブロッカー のタブ切替
- [ ] 指摘タブのスコープバー（シーン / フォルダ / プロジェクト + 開いている / 除外 フィルタ）
- [ ] 全体チェック（選択観点を固定順で直列実行・中止で残りスキップ）
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
- [ ] **Release ビルドで `app://bundle/` がロードされ CSP 違反が出ない**（`connect-src 'self'`、`script-src 'self' 'wasm-unsafe-eval'`。`ipc:` URL へ依存しない）
- [ ] Electron main / preload の未処理例外、N-API 側 panic / `unwrap` の発生有無（ターミナルログ）

## 30. リグレッション固定ポイント（過去事故）

- [ ] file-backed mount overlap (fce86d11)
- [ ] Stripe の Editor アイコン消失 (bb50e873)
- [ ] Chat HTML コメント escape / FK 診断 / ピン例外 / relation 決定論 (dbe295ea)
- [ ] Context 注入の方向ラベル・長さ上限 (1090d3ce)
- [ ] Grid click 固まり（tiktoken prefetch）
- [ ] Framer Motion clip-path 補間（open 側 inset(-200px)）
- [ ] projectStore.test.ts のテスト分離問題（フルスイートでのみ落ちる、許容）

## 31. MCP 連携（Electron + standalone sidecar）

- [ ] 設定 → AI → **MCP 連携** に「この作品 / 全作品（ローカル用）」×
      「読み取り専用 / ポリシー準拠」のコピーボタンが表示される
      （トグルではなく各ボタン＝即時コピー）
- [ ] workspace 未 open・未 hydration・switch 中はボタンが disabled。config 取得中に
      workspace path / open revision / project ID が変わった場合も clipboard へ書かずエラー表示
- [ ] **コピー契約**: `command` は本体 GUI ではなく standalone
      `grimodex-mcp[.exe]` の絶対 path。`args` は
      `["--license-file","<絶対 userData/license.json>","--workspace","<dir>","--project","<現在のID>","--readonly"]`。
      license path は Backend と同じ `userData` 配下で、renderer 入力から変更できない
- [ ] Linux AppImage では sidecar が一時的な `/tmp/.mount_*/…/resources/bin` ではなく
      `<userData>` 配下の安定 path へ materialize され、GUI 終了後・再起動後・update 後にも
      コピー済み config から spawn できる
- [ ] 「ポリシー準拠」では `--readonly` が付かない（書込は AI ポリシーに委譲）。
      「全作品」では `--project` の代わりに `--all-projects` が入る
- [ ] **Electron standalone path**: UI がコピーした `command` / `args` をそのまま MCP client で
      起動し、`initialize` + `tools/list` が成功する。product sidecar は
      `pnpm mcp:build:release`（`licensing` feature 有効）の成果物である
- [ ] **license authority parity**: Electron の activation / trial 状態と sidecar の write gate が
      同じ `<userData>/license.json` を参照する。expired / stale / revoked では read は成功し、
      write は拒否される
- [ ] **プロジェクトスコープ（既定=pinned）**: `list_projects` が bound 1 件のみ返す。
      `select_project` は pinned error（他作品の id/title を漏らさない）
- [ ] **`--all-projects`（ローカル/信頼用）**: `list_projects` が全作品を列挙し、
      `select_project(<別id>)` 後に当該 project の read-by-id が読める。存在しない id は not found。
      クラウド用途では付けない（付けるなら `--readonly` 併用）
- [ ] **dev / headless standalone**: `cargo run -p grimodex-mcp -- --workspace <ws> --readonly`
      が動く。Electron parity を見る場合は `--license-file <absolute path>` も付ける
- [ ] **write gate**: `--readonly` 時に write 14 ツール（foreshadow 2 / snippet 1 /
      codex 2 / scene prose 1 / chronicle 8）がすべて call-time error。list-time では隠れない
- [ ] **XPROJ**: project A スコープの client から project B の scene_id / entry_id を
      read-by-id しても not found
- [ ] **[要実機] Windows release**: packaged `resources/bin/grimodex-mcp.exe` を実 MCP client が
      spawn し、stdio で `initialize` + `tools/list` が取れる
- [ ] Linux headless: standalone sidecar が GUI session や desktop shell library なしで起動できる

## 32. Tauri v1 → Electron 移行（legacy 互換）

- [ ] disposable Windows VM / CI user profile で、署名済み release candidate に対し
      `pwsh scripts/verify-windows-tauri-migration.ps1 -InstallerPath <Electron installer>` が完走する
- [ ] スクリプトが pinned Tauri v1 installer の SHA-256 を検証してからインストールする
- [ ] v1 の roaming / local user-data に置いた sentinel の存在と SHA-256 が移行後も変わらない
- [ ] v1 の `/P /R /UPDATE /ARGS` 呼び出しが Electron installer の silent install + restart に
      変換され、新 Electron executable の Authenticode 署名が有効
- [ ] v1 executable / uninstaller / registry 登録は除去され、Electron の uninstall 登録と
      Start Menu shortcut が各 1 件だけ残る
- [ ] Electron installer を再実行しても同じ状態を保ち、ユーザーデータを変更しない（idempotent）
- [ ] v1 uninstaller を壊した negative case は fail-closed で非 0 終了し、v1 本体・登録・
      user-data を削除しない
- [ ] 既存 v1 workspace を Electron で開き、DB migration 後も本文・Codex・チャット・設定が保持される
- [ ] release build 初回起動で既知の v1 keyring 資格情報を Electron `safeStorage` へ移せる。
      移行元は rollback 用に保持され、移行失敗時も破壊しない

## 33. IME 辞書連携（Electron）

- [ ] 日本語プロジェクトで読み付きCodex項目を作り、設定 → Codex → IME連携に
      `<userData>/ime/` の状態、検出consumer、書き出し件数が表示される
- [ ] **auto / consumerなし**: `consumers/` に有効なhandshakeがなければ
      `effectiveEnabled=false`で、`state.json`と`projects/*.json`を作成しない
- [ ] **auto / consumerあり**: 有効な`consumers/<id>.json`を配置してウィンドウを
      再フォーカスすると自動検出され、再起動なしでsnapshotとactive stateが作成される
- [ ] **on**: consumerがなくても書き出す。**off**: consumerがあっても常に優先して
      `state.json`と全project snapshotを削除し、その後のCodex編集でも復活しない
- [ ] **atomic repeated refresh**: name / alias / excluded alias / readings / typeを短時間に連続変更してもdebounce後の
      最終状態だけが反映され、監視中の全時点でJSONをparseできる。一時ファイルが残らず、
      refresh / off / clear / removeを重ねても古い要求が新しい状態を巻き戻さない
- [ ] 日本語project AからBへ切り替えると`state.json.active_project_id`がBだけを指す。
      projectを閉じる、main windowを閉じる、またはアプリを終了すると`null`へ解除され、
      floating panelだけを閉じてもmain windowのactive pointerは解除されない
- [ ] 作品言語を`ja`から非日本語へ変更すると保存済み`readings`は保持したまま、
      そのprojectのsnapshotが削除されactiveも解除される。`ja` / `ja-*`へ戻すと再生成される
- [ ] project削除で対応する`projects/<id>.json`が消え、削除projectがactiveなら
      `state.json`も解除される。他projectのsnapshotとconsumer handshakeは維持される
- [ ] 「書き出し済み辞書をすべて削除」で`state.json`と全project snapshotが消え、
      `consumers/*.json`は保持される。statusの書き出し件数は0になり、再refresh可能

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
