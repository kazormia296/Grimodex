---
name: refactor-cross-boundaries
description: >
  Grimodex の既存の外部挙動を保ちながら、renderer、Electron IPC、N-API、
  shared Rust、MCP、永続化、または複数 AI provider 経路のうち2層以上で、
  責務・型・契約・データフローを協調変更する横断リファクタに使う。
  「横断リファクタ」「境界整理」「責務移動」「パイプライン再編」で発火する。
  新機能は implement-feature、新規 IPC command は add-electron-command、
  調査のみは explore-codebase を使う。バグ修正は debug-issue を主フローとし、
  2層以上の既存契約変更を伴う部分では本スキルの影響マトリクスも併用する。
---

# Refactor Cross Boundaries

既存の振る舞いを保ち、複数境界の契約と所有権を一貫して変更する。

## Phase 1: 不変条件とベースライン

1. `AGENTS.md`、対象配下の指示、`git status`、既存差分を確認する。
2. 保持する外部挙動、非目標、互換性要件、対象境界を列挙する。
3. 対象の公開境界を守る focused test を変更前に通す。
4. カバレッジがなければ characterization test を追加し、旧実装で成功させる。
5. `rg` で実際の entry point から consumer／sink まで追跡する。

挙動維持が目的なので、`implement-feature` の red-first TDD は適用しない。テストを失敗させるのは、仕様変更が明示された部分だけとする。

## Phase 2: 影響マトリクスと設計レビュー

広範な編集前に [impact-matrix.md](references/impact-matrix.md) を読み、実行経路ごとに一行を埋める。

- 実行形態、fallback、retry、cancel、永続化形式、wire form が異なる経路は行を分ける。
- 正本となる型・契約・domain ownership を特定する。
- 対象外の経路には理由を記録する。
- 推測は `unknown` とし、対象経路の `unknown` を解消してから実装する。
- external egress、subprocess、background、async lifecycle に関係する各行は、reference の compact lifecycle-owner
  checklist（全 entry/start/retry/reentrant、admission closure、pending-start、active handle ownership、
  cancellation、bounded wait、close/exit/terminal receipt の実終了証拠、error/timeout/onClosed ownership、
  persisted restart state）を満たす。tableへ列を増やさず、各行の lifecycle note として記録する。

可能なら独立した担当に、不変条件、行漏れ、fallback、互換性方針をレビューさせる。

## Phase 3: 縦割りで変更する

1. 公開境界の characterization／contract test を用意する。
2. 一つの代表経路を、正本の契約、domain implementation、adapter と境界検証、consumer、境界テストの順で end-to-end に変更する。
3. focused test を通し、中間レビューで設計のずれとマトリクス漏れを確認する。
4. 残りのマトリクス行へ展開する。
5. 全 consumer の移行後に、旧経路、不要な shim、重複を削除する。

互換 shim は、永続データ、外部 consumer、旧新実装の共存が必要な場合だけ使う。それ以外は一貫した atomic change にする。

コミットを依頼されている場合は、ファイル階層ではなく一つの意図を end-to-end に完結させる縦割り単位にする。各コミットへ関連テストを含め、新しい経路を発見したら先にマトリクスと計画を更新する。

## Phase 4: 影響した CI lane を検証する

各 slice で focused test を実行した後、影響した lane を CI と同じコマンドで検証する。

- renderer: `pnpm verify:frontend`
- browser UI: `pnpm test:browser --run`、`pnpm test:storybook --run`
- Electron shared／preload／main: `pnpm exec tsc -p electron/tsconfig.json --noEmit`、`pnpm test:electron --run`、`pnpm electron:build`
- N-API: `pnpm napi:build`、`pnpm --dir electron/native/grimodex-node test`、CI の release-feature check／clippy／test
- shared Rust／MCP: `.github/workflows/ci.yml` の feature flags で check、clippy、test
- licensing／release workflow: 影響した feature／contract test

固定された feature flags と CI lane は `.github/workflows/ci.yml` を正本とする。Windows 固有テストや network-dependent security job などローカルで再現しない lane は CI へ委ね、省略理由を記録する。重い full suite は focused test と安い gate が通ってから実行する。

## Phase 5: 最終監査と完了

- マトリクスの全行を完了状態にする。
- `rg` で旧 symbol、旧 route、不要な compatibility code の残存を確認する。
- IPC allowlist、入力検証、error envelope、権限境界を再確認する。
- 外部挙動、失敗経路、境界テストの不足を確認する。
- 不変条件、変更経路、検証結果、省略理由、既知のリスクを報告する。
- commit、push、PR、merge はユーザーが依頼したゴールの範囲まで行う。

主目的が新機能の場合は `implement-feature`、バグ修正の場合は `debug-issue` を主フローとし、複数境界の既存経路再編が必要な部分だけ本スキルの影響マトリクスを併用する。
