from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from litehouse.application.schemas import (
    AccessPolicy,
    ImpactIntent,
    PreparedLiteratureWorkResponse,
    PreparedReviewResponse,
    RankingReceiptResponse,
    ReviewMetadataConflictResponse,
    ReviewScoreSignalsResponse,
    ReviewSourceErrorResponse,
    ReviewSourceReceiptResponse,
    WatchSpecification,
    WorkType,
)
from litehouse.domain import WorkKind
from litehouse.infrastructure.fetch import FetchReceipt
from litehouse.infrastructure.literature import (
    InclusionPolicy,
    LiteraturePipeline,
    PreparedReview,
    RankedLiteratureWork,
    RankingIntent,
    ReviewFilters,
)
from litehouse.infrastructure.sources import SourceSearchCoordinator

TRUTH_DISCLAIMER = (
    "Ranking signals prioritize discovery and reading order; they do not measure "
    "scientific truth or study quality."
)

_WORK_KIND_MAP: dict[WorkType, tuple[WorkKind, ...]] = {
    WorkType.JOURNAL_ARTICLE: (WorkKind.ARTICLE,),
    WorkType.BOOK: (WorkKind.BOOK,),
    WorkType.BOOK_CHAPTER: (WorkKind.CHAPTER,),
    WorkType.CONFERENCE_PAPER: (WorkKind.PROCEEDINGS_PAPER,),
    WorkType.PREPRINT: (WorkKind.PREPRINT,),
    WorkType.DATASET: (WorkKind.DATASET,),
    WorkType.THESIS: (WorkKind.THESIS,),
    WorkType.REPORT_STANDARD: (WorkKind.POLICY_DOCUMENT, WorkKind.STANDARD),
    WorkType.CREATIVE_WORK_CATALOGUE: (
        WorkKind.ARTWORK,
        WorkKind.EXHIBITION_CATALOGUE,
        WorkKind.PERFORMANCE,
        WorkKind.SCORE,
    ),
}

_RANKING_MAP: dict[ImpactIntent, RankingIntent] = {
    ImpactIntent.RECENT_ATTENTION: RankingIntent.RECENT_ATTENTION,
    ImpactIntent.FIELD_AGE_NORMALIZED_INFLUENCE: RankingIntent.AGE_NORMALIZED_INFLUENCE,
    ImpactIntent.SEMINAL_FIELD_FORMING: RankingIntent.SEMINAL,
    ImpactIntent.METHODOLOGICAL_RELEVANCE: RankingIntent.METHODOLOGICAL,
    ImpactIntent.BROAD_OPEN_COVERAGE: RankingIntent.BALANCED,
}


@dataclass(frozen=True, slots=True)
class ReviewPreparationBundle:
    prepared: PreparedReview
    source_receipts: tuple[FetchReceipt, ...]
    applied_intent: RankingIntent
    query_sha256: str


