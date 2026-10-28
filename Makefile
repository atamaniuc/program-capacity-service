SHELL := /bin/bash
COMPOSE := docker compose -f deploy/compose.yaml
TENANT ?= bank-a
SCOPES ?= capacity:read capacity:write

.PHONY: status check install up down logs seed token demo verify test test-unit test-int contracts load dlq-replay

## Session and gate helpers
status: ## harness check, last logged gate, last commits, next action
	@tools/status.sh

check: ## harness gates only
	@npx harnessimo check

install:
	npm ci

## Local stack
up: ## build and start the default compose profile
	$(COMPOSE) up -d --build --wait

down:
	$(COMPOSE) down -v --remove-orphans

logs:
	$(COMPOSE) logs -f --tail=100 api worker

seed: ## deterministic seed: tenants, programs, FX rates
	npm run seed

token: ## print a JWT: make token TENANT=bank-a SCOPES="capacity:read"
	@npm run --silent token -- --tenant "$(TENANT)" --scopes "$(SCOPES)"

demo: ## replay every documented scenario against the running stack
	npm run demo

## Quality gates
verify: ## lint, types, layer rules, unit and property tests
	npm run lint
	npm run typecheck
	npm run depcruise
	npm run contracts:check
	npm run test:unit

test: ## every test level, real containers via Testcontainers
	npm run test

test-unit:
	npm run test:unit

test-int:
	npm run test:int

contracts: ## regenerate contracts/openapi.yaml from the zod schemas
	npm run contracts

load: ## k6 against the compose stack (M4)
	npm run load

dlq-replay: ## republish fixed DLQ messages: make dlq-replay TOPIC=treasury.capacity.v1.dlq FROM=0
	npm run dlq-replay -- --topic "$(TOPIC)" --from "$(FROM)"
