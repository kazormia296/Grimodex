# Grimodex Electron移行検討

- 日付: 2026-07-10
- ステータス: **移行を推奨**（採用判断が確定したら ADR-003 として記録する）
- 調査方法: コードベース精査4系統＋Web技術リサーチ4系統を並列実行し、判断を左右する5つの主張を一次情報（tauri-plugin-updater / better-sqlite3 / electron-updater のソースコード、npm registry 実体、crbug / bugs.webkit.org、実機 webkit2gtk 2.52.4）で敵対的に検証した。

## 結論（TL;DR）

**Electronへ移行すべき。ただし「大幅な書き換え」は不要で、当初の想定より条件は大幅に良い。**

1. **自動アップデートは失われない。** tauri-plugin-updater の検証は minisign 署名のみで配信物の中身を見ない（updater.rs:712, 1453-1463 で確認）。既存 minisign 鍵で署名した Electron 製アーティファクトを「最後の Tauri アップデート」として配信すれば、既存ユーザーは全チャネル（NSIS / AppImage / deb / rpm / .app.tar.gz）で自動的に Electron 版へ移行できる。移行後も electron-updater が全OSで機能する — macOS の署名必須要件は、**既に完備している Apple Developer ID 署名 + notarization**（release.yml:126-183）で満たせる。
2. **フロントエンドはほぼ無傷。** IPC は `src/lib/tauri.ts`（131行）に集約済みで、75ファイル・invoke約209箇所はラッパー1枚の差し替えで無変更。直接 `@tauri-apps/*` を触るのは本体19ファイルのみ。テスト79ファイルも `@/lib/tauri` の vi.mock なので無変更。
3. **Rustバックエンド（約74.5k LOC）は書き直さず温存する。** Tauri固有の糊は全体の約5%（2,200〜2,500行）。napi-rs でネイティブモジュール化（または sidecar プロセス化）すれば、migrate.rs 3.9k行・agent_writes 4.2k行のトランザクション/監査ロジックというデータ破損リスクの本丸に触らずに済む。lindera（UniDic同梱 +200MB）は JS 同等品が存在しないため、Rust温存はどのみち必須。
4. **上流に期待できないことは実測で確定している。** 実機 webkit2gtk 2.52.4 で6バグ全て再現済み。Tauri公式CEFはETAなし（メンテナ発言 2026-01-13）、Servo は縦書き自体が未実装、wry に WPE バックエンドは存在しない。
5. 最大の新規リスクはレンダリングではなく **Linux Wayland の日本語IME**（後述、Phase 0 でスパイク必須）。

---

## 1. 背景 — 何に出血しているか

WebKitGTK 起因の縦書きエンジンバグ6種（button縦書き拒否 / inline+abspos paintズレ / Alt keyup / focus selectionリセット / 傍点描画 / vertical-rl scrollLeftリセット）への回避コードが蓄積している。

### 回避コードの現在規模（grep + 実読で定量化）

| 区分 | 規模 | 内容 |
|---|---|---|
| TS 実装 | 約660行 | `useWebKitGtkVerticalScrollResetGuard.ts`(194) / `webkitFocusScrollGuard.ts`(70) / `EmphasisDotsFallbackPlugin.ts`(88) / `useEmphasisDotsFallback.ts`(36) / `verticalFormControls.ts`(24) ほか |
| CSS | 約130行 | `src/index.css` の `html[data-engine="webkitgtk"]` ゲート **29セレクタ** |
| Rust | 約190行 | `webkit_features.rs`(136行, unsafe dlsym FFI) + lib.rs 配線 + NVIDIA DMABUF 回避 |
| 専用テスト | 約1,060行 | 上記を gate する browser test 含む |
| **合計** | **約2,030行** | Chromium化で全量削除可能 |

### 出血速度