class ReviewPreparationService:
    def __init__(
        self,
        coordinator: SourceSearchCoordinator,
        *,
        pipeline: LiteraturePipeline | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._coordinator = coordinator
        self._pipeline = pipeline or LiteraturePipeline()
        self._clock = clock or (lambda: datetime.now(UTC))

    async def prepare(
        self,
        specification: WatchSpecification,
        *,
        max_results: int,
    ) -> PreparedReviewResponse:
        bundle = await self.prepare_internal(specification)
        prepared = bundle.prepared
        works = tuple(
            self._work_response(item) for item in prepared.ranked_works[:max_results]
        )
        receipts = tuple(
            ReviewSourceReceiptResponse(
                source=receipt.source,
                request_sha256=receipt.request_sha256,
                content_sha256=receipt.content_sha256,
            )
            for receipt in bundle.source_receipts
        )
        errors = tuple(
            ReviewSourceErrorResponse(
                source=error.source,
                code=error.code,
                message=error.message,
                retryable=error.retryable,
            )
            for error in prepared.source_errors
        )
        return PreparedReviewResponse(
            query_sha256=bundle.query_sha256,
            preparation_sha256=prepared.preparation_sha256,
            partial=prepared.partial,
            fetched_record_count=prepared.fetched_record_count,
            included_work_count=prepared.included_work_count,
            returned_work_count=len(works),
            excluded_access_count=prepared.excluded_access_count,
            excluded_filter_count=prepared.excluded_filter_count,
            excluded_without_evidence_count=prepared.excluded_without_evidence_count,
            source_receipts=receipts,
            source_errors=errors,
            ranking=RankingReceiptResponse(
                requested_intents=tuple(
                    intent.value for intent in specification.impact_intents
                ),
                applied_intent=bundle.applied_intent.value,
                truth_disclaimer=TRUTH_DISCLAIMER,
            ),
            works=works,
        )

    async def prepare_internal(
        self,
        specification: WatchSpecification,
    ) -> ReviewPreparationBundle:
        query = self._search_query(specification)
        selected_sources = tuple(source.value for source in specification.sources)
        batch = await self._coordinator.search_selected(query, sources=selected_sources)
        now = self._clock().astimezone(UTC)
        applied_intent = self._ranking_intent(specification)
        publication_to = specification.publication_to or now.date()
        publication_from = specification.publication_from or (
            publication_to - timedelta(days=specification.recency_days)
        )
        prepared = self._pipeline.prepare(
            batch,
            query=query,
            inclusion=self._inclusion_policy(specification),
            filters=ReviewFilters(
                from_date=publication_from,
                to_date=publication_to,
                languages=specification.languages,
                work_kinds=self._work_kinds(specification),
                exclusion_phrases=specification.exclusions,
            ),
            ranking_intent=applied_intent,
            now=now,
        )
        return ReviewPreparationBundle(
            prepared=prepared,
            source_receipts=tuple(
                result.receipt for result in batch.results if result.receipt is not None
            ),
            applied_intent=applied_intent,
            query_sha256=hashlib.sha256(query.encode()).hexdigest(),
        )

    @staticmethod
    def _search_query(specification: WatchSpecification) -> str:
        base = specification.query or " ".join(specification.topics)
        query = " ".join(part for part in (base, specification.scope) if part).strip()
        if not query or len(query) > 1000:
            raise ValueError("The bounded literature query must contain at most 1000 characters.")
        return query

    @staticmethod
    def _inclusion_policy(specification: WatchSpecification) -> InclusionPolicy:
        return InclusionPolicy(
            open_full_text=True,
            abstract_only=(
                specification.access_policy is AccessPolicy.INCLUDE_PAYWALLED_ABSTRACTS
            ),
            metadata_only=False,
            require_evidence_for_report=True,
        )

    @staticmethod
    def _work_kinds(specification: WatchSpecification) -> tuple[WorkKind, ...]:
        kinds: list[WorkKind] = []
        for work_type in specification.work_types:
            for kind in _WORK_KIND_MAP[work_type]:
                if kind not in kinds:
                    kinds.append(kind)
        return tuple(kinds)

    @staticmethod
    def _ranking_intent(specification: WatchSpecification) -> RankingIntent:
        if len(specification.impact_intents) != 1:
            return RankingIntent.BALANCED
        return _RANKING_MAP[specification.impact_intents[0]]

    @staticmethod
    def _work_response(item: RankedLiteratureWork) -> PreparedLiteratureWorkResponse:
        work = item.work
        scopes = tuple(sorted({segment.scope.value for segment in work.evidence_segments}))
        return PreparedLiteratureWorkResponse(
            rank=item.rank,
            score=item.score,
            identity_key=work.identity_key,
            title=work.work.title,
            kind=work.work.kind.value,
            identifiers={
                identifier.namespace: identifier.value for identifier in work.work.identifiers
            },
            contributors=tuple(
                contributor.name for contributor in work.work.contributors[:50]
            ),
            publication_date=work.publication_date,
            language=work.language,
            venue=work.venue,
            landing_url=work.landing_url,
            open_full_text_url=work.open_full_text_url,
            license_url=work.license_url,
            citation_count=work.citation_count,
            sources=work.sources,
            access_level=work.access_level.value,
            evidence_scopes=scopes,
            evidence_sha256=tuple(
                segment.sha256 for segment in work.evidence_segments
            ),
            full_text_inspected=False,
            matched_fields=work.matched_fields,
            conflicts=tuple(
                ReviewMetadataConflictResponse(
                    field=conflict.field_name,
                    values=conflict.values,
                    sources=conflict.sources,
                )
                for conflict in work.conflicts
            ),
            signals=ReviewScoreSignalsResponse(
                query_relevance=item.signals.query_relevance,
                recency=item.signals.recency,
                cohort_influence_percentile=item.signals.cohort_influence_percentile,
                methodological_signal=item.signals.methodological_signal,
                metadata_corroboration=item.signals.metadata_corroboration,
                access=item.signals.access,
            ),
            ranking_explanation=item.explanation,
        )
