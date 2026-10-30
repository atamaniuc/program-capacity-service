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
KIND_NAMESPACE := finverity-ms
# Every kubectl and helm call names the kubeconfig and context: the default kubeconfig is never read or written.
KUBECTL := kubectl --kubeconfig $(KUBECONFIG_FILE) --context kind-$(KIND_CLUSTER) --namespace $(KIND_NAMESPACE)
# In-cluster Service ports (the charts' defaults), not host ports.
OAUTH_SVC_PORT := 8080
# The one issuer string of the kind deployment (ADR 029): the in-cluster FQDN of the mock OAuth2
# Service. Passed to capacity, funding and gateway; tokens are minted at this address.
KIND_OAUTH_ISSUER := http://oauth.$(KIND_NAMESPACE).svc.cluster.local:$(OAUTH_SVC_PORT)/default
ENVOY_GATEWAY_VERSION := v1.9.3
GATEWAY_PROXY_SERVICE := gateway-edge
CAP_HTTP_PORT := 3000
CAP_OPS_PORT := 9464
PG_SVC_PORT := 5432
HELM := helm --kubeconfig $(KUBECONFIG_FILE) --kube-context kind-$(KIND_CLUSTER) --namespace $(KIND_NAMESPACE)
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
        docs-events kafka-ui events verify helm-check kind-up kind-seed kind-smoke kind-forward kind-down kind-token compat test test-unit test-int contracts load dlq-replay isolation-live

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

## Kubernetes (kind, ADR 026): cluster finverity-ms, kubeconfig in .kind/kubeconfig only
kind-up: ## create the kind cluster, build and load the :ms-local images, install the charts (K8-02)
	$(call step,Cluster $(KIND_CLUSTER) · kubeconfig $(KUBECONFIG_FILE))
	@mkdir -p .kind
	@kind export kubeconfig --name $(KIND_CLUSTER) --kubeconfig $(KUBECONFIG_FILE) >/dev/null 2>&1 || \
	  kind create cluster --name $(KIND_CLUSTER) --config deploy/kind/cluster.yaml --kubeconfig $(KUBECONFIG_FILE) --wait 120s
	$(call step,Images · program-capacity-service funding-service payments-mock (:ms-local))
	docker build -t program-capacity-service:ms-local .
	@for svc in funding payments-mock; do \
	  if [ -f services/$$svc/Dockerfile ]; then \
	    img=$$([ $$svc = funding ] && echo funding-service || echo payments-mock); \
	    docker build -f services/$$svc/Dockerfile -t $$img:ms-local . || exit 1; \
	  else printf '$(C_YELLOW)! services/%s has no Dockerfile yet: its release is skipped$(C_RESET)\n' $$svc; fi; done
	kind load docker-image --name $(KIND_CLUSTER) program-capacity-service:ms-local
	@for img in funding-service payments-mock; do \
	  if docker image inspect $$img:ms-local >/dev/null 2>&1; then kind load docker-image --name $(KIND_CLUSTER) $$img:ms-local || exit 1; fi; done
	$(call step,Releases · local-infra · capacity · funding)
	$(HELM) upgrade --install local-infra deploy/helm/local-infra --create-namespace --wait --timeout 6m \
	  --set paymentsMock.enabled=$$(docker image inspect payments-mock:ms-local >/dev/null 2>&1 && echo true || echo false)
	$(HELM) upgrade --install capacity deploy/helm/capacity --wait --timeout 6m \
	  --set-string oauth.issuer=$(KIND_OAUTH_ISSUER) --set-string corsOrigins=
	@if docker image inspect funding-service:ms-local >/dev/null 2>&1; then \
	  $(HELM) upgrade --install funding deploy/helm/funding --wait --timeout 6m \
	    --set-string oauth.issuer=$(KIND_OAUTH_ISSUER) --set-string oauth.tokenUrl=$(KIND_OAUTH_ISSUER)/token \
	    --set-string corsOrigins=; \
	else printf '$(C_YELLOW)! funding-service:ms-local is not built yet: the funding release is skipped$(C_RESET)\n'; fi
	@$(MAKE) --no-print-directory kind-seed
	$(call step,API gateway · Envoy Gateway $(ENVOY_GATEWAY_VERSION) · release gateway)
	$(HELM) upgrade --install eg \
	  oci://docker.io/envoyproxy/gateway-helm --version $(ENVOY_GATEWAY_VERSION) \
	  --namespace envoy-gateway-system --create-namespace --wait --timeout 6m
	$(HELM) upgrade --install gateway deploy/helm/gateway --wait --timeout 6m \
	  --set-string issuer=$(KIND_OAUTH_ISSUER) \
	  --set test.fundingDeployed=$$(docker image inspect funding-service:ms-local >/dev/null 2>&1 && echo true || echo false)
	@# The release wait does not cover the proxy Pod that Envoy Gateway creates later: wait for the Gateway and that Deployment.
	$(KUBECTL) wait gateway/edge --for=condition=Programmed --timeout=180s
	$(KUBECTL) --namespace envoy-gateway-system wait deployment -l gateway.envoyproxy.io/owning-gateway-name=edge --for=condition=Available --timeout=180s
	$(KUBECTL) get pods
	$(call done,Cluster up. Try: make kind-smoke · make kind-forward)

