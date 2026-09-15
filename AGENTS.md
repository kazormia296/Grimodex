# Grimodex — AI統合小説執筆エディタ

## プロジェクト概要

Electron + React 19 + TypeScript。TipTapベースのリッチテキストエディタに
AIチャットパネルとCodex/Snippet抽出機能を組み合わせた小説執筆ツール。
**コア体験: AIとのチャットから知識を抽出し、構造化して執筆に活かす。**

現行デスクトップランタイムは Electron。renderer は typed preload IPC を介して
main process を呼び、Rust 実装は N-API モジュールと standalone MCP から共有する。
`src-tauri` 直下の Tauri シェルは v1 互換・移行確認用に凍結した legacy コードであり、
新機能の実装先にしない。`src-tauri/crates/` の共有 crates と MCP は引き続き現役。

## コマンド

- デスクトップ開発: pnpm electron:dev
- フロントのみ: pnpm dev
- ビルド: pnpm electron:build
- パッケージ: pnpm electron:package
- テスト: pnpm test
- テスト(単体): pnpm test --run [ファイルパス]
- 差分ローカルCI: pnpm ci:local:quick
- 完全ローカルCI: pnpm ci:local:full
- ローカルCI一覧: pnpm ci:local:list
- ローカルCI証跡検証: pnpm ci:local:verify -- <quick|full> --base origin/master --head HEAD
- フロントCI相当: pnpm verify:frontend
- Electronテスト: pnpm test:electron --run
- N-APIビルド: pnpm napi:build
- N-APIテスト（上記ビルド後）: pnpm --dir electron/native/grimodex-node test
- Lint: pnpm lint:fix
- 型チェック: npx tsc --noEmit
- Electron型チェック: pnpm exec tsc -p electron/tsconfig.json --noEmit
- N-APIチェック: cargo check --manifest-path electron/native/grimodex-node/Cargo.toml
- 共有Rustチェック: cargo check --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding
- 共有Rustテスト: cargo test --manifest-path src-tauri/Cargo.toml --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding

## ローカルCI gate

- 通常のPR／branch pushではGitHub Actionsのrunnerを起動しない。hosted PR checkが無いことを
  greenの根拠にせず、次のローカル証跡を必須gateとして扱う。
- 関連する実装・修正・AI behavior assetの変更を終えた後、完成commitまたはPRを作る前に
  `pnpm ci:local:quick` を実行する。比較範囲を固定する場合は
  `pnpm ci:local:quick -- --base origin/master --head HEAD` とし、直後に同じrefで
  `pnpm ci:local:verify -- quick --base origin/master --head HEAD` を実行する。
- merge前の初回Fullは、最新の`origin/master`を含むcleanかつcommit済みの現在HEADで、最初のstageから
  `pnpm ci:local:full -- --base origin/master --head HEAD` を実行する。直後のverifyは、そのFull receiptに記録された
  `resolvedBaseSha`／`resolvedHeadSha`を同じrefとして使う。通常pathのmerge直前だけは、現在の`origin/master`とcandidate
  HEADに対して再verifyする。初回Fullの前にbaseが変わった場合はcandidateを安全に更新してHEADを取り直し、Fullを最初から
  やり直す。candidateをfreezeしてFull receiptを得た後のupstream baseの進行は原則として古い証跡を再利用しない。ただし、
  candidate HEAD／PR diffが不変で、upstream deltaがeditorial docs/ADR-onlyであり、executable、build、dependency、CI、policy、
  schema、manifest、generated-contractの内容もratified decision／acceptance meaningも変えていないことを確認できる場合に限り、
  狭いupstream-base exceptionを適用できる。exceptionでは旧receiptを記録済みの旧base／headに対してだけ再verifyし、upstream
  deltaは別に分類する。exceptionと比例したstatic／focused checksを記録し、旧receiptを新しいbaseに束縛されたものとは扱わない。
  曖昧さまたはcandidate HEADの変更が一つでもあればreceiptを無効化し、Full-from-stage-1 + verifyをやり直す。
