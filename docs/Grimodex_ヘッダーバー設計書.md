# Grimodex ヘッダーバー設計書

## 概要

アプリウィンドウ最上部に固定表示されるバー。`decorations: false`（フレームレスウィンドウ）設定により、OSネイティブのタイトルバーを非表示にし、アプリヘッダーがウィンドウドラッグやウィンドウ操作ボタンの役割も兼ねる。

---

## 構造

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Logo] [フォルダ名 / 題名▾] [↶][↷] [↓]  [ドラッグ領域]  [レイアウト▼] [パネル▼] [⚙ 設定] │ [─][□][×] │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

ヘッダーは `HeaderBarLayout` による **3 レール構成**（`left` / `center` / `right`）。左右レールを共に `flex-1 basis-0` にしてレール外寸を揃えている。2026-07-24 に常駐検索バーを撤去し、空になった中央レール全体を主要なウィンドウドラッグ領域にした。

### 各要素の配置

| レール | 要素 | コンポーネント |
|------|------|-------------|
| 左端 | アプリロゴ（窓幅 1680px 未満は本の記号だけ） | `GrimodexLogo`（`variant="mark"` と `"full"` を 2 つ置いて出し分け） |
| 左レール（`@container/header-menu` の wrapper の中） | ワークスペースとプロジェクトの統合メニュー | `WorkspaceMenu`（プロジェクト側の部品は `ProjectMenu`） |
| 左レール（同じ wrapper の中） | Undo / Redo | `HistoryButtons`（`Undo2` / `Redo2` アイコン） |
| 左レール（同じ wrapper の中） | エクスポート | `<button>` + `FileOutput` アイコン（どの幅でも文字なし） |
| 中央スロット | ウィンドウドラッグ領域 | `HeaderBarLayout` の空 center レール |
| 右レール | レイアウトプリセット | `LayoutPresetDropdown` |
| 右レール | パネルトグル | `PanelToggleDropdown` |
| 右レール | 設定 | `<button>` + `Settings` アイコン + ラベル |
| 仕切り線 | 縦の区切り線（非mac環境のみ） | `<div>` |
| 右端 | ウィンドウ操作ボタン（非mac環境のみ） | `WindowControls` |

**現状の実装**: macOS では OS ネイティブのトラフィックライトを表示するため、`WindowControls` と仕切り線は非表示となり、左レールに `pl-20` のパディングを設けてトラフィックライト分のスペースを確保している。中央スロットを真の中心に保つため、mac では右レールにも同量の `pr-20` を入れて左右レールの外寸を対称化している。

> 切り替えの実体（2026-06-20 追記）: 上記の mac 判定は属性駆動ではなく、(1) `WindowControls` が内部で `isMac()` 関数を呼び、mac なら `null` を返して自身と仕切り線を描画しない、(2) `HeaderBarLayout` が受け取る `mac` props（`pl-20` / `pr-20` の対称パディングを制御）の 2 系統で実現している。`data-platform-mac` 属性は外側のラッパー div（`EditorScreen`）に styling 用として設定されるのみで、ヘッダー系コンポーネントからは読まれない。

---

## フレームレスウィンドウ設定

現行 Electron ランタイムは win/linux で `frame: false`、macOS で
`titleBarStyle: "hidden"` を使う。ウィンドウは native resize を有効にするため
`transparent: false` / `resizable: true` とする。

- ヘッダー全体に `data-tauri-drag-region` を設定し、ウィンドウのドラッグ移動を可能にする
- Electron では `data-tauri-drag-region` を `-webkit-app-region: drag` に写像する
- ボタン類はクリックイベントが優先されるため、ドラッグ操作の対象外となる
- ウィンドウの最小化・最大化・閉じるボタンは `WindowControls` コンポーネントで提供する

---

## アプリロゴ（左端）

- `GrimodexLogo` SVGコンポーネント
- `height={24}` で固定表示。縮めない（`shrink-0`）
- 窓幅（viewport）1680px 未満は本の記号だけ（`variant="mark"`、幅 約 27.9px）、1680px 以上は記号＋「Grimodex」の字（`variant="full"`、幅 約 139.2px）。ヘッダーには 2 つを置き、mark に `min-[1680px]:hidden`、full に `hidden min-[1680px]:block` を当てる。字の幅を左レールの統合メニューに回すため（2026-11-11）
- mark は同じ高さのまま viewBox を `0 0 9.6 8.269779` に切り出し、字の path は描かない。切り出し幅は実 Chromium の `getBBox()` で測った値による：本の記号は viewBox の x 0〜9.5751（線の太さを含めても内側）、字の左端は x 10.3962
- ヘッダー以外（Launcher、Welcome、Recovery など）は full のまま
- `currentColor` を使用しテーマに追従（`text-foreground`）
- クリック動作なし

