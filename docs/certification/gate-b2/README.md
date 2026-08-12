# Gate B2 Engineering Certification

Gate B2 の正式認証は Global Release Quality（Related Scenes / Semantic Reranker / Impact Gate 3.1・4）とは分離する。

## 正本

- Manifest: `evals/certifications/gate-b2.yaml`
- Report schema: `evals/certifications/schemas/gate-b2-report-v1.schema.json`
- Bootstrap: `scripts/quality/certify-gate-b2-bootstrap.mjs`
- Frozen candidate runner: `scripts/quality/certify-gate-b2.mjs`
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

## C2 — Production Chronicle live certification

C2 は Human Gold 14 case を production の Observation → Evidence resolve →
Clustering → Event synthesis → Existing match → Proposal planning に通す billed
OpenRouter Heavy runner を登録する。Chronicle domain Apply は実行せず、
Attempt 1 だけを正式結果とする。失敗後の再実行は同じ Candidate では行わず、
修正した新しい Candidate SHA を Freeze する。
runner が存在しても、意味品質が閾値を満たさない場合は Gate B2 PASS ではなく HOLD となる。

```bash
OPENROUTER_API_KEY=... OPENROUTER_MODEL=openai/gpt-5.6-luna \
  OPENROUTER_REASONING_EFFORT=medium \
  pnpm eval:narrative:chronicle:production:live
```

## C3 — Web AI consent live

C3 は loopback OpenAI-compatible Local LLM に対して、consent dialog・拒否時
0 HTTP・承認後送信・destination 変更時の再同意・IndexedDB／Local Storage の
teardown を、実 Chromium で証明する。モデル品質は評価しない。

```bash
pnpm eval:web-ai-consent:browser
```

`pnpm eval:web-ai-consent:live` は同じ契約を jsdom + loopback で確認する
informational 補助であり、Gate B2 Engineering の実ブラウザ証跡にはならない。

## コマンド

```bash
# Candidate digest / freeze 事前確認（PASS は出さない）
pnpm certify:gate-b2 -- --preflight --candidate <sha>

# Candidate の Full CI を workflow_dispatch で完走させ、run ID を記録
gh workflow run ci.yml --ref <candidate-ref>

# Freeze を commit/push 後、専用 workflow を対象 Candidate につき1回だけ起動
gh workflow run gate-b2-certification.yml \
  --ref <freeze-ref> \
  -f candidate_sha=<frozen-sha> \
  -f full_ci_run_id=<successful-ci-run-id>
```

## Verdict

| Verdict    | 意味                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| PASS       | 必須 Light / Heavy / Journey がすべて成功。blocked/deferred/skipped なし。Candidate Tree 不変。 |
| HOLD       | 安全性は成功だが意味品質閾値または再現性が不足。                                                |
| BLOCK      | runner 不在、credential 不足、critical safety failure、candidate drift など。                   |
| INCOMPLETE | preflight のみ、または必須 suite 未実行。                                                       |

`skipped` / `deferred` / credential 不足を PASS に含めない。

Attempt履歴の正本はGitHub Actionsの
`.github/workflows/gate-b2-certification.yml` とする。workflow run名へCandidate
SHAを固定し、同じSHAの2回目のdispatchと`Re-run jobs`（run attempt 2）を開始時に
拒否する。失敗したCandidateはPASSへ上書きせず、修正後の新しいSHAで再認証する。

DecisionにはCandidate commit/tree、freezeId、各suiteのAttempt 1とresult、
report digest、GitHub Actions run IDを記録する。独自の秘密鍵、署名、公開鍵、
耐改ざんストレージはGate B2契約に含めない。

## Stack

`#525` の後段に certification PR（#526）を積む。

## C4 — Candidate freeze and Decision artifact

```bash
# Working tree が clean なときだけ freeze できる
pnpm certify:gate-b2:freeze -- --candidate HEAD --write-results

# 正式なLight / Heavy / Journeyは上記の専用workflowからだけ実行する
```

Freeze時点のprovisional Decisionは
`evals/certifications/results/gate-b2-<sha>.json` に残す。正式report／Decision／
suite artifactは専用workflowのGitHub Actions artifactへ保存し、生ログ全体は
リポジトリへ入れない。
