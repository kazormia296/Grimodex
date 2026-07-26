---
name: debug-issue
description: >
  バグを調査・修正する。手順は superpowers:systematic-debugging に委譲し、
  ここではプロジェクト固有の確認だけを足す。
  Use when: 「デバッグして」「修正して」「エラーが出る」「動かない」
  と言われたとき。CIの失敗、ランタイムエラー、型エラーの修正に使う。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
argument-hint: [bug-description-or-error-message]
---

「$1」を修正する。

## 方法論は superpowers に委譲する（薄い独自手順で上書きしないこと）

- `superpowers:systematic-debugging` に従う（再現→原因特定→修正→検証）。
  「推測で修正しない＝原因を特定してから直す」はこのスキルが強制する。
- 再発防止テストを書く段では `superpowers:test-driven-development` に従う。

## このプロジェクト固有で必ず確認すること

- Electron IPC 関連なら renderer / preload / main / N-API の各境界を確認する。
- レイアウト/幾何バグは happy-dom では実寸を測れない → `*.browser.test.tsx` で gate する。
- 検証: `pnpm test` ＋（共有 Rust 変更時）`cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding`。N-API adapter 変更時は `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml` も実行する。
- コミットは変更ファイルを個別 `git add`（`git add -A` 禁止）。master へ直接 commit せず branch を切り、push は branch + PR（master 直 push は hook でブロック済み）。
