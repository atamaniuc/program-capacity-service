#!/bin/sh
# Database per service (ADR 023). Runs once, as the bootstrap role `postgres`, when the data
# directory is empty. Locally both databases share one server; each has its own login role, owns
# its database, and nobody else may connect to it. Neither service role is a superuser.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE capacity LOGIN PASSWORD 'capacity';
CREATE DATABASE capacity OWNER capacity;
CREATE ROLE funding LOGIN PASSWORD 'funding';
CREATE DATABASE funding OWNER funding;
REVOKE ALL ON DATABASE capacity FROM PUBLIC;
REVOKE ALL ON DATABASE funding FROM PUBLIC;
SQL
