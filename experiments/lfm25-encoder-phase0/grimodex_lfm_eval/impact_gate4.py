"""Contracts and controlled public corpus for Phase 0b Impact Review Gate 4."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import yaml

from .dataset import load_jsonl, validate_story_splits, validate_unique_ids
from .impact_gate3 import (
    ImpactGate3ModelSpec,
    SHA256_PATTERN,
    sha256_file,
)
from .schemas import ImpactRecord, SplitManifest


GATE4_GENERATOR_VERSION = "phase0b-impact-gate4-controlled-v1"
GATE4_RECORD_COUNT = 240
GATE4_STORY_COUNTS = {
    "train": 14,
    "validation": 4,
    "test": 4,
    "challenge": 2,
}


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _ConfigModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class ImpactGate4CorpusConfig(_ConfigModel):
    path: str = Field(min_length=1)
    sha256: str
    record_count: Literal[240]
    story_counts: dict[str, int]

    @field_validator("path")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError("Gate 4 corpus path must be normalized and relative")
        return value

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not SHA256_PATTERN.fullmatch(normalized):
            raise ValueError("Gate 4 corpus SHA-256 must be a lowercase digest")
        return normalized

    @field_validator("story_counts")
    @classmethod
    def validate_story_counts(cls, value: dict[str, int]) -> dict[str, int]:
        if value != GATE4_STORY_COUNTS:
            raise ValueError(
                f"Gate 4 story counts must remain fixed at {GATE4_STORY_COUNTS}"
            )
        return value


class ImpactGate4TrainingConfig(_ConfigModel):
    modes: tuple[Literal["frozen_head", "full_finetune"], ...]
    seed: Literal[42]
    max_pair_tokens: Literal[512]
    batch_size: int = Field(ge=1)
    frozen_learning_rate: float = Field(gt=0.0)
    full_learning_rate: float = Field(gt=0.0)
    weight_decay: float = Field(ge=0.0)
    frozen_epoch_cap: int = Field(ge=1)
    full_epoch_cap: int = Field(ge=1)
    early_stop_patience: int = Field(ge=1)
    model_threads: dict[str, int]

    @field_validator("modes")
    @classmethod
    def validate_modes(
        cls,
        value: tuple[Literal["frozen_head", "full_finetune"], ...],
    ) -> tuple[Literal["frozen_head", "full_finetune"], ...]:
        expected = ("frozen_head", "full_finetune")
        if value != expected:
            raise ValueError(f"Gate 4 modes must remain fixed at {expected}")
        return value

    @field_validator("model_threads")
    @classmethod
    def validate_model_threads(cls, value: dict[str, int]) -> dict[str, int]:
        if set(value) != {"ja_xsmall", "modernbert_ja_30m"}:
            raise ValueError("Gate 4 needs one thread cap per selected model")
        if any(thread_count <= 0 for thread_count in value.values()):
            raise ValueError("Gate 4 thread caps must be positive")
        return value


class ImpactGate4ThresholdConfig(_ConfigModel):
    minimum_recall: Literal[0.95]
    minimum_direct_recall: Literal[1.0]
    minimum_candidate_reduction: Literal[0.30]
    minimum_challenge_recall: Literal[0.80]


class ImpactGate4ProtocolConfig(_ConfigModel):
    selection_protocol_version: Literal["phase0b-impact-gate4-selection-v2"]
    selection_protocol_sha256: str
    test_consumption_registry: Literal[
        "data/public/gate4/test-consumption"
    ]
    gate31_prerequisite: Literal["hold"]
    formal_gate4_eligible: Literal[False]

    @field_validator("selection_protocol_sha256")
    @classmethod
    def validate_protocol_sha256(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not SHA256_PATTERN.fullmatch(normalized):
            raise ValueError(
                "Gate 4 selection protocol SHA-256 must be a lowercase digest"
            )
        return normalized


class ImpactGate4Config(_ConfigModel):
    schema_version: Literal[1]
    corpus: ImpactGate4CorpusConfig
    protocol: ImpactGate4ProtocolConfig
    training: ImpactGate4TrainingConfig
    thresholds: ImpactGate4ThresholdConfig
    offline_environment: dict[str, str] = Field(default_factory=dict)
    models: tuple[ImpactGate3ModelSpec, ...] = Field(min_length=2)

    @model_validator(mode="after")
    def validate_models(self) -> "ImpactGate4Config":
        keys = tuple(model.key for model in self.models)
        if keys != ("ja_xsmall", "modernbert_ja_30m"):
            raise ValueError(
                "Gate 4 models must be ordered ja_xsmall, modernbert_ja_30m"
            )
        return self

    def model(self, key: str) -> ImpactGate3ModelSpec:
        for model in self.models:
            if model.key == key:
                return model
        available = ", ".join(model.key for model in self.models)
        raise ValueError(f"unknown Gate 4 model {key!r}; available: {available}")


@dataclass(frozen=True)
class ImpactProbeAssessment:
    synthetic_probe_assessment: Literal[
        "signal_detected",
        "insufficient_signal",
    ]
    gate31_prerequisite: Literal["hold"]
    formal_gate4_eligible: Literal[False]
    continue_to_human_corpus: Literal[False]
    effective_verdict: Literal[
        "hold_on_latency_prerequisite",
        "stop_on_synthetic_probe",
    ]
    phase1_ready: Literal[False]
    failed_requirements: tuple[str, ...]


@dataclass(frozen=True)
class LockedTestConsumptionIdentity:
    fingerprint_sha256: str
    corpus_sha256: str
    test_story_ids: tuple[str, ...]
    selection_protocol_version: str
    selection_protocol_sha256: str
    model_set: tuple[dict[str, Any], ...]


class LockedTestEvaluationError(RuntimeError):
    """Raised when a locked test report would leak or overwrite evidence."""


@dataclass(frozen=True)
class _StorySeed:
    story_id: str
    name: str
    alias: str
    old_role: str
    new_role: str
    old_ability: str
    new_ability: str
    old_state: str
    new_state: str
    phase_name: str


_NAMES = (
    "朱音",
    "冬馬",
    "澪",
    "蒼士",
    "小夜",
    "玲央",
    "千景",
    "環",
    "琴葉",
    "伊織",
    "紫苑",
    "凪",
    "灯里",
    "景虎",
    "真白",
    "柊",
    "楓",
    "朔",
    "皐月",
    "奏",
    "巴",
    "旭",
    "瑠璃",
    "湊",
)

_ALIASES = (
    "紅の継ぎ手",
    "北塔の鷹",
    "潮読み",
    "青磁の剣",
    "宵鈴",
    "灰冠",
    "影縫い",
    "輪守",
    "風琴",
    "白墨",
    "紫電",
    "凪渡り",
    "灯守",
    "山猫",
    "雪筆",
    "柊番",
    "楓火",
    "月朔",
    "五月雨",
    "音叉",
    "双葉",
    "朝凪",
    "瑠璃眼",
    "港狼",
)

_ROLE_PAIRS = (
    ("王都警備隊の斥候", "王立図書院の調査員"),
    ("北境伯の護衛", "自由都市の交渉官"),
    ("潮見組合の測量士", "灯台守"),
    ("近衛騎士", "地方巡察官"),
    ("神殿の記録官", "旅の薬師"),
    ("鉱山領主の代官", "坑夫組合の代表"),
    ("密偵局の伝令", "公文書庫の司書"),
    ("工房の徒弟", "時計塔の技師"),
)

_ABILITY_PAIRS = (
    ("傷を癒やす力", "炎を操る力"),
    ("鳥の声を聞く力", "金属を曲げる力"),
    ("水中で息をする力", "風向きを変える力"),
    ("記憶を読む力", "幻を映す力"),
    ("影へ潜る力", "光を固める力"),
    ("毒を見分ける力", "地脈を探る力"),
    ("未来の夢を見る力", "過去の音を聞く力"),
    ("獣と話す力", "文字を触れて読む力"),
)

_STATE_PAIRS = (
    ("旧市街の鐘楼に住んでいる", "東港の診療所に住んでいる"),
    ("王家の指輪を所有している", "王家の指輪を評議会へ返還した"),
    ("消息不明とされている", "生存が確認されている"),
    ("白鷺隊と敵対している", "白鷺隊と同盟を結んでいる"),
    ("西門の牢に拘束されている", "監視付きで釈放されている"),
    ("黒馬を所有している", "黒馬を妹へ譲っている"),
    ("南の離宮に滞在している", "雪原の砦に移っている"),
    ("師匠とは絶縁している", "師匠と和解している"),
)

_PHASE_NAMES = (
    "第一幕",
    "帰還後",
    "王都編",
    "冬至祭の後",
    "北境遠征中",
    "停戦成立後",
)


def _story_seeds() -> tuple[_StorySeed, ...]:
    seeds: list[_StorySeed] = []
    for index, (name, alias) in enumerate(zip(_NAMES, _ALIASES, strict=True)):
        old_role, new_role = _ROLE_PAIRS[index % len(_ROLE_PAIRS)]
        old_ability, new_ability = _ABILITY_PAIRS[index % len(_ABILITY_PAIRS)]
        old_state, new_state = _STATE_PAIRS[index % len(_STATE_PAIRS)]
        seeds.append(
            _StorySeed(
                story_id=f"gate4-story-{index + 1:02d}",
                name=name,
                alias=alias,
                old_role=old_role,
                new_role=new_role,
                old_ability=old_ability,
                new_ability=new_ability,
                old_state=old_state,
                new_state=new_state,
                phase_name=_PHASE_NAMES[index % len(_PHASE_NAMES)],
            )
        )
    return tuple(seeds)


def build_impact_probe_split_manifest() -> SplitManifest:
    story_ids = [seed.story_id for seed in _story_seeds()]
    return SplitManifest.model_validate(
        {
            "schemaVersion": 1,
            "train": story_ids[:14],
            "validation": story_ids[14:18],
            "test": story_ids[18:22],
            "challenge": story_ids[22:],
        }
    )


def _diff_payload(
    seed: _StorySeed,
    *,
    pair_key: str,
    field: str,
    field_name: str,
    old: str,
    new: str,
) -> dict[str, Any]:
    return {
        "change_id": f"{seed.story_id}-{pair_key}",
        "entry_id": f"character-{seed.story_id}",
        "entry_name": seed.name,
        "entry_type": "character",
        "change_summary": f"{seed.name}の{field_name}を「{old}」から「{new}」へ変更",
        "changes": [
            {
                "field": field,
                "name": field_name,
                "old": old,
                "new": new,
            }
        ],
    }


def _impact_record(
    seed: _StorySeed,
    *,
    pair_key: str,
    polarity: Literal["positive", "negative"],
    diff_payload: dict[str, Any],
    scene_text: str,
    affected_text: str | None,
    difficulty: list[str],
) -> ImpactRecord:
    affected_spans: list[dict[str, Any]] = []
    if affected_text is not None:
        start = scene_text.index(affected_text)
        affected_spans.append(
            {
                "text": affected_text,
                "start": start,
                "end": start + len(affected_text),
            }
        )
    return ImpactRecord.model_validate(
        {
            "id": f"impact-{seed.story_id}-{pair_key}-{polarity}",
            "task": "impact",
            "language": "ja",
            "storyId": seed.story_id,
            "source": "synthetic",
            "generatorVersion": GATE4_GENERATOR_VERSION,
            "reviewStatus": "unreviewed",
            "license": "synthetic",
            "entry": {
                "id": f"character-{seed.story_id}",
                "name": seed.name,
                "type": "character",
            },
            "diffPayload": diff_payload,
            "sceneText": scene_text,
            "label": int(polarity == "positive"),
            "affectedSpans": affected_spans,
            "difficulty": difficulty,
        }
    )


def _build_story_records(seed: _StorySeed, index: int) -> list[ImpactRecord]:
    records: list[ImpactRecord] = []
    old_age = 16 + (index % 8)
    new_age = old_age + 2
    fresh_test = 18 <= index < 22
    challenge = index >= 22
    challenge_slice = ["challenge"] if challenge else []

    age_diff = _diff_payload(
        seed,
        pair_key="age",
        field="detail",
        field_name="年齢",
        old=f"{old_age}歳",
        new=f"{new_age}歳",
    )
    if challenge:
        age_affected = f"{old_age}歳だと、現在の{seed.name}は戸籍に記されている"
    elif fresh_test:
        age_affected = f"当日付の名簿は{seed.name}を{old_age}歳として扱っている"
    else:
        age_affected = f"{seed.name}の年齢は今も{old_age}歳だ"
    age_scene = f"夜明けの点呼で、{age_affected}。記録官は帳面を閉じた。"
    records.append(
        _impact_record(
            seed,
            pair_key="age",
            polarity="positive",
            diff_payload=age_diff,
            scene_text=age_scene,
            affected_text=age_affected,
            difficulty=[
                "detail",
                "numeric",
                "direct-contradiction",
                "narration",
                *challenge_slice,
            ],
        )
    )
    age_negative = (
        f"年代資料には、当時{old_age}歳だった{seed.name}の署名が保存されている。"
        if fresh_test
        else f"{seed.name}が{old_age}歳だった頃の遠征日誌を、皆で読み返した。"
    )
    records.append(
        _impact_record(
            seed,
            pair_key="age",
            polarity="negative",
            diff_payload=age_diff,
            scene_text=age_negative,
            affected_text=None,
            difficulty=[
                "detail",
                "numeric",
                "past-state-negative",
                "flashback",
                *challenge_slice,
            ],
        )
    )

    new_alias = f"{seed.alias}改"
    alias_diff = _diff_payload(
        seed,
        pair_key="alias",
        field="base.summary",
        field_name="通称",
        old=seed.alias,
        new=new_alias,
    )
    if challenge:
        alias_affected = f"『{seed.alias}』こそ現在の私の通称だ"
    elif fresh_test:
        alias_affected = f"今日の呼び名も『{seed.alias}』で変わりない"
    else:
        alias_affected = f"今でも皆は私を『{seed.alias}』と呼ぶ"
    alias_scene = f"「{alias_affected}」と{seed.name}は会議で名乗った。"
    records.append(
        _impact_record(
            seed,
            pair_key="alias",
            polarity="positive",
            diff_payload=alias_diff,
            scene_text=alias_scene,
            affected_text=alias_affected,
            difficulty=[
                "base-summary",
                "alias-name",
                "direct-contradiction",
                "dialogue",
                *challenge_slice,
            ],
        )
    )
    alias_negative = (
        f"博物館の旧い表札だけが、廃称『{seed.alias}』を展示していた。"
        if fresh_test
        else f"古い暗号表には『{seed.alias}』という廃止済みの符号が残っていた。"
    )
    records.append(
        _impact_record(
            seed,
            pair_key="alias",
            polarity="negative",
            diff_payload=alias_diff,
            scene_text=alias_negative,
            affected_text=None,
            difficulty=[
                "base-summary",
                "alias-name",
                "alias-only-negative",
                "past-state-negative",
                "quotation",
                *challenge_slice,
            ],
        )
    )

    role_slice = "base-summary" if index % 2 == 0 else "base-content"
    role_diff = _diff_payload(
        seed,
        pair_key="role",
        field=role_slice.replace("-", "."),
        field_name="所属と役職",
        old=seed.old_role,
        new=seed.new_role,
    )
    if challenge:
        role_affected = (
            f"評議会が現職として紹介したのは、{seed.old_role}の{seed.name}だった"
        )
    elif fresh_test:
        role_affected = (
            f"本日の席次表で{seed.name}の現職は{seed.old_role}と明記された"
        )
    else:
        role_affected = f"{seed.name}は現在も{seed.old_role}として評議会に出席した"
    role_scene = f"{role_affected}。席札にも同じ肩書が刻まれている。"
    records.append(
        _impact_record(
            seed,
            pair_key="role",
            polarity="positive",
            diff_payload=role_diff,
            scene_text=role_scene,
            affected_text=role_affected,
            difficulty=[
                role_slice,
                "affiliation-role-relationship",
                "direct-contradiction",
                "narration",
                *challenge_slice,
            ],
        )
    )
    role_negative = (
        f"開会前、{seed.name}は欠けた窓硝子の枚数を帳面に記した。"
        if fresh_test
        else f"{seed.name}は窓辺で雨音を数え、評議会の開会を静かに待った。"
    )
    records.append(
        _impact_record(
            seed,
            pair_key="role",
            polarity="negative",
            diff_payload=role_diff,
            scene_text=role_negative,
            affected_text=None,
            difficulty=[
                role_slice,
                "affiliation-role-relationship",
                "unrelated-changed-field-negative",
                "narration",
                *challenge_slice,
            ],
        )
    )

    ability_slice = "base-content" if index % 2 == 0 else "base-summary"
    ability_diff = _diff_payload(
        seed,
        pair_key="ability",
        field=ability_slice.replace("-", "."),
        field_name="能力",
        old=seed.old_ability,
        new=seed.new_ability,
    )
    if challenge:
        ability_affected = (
            f"{seed.new_ability}は使えず、今も{seed.old_ability}だけを扱える"
        )
    elif fresh_test:
        ability_affected = (
            f"現時点の{seed.name}には{seed.old_ability}があり、"
            f"{seed.new_ability}は備わっていない"
        )
    else:
        ability_affected = (
            f"{seed.name}が使えるのは{seed.old_ability}だけで、"
            f"{seed.new_ability}ではない"
        )
    ability_scene = f"{ability_affected}。本人はそう断言して実演を始めた。"
    records.append(
        _impact_record(
            seed,
            pair_key="ability",
            polarity="positive",
            diff_payload=ability_diff,
            scene_text=ability_scene,
            affected_text=ability_affected,
            difficulty=[
                ability_slice,
                "ability-presence-absence",
                "direct-contradiction",
                "negation",
                "dialogue",
                *challenge_slice,
            ],
        )
    )
    conditional_frames = (
        "もし",
        "夢の中で",
        "芝居の台詞では",
        "敵がついた嘘では",
        "古い手紙の引用では",
    )
    frame = conditional_frames[index % len(conditional_frames)]
    ability_negative = (
        f"舞台上の仮定として、{seed.name}役が{seed.old_ability}を使う台詞が読まれた。"
        if fresh_test
        else f"{frame}{seed.name}が{seed.old_ability}を使えたなら、と仲間は仮定した。"
    )
    records.append(
        _impact_record(
            seed,
            pair_key="ability",
            polarity="negative",
            diff_payload=ability_diff,
            scene_text=ability_negative,
            affected_text=None,
            difficulty=[
                ability_slice,
                "ability-presence-absence",
                "hypothetical-dream-flashback-lie-quotation",
                "negation",
                *challenge_slice,
            ],
        )
    )

    phase_slice = ("phase-summary", "phase-content", "phase-detail")[index % 3]
    state_diff = _diff_payload(
        seed,
        pair_key="phase-state",
        field=phase_slice.replace("-", "."),
        field_name=f"{seed.phase_name}の状態",
        old=seed.old_state,
        new=seed.new_state,
    )
    if challenge:
        state_affected = (
            f"{seed.name}が{seed.old_state}以上、{seed.phase_name}の交渉は進められない"
        )
    elif fresh_test:
        state_affected = (
            f"{seed.phase_name}の現況報告は、{seed.name}が{seed.old_state}と結論づけた"
        )
    else:
        state_affected = f"{seed.phase_name}の現在も、{seed.name}は{seed.old_state}"
    state_scene = f"{state_affected}。そのため一行は計画を組み直した。"
    records.append(
        _impact_record(
            seed,
            pair_key="phase-state",
            polarity="positive",
            diff_payload=state_diff,
            scene_text=state_scene,
            affected_text=state_affected,
            difficulty=[
                phase_slice,
                "life-death-ownership-location-state",
                "implication-conflict",
                "narration",
                *challenge_slice,
            ],
        )
    )
    state_negative = (
        f"年表は{seed.phase_name}以前に{seed.name}が{seed.old_state}期間だけを振り返った。"
        if fresh_test
        else (
            f"{seed.phase_name}より前、{seed.name}が{seed.old_state}時期を"
            "古老は回想した。"
        )
    )
    records.append(
        _impact_record(
            seed,
            pair_key="phase-state",
            polarity="negative",
            diff_payload=state_diff,
            scene_text=state_negative,
            affected_text=None,
            difficulty=[
                phase_slice,
                "life-death-ownership-location-state",
                "past-state-negative",
                "flashback",
                *challenge_slice,
            ],
        )
    )
    return records


def build_impact_probe_records() -> tuple[ImpactRecord, ...]:
    records = [
        record
        for index, seed in enumerate(_story_seeds())
        for record in _build_story_records(seed, index)
    ]
    if len(records) != GATE4_RECORD_COUNT:
        raise RuntimeError(
            f"Gate 4 builder produced {len(records)} records, "
            f"expected {GATE4_RECORD_COUNT}"
        )
    validate_unique_ids(records)
    split_manifest = build_impact_probe_split_manifest()
    story_to_split = {
        story_id: split
        for split in ("train", "validation", "test", "challenge")
        for story_id in getattr(split_manifest, split)
    }
    records_by_split: dict[str, list[ImpactRecord]] = {
        split: [] for split in ("train", "validation", "test", "challenge")
    }
    for record in records:
        records_by_split[story_to_split[record.story_id]].append(record)
    validate_story_splits(records_by_split)
    return tuple(records)


def load_impact_gate4_config(path: Path) -> ImpactGate4Config:
    payload = yaml.safe_load(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Gate 4 configuration must be a mapping")
    return ImpactGate4Config.model_validate(payload)


def _experiment_path(config_path: Path, relative: str) -> Path:
    experiment_root = config_path.resolve().parent.parent
    path = (experiment_root / relative).resolve()
    try:
        path.relative_to(experiment_root)
    except ValueError as error:
        raise ValueError("Gate 4 paths must remain inside the experiment") from error
    return path


def load_impact_gate4_records(
    config_path: Path,
    config: ImpactGate4Config,
) -> tuple[ImpactRecord, ...]:
    source = _experiment_path(config_path, config.corpus.path)
    actual_hash = sha256_file(source)
    if actual_hash != config.corpus.sha256:
        raise ValueError(
            "Gate 4 corpus SHA-256 mismatch: "
            f"expected {config.corpus.sha256}, got {actual_hash}"
        )
    parsed = load_jsonl(source)
    if any(not isinstance(record, ImpactRecord) for record in parsed):
        raise ValueError("Gate 4 corpus may contain ImpactRecord values only")
    records = tuple(record for record in parsed if isinstance(record, ImpactRecord))
    if len(records) != config.corpus.record_count:
        raise ValueError(
            f"Gate 4 corpus has {len(records)} records; "
            f"expected {config.corpus.record_count}"
        )
    validate_unique_ids(records)
    return records


def build_locked_test_consumption_identity(
    config: ImpactGate4Config,
) -> LockedTestConsumptionIdentity:
    split_manifest = build_impact_probe_split_manifest()
    model_set = tuple(
        {
            "key": model.key,
            "revision": model.revision,
            "trainingModes": list(config.training.modes),
        }
        for model in config.models
    )
    fingerprint_payload = {
        "corpusSha256": config.corpus.sha256,
        "testStoryIds": list(split_manifest.test),
        "selectionProtocolVersion": (
            config.protocol.selection_protocol_version
        ),
        "selectionProtocolSha256": (
            config.protocol.selection_protocol_sha256
        ),
        "modelSet": list(model_set),
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    return LockedTestConsumptionIdentity(
        fingerprint_sha256=fingerprint,
        corpus_sha256=config.corpus.sha256,
        test_story_ids=tuple(split_manifest.test),
        selection_protocol_version=(
            config.protocol.selection_protocol_version
        ),
        selection_protocol_sha256=(
            config.protocol.selection_protocol_sha256
        ),
        model_set=model_set,
    )


def locked_test_consumption_path(
    config_path: Path,
    config: ImpactGate4Config,
    identity: LockedTestConsumptionIdentity,
) -> Path:
    registry = _experiment_path(
        config_path,
        config.protocol.test_consumption_registry,
    )
    return registry / f"{identity.fingerprint_sha256}.json"


def _locked_test_consumption_payload(
    identity: LockedTestConsumptionIdentity,
    *,
    opened_at_commit: str,
    opened_at: str,
) -> dict[str, Any]:
    normalized_commit = opened_at_commit.strip().lower()
    if len(normalized_commit) != 40 or any(
        character not in "0123456789abcdef"
        for character in normalized_commit
    ):
        raise LockedTestEvaluationError(
            "locked test consumption needs a 40-character Git commit"
        )
    return {
        "schemaVersion": 1,
        "fingerprintSha256": identity.fingerprint_sha256,
        "corpusSha256": identity.corpus_sha256,
        "testStoryIds": list(identity.test_story_ids),
        "selectionProtocolVersion": identity.selection_protocol_version,
        "selectionProtocolSha256": identity.selection_protocol_sha256,
        "modelSet": list(identity.model_set),
        "openedAt": opened_at,
        "openedAtCommit": normalized_commit,
        "consumed": True,
    }


def claim_locked_test_consumption(
    path: Path,
    identity: LockedTestConsumptionIdentity,
    *,
    opened_at_commit: str,
    opened_at: str,
) -> dict[str, Any]:
    payload = _locked_test_consumption_payload(
        identity,
        opened_at_commit=opened_at_commit,
        opened_at=opened_at,
    )
    destination = path.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("x", encoding="utf-8") as output:
            json.dump(
                payload,
                output,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            output.write("\n")
    except FileExistsError as error:
        raise LockedTestEvaluationError(
            "locked test split is already consumed for fingerprint "
            f"{identity.fingerprint_sha256}: {destination}"
        ) from error
    return payload


def impact_probe_assessment_report(
    assessment: ImpactProbeAssessment,
) -> dict[str, Any]:
    return {
        "syntheticProbeAssessment": (
            assessment.synthetic_probe_assessment
        ),
        "gate31Prerequisite": assessment.gate31_prerequisite,
        "formalGate4Eligible": assessment.formal_gate4_eligible,
        "continueToHumanCorpus": assessment.continue_to_human_corpus,
        "effectiveVerdict": assessment.effective_verdict,
        "phase1Ready": assessment.phase1_ready,
        "failedRequirements": list(assessment.failed_requirements),
    }


def assess_probe_signal(
    *,
    positive_recall: float,
    direct_recall: float,
    candidate_reduction: float,
    challenge_recall: float,
    minimum_recall: float = 0.95,
    minimum_direct_recall: float = 1.0,
    minimum_candidate_reduction: float = 0.30,
    minimum_challenge_recall: float = 0.80,
    gate31_prerequisite: Literal["hold"] = "hold",
    formal_gate4_eligible: Literal[False] = False,
) -> ImpactProbeAssessment:
    metrics = {
        "positive_recall": positive_recall,
        "direct_recall": direct_recall,
        "candidate_reduction": candidate_reduction,
        "challenge_recall": challenge_recall,
    }
    if any(not 0.0 <= value <= 1.0 for value in metrics.values()):
        raise ValueError("Gate 4 probe metrics must be between zero and one")
    requirements = {
        "positive_recall": (positive_recall, minimum_recall),
        "direct_recall": (direct_recall, minimum_direct_recall),
        "candidate_reduction": (
            candidate_reduction,
            minimum_candidate_reduction,
        ),
        "challenge_recall": (challenge_recall, minimum_challenge_recall),
    }
    failed = tuple(
        name
        for name, (observed, minimum) in requirements.items()
        if observed < minimum
    )
    return ImpactProbeAssessment(
        synthetic_probe_assessment=(
            "signal_detected" if not failed else "insufficient_signal"
        ),
        gate31_prerequisite=gate31_prerequisite,
        formal_gate4_eligible=formal_gate4_eligible,
        continue_to_human_corpus=False,
        effective_verdict=(
            "hold_on_latency_prerequisite"
            if not failed
            else "stop_on_synthetic_probe"
        ),
        phase1_ready=False,
        failed_requirements=failed,
    )


def write_locked_test_report(path: Path, report: dict[str, Any]) -> None:
    if report.get("split") != "test":
        raise LockedTestEvaluationError("locked report split must be test")
    if report.get("thresholdSource") != "validation":
        raise LockedTestEvaluationError(
            "locked test threshold must come from validation"
        )
    destination = path.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("x", encoding="utf-8") as output:
            json.dump(
                report,
                output,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            output.write("\n")
    except FileExistsError as error:
        raise LockedTestEvaluationError(
            f"locked test report already exists: {destination}"
        ) from error
