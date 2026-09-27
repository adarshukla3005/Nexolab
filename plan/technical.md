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
