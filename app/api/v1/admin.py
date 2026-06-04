import threading

from fastapi import APIRouter, Depends, Header, HTTPException

from app.core.config import settings

router = APIRouter()

_etl_running = False
_last_etl_result: list[dict] | None = None


def _run_etl_background():
    global _etl_running, _last_etl_result
    _etl_running = True
    try:
        from app.etl.pipeline import run_full_etl
        import asyncio

        _last_etl_result = asyncio.run(run_full_etl())
    finally:
        _etl_running = False


@router.post("/etl/trigger")
async def trigger_etl(x_api_key: str = Header(...)):
    global _etl_running
    if x_api_key != settings.API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    if _etl_running:
        raise HTTPException(status_code=409, detail="ETL is already running")

    thread = threading.Thread(target=_run_etl_background, daemon=True)
    thread.start()
    return {"status": "ETL started in background"}


@router.get("/etl/status")
async def etl_status():
    return {
        "running": _etl_running,
        "last_result": _last_etl_result,
    }
