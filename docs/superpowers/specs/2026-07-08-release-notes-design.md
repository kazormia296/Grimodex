# バージョンアップ時リリースノート表示 設計書 (2026-07-08)

## 概要

アプリを新バージョンにアップグレードした**後の初回起動**で、そのバージョンの
リリースノートをモーダル表示する。日本語・英語の両ロケールに対応し、UI 言語に
応じて適切な Markdown を読み込む。既存の `EulaConsentDialog` /
`MarkdownDoc` / `globalSettings` 永続化パターンに沿って実装する。

**スコープ外（YAGNI）**

- 更新検出時（`UpdateToast`）の全文モーダル化
- 複数バージョン分のノートをまとめて表示（飛び級アップ時も**最新版のみ**）
- GitHub Releases API からの動的取得

## 背景（現状）

| 既存資産 | 状態 |
|----------|------|
| `tauri-plugin-updater` + `UpdateToast` | 更新**前**に `update.body` を最大 60px で省略表示 |
| `EulaConsentDialog` | `acceptedEulaVersion` と定数比較 → モーダル |
| `MarkdownDoc` | `public/` 直下の `.md` を fetch + ReactMarkdown |
| GitHub `release.yml` | `releaseBody` に手書き追記（インストール手順テーブル含む） |
| 更新**後**の What's New | **未実装** |

## 要件

### 表示タイミング

- `getVersion()` の semver が `globalSettings.lastSeenReleaseNotesVersion` より**新しい**
  とき、起動後にモーダルを 1 回表示する。
- 対象: patch / minor / major すべて（初回インストールを除く、後述）。
- 手動インストール（GitHub から DL）後の初回起動も同じフロー。
- dev モード (`import.meta.env.DEV`) および非 Tauri 環境ではゲートをスキップ
  （既存 `useUpdateChecker` と同様）。

### 初回インストール

- `lastSeenReleaseNotesVersion` が未設定（`undefined` / `null`）= 初回インストール扱い。
- 初回はダイアログを**出さない**。代わりに `lastSeenReleaseNotesVersion` を現在版に
  設定して永続化する（サイレント初期化）。次回以降のアップグレードから表示開始。

### 表示優先順位

1. `EulaConsentDialog` が表示中 → リリースノートは待機
2. EULA 同意完了（または不要）後 → リリースノート判定・表示

両ダイアログが同時にモーダルになることはない。

### ロケール（日本語 + 英語）

UI 言語 (`globalSettings.uiLanguage` / `i18n.language`) に応じて Markdown を選択する。

| UI 言語 | 読み込むファイル（優先順） |
|---------|---------------------------|
| `en` 系 | `RELEASE_NOTES/v{version}.en.md` → 無ければ `v{version}.ja.md` |
| それ以外（既定 `ja`） | `RELEASE_NOTES/v{version}.ja.md` のみ |

- 英語 UI で日本語のみ存在する場合: 日本語本文を表示（フォールバック）。
  タイトル等の UI ラベルは i18n キーで英語のまま。
- 日本語 UI で英語のみ存在する場合: **表示しない**（`lastSeen` を進めてスキップ）。
  日本語向けアプリとして ja ファイルが正本。

### コンテンツ不在時

- 現在版に対応する **ja ファイルが無い**場合: ダイアログは出さず、
  `lastSeenReleaseNotesVersion` を現在版に更新してスキップ（運用漏れで起動が止まらない）。
- en のみ存在・ja 無し: 上記と同様にスキップ（ja が正本のため）。

### 手動再表示

Settings > About に「リリースノートを見る」ボタンを追加。現在版のノートを
ロケール選択ルールに従っていつでも開ける（`lastSeen` は変更しない）。

## アーキテクチャ

```
起動 → globalSettings 読込完了
     → getVersion() 取得
     → EULA 要同意？ → EulaConsentDialog 表示（リリースノート待機）
     → semver(current) > semver(lastSeen) ?
         lastSeen 未設定 → lastSeen = current を永続化して終了（初回インストール）
         yes（アップグレード）→ resolveReleaseNotesPath(version, uiLanguage)
               ja ファイル存在？ → ReleaseNotesDialog 表示
               無し → lastSeen = current を永続化してスキップ
         no → 終了

「閉じる」→ lastSeenReleaseNotesVersion = current を永続化
```

## ファイル構成

```
src/features/release-notes/
  ReleaseNotesDialog.tsx    # モーダル UI
  useReleaseNotesGate.ts    # 表示判定・パス解決・永続化
  resolveReleaseNotesPath.ts # ロケール → public 相対パス
  semver.ts                 # "0.10.4" 形式の比較
  semver.test.ts
  resolveReleaseNotesPath.test.ts
  ReleaseNotesDialog.test.tsx
  useReleaseNotesGate.test.ts

public/RELEASE_NOTES/
  v0.10.5.ja.md             # バージョンごと（bump 時に追加）
  v0.10.5.en.md
```

### Markdown ファイル命名規則

- パターン: `v{semver}.ja.md` / `v{semver}.en.md`
- 例: `v0.10.5.ja.md`, `v0.10.5.en.md`
- `MarkdownDoc` の `src` 引数: `RELEASE_NOTES/v0.10.5.ja.md`

### テンプレート（bump 時に両方作成）

**`vX.Y.Z.ja.md`**

```markdown
# vX.Y.Z

## 新機能

- （追記）

## 改善

- （追記）

## 修正

- （追記）
```

