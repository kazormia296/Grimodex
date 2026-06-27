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

`PanelHeader` 採用済み（単一行タイトルヘッダー）:
scenes / codex / chat-history / snippets / attribution / foreshadow /
trash-bin / related-scenes / chronicle / writing-stats

### 例外（標準コンポーネント非適用・カスタムヘッダーを維持）

固定 `h-8` 単一行に収まらない密なヘッダーは独自実装を維持する。ただし
**`data-panel-header`・先頭の `PANEL_ICON_MAP` アイコン・`text-xs`/`border-b`
トークン・コンパクト高さ**は揃える（順次対応）。

- **toolbar 型**（コントロールが折り返す）: map / timeline / grid
- **tab 型ヘッダー**: kouetsu / codex-quick
- **複数行**: matrix
- **動的タイトル**: command-center-results
- **スコープタブ付き**: chat

これらは `data-panel-header` を既に持つため最大化・コンテキストメニューは機能する。
残りの「アイコン＋トークン統一」は追従タスク。
