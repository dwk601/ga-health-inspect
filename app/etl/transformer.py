from datetime import date, datetime


def parse_date(date_str: str) -> date | None:
    try:
        return datetime.strptime(date_str.strip(), "%m-%d-%Y").date()
    except (ValueError, AttributeError):
        return None


def parse_score(score_str: str) -> int | None:
    try:
        return int(score_str.strip())
    except (ValueError, AttributeError):
        return None


def transform_record(parsed: dict, county: str) -> dict:
    return {
        "ext_id": parsed["ext_id"],
        "name": parsed["name"],
        "address": parsed["address"],
        "city": parsed["city"],
        "county": county.upper(),
        "zip_code": parsed["zip_code"] or None,
        "phone": parsed["phone"] or None,
        "permit_type": parsed["permit_type"] or None,
        "permit_number": parsed["permit_number"] or None,
        "last_score": parse_score(parsed["last_score"]),
        "last_inspection_date": parse_date(parsed["last_inspection_date"]),
        "contact_info": parsed["contact_info"] or None,
    }
