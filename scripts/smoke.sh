#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
project=${PROJECT:?Set PROJECT to a unique ga-ui- project}
[[ $project =~ ^ga-ui-[a-z0-9][a-z0-9_-]*$ ]] || { echo 'Invalid smoke project' >&2; exit 1; }
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/ga-ui-smoke.XXXXXXXX")
override=$tmpdir/compose.yaml
export DATABASE_URL='postgres://ga_inspect_reader:scratch-reader-only@postgres:5432/health_scratch?sslmode=disable'
export REDIS_PASSWORD='smoke-redis-only'
export APP_URL='http://app:8090' APP_NAME='Smoke' APP_ENV=smoke
export SMTP_HOST='' SMTP_PORT='' SMTP_USERNAME='' SMTP_PASSWORD='' SMTP_TLS=false SMTP_SENDER_NAME='' SMTP_SENDER_ADDRESS=''
export PB_ENCRYPTION_KEY='0123456789abcdef0123456789abcdef'
compose=(docker compose -p "$project" -f docker-compose.yaml -f "$override")
cleanup() {
  status=$?
  trap - EXIT
  "${compose[@]}" down -v --rmi local --remove-orphans || status=1
  rm -rf "$tmpdir"
  exit "$status"
}
trap cleanup EXIT
cat > "$override" <<'YAML'
services:
  app:
    ports: ["127.0.0.1::8090"]
  postgres:
    image: postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
    environment:
      POSTGRES_DB: health_scratch
      POSTGRES_USER: scratch
      POSTGRES_PASSWORD: smoke-only
    volumes:
      - ${ETL_SCHEMA_PATH:?ETL_SCHEMA_PATH is required}:/docker-entrypoint-initdb.d/01-schema.sql:ro
      - ./dev/seed.sql:/docker-entrypoint-initdb.d/02-seed.sql:ro
      - ./dev/readonly-role.sql:/docker-entrypoint-initdb.d/03-role.sql:ro
    networks: [inspection_source]
networks:
  inspection_source:
    external: false
    name: ${PROJECT}_smoke
YAML
export PROJECT=$project
# Validate the unmodified production configuration without contacting its network.
docker compose -p "$project" -f docker-compose.yaml config -q
"${compose[@]}" up -d --build --wait
app=$("${compose[@]}" ps -q app)
redis=$("${compose[@]}" ps -q redis)
base="http://$("${compose[@]}" port app 8090)"
curl -fsS "$base/api/health" >/dev/null
html=$(curl -fsS "$base/facilities/example")
asset=$(printf '%s' "$html" | grep -oE '/assets/[^" ]+\.js' | head -1 || true)
[ -n "$asset" ] || { echo 'SPA asset not found' >&2; exit 1; }
curl -fsS "$base$asset" >/dev/null
for path in /api/unknown /assets/missing.js; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$base$path")
  [ "$status" = 404 ] || { echo "Expected 404 for $path, got $status" >&2; exit 1; }
done
health=$(docker inspect -f '{{.State.Health.Status}}' "$app")
[ "$health" = healthy ] || { echo "App is not healthy: $health" >&2; exit 1; }
app_uid=$(docker exec "$app" sh -c "awk '/^Uid:/ {print \$2}' /proc/1/status")
redis_uid=$(docker exec "$redis" sh -c "awk '/^Uid:/ {print \$2}' /proc/1/status")
[[ $app_uid =~ ^[1-9][0-9]*$ ]] || { echo "App process is not non-root: $app_uid" >&2; exit 1; }
[[ $redis_uid =~ ^[1-9][0-9]*$ ]] || { echo "Redis process is not non-root: $redis_uid" >&2; exit 1; }
docker exec "$redis" redis-cli ping | grep -q NOAUTH
docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$redis" redis-cli ping | grep -qx PONG
docker exec "$app" /app/server superuser upsert smoke@example.test smoke-password-123 --dir=/app/pb_data --encryptionEnv=PB_ENCRYPTION_KEY >/dev/null
user=$(curl -fsS "$base/api/collections/users/records" -H 'Content-Type: application/json' -d '{"email":"user@example.test","password":"smoke-password-123","passwordConfirm":"smoke-password-123","name":"Smoke User"}')
id=$(printf '%s' "$user" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
super=$(curl -fsS "$base/api/collections/_superusers/auth-with-password" -H 'Content-Type: application/json' -d '{"identity":"smoke@example.test","password":"smoke-password-123"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl -fsS -X PATCH "$base/api/collections/users/records/$id" -H "Authorization: $super" -H 'Content-Type: application/json' -d '{"verified":true}' >/dev/null
token=$(curl -fsS "$base/api/collections/users/auth-with-password" -H 'Content-Type: application/json' -d '{"identity":"user@example.test","password":"smoke-password-123"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
comment=$(curl -fsS "$base/api/collections/comments/records" -H "Authorization: $token" -H 'Content-Type: application/json' -d "{\"owner\":\"$id\",\"facility_id\":\"pin\",\"body\":\"Smoke comment\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
"${compose[@]}" up -d --force-recreate --no-deps app
base="http://$("${compose[@]}" port app 8090)"
for _ in {1..60}; do
  if curl -fsS "$base/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
# Both records must survive replacement of the container using the same volume.
curl -fsS "$base/api/collections/_superusers/auth-with-password" -H 'Content-Type: application/json' -d '{"identity":"smoke@example.test","password":"smoke-password-123"}' >/dev/null
auth=$(curl -fsS "$base/api/collections/users/auth-with-password" -H 'Content-Type: application/json' -d '{"identity":"user@example.test","password":"smoke-password-123"}')
printf '%s' "$auth" | python3 -c 'import json,sys; assert json.load(sys.stdin)["record"]["id"] == sys.argv[1]' "$id"
curl -fsS "$base/api/collections/comments/records/$comment" | python3 -c 'import json,sys; c=json.load(sys.stdin); assert c["body"] == "Smoke comment" and c["facility_id"] == "pin"'
echo 'Smoke checks passed.'
