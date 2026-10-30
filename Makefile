SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose -f deploy/compose.yaml

# Side-by-side with `main` (ADR 027): host ports are main's +10000. compose.yaml, tools/, db/seeds
# and tools/doctor.sh read these same variables; override one on the command line to move it.
export HOST_PORT_POSTGRES ?= 15432
export HOST_PORT_KAFKA ?= 39092
export HOST_PORT_OAUTH ?= 18081
export HOST_PORT_API ?= 13000
export HOST_PORT_API_GRPC ?= 60051
export HOST_PORT_API_OPS ?= 19464
export HOST_PORT_WORKER_OPS ?= 19465
export HOST_PORT_PROMETHEUS ?= 19090
export HOST_PORT_GRAFANA ?= 13001
export HOST_PORT_JAEGER ?= 26686
export HOST_PORT_OTLP ?= 14318
export HOST_PORT_KAFKA_UI ?= 18080

# Kubernetes names reserved for the kind targets (ADR 026); nothing here touches another cluster.
KIND_CLUSTER := finverity-ms
KUBECONFIG_FILE := .kind/kubeconfig
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

.PHONY: help targets completion status check doctor install up up-all down ps logs seed token demo qa docs \
        docs-events kafka-ui events verify helm-check compat test test-unit test-int contracts load dlq-replay isolation-live

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
	  BASE   "git ref make compat compares contracts/ with (default HEAD, as the proto rule of ADR 024)" \
	  FROM   "first DLQ offset to replay" \
	  NO_COLOR "set to any value to turn colours off (FORCE_COLOR=1 forces them)"
	@printf '\n$(C_DIM)Tab completion: make completion$(C_RESET)\n'

targets: ## print target names, one per line (used by tab completion)
	@awk -F: '/^[a-zA-Z0-9_-]+:.*## / { print $$1 }' $(MAKEFILE_LIST)

completion: ## how to enable tab completion for targets and variables
	@printf 'bash: $(C_CYAN)source tools/completion.bash$(C_RESET)\n'
	@printf 'zsh:  $(C_CYAN)autoload -U +X compinit && compinit && autoload -U +X bashcompinit && bashcompinit && source tools/completion.bash$(C_RESET)\n'
	@printf '$(C_DIM)Add the line to ~/.bashrc or ~/.zshrc to keep it. It completes targets, TENANT= and TOPIC= values.$(C_RESET)\n'

## Getting started
doctor: ## check this machine: Docker, Compose, Node.js 24, free ports
	@tools/doctor.sh

install: ## one command from a fresh clone: check requirements, npm ci, start the stack, seed it
	@tools/doctor.sh
	$(call step,Installing npm dependencies exactly as locked · npm ci)
	@npm ci --no-audit --no-fund
	@$(MAKE) --no-print-directory up
	@$(MAKE) --no-print-directory seed
	$(call done,Installed. Try: make docs (Swagger UI) · make docs-events (AsyncAPI) · make demo · make qa)

## Session and gate helpers
status: ## harness check, last logged gate, last commits, next action
	@tools/status.sh

check: ## harness gates only
	@npx harnessimo check

