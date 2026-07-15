from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.triggers.cron import CronTrigger  # type: ignore[import-untyped]
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from litehouse.domain import Run, Watch, WatchRevision

if TYPE_CHECKING:
    from litehouse.application.reporting import ReportGenerationReceipt

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
TopicText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
LanguageTag = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        pattern=r"^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$",
    ),
]


class ResearchField(StrEnum):
    HUMANITIES = "humanities"
    ARTS = "arts"
    SOCIAL_SCIENCES = "social_sciences"
    NATURAL_SCIENCES = "natural_sciences"
    LIFE_SCIENCES = "life_sciences"
    MEDICINE_HEALTH = "medicine_health"
    ENGINEERING_TECHNOLOGY = "engineering_technology"
    MATHEMATICS_STATISTICS = "mathematics_statistics"
    LAW_POLICY = "law_policy"
    INTERDISCIPLINARY = "interdisciplinary"
    OTHER = "other"


class ExpertiseLevel(StrEnum):
    SECONDARY = "secondary"
    UNDERGRADUATE = "undergraduate"
    MASTERS = "masters"
    DOCTORAL = "doctoral"
    POSTDOCTORAL = "postdoctoral"
    FACULTY = "faculty"
    PROFESSIONAL = "professional"
    INDEPENDENT_RESEARCHER = "independent_researcher"


class LiteratureSource(StrEnum):
    OPENALEX = "openalex"
    CROSSREF = "crossref"
    EUROPE_PMC = "europe_pmc"
    SEMANTIC_SCHOLAR = "semantic_scholar"
    LIBRARY_OF_CONGRESS = "library_of_congress"
    DATACITE = "datacite"


class IntervalUnit(StrEnum):
    MINUTES = "minutes"
    HOURS = "hours"
    DAYS = "days"
    WEEKS = "weeks"


class WorkType(StrEnum):
    JOURNAL_ARTICLE = "journal_article"
    BOOK = "book"
    BOOK_CHAPTER = "book_chapter"
    CONFERENCE_PAPER = "conference_paper"
    PREPRINT = "preprint"
    DATASET = "dataset"
    THESIS = "thesis"
    REPORT_STANDARD = "report_standard"
    CREATIVE_WORK_CATALOGUE = "creative_work_catalogue"


class AccessPolicy(StrEnum):
    OPEN_FULL_TEXT_ONLY = "open_full_text_only"
    INCLUDE_PAYWALLED_ABSTRACTS = "include_paywalled_abstracts"


class ImpactIntent(StrEnum):
    RECENT_ATTENTION = "recent_attention"
    FIELD_AGE_NORMALIZED_INFLUENCE = "field_age_normalized_influence"
    SEMINAL_FIELD_FORMING = "seminal_field_forming"
    METHODOLOGICAL_RELEVANCE = "methodological_relevance"
    BROAD_OPEN_COVERAGE = "broad_open_coverage"


class ReportDepth(StrEnum):
    BRIEF = "brief"
    STANDARD = "standard"
    DEEP = "deep"


class ReportOutputFormat(StrEnum):
    MARKDOWN = "markdown"
    PLAIN_TEXT = "plain_text"
    LATEX_PDF = "latex_pdf"


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ExpertiseProfile(ContractModel):
    ordered_levels: tuple[ExpertiseLevel, ...] = Field(min_length=1, max_length=8)
    prior_knowledge: str = Field(default="", max_length=4000)

    @field_validator("ordered_levels")
    @classmethod
    def unique_levels(
        cls,
        values: tuple[ExpertiseLevel, ...],
    ) -> tuple[ExpertiseLevel, ...]:
        if len(set(values)) != len(values):
            raise ValueError("Expertise selections must be unique.")
        return values

    @field_validator("prior_knowledge")
    @classmethod
    def trim_prior_knowledge(cls, value: str) -> str:
        return value.strip()


