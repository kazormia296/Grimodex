"""Train and evaluate the four fixed Impact Review Gate 4 probe candidates."""

from __future__ import annotations

import argparse
from contextlib import nullcontext
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import inspect
import json
from pathlib import Path
import subprocess
import time
from typing import Any, Iterable, Literal, Sequence

from .config import configure_hugging_face_environment
from .impact_gate3 import (
    canonical_impact_query,
    resolve_impact_model_paths,
    sha256_file,
)
from .impact_gate4 import (
    ImpactGate4Config,
    ImpactProbeAssessment,
    assess_probe_signal,
    build_locked_test_consumption_identity,
    build_impact_probe_split_manifest,
    claim_locked_test_consumption,
    impact_probe_assessment_report,
    load_impact_gate4_config,
    load_impact_gate4_records,
    locked_test_consumption_path,
    write_locked_test_report,
)
from .metrics import BinaryMetrics, binary_classification_metrics
from .provenance import load_manifest, verify_file_manifest
from .schemas import ImpactRecord
from .thresholds import PredictionRecord, select_impact_thresholds


TrainingMode = Literal["frozen_head", "full_finetune"]


@dataclass(frozen=True)
class CandidateSelection:
    model_key: str
    mode: TrainingMode
    best_epoch: int
    epochs_completed: int
    training_seconds: float
    validation_metrics: BinaryMetrics
    validation_direct_recall: float
    low_threshold: float
    high_threshold: float
    qualifies_on_validation: bool
    checkpoint_path: str
    manifest_sha256: str
    loading_info: dict[str, list[str]]


@dataclass(frozen=True)
class ChallengeSelection:
    model_key: str
    mode: TrainingMode
    metrics: BinaryMetrics
    direct_recall: float
    qualifies: bool


def _json_ready(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "__dataclass_fields__"):
        return {
            key: _json_ready(item)
            for key, item in asdict(value).items()
        }
    if isinstance(value, dict):
        return {
            str(key): _json_ready(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_json_ready(item) for item in value]
    return value


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            _json_ready(payload),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _progress(event: str, **details: Any) -> None:
    print(
        json.dumps(
            {"event": event, **_json_ready(details)},
            ensure_ascii=False,
            sort_keys=True,
        ),
        flush=True,
    )


def _set_reproducible_runtime(seed: int, thread_count: int) -> None:
    import torch

    torch.manual_seed(seed)
    torch.set_num_threads(thread_count)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.use_deterministic_algorithms(True, warn_only=True)


def _load_verified_backbone(
    config_path: Path,
    config: ImpactGate4Config,
    model_key: str,
) -> tuple[Any, Any, str, dict[str, list[str]]]:
    from transformers import AutoModel, AutoTokenizer

    model = config.model(model_key)
    snapshot, manifest_path, weight = resolve_impact_model_paths(
        config_path,
        model,
    )
    manifest, expected_manifest_hash = load_manifest(manifest_path)
    manifest_hash = verify_file_manifest(snapshot, manifest)
    if manifest_hash != expected_manifest_hash:
        raise ValueError("Gate 4 model manifest changed during verification")
    if sha256_file(weight) != model.weight_sha256:
        raise ValueError(f"Gate 4 weight SHA-256 mismatch for {model.key}")
    tokenizer = AutoTokenizer.from_pretrained(
        str(snapshot),
        local_files_only=True,
        trust_remote_code=False,
    )
    backbone, raw_loading_info = AutoModel.from_pretrained(
        str(snapshot),
        local_files_only=True,
        trust_remote_code=False,
        output_loading_info=True,
    )
    errors = [str(item) for item in raw_loading_info.get("error_msgs", ())]
    mismatched = [
        str(item) for item in raw_loading_info.get("mismatched_keys", ())
    ]
    if errors or mismatched:
        raise ValueError(
            f"Gate 4 backbone did not load exactly: errors={errors}, "
            f"mismatched={mismatched}"
        )
    loading_info = {
        "missingKeys": [
            str(item) for item in raw_loading_info.get("missing_keys", ())
        ],
        "unexpectedKeys": [
            str(item) for item in raw_loading_info.get("unexpected_keys", ())
        ],
        "mismatchedKeys": mismatched,
        "errors": errors,
    }
    return tokenizer, backbone.float(), manifest_hash, loading_info


def _accepted_model_inputs(backbone: Any) -> set[str]:
    parameters = inspect.signature(backbone.forward).parameters
    if any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    ):
        return {"input_ids", "attention_mask", "token_type_ids"}
    return set(parameters) & {"input_ids", "attention_mask", "token_type_ids"}


