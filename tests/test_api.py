from app.models.establishment import Establishment
from app.services.establishment import upsert_establishment, get_establishments, get_establishment_by_ext_id


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_list_establishments_empty(client):
    response = client.get("/api/v1/establishments")
    assert response.status_code == 200
    data = response.json()
    assert data["data"] == []
    assert data["meta"]["total"] == 0


def test_list_establishments_with_data(client, db):
    upsert_establishment(db, {
        "ext_id": "4793",
        "name": "Chuck E. Cheese #617",
        "address": "2601 DAWSON RD, ALBANY, GA 31707",
        "city": "ALBANY",
        "county": "GWINNETT",
        "zip_code": "31707",
        "phone": None,
        "permit_type": "Food Service",
        "permit_number": "0470303090",
        "last_score": 99,
        "last_inspection_date": None,
        "contact_info": "(229) 438-3943",
    })
    db.commit()

    response = client.get("/api/v1/establishments?county=GWINNETT")
    assert response.status_code == 200
    data = response.json()
    assert data["meta"]["total"] == 1
    assert data["data"][0]["ext_id"] == "4793"


def test_get_establishment(client, db):
    upsert_establishment(db, {
        "ext_id": "4793",
        "name": "Chuck E. Cheese #617",
        "address": "2601 DAWSON RD, ALBANY, GA 31707",
        "city": "ALBANY",
        "county": "GWINNETT",
        "zip_code": "31707",
        "phone": None,
        "permit_type": "Food Service",
        "permit_number": "0470303090",
        "last_score": 99,
        "last_inspection_date": None,
        "contact_info": "(229) 438-3943",
    })
    db.commit()

    response = client.get("/api/v1/establishments/4793")
    assert response.status_code == 200
    assert response.json()["name"] == "Chuck E. Cheese #617"


def test_get_establishment_not_found(client):
    response = client.get("/api/v1/establishments/99999")
    assert response.status_code == 404