- **直近3日（7/8〜7/10）だけで WebKitGTK/Linux 描画起因の修正が8コミット +3,427/−369行**（純粋に WebKitGTK 起因のものだけで6コミット +2,786行）。現在の作業ブランチ `fix/vertical-ui-and-drag-handle-bugs` と未コミットの index.css 変更も同種の作業。
- スクロールリセットガードは同一バグに対して**3回作り直し**が発生（f8232058 → 46cb1d7f → 8c85747e の三層化）。
- 回避策の性質が悪い: 6バグ中 feature flag で直せたのは1つ（`VerticalFormControls`）だけで、しかもその適用は「web process 強制 terminate → 明示 load_uri」という公式想定外の手順（黒画面リスクの実測注記あり）。残り5つは 0/50/150/300ms の多段再アサート等の**タイミング依存ヒューリスティック**。paint系バグは computed style が正常なため **Chromium ベースの CI では検出不能** = 自動テストで守れない。

### 上流の見込み（Webリサーチ + 実機検証）

- 実機 **webkit2gtk 2.52.4 で6バグ全て再現**。WebKitGTK 2.50 リリースノートの「vertical writing improvements」では解消していない。2.52 のリリースノートには縦書きへの言及自体がない。
- `VerticalFormControls` は WebKit 本体で status=stable（Safari 17.4 で2024年に出荷済み）なのに、GTK ポートでは 2.52 でも既定OFF。
- Grimodex が踏んだ5件は bugs.webkit.org に該当報告が見つからず、**修正の起点自体が存在しない**。WebKit の縦書きバグは報告から解消まで10年超の前例あり（bug 117228: 2013年報告、bug 65917: 2011年報告）。
- Tauri メンテナ FabianLars 自身が「WebKitGTK はリリースごとに不安定化しており Linux サポートを完全には推奨できない」と公言（tauri discussion #8524）。

## 2. 移行で消えるもの / 残るもの

- **消える**: 上記2,030行全量 + `webkit2gtk`/`glib` 依存 + NVIDIA DMABUF 回避 + macOS(WKWebView) 限定の少数ガード（role=list復元、↑/↓キャレット置換等、全て WebKit 起因）。
- **Windows(WebView2=Chromium) 限定の描画回避策はゼロ**だった — 「Chromium化で描画バグが消える」仮説の最強の裏付け。実ユーザーの最多ダウンロードは一貫して Windows exe であり、**主力ユーザーは既に Chromium 上で動いている**。
- **残る**: `VerticalCaretNavExtension` の ←/→ 列移動（約56行+テスト約100行）— これは **Chromium 自身の** vertical-rl hardBreak 境界キャレットバグへの対策で全エンジン適用。ShowInvisibles の背景方式（Windowsフォントフォールバック問題も担う汎用化済み）。isMac 系のOSキーボード規約分岐 約1,300行（エンジン非依存）。

## 3. 移行コストの実測

### フロントエンド（小さい）

- `src/lib/tauri.ts`（131行）が invoke を一元ラップ。**75ファイルが経由**しており、Electron の `ipcRenderer.invoke` 分岐を足すだけで大半が無改修。
- DB は `src/db/client.ts` の drizzle **sqlite-proxy → invoke("db_execute")** の1点経由。Electron 側に `db_execute` 相当を生やせばスキーマ・クエリ・feature コードは完全無傷。
- ラッパーをバイパスする直 import は本体19ファイル（invoke直4、listen直1、Window API 2、WebviewWindow 1、dialog/fs 3、notification 1、opener 3、updater/process 1、app 2、webview 1）。
- ドラッグ領域は `data-tauri-drag-region` 属性宣言 → CSS の `-webkit-app-region: drag` へのマッピング数行で JSX 無変更。
- browser-mock（sql.js、1,766行）で **Tauri なしにフロント全体が動く実績が既にある**。
- 意味的な再設計が要るのは3点のみ: close veto（App.tsx の onCloseRequested）、パネル別窓（`panelWindow.ts` の WebviewWindow）、emit の全窓ブロードキャスト契約。
- **見積り: 変更45〜50ファイル・450〜600行 + 新規 main/preload 400〜600行。** テスト79ファイルは `@/lib/tauri` mock のため無変更、生 `@tauri-apps/*` を mock する20ファイルのみ張り替え。

### Rustバックエンド（温存が正解）