- release tag前は、squash前のbranch証跡を再利用せず、merge後のrelease commitそのものを
  cleanなcheckout／worktreeの現在HEADとして同じFullとverifyを再実行する。
- `--from`は失敗調査・再開用のpartial run、`--dry-run`は計画確認だけである。どちらも
  merge／releaseの成功証跡にせず、原因解消後に`--from`なしのFullを最初から実行する。
- 必須command、toolchain、依存、host capabilityが不足した場合は`blocked`として停止する。
  skipped、deferred、古いreceipt、Windows以外で実行不能なrelease-only項目をpassedへ
  読み替えない。Windows NSISの最終compileは手動Full CI／tag releaseで別途検証する。

## 高リスク作業の運用規律

- セキュリティに関わる `security-sensitive threat model` は `draft` のまま保持する。信頼主体／未信頼主体
  （trusted/untrusted actors）、対象内／対象外の攻撃（in-scope and out-of-scope attacks）、必須防御
  （mandatory defenses）、受入れ条件への影響（acceptance implications）を確認し、explicit user confirmation
  （ユーザーの明示確認）が得られるまで固定しない。material changes には reconfirmation（再確認）が必要である。
  サブエージェントとレビュー担当は提案だけを行い、脅威モデルを無断で固定・変更しない。確認未了は blocking
  precheck として `[precheck]` で停止する。
- 長期または高リスクの作業は、実装担当と独立した受入れレビュー担当を分離する。`one integrator`（統合担当1名）、
  `implementer(s)`（実装担当）、`candidate-untouched independent acceptance reviewer(s)`（候補を編集していない
  独立受入れレビュー担当）を置き、役割を重複させない。受入れレビュー担当は候補を編集しない。候補台帳
  （`single candidate ledger`）に `base`、`head`、`tree`、`clean state`、`receipt directory`、ユーザー確認済み
  `threat-model version/ref` を記録し、`focused gates` を通過してから `freeze` する。大規模な横断変更は
  `reviewable lanes` に分割し、`critical candidate` は必要最小限に保つ。`freeze` 後は編集せず、finding があれば
  候補を再開して receipt を無効化する。
- external-egress／subprocess／background／async-lifecycle の変更は、編集前に有限（`finite owner/lifecycle
  matrix`）の行列を作る。全ての `entry/start/retry/reentrant` 経路を対象に、admission closure、pending-start work、
  active handle ownership、cancellation、bounded wait、実際の終了証拠（`close/exit/terminal receipt`）、
  `error/timeout/onClosed` の所有者、persisted restart stateを各行へ割り当てる。kill request、error event、
  rejected promiseだけではtermination proofにならない。high-effort reviewとcandidate-untouched independent
  acceptance reviewはP2+をfreezeと高コストなFullの前に解消し、Full後はcandidateが不変であることを確認するだけとする。
  candidateに変更がなければ意味のレビューを開き直さない。
- 高コストな Full の前には、generic resource-isolation preflightと、リスク評価で適用対象となった late stage に限る
  focused preflight（`risk-derived applicable late stages only`）を実施する。resource-isolationはno competing heavy run、
  enough writable capacity on actual workspace/build-cache/temp filesystemsを確認し、root/home pressureとtemp quotaを
  separateに確認する。any fixed capacity/quota threshold（GB、percentage、inode、その他numericを含む）、host-specific cache deletion list、
  deletion automationは要求・実施しない。thresholdsはrisk/workload/filesystem stateから導出し、hardcodeしない。このpreflightはread-onlyであり、must not auto-delete artifacts, kill other jobs, or rewrite temp paths。
  competing jobはcoordination stopであり、kill authorityではない。runtime performance／fresh Xvfb、migration/recovery、real product journeys は例示（examples）であり、
  一律要件（blanket requirements）ではない。該当しない host capability は要求せず、block条件にも使わない。各
  preflight は診断専用（diagnostic only）で、clean Full-from-stage-1 + verifyを置き換えない。
