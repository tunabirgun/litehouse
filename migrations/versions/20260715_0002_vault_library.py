from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260715_0002"
down_revision: str | None = "20260715_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _optional_sha256(name: str) -> str:
    return (
        f"{name} IS NULL OR (length({name}) = 64 AND {name} = lower({name}) "
        f"AND {name} NOT GLOB '*[^0-9a-f]*')"
    )


def upgrade() -> None:
    op.create_table(
        "library_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("work_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("item_kind", sa.String(length=24), nullable=False),
        sa.Column("identity_sha256", sa.String(length=64), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "item_kind IN ('work', 'report', 'notebook', 'collection', 'import', 'other')",
            name="ck_library_items_kind",
        ),
        sa.CheckConstraint(
            "length(identity_sha256) = 64 AND identity_sha256 = lower(identity_sha256) "
            "AND identity_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_library_items_identity_sha256",
        ),
        sa.CheckConstraint("length(trim(title)) > 0", name="ck_library_items_title"),
        sa.ForeignKeyConstraint(["work_id"], ["works.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("identity_sha256", name="uq_library_items_identity_sha256"),
        sa.UniqueConstraint("work_id", name="uq_library_items_work_id"),
    )
    op.create_index("ix_library_items_work_id", "library_items", ["work_id"])
    op.create_table(
        "vault_artifacts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("library_item_id", sa.String(length=36), nullable=False),
        sa.Column("artifact_kind", sa.String(length=32), nullable=False),
        sa.Column("media_type", sa.String(length=255), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("source_name", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("license_expression", sa.Text(), nullable=True),
        sa.Column("license_url", sa.Text(), nullable=True),
        sa.Column("source_receipt_sha256", sa.String(length=64), nullable=True),
        sa.Column("provenance_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "artifact_kind IN ('article_pdf', 'report_pdf', 'report_markdown', "
            "'report_latex', 'note_export', 'highlight_export', 'reference_export', "
            "'supplementary', 'dataset', 'code', 'image', 'audio', 'video', 'other')",
            name="ck_vault_artifacts_kind",
        ),
        sa.CheckConstraint("length(trim(media_type)) > 0", name="ck_vault_artifacts_media_type"),
        sa.CheckConstraint(
            "length(provenance_sha256) = 64 AND provenance_sha256 = lower(provenance_sha256) "
            "AND provenance_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_vault_artifacts_provenance_sha256",
        ),
        sa.CheckConstraint(
            "length(relative_path) > 0", name="ck_vault_artifacts_relative_path"
        ),
        sa.CheckConstraint(
            "length(sha256) = 64 AND sha256 = lower(sha256) "
            "AND sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_vault_artifacts_sha256",
        ),
        sa.CheckConstraint(
            _optional_sha256("source_receipt_sha256"),
            name="ck_vault_artifacts_source_receipt_sha256",
        ),
        sa.CheckConstraint("size >= 0", name="ck_vault_artifacts_size"),
        sa.ForeignKeyConstraint(
            ["library_item_id"], ["library_items.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "library_item_id",
            "artifact_kind",
            "sha256",
            "provenance_sha256",
            name="uq_vault_artifact_identity",
        ),
    )
    op.create_index("ix_vault_artifacts_library_item_id", "vault_artifacts", ["library_item_id"])
    op.create_index("ix_vault_artifacts_sha256", "vault_artifacts", ["sha256"])
    op.create_table(
        "reading_progress",
        sa.Column("artifact_id", sa.String(length=36), nullable=False),
        sa.Column("position_fraction", sa.Float(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("locator_json", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "position_fraction >= 0 AND position_fraction <= 1",
            name="ck_reading_progress_fraction",
        ),
        sa.CheckConstraint(
            "page_count IS NULL OR page_count >= 1", name="ck_reading_progress_page_count"
        ),
        sa.CheckConstraint(
            "page_number IS NULL OR page_number >= 1", name="ck_reading_progress_page_number"
        ),
        sa.CheckConstraint(
            "page_number IS NULL OR page_count IS NULL OR page_number <= page_count",
            name="ck_reading_progress_page_range",
        ),
        sa.CheckConstraint(
            "length(locator_json) > 0", name="ck_reading_progress_locator_json"
        ),
        sa.ForeignKeyConstraint(["artifact_id"], ["vault_artifacts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("artifact_id"),
    )
    op.create_table(
        "annotations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("library_item_id", sa.String(length=36), nullable=False),
        sa.Column("artifact_id", sa.String(length=36), nullable=True),
        sa.Column("annotation_kind", sa.String(length=16), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("quote_text", sa.Text(), nullable=True),
        sa.Column("anchor_json", sa.Text(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(trim(body)) > 0 OR length(trim(COALESCE(quote_text, ''))) > 0",
            name="ck_annotations_content",
        ),
        sa.CheckConstraint(
            "annotation_kind IN ('note', 'highlight')", name="ck_annotations_kind"
        ),
        sa.CheckConstraint("length(anchor_json) > 0", name="ck_annotations_anchor_json"),
        sa.CheckConstraint(
            "length(content_sha256) = 64 AND content_sha256 = lower(content_sha256) "
            "AND content_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_annotations_content_sha256",
        ),
        sa.CheckConstraint(
            "length(idempotency_key) >= 1 AND length(idempotency_key) <= 128",
            name="ck_annotations_idempotency_key",
        ),
        sa.CheckConstraint(
            "page_number IS NULL OR page_number >= 1", name="ck_annotations_page_number"
        ),
        sa.ForeignKeyConstraint(["artifact_id"], ["vault_artifacts.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["library_item_id"], ["library_items.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key", name="uq_annotations_idempotency_key"),
    )
    op.create_index("ix_annotations_artifact_id", "annotations", ["artifact_id"])
    op.create_index("ix_annotations_library_item_id", "annotations", ["library_item_id"])
    op.create_table(
        "tags",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.CheckConstraint("length(trim(name)) > 0", name="ck_tags_name"),
        sa.CheckConstraint("length(normalized_name) > 0", name="ck_tags_normalized_name"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("normalized_name", name="uq_tags_normalized_name"),
    )
    op.create_table(
        "library_item_tags",
        sa.Column("library_item_id", sa.String(length=36), nullable=False),
        sa.Column("tag_id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["library_item_id"], ["library_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("library_item_id", "tag_id"),
    )
    op.create_table(
        "collections",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("length(trim(name)) > 0", name="ck_collections_name"),
        sa.CheckConstraint(
            "length(normalized_name) > 0", name="ck_collections_normalized_name"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("normalized_name", name="uq_collections_normalized_name"),
    )
    op.create_table(
        "collection_items",
        sa.Column("collection_id", sa.String(length=36), nullable=False),
        sa.Column("library_item_id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(["collection_id"], ["collections.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["library_item_id"], ["library_items.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("collection_id", "library_item_id"),
    )
    op.create_table(
        "report_integrity_manifests",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("report_artifact_id", sa.String(length=36), nullable=False),
        sa.Column("artifact_sha256", sa.String(length=64), nullable=False),
        sa.Column("input_hashes_json", sa.Text(), nullable=False),
        sa.Column("evidence_hashes_json", sa.Text(), nullable=False),
        sa.Column("source_receipt_hashes_json", sa.Text(), nullable=False),
        sa.Column("template_sha256", sa.String(length=64), nullable=True),
        sa.Column("logo_sha256", sa.String(length=64), nullable=True),
        sa.Column("generator_version_sha256", sa.String(length=64), nullable=True),
        sa.Column("generation_settings_sha256", sa.String(length=64), nullable=True),
        sa.Column("manifest_json", sa.Text(), nullable=False),
        sa.Column("manifest_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(artifact_sha256) = 64 AND artifact_sha256 = lower(artifact_sha256) "
            "AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_report_integrity_artifact_sha256",
        ),
        sa.CheckConstraint(
            _optional_sha256("generation_settings_sha256"),
            name="ck_report_integrity_generation_settings_sha256",
        ),
        sa.CheckConstraint(
            _optional_sha256("generator_version_sha256"),
            name="ck_report_integrity_generator_version_sha256",
        ),
        sa.CheckConstraint(
            _optional_sha256("logo_sha256"), name="ck_report_integrity_logo_sha256"
        ),
        sa.CheckConstraint(
            "length(input_hashes_json) > 0 AND length(evidence_hashes_json) > 0 "
            "AND length(source_receipt_hashes_json) > 0 AND length(manifest_json) > 0",
            name="ck_report_integrity_json_payloads",
        ),
        sa.CheckConstraint(
            "length(manifest_sha256) = 64 AND manifest_sha256 = lower(manifest_sha256) "
            "AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'",
            name="ck_report_integrity_manifest_sha256",
        ),
        sa.CheckConstraint(
            _optional_sha256("template_sha256"), name="ck_report_integrity_template_sha256"
        ),
        sa.ForeignKeyConstraint(
            ["report_artifact_id"], ["vault_artifacts.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "report_artifact_id", name="uq_report_integrity_manifests_artifact_id"
        ),
    )
    op.create_index(
        "ix_report_integrity_manifests_report_artifact_id",
        "report_integrity_manifests",
        ["report_artifact_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_report_integrity_manifests_report_artifact_id",
        table_name="report_integrity_manifests",
    )
    op.drop_table("report_integrity_manifests")
    op.drop_table("collection_items")
    op.drop_table("collections")
    op.drop_table("library_item_tags")
    op.drop_table("tags")
    op.drop_index("ix_annotations_library_item_id", table_name="annotations")
    op.drop_index("ix_annotations_artifact_id", table_name="annotations")
    op.drop_table("annotations")
    op.drop_table("reading_progress")
    op.drop_index("ix_vault_artifacts_sha256", table_name="vault_artifacts")
    op.drop_index("ix_vault_artifacts_library_item_id", table_name="vault_artifacts")
    op.drop_table("vault_artifacts")
    op.drop_index("ix_library_items_work_id", table_name="library_items")
    op.drop_table("library_items")