- `src-tauri/src` 53,954行 + workspace crates 24,737行（core 4,409 / lint 7,740 / mcp 12,588）≈ **74.5k行**。Tauriコマンド正本は145個（`lib.rs` の generate_handler!）。
- ただし **Tauri固有の糊は約2,200〜2,500行（約5%）**。ai.rs 6,772行中 `tauri::` 参照は2箇所、といった具合に純ロジック比率は約95%。crates/ は完全に Tauri/UI 非依存。
- Node への全面書き直しは棄却する理由が明確:
  - `migrate.rs`（3,917行）+ `agent_writes.rs`（4,205行、BEGIN IMMEDIATE 1トランザクションでの原子的書き込み+undo_journal+監査チェーン）の移植は**データ破損リスクの本丸**。
  - `grimodex-lint` は lindera（embed-unidic、+200〜250MB）依存で **JS に同等品がない**（kuromoji.js は IPADIC で精度劣後）。
- **推奨: napi-rs でネイティブモジュール化**（第一候補）または stdio RPC の sidecar プロセス化（代替）。イベント（emit 約55箇所・19種、全て名前付きチャネル+JSON push）は napi-rs の threadsafe function → `webContents.send` に機械写像できる。
- Node 側へ移すのは小物のみ: notify→chokidar、fontdb→`queryLocalFonts()`、keyring→safeStorage、dialog/fs/opener/notification/window-state→Electron標準、vivliostyle→child_process（現行も subprocess なので実質同じ）。
- MCP サーバ: スタンドアロン `[[bin]] grimodex-mcp` が既存なので extraResources 同梱で**書き換えゼロ**。ただしユーザーの `.mcp.json` に本体バイナリ絶対パスが静的に書かれているため、`grimodex mcp` 互換の起動契約を残すか移行案内が必要。

## 4. 自動アップデート — 「失う」前提は崩れた

敵対的検証で **confirmed**（tauri-plugin-updater 2.10.1 のソースで確認）:

- updater の検証は「配信バイト列への minisign 署名」**のみ**。アプリ同一性・フォーマット・OS署名は一切見ない。`tauri signer sign` は任意ファイルに署名できる。
- したがって**「最後の Tauri リリース」として Electron 製アーティファクトを配信するブリッジが全チャネルで成立する**:
  - **Linux AppImage**: APPIMAGE パスへ in-place 書き込み+実行権限継承。最もクリーン。
  - **deb/rpm**: v0.10.4 の latest.json に linux-x86_64-deb/-rpm キーが実在し、pkexec dpkg -i / rpm -U で更新される。Electron 側 deb の Package 名を `grimodex` に一致させれば正規アップグレード。
  - **Windows NSIS**: PE exe と判定されれば ShellExecuteW で実行。electron-builder NSIS がそのまま走る。ただし `/P /R /UPDATE` は Tauri 独自フラグなので passive UX にはならず、旧インストール（$LOCALAPPDATA\Grimodex + HKCU Uninstall）の残骸掃除をインストーラに仕込む。
  - **macOS**: tar.gz の .app を署名・quarantine 確認なしで丸ごと置換。
- **移行後**: electron-updater（GitHub Releases provider、公開リポジトリはトークン不要）が NSIS / AppImage / deb / rpm / macOS zip を更新できる。macOS は署名必須だが **Apple Developer ID 証明書 + notarization（App Store Connect API キー方式）は release.yml:126-183 で完備済み**なので要件を満たす。Windows/Linux は無署名でも動く（現状と同じ）。

### 運用上の必須事項

