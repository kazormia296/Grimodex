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

    rel_p10, rel_p25, rel_p50 = pct(related, 10), pct(related, 25), pct(related, 50)
    unr_p50, unr_p95, unr_p99 = (
        pct(unrelated, 50),
        pct(unrelated, 95),
        pct(unrelated, 99),
    )
    recommended = max(unr_p99 + 0.05, 0.0)
    margin = rel_p25 - unr_p99

    print(f"model: {args.model_id}")
    print(f"pairs: {n} related, {len(unrelated)} unrelated (cross-paired)")
    print("related   cosine  p10={:.3f}  p25={:.3f}  p50={:.3f}".format(
        rel_p10, rel_p25, rel_p50
    ))
    print("unrelated cosine  p50={:.3f}  p95={:.3f}  p99={:.3f}".format(
        unr_p50, unr_p95, unr_p99
    ))
    print(f"separation margin (rel_p25 - unr_p99): {margin:+.3f}")
    print(f"RECOMMENDED SEMANTIC_RECALL_MIN_SCORE: {recommended:.2f}")
    if margin <= 0:
        print(
            "  WARNING: negative/zero margin — related and unrelated overlap; "
            "this model may be a poor fit for the corpus or the corpus is noisy."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
