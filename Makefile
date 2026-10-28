SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose -f deploy/compose.yaml
TENANT ?= bank-a
SCOPES ?= capacity:read capacity:write

# Colour on a terminal unless NO_COLOR is set (https://no-color.org); FORCE_COLOR=1 forces it
# (CI logs). $(shell) captures stdout, so stderr stands in for "is this a terminal".
ifneq ($(FORCE_COLOR),)
  USE_COLOR := 1
else ifeq ($(NO_COLOR)$(shell test -t 2 || echo notty),)
  USE_COLOR := 1
endif
ifeq ($(USE_COLOR),1)
  C_RESET  := \033[0m
  C_BOLD   := \033[1m
  C_DIM    := \033[2m
  C_CYAN   := \033[36m
  C_GREEN  := \033[32m
  C_YELLOW := \033[33m
endif
step = @printf '$(C_CYAN)▸ %s$(C_RESET)\n' "$(1)"
done = @printf '$(C_GREEN)✔ %s$(C_RESET)\n' "$(1)"

.PHONY: help targets completion status check install up down ps logs seed token demo docs \
        verify test test-unit test-int contracts load dlq-replay

## Help
help: ## list every command (the default goal)
	@printf '$(C_BOLD)Program Capacity Service$(C_RESET) — make <target> [VAR=value]\n'
	@awk 'BEGIN { FS = ":.*## " } \
	  /^## / { printf "\n$(C_YELLOW)%s$(C_RESET)\n", substr($$0, 4) } \
	  /^[a-zA-Z0-9_-]+:.*## / { printf "  $(C_CYAN)%-12s$(C_RESET) %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\n$(C_YELLOW)Variables$(C_RESET)\n'
	@printf '  $(C_CYAN)%-12s$(C_RESET) %s\n' \
	  TENANT "tenant for make token: bank-a, bank-b, bank-c (now: $(TENANT))" \
	  SCOPES "token scopes (now: $(SCOPES))" \
	  TOPIC  "DLQ topic for make dlq-replay, e.g. treasury.capacity.v1.dlq" \
	  FROM   "first DLQ offset to replay" \
	  NO_COLOR "set to any value to turn colours off (FORCE_COLOR=1 forces them)"
	@printf '\n$(C_DIM)Tab completion: make completion$(C_RESET)\n'

targets: ## print target names, one per line (used by tab completion)
	@awk -F: '/^[a-zA-Z0-9_-]+:.*## / { print $$1 }' $(MAKEFILE_LIST)

completion: ## how to enable tab completion for targets and variables
	@printf 'bash: $(C_CYAN)source tools/completion.bash$(C_RESET)\n'
	@printf 'zsh:  $(C_CYAN)autoload -U +X compinit && compinit && autoload -U +X bashcompinit && bashcompinit && source tools/completion.bash$(C_RESET)\n'
	@printf '$(C_DIM)Add the line to ~/.bashrc or ~/.zshrc to keep it. It completes targets, TENANT= and TOPIC= values.$(C_RESET)\n'

## Session and gate helpers
status: ## harness check, last logged gate, last commits, next action
	@tools/status.sh

check: ## harness gates only
	@npx harnessimo check

install: ## install dependencies exactly as locked (npm ci)
	npm ci

## Local stack
up: ## build and start the stack, wait until every service is healthy
	$(call step,Starting PostgreSQL · Kafka · OAuth2 · migrate · api · worker)
	$(COMPOSE) up -d --build --wait
	$(call done,Stack is up — API on :3000 · Swagger UI on http://localhost:9464/docs)

down: ## stop the stack and delete its data
	$(COMPOSE) down -v --remove-orphans

ps: ## show the stack's containers and their health
	@$(COMPOSE) ps

logs: ## follow api and worker logs
	$(COMPOSE) logs -f --tail=100 api worker

seed: ## deterministic seed: tenants, programs, FX rates
	npm run seed

token: ## print a JWT: make token TENANT=bank-a SCOPES="capacity:read"
	@npm run --silent token -- --tenant "$(TENANT)" --scopes "$(SCOPES)"

demo: ## replay every documented scenario against the running stack
	npm run demo

docs: ## open Swagger UI (try the API in the browser)
	@open http://localhost:9464/docs 2>/dev/null || xdg-open http://localhost:9464/docs 2>/dev/null || \
	  printf 'Open http://localhost:9464/docs\n'

## Quality gates
verify: ## lint, types, layer rules, contract drift, unit and property tests
	$(call step,Lint and format)
	@npm run --silent lint
	$(call step,Types)
	@npm run --silent typecheck
	$(call step,Layer rules)
	@npm run --silent depcruise
	$(call step,OpenAPI contract matches the zod schemas)
	@npm run --silent contracts:check
	$(call step,Unit and property tests)
	@npm run --silent test:unit
	$(call done,verify passed)

test: ## every test level, real containers via Testcontainers
	$(call step,Unit and property tests)
	@npm run --silent test:unit
	$(call step,Integration · e2e · Kafka · fault tests (Docker))
	@npm run --silent test:int
	$(call done,all tests passed)

test-unit: ## unit and property tests only (no Docker)
	npm run test:unit

test-int: ## integration, e2e, Kafka and fault tests (Docker)
	npm run test:int

contracts: ## regenerate contracts/openapi.yaml from the zod schemas
	npm run contracts

load: ## k6 against the compose stack; fails when NFR-03 is missed
	npm run load

dlq-replay: ## republish fixed DLQ messages: make dlq-replay TOPIC=treasury.capacity.v1.dlq FROM=0
	npm run dlq-replay -- --topic "$(TOPIC)" --from "$(FROM)"
