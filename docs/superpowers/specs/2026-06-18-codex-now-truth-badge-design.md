# Codex「今の真実」バッジ ＋ 未開示警告 — 設計仕様

- 日付: 2026-06-18
- ブランチ: `feat/codex-now-truth-badge`
- 機能ID: D（feature-idea-backlog 監査の「部分重複＝バックエンド有りでUIだけ安い」枠）

## 目的

執筆中シーン（`activeSceneId`）時点での Codex エントリの **phase 解決済み状態**（「今の真実」）を、hover の `CodexPopover`（エディタ）だけでなく **ツリーの CodexQuick セクションに常時表示** へ昇格する。あわせて、そのシーン時点でまだ明かされていない **秘匿伏線**（`foreshadow.secret`）を控えめな警告アイコンで示し、ネタバレの先出しに気づけるようにする。

完全に **read-only**：本文・DB を一切変更しない純粋な表示機能。

## スコープ

### やること
- `CodexQuickSection` の各行に、現在シーン時点の **phase ラベルチップ**を常時インライン表示
- 同行に、未開示の秘匿伏線がある場合 **⚠アイコン**（tooltip に伏線タイトルを列挙）
- `CodexQuickPopover`（hover）に、欠落している `phaseLabel` / `resolvedSummary` を配線（エディタの `CodexPopover` と同等に）
- 共有部品 `CodexEntryPopoverContent` に `spoilerNote?` を追加し、両 popover（ツリー / エディタ）で未開示警告行を表示
- `CodexPopover`（エディタ）にインライン実装されている phase 解決ロジックを共有フックへ抽出（二重実装の解消）

### やらないこと（YAGNI / 確定済み判断）
- `認知度=秘匿`（Codex detail）を信号に使わない。理由: `lore` タイプ専用かつ静的（明かされる時点を持たない）で「このシーン時点では未開示」と整合せず、name 依存マッチの脆さもある（ユーザー決定 2026-06-18）
- 警告は **視覚フラグのみ**。該当 summary/detail のぼかし・クリック開示はしない（作者は自分の設定を見る権利がある前提）
- ⚠から ForeshadowPanel へのジャンプ導線は付けない（v1）
- 対象サーフェスは **CodexQuickSection ＋ 2つの popover のみ**。ReferencesSection・Codex 管理パネル・本文インラインハイライトは対象外
- DB スキーマ変更なし

## 警告信号の定義

警告は **scene-aware な単一信号**のみ：

```
未開示の秘匿伏線(entry, currentSceneId) =
  entry にリンクされた foreshadow のうち
    secret == true
    && abandoned == false
    && (
         // payoff シーン未設定: 未確定なら未回収＝未開示。確定済み(orphan_payoff)は
         // 「回収済みだが位置不明」なので開示済みとみなし警告しない。
         (payoffSceneId == null && payoffConfirmed == false)
         // payoff シーンが現在シーンより後（順序に無い=削除等も後扱い）
         || (payoffSceneId != null
             && (sceneOrder[payoffSceneId] == null
                 || sceneOrder[payoffSceneId] > sceneOrder[currentSceneId]))
       )
```

`payoffConfirmed`（ユーザーが手動で立てられる「回収済み」フラグ・`payoffSceneId` と独立）は `payoffSceneId==null` のケースでのみ参照する: 確定済みで位置不明な `orphan_payoff` 状態（`deriveLabel` 既存ラベル）の秘匿伏線を全シーンで誤って未開示と出さないためのガード。`sceneOrder` は `phaseStore.globalSceneOrder`（treeStore が維持・phase 解決と同一基準）を共有する。

## アーキテクチャ（Approach A：共有フック＋純関数）

3つのユニットに分離する。

### ① `useResolvedCodexStates(entryIds: string[])`
- 新規: `src/features/codex/useResolvedCodexStates.ts`
- 依存: `phaseStore`（`phasesByEntry` / `detailOverrides` / `resolutionMode`）、`treeStore`（`activeSceneId` / `nodes`）、`codexStore`（`entries`）
- 動作:
  - `entryIds` のうち未ロードのものに `loadPhasesForEntry` をバッチ発火
  - `computeSceneTimeIndex(nodes, resolutionMode)` を1回 memo
  - 各 entry に `resolveCodexState(...)` を `activeSceneId` で適用
- 返り値: `Map<entryId, { phaseLabel?: string; resolvedSummary: string | null }>`（`resolvedDetails` は本機能では不要＝返さない。foreshadow-only のため）
- 既存 `CodexPopover` をこのフック（単一 id）に置き換え、二重実装を解消する

**何をするユニットか**: 「表示対象の Codex 群を、現在シーン時点の解決済み状態に変換する」。入出力は entryId 配列 → 解決済み state の Map。内部の phase 適用詳細を知らずに使える。

