---
name: test-feature
description: >
  Grimodex の指定機能に対するテスト追加・実行、または既存テスト結果の確認を行う。
  実行だけの依頼では、テスト追加や製品コードの修正まで範囲を広げない。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
argument-hint: [feature-or-file-path]
---

# Test Feature

依頼が既存テストの実行、結果の確認、テスト追加のどれを含むかを判定し、その範囲で検証する。
新機能や不具合修正の一部として使う場合は、その作業の受入れ条件に合わせる。

## 検証対象と配置

- 実装の写しや mock の呼び出し確認だけでなく、利用者または公開 API が観測する振る舞いを検証する。
  失敗経路や境界値は、対象のリスクと既存カバレッジから選ぶ。
- TypeScript は Vitest の `*.test.ts(x)` をソースと同階層に置く。
  Rust は共有 crate または N-API adapter の `#[cfg(test)]` モジュールを使う。
- レイアウトや幾何の assert は `*.browser.test.tsx` で行う。happy-dom は flex／grid の実寸を計算しない。
- Electron IPC を扱うテストは allowlist、引数変換、Envelope の境界を確認する。
- immutable child／revision、bounded lookup を扱う場合は
  [ID と検索範囲の契約](../../../policies/quality/iron-laws.md#immutable-identity) を検証する。

## 実行と結果

対象に応じた focused test を実行し、どの要求や失敗条件を検証したかと結果を報告する。
失敗時は製品、テスト、環境のどこに原因があるかを証拠で判定し、成功させるためだけに期待値を
変更しない。製品コードの修正が依頼範囲に含まれない場合は、原因と修正案を報告する。

Quick／Full や公開証跡の扱いは
[検証と公開範囲](../../../policies/quality/iron-laws.md#agent-validation) に従う。
