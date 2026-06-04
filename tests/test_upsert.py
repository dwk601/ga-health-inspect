from app.models.establishment import Establishment
from app.services.establishment import upsert_establishment


def test_upsert_inserts_new_record(db):
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

    result = db.query(Establishment).filter_by(ext_id="4793").one()
    assert result.name == "Chuck E. Cheese #617"
    assert result.last_score == 99


def test_upsert_updates_existing_record(db):
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

    # Same ext_id with updated score
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
        "last_score": 85,
        "last_inspection_date": None,
        "contact_info": "(229) 438-3943",
    })
    db.commit()

    results = db.query(Establishment).filter_by(ext_id="4793").all()
    assert len(results) == 1
    assert results[0].last_score == 85


def test_upsert_multiple_runs_no_duplicates(db):
    data = {
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
    }

    # Simulate 3 ETL runs
    for _ in range(3):
        upsert_establishment(db, data)
        db.commit()

    results = db.query(Establishment).filter_by(ext_id="4793").all()
    assert len(results) == 1