def _encode_records(
    tokenizer: Any,
    records: Sequence[ImpactRecord],
    *,
    max_pair_tokens: int,
) -> dict[str, Any]:
    import torch

    queries = [
        canonical_impact_query(record.diff_payload)
        for record in records
    ]
    scenes = [f"[SCENE]\n{record.scene_text}" for record in records]
    encoded = tokenizer(
        queries,
        scenes,
        max_length=max_pair_tokens,
        padding=True,
        truncation="only_second",
        return_tensors="pt",
    )
    tensors = {
        key: value.to(dtype=torch.long)
        for key, value in encoded.items()
        if key in {"input_ids", "attention_mask", "token_type_ids"}
    }
    if "input_ids" not in tensors or "attention_mask" not in tensors:
        raise ValueError("Gate 4 tokenizer omitted required model inputs")
    if tensors["input_ids"].shape[0] != len(records):
        raise ValueError("Gate 4 tokenizer lost a corpus record")
    if tensors["input_ids"].shape[1] > max_pair_tokens:
        raise ValueError("Gate 4 tokenizer exceeded its 512-token pair cap")
    return tensors


def _split_indexes(records: Sequence[ImpactRecord]) -> dict[str, list[int]]:
    manifest = build_impact_probe_split_manifest()
    split_by_story = {
        story_id: split
        for split in ("train", "validation", "test", "challenge")
        for story_id in getattr(manifest, split)
    }
    indexes: dict[str, list[int]] = {
        split: [] for split in ("train", "validation", "test", "challenge")
    }
    for index, record in enumerate(records):
        indexes[split_by_story[record.story_id]].append(index)
    return indexes


def _batch_indexes(
    indexes: Sequence[int],
    *,
    batch_size: int,
    shuffle: bool,
    seed: int,
    epoch: int,
) -> Iterable[list[int]]:
    import torch

    ordered = torch.tensor(indexes, dtype=torch.long)
    if shuffle:
        generator = torch.Generator().manual_seed(seed + epoch)
        order = torch.randperm(len(ordered), generator=generator)
        ordered = ordered[order]
    for start in range(0, len(ordered), batch_size):
        yield ordered[start : start + batch_size].tolist()


def _select_batch(encoded: dict[str, Any], indexes: Sequence[int]) -> dict[str, Any]:
    import torch

    selected = torch.tensor(indexes, dtype=torch.long)
    return {
        key: value.index_select(0, selected)
        for key, value in encoded.items()
    }


def _masked_mean(hidden: Any, attention_mask: Any) -> Any:
    import torch

    weights = attention_mask.to(dtype=hidden.dtype).unsqueeze(-1)
    counts = weights.sum(dim=1)
    if torch.any(counts == 0):
        raise ValueError("Gate 4 cannot pool an all-padding sequence")
    return (hidden * weights).sum(dim=1) / counts


def _backbone_embeddings(
    backbone: Any,
    encoded: dict[str, Any],
    *,
    batch_size: int,
) -> Any:
    import torch

    accepted = _accepted_model_inputs(backbone)
    backbone.eval()
    embeddings: list[Any] = []
    with torch.inference_mode():
        for indexes in _batch_indexes(
            list(range(encoded["input_ids"].shape[0])),
            batch_size=batch_size,
            shuffle=False,
            seed=0,
            epoch=0,
        ):
            inputs = {
                key: value
                for key, value in _select_batch(encoded, indexes).items()
                if key in accepted
            }
            output = backbone(return_dict=True, **inputs)
            hidden = getattr(output, "last_hidden_state", None)
            if hidden is None:
                raise ValueError("Gate 4 backbone omitted last_hidden_state")
            embeddings.append(
                _masked_mean(hidden, inputs["attention_mask"]).cpu()
            )
    return torch.cat(embeddings, dim=0)