**`vX.Y.Z.en.md`**

```markdown
# vX.Y.Z

## New

- (add items)

## Improvements

- (add items)

## Fixes

- (add items)
```

## データモデル

### `GlobalSettings` 追加フィールド

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `lastSeenReleaseNotesVersion` | `string?` | ユーザーがリリースノートを確認済みの最終バージョン |

**更新箇所（両方必須）**

- `src/features/workspace/store.ts` — `GlobalSettings` interface
- `src-tauri/src/workspace.rs` — `GlobalSettings` struct（`#[serde(rename_all = "camelCase")]`）

Rust 側:

```rust
/// Last app version for which the user has seen release notes (e.g. "0.10.4").
#[serde(default)]
#[serde(skip_serializing_if = "Option::is_none")]
pub last_seen_release_notes_version: Option<String>,
```

## UI 仕様

### `ReleaseNotesDialog`

- ベース: `@/components/ui/dialog`（`EulaConsentDialog` と同型）
- `showClose={false}`、`onInteractOutside` / `onEscapeKeyDown` は prevent しない
  （ESC・外側クリックで閉じられる。EULA より緩い）
- タイトル: i18n `releaseNotes.title` — 例: 「v{{version}} の新機能」/ "What's New in v{{version}}"
- 本文: `MarkdownDoc`（スクロール可能、`max-h-[70vh]`）
- フッター: 「閉じる」ボタン 1 つ（`releaseNotes.close`）
- 英語フォールバック時: 本文上に muted な注記
  （`releaseNotes.fallbackLocale` — 「日本語版を表示しています」/ "Showing Japanese release notes"）

### Settings > About

- `AppInfoHeader` または About カテゴリ内に「リリースノートを見る」ボタン
- クリックで `ReleaseNotesDialog` を手動オープン（ゲートをバイパス）
- 現在版のノートが無い場合: sonner toast で `releaseNotes.notAvailable`

### マウント位置

`App.tsx` で `EulaConsentDialog` の直後に `<ReleaseNotesDialog />` を配置。

## `semver.ts`

- 入力: `"0.10.4"` 形式（pre-release サフィックスは現状非対応で十分）
- `compareSemver(a, b): -1 | 0 | 1`
- `isNewer(current, lastSeen): boolean` — `lastSeen` が null/undefined なら `false`
  （初回判定は gate 側で別処理）

## `resolveReleaseNotesPath.ts`

```ts
type Locale = "ja" | "en";

function resolveReleaseNotesPath(
  version: string,
  uiLanguage: string,
): { primary: string; fallback?: string } | null
```

- `version` → `v{version}.ja.md` / `v{version}.en.md` のパスを返す
- `uiLanguage.startsWith("en")` → primary=en, fallback=ja
- それ以外 → primary=ja のみ

存在確認は `fetch` HEAD または GET + ok チェック（`MarkdownDoc` と同じ fetch パターン）。
gate 側で primary → fallback の順に試行。

## i18n キー（`src/locales/ja.json` / `en.json`）

| キー | ja | en |
|------|----|----|
| `releaseNotes.title` | v{{version}} の新機能 | What's New in v{{version}} |
| `releaseNotes.close` | 閉じる | Close |
| `releaseNotes.viewButton` | リリースノートを見る | View release notes |
| `releaseNotes.notAvailable` | このバージョンのリリースノートはありません | No release notes for this version |
| `releaseNotes.fallbackLocale` | 日本語版を表示しています | Showing Japanese release notes |

## 運用（`/bump-version` スキル追記）

バージョン bump 時に以下を追加:

1. `public/RELEASE_NOTES/v{新}.ja.md` をテンプレートから作成
2. `public/RELEASE_NOTES/v{新}.en.md` をテンプレートから作成
3. リリース前に両ファイルへ内容を記入（ja / en それぞれ）

GitHub `release.yml` の `releaseBody` とは**別管理**。アプリ内表示用に
インストール手順などを除いたユーザー向け要約を書く。必要なら GitHub 本文から
コピーして整形してもよいが、自動同期はしない。

## テスト方針

| 対象 | 内容 |
|------|------|
| `semver.test.ts` | `0.10.3` vs `0.10.4`、`0.9.0` vs `0.10.0`、等しい場合 |
| `resolveReleaseNotesPath.test.ts` | en/ja UI ごとのパス・フォールバック |
| `useReleaseNotesGate.test.ts` | 初回スキップ、アップグレード表示、ja 無しスキップ、EULA 待機 |
| `ReleaseNotesDialog.test.tsx` | レンダリング、閉じるで `updateGlobalSettings` 呼び出し |
| `browser-mock.ts` | `lastSeenReleaseNotesVersion` の read-modify-write 対応（必要なら） |

## エラーハンドリング

- `getVersion()` 失敗: ゲート全体をスキップ（サイレント）
- Markdown fetch 失敗: primary 失敗時 fallback 試行、両方失敗ならスキップ +
  `lastSeen` を進める（無限再表示防止）
- `updateGlobalSettings` 失敗（閉じる時）: sonner toast（`common.saveFailed` 系）、
  ダイアログは開いたまま再試行可能

## 将来拡張（今回は実装しない）

- pre-release 版 (`0.11.0-beta.1`) の semver 比較
- GitHub Releases との自動同期スクリプト
- リリースノート内の画像・動画埋め込み
