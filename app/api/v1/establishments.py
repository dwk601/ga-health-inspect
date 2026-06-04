from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.schemas import EstablishmentResponse, PaginatedResponse
from app.services.establishment import get_establishment_by_ext_id, get_establishments

router = APIRouter()


@router.get("/establishments", response_model=PaginatedResponse)
async def list_establishments(
    county: str | None = Query(None, description="Filter by county (e.g., GWINNETT)"),
    city: str | None = Query(None, description="Filter by city"),
    min_score: int | None = Query(None, ge=0, le=100, description="Minimum inspection score"),
    permit_type: str | None = Query(None, description="Filter by permit type"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
):
    return get_establishments(
        db=db,
        county=county,
        city=city,
        min_score=min_score,
        permit_type=permit_type,
        page=page,
        limit=limit,
    )


@router.get("/establishments/{ext_id}", response_model=EstablishmentResponse)
async def get_establishment(ext_id: str, db: Session = Depends(get_db)):
    establishment = get_establishment_by_ext_id(db, ext_id)
    if not establishment:
        raise HTTPException(status_code=404, detail="Establishment not found")
    return establishment
