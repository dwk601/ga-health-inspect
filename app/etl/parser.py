import base64
import re


def strip_keys(record: dict) -> dict:
    return {k.strip(): v for k, v in record.items()}


def decode_id(b64: str) -> str | None:
    try:
        return base64.b64decode(b64.strip()).decode("utf-8")
    except Exception:
        return None


def parse_column(value: str, label_prefix: str) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace(label_prefix, "").strip()


def parse_address(raw: str) -> dict:
    cleaned = raw.replace("\r\n", "\n").strip()
    parts = cleaned.split("\n")

    street = parts[0].strip() if len(parts) > 0 else ""
    city_state_zip = parts[1].strip() if len(parts) > 1 else ""

    city = ""
    zip_code = ""
    if "," in city_state_zip:
        city_part, state_zip = city_state_zip.split(",", 1)
        city = city_part.strip()
        zip_match = re.search(r"\d{5}", state_zip)
        if zip_match:
            zip_code = zip_match.group()

    full = f"{street}, {city}, GA {zip_code}".strip(", ")
    if not city:
        full = cleaned.replace("\n", ", ")

    return {"street": street, "city": city, "zip_code": zip_code, "full": full}


def parse_raw_record(record: dict) -> dict:
    record = strip_keys(record)
    columns = {
        k.strip(): v.strip() if isinstance(v, str) else v
        for k, v in record.get("columns", {}).items()
    }

    ext_id = decode_id(record.get("id", ""))

    raw_address = columns.get("0", record.get("mapAddress", ""))
    address_parts = parse_address(raw_address)

    return {
        "ext_id": ext_id,
        "name": record.get("name", "").strip(),
        "address": address_parts["full"],
        "city": address_parts["city"],
        "zip_code": address_parts["zip_code"],
        "phone": parse_column(columns.get("1"), "Phone Number:"),
        "permit_type": parse_column(columns.get("2"), "Permit Type:"),
        "permit_number": parse_column(columns.get("3"), "Permit Number:"),
        "last_score": parse_column(columns.get("4"), "Last Inspection Score:"),
        "last_inspection_date": parse_column(columns.get("5"), "Last Inspection Date:"),
        "contact_info": parse_column(columns.get("6"), "For More Information Call:"),
    }