1. **旧クライアント向け latest.json の永続同梱**: endpoint は `releases/latest/download/latest.json` 固定なので、移行後の**全リリース**に「ブリッジ用最終 Tauri リリースのアセットを指す tauri 形式 latest.json」を複製同梱し続ける（404 はサイレント失敗 = 休眠ユーザーが永遠に取り残される）。
2. **バージョン運用**: v1.0.0 は Draft + タグ push 済みで番号消費済み。Electron 初版は配布済み全版より大きい semver（**v2.0.0 推奨** — ランタイム交換はメジャー相当）。プレリリースタグ（ハイフン付き）は `releases/latest` に載らないため、Electron ベータは旧 Tauri ユーザーの updater から見えない — ベータ運用に好都合。
3. **データ移行**: app_data_dir（`com.miyakey.grimodex`: global-settings.json / ai-settings.json / license.json / models/）は Electron の userData 既定と異なる。`app.setPath('userData', ...)` で明示するか初回マイグレーション。
4. **APIキー**: keyring（service名 `grimodex-*`）→ safeStorage への再保存マイグレーション（初回起動時に読み出して移す or 再入力）。ライセンスキーは平文 license.json なので Node から直接読める。`POLAR_EXPECTED_BENEFIT_ID` 定数を維持すればメジャーを上げても既存キーは有効。
5. release.yml は version の major>=1 で自動的に `--features licensing` を付けるため、ブリッジ用 Tauri 最終版は必然的に licensing 有効ビルドになる（挙動確認を Phase 4 に含める）。

## 5. 検証で付いた留保（新規リスク）

| リスク | 深刻度 | 対処 |
|---|---|---|
| **Linux Wayland の日本語IME**: Electron/Chromium は `--enable-wayland-ime` 等のフラグなしで fcitx5/ibus が壊れる報告が継続中（vscode #277073）。執筆アプリには生命線 | **高** | **Phase 0 スパイク必須**。フラグ組込み（`app.commandLine.appendSwitch`）+ X11/Wayland 両検証。WebKitGTK は GTK ネイティブで IME が通っていた点は正直に「後退しうる」と認識する |
| Chromium 自身の vertical-rl キャレットバグ（hardBreak 境界） | 低 | **既に対処済み**（VerticalCaretNavExtension、全エンジン適用で温存） |
| onnxruntime-node: unpacked 270MB・asar 内ロード不可・Electron worker_threads でクラッシュ報告（#20084 等） | 中 | asarUnpack + 他プラットフォーム bin 除外で配布サイズ制御。推論は main/utilityProcess で実行。**または napi-rs で現行 ort 経路を温存**（この場合 download.rs の AppHandle 依存の切り離しが必要）。30分スパイク（Node 単体で2モデル→golden fixture 一致）を移行判断前に実施 |
| ORT 1.24+ は darwin/x64 prebuilt を廃止 | なし | 現行 macOS 配布は arm64 のみなので実害なし（Intel Mac 対応を将来足すなら 1.23.x 固定 or napi-rs） |
| better-sqlite3 の Electron prebuild 追随ラグ（v12.7.x/12.9.1/12.11.0 で反復） | 低 | Electron バージョン固定運用。**napi-rs で rusqlite 温存ならこの問題自体が消える** |
| 配布サイズ・メモリ: 相場でバンドル +100〜240MB、メモリ +150〜300MB。起動時間は有意差なし | 受容済み | 「ビルドと起動の軽量さよりも見た目と操作感が命」という製品方針で明示的に受容 |
| Windows Authenticode 不在 | 現状維持 | Tauri 時代から無署名。移行で悪化しない |

実ユーザー規模（v0.10.1 各アセット 18〜27 DL、latest.json 13 DL）から、移行の実害ウィンドウは小さい。**移行するなら今が最安**。

## 6. 推奨アーキテクチャ

```
┌────────────── Electron main ──────────────┐
│ window/chrome (frameless+transparent+     │
│  vibrancy'under-window'=現行と一対一対応)   │
│ dialog / fs / notification / shell /      │
│  window-state / electron-updater          │
│ chokidar (external_mount監視)              │
│ safeStorage (APIキー)                      │
│ ipcMain.handle("cmd:*") / webContents.send│
│        │                                  │
│  napi-rs ネイティブモジュール (第一候補)      │
│   = grimodex-core/lint + db(rusqlite+     │
│     migrate+agent_writes) + ai streaming  │
│     + semantic(ort) + license             │
│  （代替: 既存バイナリの stdio RPC sidecar）  │
└───────────────────────────────────────────┘
   preload: contextBridge で typed IPC 公開
   renderer: src/lib/tauri.ts → src/lib/ipc.ts に改称し
             Electron/browser-mock の2分岐（既存構造を維持）
   extraResources: grimodex-mcp バイナリ（MCP契約維持）
```

