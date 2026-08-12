# Gate B2 Engineering Certification

Gate B2 Contract v8 は、外部 AI プロバイダへ接続せず、外部 AI 資格情報を使わない
Engineering Certification である。Live provider execution と model quality は保証範囲外で、
必要時だけ maintainer-local の Live Model Qualification で別に評価する。

| 系統                              | 実行場所         |     外部 AI キー | マージ判定 | 保証する内容                                                       |
| --------------------------------- | ---------------- | ---------------: | ---------: | ------------------------------------------------------------------ |
| Gate B2 Engineering Certification | GitHub Actions   |             なし |       必須 | Writer、Authority、OCC、Apply、Undo、Persistence、Consent、Journey |
| Live Model Qualification          | maintainer local | ローカル環境のみ |       任意 | 指定 provider/model の実応答、tool call、parser、抽出品質          |

Gate B2 Report／Decision は `assuranceScope` を必須とし、Engineering safety を認証する一方、
live provider execution と model quality を除外し、外部 AI 資格情報を使用していないことを
機械可読に記録する。Live Qualification の未実行、`HOLD`、`FAILED`、`INCOMPLETE` は
Gate B2 Verdict や Stack merge を変更しない。

## 正本

- Manifest: `evals/certifications/gate-b2.yaml`
- Report schema: `evals/certifications/schemas/gate-b2-report-v1.schema.json`
- Decision schema: `evals/certifications/schemas/gate-b2-decision-v1.schema.json`
- Bootstrap: `scripts/quality/certify-gate-b2-bootstrap.mjs`
- Frozen candidate runner: `scripts/quality/certify-gate-b2.mjs`
- Live Qualification manifest: `evals/qualifications/live-models.yaml`
- Live Qualification runner: `scripts/quality/run-live-model-qualification.mjs`
- ADR checklist: `policies/narrative/gate-b2-adr-checklist.json`
- Validator classification: `policies/narrative/gate-b2-classification.json`

## C1 — ADR static certification

C1 は ADR 004 の全 checklist 項目を `PASS` / `FAIL` / `OUT-OF-SCOPE`
として機械可読化し、6 domain の Invariant / Strategy / Signal 分類と
cross-cutting negative contract tests を Light suite の先頭で検証する。
`FAIL` と `OUT-OF-SCOPE` は Gate B2 PASS へ昇格せず、未実装・移送先を可視化する。

```bash
pnpm test:narrative:gate-b2-adr
```

## C2 — Live model evaluation boundary

Production Chronicle を含む5本の billed OpenRouter suite は Formal Gate B2 の必須契約ではない。
Quality Manifest の Heavy command は維持し、Live Model Qualification の既定 profile から参照する。
モデル更新、Prompt／Parser変更、主要AI抽出を含むリリース前、provider回帰の調査時にだけ実行する。
毎PR、毎push、定期scheduleでは実行しない。

```bash
export OPENROUTER_API_KEY
pnpm qualify:ai-live -- \
  --candidate HEAD \
  --model openai/gpt-5.6-luna \
  --reasoning-effort medium

# 特定経路だけを評価
pnpm qualify:ai-live -- \
  --candidate HEAD \
  --model openai/gpt-5.6-luna \
  --reasoning-effort medium \
  --suite heavy-narrative-chronicle-production
```

Live runner は `GITHUB_ACTIONS=true` を拒否し、既定では dirty tree も拒否する。
資格情報がなければ子プロセスを開始せず `INCOMPLETE` にする。結果語彙は次のとおりで、
Gate B2 の `PASS` / `BLOCK` とは共有しない。

| Result       | 意味                                                   |
| ------------ | ------------------------------------------------------ |
| `QUALIFIED`  | 選択した全 suite が成功した                            |
| `HOLD`       | 実行は成立したが意味品質閾値を満たさない               |
| `FAILED`     | transport、schema、parser、binding、harness が失敗した |
| `INCOMPLETE` | API key、入力、または実行が不足している                |

各実行は次のローカル専用領域へ新しい run directory を作り、既存結果を上書きしない。

```text
.artifacts/live-model-qualification/<candidate-sha>/<run-id>/
  report.json
  suites/<suite-id>/
    stdout.log
    stderr.log
    report.json
```

保存するのは Candidate、provider/model/reasoning、suite、時刻、exit code、各digest、
Qualification result だけである。API key、Authorization header、生環境一覧、
credential付きURL、HTTP dumpは保存しない。

## C3 — Credential-free Web AI consent live

