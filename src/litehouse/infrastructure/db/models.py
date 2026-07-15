from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from litehouse.domain import ClaimEvidenceRelation, ClaimKind, EvidenceScope, RunStatus, WorkKind
from litehouse.infrastructure.vault.models import AnnotationKind, ArtifactKind, LibraryItemKind


def _enum_values(enum_type: type[object]) -> str:
    return ", ".join(f"'{member.value}'" for member in enum_type)  # type: ignore[attr-defined]


class Base(DeclarativeBase):
    pass


class WorkModel(Base):
    __tablename__ = "works"
    __table_args__ = (
        CheckConstraint(f"kind IN ({_enum_values(WorkKind)})", name="ck_works_kind"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)


class WorkIdentifierModel(Base):
    __tablename__ = "work_identifiers"
    __table_args__ = (
        UniqueConstraint("namespace", "value", name="uq_work_identifier_namespace_value"),
    )

    work_id: Mapped[str] = mapped_column(
        ForeignKey("works.id", ondelete="CASCADE"), primary_key=True
    )
    namespace: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, primary_key=True)


class ContributorModel(Base):
    __tablename__ = "contributors"
    __table_args__ = (CheckConstraint("position >= 0", name="ck_contributors_position"),)

    work_id: Mapped[str] = mapped_column(
        ForeignKey("works.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(64), nullable=False)


class WatchModel(Base):
    __tablename__ = "watches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    active_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("watch_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class WatchRevisionModel(Base):
    __tablename__ = "watch_revisions"
    __table_args__ = (
        UniqueConstraint("watch_id", "revision_number", name="uq_watch_revision_number"),
        CheckConstraint("revision_number >= 1", name="ck_watch_revision_number"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    watch_id: Mapped[str] = mapped_column(
        ForeignKey("watches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False)
    specification_json: Mapped[str] = mapped_column(Text, nullable=False)
    specification_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class RunModel(Base):
    __tablename__ = "runs"
    __table_args__ = (
        UniqueConstraint(
            "watch_revision_id", "scheduled_at", name="uq_run_revision_scheduled_at"
        ),
        CheckConstraint(f"status IN ({_enum_values(RunStatus)})", name="ck_runs_status"),
        CheckConstraint(
            "attempt_count >= 0 AND artifact_count >= 0 AND source_error_count >= 0",
            name="ck_runs_counters",
        ),
        CheckConstraint(
            "result_sha256 IS NULL OR (length(result_sha256) = 64 "
            "AND result_sha256 = lower(result_sha256) "
            "AND result_sha256 NOT GLOB '*[^0-9a-f]*')",
            name="ck_runs_result_sha256",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    watch_revision_id: Mapped[str] = mapped_column(
        ForeignKey("watch_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    report_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    result_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    artifact_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_error_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)


class MetadataAssertionModel(Base):
    __tablename__ = "metadata_assertions"
    __table_args__ = (
        UniqueConstraint(
            "work_id",
            "field_name",
            "source",
            "source_record_id",
            "value_json",
            name="uq_metadata_assertion_source_value",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    work_id: Mapped[str] = mapped_column(
        ForeignKey("works.id", ondelete="CASCADE"), nullable=False, index=True
    )
    field_name: Mapped[str] = mapped_column(String(128), nullable=False)
    value_json: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(128), nullable=False)
    source_record_id: Mapped[str] = mapped_column(Text, nullable=False)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class EvidenceSegmentModel(Base):
    __tablename__ = "evidence_segments"
    __table_args__ = (
        CheckConstraint(
            f"scope IN ({_enum_values(EvidenceScope)})", name="ck_evidence_segments_scope"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    work_id: Mapped[str] = mapped_column(
        ForeignKey("works.id", ondelete="CASCADE"), nullable=False, index=True
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    locator: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)


class ClaimModel(Base):
    __tablename__ = "claims"
    __table_args__ = (
        CheckConstraint(f"kind IN ({_enum_values(ClaimKind)})", name="ck_claims_kind"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    report_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)


class ClaimEvidenceLinkModel(Base):
    __tablename__ = "claim_evidence_links"
    __table_args__ = (
        CheckConstraint(
            f"relation IN ({_enum_values(ClaimEvidenceRelation)})",
            name="ck_claim_evidence_links_relation",
        ),
    )

    claim_id: Mapped[str] = mapped_column(
        ForeignKey("claims.id", ondelete="CASCADE"), primary_key=True
    )
    evidence_segment_id: Mapped[str] = mapped_column(
        ForeignKey("evidence_segments.id", ondelete="CASCADE"), primary_key=True
    )
    relation: Mapped[str] = mapped_column(String(24), nullable=False)


class LibraryItemModel(Base):
    __tablename__ = "library_items"
    __table_args__ = (
        CheckConstraint(
            f"item_kind IN ({_enum_values(LibraryItemKind)})",
            name="ck_library_items_kind",
        ),
        CheckConstraint("length(trim(title)) > 0", name="ck_library_items_title"),
        CheckConstraint(
            "length(identity_sha256) = 64 AND identity_sha256 = lower(identity_sha256) "
            "AND identity_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_library_items_identity_sha256",
        ),
        UniqueConstraint("work_id", name="uq_library_items_work_id"),
        UniqueConstraint("identity_sha256", name="uq_library_items_identity_sha256"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    work_id: Mapped[str | None] = mapped_column(
        ForeignKey("works.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    item_kind: Mapped[str] = mapped_column(String(24), nullable=False)
    identity_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class VaultArtifactModel(Base):
    __tablename__ = "vault_artifacts"
    __table_args__ = (
        CheckConstraint(
            f"artifact_kind IN ({_enum_values(ArtifactKind)})",
            name="ck_vault_artifacts_kind",
        ),
        CheckConstraint("size >= 0", name="ck_vault_artifacts_size"),
        CheckConstraint(
            "length(trim(media_type)) > 0", name="ck_vault_artifacts_media_type"
        ),
        CheckConstraint(
            "length(relative_path) > 0", name="ck_vault_artifacts_relative_path"
        ),
        CheckConstraint(
            "length(sha256) = 64 AND sha256 = lower(sha256) "
            "AND sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_vault_artifacts_sha256",
        ),
        CheckConstraint(
            "length(provenance_sha256) = 64 AND provenance_sha256 = lower(provenance_sha256) "
            "AND provenance_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_vault_artifacts_provenance_sha256",
        ),
        CheckConstraint(
            "source_receipt_sha256 IS NULL OR (length(source_receipt_sha256) = 64 "
            "AND source_receipt_sha256 = lower(source_receipt_sha256) "
            "AND source_receipt_sha256 NOT GLOB '*[^0-9a-f]*')",
            name="ck_vault_artifacts_source_receipt_sha256",
        ),
        UniqueConstraint(
            "library_item_id",
            "artifact_kind",
            "sha256",
            "provenance_sha256",
            name="uq_vault_artifact_identity",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    library_item_id: Mapped[str] = mapped_column(
        ForeignKey("library_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    artifact_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    media_type: Mapped[str] = mapped_column(String(255), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    source_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    license_expression: Mapped[str | None] = mapped_column(Text, nullable=True)
    license_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_receipt_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provenance_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ReadingProgressModel(Base):
    __tablename__ = "reading_progress"
    __table_args__ = (
        CheckConstraint(
            "position_fraction >= 0 AND position_fraction <= 1",
            name="ck_reading_progress_fraction",
        ),
        CheckConstraint(
            "page_number IS NULL OR page_number >= 1",
            name="ck_reading_progress_page_number",
        ),
        CheckConstraint(
            "page_count IS NULL OR page_count >= 1",
            name="ck_reading_progress_page_count",
        ),
        CheckConstraint(
            "page_number IS NULL OR page_count IS NULL OR page_number <= page_count",
            name="ck_reading_progress_page_range",
        ),
        CheckConstraint(
            "length(locator_json) > 0", name="ck_reading_progress_locator_json"
        ),
    )

    artifact_id: Mapped[str] = mapped_column(
        ForeignKey("vault_artifacts.id", ondelete="CASCADE"), primary_key=True
    )
    position_fraction: Mapped[float] = mapped_column(nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    locator_json: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AnnotationModel(Base):
    __tablename__ = "annotations"
    __table_args__ = (
        CheckConstraint(
            f"annotation_kind IN ({_enum_values(AnnotationKind)})",
            name="ck_annotations_kind",
        ),
        CheckConstraint(
            "length(trim(body)) > 0 OR length(trim(COALESCE(quote_text, ''))) > 0",
            name="ck_annotations_content",
        ),
        CheckConstraint(
            "page_number IS NULL OR page_number >= 1", name="ck_annotations_page_number"
        ),
        CheckConstraint("length(anchor_json) > 0", name="ck_annotations_anchor_json"),
        CheckConstraint(
            "length(content_sha256) = 64 AND content_sha256 = lower(content_sha256) "
            "AND content_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_annotations_content_sha256",
        ),
        CheckConstraint(
            "length(idempotency_key) >= 1 AND length(idempotency_key) <= 128",
            name="ck_annotations_idempotency_key",
        ),
        UniqueConstraint("idempotency_key", name="uq_annotations_idempotency_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    library_item_id: Mapped[str] = mapped_column(
        ForeignKey("library_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    artifact_id: Mapped[str | None] = mapped_column(
        ForeignKey("vault_artifacts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    annotation_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    quote_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    anchor_json: Mapped[str] = mapped_column(Text, nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class TagModel(Base):
    __tablename__ = "tags"
    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="ck_tags_name"),
        CheckConstraint("length(normalized_name) > 0", name="ck_tags_normalized_name"),
        UniqueConstraint("normalized_name", name="uq_tags_normalized_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_name: Mapped[str] = mapped_column(Text, nullable=False)


class LibraryItemTagModel(Base):
    __tablename__ = "library_item_tags"

    library_item_id: Mapped[str] = mapped_column(
        ForeignKey("library_items.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[str] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )


class CollectionModel(Base):
    __tablename__ = "collections"
    __table_args__ = (
        CheckConstraint("length(trim(name)) > 0", name="ck_collections_name"),
        CheckConstraint(
            "length(normalized_name) > 0", name="ck_collections_normalized_name"
        ),
        UniqueConstraint("normalized_name", name="uq_collections_normalized_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CollectionItemModel(Base):
    __tablename__ = "collection_items"

    collection_id: Mapped[str] = mapped_column(
        ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True
    )
    library_item_id: Mapped[str] = mapped_column(
        ForeignKey("library_items.id", ondelete="CASCADE"), primary_key=True
    )


class ReportIntegrityManifestModel(Base):
    __tablename__ = "report_integrity_manifests"
    __table_args__ = (
        UniqueConstraint(
            "report_artifact_id", name="uq_report_integrity_manifests_artifact_id"
        ),
        CheckConstraint(
            "length(artifact_sha256) = 64 AND artifact_sha256 = lower(artifact_sha256) "
            "AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_report_integrity_artifact_sha256",
        ),
        CheckConstraint(
            "length(manifest_sha256) = 64 AND manifest_sha256 = lower(manifest_sha256) "
            "AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_report_integrity_manifest_sha256",
        ),
        CheckConstraint(
            "template_sha256 IS NULL OR (length(template_sha256) = 64 "
            "AND template_sha256 = lower(template_sha256) "
            "AND template_sha256 NOT GLOB '*[^0-9a-f]*')",
            name="ck_report_integrity_template_sha256",
        ),
        CheckConstraint(
            "logo_sha256 IS NULL OR (length(logo_sha256) = 64 "
            "AND logo_sha256 = lower(logo_sha256) "
            "AND logo_sha256 NOT GLOB '*[^0-9a-f]*')",
            name="ck_report_integrity_logo_sha256",
        ),
        CheckConstraint(
            "generator_version_sha256 IS NULL OR (length(generator_version_sha256) = 64 "
            "AND generator_version_sha256 = lower(generator_version_sha256) "
            "AND generator_version_sha256 NOT GLOB '*[^0-9a-f]*')",
            name="ck_report_integrity_generator_version_sha256",
        ),
        CheckConstraint(
            "generation_settings_sha256 IS NULL OR (length(generation_settings_sha256) = 64 "
            "AND generation_settings_sha256 = lower(generation_settings_sha256) "
            "AND generation_settings_sha256 NOT GLOB '*[^0-9a-f]*')",
            name="ck_report_integrity_generation_settings_sha256",
        ),
        CheckConstraint(
            "length(input_hashes_json) > 0 AND length(evidence_hashes_json) > 0 "
            "AND length(source_receipt_hashes_json) > 0 AND length(manifest_json) > 0",
            name="ck_report_integrity_json_payloads",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    report_artifact_id: Mapped[str] = mapped_column(
        ForeignKey("vault_artifacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    artifact_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    input_hashes_json: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_hashes_json: Mapped[str] = mapped_column(Text, nullable=False)
    source_receipt_hashes_json: Mapped[str] = mapped_column(Text, nullable=False)
    template_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    logo_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    generator_version_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    generation_settings_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manifest_json: Mapped[str] = mapped_column(Text, nullable=False)
    manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