kind-seed: ## seed capacity's database in kind through a short port-forward (programs for the smoke)
	$(call step,Seed · capacity database through 127.0.0.1:23040)
	@$(KUBECTL) port-forward --address 127.0.0.1 svc/postgres 23040:$(PG_SVC_PORT) >/dev/null & pf=$$!; \
	trap 'kill $$pf 2>/dev/null' EXIT; \
	for i in $$(seq 1 30); do nc -z 127.0.0.1 23040 2>/dev/null && break; sleep 1; done; \
	DATABASE_URL=postgres://capacity:capacity@127.0.0.1:23040/capacity npm run --silent seed

kind-smoke: ## in-cluster tests: helm test capacity and funding (K8-03)
	$(HELM) test capacity --logs --timeout 3m
	@if $(HELM) status funding >/dev/null 2>&1; then $(HELM) test funding --logs --timeout 3m; \
	else printf '$(C_YELLOW)! funding release not installed: only capacity was tested$(C_RESET)\n'; fi
	$(HELM) test gateway --logs --timeout 5m
	$(call done,kind smoke passed)

kind-forward: ## port-forward to host ports 23000-23099 (Ctrl-C stops): capacity 23000-23002, funding 23010, oauth 23020
	@echo "gateway :23050 | capacity http :23000 · grpc :23001 · ops :23002 | funding http :23010 | oauth :23020 | payments :23030 | postgres :23040"
	@trap 'kill 0' INT TERM EXIT; \
	$(KUBECTL) port-forward --address 127.0.0.1 svc/capacity-api 23000:$(CAP_HTTP_PORT) 23001:50051 23002:$(CAP_OPS_PORT) & \
	$(KUBECTL) --namespace envoy-gateway-system port-forward --address 127.0.0.1 svc/$(GATEWAY_PROXY_SERVICE) 23050:80 & \
	$(KUBECTL) port-forward --address 127.0.0.1 svc/oauth 23020:$(OAUTH_SVC_PORT) & \
	$(KUBECTL) port-forward --address 127.0.0.1 svc/postgres 23040:$(PG_SVC_PORT) & \
	if $(KUBECTL) get svc funding-api >/dev/null 2>&1; then $(KUBECTL) port-forward --address 127.0.0.1 svc/funding-api 23010:3100 & fi; \
	if $(KUBECTL) get svc payments-mock >/dev/null 2>&1; then $(KUBECTL) port-forward --address 127.0.0.1 svc/payments-mock 23030:$(OAUTH_SVC_PORT) & fi; \
	wait

kind-token: ## print a JWT valid in kind (issuer = the cluster issuer): make kind-token TENANT=bank-a (needs make kind-forward)
	@curl -fsS -X POST -H 'Host: oauth.$(KIND_NAMESPACE).svc.cluster.local:$(OAUTH_SVC_PORT)' \
	  -d 'grant_type=client_credentials&client_id=$(TENANT)&client_secret=s&scope=$(SCOPES)' \
	  http://127.0.0.1:23020/default/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/'

kind-down: ## delete cluster finverity-ms (and only it) and its kubeconfig
	kind delete cluster --name $(KIND_CLUSTER) --kubeconfig $(KUBECONFIG_FILE)
	@rm -rf .kind

dlq-replay: ## republish fixed DLQ messages: make dlq-replay TOPIC=treasury.capacity.v1.dlq FROM=0
	npm run dlq-replay -- --topic "$(TOPIC)" --from "$(FROM)"
