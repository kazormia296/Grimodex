# Grimodex パネルヘッダー設計書

各ツールパネル上端の「ヘッダー帯」の統一ルール。ヘッダーがパネルごとに
バラついていた（高さ 3 段階・アイコン有無・i18n/ハードコード混在・最大化や
コンテキストメニュー未配線）ため、**共有コンポーネント `PanelHeader` を正本**
として明文化する。

正本の実体: `src/features/layout/PanelHeader.tsx`

## 標準（`PanelHeader` が強制する）

| 項目 | 値 |
| --- | --- |
| 高さ | `h-8`（32px・コンパクト） |
| 横パディング | `px-3` |
| 文字サイズ | `text-xs` |
| 下境界 | `border-b border-border` |
| 先頭アイコン | `PANEL_ICON_MAP[panelId]`（`size-3.5` opacity-70）。**サイドストライプと同一アイコン**なので視覚が一致する |
| タイトル | 既定で i18n `layout.panel.<panelId>`（全パネル定義・翻訳済み）。`font-medium` |
| 件数など | `count` prop（タイトル直後・muted・nowrap） |
| 右端操作 | `actions` prop（`ms-auto` 右寄せ） |
| 追加の左側内容 | children（警告チップ・トグル等） |
| ジェスチャ | `data-panel-header` を必ず付与 |

### `data-panel-header` の効果（自動配線）

`PanelChromeMenu`（`AnimatedSlotPanel` が全パネルに被せる）がヘッダー帯を委譲で拾い、
パネル側は配線不要で以下が有効になる:

- **ヘッダーのダブルクリック → パネル最大化トグル**（`toggleMaximizePanel`）
- **ヘッダーの右クリック → コンテキストメニュー**（最大化/復元・折りたたみ・ウィンドウで開く）

ボタン・select・入力欄など操作要素の上では `isPanelChromeGestureTarget` が誤発火を抑止する。

## 使い方

```tsx
import { PanelHeader } from "@/features/layout/PanelHeader";

<PanelHeader
  panelId="chronicle"
  count={t("chronicle.count", { count: n })}
  actions={<>{/* 右端ボタン群（onClick 等はそのまま） */}</>}
>
  {/* タイトル直後に出す任意の左側内容（暦設定ボタン・警告など） */}
</PanelHeader>
```

- **タイトル文言は原則 `title` を渡さない**（既定の `layout.panel.<id>` を使う）。
- 旧タイトル要素にテスト参照の `data-testid` がある場合のみ
  `title={<span data-testid="...">{t("layout.panel.<id>")}</span>}` で保持する。
- 新しいパネル / 既存ヘッダーの作り直しは、生 `div` でなく `PanelHeader` を使うこと。

## 縦書き対応

ヘッダー帯のポップオーバー（操作ドロップダウン等）は `document.body` へ portal して
`position: fixed` で配置する（`@/components/ui/useAnchoredPopover`）。縦書きフロー外で
既定の横書き・トリガー矩形基準に出るため、モード別の特例 CSS は不要。

## 移行状況（2026-06-28）

### `PanelHeader` 採用済み（単一行タイトルヘッダー）

scenes / codex / codex-quick / chat-history / snippets / attribution /
foreshadow / trash-bin / related-scenes / chronicle / writing-stats

（codex-quick は title + sort select のみのため本コンポーネントへ全面移行した。）

### アイコン＋トークン統一済み（密なヘッダーはカスタム実装を維持）

固定 `h-8` 単一行に収まらない密なヘッダーは独自実装を維持しつつ、共通項を揃えた:
**`data-panel-header`・先頭の `PANEL_ICON_MAP` アイコン（`size-3.5` opacity-70・
ストライプと同一）・`text-xs`・`border-b border-border`・横 `px-3`・コンパクト高さ**。
タイトルを持つパネルは `font-medium`（旧 `font-semibold`/`text-sm` から統一）。
`border-b border-border` の 2 クラス併記はガラスモードの枠色差し替え
（`src/index.css` の `.border-b.border-border` ルール）に必要なので、片方だけの
`border-b` は使わない。

- **timeline**: flex-wrap toolbar。`CalendarClock` ＋ `font-medium` タイトル。
- **matrix**: 複数行。`Table2` ＋ `font-medium` タイトル。境界は外側ラッパに
  `border-b border-border`。
- **chat**: スコープタブ付き。`MessageSquare` ＋ `font-medium` タイトル
  （`chat.title` → `layout.panel.chat`）。
- **map**: インラインスタイル主体の既存実装を維持（全面 Tailwind 化はスコープ外）。
  `Map` アイコン ＋ `layout.panel.map` タイトル、横パディングを 12px（`px-3` 相当）へ。
- **grid**: 旧 mono kicker（`font-mono text-[10px]`）を標準書体へ統一。`Columns3`
  アイコン ＋ `layout.panel.grid` の `font-medium` タイトル、行を `h-8`／`text-xs`／
  `px-3` に揃え、外側ラッパは `border-b border-border`。`/` 以降のパンくず
  （コンテナ選択・章数）は機能としてそのまま残す。
- **kouetsu**: タブ型。タブ行先頭に `SpellCheck` アイコン ＋ `layout.panel.kouetsu`
  （「校閲」）の `font-medium` タイトルを置き、その後ろにタブを並べる。
- **editor**（パンくず）: エディタ最上段のパンくず帯（`Breadcrumb.tsx`・TabBar の上）が
  実質的なエディタのヘッダー。既に `data-panel-header`／`text-xs`／`border-b border-border`
  ／`px-3` を持つので、先頭に `FileText` アイコン（`size-3.5` opacity-70）を足し、高さを
  `h-8` に揃え、現在地（末尾セグメント）を `font-medium` にした。`editor` は
  `PANEL_ICON_MAP`（ストライプが消費＝ツールパネル専用）から除外されているため、
  共有マップへは追加せず `Breadcrumb.tsx` ローカルでアイコンを描画する。

### 例外（タイトルヘッダーを持たないため対象外）

- **command-center-results**: ヘッダー帯そのものがライブ検索入力欄（旧「動的タイトル」）。
  先頭の `PANEL_ICON_MAP` アイコン（= Search）は入力欄内に既出のため、独立した
  タイトル行は設けない。`data-panel-header`・`border-b border-border` は具備。

全パネルが `data-panel-header` を持つため、ヘッダーのダブルクリック最大化・
右クリックメニューは全パネルで機能する。
