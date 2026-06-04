"""create establishments table

Revision ID: 001
Revises:
Create Date: 2026-06-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "establishments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("ext_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("city", sa.String(), nullable=True),
        sa.Column("county", sa.String(), nullable=True),
        sa.Column("zip_code", sa.String(), nullable=True),
        sa.Column("phone", sa.String(), nullable=True),
        sa.Column("permit_type", sa.String(), nullable=True),
        sa.Column("permit_number", sa.String(), nullable=True),
        sa.Column("last_score", sa.Integer(), nullable=True),
        sa.Column("last_inspection_date", sa.Date(), nullable=True),
        sa.Column("contact_info", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("ext_id"),
    )
    op.create_index("ix_establishments_ext_id", "establishments", ["ext_id"])
    op.create_index("ix_establishments_city", "establishments", ["city"])
    op.create_index("ix_establishments_county", "establishments", ["county"])
    op.create_index("ix_establishments_permit_type", "establishments", ["permit_type"])
    op.create_index("ix_establishments_last_score", "establishments", ["last_score"])
    op.create_index("ix_establishments_county_city", "establishments", ["county", "city"])
    op.create_index("ix_establishments_county_score", "establishments", ["county", "last_score"])


def downgrade() -> None:
    op.drop_table("establishments")
