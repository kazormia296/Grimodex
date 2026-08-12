# Gate B2 Engineering Certification

Gate B2 の正式認証は Global Release Quality（Related Scenes / Semantic Reranker / Impact Gate 3.1・4）とは分離する。

## 正本

- Manifest: `evals/certifications/gate-b2.yaml`
- Report schema: `evals/certifications/schemas/gate-b2-report-v1.schema.json`
- Runner: `scripts/quality/certify-gate-b2.mjs`

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
