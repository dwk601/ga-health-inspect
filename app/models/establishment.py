from sqlalchemy import Column, Date, DateTime, Index, Integer, String, Text
from sqlalchemy.sql import func

from app.db.base import Base


class Establishment(Base):
    __tablename__ = "establishments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ext_id = Column(String, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    address = Column(Text)
    city = Column(String, index=True)
    county = Column(String, index=True)
    zip_code = Column(String)
    phone = Column(String)
    permit_type = Column(String, index=True)
    permit_number = Column(String)
    last_score = Column(Integer, index=True)
    last_inspection_date = Column(Date)
    contact_info = Column(String)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("ix_establishments_county_city", "county", "city"),
        Index("ix_establishments_county_score", "county", "last_score"),
    )
