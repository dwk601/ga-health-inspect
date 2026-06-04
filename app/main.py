import logging

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI

from app.api.v1 import admin, establishments, health
from app.etl.pipeline import trigger_etl_sync
from app.core.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

scheduler = BackgroundScheduler()


def _startup():
    scheduler.add_job(trigger_etl_sync, "interval", hours=settings.ETL_INTERVAL_HOURS, id="etl")
    scheduler.start()


def _shutdown():
    scheduler.shutdown(wait=False)


app = FastAPI(
    title="GA Health Inspections API",
    version="1.0.0",
    on_startup=[_startup],
    on_shutdown=[_shutdown],
)

app.include_router(health.router, tags=["health"])
app.include_router(establishments.router, prefix="/api/v1", tags=["establishments"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["admin"])
