---
name: explore-codebase
description: >
  コードベースを探索し、構造と実装を理解する。コードは書かない。
  Use when: 「調べて」「調査して」「構造を教えて」「どうなってる？」
  と言われたとき。新しいコード領域に入る前の事前調査に使う。
allowed-tools: Read, Grep, Glob
argument-hint: [exploration-target]
context: fork
agent: Explore
---

「$1」について調査してください。

1. 関連ファイルを特定する
2. データフロー・依存関係を把握する
3. Electron IPC境界（renderer↔preload↔main↔N-API）がある場合、全層を確認する
4. 発見事項を構造化して報告する

**コードの変更は一切行わないこと。**