class IntervalSchedule(ContractModel):
    kind: Literal["interval"]
    every: int = Field(ge=1, le=10080)
    unit: IntervalUnit
    start_at: AwareDatetime


class CronSchedule(ContractModel):
    kind: Literal["cron"]
    expression: str = Field(min_length=9, max_length=120)

    @field_validator("expression")
    @classmethod
    def valid_crontab(cls, value: str) -> str:
        normalized = " ".join(value.split())
        try:
            CronTrigger.from_crontab(normalized, timezone="UTC")
        except ValueError:
            raise ValueError("Cron expression must contain five valid fields.") from None
        return normalized


Schedule = Annotated[IntervalSchedule | CronSchedule, Field(discriminator="kind")]


class WatchSpecification(ContractModel):
    topics: tuple[TopicText, ...] = Field(default=(), max_length=30)
    query: str | None = Field(default=None, max_length=1000)
    scope: str = Field(default="", max_length=4000)
    exclusions: tuple[TopicText, ...] = Field(default=(), max_length=30)
    fields: tuple[ResearchField, ...] = Field(min_length=1, max_length=11)
    languages: tuple[LanguageTag, ...] = Field(default=("en",), min_length=1, max_length=20)
    work_types: tuple[WorkType, ...] = Field(
        default=(WorkType.JOURNAL_ARTICLE,),
        min_length=1,
        max_length=9,
    )
    expertise: ExpertiseProfile
    timezone: str = Field(min_length=1, max_length=64)
    schedule: Schedule
    recency_days: int = Field(default=7, ge=1, le=3650)
    publication_from: date | None = None
    publication_to: date | None = None
    citation_style: str = Field(
        default="apa-7th-edition",
        min_length=1,
        max_length=80,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9 ._/-]*$",
    )
    sources: tuple[LiteratureSource, ...] = Field(min_length=1, max_length=6)
    access_policy: AccessPolicy = AccessPolicy.OPEN_FULL_TEXT_ONLY
    impact_intents: tuple[ImpactIntent, ...] = Field(
        default=(
            ImpactIntent.RECENT_ATTENTION,
            ImpactIntent.FIELD_AGE_NORMALIZED_INFLUENCE,
        ),
        min_length=1,
        max_length=5,
    )
    report_depth: ReportDepth = ReportDepth.STANDARD
    include_recommendations: bool = True
    output_formats: tuple[ReportOutputFormat, ...] = Field(
        default=(ReportOutputFormat.MARKDOWN,),
        min_length=1,
        max_length=3,
    )

    @field_validator("topics", "exclusions")
    @classmethod
    def unique_topic_terms(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len({value.casefold() for value in values}) != len(values):
            raise ValueError("Topic terms must be unique.")
        return values

    @field_validator("scope")
    @classmethod
    def trim_scope(cls, value: str) -> str:
        return value.strip()

    @field_validator("query")
    @classmethod
    def trim_query(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator(
        "fields",
        "languages",
        "work_types",
        "sources",
        "impact_intents",
        "output_formats",
    )
    @classmethod
    def unique_selections[T](cls, values: tuple[T, ...]) -> tuple[T, ...]:
        if len(set(values)) != len(values):
            raise ValueError("Selections must be unique.")
        return values

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError:
            raise ValueError("Timezone must be a valid IANA name.") from None
        return value

    @model_validator(mode="after")
    def requires_search_intent(self) -> WatchSpecification:
        if not self.topics and self.query is None:
            raise ValueError("At least one topic or a query is required.")
        if (
            self.publication_from is not None
            and self.publication_to is not None
            and self.publication_from > self.publication_to
        ):
            raise ValueError("Publication start date cannot be after the end date.")
        return self

    def canonical_payload(self) -> dict[str, object]:
        return self.model_dump(mode="json", exclude_none=True)


class CreateWatchRequest(ContractModel):
    name: ShortText
    specification: WatchSpecification
    enabled: bool = True


class ReviseWatchRequest(ContractModel):
    base_revision_number: int = Field(ge=1)
    specification: WatchSpecification


class QueueRunRequest(ContractModel):
    scheduled_at: AwareDatetime | None = None


class WatchRevisionResponse(ContractModel):
    id: str
    number: int
    specification_sha256: str
    created_at: datetime
    specification: WatchSpecification

    @classmethod
    def from_domain(cls, revision: WatchRevision) -> WatchRevisionResponse:
        return cls(
            id=revision.id,
            number=revision.revision_number,
            specification_sha256=revision.specification_sha256,
            created_at=revision.created_at,
            specification=WatchSpecification.model_validate(revision.specification),
        )


class WatchResponse(ContractModel):
    id: str
    name: str
    enabled: bool
    created_at: datetime
    active_revision: WatchRevisionResponse

    @classmethod
    def from_domain(cls, watch: Watch) -> WatchResponse:
        return cls(
            id=watch.id,
            name=watch.name,
            enabled=watch.enabled,
            created_at=watch.created_at,
            active_revision=WatchRevisionResponse.from_domain(watch.active_revision),
        )


class RunResponse(ContractModel):
    id: str
    watch_revision_id: str
    status: str
    scheduled_at: datetime
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    attempt_count: int = Field(ge=0)
    report_id: str | None
    result_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    artifact_count: int = Field(ge=0)
    source_error_count: int = Field(ge=0)

    @classmethod
    def from_domain(cls, run: Run) -> RunResponse:
        return cls(
            id=run.id,
            watch_revision_id=run.watch_revision_id,
            status=run.status.value,
            scheduled_at=run.scheduled_at,
            created_at=run.created_at,
            started_at=run.started_at,
            finished_at=run.finished_at,
            attempt_count=run.attempt_count,
            report_id=run.report_id,
            result_sha256=run.result_sha256,
            artifact_count=run.artifact_count,
            source_error_count=run.source_error_count,
        )


class QueuedRunResponse(ContractModel):
    run: RunResponse
    created: bool


class PrepareReviewRequest(ContractModel):
    specification: WatchSpecification
    max_results: int = Field(default=25, ge=1, le=100)


class GenerateReportRequest(ContractModel):
    specification: WatchSpecification
    max_results: int = Field(default=25, ge=1, le=100)


class ReviewSourceReceiptResponse(ContractModel):
    source: str
    request_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    content_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class ReviewSourceErrorResponse(ContractModel):
    source: str
    code: str
    message: str
    retryable: bool


class ReviewMetadataConflictResponse(ContractModel):
    field: str
    values: tuple[str, ...]
    sources: tuple[str, ...]


class ReviewScoreSignalsResponse(ContractModel):
    query_relevance: float = Field(ge=0, le=1)
    recency: float = Field(ge=0, le=1)
    cohort_influence_percentile: float = Field(ge=0, le=1)
    methodological_signal: float = Field(ge=0, le=1)
    metadata_corroboration: float = Field(ge=0, le=1)
    access: float = Field(ge=0, le=1)


class PreparedLiteratureWorkResponse(ContractModel):
    rank: int = Field(ge=1)
    score: float = Field(ge=0, le=1)
    identity_key: str
    title: str
    kind: str
    identifiers: dict[str, str]
    contributors: tuple[str, ...]
    publication_date: date | None
    language: str | None
    venue: str | None
    landing_url: str | None
    open_full_text_url: str | None
    license_url: str | None
    citation_count: int | None = Field(default=None, ge=0)
    sources: tuple[str, ...]
    access_level: str
    evidence_scopes: tuple[str, ...]
    evidence_sha256: tuple[str, ...]
    full_text_inspected: bool = False
    matched_fields: tuple[str, ...]
    conflicts: tuple[ReviewMetadataConflictResponse, ...]
    signals: ReviewScoreSignalsResponse
    ranking_explanation: tuple[str, ...]


class RankingReceiptResponse(ContractModel):
    requested_intents: tuple[str, ...]
    applied_intent: str
    truth_disclaimer: str


class PreparedReviewResponse(ContractModel):
    query_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    preparation_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    partial: bool
    fetched_record_count: int = Field(ge=0)
    included_work_count: int = Field(ge=0)
    returned_work_count: int = Field(ge=0)
    excluded_access_count: int = Field(ge=0)
    excluded_filter_count: int = Field(ge=0)
    excluded_without_evidence_count: int = Field(ge=0)
    source_receipts: tuple[ReviewSourceReceiptResponse, ...]
    source_errors: tuple[ReviewSourceErrorResponse, ...]
    ranking: RankingReceiptResponse
    works: tuple[PreparedLiteratureWorkResponse, ...]


class GeneratedReportArtifactResponse(ContractModel):
    output_format: str
    artifact_id: str
    artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size: int = Field(ge=0)
    manifest_id: str | None
    manifest_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class GeneratedReportSourceErrorResponse(ContractModel):
    source: str
    code: str
    retryable: bool


class GeneratedReportResponse(ContractModel):
    report_id: str
    report_document_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    preparation_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    specification_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    result_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    generated_at: datetime
    partial: bool
    synthesis_status: str
    requested_citation_style: str
    applied_citation_style: str
    work_count: int = Field(ge=0, le=100)
    claim_count: int = Field(ge=0, le=100)
    recommendation_count: int = Field(ge=0, le=10)
    abstract_evidence_count: int = Field(ge=0, le=50)
    full_text_evidence_count: int = Field(ge=0, le=50)
    source_receipt_sha256: tuple[str, ...] = Field(max_length=12)
    source_evidence_sha256: tuple[str, ...] = Field(max_length=50)
    evidence_excerpt_sha256: tuple[str, ...] = Field(max_length=50)
    artifacts: tuple[GeneratedReportArtifactResponse, ...] = Field(max_length=6)
    source_errors: tuple[GeneratedReportSourceErrorResponse, ...] = Field(max_length=6)
    format_errors: tuple[str, ...] = Field(max_length=3)

    @classmethod
    def from_receipt(cls, receipt: ReportGenerationReceipt) -> GeneratedReportResponse:
        return cls(
            report_id=receipt.report_id,
            report_document_sha256=receipt.report_document_sha256,
            preparation_sha256=receipt.preparation_sha256,
            specification_sha256=receipt.specification_sha256,
            result_sha256=receipt.result_sha256,
            generated_at=receipt.generated_at,
            partial=receipt.partial,
            synthesis_status=receipt.synthesis_status,
            requested_citation_style=receipt.requested_citation_style,
            applied_citation_style=receipt.applied_citation_style,
            work_count=receipt.work_count,
            claim_count=receipt.claim_count,
            recommendation_count=receipt.recommendation_count,
            abstract_evidence_count=receipt.abstract_evidence_count,
            full_text_evidence_count=receipt.full_text_evidence_count,
            source_receipt_sha256=receipt.source_receipt_sha256,
            source_evidence_sha256=receipt.source_evidence_sha256,
            evidence_excerpt_sha256=receipt.evidence_excerpt_sha256,
            artifacts=tuple(
                GeneratedReportArtifactResponse(
                    output_format=artifact.output_format,
                    artifact_id=artifact.artifact_id,
                    artifact_sha256=artifact.artifact_sha256,
                    size=artifact.size,
                    manifest_id=artifact.manifest_id,
                    manifest_sha256=artifact.manifest_sha256,
                )
                for artifact in receipt.artifacts
            ),
            source_errors=tuple(
                GeneratedReportSourceErrorResponse(
                    source=error.source,
                    code=error.code,
                    retryable=error.retryable,
                )
                for error in receipt.source_errors
            ),
            format_errors=receipt.format_errors,
        )