---

## Undo / Redo ボタン（左レール・統合メニューの隣）

`HistoryButtons` コンポーネント。`globalHistoryStore` が公開する `past` / `future` スタックを参照する。

- アイコン: `Undo2` / `Redo2`（lucide-react）
- ツールチップ: 直近操作のラベルがあれば `元に戻す: <label> (Ctrl+Z)` / `やり直し: <label> (Ctrl+Shift+Z)` の形式
- スタックが空のときは `disabled` 状態（`opacity-30`、ポインタ無効化）
- 失敗時は sonner トーストで通知（`history.undoError` / `history.redoError`）

---

## ワークスペースとプロジェクトの統合メニュー（左から2番目）

ワークスペース（フォルダ）とプロジェクトを 1 つのメニューで扱う `WorkspaceMenu`（`src/features/workspace/WorkspaceMenu.tsx`）。2026-11-11 に、それまで別々だったワークスペースメニューとプロジェクトメニューを統合した。トリガーとパネルの枠は `WorkspaceMenu` が持ち、プロジェクト側の部品（一覧と操作の行、作成ダイアログ、削除の確認ダイアログ、一覧の読み込み）は `src/features/project/` の `ProjectMenu.tsx`（`useProjectMenu` / `ProjectMenuSection`）・`ProjectMenuCommands.tsx`・`ProjectMenuDialogs.tsx` にある。部品は自前で、Radix の DropdownMenu は使わない。

### 表示（閉じているとき）

```
[フォルダ名 / 題名 !▾]
```

- 題名が主（`font-medium`）、フォルダ名は従（muted、通常の太さ）。フォルダ名は `activeWorkspaceName ?? workspaceMenu.fallback`、題名は `currentProject?.title ?? project.menu.fallback`
- 幅は中身に合わせ、上限 320px（root の `max-w-80`）。固定幅は持たない。左レールが足りないときは、ロゴや後ろのボタンより先にこのメニューが縮む（root の `shrink-[1000]`）。root の最小幅はトリガーの左右の padding（`min-w-4`＝16px）で、それより狭いときは後ろの「元に戻す」「やり直す」が縮む
- トリガーの button は `overflow-hidden`。名前が最小幅のまま入り切らないときも、隣の要素へはみ出さずに button の中で切れる（button 自身の focus の輪郭は切れない）
- 足りないときはフォルダ名が先に縮む（`shrink-[1000]`）。フォルダ名は 3.5em より短くしない。題名の最小幅は 1.5em で、フォルダ名を出す幅では閾値の決め方から 3em 以上が残る。フォルダ名を隠す狭い幅では題名のほうを縮め、▾ を button の中に残す。最小幅より短い名前（文字数 3 以下のフォルダ名、2 以下の題名）は `shrink-0` で最小幅を付けない。どちらも truncate
- フォルダ名を隠す条件は「メニューに実際に残る幅」で決める。`EditorWorkspaceHeader` は、ロゴの後ろの 3 つ（統合メニュー、`HistoryButtons`、書き出し）を 1 つの wrapper（`flex min-w-0 flex-1 items-center gap-3`、名前付きの container `@container/header-menu`、`data-tauri-drag-region`）に入れる。メニューの後ろの固定分は 132px（gap 12＋32＋12＋32＋12＋32）で一定なので、wrapper の内容幅が 288px 未満のとき（メニューに残る幅が、フォルダ名を出すときのトリガーの最小幅 約 135〜147px（「!」あり）を切るとき）、メニュー側の `@max-[288px]/header-menu:hidden` でフォルダ名と「/」を隠して題名だけにする。JS で幅を測らない。phone の「その他」は container の外なので、フォルダ名は常に出る
- 実測（実 Chromium、mac なし、`EditorWorkspaceHeader.browser.test.tsx`）：800／1080px はフォルダ名を隠し、題名は 800px で約 42px、1080px で約 122px（長い題名）見える。1280px 以上はフォルダ名と題名の両方が出る。mac（左右に 80px）の 800px はメニューが 16px（padding だけ）まで縮み、題名はほぼ見えない
- 題名がフォルダ名と同じときは、フォルダ名と「/」を隠す
- 隠すときも span は DOM に残す。ボタンの中の最初の span はフォルダ名で、文字はフォルダ名だけ（Electron の product journey が読む）。題名の span は `data-testid="project-menu-trigger"` で常に描画し、幅が 0 にならない
- `aria-label` と `title` は「フォルダ名 / 題名」の全文。読み込みに欠けがあるとき（degraded）は aria-label に `: project.loadDegraded` を足し、▾ の手前に「!」を出す
- ワークスペースを開いている・切り替えている間（`workspaceOpenRequestInProgress || workspaceSwitchInProgress`）はトリガーごと disabled
- ツアーの対象は、root の `data-tour-target="workspace-menu"` とボタンの `data-tour-target="project-menu"`