def _build_classifier(backbone: Any, seed: int) -> Any:
    import torch
    from torch import nn

    hidden_size = getattr(backbone.config, "hidden_size", None)
    if not isinstance(hidden_size, int) or hidden_size <= 0:
        raise ValueError("Gate 4 backbone does not expose a valid hidden_size")
    accepted = _accepted_model_inputs(backbone)

    class ImpactClassifier(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.backbone = backbone
            with torch.random.fork_rng(devices=[]):
                torch.manual_seed(seed)
                self.classifier = nn.Linear(hidden_size, 1)

        def forward(self, inputs: dict[str, Any]) -> Any:
            selected = {
                key: value for key, value in inputs.items() if key in accepted
            }
            output = self.backbone(return_dict=True, **selected)
            hidden = getattr(output, "last_hidden_state", None)
            if hidden is None:
                raise ValueError("Gate 4 backbone omitted last_hidden_state")
            pooled = _masked_mean(hidden, selected["attention_mask"])
            return self.classifier(pooled).float().squeeze(-1)

    return ImpactClassifier().float()


def _clone_state_dict(module: Any) -> dict[str, Any]:
    return {
        key: value.detach().cpu().clone()
        for key, value in module.state_dict().items()
    }


def _probabilities_from_logits(logits: Any) -> list[float]:
    import torch

    return [
        float(value)
        for value in torch.sigmoid(logits).detach().cpu().tolist()
    ]


def _head_probabilities(head: Any, embeddings: Any, indexes: Sequence[int]) -> list[float]:
    import torch

    selected = embeddings.index_select(
        0,
        torch.tensor(indexes, dtype=torch.long),
    )
    head.eval()
    with torch.inference_mode():
        logits = head(selected).squeeze(-1)
    return _probabilities_from_logits(logits)


def _classifier_probabilities(
    classifier: Any,
    encoded: dict[str, Any],
    indexes: Sequence[int],
    *,
    batch_size: int,
) -> list[float]:
    import torch

    classifier.eval()
    probabilities: list[float] = []
    with torch.inference_mode():
        for batch in _batch_indexes(
            indexes,
            batch_size=batch_size,
            shuffle=False,
            seed=0,
            epoch=0,
        ):
            probabilities.extend(
                _probabilities_from_logits(
                    classifier(_select_batch(encoded, batch))
                )
            )
    return probabilities


def _labels(records: Sequence[ImpactRecord], indexes: Sequence[int]) -> list[int]:
    return [records[index].label for index in indexes]


def _direct_recall(
    records: Sequence[ImpactRecord],
    indexes: Sequence[int],
    probabilities: Sequence[float],
    threshold: float,
) -> float:
    direct_probabilities = [
        probability
        for index, probability in zip(indexes, probabilities, strict=True)
        if records[index].label == 1
        and "direct-contradiction" in records[index].difficulty
    ]
    if not direct_probabilities:
        return 1.0
    return sum(
        probability >= threshold for probability in direct_probabilities
    ) / len(direct_probabilities)


def _threshold_records(
    records: Sequence[ImpactRecord],
    indexes: Sequence[int],
    probabilities: Sequence[float],
) -> list[PredictionRecord]:
    return [
        PredictionRecord(
            probability=probability,
            label=records[index].label,
            split="validation",
            direct_contradiction=(
                "direct-contradiction" in records[index].difficulty
            ),
        )
        for index, probability in zip(indexes, probabilities, strict=True)
    ]


def _fit_frozen_head(
    backbone: Any,
    encoded: dict[str, Any],
    records: Sequence[ImpactRecord],
    split_indexes: dict[str, list[int]],
    config: ImpactGate4Config,
) -> tuple[Any, Any, int, int, float]:
    import torch
    from torch import nn

    embeddings = _backbone_embeddings(
        backbone,
        encoded,
        batch_size=config.training.batch_size,
    )
    hidden_size = embeddings.shape[1]
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(config.training.seed)
        head = nn.Linear(hidden_size, 1).float()
    optimizer = torch.optim.AdamW(
        head.parameters(),
        lr=config.training.frozen_learning_rate,
        weight_decay=config.training.weight_decay,
    )
    loss_function = nn.BCEWithLogitsLoss()
    best_state = _clone_state_dict(head)
    best_ap = -1.0
    best_epoch = 0
    stale_epochs = 0
    started = time.perf_counter()
    epochs_completed = 0
    for epoch in range(1, config.training.frozen_epoch_cap + 1):
        head.train()
        for indexes in _batch_indexes(
            split_indexes["train"],
            batch_size=config.training.batch_size,
            shuffle=True,
            seed=config.training.seed,
            epoch=epoch,
        ):
            selected = torch.tensor(indexes, dtype=torch.long)
            batch_embeddings = embeddings.index_select(0, selected)
            batch_labels = torch.tensor(
                _labels(records, indexes),
                dtype=torch.float32,
            )
            optimizer.zero_grad(set_to_none=True)
            logits = head(batch_embeddings).squeeze(-1)
            loss = loss_function(logits, batch_labels)
            if not torch.isfinite(loss):
                raise RuntimeError("Gate 4 frozen-head loss became non-finite")
            loss.backward()
            optimizer.step()
        epochs_completed = epoch
        validation_probabilities = _head_probabilities(
            head,
            embeddings,
            split_indexes["validation"],
        )
        metrics = binary_classification_metrics(
            _labels(records, split_indexes["validation"]),
            validation_probabilities,
        )
        if metrics.average_precision > best_ap + 1e-12:
            best_ap = metrics.average_precision
            best_epoch = epoch
            best_state = _clone_state_dict(head)
            stale_epochs = 0
        else:
            stale_epochs += 1
        if stale_epochs >= config.training.early_stop_patience:
            break
    training_seconds = time.perf_counter() - started
    head.load_state_dict(best_state)
    return head, embeddings, best_epoch, epochs_completed, training_seconds


def _fit_full_classifier(
    backbone: Any,
    encoded: dict[str, Any],
    records: Sequence[ImpactRecord],
    split_indexes: dict[str, list[int]],
    config: ImpactGate4Config,
) -> tuple[Any, int, int, float]:
    import torch
    from torch import nn

    classifier = _build_classifier(backbone, config.training.seed)
    optimizer = torch.optim.AdamW(
        classifier.parameters(),
        lr=config.training.full_learning_rate,
        weight_decay=config.training.weight_decay,
    )
    loss_function = nn.BCEWithLogitsLoss()
    best_state = _clone_state_dict(classifier)
    best_ap = -1.0
    best_epoch = 0
    stale_epochs = 0
    started = time.perf_counter()
    epochs_completed = 0
    for epoch in range(1, config.training.full_epoch_cap + 1):
        classifier.train()
        for indexes in _batch_indexes(
            split_indexes["train"],
            batch_size=config.training.batch_size,
            shuffle=True,
            seed=config.training.seed,
            epoch=epoch,
        ):
            batch_labels = torch.tensor(
                _labels(records, indexes),
                dtype=torch.float32,
            )
            optimizer.zero_grad(set_to_none=True)
            logits = classifier(_select_batch(encoded, indexes))
            loss = loss_function(logits, batch_labels)
            if not torch.isfinite(loss):
                raise RuntimeError("Gate 4 full-finetune loss became non-finite")
            loss.backward()
            optimizer.step()
        epochs_completed = epoch
        validation_probabilities = _classifier_probabilities(
            classifier,
            encoded,
            split_indexes["validation"],
            batch_size=config.training.batch_size,
        )
        metrics = binary_classification_metrics(
            _labels(records, split_indexes["validation"]),
            validation_probabilities,
        )
        if metrics.average_precision > best_ap + 1e-12:
            best_ap = metrics.average_precision
            best_epoch = epoch
            best_state = _clone_state_dict(classifier)
            stale_epochs = 0
        else:
            stale_epochs += 1
        if stale_epochs >= config.training.early_stop_patience:
            break
    training_seconds = time.perf_counter() - started
    classifier.load_state_dict(best_state)
    return classifier, best_epoch, epochs_completed, training_seconds


def _candidate_directory(
    output_root: Path,
    model_key: str,
    mode: TrainingMode,
) -> Path:
    return output_root / "candidates" / f"{model_key}-{mode}"


def train_candidate(
    *,
    config_path: Path,
    config: ImpactGate4Config,
    records: Sequence[ImpactRecord],
    model_key: str,
    mode: TrainingMode,
    output_root: Path,
) -> CandidateSelection:
    import torch

    thread_count = config.training.model_threads[model_key]
    _set_reproducible_runtime(config.training.seed, thread_count)
    tokenizer, backbone, manifest_hash, loading_info = _load_verified_backbone(
        config_path,
        config,
        model_key,
    )
    encoded = _encode_records(
        tokenizer,
        records,
        max_pair_tokens=config.training.max_pair_tokens,
    )
    split_indexes = _split_indexes(records)
    candidate_directory = _candidate_directory(output_root, model_key, mode)
    checkpoint_path = candidate_directory / "checkpoint.pt"

    if mode == "frozen_head":
        head, embeddings, best_epoch, epochs_completed, training_seconds = (
            _fit_frozen_head(
                backbone,
                encoded,
                records,
                split_indexes,
                config,
            )
        )
        validation_probabilities = _head_probabilities(
            head,
            embeddings,
            split_indexes["validation"],
        )
        checkpoint_payload = {
            "schemaVersion": 1,
            "modelKey": model_key,
            "mode": mode,
            "headState": _clone_state_dict(head),
        }
    else:
        classifier, best_epoch, epochs_completed, training_seconds = (
            _fit_full_classifier(
                backbone,
                encoded,
                records,
                split_indexes,
                config,
            )
        )
        validation_probabilities = _classifier_probabilities(
            classifier,
            encoded,
            split_indexes["validation"],
            batch_size=config.training.batch_size,
        )
        checkpoint_payload = {
            "schemaVersion": 1,
            "modelKey": model_key,
            "mode": mode,
            "classifierState": _clone_state_dict(classifier),
        }

    threshold_selection = select_impact_thresholds(
        _threshold_records(
            records,
            split_indexes["validation"],
            validation_probabilities,
        ),
        minimum_recall=config.thresholds.minimum_recall,
        minimum_direct_recall=config.thresholds.minimum_direct_recall,
    )
    validation_metrics = binary_classification_metrics(
        _labels(records, split_indexes["validation"]),
        validation_probabilities,
        threshold=threshold_selection.low_threshold,
    )
    direct_recall = _direct_recall(
        records,
        split_indexes["validation"],
        validation_probabilities,
        threshold_selection.low_threshold,
    )
    qualifies = (
        validation_metrics.positive_recall
        >= config.thresholds.minimum_recall
        and direct_recall >= config.thresholds.minimum_direct_recall
        and validation_metrics.candidate_reduction
        >= config.thresholds.minimum_candidate_reduction
    )

    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint_payload, checkpoint_path)
    selection = CandidateSelection(
        model_key=model_key,
        mode=mode,
        best_epoch=best_epoch,
        epochs_completed=epochs_completed,
        training_seconds=training_seconds,
        validation_metrics=validation_metrics,
        validation_direct_recall=direct_recall,
        low_threshold=threshold_selection.low_threshold,
        high_threshold=threshold_selection.high_threshold,
        qualifies_on_validation=qualifies,
        checkpoint_path=str(checkpoint_path.resolve()),
        manifest_sha256=manifest_hash,
        loading_info=loading_info,
    )
    _write_json(
        candidate_directory / "validation.json",
        {
            "schemaVersion": 1,
            "thresholdSource": "validation",
            "selection": selection,
            "predictions": [
                {
                    "id": records[index].id,
                    "label": records[index].label,
                    "probability": probability,
                    "difficulty": records[index].difficulty,
                }
                for index, probability in zip(
                    split_indexes["validation"],
                    validation_probabilities,
                    strict=True,
                )
            ],
        },
    )
    return selection