- 原因不明の runtime failure は、因果関係を示す causal evidence が得られるまで `unattributed runtime blocker`
  として扱う。変更したパスだけから環境または製品の状態を推定しない。rAF、event-loop、wake/discovery counts、
  memory-sampler duration、process CPU/I/O、device/PSI を相関させ、exact failed receipt を保存する。
- `diagnostic/P3 debt` は、ユーザーの明示的な許可がない限り `critical candidate` から分離する。
- 外部 Claude review では、送信前に data categories（データ分類）と permission（送信許可）を確認する。ユーザーが
  override しない限り、`claude-fable-5-1` を effort `high` で使う。requested/effective model・effort・Fast を記録し、
  silently substitute しない。外部 review の条件は実施する作業の開始時 precheck で固定し、確認は承認済みデータに限る。
  すべてのリポジトリやログを送る包括許可にはしない。

## GitHub認証（Codex sandbox）

- 通常のユーザー端末では `gh auth status` が成功していても、Codex の sandbox 内では
  OS keyring を参照できず、`The token in default is invalid` と誤判定されることがある。
- sandbox 内の失敗だけを根拠に、ユーザーへ再ログインを依頼したり `gh auth logout` を
  実行したりしない。まず同じ `gh auth status` を `require_escalated` で再実行し、
  sandbox 外の keyring から認証状態を確認する。
- 認証が sandbox 外で成功した場合、keyring／ネットワークを必要とする `gh`・`git`
  操作も、必要な範囲に限定して escalation して続行する。トークン本体は出力しない。
- sandbox 外でも失敗した場合に限り、`gh auth login -h github.com` をユーザーへ案内する。

## コード規約

- ES modules（import/export）、CommonJS禁止
- 2スペースインデント、TypeScript strictモード
- React: 関数コンポーネント + hooks のみ
- 状態管理: グローバル=Zustand、局所=Jotai
- DB操作: Drizzle ORM経由、生SQL禁止
- テスト: Vitest、ソースと同階層に \*.test.ts
- コンポーネント: 1ファイル1コンポーネント、200行超えたら分割
- Rust: unwrap()禁止、thiserror/anyhow使用（共有 crates の詳細は src-tauri-CLAUDE.md）
- アニメ: duration/easing は `src/lib/animation.ts` の `DURATIONS`/`EASINGS`/`VARIANTS` 経由（べた書き禁止、詳細は /polish-motion）
- React/TS詳細は src-CLAUDE.md を参照

## アーキテクチャ原則

- feature-based ディレクトリ構造（src/features/[name]/）
- renderer は Node/Electron/N-API を直接 import せず、`window.grimodex` の typed preload API を使う
- IPC の正本は `electron/shared/ipcContract.ts`。main 側で引数を再検証し、N-API backend を呼ぶ
- Rust のドメイン実装は `src-tauri/crates/` に置き、Electron 用 binding は `electron/native/grimodex-node/` に置く
- 既存経路の責務・型・契約・データフローを renderer／Electron IPC／N-API／shared Rust／MCP、
  または複数 AI provider 経路のうち2つ以上で協調変更する場合は、`/refactor-cross-boundaries` を使用し、実装前に影響マトリクスを作る
- AI指示、system prompt、Codex skill、AI policy、AI経路レジストリ、評価fixtureなどの
  AI behavior asset を作成・変更する場合は `/grimodex-author` を使用し、実在する正本と評価証跡を一緒に更新する
- AI behavior asset の変更後、および commit／PR 前の差分評価では `/grimodex-impact-gate` を使用し、
  canonical quality workflow が選択した Light suite を読み取り専用で実行する
- sandbox 内の tsx IPC pipe／listen EPERM で validation が起動不能になった場合は
  `/rerun-sandbox-eperm` を使用し、同一 command を sandbox 外で一度だけ再実行して判定する
- 通常の単一 pass レビューは `/review-code`、独立 reviewer による多次元敵対的レビューは
  `/adversarial-review` を使用し、reviewer の model／effort／Fast の requested と effective を記録する
