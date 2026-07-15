from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260715_0003"
down_revision: str | None = "20260715_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ARTIFACT_KINDS = (
    "artifact_kind IN ('article_pdf', 'report_pdf', 'report_markdown', 'report_text', "
    "'report_latex', 'note_export', 'highlight_export', 'reference_export', "
    "'supplementary', 'dataset', 'code', 'image', 'audio', 'video', 'other')"
)
_OLD_ARTIFACT_KINDS = _ARTIFACT_KINDS.replace("'report_text', ", "")


def upgrade() -> None:
    with op.batch_alter_table("runs") as batch:
        batch.add_column(sa.Column("available_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(
            sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False)
        )
        batch.add_column(sa.Column("report_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("result_sha256", sa.String(length=64), nullable=True))
        batch.add_column(
            sa.Column("artifact_count", sa.Integer(), server_default=sa.text("0"), nullable=False)
        )
        batch.add_column(
            sa.Column(
                "source_error_count", sa.Integer(), server_default=sa.text("0"), nullable=False
            )
        )
        batch.add_column(sa.Column("error_code", sa.String(length=64), nullable=True))
    op.execute("UPDATE runs SET available_at = scheduled_at WHERE available_at IS NULL")
    with op.batch_alter_table("runs") as batch:
        batch.alter_column("available_at", existing_type=sa.DateTime(timezone=True), nullable=False)
        batch.create_check_constraint(
            "ck_runs_counters",
            "attempt_count >= 0 AND artifact_count >= 0 AND source_error_count >= 0",
        )
        batch.create_check_constraint(
            "ck_runs_result_sha256",
            "result_sha256 IS NULL OR (length(result_sha256) = 64 "
            "AND result_sha256 = lower(result_sha256) "
            "AND result_sha256 NOT GLOB '*[^0-9a-f]*')",
        )
    with op.batch_alter_table("vault_artifacts") as batch:
        batch.drop_constraint("ck_vault_artifacts_kind", type_="check")
        batch.create_check_constraint("ck_vault_artifacts_kind", _ARTIFACT_KINDS)


def downgrade() -> None:
    with op.batch_alter_table("vault_artifacts") as batch:
        batch.drop_constraint("ck_vault_artifacts_kind", type_="check")
        batch.create_check_constraint("ck_vault_artifacts_kind", _OLD_ARTIFACT_KINDS)
    with op.batch_alter_table("runs") as batch:
        batch.drop_constraint("ck_runs_result_sha256", type_="check")
        batch.drop_constraint("ck_runs_counters", type_="check")
        batch.drop_column("error_code")
        batch.drop_column("source_error_count")
        batch.drop_column("artifact_count")
        batch.drop_column("result_sha256")
        batch.drop_column("report_id")
        batch.drop_column("attempt_count")
        batch.drop_column("finished_at")
        batch.drop_column("started_at")
        batch.drop_column("available_at")