def evaluate_challenge_candidate(
    *,
    config_path: Path,
    config: ImpactGate4Config,
    records: Sequence[ImpactRecord],
    candidate: CandidateSelection,
) -> ChallengeSelection:
    indexes = _split_indexes(records)["challenge"]
    runtime, encoded, auxiliary = _load_selected_runtime(
        config_path=config_path,
        config=config,
        records=records,
        candidate=candidate,
    )
    probabilities = _selected_probabilities(
        runtime,
        encoded,
        auxiliary,
        indexes,
        candidate,
        config,
    )
    metrics = binary_classification_metrics(
        _labels(records, indexes),
        probabilities,
        threshold=candidate.low_threshold,
    )
    direct_recall = _direct_recall(
        records,
        indexes,
        probabilities,
        candidate.low_threshold,
    )
    return ChallengeSelection(
        model_key=candidate.model_key,
        mode=candidate.mode,
        metrics=metrics,
        direct_recall=direct_recall,
        qualifies=(
            metrics.positive_recall
            >= config.thresholds.minimum_challenge_recall
        ),
    )


def _selection_rank(
    candidate: CandidateSelection,
    challenge: ChallengeSelection,
) -> tuple[Any, ...]:
    metrics = candidate.validation_metrics
    return (
        candidate.qualifies_on_validation and challenge.qualifies,
        challenge.metrics.positive_recall,
        challenge.metrics.candidate_reduction,
        metrics.average_precision,
        metrics.candidate_reduction,
        metrics.positive_recall,
        -metrics.brier_score,
        candidate.mode == "full_finetune",
        candidate.model_key == "ja_xsmall",
    )