C3 は loopback OpenAI-compatible Local LLM に対して、consent dialog・拒否時
0 HTTP・承認後送信・destination 変更時の再同意・IndexedDB／Local Storage の
teardown を実 Chromium で証明する。外部モデルも外部資格情報も使わず、モデル品質は評価しない。
Contract v8 の `requiredHeavy` はこの1本だけである。

```bash
pnpm eval:web-ai-consent:browser
```

`pnpm eval:web-ai-consent:live` は同じ契約を jsdom + loopback で確認する
informational 補助であり、Gate B2 Engineering の実ブラウザ証跡にはならない。

## Formal Gate B2 コマンド

```bash
# Candidate digest / freeze 事前確認（PASS は出さない）
pnpm certify:gate-b2 -- --preflight --candidate <sha>

# Candidate の Full CI を workflow_dispatch で完走させ、run ID を記録
gh workflow run ci.yml --ref <candidate-ref>

# Freeze envelope を commit/push 後、専用 workflow を対象 Candidate につき1回だけ起動
gh workflow run gate-b2-certification.yml \
  --ref master \
  -f candidate_sha=<frozen-sha> \
  -f freeze_sha=<freeze-envelope-sha> \
  -f full_ci_run_id=<successful-ci-run-id>
```

`freeze_sha` は `candidate_sha` の直子でなければならず、差分は active freeze、
Candidate用provisional result、直前freezeのsuperseded archiveの3ファイルだけに限定する。
workflowはrepository scriptを実行する前にこのenvelopeを検証し、その後Bootstrapが
`candidate_sha` のdetached worktreeで正式suiteを実行する。これによりCandidate自身へ
後続freezeを自己参照させず、実行コードとfreeze metadataの両方をimmutableに束縛する。

専用workflowは `--run-light --run-heavy --run-journeys` を維持する。Contract v8 の
`--run-heavy` は credential-free Chromium consent suite だけを意味する。
Formal required Light／Heavy／Journey entry に `requiresEnv` を追加するとcontract testが失敗する。
`decisionPolicy.credentialShortageIsPass` は `false` のままであり、資格情報不足を
skipやPASSへ読み替えたのではなく、外部モデルsuiteを必須契約から分離した。

Full CIでfailed-only rerunを使った場合、GitHubは成功済みjobを新しいrun attemptへ
持ち越す一方、そのjobが生成したcheckout identity artifactは生成元attempt名のまま保持する。
Gateは現在のFull CI attempt以下で最新のidentity artifactを選び、Candidate commit/treeと
artifact digestを再検証する。未来attempt、期限切れ、同一attemptの重複artifactは受理しない。

## Verdict

| Verdict      | 意味                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| `PASS`       | 必須のcredential-free Light / Heavy / Journeyがすべて成功し、Candidate Treeが不変 |
| `HOLD`       | 必須Engineering evidenceの再現性または判定条件が不足                              |
| `BLOCK`      | runner不在、critical safety failure、candidate driftなど                          |
| `INCOMPLETE` | preflightのみ、または必須suite未実行                                              |

`skipped` / `deferred` / credential不足をPASSに含めない。Gate B2 `PASS` は実providerや
model qualityを保証しない。

Attempt履歴の正本はGitHub Actionsの
`.github/workflows/gate-b2-certification.yml` とする。workflow run名へCandidate
SHAを固定し、同じSHAの2回目のdispatchと`Re-run jobs`（run attempt 2）を開始時に
拒否する。失敗したCandidateはPASSへ上書きせず、修正後の新しいSHAで再認証する。

DecisionにはCandidate commit/tree、freezeId、各suiteのAttempt 1とresult、
report digest、GitHub Actions run ID、`assuranceScope`を記録する。独自の秘密鍵、署名、
公開鍵、耐改ざんストレージはGate B2契約に含めない。

## StackとFreeze

`#525` の後段に certification PR（#526）を積む。Contract、harness semantics、workflow、
schemaを変更した既存Freezeは再利用しない。

```bash
# Working tree が clean なときだけ freeze できる
pnpm certify:gate-b2:freeze -- --candidate HEAD --write-results

# 正式なLight / Heavy / Journeyは上記の専用workflowからだけ実行する
```

Gate B2 Freeze はEngineering production code、writer registry、runtime policy、migration、
browser mock、Gate/Journey/Chromium consent runner、Report／Decision schemaを対象とする。
Prompt、Parser、Human Gold、Chronicle adapter/scorer、live test、model/provider/reasoning設定は
Live Qualification側のCandidate commit/treeと設定記録へ束縛する。

Freeze時点のprovisional Decisionは
`evals/certifications/results/gate-b2-<sha>.json` に残す。正式report／Decision／
suite artifactは専用workflowのGitHub Actions artifactへ保存し、生ログ全体は
リポジトリへ入れない。
