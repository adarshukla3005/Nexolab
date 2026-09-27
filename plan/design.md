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