## Local stack
up: ## build and start the stack, wait until every service is healthy
	$(call step,Starting PostgreSQL · Kafka · OAuth2 · migrate · api · worker)
	$(COMPOSE) up -d --build --wait
	$(call done,Stack is up — API on :$(HOST_PORT_API) · Swagger UI on http://localhost:$(HOST_PORT_API_OPS)/docs · AsyncAPI on http://localhost:$(HOST_PORT_API_OPS)/docs/asyncapi)

up-all: ## the stack plus Kafka UI, Prometheus, Grafana and Jaeger, with tracing on
	$(call step,Starting the stack · Kafka UI · Prometheus · Grafana · Jaeger (OTEL_ENABLED=true))
	OTEL_ENABLED=true $(COMPOSE) --profile observability up -d --build --wait
	$(call done,Kafka UI http://localhost:$(HOST_PORT_KAFKA_UI) · Grafana http://localhost:$(HOST_PORT_GRAFANA) · Jaeger http://localhost:$(HOST_PORT_JAEGER) · Prometheus http://localhost:$(HOST_PORT_PROMETHEUS))

down: ## stop this branch's stack (project program-capacity-ms, observability profile included) and delete its data
	$(COMPOSE) --profile observability down -v --remove-orphans

ps: ## show the stack's containers and their health
	@$(COMPOSE) ps

logs: ## follow api and worker logs
	$(COMPOSE) logs -f --tail=100 api worker

seed: ## seed tenants, programs, FX rates, invoices (FX rates live 24 h: re-run on demo day)
	$(call step,Seeding 3 banks · 6 programs · FX rates · ~200 invoices)
	@npm run --silent seed
	@printf '$(C_YELLOW)! FX rates are valid for 24 h. On the day of a demo run make seed again$(C_RESET)\n'
	@printf '$(C_YELLOW)  or reservations in a foreign currency fail with fx-rate-unavailable.$(C_RESET)\n'

token: ## print a JWT: make token TENANT=bank-a SCOPES="capacity:read"
	@npm run --silent token -- --tenant "$(TENANT)" --scopes "$(SCOPES)"

demo: ## replay every documented scenario against the running stack
	npm run demo

qa: ## QA pass: every endpoint and treasury message, with DB/Kafka checks (docs/qa.md)
	@bash tools/qa/run.sh

docs: ## open Swagger UI (try the API in the browser)
	@open http://localhost:$(HOST_PORT_API_OPS)/docs 2>/dev/null || xdg-open http://localhost:$(HOST_PORT_API_OPS)/docs 2>/dev/null || \
	  printf 'Open http://localhost:$(HOST_PORT_API_OPS)/docs\n'

docs-events: ## open the AsyncAPI page: every Kafka topic, message, header and example
	@open http://localhost:$(HOST_PORT_API_OPS)/docs/asyncapi 2>/dev/null || \
	  xdg-open http://localhost:$(HOST_PORT_API_OPS)/docs/asyncapi 2>/dev/null || \
	  printf 'Open http://localhost:$(HOST_PORT_API_OPS)/docs/asyncapi\n'

kafka-ui: ## open Kafka UI (started by make up-all): topics, records, consumer lag (docs/qa.md)
	@open http://localhost:$(HOST_PORT_KAFKA_UI) 2>/dev/null || xdg-open http://localhost:$(HOST_PORT_KAFKA_UI) 2>/dev/null || \
	  printf 'Open http://localhost:$(HOST_PORT_KAFKA_UI)\n'

events: ## follow capacity.events.v1 from the beginning: headers | key | value (Ctrl-C stops)
	@$(COMPOSE) exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 \
	  --topic capacity.events.v1 --from-beginning --formatter-property print.key=true \
	  --formatter-property print.headers=true --formatter-property key.separator=' | '

## Quality gates
verify: ## lint, types, layer rules, contract drift, unit and property tests
	$(call step,Lint and format)
	@npm run --silent lint
	@npm run --silent lint --workspaces --if-present
	$(call step,Types)
	@npm run --silent typecheck
	@npm run --silent typecheck --workspaces --if-present
	$(call step,Layer rules)
	@npm run --silent depcruise
	@npm run --silent depcruise --workspaces --if-present
	$(call step,OpenAPI contract matches the zod schemas)
	$(call step,OpenAPI · AsyncAPI · JSON Schema contracts match the zod schemas)
	@npm run --silent contracts:check
	$(call step,Proto contract (lint, breaking changes, stub drift))
	@npm run --silent proto:lint
	@npm run --silent proto:breaking
	@npm run --silent proto:check
	$(call step,Unit and property tests)
	@npm run --silent test:unit
	@npm run --silent test:unit --workspaces --if-present
	$(call done,verify passed)

test: ## every test level, real containers via Testcontainers
	$(call step,Unit and property tests)
	@npm run --silent test:unit
	@npm run --silent test:unit --workspaces --if-present
	$(call step,Integration · e2e · Kafka · fault tests (Docker))
	@npm run --silent test:int
	@npm run --silent test:int --workspaces --if-present
	$(call done,all tests passed)

test-unit: ## unit and property tests only (no Docker)
	npm run test:unit

test-int: ## integration, e2e, Kafka and fault tests (Docker)
	npm run test:int

contracts: ## regenerate contracts/ (OpenAPI, AsyncAPI, JSON Schema) from the zod schemas
	npm run contracts

compat: ## no breaking contract change against BASE (default HEAD, as the proto rule of ADR 024): oasdiff + message schemas
	npm run contracts:compat -- --base "$(or $(BASE),HEAD)"

load: ## k6 against the compose stack; fails when NFR-03 is missed
	npm run load

isolation-live: ## prove main's stack and this branch's stack run together (MS-02)
	@bash tools/isolation-live.sh

helm-check: ## helm lint, helm template and kubeconform for every chart in deploy/helm (K8-01)
	@tools/helm-check.sh

dlq-replay: ## republish fixed DLQ messages: make dlq-replay TOPIC=treasury.capacity.v1.dlq FROM=0
	npm run dlq-replay -- --topic "$(TOPIC)" --from "$(FROM)"