### ドロップダウン展開時

パネルは `data-testid="workspace-menu-dropdown"`、幅 320px（`w-80`）、高さの上限 `calc(100vh - 4rem)` でスクロールする。

```
┌──────────────────────────────────────┐
│ ▸ フォルダ名          このワークスペース │  ← 見出し（操作なし）
│   （degraded／recovering の警告）       │
│ ✓ プロジェクトA               [削除]   │  ← 6 行を超えたら一覧の中だけスクロール
│   プロジェクトB               [削除]   │
│   新規プロジェクト…                    │
├──────────────────────────────────────┤
│   インポート…                          │  ← onOpenImport 提供時のみ
│   プロジェクトを ZIP で書き出す…         │  ← onOpenExport 提供時のみ
│   プロジェクトスナップショット…          │  ← onOpenSnapshot 提供時のみ（3 つとも無ければ区切りごと出さない）
├──────────────────────────────────────┤
│ 別のワークスペース                      │
│ ▸ 最近のワークスペース1                │  ← 現在を除く最大4件。title に path
│ ▸ 最近のワークスペース2                │
│   フォルダを開く…                      │
│     ワークスペースでないフォルダを選ぶと、そこに新しく作ります │
│   スタート画面                         │
└──────────────────────────────────────┘
```

▸ はフォルダのアイコン（`Folder`、aria-hidden）。「このワークスペース」と「別のワークスペース」は `role="group"`（`aria-labelledby` で見出しにつなぐ）。開いていないワークスペースのプロジェクトは出さない（プロジェクトはワークスペースごとの DB にあり、開かずに読む手段がない）。

### 各メニュー項目の動作

| 項目 | 動作 |
|------|------|
| プロジェクト一覧（✓ と `aria-current="true"` が現在） | クリックで `loadProject` による切り替え。失敗時は `project.switchFailed` トースト |
| 削除 | 確認ダイアログ → `deleteProjectById`。2件以上ある場合のみ。hover か、行に focus があるとき（`group-focus-within`）に出る。確認を閉じると focus はトリガーへ戻る |
| 新規プロジェクト… | `CreateProjectDialog` を開く（タイトル/ジャンル/言語/タイムラプス記録、別 Project からの Codex コピーも選択可）。ダイアログは初めて開くときに mount する |
| インポート… | インポート / エクスポートダイアログを `import` タブで開く（`onOpenImport`） |
| プロジェクトを ZIP で書き出す… | インポート / エクスポートダイアログを `zip` タブで開く（`onOpenExport`）。ヘッダーの書き出しボタン（原稿の書き出し）とは別の機能 |
| プロジェクトスナップショット… | スナップショット作成モーダルを開く（`onOpenSnapshot`） |
| 最近のワークスペース | クリックで該当パスのワークスペースに切り替え（`openRecentWorkspace(path, "workspace-menu-recent")`）。accessible name はフォルダ名だけ |
| フォルダを開く… | OS のフォルダ選択ダイアログ → `requestOpenWorkspace(path, "folder-picker")`。ワークスペースでないフォルダを選ぶと、そこに新しく作る（旧「他のフォルダを開く…」と「新規ワークスペース」は同じ処理だったので 1 つにした） |
| スタート画面 | スタート/ランチャー画面を表示（`showLauncher`） |

「Web Editorから続ける」はメニューに載せない（Web Editor は廃止。`requestWebEditorHandoffImport` とスタート画面・Welcome のリンクは残す）。プロジェクト作成のライセンス制限拒否は gate 側が理由トーストを表示するため、メニュー側では「失敗しました」を重ねて出さない。

### 動作仕様

