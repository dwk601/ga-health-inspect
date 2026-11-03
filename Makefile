SHELL := /bin/bash
ETL_SCHEMA_PATH ?= $(CURDIR)/../etl/ga_health_inspect/schema.sql
export ETL_SCHEMA_PATH
COMPOSE = docker compose -f compose.dev.yaml -p $(PROJECT)
GO_PACKAGES = . ./internal/... ./web ./migrations
SERVICE_URLS = DATABASE_URL="postgres://ga_inspect_reader:scratch-reader-only@127.0.0.1:$$pgport/health_scratch?sslmode=disable" REDIS_URL="redis://:scratch-redis-only@127.0.0.1:$$redisport/0"

.PHONY: setup frontend build test vet check dev-api dev-web require-project db-up db-down services-check image smoke
image:
	docker build --build-arg VITE_CARTO_KEY="$${VITE_CARTO_KEY:-}" -t ga-health-inspect:local .
smoke: require-project
	PROJECT=$(PROJECT) bash scripts/smoke.sh
setup:
	npm --prefix web ci
frontend:
	npm --prefix web run build
build: frontend
	go build -o server .
test: frontend require-project
	@pgport=$$($(COMPOSE) port postgres 5432 | awk -F: '{print $$NF}'); redisport=$$($(COMPOSE) port redis 6379 | awk -F: '{print $$NF}'); \
	$(SERVICE_URLS) go test $(GO_PACKAGES) $(if $(TEST),-run '$(TEST)',)
vet: frontend
	go vet $(GO_PACKAGES)
check: frontend require-project
	npm --prefix web run check
	go vet $(GO_PACKAGES)
	@pgport=$$($(COMPOSE) port postgres 5432 | awk -F: '{print $$NF}'); redisport=$$($(COMPOSE) port redis 6379 | awk -F: '{print $$NF}'); \
	$(SERVICE_URLS) go test $(GO_PACKAGES)
dev-api: build require-project
	@set -e; \
	if [ -f .env.local ]; then set -a; source .env.local; set +a; fi; \
	if [ -n "$${PB_SUPERUSER_EMAIL:-}" ] && [ -n "$${PB_SUPERUSER_PASSWORD:-}" ]; then \
		./server superuser upsert "$$PB_SUPERUSER_EMAIL" "$$PB_SUPERUSER_PASSWORD"; \
	fi; \
	pgport=$$($(COMPOSE) port postgres 5432 | awk -F: '{print $$NF}'); redisport=$$($(COMPOSE) port redis 6379 | awk -F: '{print $$NF}'); smtpport=$$($(COMPOSE) port mailpit 1025 | awk -F: '{print $$NF}'); \
	$(SERVICE_URLS) APP_URL="$${APP_URL:-http://127.0.0.1:8090}" SMTP_HOST="$${SMTP_HOST:-127.0.0.1}" SMTP_PORT="$${SMTP_PORT:-$$smtpport}" ./server serve --http=127.0.0.1:8090

dev-web:
	npm --prefix web run dev
require-project:
	@case '$(PROJECT)' in ga-ui-*) [[ '$(PROJECT)' =~ ^ga-ui-[a-z0-9][a-z0-9_-]*$$ ]] || { echo 'Invalid scratch PROJECT' >&2; exit 1; };; *) echo 'PROJECT must start with ga-ui-' >&2; exit 1;; esac

db-up: require-project
	$(COMPOSE) up -d --wait

db-down: require-project
	$(COMPOSE) down -v

services-check: require-project
	@set -euo pipefail; \
	$(COMPOSE) exec -T -e PGPASSWORD=scratch-reader-only postgres psql -h 127.0.0.1 -U ga_inspect_reader -d health_scratch -v ON_ERROR_STOP=1 -c 'SELECT source_id FROM public.facilities ORDER BY source_id'; \
	if $(COMPOSE) exec -T -e PGPASSWORD=scratch-reader-only postgres psql -h 127.0.0.1 -U ga_inspect_reader -d health_scratch -v ON_ERROR_STOP=1 -c "DELETE FROM public.facilities" >/dev/null 2>&1; then echo 'reader can write' >&2; exit 1; fi; \
	$(COMPOSE) exec -T -e REDISCLI_AUTH=scratch-redis-only redis redis-cli ping | grep -qx PONG; \
	$(COMPOSE) exec -T redis redis-cli ping | grep -q NOAUTH; \
	smtp=$$($(COMPOSE) port mailpit 1025 | awk -F: '{print $$NF}'); http=$$($(COMPOSE) port mailpit 8025 | awk -F: '{print $$NF}'); \
	subject="scratch-probe-$$(date +%s)-$$$$"; \
	printf 'From: probe@example.test\r\nTo: recipient@example.test\r\nSubject: %s\r\n\r\nScratch service probe.\r\n' "$$subject" | curl -fsS --url "smtp://127.0.0.1:$$smtp" --mail-from probe@example.test --mail-rcpt recipient@example.test --upload-file -; \
	curl -fsS "http://127.0.0.1:$$http/api/v1/messages" | grep -q "$$subject"; \
	echo 'Restricted PostgreSQL, Redis authentication, and Mailpit SMTP checks passed.'