- 新機能は `/implement-feature`、新規 Electron IPC command は `/add-electron-command` を優先する
- バグ修正は `/debug-issue` を主フローとし、上記の横断条件を満たす場合は影響マトリクスも併用する
- Electron release CI／release workflow／tag build／署名・公証／installer migration／artifact publish
  の失敗は `/debug-release-ci` を主フローとする。一般のPR／master CI失敗は `/debug-issue` を使う
- release CI修正中はversion、release notes、tagを変更せず、失敗stage相当のfocused gateを先に通す。
  workflow再実行だけを目的にpatch versionを上げない。修正merge後のDraft Release準備だけを `/bump-version` へ渡す
- Grimodexの公開向け文書は `docs/communication-style-guide.md` を正本として `/write-grimodex-copy`
  を使用する。Issue、PR、コミット、UI／エラー／復旧手順、API／IPC／MCP／CLI／セットアップ等の
  技術文書には適用しない
- version更新を含むリリース作業は `/bump-version` を主フローとし、リリースノート作成だけを
  `/write-grimodex-copy` に委ねる。release commit後のpush／PR／mergeは `/ship-branch` へ渡す。
  tag workflow完了後もGitHub ReleaseはDraftのまま停止し、公開には別の明示指示を必要とする
- SQLite WALモード、FTS5有効
- エディタ: チャプター/シーンごとに独立TipTapインスタンス
- AIチャット: シーンごとに独立した会話履歴を保持
- 帰属追跡: テキスト挿入時にsource metadata（human/ai/unknown）を記録

## スキル発火条件

| トリガーワード                                                                                              | 発動スキル                 | 動作                                   |
| ----------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- |
| 「調べて」「調査」                                                                                          | /explore-codebase          | コード探索                             |
| 「AI指示」「システムプロンプト」「Codexスキル」「AI評価fixture」                                            | /grimodex-author           | 正本→評価証跡→差分品質ゲート           |
| 「差分評価」「品質ゲート」「impact gate」「コミット前／PR前評価」                                           | /grimodex-impact-gate      | 差分→関連Light suite選択・実行         |
| 「実装して」「作って」                                                                                      | /implement-feature         | 実装フロー                             |
| 「多次元敵対的レビュー」「敵対的レビュー」「複眼レビュー」「red-team review」                               | /adversarial-review        | 独立reviewer→反証→finding統合          |
| 「レビュー」                                                                                                | /review-code               | コードレビュー                         |
| 「tsx IPC EPERM」「listen EPERM」「sandbox外で同じテストを再実行」                                          | /rerun-sandbox-eperm       | 証拠固定→同一commandを1回だけ再実行    |
| 「テスト」                                                                                                  | /test-feature              | テスト作成・実行                       |
| 「release CI失敗」「release workflow失敗」「tag build失敗」「packaging失敗」「署名」「公証」「publish失敗」 | /debug-release-ci          | run／SHA固定→対象stageだけ検証         |
| 「デバッグ」「修正」「一般CI失敗」                                                                          | /debug-issue               | 一般デバッグフロー                     |
| 「Electronコマンド」「IPC」「invoke」                                                                       | /add-electron-command      | IPC一括追加                            |
| 「アニメ」「トランジション」「動き」「磨いて」                                                              | /polish-motion             | UIモーション規律                       |
| 「横断リファクタ」「境界整理」「責務移動」「パイプライン再編」                                              | /refactor-cross-boundaries | 影響マトリクス→段階レビュー→CI相当検証 |
| 「リリースノート」「広報文」「告知文」「README冒頭」「日英リリースノート」                                  | /write-grimodex-copy       | 正本確認→事実整理→日英整合→公開前確認  |
| 「バージョン上げて」「リリースタグ」「リリース準備」                                                        | /bump-version              | version→文面→PR→tag→Draft確認          |
| 「PR出して」「プルリク作って」「pushしてマージ」「shipして」                                                | /ship-branch               | push→PR→CI・レビュー→squash merge      |
