```markdown
# Product Requirements Document (PRD)
**Project Name:** Georgia Environmental Health Inspection API & ETL Pipeline
**Version:** 1.0
**Status:** Approved for Development
**Target Stack:** Python, FastAPI, PostgreSQL, Docker, Next.js (Frontend Consumer)

---

## 1. Executive Summary
The Georgia Department of Public Health (DPH) provides environmental health inspection data via a web portal (`ga.healthinspections.us`). However, there is no official public REST API or bulk dataset download. The portal relies on a hidden, poorly formatted JSON API to power an "infinite scroll" frontend. 

This project aims to reverse-engineer the hidden API, build a resilient Dockerized ETL pipeline to extract and clean the data, store it in a normalized PostgreSQL database, and serve it via a high-performance FastAPI REST API. This will provide a reliable, queryable data source for a Next.js frontend application (e.g., filtering specifically for Gwinnett County/Buford).

## 2. Problem Statement
- **No Public API:** Developers cannot easily access GA health inspection data for research or app development.
- **Poor Data Formatting:** The raw API response contains trailing spaces in keys, Base64 encoded IDs, and nested dictionaries with concatenated label-value strings.
- **Frontend Coupling:** The data is currently locked behind an infinite-scroll UI, making bulk analysis or localized filtering (e.g., "Show me all restaurants in Buford with a score < 90") impossible without manual scraping.

## 3. Goals & Objectives
1. **Automate Extraction:** Build a background ETL job that fetches all GA inspection data (or targeted counties) daily.
2. **Data Normalization:** Clean, decode, and parse the raw JSON into a relational PostgreSQL schema.
3. **API Delivery:** Expose the cleaned data via a FastAPI REST API with filtering capabilities (County, City, Score, Permit Type).
4. **Containerization:** Ensure the entire stack (DB, ETL, API) is deployable via a single `docker-compose up` command.

---

## 4. Technical Architecture
The system follows a "Two-Container" microservices pattern orchestrated by Docker Compose.

### 4.1. Components
1. **PostgreSQL Database:** Persistent storage for normalized establishment and inspection data.
2. **FastAPI Application:** 
   - Serves the REST API to the Next.js frontend.
   - Hosts `APScheduler` to run the ETL pipeline in the background (eliminating the need for OS-level cron jobs).
3. **Next.js Frontend (Out of Scope for this PRD, but the primary consumer):** Will consume the FastAPI endpoints to render maps, lists, and search filters.

### 4.2. Data Flow
`Hidden DPH API` ➔ `Python ETL (Requests/Httpx)` ➔ `Data Cleaning/Decoding` ➔ `PostgreSQL (Upsert)` ➔ `FastAPI` ➔ `Next.js Frontend`

---

## 5. ETL Pipeline Specifications
Based on HAR network analysis (`har_export_1780580219819.json`), the ETL must handle several specific anomalies in the state's API response.

### 5.1. Raw API Quirks to Handle
1. **Trailing Spaces:** All JSON keys contain accidental trailing spaces (e.g., `"name "`, `"mapAddress "`, `"columns "`).
2. **Base64 IDs:** The unique establishment ID is Base64 encoded (e.g., `"NDc5Mw== "` decodes to `4793`).
3. **Nested Columns:** Useful data is buried in a `columns` dictionary using numeric string keys (`"0 "`, `"1 "`), and the values include the label text (e.g., `"Last Inspection Score: 99 "`).
4. **Address Formatting:** `mapAddress` contains `\r\n` characters that must be parsed into Street, City, State, and Zip.

### 5.2. Transformation Logic (Python)
```python
import base64

def transform_record(raw_item):
    # 1. Strip trailing spaces from top-level keys
    item = {k.strip(): v for k, v in raw_item.items()}
    cols = {k.strip(): v.strip() for k, v in item.get('columns', {}).items()}
    
    # 2. Decode ID
    b64_id = item.get('id', '')
    decoded_id = base64.b64decode(b64_id).decode('utf-8') if b64_id else None
    
    # 3. Helper to extract values from "Label: Value" strings
    def parse_col(key, label):
        val = cols.get(key, '')
        return val.replace(label, '').strip() if isinstance(val, str) else ''

    # 4. Parse Address
    raw_addr = item.get('mapAddress', '').replace('\r\n', ', ').strip()
    
    return {
        'ext_id': decoded_id,
        'name': item.get('name', '').strip(),
        'address_raw': raw_addr,
        'phone': parse_col('1', 'Phone Number:'),
        'permit_type': parse_col('2', 'Permit Type:'),
        'permit_number': parse_col('3', 'Permit Number:'),
        'last_score': parse_col('4', 'Last Inspection Score:'),
        'last_date': parse_col('5', 'Last Inspection Date:'),
        'contact': parse_col('6', 'For More Information Call:')
    }
