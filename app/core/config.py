from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql://gwinnett_user:securepassword@db:5432/inspections_db"
    TARGET_COUNTIES: str = "GWINNETT"
    ETL_INTERVAL_HOURS: int = 168
    API_KEY: str = "change-me"

    @property
    def counties(self) -> list[str]:
        return [c.strip().upper() for c in self.TARGET_COUNTIES.split(",")]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
