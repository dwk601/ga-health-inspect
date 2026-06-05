import logging

import httpx

from app.core.config import settings
from app.db.session import SessionLocal
from app.etl.client import fetch_all_records
from app.etl.parser import parse_raw_record
from app.etl.transformer import transform_record
from app.services.establishment import get_known_ext_ids, upsert_establishment

logger = logging.getLogger(__name__)


async def run_etl_for_county(county: str) -> dict:
    db = SessionLocal()
    success = 0
    errors = 0
    skipped = 0

    try:
        known = get_known_ext_ids(db, county)
        logger.info("Loaded %d known records for %s", len(known), county)

        async with httpx.AsyncClient(timeout=30.0) as client:
            records = await fetch_all_records(client)

        for raw in records:
            try:
                parsed = parse_raw_record(raw)
                transformed = transform_record(parsed, county)
                ext_id = transformed["ext_id"]
                if not ext_id:
                    logger.warning("Skipping record with no ext_id: %s", parsed.get("name"))
                    continue

                new_date = transformed["last_inspection_date"]
                existing_date = known.get(ext_id)
                if ext_id in known and new_date == existing_date:
                    skipped += 1
                    continue

                upsert_establishment(db, transformed)
                success += 1
            except Exception:
                errors += 1
                logger.exception("Error processing record")

        db.commit()
    except httpx.HTTPStatusError as e:
        logger.error("HTTP error fetching county %s: %s", county, e)
        db.rollback()
    except Exception:
        logger.exception("Unexpected error for county %s", county)
        db.rollback()
    finally:
        db.close()

    logger.info(
        "ETL complete for %s: %d updated, %d skipped, %d errors",
        county, success, skipped, errors,
    )
    return {"county": county, "success": success, "skipped": skipped, "errors": errors}


async def run_full_etl() -> list[dict]:
    results = []
    for county in settings.counties:
        result = await run_etl_for_county(county)
        results.append(result)
    return results


def trigger_etl_sync():
    import asyncio

    asyncio.run(run_full_etl())
