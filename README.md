# Georgia Health Inspections API

Reverse-engineered API & ETL pipeline for Georgia Department of Public Health environmental health inspection data. Extracts data from the state's hidden JSON API, normalizes it into PostgreSQL, and serves it via FastAPI.

## Stack

- **Python 3.11+** / FastAPI / Uvicorn
- **PostgreSQL 15** (Alpine)
- **APScheduler** for background ETL
- **Docker Compose** for orchestration
- **Alembic** for database migrations

## Quick Start

```bash
# Clone and configure
cp .env.example .env
# Edit .env with your credentials

# Start everything
docker-compose up --build
```

The API will be available at `http://localhost:8000`. Swagger docs at `http://localhost:8000/docs`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_USER` | Database username | `gwinnett_user` |
| `POSTGRES_PASSWORD` | Database password | `securepassword` |
| `POSTGRES_DB` | Database name | `inspections_db` |
| `DATABASE_URL` | Full connection string | `postgresql://...` |
| `TARGET_COUNTIES` | Comma-separated county list | `GWINNETT` |
| `ETL_INTERVAL_HOURS` | ETL run frequency | `12` |
| `API_KEY` | Admin endpoint auth key | `change-me` |

## API Endpoints

Base URL: `/api/v1`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/establishments` | List establishments with filtering |
| `GET` | `/establishments/{ext_id}` | Get single establishment |
| `POST` | `/admin/etl/trigger` | Manually trigger ETL (requires `X-API-Key` header) |
| `GET` | `/admin/etl/status` | Check ETL status |

### Query Parameters (`GET /establishments`)

| Param | Type | Description |
|-------|------|-------------|
| `county` | string | Filter by county (e.g., `GWINNETT`) |
| `city` | string | Filter by city |
| `min_score` | int | Minimum inspection score (0-100) |
| `permit_type` | string | Filter by permit type |
| `page` | int | Page number (default: 1) |
| `limit` | int | Items per page (default: 50, max: 100) |

### Example

```
GET /api/v1/establishments?county=GWINNETT&city=BUFORD&min_score=90
```

```json
{
  "data": [
    {
      "ext_id": "4793",
      "name": "Chuck E. Cheese #617",
      "address": "2601 DAWSON RD, ALBANY, GA 31707",
      "county": "GWINNETT",
      "permit_type": "Food Service",
      "last_score": 99,
      "last_inspection_date": "2026-06-03"
    }
  ],
  "meta": {
    "total": 142,
    "page": 1,
    "limit": 50
  }
}
```

## Project Structure

```
.
├── app/
│   ├── api/v1/          # FastAPI route handlers
│   ├── core/            # Settings and config
│   ├── db/              # SQLAlchemy base and session
│   ├── etl/             # ETL pipeline (client, parser, transformer)
│   ├── models/          # SQLAlchemy models and Pydantic schemas
│   └── services/        # Business logic (upsert, queries)
├── alembic/             # Database migrations
├── docker/              # Dockerfile and entrypoint
└── tests/               # Pytest test suite
```

## ETL Pipeline

The ETL handles quirks in the state's raw API response:

1. **Trailing spaces** in JSON keys — stripped during parsing
2. **Base64 encoded IDs** — decoded to integers
3. **Nested columns** with "Label: Value" format — parsed into clean fields
4. **`\r\n` in addresses** — split into street, city, zip components

The pipeline runs automatically every 12 hours via APScheduler, or manually via `POST /api/v1/admin/etl/trigger`.

## Development

```bash
# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run tests
python -m pytest tests/ -v

# Run locally (requires PostgreSQL)
alembic upgrade head
uvicorn app.main:app --reload
```

## License

MIT
