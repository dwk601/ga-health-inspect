from datetime import date
from typing import Optional

from pydantic import BaseModel, ConfigDict


class EstablishmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    ext_id: str
    name: str
    address: Optional[str] = None
    city: Optional[str] = None
    county: Optional[str] = None
    zip_code: Optional[str] = None
    phone: Optional[str] = None
    permit_type: Optional[str] = None
    permit_number: Optional[str] = None
    last_score: Optional[int] = None
    last_inspection_date: Optional[date] = None
    contact_info: Optional[str] = None


class PaginationMeta(BaseModel):
    total: int
    page: int
    limit: int


class PaginatedResponse(BaseModel):
    data: list[EstablishmentResponse]
    meta: PaginationMeta
