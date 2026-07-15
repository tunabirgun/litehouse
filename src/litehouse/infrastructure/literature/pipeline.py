from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime

from litehouse.domain import WorkKind, canonical_json
from litehouse.infrastructure.fetch.models import FetchResult
from litehouse.infrastructure.literature.models import (
    AccessLevel,
    CanonicalLiteratureWork,
    LiteratureRecord,
)
from litehouse.infrastructure.literature.parsers import LiteratureParseError, parse_source_result
from litehouse.infrastructure.literature.ranking import (
    RankedLiteratureWork,
    RankingIntent,
    rank_literature,
)
from litehouse.infrastructure.literature.reconcile import reconcile_records
from litehouse.infrastructure.sources.search import SourceSearchBatch


@dataclass(frozen=True, slots=True)
class InclusionPolicy:
    open_full_text: bool = True
    abstract_only: bool = False
    metadata_only: bool = False
    require_evidence_for_report: bool = True

    def __post_init__(self) -> None:
        if not (self.open_full_text or self.abstract_only or self.metadata_only):
            raise ValueError("At least one literature access level must be included.")

    def includes(self, access_level: AccessLevel) -> bool:
        return {
            AccessLevel.OPEN_FULL_TEXT: self.open_full_text,
            AccessLevel.ABSTRACT_ONLY: self.abstract_only,
            AccessLevel.METADATA_ONLY: self.metadata_only,
        }[access_level]


@dataclass(frozen=True, slots=True)
class ReviewFilters:
    from_date: date | None = None
    to_date: date | None = None
    languages: tuple[str, ...] = ()
    work_kinds: tuple[WorkKind, ...] = ()
    exclusion_phrases: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.from_date and self.to_date and self.from_date > self.to_date:
            raise ValueError("Review start date cannot be later than its end date.")
        languages = tuple(
            language.strip().casefold() for language in self.languages if language.strip()
        )
        exclusions = tuple(phrase.strip() for phrase in self.exclusion_phrases if phrase.strip())
        if len(set(languages)) != len(languages) or len(set(exclusions)) != len(exclusions):
            raise ValueError("Review filters must be unique.")
        object.__setattr__(self, "languages", languages)
        object.__setattr__(self, "exclusion_phrases", exclusions)

    def includes(self, work: CanonicalLiteratureWork) -> bool:
        if self.from_date and work.publication_date and work.publication_date < self.from_date:
            return False
        if self.to_date and work.publication_date and work.publication_date > self.to_date:
            return False
        if self.languages and work.language and work.language.casefold() not in self.languages:
            return False
        if self.work_kinds and work.work.kind not in self.work_kinds:
            return False
        searchable = unicodedata.normalize(
            "NFKC", f"{work.work.title} {work.abstract or ''}"
        ).casefold()
        return not any(
            unicodedata.normalize("NFKC", phrase).casefold() in searchable
            for phrase in self.exclusion_phrases
        )


@dataclass(frozen=True, slots=True)
class SourceProcessingError:
    source: str
    code: str
    message: str
    retryable: bool


@dataclass(frozen=True, slots=True)
class PreparedReview:
    query: str
    ranked_works: tuple[RankedLiteratureWork, ...]
    source_errors: tuple[SourceProcessingError, ...]
    fetched_record_count: int
    included_work_count: int
    excluded_access_count: int
    excluded_filter_count: int
    excluded_without_evidence_count: int
    preparation_sha256: str

    @property
    def partial(self) -> bool:
        return bool(self.source_errors)


class LiteraturePipeline:
    def prepare(
        self,
        batch: SourceSearchBatch,
        *,
        query: str,
        inclusion: InclusionPolicy | None = None,
        filters: ReviewFilters | None = None,
        ranking_intent: RankingIntent = RankingIntent.BALANCED,
        now: datetime | None = None,
    ) -> PreparedReview:
        if not query.strip():
            raise ValueError("A query is required to prepare a literature review.")
        policy = inclusion or InclusionPolicy()
        active_filters = filters or ReviewFilters()
        records: list[LiteratureRecord] = []
        errors: list[SourceProcessingError] = []
        for result in batch.results:
            if not result.accepted:
                errors.append(self._fetch_error(result))
                continue
            try:
                records.extend(parse_source_result(result))
            except LiteratureParseError:
                source = result.receipt.source if result.receipt else "unknown"
                errors.append(
                    SourceProcessingError(
                        source=source,
                        code="source_schema_invalid",
                        message="The source response could not be normalized safely.",
                        retryable=False,
                    )
                )
        reconciled = reconcile_records(records)
        review_filtered = tuple(work for work in reconciled if active_filters.includes(work))
        access_filtered = tuple(
            work for work in review_filtered if policy.includes(work.access_level)
        )
        evidence_filtered = tuple(
            work
            for work in access_filtered
            if not policy.require_evidence_for_report or work.evidence_segments
        )
        ranked = rank_literature(
            evidence_filtered,
            query=query,
            intent=ranking_intent,
            now=now,
        )
        preparation_payload = {
            "query": query.strip(),
            "ranking_intent": ranking_intent.value,
            "inclusion": {
                "open_full_text": policy.open_full_text,
                "abstract_only": policy.abstract_only,
                "metadata_only": policy.metadata_only,
                "require_evidence_for_report": policy.require_evidence_for_report,
            },
            "filters": {
                "from_date": active_filters.from_date.isoformat()
                if active_filters.from_date
                else None,
                "to_date": active_filters.to_date.isoformat() if active_filters.to_date else None,
                "languages": list(active_filters.languages),
                "work_kinds": [kind.value for kind in active_filters.work_kinds],
                "exclusion_phrases": list(active_filters.exclusion_phrases),
            },
            "source_responses": [
                {
                    "source": result.receipt.source,
                    "content_sha256": result.receipt.content_sha256,
                    "request_sha256": result.receipt.request_sha256,
                }
                if result.receipt
                else {
                    "source": result.error.source if result.error else "unknown",
                    "error_code": result.error.code if result.error else "invalid",
                }
                for result in batch.results
            ],
            "ranked_works": [
                {
                    "identity_key": ranked_work.work.identity_key,
                    "rank": ranked_work.rank,
                    "score": ranked_work.score,
                    "evidence_sha256": [
                        segment.sha256 for segment in ranked_work.work.evidence_segments
                    ],
                }
                for ranked_work in ranked
            ],
        }
        preparation_sha256 = hashlib.sha256(
            canonical_json(preparation_payload).encode()
        ).hexdigest()
        return PreparedReview(
            query=query.strip(),
            ranked_works=ranked,
            source_errors=tuple(errors),
            fetched_record_count=len(records),
            included_work_count=len(evidence_filtered),
            excluded_access_count=len(review_filtered) - len(access_filtered),
            excluded_filter_count=len(reconciled) - len(review_filtered),
            excluded_without_evidence_count=len(access_filtered) - len(evidence_filtered),
            preparation_sha256=preparation_sha256,
        )

    @staticmethod
    def _fetch_error(result: FetchResult) -> SourceProcessingError:
        if result.error is None:
            return SourceProcessingError(
                source="unknown",
                code="source_result_invalid",
                message="The source returned no accepted response.",
                retryable=False,
            )
        return SourceProcessingError(
            source=result.error.source,
            code=result.error.code,
            message=result.error.message,
            retryable=result.error.retryable,
        )