def select_finalist(
    candidates: Sequence[CandidateSelection],
    challenges: Sequence[ChallengeSelection],
) -> CandidateSelection | None:
    if not candidates:
        raise ValueError("Gate 4 needs at least one trained candidate")
    challenge_by_candidate = {
        (challenge.model_key, challenge.mode): challenge
        for challenge in challenges
    }
    if len(challenge_by_candidate) != len(candidates):
        raise ValueError("Gate 4 needs one challenge result per candidate")
    eligible = [
        candidate
        for candidate in candidates
        if candidate.qualifies_on_validation
        and challenge_by_candidate[
            (candidate.model_key, candidate.mode)
        ].qualifies
    ]
    if not eligible:
        return None
    return max(
        eligible,
        key=lambda candidate: _selection_rank(
            candidate,
            challenge_by_candidate[(candidate.model_key, candidate.mode)],
        ),
    )


def _load_selected_runtime(
    *,
    config_path: Path,
    config: ImpactGate4Config,
    records: Sequence[ImpactRecord],
    candidate: CandidateSelection,
) -> tuple[Any, dict[str, Any], Any]:
    import torch
    from torch import nn

    _set_reproducible_runtime(
        config.training.seed,
        config.training.model_threads[candidate.model_key],
    )
    tokenizer, backbone, _manifest_hash, _loading_info = _load_verified_backbone(
        config_path,
        config,
        candidate.model_key,
    )
    encoded = _encode_records(
        tokenizer,
        records,
        max_pair_tokens=config.training.max_pair_tokens,
    )
    checkpoint = torch.load(
        candidate.checkpoint_path,
        map_location="cpu",
        weights_only=False,
    )
    if candidate.mode == "frozen_head":
        embeddings = _backbone_embeddings(
            backbone,
            encoded,
            batch_size=config.training.batch_size,
        )
        head = nn.Linear(embeddings.shape[1], 1).float()
        head.load_state_dict(checkpoint["headState"])
        return head, encoded, embeddings
    classifier = _build_classifier(backbone, config.training.seed)
    classifier.load_state_dict(checkpoint["classifierState"])
    return classifier, encoded, nullcontext()


