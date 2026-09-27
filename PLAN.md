# Production deployment for Plan collab — OpenSpec Plan


---

# Proposal

# Production Deployment for Plan Collab

## Motivation
Nexolab OpenSpec currently runs as a local Docker Compose stack suited only for development. To serve real teams, it must be deployed on a hardened, internet-accessible infrastructure that delivers secure HTTPS access, persistent and backed-up data, real-time collaborative editing via Yjs, LLM-driven planning via a LiteLLM proxy, and production-grade notifications — all without introducing unnecessary operational complexity. The intake answers identify AWS (EKS + RDS), Nginx + Let's Encrypt, AWS Secrets Manager, and a full observability stack (CloudWatch, OpenTelemetry, Sentry) as the target environment.

## Proposed Change

### Infrastructure
- **Kubernetes on EKS** — deploy backend and frontend as separate `Deployment` workloads with `HorizontalPodAutoscaler` and liveness/readiness probes mirroring the existing Docker Compose `healthcheck` definitions.
- **Nginx Ingress + Cert-Manager (Let's Encrypt)** — terminate HTTPS at the cluster edge; proxy `/api`, `/ws` (Yjs), and static frontend paths appropriately.
- **Amazon RDS for PostgreSQL 16** — replace the dev `postgres` container; retain the existing `db-migrate` pattern (`backend/src/migrate.ts`) as a Kubernetes `Job` run pre-deploy.
- **Persistent Volumes (EBS)** — back the `/data/repos`, `/data/worktrees`, `/data/snapshots`, and `/data/user-credentials` volume mounts that the backend already declares in `docker-compose.yml`.
- **Automated daily RDS snapshots** — via AWS-native automated backup retention; no additional tooling required.

### Secret Management
- All sensitive values (`DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `GIT_TOKEN`, `LITELLM_API_KEY`, etc. from `.env.example`) stored in **AWS Secrets Manager**; injected into pods via the AWS Secrets Store CSI Driver as environment variables, matching the exact env-var names the application already reads.

### Application Services
- **Backend** — existing `backend/Dockerfile` promoted to production image; `NODE_ENV=production`, `REVIEWER_MODE=real`; LLM wired to the team's LiteLLM VPN base URL + API key via `LITELLM_BASE_URL` / `LITELLM_API_KEY`.
- **Frontend** — existing `frontend/Dockerfile` (Nginx static build) deployed as a separate pod behind the Ingress.
- **Yjs WebSocket** — `backend/src/yjs/server.ts` exposed through a dedicated Ingress path with WebSocket upgrade support.
- **GitHub integration** — fine-grained Personal Access Token stored in Secrets Manager; injected as `GIT_TOKEN`, consumed by `backend/src/git/askpass.sh` — no code changes required.
- **Production SMTP** — `SMTP_URL` set to the team's production mail provider DSN; `mailhog` service not deployed.

### Observability
- **Structured JSON logging** — `NODE_ENV=production` already switches the app to stdout JSON; logs shipped to **CloudWatch Logs** via the Fluent Bit DaemonSet.
- **Health-check alerting** — CloudWatch Alarms on EKS pod restarts + RDS `FreeStorageSpace` / `DatabaseConnections` metrics; SNS → email/Slack.
- **Distributed tracing** — OpenTelemetry Collector sidecar; traces exported to an OTLP-compatible backend (e.g., AWS X-Ray or Grafana Tempo).
- **Error tracking** — Sentry DSN injected as `SENTRY_DSN`; Sentry SDK added to backend and frontend builds.

### CI/CD
- GitHub Actions workflow: build & push Docker images to ECR → run `db-migrate` Job → rolling `kubectl rollout` update.

## Success Criteria
1. **HTTPS reachability** — the application is accessible at the production domain over TLS 1.2+; Let's Encrypt certificate auto-renews without manual intervention.
2. **Data persistence & backups** — all PostgreSQL data survives a pod or node restart; automated daily RDS snapshots are retained for ≥ 7 days and a restore has been verified.
3. **LLM integration functional** — an end-to-end planning run completes successfully through the LiteLLM VPN proxy with `REVIEWER_MODE=real`.
4. **GitHub commit flow works** — a finished planning stage triggers a `PLAN.md` commit to the target repo via the GitHub PAT with zero plaintext token exposure in logs or process arguments.
5. **Real-time collaboration** — two simultaneous browser sessions show live Yjs document sync with no WebSocket errors in production.
6. **Observability active** — structured logs appear in CloudWatch, at least one Sentry error event is captured end-to-end in staging, and an OpenTelemetry trace is visible for a planning-stage request.

## Out of Scope
- **Multi-region / disaster-recovery failover** — single-region EKS deployment only; cross-region replication is deferred.
- **Auto-scaling based on LLM queue depth** — HPA scales on CPU/memory only; custom-metrics autoscaling is not included in this release.
- **GitLab integration** — `backend/src/git/providers/gitlab.ts` exists but production secret management and testing for GitLab tokens are deferred.
- **Self-hosted LiteLLM deployment** — the LiteLLM proxy itself is assumed to exist and be reachable via VPN; provisioning or managing it is out of scope.
- **Blue/green or canary deployments** — initial rollout uses a simple rolling update strategy; advanced deployment patterns are deferred.

---

# Spec

# Spec — Production Deployment for Plan Collab

## Behaviors

- The application is reachable at a public domain over HTTPS (TLS 1.2+) with a certificate automatically provisioned and renewed by Let's Encrypt via Cert-Manager.
- All HTTP traffic on port 80 is permanently redirected to HTTPS; no unencrypted traffic reaches application services.
- The Nginx Ingress routes `/api/*` and `/yjs/*` paths to the backend service and serves the frontend static build for all other paths, transparently handling WebSocket upgrades on the `/yjs/*` path.
- The backend and frontend run as separate, independently scalable Kubernetes `Deployment` workloads on EKS with liveness and readiness probes that match the existing `GET /health` and `curl -sf http://localhost:4000/health` healthcheck definitions.
- Database schema migrations (`backend/src/migrate.ts`) execute automatically as a Kubernetes `Job` before each rolling deployment and must complete successfully before new backend pods receive traffic.
- All sensitive configuration values (`DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `GIT_TOKEN`, `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_MODEL`, `SENTRY_DSN`) are sourced exclusively from AWS Secrets Manager and injected into pods as environment variables via the AWS Secrets Store CSI Driver; no secrets appear in container images, Kubernetes manifests, or source control.
- The backend connects to an Amazon RDS for PostgreSQL 16 instance in place of the development `postgres` container; all application data persists across pod restarts and node failures.
- The four backend volume mounts (`/data/repos`, `/data/worktrees`, `/data/snapshots`, `/data/user-credentials`) are backed by EBS-backed Kubernetes `PersistentVolumeClaims`; data survives pod restarts.
- Automated daily RDS snapshots are retained for a minimum of 7 days; no application-level backup tooling is required.
- The LLM subsystem (`backend/src/llm/client.ts`) connects to the team's LiteLLM VPN proxy using `LITELLM_BASE_URL` and `LITELLM_API_KEY`; end-to-end planning runs complete with `REVIEWER_MODE=real`.
- The GitHub integration (`backend/src/git/providers/github.ts`, `askpass.sh`) uses a fine-grained Personal Access Token stored in Secrets Manager as `GIT_TOKEN`; completed planning stages trigger a `PLAN.md` commit to the target repository without requiring any code changes.
- Production SMTP (`SMTP_URL`) delivers magic-link authentication emails; the development `mailhog` service is not deployed in production.
- The Yjs WebSocket server (`backend/src/yjs/server.ts`) supports real-time collaborative editing for multiple concurrent users within a feature; Yjs document snapshots persist to the EBS-backed `/data/snapshots` volume.
- Backend pods emit structured JSON logs to stdout; logs are collected by the Fluent Bit DaemonSet and shipped to CloudWatch Logs.
- CloudWatch Alarms fire on EKS pod restart spikes and RDS `FreeStorageSpace` / `DatabaseConnections` threshold breaches, with notifications delivered via SNS to email and/or Slack.
- Distributed traces are emitted via OpenTelemetry and exported to an OTLP-compatible backend (AWS X-Ray or equivalent).
- Sentry error tracking is active in both backend and frontend builds; unhandled exceptions are reported to the configured Sentry DSN.
- A GitHub Actions CI/CD pipeline builds and pushes Docker images to ECR, runs the migration Job, and performs a rolling `kubectl rollout` update on each merge to the production branch.
- `HorizontalPodAutoscaler` resources are defined for the backend and frontend Deployments to scale pods based on CPU/memory load.

---

## APIs / Data Changes

### Environment Variables (new production values; no code changes required)

| Variable | Description |
|---|---|
| `DATABASE_URL` | RDS PostgreSQL 16 connection string |
| `SESSION_SECRET` | 32-byte hex secret (from Secrets Manager) |
| `SMTP_URL` | Production SMTP DSN (nodemailer format) |
| `PUBLIC_BASE_URL` | Public HTTPS domain (e.g. `https://app.example.com`) |
| `GIT_TOKEN` | GitHub PAT with `contents: read+write` scope |
| `LITELLM_BASE_URL` | LiteLLM VPN proxy base URL |
| `LITELLM_API_KEY` | LiteLLM API key |
| `LITELLM_MODEL` | Model name passed to LiteLLM proxy |
| `REVIEWER_MODE` | Set to `real` in production |
| `NODE_ENV` | Set to `production` |
| `SENTRY_DSN` | Sentry ingest URL for backend and frontend |
| `SNAPSHOTS_DIR` | Path to EBS-backed snapshots mount (default `/data/snapshots`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint |
| `OTEL_SERVICE_NAME` | Service name tag for traces |

### Existing Endpoints (no signature changes; behavioral notes only)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Used as Kubernetes liveness and readiness probe target; must return `{ ok: true }` with HTTP 200 |
| `GET` | `/yjs/:featureId` | WebSocket upgrade; Ingress must pass `Upgrade: websocket` header |
| `GET` | `/api/notify/features` | SSE long-poll; Ingress `proxy_read_timeout` must be ≥ 60 s |
| `GET` | `/api/features/:id/chat/stream` | SSE long-poll; same timeout requirement as above |
| All others | `/api/*` | Standard REST; no changes |

### New Kubernetes Resources (infrastructure schema)

| Resource Kind | Name | Purpose |
|---|---|---|
| `Namespace` | `openspec` | Isolates all workloads |
| `Deployment` | `backend` | Backend pods (existing Dockerfile) |
| `Deployment` | `frontend` | Frontend Nginx static pods (existing Dockerfile) |
| `Service` | `backend`, `frontend` | ClusterIP services for Ingress routing |
| `HorizontalPodAutoscaler` | `backend`, `frontend` | CPU/memory-based autoscaling |
| `Ingress` | `openspec` | Nginx Ingress with TLS + path-based routing |
| `Certificate` | `openspec-tls` | Cert-Manager Let's Encrypt certificate |
| `Job` | `db-migrate` | Pre-deploy migration runner |
| `PersistentVolumeClaim` | `repos`, `worktrees`, `snapshots`, `user-credentials` | EBS-backed volumes for backend |
| `SecretProviderClass` | `openspec-secrets` | AWS Secrets Store CSI Driver mapping |

### Database

No new tables or schema changes are introduced by this deployment. All existing migrations (`001`–`005`) continue to be applied via the existing `runMigrations()` call at backend startup, now also executed as a pre-deploy Kubernetes Job.

---

## Acceptance Criteria

### 1. HTTPS Reachability and TLS

```
Given: a DNS A record points the production domain to the Nginx Ingress load balancer
  and: Cert-Manager and the Let's Encrypt ClusterIssuer are configured
 When: a user navigates to http://<domain>
 Then: the browser is redirected to https://<domain> with HTTP 301
  and: the TLS certificate is valid, not self-signed, and issued for the correct domain
  and: the certificate auto-renews before expiry without manual intervention
```

### 2. Secure Secret Injection

```
Given: all secrets are stored in AWS Secrets Manager
  and: the SecretProviderClass is deployed with correct ARN mappings
 When: a backend pod starts
 Then: all required env vars (DATABASE_URL, SESSION_SECRET, GIT_TOKEN, LITELLM_API_KEY, etc.)
       are present and non-empty inside the container
  and: no secret values appear in the pod spec YAML, Kubernetes Secrets, or application logs
```

### 3. Database Persistence and Migrations

```
Given: an RDS PostgreSQL 16 instance is provisioned and DATABASE_URL is injected
 When: the db-migrate Job runs before a rolling deployment
 Then: all migrations complete successfully (exit 0) before new backend pods receive traffic
  and: if the migration Job fails, the deployment is halted and existing pods continue serving traffic
 When: a backend pod is deleted or a node is replaced
 Then: a new pod reconnects to RDS and serves requests without data loss
```

### 4. Automated Backups and Restore

```
Given: RDS automated backups are enabled with a 7-day retention window
 When: 24 hours have elapsed since the last backup
 Then: a new automated snapshot exists in the RDS console
 When: a restore drill is performed from any snapshot
 Then: a restored RDS instance contains all data committed prior to the snapshot time
```

### 5. Persistent Volume Survival

```
Given: the backend has EBS-backed PVCs for /data/repos, /data/worktrees,
       /data/snapshots, and /data/user-credentials
 When: a backend pod is killed and rescheduled (on the same AZ)
 Then: all four volume mounts are reattached and data written before the restart is intact
```

### 6. LLM Integration via LiteLLM Proxy

```
Given: LITELLM_BASE_URL points to the team VPN LiteLLM proxy
  and: LITELLM_API_KEY and LITELLM_MODEL are correctly set
  and: REVIEWER_MODE=real
 When: a user triggers a planning stage run
 Then: the stage completes end-to-end, the LLM response is processed, and an artifact is produced
  and: the backend logs show no LLM connection errors
```

### 7. GitHub PLAN.md Commit

```
Given: GIT_TOKEN is a valid GitHub PAT with contents read+write on the target repo
 When: a planning stage finishes and the commit flow is triggered
 Then: a PLAN.md file is committed and pushed to the target GitHub repository
  and: the GIT_TOKEN value is never visible in git history, application logs, or process arguments
```

### 8. Magic-Link Email via Production SMTP

```
Given: SMTP_URL is set to the production mail provider DSN
  and: PUBLIC_BASE_URL is set to the production HTTPS domain
 When: a user requests a magic-link login
 Then: an email is delivered to the user's inbox containing a valid one-time login URL
  and: the URL uses the production HTTPS domain
  and: no email is routed to mailhog or any dev mail sink
```

### 9. Yjs Real-Time Collaboration

```
Given: two authenticated users have the same feature open
 When: one user makes an edit via the Yjs WebSocket (/yjs/:featureId)
 Then: the change is propagated to the other user's session within 1 second under normal network conditions
 When: all users disconnect and later reconnect
 Then: the Yjs document state is restored from the /data/snapshots EBS volume
```

### 10. Liveness and Readiness Probes

```
Given: a backend pod is running
 When: GET /health is called
 Then: it returns HTTP 200 with body { "ok": true } within 2 seconds
 When: the backend is not yet ready (e.g., migrations still running)
 Then: the readiness probe fails and the pod is not added to the Service endpoints
  and: the liveness probe does not kill the pod during the initialDelaySeconds window
```

### 11. Structured Logging and CloudWatch Shipping

```
Given: NODE_ENV=production and the Fluent Bit DaemonSet is deployed
 When: the backend handles any request or emits a log line
 Then: the log entry is valid JSON and appears in the designated CloudWatch Log Group within 60 seconds
```

### 12. Alerting

```
Given: CloudWatch Alarms are configured for pod restarts, RDS FreeStorageSpace, and DatabaseConnections
 When: a backend pod restarts more than N times within 5 minutes
   or: RDS FreeStorageSpace drops below the configured threshold
 Then: an SNS notification is delivered to the configured email/Slack endpoint within 5 minutes
```

### 13. Distributed Tracing

```
Given: the OpenTelemetry SDK is initialised and OTEL_EXPORTER_OTLP_ENDPOINT is set
 When: a user makes an API request that invokes the LLM or database
 Then: a trace with spans for the HTTP request, DB query, and LLM call appears in the OTLP backend
```

### 14. Error Tracking (Sentry)

```
Given: SENTRY_DSN is injected and the Sentry SDK is initialised in backend and frontend
 When: an unhandled exception occurs in the backend or an unhandled JS error occurs in the frontend
 Then: the event is captured and visible in the Sentry project dashboard within 30 seconds
```

### 15. CI/CD Rolling Deployment

```
Given: a commit is merged to the production branch
 When: the GitHub Actions workflow runs
 Then: new Docker images are built and pushed to ECR
  and: the db-migrate Job runs and completes successfully
  and: a rolling kubectl rollout replaces pods without downtime
  and: if the migration Job fails, the rollout is aborted and existing pods remain serving
```

---

## Non-Functional Requirements

### Security
- TLS 1.2 minimum enforced at the Nginx Ingress level; TLS 1.3 preferred.
- All secrets sourced from AWS Secrets Manager; zero secrets in Kubernetes `Secret` objects created manually, pod specs, or source control.
- `GIT_TOKEN` must never appear in process argument lists, application logs, or git history; the existing `GIT_ASKPASS` mechanism satisfies this and must be preserved unchanged.
- Backend CORS `origin` must be set to the production domain only (`PUBLIC_BASE_URL`); wildcard origins are not permitted.
- RDS instance must not be publicly accessible; connectivity only from within the EKS VPC via security group rules.
- EBS volumes must be encrypted at rest.
- RDS storage must be encrypted at rest.

### Performance
- Backend liveness probe must respond within 2 seconds under normal load.
- Yjs document changes must propagate to all connected clients within 1 second under normal network conditions.
- Rolling deployments must complete with zero downtime; pods must pass readiness probes before traffic is shifted.

### Reliability and Data Durability
- RDS automated snapshots retained for ≥ 7 days.
- EBS PVC data must survive pod restarts (node AZ affinity must be respected for EBS volumes).
- `HorizontalPodAutoscaler` must maintain a minimum of 1 replica for each Deployment at all times.

### Observability
- All backend log lines in production must be valid JSON.
- Logs must be shipped to CloudWatch within 60 seconds of emission.
- CloudWatch Alarms must notify within 5 minutes of threshold breach.
- Sentry events must appear within 30 seconds of an unhandled exception.
- OpenTelemetry traces must capture HTTP, DB, and LLM spans per request.

### Maintainability
- The deployment must not introduce infrastructure components beyond those specified (no service mesh, no external secret operator beyond CSI Driver, no message queue).
- All Kubernetes manifests must be stored in source control alongside the application code.
- The CI/CD pipeline must be the sole mechanism for promoting images to production; no manual `kubectl apply` of application manifests should be required for routine deployments.

---

# Design

# Design — Production Deployment for Plan Collab

## Architecture Overview

Nexolab OpenSpec is a monorepo with a Node.js/Fastify backend (`backend/`) and a static Nginx frontend (`frontend/`), currently wired together via Docker Compose for local development. This feature lifts that stack onto AWS EKS — the two services become separate Kubernetes `Deployment` workloads behind a single Nginx Ingress Controller that terminates HTTPS (Let's Encrypt via Cert-Manager) and routes `/api/*`, `/yjs/*` (WebSocket), and all other paths to the backend and frontend pods respectively. The development `postgres` container is replaced by Amazon RDS for PostgreSQL 16, and the four named Docker volumes (`repos`, `worktrees`, `snapshots`, `user-credentials`) are replaced by EBS-backed `PersistentVolumeClaims`. No application source code changes are required; the deployment exclusively adds infrastructure artefacts (Kubernetes manifests, a GitHub Actions workflow, and AWS resource configuration).

## Key Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **EKS with Nginx Ingress + Cert-Manager** | Matches the intake selection; Cert-Manager automates Let's Encrypt issuance and renewal without manual intervention, and the Nginx Ingress handles both HTTPS termination and WebSocket upgrades for the `/yjs/:featureId` path already defined in `backend/src/index.ts`. |
| 2 | **AWS Secrets Manager + Secrets Store CSI Driver** | Injects all secrets from `.env.example` (`DATABASE_URL`, `SESSION_SECRET`, `SMTP_URL`, `GIT_TOKEN`, `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_MODEL`, `SENTRY_DSN`) as environment variables at pod start time, keeping them out of images, manifests, and source control — matching the exact variable names the application already reads. |
| 3 | **Migration as a Kubernetes pre-deploy Job** | `backend/src/migrate.ts` already implements idempotent schema migrations; wrapping it in a `Job` with `initContainer`-style ordering guarantees schema is current before new backend pods receive traffic, preserving the existing migration flow without code changes. |
| 4 | **EBS-backed PersistentVolumeClaims for stateful backend paths** | The Yjs server (`backend/src/yjs/server.ts`) writes `.ydoc` snapshots to `/data/snapshots`; the git worker uses `/data/repos` and `/data/worktrees`; auth uses `/data/user-credentials`. EBS volumes provide durable single-AZ block storage matching the existing filesystem API surface without requiring object-storage refactoring. |
| 5 | **LiteLLM VPN proxy via existing OpenAI-compat SDK** | `backend/src/llm/client.ts` already instantiates `openai` with `baseURL` and `apiKey` from env vars; pointing `LITELLM_BASE_URL` at the team's internal LiteLLM endpoint and setting `LITELLM_API_KEY` requires zero code changes and is fully supported by the client's retry/timeout logic. |
| 6 | **Fluent Bit DaemonSet → CloudWatch + OpenTelemetry Collector sidecar + Sentry SDK** | Fastify already emits structured JSON logs to stdout when `NODE_ENV=production`; Fluent Bit ships them to CloudWatch Logs with no code changes. A per-namespace OTel Collector sidecar forwards traces to AWS X-Ray. Sentry is added as a package dependency (`@sentry/node`, `@sentry/react`) initialized at process/app start via `SENTRY_DSN` env var — the only application-layer code addition in this deployment. |

## Module Boundaries

### Existing modules touched (configuration / environment only — no logic changes)

| File / Module | Change |
|---|---|
| `backend/src/index.ts` | No code change; `SESSION_SECRET`, `PUBLIC_BASE_URL`, `NODE_ENV` consumed from injected env vars |
| `backend/src/db.ts` | No code change; `DATABASE_URL` now points at RDS endpoint |
| `backend/src/llm/client.ts` | No code change; `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_MODEL` injected from Secrets Manager |
| `backend/src/yjs/server.ts` | No code change; `SNAPSHOTS_DIR` defaults to `/data/snapshots` which is the EBS PVC mount path |
| `backend/src/git/askpass.sh` | No code change; `GIT_TOKEN` injected from Secrets Manager |
| `backend/src/auth/mail.ts` | No code change; `SMTP_URL` injected from Secrets Manager (production SMTP DSN) |
| `backend/src/migrate.ts` | Executed as a Kubernetes `Job` pre-deploy; no code change |
| `backend/Dockerfile` | No change; existing multi-stage Node 20 Alpine image promoted to production |
| `frontend/Dockerfile` | No change; existing Nginx static build promoted to production |
| `docker-compose.yml` | Not used in production; retained for local development only |

### New modules / artefacts to add

| Path | Purpose |
|---|---|
| `k8s/namespace.yaml` | `openspec` Kubernetes namespace |
| `k8s/backend-deployment.yaml` | Backend `Deployment` + `HorizontalPodAutoscaler` + liveness/readiness probes (`GET /health`) |
| `k8s/frontend-deployment.yaml` | Frontend `Deployment` + `HorizontalPodAutoscaler` |
| `k8s/backend-service.yaml` | `ClusterIP` Service for backend (port 4000) |
| `k8s/frontend-service.yaml` | `ClusterIP` Service for frontend (port 80) |
| `k8s/ingress.yaml` | Nginx `Ingress` with TLS annotation, HTTP→HTTPS redirect, `/yjs/*` WebSocket upgrade, `/api/*` backend proxy, `/*` frontend |
| `k8s/cert-manager-issuer.yaml` | `ClusterIssuer` (Let's Encrypt production) |
| `k8s/migrate-job.yaml` | `Job` running `node dist/migrate.js` against RDS before rollout |
| `k8s/pvcs.yaml` | Four `PersistentVolumeClaim` objects (EBS gp3) for `repos`, `worktrees`, `snapshots`, `user-credentials` |
| `k8s/secret-provider-class.yaml` | `SecretProviderClass` (Secrets Store CSI) mapping AWS Secrets Manager ARNs to pod env vars |
| `k8s/otel-collector-sidecar.yaml` | OpenTelemetry Collector config for trace export to AWS X-Ray |
| `.github/workflows/deploy.yml` | CI/CD: ECR build+push → migrate Job → `kubectl rollout restart` on merge to `main` |
| `backend/src/instrumentation.ts` | **New file** — Sentry SDK init (`@sentry/node`) loaded before Fastify; reads `SENTRY_DSN` from env |
| `frontend/src/instrumentation.ts` | **New file** — Sentry SDK init (`@sentry/react`) at React app entry; reads `VITE_SENTRY_DSN` from env |

## External Dependencies

| Dependency | Version / Notes |
|---|---|
| **Amazon EKS** | Kubernetes 1.30+; managed node groups (ARM64 Graviton recommended for cost) |
| **Amazon RDS for PostgreSQL** | 16.x; Multi-AZ optional, automated daily snapshots retained ≥ 7 days |
| **Amazon EBS CSI Driver** | Installed as EKS managed add-on; provides `ebs.csi.aws.com` StorageClass (gp3) |
| **AWS Secrets Store CSI Driver** | `secrets-store-csi-driver` + `secrets-store-csi-driver-provider-aws` Helm charts |
| **Cert-Manager** | v1.14+; Helm chart `cert-manager/cert-manager` with `installCRDs=true` |
| **Nginx Ingress Controller** | `ingress-nginx/ingress-nginx` Helm chart v4.x; annotation `nginx.org/websocket-services` for Yjs |
| **Fluent Bit** | AWS-provided DaemonSet (`aws/aws-for-fluent-bit`); ships stdout logs to CloudWatch Logs |
| **OpenTelemetry Collector** | `otel/opentelemetry-collector-contrib` v0.100+; AWS X-Ray exporter |
| **`@sentry/node`** | v8.x; added to `backend/package.json` |
| **`@sentry/react`** | v8.x; added to `frontend/package.json` |
| **GitHub Actions** | `aws-actions/amazon-ecr-login`, `aws-actions/configure-aws-credentials`, `azure/setup-kubectl` |
| **LiteLLM VPN proxy** | Team-managed; accessible from EKS node CIDR via VPN; `LITELLM_BASE_URL` env var |
| **Production SMTP provider** | Team-managed; nodemailer-compatible DSN supplied as `SMTP_URL` |

## Trade-offs & Risks

**EBS single-AZ constraint:** EBS PVCs are tied to a single Availability Zone; if the AZ hosting the volumes fails, pods cannot be rescheduled to another AZ until the volume is detached (or Multi-AZ EFS is adopted). For the current workload (single-tenant collaborative editing) this is acceptable, but a future multi-AZ requirement would necessitate migrating `/data/snapshots` and `/data/repos` to EFS or S3 — an invasive change to `backend/src/yjs/server.ts` and the git worker. **Yjs in-process fan-out:** The Yjs server (`backend/src/yjs/server.ts`) holds document state in the Node.js process memory and fans updates to all connected WebSocket clients in-process; horizontal scaling of the backend beyond one replica would cause split-brain collaboration sessions. The `HorizontalPodAutoscaler` should therefore keep backend replicas at 1 (or use sticky sessions) until a shared Yjs persistence layer (e.g., `y-redis`) is introduced. **VPN dependency for LLM:** Planning runs depend on the team's internal LiteLLM VPN proxy being reachable from EKS; a VPN outage silently stalls stage runs — CloudWatch Alarms on LLM timeout error rates in structured logs are the primary mitigation. **Secrets rotation lag:** The Secrets Store CSI Driver refreshes secrets on pod restart, not live; a rotated `SESSION_SECRET` or `GIT_TOKEN` will not take effect until pods are cycled, which could temporarily break active sessions or git operations.

---

# Technical

# Technical Tasks — Production Deployment for Plan Collab

## 1. Implementation Tasks

### Kubernetes & Infrastructure Manifests

1. Create `infra/k8s/namespace.yaml` defining the `openspec` Kubernetes namespace with resource quotas.
2. Create `infra/k8s/backend/deployment.yaml` — Deployment for the Fastify backend (image: ECR repo, 2 replicas, resource limits, liveness/readiness probes on `GET /api/health`, env vars sourced from a `backend-secret` ExternalSecret).
3. Create `infra/k8s/backend/service.yaml` — ClusterIP Service exposing port 4000 for the backend Deployment.
4. Create `infra/k8s/backend/hpa.yaml` — HorizontalPodAutoscaler targeting the backend Deployment, scaling 2–6 replicas on CPU ≥ 70%.
5. Create `infra/k8s/frontend/deployment.yaml` — Deployment for the Nginx frontend (image: ECR repo, 2 replicas), serving the React SPA and proxying `/api/` and `/yjs/` to the backend Service.
6. Create `infra/k8s/frontend/service.yaml` — ClusterIP Service exposing port 80 for the frontend Deployment.
7. Create `infra/k8s/ingress.yaml` — Kubernetes Ingress (nginx ingress controller) with TLS termination via cert-manager Let's Encrypt ClusterIssuer, routing all traffic to the frontend Service, and WebSocket annotations (`nginx.org/websocket-services`).
8. Create `infra/k8s/cert-manager/clusterissuer.yaml` — Let's Encrypt production ClusterIssuer using HTTP-01 challenge for automatic TLS certificate provisioning and renewal.
9. Create `infra/k8s/backend/pvc.yaml` — PersistentVolumeClaim (`ReadWriteOnce`, 10 Gi, `gp3` StorageClass) for Yjs snapshot storage at `/data/snapshots`.
10. Create `infra/k8s/external-secrets/secret-store.yaml` — SecretStore (or ClusterSecretStore) pointing to AWS Secrets Manager in the deployment region, using IRSA for authentication.
11. Create `infra/k8s/external-secrets/backend-external-secret.yaml` — ExternalSecret that pulls the `openspec/production` secret from AWS Secrets Manager and syncs it to the `backend-secret` Kubernetes Secret with a 1-hour refresh interval.

### AWS Secrets Manager

12. Create `infra/scripts/create-secrets.sh` — shell script to create (or update) the `openspec/production` secret in AWS Secrets Manager with all required keys: `DATABASE_URL`, `JWT_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `LITELLM_API_KEY`, `LITELLM_BASE_URL`, `GITHUB_TOKEN`, `OPENSPEC_URL`, `COOKIE_DOMAIN`, `SNAPSHOTS_DIR`.

### Backend: Health Check Endpoint

13. Add `GET /api/health` route in `backend/src/index.ts` that returns `{ status: "ok", uptime: process.uptime() }` with HTTP 200 — used by Kubernetes liveness and readiness probes.

### Backend: LiteLLM Integration

14. Update `backend/src/llm/client.ts` to read `LITELLM_API_KEY` and `LITELLM_BASE_URL` from environment variables and pass them as `apiKey` and `baseURL` to the `OpenAI` SDK constructor, enabling LiteLLM proxy compatibility.

### Backend: SMTP Production Configuration

15. Update `backend/src/auth/mail.ts` to construct the Nodemailer transporter from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` environment variables, replacing any hardcoded dev defaults.

### Backend: Database SSL

16. Update `backend/src/db.ts` to pass `ssl: { rejectUnauthorized: true }` in the `pg.Pool` constructor when `NODE_ENV=production`, enabling encrypted connections to AWS RDS PostgreSQL.

### Backend: Structured Logging (OpenTelemetry + Sentry)

17. Add `backend/src/telemetry.ts` — initialises the `@opentelemetry/sdk-node` SDK with the OTLP exporter (endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`) and auto-instrumentation for Fastify, pg, and HTTP; must be imported before all other modules.
18. Update `backend/src/index.ts` to import `./telemetry.js` as the very first import so instrumentation is registered before Fastify boots.
19. Add `@sentry/node` initialisation in `backend/src/index.ts` using `SENTRY_DSN` from env, with `tracesSampleRate: 0.2` and Fastify error-handler integration.
20. Update `backend/package.json` to add dependencies: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@sentry/node`.

### Frontend: Production Nginx Configuration

21. Update `frontend/nginx.conf` to add security headers (`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`), gzip compression for text assets, and correct `proxy_read_timeout 3600s` for SSE and WebSocket connections.

### Frontend: Dockerfile Production Build

22. Update `frontend/Dockerfile` (or create it if absent) to use a multi-stage build: `node:20-alpine` build stage runs `npm ci && npm run build`, then an `nginx:alpine` serve stage copies `dist/` to `/usr/share/nginx/html` and the updated `nginx.conf`.

### Backend: Dockerfile Production Build

23. Update `backend/Dockerfile` to use a multi-stage build: `node:20-alpine` build stage runs `npm ci && npm run build`, then a lean `node:20-alpine` runtime stage copies `dist/` and `node_modules`, sets `CMD ["node", "dist/index.js"]`, and drops to a non-root user (`node`).

### CI/CD — GitHub Actions

24. Create `.github/workflows/deploy.yaml` — GitHub Actions workflow triggered on push to `main` that: (a) builds and pushes both Docker images to ECR with the commit SHA tag, (b) updates the image tag in `infra/k8s/backend/deployment.yaml` and `infra/k8s/frontend/deployment.yaml` via `kustomize edit set image` or `sed`, (c) runs `kubectl apply -k infra/k8s/` against the EKS cluster using an IRSA-backed IAM role, (d) waits for rollout with `kubectl rollout status`.
25. Create `.github/workflows/migrate.yaml` — GitHub Actions workflow (manual `workflow_dispatch`) that runs `npm run migrate` in a one-shot Kubernetes Job (`infra/k8s/jobs/migrate-job.yaml`) using the same backend image and `DATABASE_URL` from the ExternalSecret.

### Database Migration Job

26. Create `infra/k8s/jobs/migrate-job.yaml` — Kubernetes Job that runs `node dist/migrate.js` in the backend container image, sources env from `backend-secret`, and has `restartPolicy: Never` with a `backoffLimit: 1`.

### RDS Backups

27. Create `infra/scripts/enable-rds-backups.sh` — AWS CLI script that sets `--backup-retention-period 7` and `--preferred-backup-window "02:00-03:00"` on the production RDS instance, and enables automated minor version upgrades.

### Environment File Template

28. Update `.env.example` to add all new production-required variables: `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN`, `COOKIE_DOMAIN`, `NODE_ENV`, `SNAPSHOTS_DIR`.

---

## 2. Tests to Add

All tests live under `backend/src/__tests__/` (Vitest) unless noted otherwise.

| # | File | Type | Acceptance Criteria Covered |
|---|------|------|-----------------------------|
| T1 | `backend/src/__tests__/health.test.ts` | Integration | `GET /api/health` returns 200 `{ status: "ok" }` |
| T2 | `backend/src/__tests__/llm-client.test.ts` | Unit | `LiteLLM` client instantiates with `LITELLM_BASE_URL` and `LITELLM_API_KEY`; throws on missing vars |
| T3 | `backend/src/__tests__/mail.test.ts` | Unit | Nodemailer transporter reads `SMTP_*` env vars; fails fast if `SMTP_HOST` is unset |
| T4 | `backend/src/__tests__/db-ssl.test.ts` | Unit | `db.ts` passes `ssl: { rejectUnauthorized: true }` in pool config when `NODE_ENV=production` |
| T5 | `backend/src/__tests__/auth-routes.test.ts` | Integration | Login/logout flows succeed; JWT cookie is `HttpOnly; Secure; SameSite=Strict` in production mode |
| T6 | `backend/src/__tests__/git-github.test.ts` | Unit | `github.ts` provider reads `GITHUB_TOKEN` from env; commit request includes correct `Authorization: Bearer` header |
| T7 | `backend/src/__tests__/yjs-snapshot.test.ts` | Unit | Yjs snapshot save/load round-trips correctly; uses `SNAPSHOTS_DIR` env var as path prefix |
| T8 | `backend/src/__tests__/notify-sse.test.ts` | Integration | `/api/notify/features` SSE endpoint rejects unauthenticated requests (401) and returns `data: {"type":"connected"}` for valid sessions |
| T9 | `infra/tests/k8s-manifests.test.ts` | Lint/Validate | `kubectl --dry-run=client apply -f infra/k8s/` exits 0 (can be a shell-based CI step) |
| T10 | `e2e/prod-smoke.test.ts` (Playwright) | E2E smoke | HTTPS redirect works; login page loads; `/api/health` returns 200 — run post-deploy in CI |

---

## 3. Deployment Notes

### Environment Variables (all sourced from AWS Secrets Manager via ExternalSecret)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Full PostgreSQL connection string for RDS (e.g. `postgres://user:pass@host:5432/openspec?sslmode=require`) |
| `JWT_SECRET` | Random 64-byte hex string for signing JWT cookies |
| `SMTP_HOST` | Production SMTP server hostname |
| `SMTP_PORT` | SMTP port (typically `587` for STARTTLS) |
| `SMTP_USER` | SMTP auth username |
| `SMTP_PASS` | SMTP auth password |
| `SMTP_FROM` | Sender address (e.g. `noreply@yourdomain.com`) |
| `LITELLM_API_KEY` | API key issued by your LiteLLM proxy |
| `LITELLM_BASE_URL` | Base URL of the LiteLLM VPN endpoint (e.g. `https://litellm.internal/v1`) |
| `GITHUB_TOKEN` | GitHub Personal Access Token with `repo` scope for committing `PLAN.md` |
| `OPENSPEC_URL` | Public HTTPS URL of the deployment (e.g. `https://openspec.yourdomain.com`) |
| `COOKIE_DOMAIN` | Domain for auth cookies (e.g. `.yourdomain.com`) |
| `SNAPSHOTS_DIR` | Path to Yjs snapshot volume mount (e.g. `/data/snapshots`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint for traces/metrics |
| `SENTRY_DSN` | Sentry project DSN for error tracking |
| `NODE_ENV` | Must be `production` |

### Database Migrations

- Migrations are **not** run automatically on pod startup.
- Before every deploy, trigger the `migrate` GitHub Actions workflow (`workflow_dispatch`) which executes the `migrate-job.yaml` Kubernetes Job.
- The job uses `node-pg-migrate` (`npm run migrate`) against `DATABASE_URL` from the secret.
- Verify the job completed (`kubectl get job openspec-migrate -n openspec`) before promoting the new image.

### First-Time Cluster Bootstrap Order

1. Install cert-manager (`kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml`).
2. Install External Secrets Operator via Helm.
3. Install nginx ingress controller via Helm.
4. Apply `infra/k8s/namespace.yaml`.
5. Apply `infra/k8s/external-secrets/` (SecretStore + ExternalSecret).
6. Run `infra/scripts/create-secrets.sh` to populate AWS Secrets Manager.
7. Run the migration job manually (step T2 above).
8. Apply the full `infra/k8s/` tree: `kubectl apply -k infra/k8s/`.
9. Verify cert-manager issues the TLS certificate (`kubectl describe certificate -n openspec`).

### Feature Flags

No runtime feature flags are introduced. The LiteLLM integration is a pure configuration switch — setting `LITELLM_BASE_URL` and `LITELLM_API_KEY` activates it; removing them will cause the backend to throw at startup (intentional fail-fast).

### Persistent Storage

- The Yjs PVC (`openspec-yjs-snapshots`) must be created before the backend Deployment rolls out.
- The PVC is `ReadWriteOnce` — ensure the backend Deployment uses `Recreate` strategy (or pins to a single node) if the PVC does not support `ReadWriteMany`.
- For multi-replica backends sharing snapshots, migrate to an EFS-backed `ReadWriteMany` PVC in a follow-up.

---

## 4. Rollback Plan

If a deployment misbehaves in production, execute an immediate rollback with `kubectl rollout undo deployment/openspec-backend -n openspec && kubectl rollout undo deployment/openspec-frontend -n openspec`, which reverts both Deployments to the previous ReplicaSet (the prior Docker image). If the breakage is schema-related (a bad migration), restore the RDS instance from the automated daily snapshot taken before the deploy window via the AWS Console (RDS → Snapshots → Restore to Point in Time), update `DATABASE_URL` in AWS Secrets Manager to point at the restored instance endpoint, then force an ExternalSecret refresh (`kubectl annotate externalsecret backend-secret -n openspec force-sync=$(date +%s)`) and re-trigger a pod rollout. For Yjs data loss, the `/data/snapshots` PVC can be restored from the most recent EBS snapshot via `aws ec2 create-volume --snapshot-id <id>` and re-mounting. All infrastructure changes (Kubernetes manifests) are version-controlled in `infra/k8s/` — reverting a bad infra change is a `git revert` + re-apply of the previous manifest set.
