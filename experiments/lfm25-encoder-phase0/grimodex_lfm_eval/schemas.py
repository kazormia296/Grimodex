"""Versioned public dataset contracts for both Phase 0 workstreams."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TaskName(StrEnum):
    RELEVANCE = "relevance"
    IMPACT = "impact"


class Language(StrEnum):
    JA = "ja"
    EN = "en"


class SourceKind(StrEnum):
    SEED = "seed"
    SYNTHETIC = "synthetic"
    PRIVATE = "private"


class ReviewStatus(StrEnum):
    UNREVIEWED = "unreviewed"
    SAMPLED = "sampled"
    HUMAN_VERIFIED = "human-verified"


class LicenseKind(StrEnum):
    PROJECT_OWNED = "project-owned"
    SYNTHETIC = "synthetic"
    PRIVATE = "private-not-for-redistribution"


class ContractModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
        use_enum_values=True,
    )


class ProvenanceRecord(ContractModel):
    id: str = Field(min_length=1)
    task: TaskName
    language: Language
    story_id: str = Field(alias="storyId", min_length=1)
    source: SourceKind
    generator_version: str = Field(alias="generatorVersion", min_length=1)
    review_status: ReviewStatus = Field(alias="reviewStatus")
    license: LicenseKind

    @model_validator(mode="after")
    def validate_private_license(self) -> "ProvenanceRecord":
        if self.source == SourceKind.PRIVATE and self.license != LicenseKind.PRIVATE:
            raise ValueError(
                "private source records must use private-not-for-redistribution"
            )
        if self.source != SourceKind.PRIVATE and self.license == LicenseKind.PRIVATE:
            raise ValueError("private-not-for-redistribution requires source=private")
        return self


class RelevancePair(ProvenanceRecord):
    task: Literal["relevance"]
    query_id: str = Field(alias="queryId", min_length=1)
    query: str = Field(min_length=1)
    candidate_text: str = Field(alias="candidateText", min_length=1)
    relevance_grade: int = Field(alias="relevanceGrade", ge=0, le=2)
    difficulty: list[str] = Field(default_factory=list)


class EntryRef(ContractModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    type: str = Field(min_length=1)


class AffectedSpan(ContractModel):
    text: str = Field(min_length=1)
    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_bounds(self) -> "AffectedSpan":
        if self.end <= self.start:
            raise ValueError("affected span end must be greater than start")
        return self


class ImpactRecord(ProvenanceRecord):
    task: Literal["impact"]
    entry: EntryRef
    diff_payload: dict[str, Any] = Field(alias="diffPayload")
    scene_text: str = Field(alias="sceneText", min_length=1)
    label: Literal[0, 1]
    affected_spans: list[AffectedSpan] = Field(
        alias="affectedSpans",
        default_factory=list,
    )
    difficulty: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_affected_spans(self) -> "ImpactRecord":
        if self.label == 1 and not self.affected_spans:
            raise ValueError("positive impact records require an affected span")
        if self.label == 0 and self.affected_spans:
            raise ValueError("negative impact records cannot contain affected spans")
        for span in self.affected_spans:
            if span.end > len(self.scene_text):
                raise ValueError("affected span exceeds sceneText")
            if self.scene_text[span.start : span.end] != span.text:
                raise ValueError("affected span text does not match sceneText")
        return self


class SplitManifest(ContractModel):
    schema_version: Literal[1] = Field(alias="schemaVersion", default=1)
    train: list[str]
    validation: list[str]
    test: list[str]
    challenge: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_story_isolation(self) -> "SplitManifest":
        owners: dict[str, str] = {}
        for split_name in ("train", "validation", "test", "challenge"):
            for story_id in getattr(self, split_name):
                owner = owners.setdefault(story_id, split_name)
                if owner != split_name:
                    raise ValueError(
                        f"story {story_id!r} appears in both {owner} and {split_name}"
                    )
        return self


DatasetRecord = RelevancePair | ImpactRecord
