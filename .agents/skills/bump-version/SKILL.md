---
name: bump-version
description: >
  Grimodex の Electron リリースバージョンを上げ、リリースノート、commit、
  branch、PR、merge、注釈付き Release tag まで進める。
  「バージョン上げて」「パッチ／マイナー／メジャーバージョン」
  「リリースタグ」「リリース準備して」で使用する。
---

# Bump Version

リリースバージョンを上げる。引数が `patch`、`minor`、`major` のいずれかで、指定がなければ `patch` とする。`major` は対象 major の release workflow が準備済みの場合だけ実行する。

## Electron 版バージョンの正本

electron-builder、`app.getVersion()`、v2 release workflow の tag gate は、すべて `package.json` の `version` を参照する。アプリのバージョン値はここだけを更新する。

次は変更しない。

- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.lock` 内の `grimodex` version
- shared Rust crate と N-API crate の `0.1.0`

これらは凍結済み Tauri v1 の履歴・移行契約、またはアプリ版とは独立した crate version である。

## Workflow

1. **Preflight**
   - `git status`、現在の branch、`origin/master` を確認する。
   - ユーザーの既存変更を release commit に混ぜない。
   - bump 種別と、ゴールが local、PR、merge、tag のどこまでかを確認する。
2. **現在値と次の値を決める**
   - `package.json` の `version` を読む。
   - `patch`: `z + 1`
   - `minor`: `y + 1`, `z = 0`
   - `major`: `x + 1`, `y = 0`, `z = 0`
   - `major` の場合、`.github/workflows/release.yml` の tag pattern と release gate が新しい major を受け付けることを確認する。未対応なら version を変更せず、release pipeline migration が必要と報告して停止する。
   - local／remote に `v<新バージョン>` tag が存在しないことを確認する。
3. **`package.json` を編集する**
   - アプリのバージョン値は `package.json` だけを新値へ上げる。
4. **リリースノートを作る**
   - `public/RELEASE_NOTES/v<新バージョン>.ja.md`
   - `public/RELEASE_NOTES/v<新バージョン>.en.md`
   - 直近リリース以降のユーザー向け変更を、ja／en それぞれに要約する。
5. **整合性を検証する**

   ```bash
   node -p "require('./package.json').version"
   node -p "require('./src-tauri/tauri.conf.json').version"
   node scripts/validate-release-version.mjs \
     --tag "v<新バージョン>" --ref-type tag --package package.json --major <新major>
   ```

   Electron 版が新値で、凍結 Tauri 版が v1 のままであることを確認する。release workflow の tag pattern と `--major` も同じ新 major を使っていることを確認する。

6. **branch と commit を作る**
   - `master` へ直接 commit しない。
   - 新規 branch は `chore/bump-v<新バージョン>` とする。既に適切な作業 branch 上ならそのまま使える。
   - `git status` と diff で対象を確認する。
   - `git add -A` は使わず、`package.json` と2つのリリースノートを明示パスで stage する。
   - commit 例: `chore(release): バージョンを<旧>から<新>に上げる`
   - repository の規約で要求される場合だけ `Co-Authored-By` trailer を付ける。
7. **push、PR、merge を行う**
   - release commit を作成して作業ツリーが clean になった後、`/ship-branch` を公開フローとして使用する。
   - ユーザーが依頼したゴールに含まれる push、PR、merge まで進める。
   - `/ship-branch` の CI、mergeability、レビュー、HEAD 固定、base 反映確認を満たす。
8. **注釈付き tag を作成して push する**
   - merge 後の `origin/master` を fetch し、release commit を確認する。
   - ゴールに tag 作成が含まれる場合、`origin/master` の release commit に `v<新バージョン>` を付ける。
   - `git tag -a v<新バージョン> <release-commit> -m "Release v<新バージョン>"`
   - lightweight tag は使わない。
   - tag を push し、remote に反映されたことを確認する。

ユーザーが単にファイル更新だけを指定した場合は、commit、push、PR、merge、tag へ範囲を広げない。一方、ゴールに含まれる操作については段階ごとに同じ承認を取り直さない。

## Release notes template

```markdown
# vX.Y.Z

## 新機能 / New

- （追記）

## 改善 / Improvements

- （追記）

## 修正 / Fixes

- （追記）
```

GitHub `release.yml` の `releaseBody` とは別管理とする。アップグレード後の初回起動では `ReleaseNotesDialog` が ja 正本を参照し、英語 UI は en から ja へフォールバックする。
