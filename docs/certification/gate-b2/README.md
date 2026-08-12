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
Attempt 1 だけを normative とし、Attempt 2 は diagnostic-only として記録する。
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

# Light / Heavy / Journey
pnpm certify:gate-b2 -- \
  --run-light \
  --run-heavy \
  --run-journeys \
  --candidate <sha> \
  --ci-evidence .artifacts/gate-b2/<sha>/light/full-ci.json \
  --report .artifacts/gate-b2/<sha>/report.json
```

## Verdict

| Verdict | 意味 |
| --- | --- |
| PASS | 必須 Light / Heavy / Journey がすべて成功。blocked/deferred/skipped なし。Candidate Tree 不変。 |
| HOLD | 安全性は成功だが意味品質閾値または再現性が不足。 |
| BLOCK | runner 不在、credential 不足、critical safety failure、candidate drift など。 |
| INCOMPLETE | preflight のみ、または必須 suite 未実行。 |

`skipped` / `deferred` / credential 不足を PASS に含めない。

## Stack

`#518`（`codex/fix-gate-b2-review`）の後段に certification PR を積む。

## C4 — Candidate freeze and Decision artifact

```bash
# Working tree が clean なときだけ freeze できる
pnpm certify:gate-b2:freeze -- --candidate HEAD --write-results

# Freeze 後に Light / Heavy / Journey を同一 tree へ実行し decision を更新
pnpm certify:gate-b2 -- \
  --run-light --run-heavy --run-journeys \
  --candidate <frozen-sha> \
  --report .artifacts/gate-b2/<frozen-sha>/report.json
```

Digest と Decision のみを `evals/certifications/results/gate-b2-<sha>.json` に残す。
生ログ全体はリポジトリへ入れない。