def _selected_probabilities(
    runtime: Any,
    encoded: dict[str, Any],
    auxiliary: Any,
    indexes: Sequence[int],
    candidate: CandidateSelection,
    config: ImpactGate4Config,
) -> list[float]:
    if candidate.mode == "frozen_head":
        return _head_probabilities(runtime, auxiliary, indexes)
    return _classifier_probabilities(
        runtime,
        encoded,
        indexes,
        batch_size=config.training.batch_size,
    )


def _slice_metrics(
    records: Sequence[ImpactRecord],
    indexes: Sequence[int],
    probabilities: Sequence[float],
    *,
    threshold: float,
) -> dict[str, dict[str, Any]]:
    by_slice: dict[str, list[tuple[int, float]]] = {}
    for index, probability in zip(indexes, probabilities, strict=True):
        for difficulty in records[index].difficulty:
            by_slice.setdefault(difficulty, []).append(
                (records[index].label, probability)
            )
    return {
        slice_name: {
            "count": len(values),
            **asdict(
                binary_classification_metrics(
                    [label for label, _probability in values],
                    [probability for _label, probability in values],
                    threshold=threshold,
                )
            ),
        }
        for slice_name, values in sorted(by_slice.items())
    }


def _git_head_commit(experiment_root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=experiment_root,
        check=True,
        capture_output=True,
        text=True,
    )
    commit = completed.stdout.strip().lower()
    if len(commit) != 40 or any(
        character not in "0123456789abcdef" for character in commit
    ):
        raise RuntimeError("Gate 4 could not resolve a full Git HEAD commit")
    return commit


