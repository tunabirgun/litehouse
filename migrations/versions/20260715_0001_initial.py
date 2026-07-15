from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260715_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "works",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "kind IN ('article', 'preprint', 'book', 'chapter', 'thesis', "
            "'proceedings_paper', 'archival_document', 'artwork', "
            "'exhibition_catalogue', 'performance', 'score', 'dataset', 'software', "
            "'protocol', 'trial', 'policy_document', 'standard', 'other')",
            name="ck_works_kind",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "work_identifiers",
        sa.Column("work_id", sa.String(length=36), nullable=False),
        sa.Column("namespace", sa.String(length=64), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["work_id"], ["works.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("work_id", "namespace", "value"),
        sa.UniqueConstraint(
            "namespace", "value", name="uq_work_identifier_namespace_value"
        ),
    )
    op.create_table(
        "contributors",
        sa.Column("work_id", sa.String(length=36), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("role", sa.String(length=64), nullable=False),
        sa.CheckConstraint("position >= 0", name="ck_contributors_position"),
        sa.ForeignKeyConstraint(["work_id"], ["works.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("work_id", "position"),
    )
    op.create_table(
        "watches",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("active_revision_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["active_revision_id"],
            ["watch_revisions.id"],
            name="fk_watches_active_revision_id",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "watch_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("watch_id", sa.String(length=36), nullable=False),
        sa.Column("revision_number", sa.Integer(), nullable=False),
        sa.Column("specification_json", sa.Text(), nullable=False),
        sa.Column("specification_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision_number >= 1", name="ck_watch_revision_number"),
        sa.ForeignKeyConstraint(
            ["watch_id"],
            ["watches.id"],
            name="fk_watch_revisions_watch_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("watch_id", "revision_number", name="uq_watch_revision_number"),
    )
    op.create_index("ix_watch_revisions_watch_id", "watch_revisions", ["watch_id"])
    op.create_table(
        "runs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("watch_revision_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled')",
            name="ck_runs_status",
        ),
        sa.ForeignKeyConstraint(
            ["watch_revision_id"], ["watch_revisions.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "watch_revision_id", "scheduled_at", name="uq_run_revision_scheduled_at"
        ),
    )
    op.create_index("ix_runs_watch_revision_id", "runs", ["watch_revision_id"])
    op.create_table(
        "metadata_assertions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("work_id", sa.String(length=36), nullable=False),
        sa.Column("field_name", sa.String(length=128), nullable=False),
        sa.Column("value_json", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=128), nullable=False),
        sa.Column("source_record_id", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["work_id"], ["works.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "work_id",
            "field_name",
            "source",
            "source_record_id",
            "value_json",
            name="uq_metadata_assertion_source_value",
        ),
    )
    op.create_index("ix_metadata_assertions_work_id", "metadata_assertions", ["work_id"])
    op.create_table(
        "evidence_segments",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("work_id", sa.String(length=36), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("locator", sa.Text(), nullable=False),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.CheckConstraint(
            "scope IN ('metadata', 'abstract', 'full_text')",
            name="ck_evidence_segments_scope",
        ),
        sa.ForeignKeyConstraint(["work_id"], ["works.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_evidence_segments_work_id", "evidence_segments", ["work_id"])
    op.create_table(
        "claims",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("report_id", sa.String(length=36), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.CheckConstraint("kind IN ('sourced', 'system')", name="ck_claims_kind"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_claims_report_id", "claims", ["report_id"])
    op.create_table(
        "claim_evidence_links",
        sa.Column("claim_id", sa.String(length=36), nullable=False),
        sa.Column("evidence_segment_id", sa.String(length=36), nullable=False),
        sa.Column("relation", sa.String(length=24), nullable=False),
        sa.CheckConstraint(
            "relation IN ('supports', 'contradicts', 'contextualizes')",
            name="ck_claim_evidence_links_relation",
        ),
        sa.ForeignKeyConstraint(["claim_id"], ["claims.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["evidence_segment_id"], ["evidence_segments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("claim_id", "evidence_segment_id"),
    )


def downgrade() -> None:
    op.drop_table("claim_evidence_links")
    op.drop_index("ix_claims_report_id", table_name="claims")
    op.drop_table("claims")
    op.drop_index("ix_evidence_segments_work_id", table_name="evidence_segments")
    op.drop_table("evidence_segments")
    op.drop_index("ix_metadata_assertions_work_id", table_name="metadata_assertions")
    op.drop_table("metadata_assertions")
    op.drop_index("ix_runs_watch_revision_id", table_name="runs")
    op.drop_table("runs")
    op.execute("UPDATE watches SET active_revision_id = NULL")
    op.drop_index("ix_watch_revisions_watch_id", table_name="watch_revisions")
    op.drop_table("watch_revisions")
    op.drop_table("watches")
    op.drop_table("contributors")
    op.drop_table("work_identifiers")
    op.drop_table("works")
