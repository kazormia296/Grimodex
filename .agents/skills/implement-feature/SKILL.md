---
name: implement-feature
description: >
  機能を実装する。計画→TDD→実装→検証の順で進める。
  Use when: 新機能の追加、既存機能の拡張、「実装して」「作って」「追加して」
  と言われたとき。UIコンポーネント、DB操作、Electron IPC追加を含む。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
---

以下の手順で「$1」を実装してください。

## Phase 1: 探索

1. 関連コードを探索し、影響範囲を把握する
2. 既存のパターン（類似機能の実装方法）を確認する

## Phase 2: TDD（コンテキスト汚染を防ぐ）

3. 高リスクな横断変更では、テストを書く前に
   [impact matrix](../refactor-cross-boundaries/references/impact-matrix.md) を完成させ、各対象経路の
   owner／lifecycle completeness と `unknown` を解消する。
4. **テストファイルを先に作成する**
   - 正常系・異常系・エッジケースをカバー
   - 実装の詳細を仮定せず、公開APIの振る舞いをテストする
5. 可能なら focused test で期待する失敗またはベースラインを確認する。red commit は必須ではなく、
   ユーザーが明示的に求めない限り作成しない。

## Phase 3: 実装

6. テストを通過するよう実装する
7. 実装中にテストを変更する必要がある場合は、invalid／flaky／incorrect-assumptionである根拠を記録する。
   実装に合わせるためにテストを弱めてはならない。

## Phase 4: 検証

8. 変更範囲とリスクに比例した focused validation（関連テスト、型、lint、Electron／Rust境界など）を選んで実行する。
   必要性のない全テストや重い検証を一律に要求しない。
9. focused validation後、commitが依頼範囲に含まれる場合はCI許可の有無にかかわらず候補commitを作成する。
   PR／releaseが依頼範囲に含まれ、CIが許可されている場合は、cleanな候補HEADで`candidate_base`／`candidate_head`を一度だけ解決し、同じ値をQuickと直後のverifyへ渡す。
   CIが明示的に除外されたcommit-only作業ではQuickを実行せず、commitだけを保持してmerge readinessを主張しない。ユーザーがcommit／PRを依頼していない場合はQuickのためだけにcommitを作らず、CIも開始せず、working-tree評価は診断専用とする。
   失敗、blocked、partial、dry-runは成功扱いにしない。候補変更後は旧receiptを再利用しない。

   ```bash
   candidate_base="$(git rev-parse 'origin/master^{commit}')"
   candidate_head="$(git rev-parse 'HEAD^{commit}')"
   pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
   pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"
   ```

10. 許可されたPR／release候補のQuick＋verifyが完了したら、候補commitをcompletion commitとして保持する。
    commit-onlyまたはCI明示除外ではQuickなしで候補commitを保持し、merge／release readinessを主張しない。commitが依頼されていない場合は
    作業ツリーをcommitせず、検証結果を診断専用として報告する。
11. 高リスク変更では、その後にrequired high-effort reviewとread-only acceptanceを収束させる。review後のcontent changeは
    acceptance／receiptを無効化し、影響したchecksとacceptanceを繰り返す。
12. 高リスク変更で必要なgateが承認されたらcandidateをfreezeし、resource-isolation preflightを行ってからFullへ進む。

各ステップの結果を簡潔に報告すること。