def evaluate_locked_finalist(
    *,
    config_path: Path,
    config: ImpactGate4Config,
    records: Sequence[ImpactRecord],
    candidate: CandidateSelection,
    output_root: Path,
) -> dict[str, Any]:
    opened_at = datetime.now(UTC).isoformat()
    consumption_identity = build_locked_test_consumption_identity(config)
    consumption_record = claim_locked_test_consumption(
        locked_test_consumption_path(
            config_path,
            config,
            consumption_identity,
        ),
        consumption_identity,
        opened_at_commit=_git_head_commit(config_path.parent.parent),
        opened_at=opened_at,
    )
    split_indexes = _split_indexes(records)
    runtime, encoded, auxiliary = _load_selected_runtime(
        config_path=config_path,
        config=config,
        records=records,
        candidate=candidate,
    )
    challenge_probabilities = _selected_probabilities(
        runtime,
        encoded,
        auxiliary,
        split_indexes["challenge"],
        candidate,
        config,
    )
    test_probabilities = _selected_probabilities(
        runtime,
        encoded,
        auxiliary,
        split_indexes["test"],
        candidate,
        config,
    )
    threshold = candidate.low_threshold
    challenge_metrics = binary_classification_metrics(
        _labels(records, split_indexes["challenge"]),
        challenge_probabilities,
        threshold=threshold,
    )
    test_metrics = binary_classification_metrics(
        _labels(records, split_indexes["test"]),
        test_probabilities,
        threshold=threshold,
    )
    test_direct_recall = _direct_recall(
        records,
        split_indexes["test"],
        test_probabilities,
        threshold,
    )
    assessment: ImpactProbeAssessment = assess_probe_signal(
        positive_recall=test_metrics.positive_recall,
        direct_recall=test_direct_recall,
        candidate_reduction=test_metrics.candidate_reduction,
        challenge_recall=challenge_metrics.positive_recall,
        minimum_recall=config.thresholds.minimum_recall,
        minimum_direct_recall=config.thresholds.minimum_direct_recall,
        minimum_candidate_reduction=(
            config.thresholds.minimum_candidate_reduction
        ),
        minimum_challenge_recall=config.thresholds.minimum_challenge_recall,
        gate31_prerequisite=config.protocol.gate31_prerequisite,
        formal_gate4_eligible=config.protocol.formal_gate4_eligible,
    )
    assessment_report = impact_probe_assessment_report(assessment)
    report = {
        "schemaVersion": 2,
        "createdAt": opened_at,
        "split": "test",
        "thresholdSource": "validation",
        "threshold": threshold,
        "highThreshold": candidate.high_threshold,
        "selectedModel": candidate.model_key,
        "selectedMode": candidate.mode,
        "testMetrics": test_metrics,
        "testDirectRecall": test_direct_recall,
        "challengeMetrics": challenge_metrics,
        "assessment": assessment_report,
        "phase1Ready": False,
        "consumption": consumption_record,
        "corpusReviewStatus": "unreviewed",
        "limitations": [
            "controlled synthetic probe only",
            "no human-verified direct-contradiction subset",
            "single fixed seed",
            "Gate 3.1 full-scene latency prerequisite is Hold",
            "not authorization for product candidate removal",
        ],
        "sliceMetrics": _slice_metrics(
            records,
            split_indexes["test"],
            test_probabilities,
            threshold=threshold,
        ),
        "predictions": [
            {
                "id": records[index].id,
                "label": records[index].label,
                "probability": probability,
                "difficulty": records[index].difficulty,
            }
            for index, probability in zip(
                split_indexes["test"],
                test_probabilities,
                strict=True,
            )
        ],
    }
    write_locked_test_report(output_root / "locked-test.json", _json_ready(report))
    return _json_ready(report)


