---
name: ship-branch
description: >
  現在の作業ブランチを push → PR 作成 → CI green を待ってマージするよう
  頼まれたときに使う。branch-first 運用（master 直 commit/push 禁止）の後半を担う。
  Use when: 「PR 出して」「プルリク作って」「プッシュしてマージ」「マージまでして」
  「ship して」「リモートに上げて PR」と言われたとき。コミットは別スキルの領分。
allowed-tools: Bash, Read
---

作業ブランチのコミットを **push → PR → CI green 待ち → squash マージ → master 同期** まで通す。
master/main へは直接 push しない。**CI が red/pending のときは絶対にマージしない。**

## 前提（実行前に必ず確認）

1. **作業ブランチ上か**: `git branch --show-current` が `master`/`main` なら停止してユーザーに伝える。
   先にブランチを切る（コミットが master に乗っているなら `git switch -c <branch>` で退避してから）。
2. **作業ツリーがクリーンか**: `git status --short` に未コミットがあれば停止し、先にコミットする
   （コミット手順は /implement-feature・/debug-issue 側の領分。`git add -A` は使わず明示パスで個別 add）。
3. **先行コミットがあるか**: `git log origin/master..HEAD --oneline` が空なら PR にならない。

## 手順

1. **push**: `git push -u origin "$(git branch --show-current)"`
   （`git push *` は権限ダイアログが出る＝ここがユーザー確認点。`master`/`main` への push は hook が弾く）。
2. **PR 作成**: ブランチのコミットから title/body を作る。本文はヒアドキュメントで渡す（改行・日本語が崩れない）。
   ```
   gh pr create --base master --title "<簡潔な要約>" --body "$(cat <<'EOF'
   ## 概要
   <変更点の箇条書き>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```
3. **CI を待つ**: `gh pr checks --watch --interval 20`。
   引数を省くと**現在ブランチの PR を自動検出**する（明示するなら手順 2 の `gh pr create` が出力した
   URL 末尾の番号を使う）。push 直後はこのブランチ上にいるので番号は不要。
   Rust/Browser/claude-review で 5〜10 分かかるので **Bash を `run_in_background: true` で実行**し、
   完了通知で再開する（foreground で長時間待たない）。
   チェックが無い PR では `gh pr checks` が "no checks reported" で即終了する → その場合は手順 4 へ進む。
4. **green のときだけマージ**: 全チェック pass を確認してから
   `gh pr merge --squash --delete-branch`（こちらも引数省略で現在ブランチの PR が対象）。
   **1 つでも fail/pending が残るならマージせず**、失敗チェックを報告して止まる。
   （merge は gh API 経由なので block-push-to-main hook には当たらない。）
5. **master を同期**: マージ後は `git switch master` → `git pull` で local を最新化し、ブランチ削除を確認。

## オプション

- **PR だけ作って止めたい**（「PR だけ」「マージはまだ」）: 手順 1〜2 で停止し、PR の URL を報告する。
- マージ方式は **squash 既定**（master の履歴を線形に保つ）。merge commit / rebase が要るときだけ変える。

## よくある失敗

| 失敗 | 対策 |
| --- | --- |
| master 上で実行 | 先にブランチを切る。master 直 push は禁止・hook で弾かれる。 |
| CI red/pending なのにマージ | red/pending では絶対にマージしない。失敗を直して再 push。 |
| 合成 git コマンドが権限拒否 | `&&` で繋がず単純コマンドに分割する（特に `git reset --hard` 系）。 |
| PR 本文の改行・日本語が崩れる | `--body` はヒアドキュメント（`<<'EOF'`）で渡す。 |
| マージ後に local master が古いまま | `git switch master` → `git pull` で同期する。 |