- ビルド: electron-vite（dev）+ electron-builder（パッケージ、NSIS/dmg/deb/rpm/AppImage — 現行ターゲットと同一集合）。
- セキュリティ: contextIsolation + sandbox + preload の typed bridge。現行 CSP の `ipc:` 部分を差し替え。

## 7. 移行計画（フェーズ分割）

- **Phase 0 — スパイク（数日、GO/NO-GO 判定）**
  1. Wayland/X11 × fcitx5/ibus の日本語IME（素の Electron + contenteditable 縦書きで確認）← **唯一の NO-GO 候補**
  2. napi-rs で grimodex-core + rusqlite を .node 化して db_execute 相当を疎通
  3. ort 経路: napi-rs 温存 or onnxruntime-node で golden fixture（ruri/bge）一致確認
  4. frameless + transparent + vibrancy の3OS見た目パリティ
- **Phase 1 — 抽象層の仕上げ（現行 Tauri のまま出荷可能な純リファクタ）**
  - 直 import 19ファイルを `src/lib/tauri.ts` 系ラッパーへ吸収（listen/Window/dialog/notification/opener の抽象化）
  - typed なコマンド/イベント契約を1ファイルに集約（145コマンド+19イベント）
- **Phase 2 — Electron シェル**: main/preload、ウィンドウクローム（app-region CSS）、db_execute ブリッジ、イベントチャネル、close veto / パネル別窓（BrowserWindow）再設計
- **Phase 3 — ネイティブ再結線**: napi-rs パッケージング CI（3OS）、chokidar、safeStorage 移行、queryLocalFonts（日本語 family 名優先ロジックの実機確認）、vivliostyle 子プロセス、MCP extraResources
- **Phase 4 — リリース/updater**: electron-builder 全ターゲット、electron-updater + Apple 署名/notarization、**ブリッジ最終 Tauri リリース**（v1.x）、tauri 形式 latest.json の永続同梱ジョブ、userData/API キー移行、v2.0.0
- **Phase 5 — 撤去**: WebKitGTK 回避コード約2,030行 + webkit_features.rs + webkit2gtk 依存の削除、CLAUDE.md / スキル（bump-version 等のバージョン正本4箇所）更新、MANUAL_TEST_CHECKLIST 改訂

### 移行期間中の運用

- 現行ブランチの縦書き修正は仕上げて出荷してよいが、**以後の新規 WebKitGTK 深掘り回避は原則凍結**（タイムボックス制）。出血を止めることが移行の主目的なので、移行作業と並行して回避コードを増やすのは本末転倒。
- Tauri CEF ランタイムのウォッチは継続（出れば Phase 2 以降を中断して再評価する価値はあるが、待つ対象ではない）。

## 8. 棄却した代替案

| 案 | 推奨度 | 棄却理由 |
|---|---|---|
| **段階的 Electron 移行（本提案）** | 5/5 | 抽象層敷設済み・Rust温存可・ブリッジ成立 |
| Tauri 公式 CEF ランタイム待ち | 2/5 | 顧客プロジェクト先行・公開ETAなし（2026-01-13 メンテナ発言）。並行ウォッチのみ |
| OS別二本立て（Linux=Electron / Win=Tauri） | 2/5 | 実例ゼロ、updater/CI/署名の恒久二重化。過渡期形態としてのみ許容 |
| WebKitGTK ガード継続 | 2/5 | フラグで直るのは6バグ中1つ。タイミング依存ガードは CI 検出不能で、直近3日 +2,786行の出血が続く |
| WebKitGTK 2.50+/WPE 待ち | 1/5 | 2.52.4 実機で全バグ再現。wry に WPE バックエンドなし。WebCore/Skia 共有で解消根拠なし |
| tauri-runtime-verso (Servo) | 1/5 | **Servo は縦書き未実装**（servo#44538、2026-04 起票 open）。縦書きエディタでは論外 |
| Wails / Neutralino | 1/5 | Linux は同じ WebKitGTK。バグ源不変で書き換えコストのみ増加 |

