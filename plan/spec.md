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