```

### 5.3. Scheduling
- **Tool:** `APScheduler` (BackgroundScheduler) running inside the FastAPI container.
- **Frequency:** Every 12 hours (or configurable via `.env`).
- **Trigger:** Iterates through known Counties (starting with GWINNETT) or uses pagination parameters discovered in the HAR payload.

---

## 6. Data Model (PostgreSQL)

### Table: `establishments`
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | SERIAL | Primary Key (Internal) |
| `ext_id` | VARCHAR | Decoded Base64 ID from State API (Unique Index) |
| `name` | VARCHAR | Establishment Name |
| `address` | TEXT | Cleaned full address |
| `city` | VARCHAR | Extracted from address or API filter |
| `county` | VARCHAR | e.g., 'GWINNETT' |
| `zip_code` | VARCHAR | Extracted from address |
| `phone` | VARCHAR | Contact phone |
| `permit_type` | VARCHAR | 'Food Service', 'Swimming Pool', etc. |
| `permit_number` | VARCHAR | State permit number |
| `last_score` | INTEGER | Most recent inspection score |
| `last_inspection_date`| DATE | Date of most recent inspection |
| `contact_info` | VARCHAR | Local health department phone |
| `updated_at` | TIMESTAMP | Last time ETL updated this record |

---

## 7. API Specifications (FastAPI)

Base URL: `/api/v1`

### 7.1. Endpoints
| Method | Endpoint | Description | Query Params |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Health check for Docker/Uptime monitors | None |
| `GET` | `/establishments` | List establishments with pagination | `county`, `city`, `min_score`, `permit_type`, `page`, `limit` |
| `GET` | `/establishments/{ext_id}`| Get single establishment details | None |
| `POST` | `/admin/etl/trigger` | Manually trigger the ETL job | `api_key` (Header) |
| `GET` | `/admin/etl/status` | Check last successful ETL run time | None |

### 7.2. Example Response (`GET /api/v1/establishments?county=GWINNETT&city=BUFORD`)
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

---

## 8. Infrastructure & Deployment

### 8.1. Docker Compose Setup
The project will be deployed using a `docker-compose.yml` file defining two services:
1. **`db`**: Official `postgres:15-alpine` image with a persistent named volume (`postgres_data`).
2. **`api`**: Custom Python image built from a `Dockerfile` containing FastAPI, Uvicorn, APScheduler, and Psycopg2.

### 8.2. Environment Variables (`.env`)
```env
# Database
POSTGRES_USER=gwinnett_user
POSTGRES_PASSWORD=securepassword
POSTGRES_DB=inspections_db
DATABASE_URL=postgresql://gwinnett_user:securepassword@db:5432/inspections_db

# ETL Config
TARGET_COUNTIES=GWINNETT,FULTON,DEKALB
ETL_INTERVAL_HOURS=12
```

---

## 9. Milestones & Roadmap

### Phase 1: Core MVP (Current Sprint)
- [ ] Reverse-engineer exact API URL and pagination parameters from HAR file.
- [ ] Write Python ETL script with data cleaning logic.
- [ ] Set up PostgreSQL schema and Docker Compose environment.
- [ ] Build FastAPI endpoints for basic querying.

### Phase 2: Refinement & Frontend Integration
- [ ] Implement address parsing (extracting City/State/Zip into separate columns).
- [ ] Connect Next.js 15 frontend to FastAPI.
- [ ] Add Swagger UI documentation to FastAPI.

### Phase 3: Advanced Features (Future)
- [ ] **Historical Data:** Reverse-engineer the "Detail View" API endpoint to scrape individual violation histories (not just the "Last Inspection" summary).
- [ ] **Geospatial:** Use PostGIS to geocode addresses and enable "Near Me" radius searches.
- [ ] **Alerts:** Add an endpoint to subscribe to email/SMS alerts when a specific restaurant's score drops below a threshold.

---

## 10. Risks & Mitigations
| Risk | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **API Rate Limiting / IP Ban** | High | Implement random delays (1-3 seconds) between ETL requests. Rotate User-Agent strings. |
| **API Schema Changes** | Medium | Write Pydantic models to validate incoming JSON. If the state changes their keys, the ETL will fail gracefully and log an error rather than corrupting the DB. |
| **Duplicate Records** | Low | Use PostgreSQL `ON CONFLICT (ext_id) DO UPDATE` to ensure idempotency during ETL runs. |
```