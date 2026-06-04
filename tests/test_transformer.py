from datetime import date

from app.etl.transformer import parse_date, parse_score, transform_record


def test_parse_date():
    assert parse_date("06-03-2026") == date(2026, 6, 3)
    assert parse_date("01-15-2024") == date(2024, 1, 15)


def test_parse_date_invalid():
    assert parse_date("invalid") is None
    assert parse_date("") is None
    assert parse_date(None) is None


def test_parse_score():
    assert parse_score("99") == 99
    assert parse_score(" 85 ") == 85


def test_parse_score_invalid():
    assert parse_score("N/A") is None
    assert parse_score("") is None
    assert parse_score(None) is None


def test_transform_record():
    parsed = {
        "ext_id": "4793",
        "name": "Chuck E. Cheese #617",
        "address": "2601 DAWSON RD, ALBANY, GA 31707",
        "city": "ALBANY",
        "zip_code": "31707",
        "phone": "",
        "permit_type": "Food Service",
        "permit_number": "0470303090",
        "last_score": "99",
        "last_inspection_date": "06-03-2026",
        "contact_info": "(229) 438-3943",
    }

    result = transform_record(parsed, "GWINNETT")
    assert result["ext_id"] == "4793"
    assert result["county"] == "GWINNETT"
    assert result["last_score"] == 99
    assert result["last_inspection_date"] == date(2026, 6, 3)
    assert result["phone"] is None
    assert result["permit_type"] == "Food Service"
