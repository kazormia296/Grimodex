#!/usr/bin/env python3
"""
ruri-v3-30m (検索版) の golden embedding を生成するスクリプト。

Rust 側 ONNX 実装 (Step 4-5) の golden test 用 fixture を作る。
sentence-transformers を ground truth として、プレフィックス込み・mean pooling
(include_prompt=True)・L2 正規化済みの埋め込みを JSON で出力する。

設計: temp/semantic-prose-search-context.md §2.2 / §7 Step 3。

Usage:
    python3 scripts/generate-ruri-golden.py [--out PATH] [--revision SHA]

Requirements:
    pip install sentence-transformers

採用モデル:
    cl-nagoya/ruri-v3-30m   ← 検索ファインチューン版 (PT 版 -pt- ではない)
    256 次元、mean pooling, prefix tokens を pooling に含める設定。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MODEL_ID = "cl-nagoya/ruri-v3-30m"
DEFAULT_OUT = Path("src-tauri/tests/fixtures/ruri_v3_30m_golden.json")

QUERY_PREFIX = "検索クエリ: "
DOCUMENT_PREFIX = "検索文書: "

# spec §2.2 が「最低限含める」と指定した 4 件 + tokenizer の境界条件を
# 確認するための数件。Rust 側の Step 5 golden test はここに列挙された全件を
# 個別にエンコードして cosine を比較する。
GOLDEN_INPUTS: list[dict[str, str]] = [
    # 必須: クエリ/文書の意味マッチ
    {"kind": "query", "text": "嵐の描写"},
    {"kind": "document", "text": "雨が窓を叩いていた。"},
    {"kind": "query", "text": "主人公が後悔している場面"},
    {"kind": "document", "text": "彼は返事をしないまま、床に落ちた手紙を見つめていた。"},
    # 追加: mixed-script・短い名詞句クエリ
    {"kind": "query", "text": "夜の街の描写"},
    {"kind": "document", "text": "街灯の光が雨に滲んでいた。"},
    # 追加: 鉤括弧入り (tokenizer の特殊 token・会話文)
    {"kind": "document", "text": "「ここから出たい」と彼は言った。"},
]

# 英語モデル (granite-embedding-small-english-r2 / bge-small-en-v1.5 等) 用の
# golden 入力。prefix は無し (両候補とも prefix なし運用) を既定とし、CLS
# pooling を Rust 側 golden test で検証する。会話文 (straight/curly quote) と
# 地の文を混在させる。
EN_GOLDEN_INPUTS: list[dict[str, str]] = [
    {"kind": "query", "text": "description of a storm"},
    {"kind": "document", "text": "Rain hammered against the window."},
    {"kind": "query", "text": "a scene where the protagonist feels regret"},
    {
        "kind": "document",
        "text": "He said nothing, staring at the letter on the floor.",
    },
    {"kind": "query", "text": "a quiet night in the city"},
    {"kind": "document", "text": "Streetlight blurred in the falling rain."},
    # 会話文 (curly quotes / dialogue tag)
    {"kind": "document", "text": "“I want out of here,” he said."},
]


def resolve_revision(model_id: str, revision: str | None) -> str | None:
    """指定 revision を Hugging Face API で resolve して commit sha を返す。
    取得に失敗しても fixture 生成自体は止めない。"""
    try:
        from huggingface_hub import HfApi  # type: ignore
    except ImportError:
        return None
    try:
        info = HfApi().repo_info(model_id, revision=revision)
        return info.sha
    except Exception as exc:  # ネットワーク・auth・存在しない revision 等
        sys.stderr.write(f"[warn] could not resolve revision: {exc}\n")
        return None


def detect_pooling(model) -> str:
    """ST モデルの Pooling モジュールから pooling 種別 (mean / cls) を検出する。
    判定できなければ 'mean' を返す (ruri 既定)。"""
    try:
        for module in model._modules.values():
            if module.__class__.__name__ == "Pooling":
                if getattr(module, "pooling_mode_cls_token", False):
                    return "cls"
                if getattr(module, "pooling_mode_mean_tokens", False):
                    return "mean"
        return "mean"
    except Exception:
        return "mean"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        type=Path,
        help=f"出力先 JSON パス (default: {DEFAULT_OUT})",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_MODEL_ID,
        help=f"Hugging Face model id (default: {DEFAULT_MODEL_ID})",
    )
    parser.add_argument(
        "--revision",
        default=None,
        help="Hugging Face revision (commit/branch/tag)。省略時は main の最新。",
    )
    parser.add_argument(
        "--lang",
        choices=["ja", "en"],
        default="ja",
        help="入力サンプル集の言語 (ja=ruri 用 / en=英語モデル用)。"
        "prefix 既定もこれで切替 (ja=検索クエリ/検索文書, en=無し)。",
    )
    parser.add_argument(
        "--query-prefix",
        default=None,
        help="クエリ prefix を明示指定 (省略時は --lang から導出)。",
    )
    parser.add_argument(
        "--document-prefix",
        default=None,
        help="文書 prefix を明示指定 (省略時は --lang から導出)。",
    )
    parser.add_argument(
        "--pooling",
        choices=["auto", "mean", "cls"],
        default="auto",
        help="出力 JSON に記録する pooling 種別。auto は ST モデルから検出。",
    )
    args = parser.parse_args()

    # prefix: 明示指定 > --lang 既定 (ja=検索クエリ/検索文書, en=無し)。
    if args.lang == "ja":
        query_prefix = args.query_prefix if args.query_prefix is not None else QUERY_PREFIX
        document_prefix = (
            args.document_prefix if args.document_prefix is not None else DOCUMENT_PREFIX
        )
        inputs = GOLDEN_INPUTS
    else:
        query_prefix = args.query_prefix if args.query_prefix is not None else ""
        document_prefix = (
            args.document_prefix if args.document_prefix is not None else ""
        )
        inputs = EN_GOLDEN_INPUTS

    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError:
        sys.stderr.write(
            "Missing dependency: sentence-transformers.\n"
            "Install in a venv:\n"
            "    python3 -m venv .venv && source .venv/bin/activate\n"
            "    pip install sentence-transformers\n"
        )
        return 1

    sys.stderr.write(
        f"Loading {args.model_id} (revision={args.revision or 'main'})...\n"
    )
    model = SentenceTransformer(args.model_id, revision=args.revision)

    actual_revision = resolve_revision(args.model_id, args.revision)

    pooling = args.pooling if args.pooling != "auto" else detect_pooling(model)

    samples: list[dict] = []
    for entry in inputs:
        kind = entry["kind"]
        text = entry["text"]
        prefix = query_prefix if kind == "query" else document_prefix
        prefixed = prefix + text
        # 個別 encode (バッチ化しない) = Rust 側の単発推論と一致条件を揃える。
        # normalize_embeddings=True で L2 正規化。
        emb = model.encode(
            prefixed,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        samples.append(
            {
                "kind": kind,
                "text": text,
                "prefix": prefix,
                "prefixed": prefixed,
                "embedding": [float(x) for x in emb.tolist()],
            }
        )

    embedding_dim = len(samples[0]["embedding"]) if samples else 0
    out_doc = {
        "schema_version": 2,
        "model_id": args.model_id,
        "revision": actual_revision,
        "embedding_dim": embedding_dim,
        "query_prefix": query_prefix,
        "document_prefix": document_prefix,
        "pooling": pooling,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": (
            "Golden embeddings produced by Python sentence-transformers as ground "
            "truth for the Rust ONNX pipeline. Each entry is encoded individually "
            "with the prefix prepended; output is L2-normalized. `pooling` records "
            "the model's pooling mode (mean / cls) so the Rust side can verify it "
            "uses the matching pool. Rust ONNX inference (fp32) must match with "
            "cosine >= 0.9999; quantized ONNX uses a >= 0.99 acceptance gate."
        ),
        "samples": samples,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        json.dump(out_doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    sys.stderr.write(
        f"Wrote {args.out} ({len(samples)} samples, dim={embedding_dim}, "
        f"revision={actual_revision or 'unresolved'})\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
