#!/usr/bin/env python3
"""
段階2 ライブ計測ゲート: codex 検索に dense 埋め込み(hybrid)を入れる価値を
実モデルで実測する。

問い(計測ゲート由来): codex の曖昧リコール(「どのキャラ/アイテムだっけ」)で、
FTS(trigram)が落とす説明的クエリを dense 埋め込みなら top-K に乗せられるか。
そして本文(content)を埋めると summary だけより recall が上がるか。

計測対象: 実シードの codex エントリ(name/summary/本文)を、実 ONNX/SentenceTransformer
モデルで埋め込み、各クエリを全エントリに対してランキングして Recall@1/@3/MRR を出す。
2つの doc モード(summary-only / summary+body)を同時に走らせ、本文を足した差分を見る。
control-name(名前入り・易) と descriptive-hard(名前無し・言い換え) を分けて集計する。

FTS ベースライン参考(決定的計測): descriptive-hard の和文は FTS 到達 ~0/11、
英語も discriminative ヒットは 6/22 のみ。dense がここをどれだけ救うかが判定軸。

入力:
  --lang ja|en       既定モデル/シード/fixture/prefix を選ぶ
  --seed PATH        プロジェクトシード JSON (codex_entries を含む)
  --queries PATH     クエリ fixture JSONL: {"query","target","kind"}
  --model-id ID      SentenceTransformer モデル ID
  --query-prefix / --document-prefix   ruri 等のプレフィックス
  --dry-run          モデルをロードせず、抽出したコーパス/クエリ件数と
                     target 解決のみ検証して終了(モデル不要・CI/サンドボックス用)

Usage:
  # 和文 (ruri)
  python3 scripts/eval-codex-recall.py --lang ja
  # 英語 (bge)
  python3 scripts/eval-codex-recall.py --lang en
  # 抽出/結線だけ検証(モデル不要)
  python3 scripts/eval-codex-recall.py --lang ja --dry-run

Requirements (dry-run 以外):
  pip install sentence-transformers numpy
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

LANG_DEFAULTS = {
    "ja": {
        "seed": "src-tauri/resources/sample_project/v1.json",
        "queries": "scripts/fixtures/codex-recall-ja.jsonl",
        "model_id": "cl-nagoya/ruri-v3-30m",
        "query_prefix": "検索クエリ: ",
        "document_prefix": "検索文書: ",
    },
    "en": {
        "seed": "src-tauri/resources/sample_project/v1_en.json",
        "queries": "scripts/fixtures/codex-recall-en.jsonl",
        "model_id": "BAAI/bge-small-en-v1.5",
        "query_prefix": "",
        "document_prefix": "",
    },
}


def flatten_prosemirror(node, out: list[str]) -> None:
    """ProseMirror JSON から text ノードを順に拾って平文化する。"""
    if isinstance(node, dict):
        if node.get("type") == "text" and isinstance(node.get("text"), str):
            out.append(node["text"])
        for v in node.values():
            flatten_prosemirror(v, out)
    elif isinstance(node, list):
        for v in node:
            flatten_prosemirror(v, out)


def body_text(content) -> str:
    if not content:
        return ""
    try:
        doc = json.loads(content) if isinstance(content, str) else content
    except (json.JSONDecodeError, TypeError):
        return ""
    out: list[str] = []
    flatten_prosemirror(doc, out)
    return "".join(out)


def parse_aliases(raw) -> list[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(x) for x in v] if isinstance(v, list) else []


def load_entries(seed_path: Path) -> list[dict]:
    data = json.loads(seed_path.read_text(encoding="utf-8"))
    entries = []
    for e in data.get("codex_entries", []):
        name = str(e.get("name", ""))
        summary = str(e.get("summary") or "")
        aliases = parse_aliases(e.get("aliases"))
        body = body_text(e.get("content") or "")
        entries.append(
            {
                "name": name,
                "summary": summary,
                "aliases": aliases,
                "body": body,
            }
        )
    return entries


def load_queries(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        rec = json.loads(line)
        if "query" in rec and "target" in rec:
            rec.setdefault("kind", "descriptive-hard")
            out.append(rec)
    return out


def doc_for(entry: dict, mode: str) -> str:
    """mode='summary' は name+aliases+summary、'body' はそれに本文を加える。"""
    parts = [entry["name"], " ".join(entry["aliases"]), entry["summary"]]
    if mode == "body":
        parts.append(entry["body"])
    return "。".join(p for p in parts if p)


def resolve_target(target: str, entries: list[dict]) -> int:
    names = [e["name"] for e in entries]
    if target in names:
        return names.index(target)
    # 部分一致フォールバック(別名ゆらぎ吸収)
    for i, n in enumerate(names):
        if target in n or n in target:
            return i
    return -1


def run_mode(model, entries, queries, mode, qprefix, dprefix, np):
    docs = [dprefix + doc_for(e, mode) for e in entries]
    qtexts = [qprefix + q["query"] for q in queries]
    d = model.encode(docs, normalize_embeddings=True, convert_to_numpy=True)
    q = model.encode(qtexts, normalize_embeddings=True, convert_to_numpy=True)
    sim = q @ d.T  # [num_queries, num_entries]

    rows = []
    for i, query in enumerate(queries):
        tgt = resolve_target(query["target"], entries)
        order = np.argsort(-sim[i])
        rank = int(np.where(order == tgt)[0][0]) + 1
        rows.append(
            {
                "query": query["query"],
                "target": query["target"],
                "kind": query.get("kind", "descriptive-hard"),
                "rank": rank,
                "score": float(sim[i, tgt]),
            }
        )
    return rows


def summarize(rows, np, label):
    def metrics(subset):
        if not subset:
            return (0.0, 0.0, 0.0, 0)
        ranks = np.array([r["rank"] for r in subset])
        return (
            float(np.mean(ranks <= 1)),
            float(np.mean(ranks <= 3)),
            float(np.mean(1.0 / ranks)),
            len(subset),
        )

    hard = [r for r in rows if r["kind"] == "descriptive-hard"]
    ctrl = [r for r in rows if r["kind"] == "control-name"]
    print(f"\n── {label} ─────────────────────────────")
    for name, sub in (("all", rows), ("descriptive-hard", hard), ("control-name", ctrl)):
        r1, r3, mrr, n = metrics(sub)
        print(f"  {name:16s} n={n:2d}  Recall@1={r1:.2f}  Recall@3={r3:.2f}  MRR={mrr:.3f}")
    print("  per-query (rank / score):")
    for r in sorted(rows, key=lambda x: (x["kind"], x["rank"])):
        flag = "" if r["rank"] <= 3 else "  <- MISS@3"
        print(f"    [{r['kind'][:4]}] rank={r['rank']:2d} score={r['score']:.3f}  {r['query'][:42]}{flag}")
    r1, r3, mrr, _ = metrics(hard)
    return (r1, r3, mrr)  # descriptive-hard (Recall@1, Recall@3, MRR)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lang", choices=["ja", "en"], default="ja")
    parser.add_argument("--seed", type=Path, default=None)
    parser.add_argument("--queries", type=Path, default=None)
    parser.add_argument("--model-id", default=None)
    parser.add_argument("--revision", default=None)
    parser.add_argument("--query-prefix", default=None)
    parser.add_argument("--document-prefix", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    dft = LANG_DEFAULTS[args.lang]
    seed = args.seed or Path(dft["seed"])
    queries_path = args.queries or Path(dft["queries"])
    model_id = args.model_id or dft["model_id"]
    qprefix = dft["query_prefix"] if args.query_prefix is None else args.query_prefix
    dprefix = dft["document_prefix"] if args.document_prefix is None else args.document_prefix

    for p in (seed, queries_path):
        if not p.exists():
            sys.stderr.write(f"not found: {p}\n")
            return 1

    entries = load_entries(seed)
    queries = load_queries(queries_path)
    if not entries or not queries:
        sys.stderr.write("empty corpus or query set\n")
        return 1

    # target 解決の検証(全クエリの target がコーパスに存在するか)
    unresolved = [q["target"] for q in queries if resolve_target(q["target"], entries) < 0]
    if unresolved:
        sys.stderr.write(
            "unresolved targets (not in seed codex_entries):\n  "
            + "\n  ".join(sorted(set(unresolved)))
            + "\navailable: "
            + ", ".join(e["name"] for e in entries)
            + "\n"
        )
        return 1

    print(f"lang={args.lang}  model={model_id}  seed={seed.name}  queries={queries_path.name}")
    print(f"corpus: {len(entries)} entries | queries: {len(queries)} "
          f"({sum(1 for q in queries if q.get('kind')=='control-name')} control / "
          f"{sum(1 for q in queries if q.get('kind')=='descriptive-hard')} hard)")
    for e in entries:
        print(f"  - {e['name']}  (summaryLen={len(e['summary'])} bodyLen={len(e['body'])})")

    if args.dry_run:
        print("\n[dry-run] extraction & target resolution OK. Skipping model load.")
        return 0

    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError:
        sys.stderr.write(
            "Missing dependency. Install in a venv:\n"
            "    pip install sentence-transformers numpy\n"
        )
        return 1

    sys.stderr.write(f"Loading {model_id} (revision={args.revision or 'main'})...\n")
    model = SentenceTransformer(model_id, revision=args.revision)

    summary_rows = run_mode(model, entries, queries, "summary", qprefix, dprefix, np)
    body_rows = run_mode(model, entries, queries, "body", qprefix, dprefix, np)

    s1, s3, smrr = summarize(summary_rows, np, "doc=summary-only (name+aliases+summary)")
    b1, b3, bmrr = summarize(body_rows, np, "doc=summary+body (adds content)")

    n_entries = len(entries)
    print("\n=== DECISION (descriptive-hard) ===")
    print("             Recall@1  Recall@3    MRR")
    print(f"  summary  :   {s1:.2f}      {s3:.2f}    {smrr:.3f}")
    print(f"  +body    :   {b1:.2f}      {b3:.2f}    {bmrr:.3f}")
    print(f"  body lift:  R@1 {b1 - s1:+.2f}            MRR {bmrr - smrr:+.3f}")
    if n_entries < 12:
        # Recall@3 is top-3-of-N; on a tiny corpus it saturates and is NOT the
        # discriminating signal. Read Recall@1 / MRR instead, and treat absolute
        # values as optimistic (a real codex has many more distractors).
        print(
            f"  NOTE: tiny corpus ({n_entries} entries) — Recall@3 saturates "
            f"(top-3 of {n_entries}); judge by Recall@1 / MRR."
        )
    print()
    # Decision keys on Recall@1 / MRR (robust on small corpora), not Recall@3.
    dense_ok = b1 >= 0.7 or bmrr >= 0.8
    body_helps = (b1 - s1) >= 0.05 or (bmrr - smrr) >= 0.03
    if dense_ok and body_helps:
        print("  => GO: dense recovers FTS-missed queries; embed BODY (clear Recall@1/MRR lift).")
    elif dense_ok:
        print("  => GO: dense helps; body adds little at rank-1 — summary may suffice.")
    elif s1 < 0.5 and b1 < 0.5:
        print("  => WEAK: dense struggles even at rank-1. Re-check model/corpus before stage 3.")
    else:
        print("  => MIXED: inspect per-query misses above before committing to hybrid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
