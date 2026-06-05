from datetime import date

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models.establishment import Establishment
from app.models.schemas import PaginatedResponse, PaginationMeta


def get_establishments(
    db: Session,
    county: str | None = None,
    city: str | None = None,
    min_score: int | None = None,
    permit_type: str | None = None,
    page: int = 1,
    limit: int = 50,
) -> PaginatedResponse:
    query = select(Establishment)
    count_query = select(func.count()).select_from(Establishment)

    if county:
        query = query.where(Establishment.county == county.upper())
        count_query = count_query.where(Establishment.county == county.upper())
    if city:
        query = query.where(Establishment.city == city.upper())
        count_query = count_query.where(Establishment.city == city.upper())
    if min_score is not None:
        query = query.where(Establishment.last_score >= min_score)
        count_query = count_query.where(Establishment.last_score >= min_score)
    if permit_type:
        query = query.where(Establishment.permit_type == permit_type)
        count_query = count_query.where(Establishment.permit_type == permit_type)

    total = db.execute(count_query).scalar()

    offset = (page - 1) * limit
    query = query.order_by(Establishment.name).offset(offset).limit(limit)
    results = db.execute(query).scalars().all()

    return PaginatedResponse(
        data=results,
        meta=PaginationMeta(total=total, page=page, limit=limit),
    )


def get_known_ext_ids(db: Session, county: str) -> dict[str, date | None]:
    rows = db.execute(
        select(Establishment.ext_id, Establishment.last_inspection_date).where(
            Establishment.county == county.upper()
        )
    ).all()
    return {row.ext_id: row.last_inspection_date for row in rows}


def get_establishment_by_ext_id(db: Session, ext_id: str) -> Establishment | None:
    return db.execute(
        select(Establishment).where(Establishment.ext_id == ext_id)
    ).scalar_one_or_none()


def upsert_establishment(db: Session, data: dict) -> None:
    stmt = (
        insert(Establishment)
        .values(**data)
        .on_conflict_do_update(
            index_elements=["ext_id"],
            set_={k: v for k, v in data.items() if k != "ext_id"},
        )
    )
    db.execute(stmt)
