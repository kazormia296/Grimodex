---
name: bump-version
description: >
  リリースバージョンを上げ、コミットして注釈付きタグを打つ。
  バージョンの正本4箇所を揃え、master直commit→Release タグ作成まで一括で行う。
  Use when: 「バージョン上げて」「パッチ(マイナー/メジャー)バージョン」
  「リリースタグ」「リリース準備して」と言われたとき。
allowed-tools: Read, Edit, Grep, Bash
argument-hint: "[patch|minor|major]  (省略時 patch)"
---

リリースバージョンを上げる。引数 `$1` が bump 種別（`patch`/`minor`/`major`、省略時は **patch**）。

## バージョンの正本は4箇所

すべて同じ値に揃える。`package.json` の `version` が現在値の参照元。

1. `package.json` の `"version"`（5行目付近、`name`/`license` 直下）
2. `src-tauri/Cargo.toml` の `[package]` 内 `version`（`name = "grimodex"` の直下）
3. `src-tauri/tauri.conf.json` の `"version"`（`productName` 直下）
4. `src-tauri/Cargo.lock` の `[[package]] name = "grimodex"` エントリの `version`

**触らない同名の罠（別パッケージ・依存）:**
- `package.json` の `"class-variance-authority": "^0.7.x"` ← 無関係な依存
- `src-tauri/Cargo.lock` の `window-vibrancy` の `version` ← 無関係な依存
- バージョン文字列での grep 一括置換は禁止。上記4箇所をピンポイントで編集する。

**Cargo.lock の自身エントリ**: `Cargo.toml` を編集するとツールチェーン側が
`Cargo.lock` の `grimodex` エントリを自動再生成することがある。編集後に
`[[package]] name = "grimodex"` の `version` が新値になっているか必ず確認し、
古いままなら手で直す（`window-vibrancy` 等の別エントリと取り違えない）。

## 手順

1. **現在値を読む**: `package.json` の `version` を読み、`$1`（既定 patch）で次の値を算出
   （patch: z+1 / minor: y+1, z=0 / major: x+1, y=z=0）。
2. **4箇所を編集**して新値に揃える（上の正本リスト）。
3. **整合性を確認**: 4ファイルすべてが新値か grep で検証。
   ```
   grep -n '"version"' package.json src-tauri/tauri.conf.json
   grep -n '^version' src-tauri/Cargo.toml
   sed -n '/name = "grimodex"/{n;p}' src-tauri/Cargo.lock   # 直下行が新値か
   ```
4. **コミット**（運用方針: master 直 commit・独断でブランチを切らない）:
   - コミット前に `git log origin/master..HEAD` と `git status` を確認。
   - `git add` は `-A` を使わず、変更4ファイルを**明示パスで個別に** add。
   - メッセージ例: `chore(release): バージョンを<旧>から<新>に上げる`
   - コミットメッセージ末尾に Co-Authored-By trailer を付ける。
5. **注釈付きタグを作成**（既存規約: annotated・`vX.Y.Z`・メッセージ `Release vX.Y.Z`）:
   ```
   git tag -a v<新> -m "Release v<新>"
   ```
   lightweight タグ（`git tag v...` のみ）にしないこと。
6. **報告して push 前に確認**: コミット・タグはローカルのみ（未push）であることを伝え、
   push するか必ずユーザーに確認する。独断で push しない。
   - push する場合: `git push origin master` と `git push origin v<新>` の両方が必要。
