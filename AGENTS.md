# Grimodex — AI統合小説執筆エディタ

Electron + React 19 + TypeScript、TipTap、SQLite の小説執筆エディタ。
コア体験は、AIとのチャットから知識を抽出・構造化して執筆に活かすこと。

## 実装の境界

- renderer → typed preload IPC → Electron main → N-API → 共有 Rust の順で呼び出す。
  renderer から Node／Electron／N-API を直接 import しない。
- IPC の正本は `electron/shared/ipcContract.ts`。main で引数を再検証する。
  renderer は `src/lib/` の wrapper 経由で `window.grimodex` を利用する。
- Rust ドメイン実装は `src-tauri/crates/`、Electron binding は
  `electron/native/grimodex-node/`。`src-tauri` 直下の Tauri shell は v1 互換・移行確認用の
  frozen legacy で、新機能の実装先にしない。共有 crates と standalone MCP は現役。
- React は関数コンポーネントと hooks、グローバル状態は Zustand、局所状態は Jotai。
  ES modules、TypeScript strict、2スペースインデントを使う。
- renderer の DB 操作は Drizzle 経由。schema／migration の正本は `grimodex-db`。
  SQLite は WAL／FTS5 を使う。
- シーンごとの独立 TipTap インスタンスと AI 会話履歴、挿入テキストの
  source metadata（human／ai／unknown）を維持する。

## 作業範囲と完了

依頼された変更とその検証を終えるまで進める。承認済みの範囲内の可逆な修正・検証で
再承認を求めない。調査・レビューだけの依頼は read-only とし、既存の無関係な差分を保持する。
commit、push、merge、公開は依頼範囲に含まれる場合だけ行い、明示された停止点を守る。
commit は作業ブランチで行い、変更ファイルを明示して stage する。master に直接 commit／push しない。
#610 の C-query 作業では、worker／所有権／終了処理とその技術的脅威モデルの判断を
ユーザーが事前委任している。既存の作業記録に具体的な判断と安全境界を残して進め、
同じ範囲の個別確認を繰り返さない。製品認可の削除、秘密の外部送信、8 ms／2 MiB／Gold 等の
受入れ条件の黙示変更、指定外の送信先は委任に含まれない。

検証は変更内容とリスクで選ぶ。調査・レビューや通常文書だけの作業で Quick／Full を開始しない。
AI指示・skills・品質規則は動作契約なので、通常文書と区別して品質ゲートを適用する。
同じ候補・環境・command の成功結果は、変更・失敗・未解決の懸念がなければ再実行しない。
完了時は結果、実施した検証、未解決事項を報告し、未実行を成功扱いしない。

## 必要な場面で読む正本

該当する作業の前に、次のリンク先の対象節を読む。全ファイルの一括読込は不要。

- 開発環境・コマンド: [README の Development](README.md#development--開発)、実行定義は `package.json`
- React／TipTap／renderer: [フロントエンド規約](src-CLAUDE.md)
- 共有 Rust／N-API／DB: [Rust 規約](src-tauri-CLAUDE.md)
- 検証範囲の選択: [検証の適用条件](policies/quality/iron-laws.md#agent-validation)
- 長期・高リスク、security-sensitive threat model、external-egress／subprocess／background／async-lifecycle、外部 Claude review: [GDX-PRECHECK-001](policies/quality/iron-laws.md#GDX-PRECHECK-001)。編集・送信前に適用し、必要なユーザー確認が未了なら `[precheck]` で停止する
- PR／merge／release の CI 証跡、candidate freeze、Full 前の resource-isolation preflight: [GDX-TRACE-001](policies/quality/iron-laws.md#GDX-TRACE-001) と [CI runner](docs/local-ci-runner.md)。clean な候補、固定 base／head、receipt の条件を守る
- immutable child／revision、bounded lookup、Journey: [ID とページネーションの契約](policies/quality/iron-laws.md#immutable-identity)
- AI指示・prompt・policy・評価: [Iron Laws](policies/quality/iron-laws.md) の関連 requirement と `evals/quality-manifest.yaml`

通常の PR／branch push で hosted checks がないことを green の根拠にしない。
commit-only は Quick を要求せず、merge／release readiness を主張しない。

## Skill の選択

単語の一致だけでなく、依頼の目的と変更対象から主フローを選ぶ。補助 skill はその担当範囲だけに使う。

- コードの調査だけ: [explore-codebase](.agents/skills/explore-codebase/SKILL.md)
- 新機能・既存機能の拡張: [implement-feature](.agents/skills/implement-feature/SKILL.md)
- バグ・一般 CI の修正: [debug-issue](.agents/skills/debug-issue/SKILL.md)
- Electron の新規 IPC command: [add-electron-command](.agents/skills/add-electron-command/SKILL.md)
- 既存経路を renderer／IPC／N-API／Rust／MCP または複数 AI provider の2層以上で再編: [refactor-cross-boundaries](.agents/skills/refactor-cross-boundaries/SKILL.md)。実装前に影響マトリクスを作る。バグ修正時は補助として使う
- AI指示・システムプロンプト・skill・AI評価fixture の変更: [grimodex-author](.agents/skills/grimodex-author/SKILL.md)
- 差分評価・品質ゲートの実行依頼／AI behavior asset 変更後: [grimodex-impact-gate](.agents/skills/grimodex-impact-gate/SKILL.md)
- 通常のコードレビュー／多次元敵対的レビュー: [review-code](.agents/skills/review-code/SKILL.md)／[adversarial-review](.agents/skills/adversarial-review/SKILL.md)
- テスト作成・不足ケースの検証: [test-feature](.agents/skills/test-feature/SKILL.md)
- UI のアニメーション・トランジション: [polish-motion](.agents/skills/polish-motion/SKILL.md)。`src/lib/animation.ts` の共有定数を使う
- 最新基点から作業ブランチを作成: [create-branch](.agents/skills/create-branch/SKILL.md)
- push・PR・merge: [ship-branch](.agents/skills/ship-branch/SKILL.md)
- version 更新・release 準備: [bump-version](.agents/skills/bump-version/SKILL.md)。GitHub Release は Draft で停止し、公開には別の明示指示が必要
- release workflow／tag build／署名／公証／packaging／publish 失敗: [debug-release-ci](.agents/skills/debug-release-ci/SKILL.md)。修正中は version／release notes／tag を変更しない
- リリースノートなどの公開向け文章: [write-grimodex-copy](.agents/skills/write-grimodex-copy/SKILL.md)。技術文書・UI文言には適用しない
- validation 起動時の tsx IPC pipe／listen EPERM: [rerun-sandbox-eperm](.agents/skills/rerun-sandbox-eperm/SKILL.md)。一般の権限エラーには使わない

## GitHub 認証

sandbox 内だけで `gh auth status` が invalid になる場合は OS keyring の可視性を疑う。
利用可能な許可済み host 実行で同じ確認を行い、成功したら必要な GitHub 操作をそこで続ける。
host 確認前に logout／再ログインを要求せず、token は表示しない。
実行環境が権限昇格を許可しない場合は、それを回避せず可視性の制限として報告する。