- マウント時に `refreshProjects` でプロジェクト一覧を取得（メニューを閉じていても）
- クリックで展開/折りたたみ切り替え。外側の mousedown で閉じる（focus は戻さない）
- メニュー項目をクリックすると自動的にドロップダウンが閉じる
- Esc で閉じてトリガーへ focus を戻す。Esc はメニューの root で受けて `preventDefault` と `stopPropagation` をする（document で Esc を拾う work layer の「戻る」と二重に動かさない）
- 上下キーでパネル内の有効なボタン（disabled と非表示を除く）を移動し、端で折り返す。Home／End で先頭／末尾。トリガーで ↓ を押すと開いて最初の項目へ。行末の「削除」（`data-menu-secondary`）は移動先に入れない（hover や行の focus で出たり消えたりし、含めると ↓ と ↑ で順序が変わる）。削除へは、行に focus があるときに Tab で届く。削除に focus があるときの上下キーは、DOM の順で前後の行へ動く
- トリガーに `aria-haspopup` は付けない（パネルは role=menu ではない）。開いている間だけ `aria-controls` でパネルの id を指す
- Electron ではヘッダーがウィンドウのドラッグ領域なので、パネルに `data-tauri-drag-region="false"` を付けて、見出しや補足が drag にならないようにする
- phone の「その他」（`[data-phone-workspace-controls]`）では同じメニューを 1 つ置く。トリガーは幅 100%・48px・枠付き、パネルはその場で開き（`position: relative`）、高さの上限とスクロールは外す（`phoneWorkspace.css`）

---

## エクスポートボタン（左レール末尾）

- `FileOutput` アイコン（lucide-react）だけを、どの幅でも出す（2026-11-11 に xl 以上の文字ラベルをやめた。左レールの幅を統合メニューに回すため）。幅は 32px
- 名前は `aria-label`（`app.exportLabel`「エクスポート」）、ツアーの対象は `data-tour-target="export-button"`
- クリックでエクスポートダイアログを開閉
- ツールチップ: `エクスポート (Ctrl+Shift+E)`
- キーボードショートカット: `Ctrl+Shift+E`
- 詳細は[エクスポートダイアログ設計書](Grimodex_エクスポートダイアログ設計書.md)を参照

---

## レイアウトプリセットドロップダウン

詳細は[レイアウトシステム置換設計書 §9 プリセット / `LayoutPresetDropdown`](Grimodex_レイアウトシステム置換設計書.md)を参照。

---

## パネルトグルドロップダウン

詳細は[レイアウトシステム置換設計書 §6 振る舞い / `PanelToggleDropdown`](Grimodex_レイアウトシステム置換設計書.md)を参照。

---

## 設定ボタン（右から2番目）

- 歯車アイコン（`Settings` from lucide-react）＋ `app.settingsLabel`（「設定」）テキストラベル
- クリックで設定ダイアログを「project」カテゴリで開く
- ツールチップ: `設定 (Ctrl+Alt+,)`
- キーボードショートカット: `Ctrl+Alt+,`
- `open-settings` カスタムイベント（`detail.category`）でも開閉可能（他コンポーネントから任意カテゴリを指定できる）

---

## ウィンドウ操作ボタン（右端）

`WindowControls` コンポーネント。設定ボタンとの間に縦の区切り線（`h-4 w-px bg-border`）を配置。

| ボタン | アイコン | ツールチップ | 動作 |
|--------|---------|-------------|------|
| 最小化 | `Minus` | 最小化 | ウィンドウを最小化 |
| 最大化/復元 | `Square` / `Copy` | 最大化 / 元に戻す | 最大化状態をトグル |
| 閉じる | `X` | 閉じる | ウィンドウを閉じる |

- 閉じるボタンはホバー時に赤色背景（`hover:bg-red-600`）
- Tauri環境以外では非表示
- macOS では OS ネイティブのトラフィックライトを使うため、`WindowControls` と仕切り線そのものを描画しない

---

## レイアウトとスタイル

```
height:     auto（py-2 相当、縦方向は内容に合わせる）
padding:    px-4 py-2（macOS のみ左レール pl-20 + 右レール pr-20 で対称化）
border:     下辺に border-b border-border
flex:       items-center gap-3（3 レール: left / center / right、各レール内も gap-3）
shrink:     flex-shrink-0（ドックゾーンの高さに押しつぶされない）
drag:       data-tauri-drag-region（ヘッダー全体・各レールに付与。中央レールは全面 drag）
```

`py-2`（上下 8px）は、ボタンの上下にもドラッグ領域帯を確保するため。空の中央レールが `-webkit-app-region: drag` になることと、左右レールの外寸が等しいことは `HeaderBarLayout.browser.test.tsx` でゲートする。

**現状の実装**: スクリーンショット撮影モード中はヘッダーに `no-screenshot` クラスが付与され、キャプチャ対象から除外される。

---

## 将来の検討事項

- **最近のワークスペース上限**: 現在4件固定（`WorkspaceMenuOtherSection` の `RECENT_LIMIT`）。設定で変更可能にするか検討

> 「プロジェクトタイトルをヘッダーに表示する案」は統合メニュー（`WorkspaceMenu`）のトリガーが「フォルダ名 / 題名」を表示することで実装済み（中央ではなく左レール）。
