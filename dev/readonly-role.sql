CREATE ROLE ga_inspect_reader LOGIN PASSWORD 'scratch-reader-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6;
GRANT CONNECT ON DATABASE health_scratch TO ga_inspect_reader;
GRANT USAGE ON SCHEMA public TO ga_inspect_reader;
GRANT SELECT ON public.facilities, public.inspections, public.current_violations, public.gnr_inspections, public.etl_runs TO ga_inspect_reader;
ALTER ROLE ga_inspect_reader IN DATABASE health_scratch SET default_transaction_read_only = on;
ALTER ROLE ga_inspect_reader IN DATABASE health_scratch SET statement_timeout = '3s';
ALTER ROLE ga_inspect_reader IN DATABASE health_scratch SET idle_in_transaction_session_timeout = '10s';
