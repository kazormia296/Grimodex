"""Compare the product-candidate quantized path with the official FP32 ONNX."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import UTC, datetime
import json
from pathlib import Path
import sys
from typing import Any

import numpy as np

from .reranker_gate2 import (
    ParityPair,
    evaluate_logit_parity,
    load_gate2_jsonl,
    load_parity_jsonl,
)
from .reranker_phase0b import (
    OnnxRerankerRuntime,
    load_onnx_reranker,
    load_phase0b_config,
    load_reference_reranker,
)


def _fixed_pairs(
    path: Path,
    *,
    expected_pair_count: int = 12,
) -> list[tuple[ParityPair, str, str]]:
    return [
        (
            ParityPair(
                pair_id=case.pair_id,
                group_id=case.group_id,
                relevant=case.relevant,
            ),
            case.query,
            case.passage,
        )
        for case in load_parity_jsonl(
            path,
            expected_pair_count=expected_pair_count,
        )
    ]


def _encode(
    runtime: OnnxRerankerRuntime,
    queries: list[str],
    passages: list[str],
) -> dict[str, np.ndarray]:
    encoded = runtime.tokenizer(
        queries,
        passages,
        max_length=runtime.max_pair_tokens,
        padding=True,
        truncation=True,
        return_tensors="np",
        return_special_tokens_mask=True,
    )
    return {
        key: np.asarray(value, dtype=np.int64)
        for key, value in encoded.items()
        if key
        in {
            "input_ids",
            "attention_mask",
            "token_type_ids",
            "special_tokens_mask",
        }
    }


def _arrays_equal(
    reference: dict[str, np.ndarray],
    quantized: dict[str, np.ndarray],
    *,
    require_token_type_ids: bool,
) -> tuple[bool, dict[str, bool]]:
    required = ["input_ids", "attention_mask", "special_tokens_mask"]
    if require_token_type_ids:
        required.append("token_type_ids")
    field_matches: dict[str, bool] = {}
    for field in required:
        left = reference.get(field)
        right = quantized.get(field)
        field_matches[field] = (
            left is not None
            and right is not None
            and left.shape == right.shape
            and bool(np.array_equal(left, right))
        )
    return all(field_matches.values()), field_matches


def run_parity(
    *,
    config_path: Path,
    candidate_path: Path,
    pair_path: Path,
    model_key: str,
    thread_count: int,
) -> dict[str, Any]:
    config = load_phase0b_config(config_path)
    model = config.model(model_key)
    queries = [
        query
        for query in load_gate2_jsonl(candidate_path)
        if query.language == model.language
    ]
    fixed = _fixed_pairs(pair_path)
    quantized, quantized_manifest = load_onnx_reranker(
        config_path,
        config,
        model,
        thread_count=thread_count,
    )
    reference, reference_manifest = load_reference_reranker(
        config_path,
        config,
        model,
        thread_count=thread_count,
    )

    reference_scores: dict[str, float] = {}
    quantized_scores: dict[str, float] = {}
    pair_rows: list[dict[str, Any]] = []
    tokenization_matches = True
    token_type_ids_verified = "token_type_ids" not in quantized.input_names
    field_matches_by_group: dict[str, dict[str, bool]] = {}
    max_encoded_tokens = 0

    groups = sorted({pair.group_id for pair, _query, _passage in fixed})
    for group_id in groups:
        members = [
            item for item in fixed if item[0].group_id == group_id
        ]
        query_texts = [item[1] for item in members]
        passages = [item[2] for item in members]
        reference_encoded = _encode(reference, query_texts, passages)
        quantized_encoded = _encode(quantized, query_texts, passages)
        group_matches, field_matches = _arrays_equal(
            reference_encoded,
            quantized_encoded,
            require_token_type_ids="token_type_ids" in quantized.input_names,
        )
        tokenization_matches = tokenization_matches and group_matches
        field_matches_by_group[group_id] = field_matches
        if "token_type_ids" in quantized.input_names:
            token_type_ids_verified = (
                token_type_ids_verified
                or field_matches.get("token_type_ids", False)
            )
        max_encoded_tokens = max(
            max_encoded_tokens,
            int(reference_encoded["attention_mask"].sum(axis=1).max()),
            int(quantized_encoded["attention_mask"].sum(axis=1).max()),
        )

        reference_logits = reference.score_pairs(query_texts[0], passages)
        quantized_logits = quantized.score_pairs(query_texts[0], passages)
        for (
            pair,
            query,
            passage,
        ), reference_logit, quantized_logit in zip(
            members,
            reference_logits,
            quantized_logits,
            strict=True,
        ):
            reference_scores[pair.pair_id] = reference_logit
            quantized_scores[pair.pair_id] = quantized_logit
            pair_rows.append(
                {
                    "pairId": pair.pair_id,
                    "groupId": pair.group_id,
                    "query": query,
                    "passage": passage,
                    "relevant": pair.relevant,
                    "referenceLogit": reference_logit,
                    "quantizedLogit": quantized_logit,
                }
            )

    pairs = [item[0] for item in fixed]
    parity = evaluate_logit_parity(
        pairs,
        reference_scores=reference_scores,
        quantized_scores=quantized_scores,
        tokenization_matches=tokenization_matches,
        token_type_ids_verified=token_type_ids_verified,
    )
    return {
        "schemaVersion": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "modelKey": model.key,
        "modelId": model.model_id,
        "modelRevision": model.revision,
        "quantizedArtifact": model.artifact,
        "quantizedArtifactSha256": model.artifact_sha256,
        "quantizedManifestHash": quantized_manifest,
        "referenceArtifact": model.reference.artifact,
        "referenceArtifactSha256": model.reference.artifact_sha256,
        "referenceManifestHash": reference_manifest,
        "candidateFile": str(candidate_path),
        "parityPairFile": str(pair_path),
        "candidateCount": len(queries[0].candidates) if queries else 0,
        "parityPairCount": len(pairs),
        "pairTruncation": "longest_first",
        "maxPairTokens": config.benchmark.max_pair_tokens,
        "maxEncodedTokensObserved": max_encoded_tokens,
        "quantizedInputs": list(quantized.input_names),
        "referenceInputs": list(reference.input_names),
        "fieldMatchesByGroup": field_matches_by_group,
        "result": asdict(parity),
        "pairs": pair_rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--pairs", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        report = run_parity(
            config_path=arguments.config.resolve(),
            candidate_path=arguments.candidates.resolve(),
            pair_path=arguments.pairs.resolve(),
            model_key=arguments.model,
            thread_count=arguments.threads,
        )
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["result"], ensure_ascii=False, sort_keys=True))
    return 0 if report["result"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
