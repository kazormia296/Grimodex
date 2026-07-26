---
name: debug-issue
description: >
  バグを調査・修正する。再現→原因特定→修正→検証の順で進める。
  Use when: 「デバッグして」「修正して」「エラーが出る」「動かない」
  と言われたとき。一般のPR／master CI、ランタイムエラー、型エラーの修正に使う。
  Electron release workflow、tag build、署名、公証、publishの失敗はdebug-release-ciへ渡す。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [bug-description-or-error-message]
---

「$1」を修正してください。

0. Electron release workflow、tag build、署名、公証、installer migration、artifact publishの失敗なら、versionを変更せず`/debug-release-ci`へ渡す
1. エラーメッセージ・再現手順を確認する
2. 関連コードを探索し、根本原因を特定する
   - Electron IPC関連なら renderer / preload / main / N-API の各境界を確認
3. 修正方針を報告し、承認を得てから実装する
4. 修正を実装する
5. 既存テストが通過することを確認する
6. 再発防止のためのテストを追加する
7. `pnpm test` + `pnpm test:electron --run` + 対象 Rust crate の `cargo test` で確認
8. 変更をコミットする

**推測で修正しない。原因を特定してから修正すること。**
