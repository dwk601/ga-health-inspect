#!/bin/bash
set -e

echo "Waiting for database..."
while ! python -c "
import sys
import psycopg2
try:
    conn = psycopg2.connect('${DATABASE_URL}')
    conn.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; do
    sleep 1
done
echo "Database is ready."

echo "Running migrations..."
alembic upgrade head

echo "Starting application..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
