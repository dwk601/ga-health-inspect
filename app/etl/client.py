import logging
import random

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://ga.healthinspections.us/stateofgeorgia/API/index.cfm/facilities"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
]


def _headers() -> dict:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://ga.healthinspections.us/stateofgeorgia/",
    }


async def fetch_page(
    client: httpx.AsyncClient, start_row: int
) -> list | None:
    url = f"{BASE_URL}/{start_row}"
    delay = random.uniform(1.0, 3.0)
    logger.debug("Waiting %.1fs before fetching startRow=%d", delay, start_row)
    import asyncio

    await asyncio.sleep(delay)

    resp = await client.get(url, headers=_headers())
    resp.raise_for_status()
    return resp.json()


async def fetch_all_records(client: httpx.AsyncClient) -> list[dict]:
    all_records = []
    start_row = 0
    page_size = 5  # API returns 5 records per request

    while True:
        data = await fetch_page(client, start_row)
        if not data or not isinstance(data, list) or len(data) == 0:
            logger.info("No more data at startRow=%d", start_row)
            break

        all_records.extend(data)
        logger.info("Fetched %d records at startRow=%d", len(data), start_row)

        if len(data) < page_size:
            break

        start_row += page_size

    return all_records
