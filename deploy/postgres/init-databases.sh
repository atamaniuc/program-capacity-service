#!/bin/sh
# The local POC gives each persistent service a private schema in the same database.
# This job can also run on a volume that still holds the earlier service databases.
set -eu

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
SELECT 'CREATE ROLE capacity LOGIN PASSWORD ''capacity'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'capacity')
\gexec
SELECT 'CREATE ROLE funding LOGIN PASSWORD ''funding'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'funding')
\gexec
SELECT 'CREATE DATABASE finverity'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'finverity')
\gexec

\connect finverity
BEGIN;
REVOKE ALL ON DATABASE finverity FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS capacity AUTHORIZATION capacity;
CREATE SCHEMA IF NOT EXISTS funding AUTHORIZATION funding;
GRANT CONNECT ON DATABASE finverity TO capacity, funding;
-- The workflow package creates its own funding-only journal schema.
GRANT CREATE ON DATABASE finverity TO funding;
ALTER ROLE capacity IN DATABASE finverity SET search_path TO capacity;
ALTER ROLE funding IN DATABASE finverity SET search_path TO funding;
COMMIT;
SQL
