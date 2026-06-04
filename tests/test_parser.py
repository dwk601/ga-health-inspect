from app.etl.parser import decode_id, parse_address, parse_column, parse_raw_record


def test_decode_id():
    assert decode_id("NDc5Mw==") == "4793"
    assert decode_id("NDgxOQ==") == "4819"
    assert decode_id("MTI5ODU3NjA=") == "12985760"


def test_decode_id_with_trailing_space():
    assert decode_id("NDc5Mw== ") == "4793"


def test_decode_id_invalid():
    assert decode_id("not-base64!!!") is None


def test_parse_address():
    raw = "2601 DAWSON RD \r\nALBANY, GA 31707"
    result = parse_address(raw)
    assert result["street"] == "2601 DAWSON RD"
    assert result["city"] == "ALBANY"
    assert result["zip_code"] == "31707"


def test_parse_address_with_extended_zip():
    raw = "1661 POWDER SPRINGS RD SW \r\nMARIETTA, GA 30064-4145"
    result = parse_address(raw)
    assert result["street"] == "1661 POWDER SPRINGS RD SW"
    assert result["city"] == "MARIETTA"
    assert result["zip_code"] == "30064"


def test_parse_column_with_value():
    assert parse_column("Food Service", "Permit Type:") == "Food Service"


def test_parse_column_with_label():
    assert parse_column("Permit Type: Food Service", "Permit Type:") == "Food Service"


def test_parse_column_empty():
    assert parse_column("Phone Number: ", "Phone Number:") == ""


def test_parse_column_none():
    assert parse_column(None, "Phone Number:") == ""


def test_parse_raw_record():
    raw = {
        "mapAddress": "2601 DAWSON RD \r\nALBANY, GA 31707",
        "columns": {
            "0": "2601 DAWSON RD \r\nALBANY, GA 31707",
            "1": "Phone Number: ",
            "2": "Permit Type: Food Service",
            "3": "Permit Number: 0470303090",
            "4": "Last Inspection Score: 99",
            "5": "Last Inspection Date: 06-03-2026",
            "6": "For More Information Call: (229) 438-3943",
        },
        "id": "NDc5Mw==",
        "name": "Chuck E. Cheese #617",
    }

    result = parse_raw_record(raw)
    assert result["ext_id"] == "4793"
    assert result["name"] == "Chuck E. Cheese #617"
    assert result["permit_type"] == "Food Service"
    assert result["permit_number"] == "0470303090"
    assert result["last_score"] == "99"
    assert result["last_inspection_date"] == "06-03-2026"
    assert result["contact_info"] == "(229) 438-3943"
    assert result["city"] == "ALBANY"
    assert result["zip_code"] == "31707"


def test_parse_raw_record_with_trailing_spaces():
    raw = {
        "mapAddress ": "3800 OLD DAWSON RD \r\nALBANY, GA 31707",
        "columns ": {
            "0 ": "3800 OLD DAWSON RD \r\nALBANY, GA 31707",
            "1 ": "Phone Number: (229) 436-6501",
            "2 ": "Permit Type: Food Service",
            "3 ": "Permit Number: 0470403501",
            "4 ": "Last Inspection Score: 91",
            "5 ": "Last Inspection Date: 06-03-2026",
            "6 ": "For More Information Call: (229) 438-3943",
        },
        "id ": "NDgxOQ==",
        "name ": "Doublegate Country Club",
    }

    result = parse_raw_record(raw)
    assert result["ext_id"] == "4819"
    assert result["name"] == "Doublegate Country Club"
    assert result["phone"] == "(229) 436-6501"
    assert result["last_score"] == "91"
