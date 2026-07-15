from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from litehouse.domain import Claim, ClaimEvidenceLink, EvidenceSegment
from litehouse.infrastructure.exports import CitationStyle, ReferenceRecord


class UnsupportedClaimPolicy(StrEnum):
    REFUSE = "refuse"
    MARK_UNSUPPORTED = "mark_unsupported"


@dataclass(frozen=True, slots=True)
class ReadingRecommendation:
    work_id: str
    rank: int
    rationale: tuple[str, ...]
    evidence_segment_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        work_id = self.work_id.strip()
        rationale = tuple(item.strip() for item in self.rationale)
        evidence_segment_ids = tuple(item.strip() for item in self.evidence_segment_ids)
        if not work_id:
            raise ValueError("A reading recommendation must identify a Work.")
        if self.rank < 1:
            raise ValueError("A reading recommendation rank must be positive.")
        if not rationale or any(not item for item in rationale):
            raise ValueError("A reading recommendation requires visible ranking rationales.")
        if len(rationale) > 8:
            raise ValueError("A reading recommendation can contain at most eight rationales.")
        if any(not item for item in evidence_segment_ids):
            raise ValueError("Recommendation evidence segment IDs cannot be empty.")
        if len(evidence_segment_ids) > 10:
            raise ValueError("A reading recommendation can link at most ten evidence segments.")
        if len(evidence_segment_ids) != len(set(evidence_segment_ids)):
            raise ValueError("Recommendation evidence segment IDs must be unique.")
        object.__setattr__(self, "work_id", work_id)
        object.__setattr__(self, "rationale", rationale)
        object.__setattr__(self, "evidence_segment_ids", evidence_segment_ids)


@dataclass(frozen=True, slots=True, kw_only=True)
class ReportDocument:
    id: str
    title: str
    generated_at: datetime
    citation_style: CitationStyle
    references: tuple[ReferenceRecord, ...]
    claims: tuple[Claim, ...]
    evidence_segments: tuple[EvidenceSegment, ...]
    evidence_links: tuple[ClaimEvidenceLink, ...]
    recommendations: tuple[ReadingRecommendation, ...] = ()

    def __post_init__(self) -> None:
        report_id = self.id.strip()
        title = self.title.strip()
        if not report_id or not title:
            raise ValueError("Report ID and title cannot be empty.")
        if self.generated_at.tzinfo is None or self.generated_at.utcoffset() is None:
            raise ValueError("Report generation time must include a UTC offset.")
        object.__setattr__(self, "id", report_id)
        object.__setattr__(self, "title", title)
        object.__setattr__(self, "generated_at", self.generated_at.astimezone(UTC))


class ReportIntegrityError(ValueError):
    pass


class UnsupportedClaimError(ReportIntegrityError):
    def __init__(self, claim_ids: tuple[str, ...]) -> None:
        self.claim_ids = claim_ids
        super().__init__(f"Sourced claims lack supporting evidence: {', '.join(claim_ids)}")
