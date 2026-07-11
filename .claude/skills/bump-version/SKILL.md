---
name: bump-version
description: >
  リリースバージョンを上げ、コミットして注釈付きタグを打つ。
  Electron版の正本 package.json を更新し、branch + PR で commit→マージ後に
  Release タグ作成まで行う。
  Use when: 「バージョン上げて」「パッチ(マイナー/メジャー)バージョン」
  「リリースタグ」「リリース準備して」と言われたとき。
allowed-tools: Read, Edit, Grep, Bash
argument-hint: "[patch|minor|major]  (省略時 patch)"
---

リリースバージョンを上げる。引数 `$1` が bump 種別（`patch`/`minor`/`major`、省略時は **patch**）。

## Electron版バージョンの正本は `package.json` 1箇所

electron-builder、`app.getVersion()`、v2 release workflow の tag gate はすべて
`package.json` の `version` を参照する。ここだけを更新する。

`src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.lock` の
`grimodex` version は、凍結済み Tauri v1 の履歴・移行契約なので変更しない。
共有Rust crateとN-API crateの `0.1.0` もアプリ版とは別物である。

## 手順

1. **現在値を読む**: `package.json` の `version` を読み、`$1`（既定 patch）で次の値を算出
   （patch: z+1 / minor: y+1, z=0 / major: x+1, y=z=0）。
2. **`package.json` だけを編集**して新値へ上げる。
3. **整合性を確認**: Electron版は新値、凍結Tauri版は v1 のままか検証する。
   ```
   node -p "require('./package.json').version"
   node -p "require('./src-tauri/tauri.conf.json').version"  # frozen v1
   node scripts/validate-release-version.mjs \
     --tag "v<新>" --ref-type tag --package package.json --major 2
   ```
4. **ブランチを切ってコミット**（master へ直接 commit しない）:
   - `git switch -c chore/bump-v<新>`（既に作業ブランチ上ならそのまま使ってよい）。
   - コミット前に `git status` で対象を確認。
   - `git add` は `-A` を使わず、`package.json` とリリースノートを
     **明示パスで個別に** add。
   - メッセージ例: `chore(release): バージョンを<旧>から<新>に上げる`
   - コミットメッセージ末尾に Co-Authored-By trailer を付ける。
5. **push + PR**（push 前にユーザー確認・独断で push しない）:
   - `git push origin chore/bump-v<新>` → `gh pr create`。CI green を確認してマージする。
6. **注釈付きタグを作成**（マージ後・master 上で。既存規約: annotated・`vX.Y.Z`・メッセージ `Release vX.Y.Z`）:
   - `git switch master && git pull` で master を最新化。
   - `git tag -a v<新> -m "Release v<新>"`（lightweight タグ `git tag v...` のみは不可）。
   - `git push origin v<新>`（タグ push もユーザー確認の上で）。

## リリースノート（アプリ内 What's New）

バージョン bump 後、**リリース前**に以下を追加・更新する:

1. `public/RELEASE_NOTES/v{新バージョン}.ja.md` をテンプレートから作成
2. `public/RELEASE_NOTES/v{新バージョン}.en.md` をテンプレートから作成
3. 両ファイルにユーザー向け要約を記入（ja / en それぞれ）

テンプレート例:

```markdown
# vX.Y.Z

## 新機能 / New

- （追記）

## 改善 / Improvements

- （追記）

## 修正 / Fixes

- （追記）
```

GitHub `release.yml` の `releaseBody` とは別管理。アップグレード後の初回起動で
`ReleaseNotesDialog` が ja 正本を参照して表示する（en UI は en → ja フォールバック）。
