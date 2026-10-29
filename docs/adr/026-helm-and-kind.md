# 026. Helm charts and a local kind cluster

- Status: accepted (branch `microservices` only)
- Date: 2026-10-29
- Amends: ADR 017 row "Helm, a real cluster, service mesh" (Helm and a local cluster are built
  on this branch; a real cluster and a service mesh stay out)
- Amended by: [ADR 029](029-api-gateway.md) (Envoy Gateway in kind: two more releases in
  `make kind-up`, `helm test gateway` in `make kind-smoke`; an `Ingress` controller stays out,
  the edge is the Gateway API)

## Context

`main` ships plain manifests in `deploy/k8s/`, validated with kubeconform and never applied
(lane 0005). ADR 017 named the condition for Helm and a cluster: "a target environment". On
this branch the target is a local kind cluster that runs the whole system: PostgreSQL, Kafka,
the mock OAuth2 server, capacity `api` and `worker`, `funding-service` and the mock payment
rail. Three deployables with shared configuration is where templating starts to pay.

## Decision

### Charts

Under `deploy/helm/`, one chart per owner:

| Chart | Contents | Production meaning |
| --- | --- | --- |
| `capacity` | ConfigMap, Secret, `api` Deployment and Service (HTTP 3000, gRPC 50051, ops 9464), `worker` Deployment, migrate Job as a `pre-install,pre-upgrade` hook | The capacity service as it would ship |
| `funding` | ConfigMap, Secret, `api` and `worker` Deployments, Service (HTTP, ops), migrate hook Job | The funding service as it would ship |
| `local-infra` | PostgreSQL 18 StatefulSet with an init script creating the `capacity` and `funding` databases and roles; Kafka 4 single-node KRaft StatefulSet and a topic Job; mock OAuth2; payments mock | **Local only.** Replaced by RDS, MSK, the bank's IdP and a real payment rail; never installed outside kind |

- The `capacity` templates are derived from `deploy/k8s/` and keep its probes on the ops port,
  `terminationGracePeriodSeconds: 40`, resources and the Secret for the database URL.
  `deploy/k8s/` stays as it is, as `main`'s reference manifests; on this branch the chart is
  the source.
- No public infrastructure charts (for example Bitnami): their images and licensing changed in
  2025, and a single-node PostgreSQL and Kafka for a local cluster need a few dozen lines.
- `make helm-check`: `helm lint` and `helm template` for every chart, the rendered output
  validated with kubeconform (as in lane 0005).

### Local cluster

- Cluster name `finverity-ms`, from `deploy/kind/cluster.yaml`: one node, **no
  `extraPortMappings`**, so the cluster binds no host port beyond the API server port that kind
  picks itself. Nothing can collide with `main`'s compose stack or the branch's own.
- The kubeconfig is written to `.kind/kubeconfig` (gitignored). Every `kubectl` and `helm`
  call in the Makefile passes `--kubeconfig .kind/kubeconfig --kube-context kind-finverity-ms`,
  so the targets never touch `~/.kube/config` or its current context.
- Images are built with the `:ms-local` tag and loaded with `kind load docker-image --name
  finverity-ms`; Pods use `imagePullPolicy: IfNotPresent`.
- Namespace `finverity-ms`. Releases install in order with `--wait`: `local-infra`, `capacity`,
  `funding`.
- `make kind-up` creates the cluster (if absent), builds and loads images and installs the
  charts. `make kind-smoke` runs `helm test funding`: a Pod inside the cluster mints tokens,
  creates funding requests and checks a completed path and a compensated path against
  capacity's numbers. Running it in the cluster keeps every token's issuer the in-cluster OAuth2
  address. `make kind-forward` port-forwards for manual use to host ports 23000–23099, a range
  neither stack uses. `make kind-down` runs `kind delete cluster --name finverity-ms`; the name
  is a constant in the Makefile, not a variable, so the target cannot delete another cluster.
- `make doctor` reports `kind`, `helm` and `kubectl` as warnings: only the kind targets need
  them.

### Out of scope, still

A real cluster or cloud account, an `Ingress` controller (the edge is the Gateway API of
ADR 029), HPA, NetworkPolicies (kind's default CNI does not enforce them), service mesh and
mTLS, GitOps, image registry. A kind job in CI is optional and
comes after the MVP cut.

## Consequences

- The same images run in compose and kind; the chart shows probes, hooks, config and secrets
  as a reviewer would expect.
- The local stack now has two ways to run; compose stays the fast loop, kind the "it deploys"
  check.

## Alternatives rejected

- **One umbrella chart.** It ties the funding and capacity release cycles together, which is
  the opposite of the split.
- **Kustomize over `deploy/k8s/`.** Workable, but the job description and most platforms
  expect Helm, and hooks for migrations are simpler there.
- **minikube or k3d.** kind runs in GitHub Actions without a VM and is already installed here.