## 追記: Phase 0 実施結果（2026-07-10、全項目GO）

| スパイク | 判定 | 要点 |
|---|---|---|
| ① Wayland IME | **GO** | GNOME Wayland + fcitx5 実機で x11 / wayland / wayland+ime の3モードすべて composition フルサイクル成功（Electron 43.1.0 / Chromium 150）。フラグなしネイティブWaylandでも動作 = 懸念だったフラグ運用すら不要。傍点 text-emphasis・縦書き button も素で描画 |
| ② napi-rs | **GO** | grimodex-core(path依存) + rusqlite(bundled) の .node 化成立。WAL+FTS5(trigram)+日本語MATCH 全通過。クリーンビルド57秒・約2.7MiB・glibc問題なし・Electronリビルド不要。本移行の要点: 同期 `#[napi]` は Node メインスレッドをブロック（重コマンドは AsyncTask/tokio_rt で async 化）、`State<T>` 118箇所は init+OnceCell か napi クラスで再設計、ort 系は glibc 問題隔離のため別モジュール/サイドカーに分離 |
| ③ ONNX 純Node | **条件付きGO** | onnxruntime-node **1.24.3 固定**（Rust ort 同梱の ONNX Runtime 1.24.2 とカーネル一致、cos=1.0）なら golden 比較 0.9944〜0.9983 で int8 ゲート帯域内・近傍順位 6/6 保存。**1.27 は int8 カーネル変更で 0.999 割れあり**。transformers.js は Unigram byte_fallback 未実装で希少字（例:「滲」）が UNK 化し cos 0.9568 まで劣化 → JS シム or Rust tokenizers 温存が必要。実効ペイロード約37.4MB（CUDA provider・他OS bin 除外後）、要 asarUnpack |
| ④ ウィンドウクローム | **GO** | frameless + transparent + `-webkit-app-region: drag` が mutter 上で成立 |

**アーキテクチャへの帰結**: ③の2条件（ORTバージョン固定・byte_fallback シム）は**セマンティック経路を Rust のまま温存すれば両方消える**。②で温存経路が実証されたため、第一候補は「semantic も含めて Rust 温存（ort 系は別 .node またはサイドカーに隔離）」、純Node 経路は文書化されたフォールバックとする。

**Phase 1 実施結果（同日）**: `refactor/electron-p1-ipc-abstraction` ブランチ（5コミット）で完了。本体コードの `@tauri-apps` 接触面を `src/lib/` 配下11ファイルに集約。敵対的レビューで確定バグ2件（segment_bunsetsu の 10s タイムアウト新規適用・非Tauri時の通知退行）を検出し修正済み。tsc / lint / テスト8,636件グリーン。

## 参考（主要一次情報）

- tauri-plugin-updater 2.10.1 `updater.rs`（minisign のみ検証・プラットフォーム別インストール機構）
- electron-updater ソース（MacUpdater→Squirrel.Mac 委譲 = macOS 署名必須）/ electron-builder ドキュメント
- better-sqlite3 `deps/defines.gypi`（SQLITE_ENABLE_FTS5 明記）
- npm registry onnxruntime-node@1.27.0（os/napi/270MB 実体、darwin は arm64 のみ）
- tauri discussion #8524（CEF ETA なし・Linux 非推奨発言）/ servo#44538 / wry discussion #996
- developer.chrome.com: vertical form controls（Chrome 119-123 既定ON）/ text-emphasis（Chrome 99）/ ruby（Chrome 128）
- bugs.webkit.org 117228・65917（縦書きバグ10年超放置の前例）/ webkitgtk.org 2.50・2.52 リリースノート
- vscode #277073（Electron Wayland IME）
- 実機検証: webkit2gtk 2.52.4 で6バグ再現（memory/webkitgtk-vertical-engine-bugs.md, 2026-07-10）