def run_gate4(config_path: Path, output_root: Path) -> Path:
    config_path = config_path.resolve()
    output_root = output_root.resolve()
    if output_root.exists() and any(output_root.iterdir()):
        raise FileExistsError(
            f"Gate 4 output must be new or empty: {output_root}"
        )
    output_root.mkdir(parents=True, exist_ok=True)
    config = load_impact_gate4_config(config_path)
    experiment_root = config_path.parent.parent
    configure_hugging_face_environment(
        experiment_root,
        offline=True,
        configured_values=config.offline_environment,
    )
    records = load_impact_gate4_records(config_path, config)
    candidates: list[CandidateSelection] = []
    for model in config.models:
        for mode in config.training.modes:
            _progress("candidate_started", model=model.key, mode=mode)
            candidate = train_candidate(
                config_path=config_path,
                config=config,
                records=records,
                model_key=model.key,
                mode=mode,
                output_root=output_root,
            )
            candidates.append(candidate)
            _progress(
                "candidate_completed",
                model=model.key,
                mode=mode,
                bestEpoch=candidate.best_epoch,
                epochsCompleted=candidate.epochs_completed,
                validationAveragePrecision=(
                    candidate.validation_metrics.average_precision
                ),
                validationRecall=(
                    candidate.validation_metrics.positive_recall
                ),
                validationReduction=(
                    candidate.validation_metrics.candidate_reduction
                ),
            )
    challenges: list[ChallengeSelection] = []
    for candidate in candidates:
        _progress(
            "challenge_started",
            model=candidate.model_key,
            mode=candidate.mode,
        )
        challenge = evaluate_challenge_candidate(
            config_path=config_path,
            config=config,
            records=records,
            candidate=candidate,
        )
        challenges.append(challenge)
        _progress(
            "challenge_completed",
            model=candidate.model_key,
            mode=candidate.mode,
            recall=challenge.metrics.positive_recall,
            reduction=challenge.metrics.candidate_reduction,
            qualifies=challenge.qualifies,
        )
    finalist = select_finalist(candidates, challenges)
    selection_phase = {
        "dataScope": (
            "validation checkpoint and threshold selection plus "
            "challenge robustness only"
        ),
        "testStatus": (
            "unopened_at_selection"
            if finalist is not None
            else "not_opened_no_eligible_finalist"
        ),
    }
    _write_json(
        output_root / "selection.json",
        {
            "schemaVersion": 2,
            "selectionPhase": selection_phase,
            "selected": finalist,
            "candidates": candidates,
            "challenges": challenges,
        },
    )
    if finalist is None:
        _progress(
            "selection_stopped",
            reason="no_eligible_finalist",
            testStatus="not_opened",
        )
        report_path = output_root / "gate4-results.json"
        _write_json(
            report_path,
            {
                "schemaVersion": 2,
                "createdAt": datetime.now(UTC).isoformat(),
                "config": str(config_path),
                "corpusSha256": config.corpus.sha256,
                "recordCount": len(records),
                "selectionPhase": selection_phase,
                "candidates": candidates,
                "challenges": challenges,
                "selected": None,
                "lockedTestPhase": {
                    "status": "not_opened",
                    "reason": "no_eligible_finalist",
                },
                "syntheticProbeAssessment": "not_evaluated",
                "gate31Prerequisite": (
                    config.protocol.gate31_prerequisite
                ),
                "formalGate4Eligible": (
                    config.protocol.formal_gate4_eligible
                ),
                "continueToHumanCorpus": False,
                "effectiveVerdict": "stop_before_locked_test",
                "phase1Ready": False,
            },
        )
        return report_path
    _progress(
        "finalist_selected",
        model=finalist.model_key,
        mode=finalist.mode,
        threshold=finalist.low_threshold,
    )
    locked_test = evaluate_locked_finalist(
        config_path=config_path,
        config=config,
        records=records,
        candidate=finalist,
        output_root=output_root,
    )
    _progress(
        "locked_test_completed",
        assessment=locked_test["assessment"],
        testMetrics=locked_test["testMetrics"],
    )
    assessment = locked_test["assessment"]
    if not isinstance(assessment, dict):
        raise TypeError("Gate 4 locked assessment must be a JSON object")
    locked_test_phase: dict[str, Any] = {"status": "opened_once"}
    consumption = locked_test.get("consumption")
    if isinstance(consumption, dict):
        fingerprint = consumption.get("fingerprintSha256")
        if isinstance(fingerprint, str):
            locked_test_phase["consumptionFingerprint"] = fingerprint
    report_path = output_root / "gate4-results.json"
    _write_json(
        report_path,
        {
            "schemaVersion": 2,
            "createdAt": datetime.now(UTC).isoformat(),
            "config": str(config_path),
            "corpusSha256": config.corpus.sha256,
            "recordCount": len(records),
            "selectionPhase": selection_phase,
            "candidates": candidates,
            "challenges": challenges,
            "selected": finalist,
            "lockedTestPhase": locked_test_phase,
            "syntheticProbeAssessment": assessment[
                "syntheticProbeAssessment"
            ],
            "gate31Prerequisite": assessment["gate31Prerequisite"],
            "formalGate4Eligible": assessment["formalGate4Eligible"],
            "continueToHumanCorpus": assessment["continueToHumanCorpus"],
            "effectiveVerdict": assessment["effectiveVerdict"],
            "phase1Ready": assessment["phase1Ready"],
            "lockedTest": locked_test,
        },
    )
    return report_path


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    arguments = _build_parser().parse_args()
    report = run_gate4(arguments.config, arguments.output)
    print(
        json.dumps(
            {"gate4Report": str(report)},
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