### ② `computeUnrevealedSecretForeshadows`
- 新規・純関数: `src/features/codex/codexSpoilerFlags.ts`（名前は実装時に最終決定）
- 入力: `Map<codexEntryId, ForeshadowRow[]>`（リンク済み伏線）、`sceneOrder: Map<sceneId, number>`、`currentSceneId: string | null`
- 出力: `Map<codexEntryId, Array<{ id: string; title: string }>>`（未開示の秘匿伏線）
- `currentSceneId == null` のときは空（「このシーン時点」が定義不能）
- データ源:
  - `foreshadowCodexLinks`（`codexEntryId → foreshadowId`、`src/features/foreshadow/api.ts:1199-1202` に既存クエリ）
  - foreshadow 行（`secret`/`payoffSceneId`/`abandoned`）は `foreshadowStore`／api 経由
  - これらから `Map<codexEntryId, ForeshadowRow[]>` を **1回構築**するローダ（正確な関数は実装計画で確定。プロジェクト単位で1度、シーン集合に依存しない）

**何をするユニットか**: 「entry と現在シーンを与えると、まだ明かされていない秘匿伏線を返す」。純関数でテスト容易。

### ③ UI 配線
- `CodexQuickSection`（`src/features/tree/CodexQuickSection.tsx`）:
  - `displayed` 配列の entryId 群を ①②に渡す
  - 各行に phase チップ（`phaseLabel` がある時のみ、既存 `bg-primary/10 px-2 py-0.5 text-[10px] text-primary` スタイル流用）
  - 未開示秘匿伏線がある行に ⚠アイコン（lucide `EyeOff`＝「隠されている＝未開示」を直感的に示す）。`title` 属性で tooltip（例: `このシーン時点で未開示: 〈伏線X〉, 〈伏線Y〉`）
  - hover popover に `phaseLabel` / `resolvedSummary` / `spoilerNote` を渡す
- `CodexEntryPopoverContent`（`src/features/codex/components/CodexEntryPopoverContent.tsx`）:
  - optional prop `spoilerNote?: string` を追加し、ある時に ⚠行を描画
  - 既存の `phaseLabel` / `resolvedSummary` プロップはそのまま
- `CodexQuickPopover`（`src/features/tree/CodexQuickPopover.tsx`）: 現在欠落の `phaseLabel` / `resolvedSummary` / `spoilerNote` を受け取り `CodexEntryPopoverContent` へ中継

## データフロー

```
activeSceneId, nodes, phasesByEntry, detailOverrides
        │
        ▼
①useResolvedCodexStates ─► Map<entryId, {phaseLabel, resolvedSummary}>
                                              │
foreshadowCodexLinks + foreshadowStore        │
        │                                     │
        ▼                                     │
②computeUnrevealedSecretForeshadows ─► Map<entryId, secretForeshadow[]>
        │                                     │
        └──────────────┬──────────────────────┘
                       ▼
       ③CodexQuickSection 行 / popover で合成表示（read-only）
```

## エッジケース

- `activeSceneId == null`（シーン未オープン）: phase チップ非表示・foreshadow 警告非表示（base 表示に素直にフォールバック）
- phase を持たないエントリ: チップなし・base summary（現挙動を維持）
- payoff 済み（`order[payoff] <= 現在`）/ `abandoned` / `secret == false`: 警告を出さない
- シーン削除・順序外の `currentSceneId`: `resolveCodexState` が base を返す既存挙動に従う
- i18n: tooltip 文言の ja/en キーを追加
- パフォーマンス: 解決は `displayed`（matched + pinned、通常少数）のみ・`sceneOrder` を memo・`phaseStore` キャッシュに依存。全エントリは対象にしない

## テスト

- 純関数 `computeUnrevealedSecretForeshadows`:
  - payoff = null → 警告
  - payoff が現在より後 → 警告
  - payoff が現在以前 → 警告なし
  - `abandoned` / `secret == false` → 警告なし
  - `currentSceneId == null` → 空
- フック `useResolvedCodexStates`: バッチ解決（抽出した純ロジック単位で）。`CodexPopover` の既存解決と同値であること
- コンポーネント: `CodexQuickSection` が phase チップ＋⚠を描画（store mock・happy-dom）／`CodexEntryPopoverContent` が `spoilerNote` を描画
- 既存 `resolveCodexState` のテストは流用

## 影響を受ける既存コード

| ファイル | 変更 |
|---|---|
| `src/features/editor/CodexPopover.tsx` | インライン phase 解決を①フックに置換（二重実装解消） |
| `src/features/codex/components/CodexEntryPopoverContent.tsx` | `spoilerNote?` prop 追加 |
| `src/features/tree/CodexQuickPopover.tsx` | `phaseLabel`/`resolvedSummary`/`spoilerNote` を中継 |
| `src/features/tree/CodexQuickSection.tsx` | 行に phase チップ＋⚠、①②を配線 |
| `src/features/codex/useResolvedCodexStates.ts` | 新規（①） |
| `src/features/codex/codexSpoilerFlags.ts` | 新規（②） |
| locales ja/en | tooltip 文言キー追加 |

## 既知の制約（記録）

- foreshadow → Codex リンク未設定の伏線は警告対象にならない（リンクが前提）。これは伏線管理側の運用に依存する仕様であり、本機能では補わない
- 警告は秘匿伏線のみ。「秘匿キャラ」「隠しアイテム」等は対象外（`認知度` 信号を採用しないため）
