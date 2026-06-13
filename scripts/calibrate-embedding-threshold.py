#!/usr/bin/env python3
"""
埋め込みモデルの RAG スコア閾値 (SEMANTIC_RECALL_MIN_SCORE) を実測で決めるための
キャリブレーションスクリプト。

背景: 現行 SEMANTIC_RECALL_MIN_SCORE = 0.5 は ruri-v3 の正規化内積分布を前提とした
経験値。英語モデル (granite-embedding-small-english-r2 / bge-small-en-v1.5 等) は
スコア分布が異なる (bge/e5 系は無関係ペアでも 0.6〜0.8 に座る) ため、モデルごとに
再設定が必要。このスクリプトは「関連ペア」と「無関係ペア」の cosine 分布を測り、
推奨閾値と分離マージンを出す。

入力 (--inputs): JSONL。各行 {"query": "...", "doc": "..."} の**意味的に関連する**
ペア。無関係分布は query_i × doc_j (i≠j) の総当たりで生成する (各 query は自分の
doc にのみ関連する前提)。

Usage:
    python3 scripts/calibrate-embedding-threshold.py \\
        --model-id ibm-granite/granite-embedding-small-english-r2 \\
        --inputs scripts/fixtures/en-calibration.jsonl
    # ruri のベースライン分布 (現行 0.5 の位置確認):
    python3 scripts/calibrate-embedding-threshold.py \\
        --model-id cl-nagoya/ruri-v3-30m \\
        --query-prefix "検索クエリ: " --document-prefix "検索文書: " \\
        --inputs scripts/fixtures/ja-calibration.jsonl

Requirements:
    pip install sentence-transformers numpy
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_pairs(path: Path) -> list[dict]:
    pairs: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if "query" in rec and "doc" in rec:
                pairs.append(rec)
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--revision", default=None)
    parser.add_argument(
        "--inputs",
        type=Path,
        default=Path("scripts/fixtures/en-calibration.jsonl"),
    )
    parser.add_argument("--query-prefix", default="")
    parser.add_argument("--document-prefix", default="")
    args = parser.parse_args()

    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError:
        sys.stderr.write(
            "Missing dependency. Install in a venv:\n"
            "    pip install sentence-transformers numpy\n"
        )
        return 1

    if not args.inputs.exists():
        sys.stderr.write(f"inputs not found: {args.inputs}\n")
        return 1

    pairs = load_pairs(args.inputs)
    if len(pairs) < 4:
        sys.stderr.write(
            f"need at least 4 related pairs, got {len(pairs)} in {args.inputs}\n"
        )
        return 1

    sys.stderr.write(
        f"Loading {args.model_id} (revision={args.revision or 'main'})...\n"
    )
    model = SentenceTransformer(args.model_id, revision=args.revision)

    queries = [args.query_prefix + p["query"] for p in pairs]
    docs = [args.document_prefix + p["doc"] for p in pairs]
    q = model.encode(queries, normalize_embeddings=True, convert_to_numpy=True)
    d = model.encode(docs, normalize_embeddings=True, convert_to_numpy=True)

    # cosine = normalized dot product. sim[i][j] = q_i · d_j.
    sim = q @ d.T
    n = len(pairs)
    related = np.array([sim[i, i] for i in range(n)])
    unrelated = np.array([sim[i, j] for i in range(n) for j in range(n) if i != j])

    def pct(a, p):
        return float(np.percentile(a, p))

    # ── Retrieval quality (the metric that actually matters for RAG) ──────
    # For each query, rank ALL docs by cosine. The "true" doc is index i.
    # Recall@k = fraction of queries whose true doc is within the top-k.
    # MRR = mean reciprocal rank of the true doc. These are threshold-free and
    # robust to the high absolute baseline of homogeneous prose.
    ranks = []
    for i in range(n):
        order = np.argsort(-sim[i])  # doc indices, best first
        rank = int(np.where(order == i)[0][0]) + 1  # 1-based rank of true doc
        ranks.append(rank)
    ranks = np.array(ranks)
    recall_at_1 = float(np.mean(ranks <= 1))
    recall_at_3 = float(np.mean(ranks <= 3))
    mrr = float(np.mean(1.0 / ranks))

    # ── Threshold sweep: related-recall vs unrelated false-positive-rate ──
    # Pick the operating point maximising (recall - fp_rate) = Youden's J.
    lo = float(min(related.min(), unrelated.min()))
    hi = float(max(related.max(), unrelated.max()))
    best_t, best_j, best_recall, best_fp = 0.0, -1.0, 0.0, 1.0
    sweep_rows = []
    t = lo
    while t <= hi + 1e-9:
        recall = float(np.mean(related >= t))
        fp = float(np.mean(unrelated >= t))
        j = recall - fp
        sweep_rows.append((t, recall, fp))
        if j > best_j:
            best_j, best_t, best_recall, best_fp = j, t, recall, fp
        t += 0.02

    print(f"model: {args.model_id}")
    print(f"pairs: {n} related, {len(unrelated)} unrelated (cross-paired)")
    print(
        "related   cosine  p10={:.3f}  p25={:.3f}  p50={:.3f}".format(
            pct(related, 10), pct(related, 25), pct(related, 50)
        )
    )
    print(
        "unrelated cosine  p50={:.3f}  p95={:.3f}  p99={:.3f}".format(
            pct(unrelated, 50), pct(unrelated, 95), pct(unrelated, 99)
        )
    )
    print()
    print("RETRIEVAL (rank of the true doc among all docs per query):")
    print(
        f"  Recall@1={recall_at_1:.2f}  Recall@3={recall_at_3:.2f}  MRR={mrr:.3f}"
        f"  (worst rank={int(ranks.max())}/{n})"
    )
    print()
    print("THRESHOLD SWEEP (related recall vs unrelated false-positive rate):")
    for tv, rc, fp in sweep_rows:
        mark = "  <- best (recall-fp)" if abs(tv - best_t) < 1e-9 else ""
        print(f"  t={tv:.2f}  recall={rc:.2f}  fp={fp:.3f}{mark}")
    print()
    print(
        f"RECOMMENDED SEMANTIC_RECALL_MIN_SCORE: {best_t:.2f} "
        f"(recall={best_recall:.2f}, fp={best_fp:.3f})"
    )
    if recall_at_3 < 0.7:
        print(
            "  WARNING: Recall@3 < 0.70 — this model struggles to rank the right "
            "passage on this corpus. Consider the other model, or treat the "
            "corpus as too homogeneous/small to be conclusive."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
